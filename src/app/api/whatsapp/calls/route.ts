import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  executeCallAction,
  initiateCall,
  type CallAction,
} from '@/lib/whatsapp/meta-api'
import { recordCallInConversation } from '@/lib/whatsapp/call-webhook'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { searchParams } = new URL(request.url)
    const contactId = searchParams.get('contact_id')
    const status = searchParams.get('status')
    const limitParam = searchParams.get('limit')
    const limit = limitParam ? Math.min(50, Math.max(1, parseInt(limitParam, 10))) : 20

    let query = supabase
      .from('whatsapp_calls')
      .select('*, contact:contacts(*)')
      .eq('account_id', accountId)
      .order('started_at', { ascending: false })
      .limit(limit)

    if (contactId) {
      query = query.eq('contact_id', contactId)
    }

    if (status) {
      query = query.eq('status', status)
    }

    const { data: calls, error } = await query

    if (error) {
      console.error('[calls GET] query error:', error)
      // Return empty array gracefully if table is not yet migrated
      if (error.code === 'PGRST205' || error.message?.includes('does not exist')) {
        return NextResponse.json({ calls: [], warning: 'whatsapp_calls table not yet created. Run migration 043.' })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ calls: calls ?? [] })
  } catch (err) {
    console.error('[calls GET] error:', err)
    const message = (err as Error)?.message || 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Fetch account's WhatsApp configuration
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured for this account.' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)
    const phoneNumberId = config.phone_number_id

    const body = await request.json()
    const { action, callId, sdp, to, contactId } = body as {
      action: 'initiate' | 'accept' | 'pre_accept' | 'reject' | 'terminate'
      callId?: string
      sdp?: string
      to?: string
      contactId?: string
    }

    if (!action) {
      return NextResponse.json({ error: 'Action is required.' }, { status: 400 })
    }

    // ── 1. INITIATE OUTBOUND CALL ──────────────────────────────
    if (action === 'initiate') {
      if (!to || !sdp) {
        return NextResponse.json(
          { error: 'Both "to" and "sdp" (offer) are required to initiate a call.' },
          { status: 400 }
        )
      }

      const metaResult = await initiateCall({
        phoneNumberId,
        accessToken,
        to,
        session: {
          sdp_type: 'offer',
          sdp,
        },
      })

      const newCallId = metaResult.callId

      // Record outbound call in database
      const { data: insertedCall, error: insertError } = await supabase
        .from('whatsapp_calls')
        .insert({
          account_id: accountId,
          contact_id: contactId || null,
          call_id: newCallId,
          direction: 'outbound',
          status: 'ringing',
          from_phone: phoneNumberId,
          to_phone: to,
          sdp_offer: sdp,
          agent_id: userId,
          started_at: new Date().toISOString(),
        })
        .select('*')
        .maybeSingle()

      if (insertError) {
        console.warn('[calls POST] Failed to save outbound call record:', insertError)
      }

      return NextResponse.json({
        success: true,
        callId: newCallId,
        call: insertedCall,
      })
    }

    // ── 2. CALL ACTIONS: accept / pre_accept / reject / terminate
    if (!callId) {
      return NextResponse.json(
        { error: 'callId is required for this action.' },
        { status: 400 }
      )
    }

    let session: { sdp_type: 'answer'; sdp: string } | undefined
    if (action === 'accept') {
      if (!sdp) {
        return NextResponse.json(
          { error: 'sdp answer is required to accept a call.' },
          { status: 400 }
        )
      }
      session = {
        sdp_type: 'answer',
        sdp,
      }
    }

    // Execute with Meta Graph API
    await executeCallAction({
      phoneNumberId,
      accessToken,
      callId,
      action: action as CallAction,
      session,
    })

    // Update local database record accordingly
    const now = new Date()
    const updatePayload: Record<string, unknown> = {
      updated_at: now.toISOString(),
    }

    if (action === 'accept') {
      updatePayload.status = 'accepted'
      updatePayload.answered_at = now.toISOString()
      updatePayload.agent_id = userId
      if (sdp) updatePayload.sdp_answer = sdp
    } else if (action === 'reject') {
      updatePayload.status = 'rejected'
      updatePayload.ended_at = now.toISOString()
    } else if (action === 'terminate') {
      updatePayload.status = 'terminated'
      updatePayload.ended_at = now.toISOString()

      // Calculate duration and get contact info
      const { data: currentCall } = await supabase
        .from('whatsapp_calls')
        .select('answered_at, contact_id, direction')
        .eq('call_id', callId)
        .maybeSingle()

      let duration = 0
      if (currentCall?.answered_at) {
        duration = Math.max(0, Math.round((now.getTime() - new Date(currentCall.answered_at).getTime()) / 1000))
        updatePayload.duration_seconds = duration
      }

      if (currentCall) {
        await recordCallInConversation({
          db: supabase,
          accountId,
          contactId: currentCall.contact_id,
          status: 'terminated',
          durationSeconds: duration,
          direction: (currentCall.direction || 'outbound') as 'inbound' | 'outbound',
        })
      }
    }

    await supabase
      .from('whatsapp_calls')
      .update(updatePayload)
      .eq('call_id', callId)
      .eq('account_id', accountId)

    return NextResponse.json({ success: true, action, callId })
  } catch (err) {
    console.error('[calls POST] error:', err)
    const message = (err as Error)?.message || 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
