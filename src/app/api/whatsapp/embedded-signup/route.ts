import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { subscribeWabaToApp } from '@/lib/whatsapp/meta-api'

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const body = await request.json()
    const { code, phone_number_id: inputPhoneId, waba_id: inputWabaId } = body

    if (!code) {
      return NextResponse.json(
        { error: 'Authorization code is required' },
        { status: 400 }
      )
    }

    const appId = process.env.NEXT_PUBLIC_META_APP_ID || '846424185197562'
    const appSecret = process.env.META_APP_SECRET

    if (!appSecret) {
      return NextResponse.json(
        { error: 'META_APP_SECRET is not configured on the server' },
        { status: 500 }
      )
    }

    // 1. Exchange short-lived auth code for permanent access token
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}`
    const tokenRes = await fetch(tokenUrl)
    const tokenData = await tokenRes.json()

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[embedded-signup] token exchange failed:', tokenData)
      return NextResponse.json(
        { error: tokenData.error?.message || 'Failed to exchange code with Meta' },
        { status: 400 }
      )
    }

    const accessToken = tokenData.access_token
    let phoneNumberId = inputPhoneId
    let wabaId = inputWabaId

    // 2. If phone_number_id is missing, look up from WABA
    if (!phoneNumberId && wabaId) {
      try {
        const phoneRes = await fetch(
          `https://graph.facebook.com/v21.0/${wabaId}/phone_numbers`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )
        const phoneJson = await phoneRes.json()
        if (phoneJson.data?.[0]?.id) {
          phoneNumberId = phoneJson.data[0].id
        }
      } catch (err) {
        console.warn('[embedded-signup] failed to auto-detect phone_number_id:', err)
      }
    }

    // 3. If wabaId is still missing, debug the access token to get target WABA
    if (!wabaId) {
      try {
        const debugRes = await fetch(
          `https://graph.facebook.com/v21.0/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`
        )
        const debugJson = await debugRes.json()
        const targetIds = debugJson.data?.granular_scopes?.find(
          (s: { scope: string }) => s.scope === 'whatsapp_business_management'
        )?.target_ids
        if (targetIds?.[0]) {
          wabaId = targetIds[0]
        }
      } catch (err) {
        console.warn('[embedded-signup] failed to debug token for WABA ID:', err)
      }
    }

    if (!phoneNumberId) {
      return NextResponse.json(
        {
          error:
            'Could not determine Phone Number ID. Please check permissions or try again.',
        },
        { status: 400 }
      )
    }

    // 4. Subscribe the WABA to this app
    if (wabaId) {
      try {
        await subscribeWabaToApp({ wabaId, accessToken })
      } catch (err) {
        console.warn('[embedded-signup] subscribeWabaToApp error:', err)
      }
    }

    // 5. Encrypt tokens
    const encryptedToken = encrypt(accessToken)
    const encryptedVerify = encrypt('health_mantra_token_123')

    const db = supabaseAdmin()

    // 6. Check existing config for this account
    const { data: existing } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const configPayload = {
      account_id: accountId,
      user_id: userId,
      phone_number_id: phoneNumberId,
      waba_id: wabaId || null,
      access_token: encryptedToken,
      verify_token: encryptedVerify,
      status: 'connected',
      registered_at: new Date().toISOString(),
      subscribed_apps_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    let saveErr = null
    if (existing) {
      const { error } = await db
        .from('whatsapp_config')
        .update(configPayload)
        .eq('id', existing.id)
      saveErr = error
    } else {
      const { error } = await db.from('whatsapp_config').insert(configPayload)
      saveErr = error
    }

    if (saveErr) {
      console.error('[embedded-signup] save config error:', saveErr)
      return NextResponse.json(
        { error: `Failed to save configuration: ${saveErr.message}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
    })
  } catch (error) {
    console.error('[embedded-signup] unexpected error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    )
  }
}
