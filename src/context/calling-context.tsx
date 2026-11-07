'use client'

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { toast } from 'sonner'
import {
  createWhatsAppPeerConnection,
  createAnswerForOffer,
  createOfferForCall,
  callSound,
} from '@/lib/calling/webrtc'
import type { WhatsAppCall } from '@/types'

export interface ActiveCallState {
  callId: string
  contactId?: string | null
  contactName: string
  contactPhone: string
  direction: 'inbound' | 'outbound'
  status: 'connecting' | 'ringing' | 'connected' | 'ended'
  startedAt: Date
  duration: number
  isMuted: boolean
}

export interface IncomingCallState {
  callId: string
  contactId?: string | null
  callerName: string
  callerPhone: string
  sdpOffer?: string | null
}

interface CallingContextValue {
  incomingCall: IncomingCallState | null
  activeCall: ActiveCallState | null
  acceptIncomingCall: () => Promise<void>
  rejectIncomingCall: () => Promise<void>
  startOutboundCall: (phone: string, contactId?: string, contactName?: string) => Promise<void>
  endCall: () => Promise<void>
  toggleMute: () => void
}

const CallingContext = createContext<CallingContextValue | null>(null)

export function CallingProvider({ children }: { children: React.ReactNode }) {
  const { accountId, user } = useAuth()
  const supabase = createClient()

  const [incomingCall, setIncomingCall] = useState<IncomingCallState | null>(null)
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null)

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const durationTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Ensure remote audio element exists
  useEffect(() => {
    if (!remoteAudioRef.current && typeof document !== 'undefined') {
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.style.display = 'none'
      document.body.appendChild(audio)
      remoteAudioRef.current = audio
    }

    return () => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.remove()
        remoteAudioRef.current = null
      }
    }
  }, [])

  // Clean up media and peer connections on unmount or call termination
  const cleanupCallResources = useCallback(() => {
    callSound.stop()

    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null
    }
  }, [])

  // Listen to incoming calls and status updates via Supabase Realtime
  useEffect(() => {
    if (!accountId) return

    const channel = supabase
      .channel(`calls-realtime-${accountId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'whatsapp_calls',
          filter: `account_id=eq.${accountId}`,
        },
        async (payload) => {
          const row = payload.new as WhatsAppCall

          if (!row || !row.call_id) return

          // 1. New or pending Incoming Call
          if (row.direction === 'inbound' && row.status === 'ringing') {
            // Fetch caller name if contact_id exists
            let callerName = row.from_phone
            if (row.contact_id) {
              const { data: contact } = await supabase
                .from('contacts')
                .select('name')
                .eq('id', row.contact_id)
                .maybeSingle()
              if (contact?.name) callerName = contact.name
            }

            setIncomingCall({
              callId: row.call_id,
              contactId: row.contact_id,
              callerName,
              callerPhone: row.from_phone,
              sdpOffer: row.sdp_offer,
            })
            callSound.startIncomingRingtone()
          }

          // 2. Outbound call connected or accepted
          if (row.status === 'accepted') {
            callSound.stop()
            setActiveCall((prev) => {
              if (prev && prev.callId === row.call_id) {
                return { ...prev, status: 'connected' }
              }
              return prev
            })
          }

          // 3. Call answered by another agent, rejected, terminated, or missed
          if (['accepted', 'rejected', 'terminated', 'missed', 'failed'].includes(row.status)) {
            // Dismiss incoming ring modal if this call stopped ringing
            setIncomingCall((prev) => (prev?.callId === row.call_id ? null : prev))

            // If this agent is currently on this call and it ended
            setActiveCall((prev) => {
              if (prev && prev.callId === row.call_id && ['terminated', 'rejected', 'failed'].includes(row.status)) {
                cleanupCallResources()
                return null
              }
              return prev
            })
          }
        }
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [accountId, supabase, cleanupCallResources])

  // Call duration counter
  useEffect(() => {
    if (activeCall?.status === 'connected') {
      durationTimerRef.current = setInterval(() => {
        setActiveCall((prev) => (prev ? { ...prev, duration: prev.duration + 1 } : null))
      }, 1000)
    } else if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }

    return () => {
      if (durationTimerRef.current) clearInterval(durationTimerRef.current)
    }
  }, [activeCall?.status])

  // Accept incoming call
  const acceptIncomingCall = useCallback(async () => {
    if (!incomingCall) return
    const callToAccept = incomingCall
    callSound.stop()
    setIncomingCall(null)

    try {
      // Create WebRTC connection & capture microphone
      const { pc, localStream } = await createWhatsAppPeerConnection(
        (remoteStream) => {
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = remoteStream
            void remoteAudioRef.current.play().catch(console.warn)
          }
        },
        (connectionState) => {
          if (['disconnected', 'failed', 'closed'].includes(connectionState)) {
            cleanupCallResources()
            setActiveCall(null)
          }
        }
      )

      peerConnectionRef.current = pc
      localStreamRef.current = localStream

      setActiveCall({
        callId: callToAccept.callId,
        contactId: callToAccept.contactId,
        contactName: callToAccept.callerName,
        contactPhone: callToAccept.callerPhone,
        direction: 'inbound',
        status: 'connecting',
        startedAt: new Date(),
        duration: 0,
        isMuted: false,
      })

      // Generate SDP answer from Meta's SDP offer
      const sdpAnswer = callToAccept.sdpOffer
        ? await createAnswerForOffer(pc, callToAccept.sdpOffer)
        : ''

      // Send SDP answer to Meta API
      const res = await fetch('/api/whatsapp/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'accept',
          callId: callToAccept.callId,
          sdp: sdpAnswer,
        }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || 'Failed to connect call with Meta')
      }

      setActiveCall((prev) => (prev ? { ...prev, status: 'connected' } : null))
      toast.success('Call connected')
    } catch (err) {
      console.error('Accept call failed:', err)
      cleanupCallResources()
      setActiveCall(null)
      toast.error(err instanceof Error ? err.message : 'Failed to answer call')
    }
  }, [incomingCall, cleanupCallResources])

  // Reject incoming call
  const rejectIncomingCall = useCallback(async () => {
    if (!incomingCall) return
    const { callId } = incomingCall
    callSound.stop()
    setIncomingCall(null)

    try {
      await fetch('/api/whatsapp/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          callId,
        }),
      })
    } catch (err) {
      console.warn('Reject call failed:', err)
    }
  }, [incomingCall])

  // Start Outbound call
  const startOutboundCall = useCallback(
    async (phone: string, contactId?: string, contactName?: string) => {
      if (activeCall) {
        toast.error('Another call is already in progress.')
        return
      }

      try {
        callSound.startOutgoingRingback()

        const displayName = contactName || phone
        setActiveCall({
          callId: 'pending',
          contactId,
          contactName: displayName,
          contactPhone: phone,
          direction: 'outbound',
          status: 'ringing',
          startedAt: new Date(),
          duration: 0,
          isMuted: false,
        })

        // Setup WebRTC and create SDP offer
        const { pc, localStream } = await createWhatsAppPeerConnection(
          (remoteStream) => {
            if (remoteAudioRef.current) {
              remoteAudioRef.current.srcObject = remoteStream
              void remoteAudioRef.current.play().catch(console.warn)
            }
          },
          (connectionState) => {
            if (['disconnected', 'failed', 'closed'].includes(connectionState)) {
              cleanupCallResources()
              setActiveCall(null)
            }
          }
        )

        peerConnectionRef.current = pc
        localStreamRef.current = localStream

        const sdpOffer = await createOfferForCall(pc)

        // Initiate call with Meta
        const res = await fetch('/api/whatsapp/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'initiate',
            to: phone,
            sdp: sdpOffer,
            contactId,
          }),
        })

        const data = await res.json()
        if (!res.ok) {
          throw new Error(data.error || 'Failed to initiate WhatsApp call')
        }

        const callId = data.callId
        setActiveCall((prev) => (prev ? { ...prev, callId, status: 'ringing' } : null))
      } catch (err) {
        console.error('Outbound call failed:', err)
        cleanupCallResources()
        setActiveCall(null)
        toast.error(err instanceof Error ? err.message : 'Could not start call')
      }
    },
    [activeCall, cleanupCallResources]
  )

  // End active call
  const endCall = useCallback(async () => {
    if (!activeCall) return
    const { callId } = activeCall
    cleanupCallResources()
    setActiveCall(null)

    if (callId && callId !== 'pending') {
      try {
        await fetch('/api/whatsapp/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'terminate',
            callId,
          }),
        })
      } catch (err) {
        console.warn('Terminate call error:', err)
      }
    }
  }, [activeCall, cleanupCallResources])

  // Mute / Unmute
  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return
    const audioTrack = localStreamRef.current.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled
      setActiveCall((prev) => (prev ? { ...prev, isMuted: !audioTrack.enabled } : null))
    }
  }, [])

  return (
    <CallingContext.Provider
      value={{
        incomingCall,
        activeCall,
        acceptIncomingCall,
        rejectIncomingCall,
        startOutboundCall,
        endCall,
        toggleMute,
      }}
    >
      {children}
    </CallingContext.Provider>
  )
}

export function useWhatsAppCalling() {
  const context = useContext(CallingContext)
  if (!context) {
    throw new Error('useWhatsAppCalling must be used within a CallingProvider')
  }
  return context
}
