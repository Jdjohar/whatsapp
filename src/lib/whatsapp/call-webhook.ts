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
    .select('id, status')
    .eq('call_id', callId)
    .maybeSingle()

  if (existingCall) {
    // Update SDP offer or state if newly provided
    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (sdpOffer) updatePayload.sdp_offer = sdpOffer
    if (call.event === 'connect' && existingCall.status === 'ringing') {
      updatePayload.status = 'accepted'
      updatePayload.answered_at = new Date().toISOString()
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
    .select('id, started_at, answered_at, status')
    .eq('call_id', callId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (!callRow) return

  const now = new Date()
  let mappedStatus = callRow.status
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
      updatePayload.duration_seconds = Math.max(0, Math.round((now.getTime() - answeredTime) / 1000))
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
}
