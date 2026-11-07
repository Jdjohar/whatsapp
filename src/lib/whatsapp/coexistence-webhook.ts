import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

export interface CoexistenceEcho {
  id: string
  from: string // business phone number
  to: string   // customer phone number
  from_user_id?: string
  to_user_id?: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type?: string; caption?: string }
  video?: { id: string; mime_type?: string; caption?: string }
  document?: { id: string; mime_type?: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type?: string }
  sticker?: { id: string; mime_type?: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  revoke?: { original_message_id: string }
  edit?: {
    original_message_id: string
    message?: { body?: string }
    text?: { body?: string }
  }
  context?: { id: string }
}

export interface CoexistenceWebhookChange {
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
    message_echoes?: CoexistenceEcho[]
  }
}

/** Check if the webhook field is a coexistence echo field */
export function isCoexistenceWebhookField(field: string): boolean {
  return field === 'smb_message_echoes' || field === 'message_echoes'
}

/** Check if a webhook change payload represents a coexistence event */
export function isCoexistenceWebhookChange(change: {
  field?: string
  value?: unknown
}): boolean {
  if (change.field && isCoexistenceWebhookField(change.field)) return true
  const val = change.value as { message_echoes?: unknown[] } | undefined
  return Boolean(
    val?.message_echoes &&
      Array.isArray(val.message_echoes) &&
      val.message_echoes.length > 0
  )
}

function parseEchoContent(echo: CoexistenceEcho): {
  contentType: string
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
} {
  const empty = {
    contentType: 'text',
    contentText: null,
    mediaUrl: null,
    mediaType: null,
  }

  switch (echo.type) {
    case 'text':
      return {
        ...empty,
        contentType: 'text',
        contentText: echo.text?.body ?? null,
      }

    case 'image':
      return {
        ...empty,
        contentType: 'image',
        contentText: echo.image?.caption ?? null,
        mediaUrl: echo.image?.id ? `/api/whatsapp/media/${echo.image.id}` : null,
        mediaType: echo.image?.mime_type ?? 'image/jpeg',
      }

    case 'video':
      return {
        ...empty,
        contentType: 'video',
        contentText: echo.video?.caption ?? null,
        mediaUrl: echo.video?.id ? `/api/whatsapp/media/${echo.video.id}` : null,
        mediaType: echo.video?.mime_type ?? 'video/mp4',
      }

    case 'document':
      return {
        ...empty,
        contentType: 'document',
        contentText: echo.document?.caption ?? echo.document?.filename ?? null,
        mediaUrl: echo.document?.id ? `/api/whatsapp/media/${echo.document.id}` : null,
        mediaType: echo.document?.mime_type ?? 'application/pdf',
      }

    case 'audio':
      return {
        ...empty,
        contentType: 'audio',
        mediaUrl: echo.audio?.id ? `/api/whatsapp/media/${echo.audio.id}` : null,
        mediaType: echo.audio?.mime_type ?? 'audio/ogg',
      }

    case 'sticker':
      return {
        ...empty,
        contentType: 'image',
        mediaUrl: echo.sticker?.id ? `/api/whatsapp/media/${echo.sticker.id}` : null,
        mediaType: echo.sticker?.mime_type ?? 'image/webp',
      }

    case 'location':
      if (echo.location) {
        const parts = [echo.location.name, echo.location.address].filter(Boolean)
        const desc =
          parts.length > 0
            ? parts.join(', ')
            : `${echo.location.latitude}, ${echo.location.longitude}`
        return {
          ...empty,
          contentType: 'location',
          contentText: `📍 ${desc}`,
        }
      }
      return empty

    default:
      return {
        ...empty,
        contentType: 'text',
        contentText: echo.text?.body ?? null,
      }
  }
}

/**
 * Handle incoming WhatsApp Coexistence Webhook change (`smb_message_echoes`).
 * Synchronizes messages sent, edited, revoked, or reacted to from the
 * mobile WhatsApp Business App into the shared CRM inbox.
 */
export async function handleCoexistenceWebhookChange(
  change: CoexistenceWebhookChange,
  db: SupabaseClient
) {
  const { value } = change
  if (!value?.metadata?.phone_number_id) return

  const phoneNumberId = value.metadata.phone_number_id

  // 1. Resolve owning account from whatsapp_config
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('id, account_id, user_id')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()

  if (configErr || !config) {
    console.warn(
      '[coexistence-webhook] No whatsapp_config found for phone_number_id:',
      phoneNumberId
    )
    return
  }

  const accountId = config.account_id
  const ownerUserId = config.user_id

  if (!value.message_echoes || !Array.isArray(value.message_echoes)) {
    return
  }

  for (const echo of value.message_echoes) {
    await processEchoItem(echo, value, accountId, ownerUserId, db)
  }
}

async function processEchoItem(
  echo: CoexistenceEcho,
  value: CoexistenceWebhookChange['value'],
  accountId: string,
  ownerUserId: string,
  db: SupabaseClient
) {
  // A. Message Revocation (Deleted from mobile app)
  if (echo.type === 'revoke' || echo.revoke?.original_message_id) {
    const originalWamid = echo.revoke?.original_message_id || echo.id
    if (originalWamid) {
      await handleEchoRevoke(originalWamid, db)
    }
    return
  }

  // B. Message Edit (Edited from mobile app)
  if (echo.type === 'edit' || echo.edit?.original_message_id) {
    const originalWamid = echo.edit?.original_message_id
    const newBody =
      echo.edit?.message?.body ?? echo.edit?.text?.body ?? echo.text?.body
    if (originalWamid && newBody) {
      await handleEchoEdit(originalWamid, newBody, db)
    }
    return
  }

  // C. Reaction from mobile app
  if (echo.type === 'reaction' && echo.reaction?.message_id) {
    await handleEchoReaction(echo, ownerUserId, db)
    return
  }

  // D. Standard Sent Message (Text / Media / Location)
  const recipientPhone = echo.to
  if (!recipientPhone) {
    console.warn('[coexistence-webhook] echo has no recipient (to) phone:', echo.id)
    return
  }

  // Find or create contact
  let contactId: string | null = null
  const existing = await findExistingContact(db, accountId, recipientPhone)
  if (existing) {
    contactId = existing.id
  } else {
    // Check if contacts metadata has name
    const matchedProfile = value.contacts?.find(
      (c) => c.wa_id && normalizePhone(c.wa_id) === normalizePhone(recipientPhone)
    )?.profile
    const contactName =
      matchedProfile?.name ||
      matchedProfile?.username ||
      `+${normalizePhone(recipientPhone)}`

    const { data: newContact, error: createContactErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        name: contactName,
        phone: recipientPhone,
      })
      .select('id')
      .maybeSingle()

    if (createContactErr) {
      // Handle unique violation race
      if (isUniqueViolation(createContactErr)) {
        const recheck = await findExistingContact(db, accountId, recipientPhone)
        if (recheck) contactId = recheck.id
      } else {
        console.error('[coexistence-webhook] failed to create contact:', createContactErr)
      }
    } else if (newContact) {
      contactId = newContact.id
    }
  }

  if (!contactId) {
    console.error('[coexistence-webhook] could not resolve contact for echo:', echo.id)
    return
  }

  // Find or create conversation
  const { data: existingConv } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  let conversationId = existingConv?.id
  let conversationCreated = false

  if (!conversationId) {
    const { data: newConv, error: createConvErr } = await db
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        contact_id: contactId,
      })
      .select('id')
      .maybeSingle()

    if (createConvErr) {
      if (isUniqueViolation(createConvErr)) {
        const raced = await db
          .from('conversations')
          .select('id')
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        conversationId = raced.data?.id
      } else {
        console.error('[coexistence-webhook] failed to create conversation:', createConvErr)
      }
    } else if (newConv) {
      conversationId = newConv.id
      conversationCreated = true
    }
  }

  if (!conversationId) {
    console.error('[coexistence-webhook] could not resolve conversation for echo:', echo.id)
    return
  }

  if (conversationCreated) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversationId,
      contact_id: contactId,
    })
  }

  // Lookup reply_to context parent
  let replyToInternalId: string | null = null
  if (echo.context?.id) {
    const { data: parentMsg } = await db
      .from('messages')
      .select('id')
      .eq('message_id', echo.context.id)
      .eq('conversation_id', conversationId)
      .maybeSingle()
    if (parentMsg) {
      replyToInternalId = parentMsg.id
    }
  }

  const parsed = parseEchoContent(echo)

  // Idempotent upsert into messages table as sender_type: 'agent'
  const { data: insertedRows, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversationId,
        sender_type: 'agent',
        content_type: parsed.contentType,
        content_text: parsed.contentText,
        media_url: parsed.mediaUrl,
        media_type: parsed.mediaType,
        message_id: echo.id,
        status: 'delivered',
        created_at: echo.timestamp
          ? new Date(parseInt(echo.timestamp, 10) * 1000).toISOString()
          : new Date().toISOString(),
        reply_to_message_id: replyToInternalId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('[coexistence-webhook] error inserting message echo:', msgError)
    return
  }

  // If already present (idempotent replay), skip downstream updates
  if (!insertedRows || insertedRows.length === 0) {
    return
  }

  const lastPreview = parsed.contentText || `[${parsed.contentType}]`
  const lastAt = echo.timestamp
    ? new Date(parseInt(echo.timestamp, 10) * 1000).toISOString()
    : new Date().toISOString()

  // Update conversation: agent replied, so reset unread count and refresh last preview
  await db
    .from('conversations')
    .update({
      last_message_text: lastPreview,
      last_message_at: lastAt,
      unread_count: 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  // Pause active Flow run for this contact — human agent stepped in via mobile
  try {
    await db
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
  } catch (err) {
    console.error('[coexistence-webhook] pause active flow failed:', err)
  }
}

async function handleEchoRevoke(originalWamid: string, db: SupabaseClient) {
  const { data: existingMsg } = await db
    .from('messages')
    .select('id, conversation_id, content_text')
    .eq('message_id', originalWamid)
    .maybeSingle()

  if (!existingMsg) return

  await db
    .from('messages')
    .update({
      content_text: 'This message was deleted',
    })
    .eq('id', existingMsg.id)

  const { data: conv } = await db
    .from('conversations')
    .select('id, last_message_text')
    .eq('id', existingMsg.conversation_id)
    .maybeSingle()

  if (conv && conv.last_message_text === existingMsg.content_text) {
    await db
      .from('conversations')
      .update({
        last_message_text: 'This message was deleted',
        updated_at: new Date().toISOString(),
      })
      .eq('id', conv.id)
  }
}

async function handleEchoEdit(
  originalWamid: string,
  newBody: string,
  db: SupabaseClient
) {
  const { data: existingMsg } = await db
    .from('messages')
    .select('id, conversation_id, content_text')
    .eq('message_id', originalWamid)
    .maybeSingle()

  if (!existingMsg) return

  await db
    .from('messages')
    .update({
      content_text: newBody,
    })
    .eq('id', existingMsg.id)

  const { data: conv } = await db
    .from('conversations')
    .select('id, last_message_text')
    .eq('id', existingMsg.conversation_id)
    .maybeSingle()

  if (conv && conv.last_message_text === existingMsg.content_text) {
    await db
      .from('conversations')
      .update({
        last_message_text: newBody,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conv.id)
  }
}

async function handleEchoReaction(
  echo: CoexistenceEcho,
  ownerUserId: string,
  db: SupabaseClient
) {
  const reaction = echo.reaction
  if (!reaction?.message_id) return

  const { data: targetMsg } = await db
    .from('messages')
    .select('id, conversation_id')
    .eq('message_id', reaction.message_id)
    .maybeSingle()

  if (!targetMsg) return

  if (!reaction.emoji) {
    await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetMsg.id)
      .eq('actor_type', 'agent')
  } else {
    await db
      .from('message_reactions')
      .upsert(
        {
          message_id: targetMsg.id,
          conversation_id: targetMsg.conversation_id,
          actor_type: 'agent',
          actor_id: ownerUserId,
          emoji: reaction.emoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' }
      )
  }
}
