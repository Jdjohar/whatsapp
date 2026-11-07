import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

export interface MetaCallPayload {
  id: string
  from?: string
  to?: string
  event?: string
  direction?: 'USER_INITIATED' | 'BUSINESS_INITIATED'
  timestamp?: string
  connection?: {
    webrtc?: {
      sdp?: string
    }
  }
  session?: {
    sdp_type?: string
    sdp?: string
  }
}

export interface MetaCallStatusPayload {
  id: string
  type?: string
  status: string
  timestamp: string
}

export interface CallWebhookChange {
  field: string
  value: {
    messaging_product?: string
    metadata: {
      display_phone_number: string
      phone_number_id: string
    }
    contacts?: Array<{
      profile?: { name?: string; username?: string }
      wa_id?: string
    }>
    calls?: MetaCallPayload[]
    statuses?: MetaCallStatusPayload[]
  }
}

/**
 * Handle incoming WhatsApp Calling API webhook changes.
 * Manages ringing state, WebRTC SDP negotiation, and call terminations.
 */
export async function handleCallWebhookChange(
  change: CallWebhookChange,
  db: SupabaseClient
) {
  const { value } = change
  const phoneNumberId = value.metadata.phone_number_id

  // 1. Resolve owning account from whatsapp_config
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('id, account_id, user_id')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()

  if (configErr || !config) {
    console.warn('[call-webhook] No whatsapp_config found for phone_number_id:', phoneNumberId)
    return
  }

  const accountId = config.account_id

  // 2. Process incoming call signals (calls array)
  if (value.calls && Array.isArray(value.calls)) {
    for (const call of value.calls) {
      await processCallSignal(call, value, accountId, config.user_id, db)
    }
  }

  // 3. Process call statuses (statuses array when type === 'call')
  if (value.statuses && Array.isArray(value.statuses)) {
    for (const status of value.statuses) {
      if (status.type === 'call' || status.id?.startsWith('wacid.')) {
        await processCallStatusUpdate(status, accountId, db)
      }
    }
  }
}

async function processCallSignal(
  call: MetaCallPayload,
  value: CallWebhookChange['value'],
  accountId: string,
  ownerUserId: string,
  db: SupabaseClient
) {
  const callId = call.id
  if (!callId) return

  const fromPhone = call.from || value.contacts?.[0]?.wa_id || ''
  const toPhone = call.to || value.metadata.display_phone_number || ''
  const direction = call.direction === 'BUSINESS_INITIATED' ? 'outbound' : 'inbound'
  const sdpOffer = call.connection?.webrtc?.sdp || (call.session?.sdp_type === 'offer' ? call.session.sdp : null)

  // Resolve or create contact for caller
  let contactId: string | null = null
  if (fromPhone) {
    const existing = await findExistingContact(db, accountId, fromPhone)
    if (existing) {
      contactId = existing.id
    } else {
      const contactProfile = value.contacts?.[0]?.profile
      const callerName = contactProfile?.name || contactProfile?.username || `+${normalizePhone(fromPhone)}`
      const { data: newContact } = await db
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: ownerUserId,
          name: callerName,
          phone: fromPhone,
        })
        .select('id')
        .maybeSingle()

      if (newContact) contactId = newContact.id
    }
  }

  // Check if call row already exists
  const { data: existingCall } = await db
    .from('whatsapp_calls')
    .select('id, status, answered_at, contact_id, direction')
    .eq('call_id', callId)
    .maybeSingle()

  const rawEvent = (call.event || '').toLowerCase()

  if (existingCall) {
    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (sdpOffer) updatePayload.sdp_offer = sdpOffer

    if (rawEvent === 'connect' && existingCall.status === 'ringing') {
      updatePayload.status = 'accepted'
      updatePayload.answered_at = new Date().toISOString()
    } else if (rawEvent === 'terminate' || rawEvent === 'hangup' || rawEvent === 'ended' || rawEvent === 'completed') {
      const now = new Date()
      const isAnswered = Boolean(existingCall.answered_at || existingCall.status === 'accepted')
      const mappedStatus = isAnswered ? 'terminated' : 'missed'
      updatePayload.status = mappedStatus
      updatePayload.ended_at = now.toISOString()

      let duration = (call as { duration?: number }).duration || 0
      if (!duration && existingCall.answered_at) {
        duration = Math.max(0, Math.round((now.getTime() - new Date(existingCall.answered_at).getTime()) / 1000))
      }
      updatePayload.duration_seconds = duration

      await recordCallInConversation({
        db,
        accountId,
        contactId: existingCall.contact_id || contactId,
        status: mappedStatus,
        durationSeconds: duration,
        direction: (existingCall.direction || direction) as 'inbound' | 'outbound',
      })
    } else if (rawEvent === 'reject' || rawEvent === 'declined') {
      updatePayload.status = 'rejected'
      updatePayload.ended_at = new Date().toISOString()

      await recordCallInConversation({
        db,
        accountId,
        contactId: existingCall.contact_id || contactId,
        status: 'rejected',
        durationSeconds: 0,
        direction: (existingCall.direction || direction) as 'inbound' | 'outbound',
      })
    }

    await db.from('whatsapp_calls').update(updatePayload).eq('id', existingCall.id)
  } else {
    // Insert new incoming call
    await db.from('whatsapp_calls').insert({
      account_id: accountId,
      contact_id: contactId,
      call_id: callId,
      direction,
      status: 'ringing',
      from_phone: fromPhone,
      to_phone: toPhone,
      sdp_offer: sdpOffer,
      started_at: new Date().toISOString(),
    })
  }
}

async function processCallStatusUpdate(
  statusPayload: MetaCallStatusPayload,
  accountId: string,
  db: SupabaseClient
) {
  const callId = statusPayload.id
  const rawStatus = (statusPayload.status || '').toUpperCase()

  const { data: callRow } = await db
    .from('whatsapp_calls')
    .select('id, started_at, answered_at, status, contact_id, direction')
    .eq('call_id', callId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (!callRow) return

  const now = new Date()
  let mappedStatus = callRow.status
  let duration = 0
  const updatePayload: Record<string, unknown> = {
    updated_at: now.toISOString(),
  }

  if (rawStatus === 'RINGING') {
    mappedStatus = 'ringing'
  } else if (rawStatus === 'ACCEPTED' || rawStatus === 'CONNECTED') {
    mappedStatus = 'accepted'
    if (!callRow.answered_at) {
      updatePayload.answered_at = now.toISOString()
    }
  } else if (rawStatus === 'REJECTED' || rawStatus === 'DECLINED') {
    mappedStatus = 'rejected'
    updatePayload.ended_at = now.toISOString()
  } else if (rawStatus === 'TERMINATED' || rawStatus === 'COMPLETED' || rawStatus === 'ENDED') {
    mappedStatus = callRow.answered_at ? 'terminated' : 'missed'
    updatePayload.ended_at = now.toISOString()
    if (callRow.answered_at) {
      const answeredTime = new Date(callRow.answered_at).getTime()
      duration = Math.max(0, Math.round((now.getTime() - answeredTime) / 1000))
      updatePayload.duration_seconds = duration
    }
  } else if (rawStatus === 'MISSED' || rawStatus === 'UNANSWERED') {
    mappedStatus = 'missed'
    updatePayload.ended_at = now.toISOString()
  } else if (rawStatus === 'FAILED') {
    mappedStatus = 'failed'
    updatePayload.ended_at = now.toISOString()
  }

  updatePayload.status = mappedStatus
  await db.from('whatsapp_calls').update(updatePayload).eq('id', callRow.id)

  if (['terminated', 'missed', 'rejected', 'failed'].includes(mappedStatus)) {
    await recordCallInConversation({
      db,
      accountId,
      contactId: callRow.contact_id,
      status: mappedStatus as 'terminated' | 'missed' | 'rejected' | 'failed',
      durationSeconds: duration,
      direction: callRow.direction as 'inbound' | 'outbound',
    })
  }
}

export async function recordCallInConversation({
  db,
  accountId,
  contactId,
  status,
  durationSeconds,
  direction,
}: {
  db: SupabaseClient
  accountId: string
  contactId: string | null
  status: 'accepted' | 'terminated' | 'missed' | 'rejected' | 'failed'
  durationSeconds: number
  direction: 'inbound' | 'outbound'
}) {
  if (!contactId) return

  // 1. Find conversation for this contact
  const { data: conv } = await db
    .from('conversations')
    .select('id, user_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!conv) return

  // Format label
  let text = '📞 Voice call'
  if (status === 'missed') {
    text = direction === 'inbound' ? '📞 Missed voice call' : '📞 Unanswered voice call'
  } else if (status === 'rejected') {
    text = '📞 Declined voice call'
  } else if (status === 'failed') {
    text = '📞 Failed voice call'
  } else if (durationSeconds > 0) {
    const mins = Math.floor(durationSeconds / 60)
    const secs = durationSeconds % 60
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
    text = `📞 Voice call (${timeStr})`
  }

  // Check if a call message for this call was inserted in the last 15s to avoid duplicate inserts
  const { data: existingMsg } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conv.id)
    .like('content_text', '📞%')
    .gte('created_at', new Date(Date.now() - 15000).toISOString())
    .limit(1)
    .maybeSingle()

  if (existingMsg) return

  // Insert call message into conversation
  await db.from('messages').insert({
    conversation_id: conv.id,
    sender_type: direction === 'inbound' ? 'customer' : 'agent',
    content_type: 'text',
    content_text: text,
    status: 'delivered',
  })

  // Update conversation last message preview
  await db.from('conversations').update({
    last_message_text: text,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', conv.id)
}
