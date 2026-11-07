/**
 * WebRTC and Audio helper for WhatsApp VoIP Calling.
 * Handles microphone capture, peer connection, and synthesized ringing sounds.
 */

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
}

/**
 * Creates and initializes an RTCPeerConnection for WhatsApp audio call.
 * Attaches the local microphone stream immediately to satisfy Meta's 20s track attachment requirement.
 */
export async function createWhatsAppPeerConnection(
  onRemoteStream: (stream: MediaStream) => void,
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
): Promise<{
  pc: RTCPeerConnection
  localStream: MediaStream
}> {
  const pc = new RTCPeerConnection(RTC_CONFIG)

  // Request microphone with high quality voice settings
  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
    },
    video: false,
  })

  // IMPORTANT: Attach tracks BEFORE creating offer/answer (Meta requirement)
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream)
  })

  // Listen for incoming remote audio from Meta / WhatsApp user
  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      onRemoteStream(event.streams[0])
    }
  }

  if (onConnectionStateChange) {
    const handleState = () => {
      const conn = pc.connectionState
      const ice = pc.iceConnectionState
      if (['disconnected', 'failed', 'closed'].includes(conn) || ['disconnected', 'failed', 'closed'].includes(ice)) {
        onConnectionStateChange('disconnected')
      } else {
        onConnectionStateChange(conn)
      }
    }
    pc.onconnectionstatechange = handleState
    pc.oniceconnectionstatechange = handleState
  }

  return { pc, localStream }
}

/**
 * Generates an SDP Answer for an incoming SDP Offer.
 */
export async function createAnswerForOffer(
  pc: RTCPeerConnection,
  sdpOffer: string
): Promise<string> {
  await pc.setRemoteDescription({
    type: 'offer',
    sdp: sdpOffer,
  })

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  // Wait for complete ICE gathering so full SDP with candidates is sent to Meta
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', checkState)
          resolve()
        }
      }
      pc.addEventListener('icegatheringstatechange', checkState)
      // Safety timeout after 1.5s
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkState)
        resolve()
      }, 1500)
    })
  }

  return pc.localDescription?.sdp || answer.sdp || ''
}

/**
 * Generates an SDP Offer for initiating an outbound call.
 */
export async function createOfferForCall(
  pc: RTCPeerConnection
): Promise<string> {
  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: false,
  })
  await pc.setLocalDescription(offer)

  // Wait for ICE gathering
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', checkState)
          resolve()
        }
      }
      pc.addEventListener('icegatheringstatechange', checkState)
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkState)
        resolve()
      }, 1500)
    })
  }

  return pc.localDescription?.sdp || offer.sdp || ''
}

// ============================================================
// Web Audio API Ringtone / Dial tone synthesizer
// Avoids missing MP3 asset errors or 404s.
// ============================================================

class CallAudioSynthesizer {
  private ctx: AudioContext | null = null
  private osc1: OscillatorNode | null = null
  private osc2: OscillatorNode | null = null
  private gain: GainNode | null = null
  private intervalTimer: NodeJS.Timeout | null = null

  private getAudioContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new AudioCtx()
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume()
    }
    return this.ctx
  }

  /**
   * Starts playing an incoming phone ringing sound (European/WhatsApp style double-beep).
   */
  startIncomingRingtone() {
    this.stop()
    try {
      const ctx = this.getAudioContext()
      const playTone = () => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(440, ctx.currentTime) // A4

        gain.gain.setValueAtTime(0.15, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2)

        osc.connect(gain)
        gain.connect(ctx.destination)

        osc.start()
        osc.stop(ctx.currentTime + 1.2)
      }

      playTone()
      this.intervalTimer = setInterval(playTone, 2500)
    } catch (e) {
      console.warn('[CallAudio] Autoplay blocked or AudioContext unavailable:', e)
    }
  }

  /**
   * Starts playing an outgoing ringback tone.
   */
  startOutgoingRingback() {
    this.stop()
    try {
      const ctx = this.getAudioContext()
      const playTone = () => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(400, ctx.currentTime)

        gain.gain.setValueAtTime(0.08, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.0)

        osc.connect(gain)
        gain.connect(ctx.destination)

        osc.start()
        osc.stop(ctx.currentTime + 1.0)
      }

      playTone()
      this.intervalTimer = setInterval(playTone, 3000)
    } catch (e) {
      console.warn('[CallAudio] Outgoing ringback failed:', e)
    }
  }

  /**
   * Stops all playing ringtones or tones.
   */
  stop() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    if (this.osc1) {
      try { this.osc1.stop() } catch {}
      this.osc1 = null
    }
    if (this.osc2) {
      try { this.osc2.stop() } catch {}
      this.osc2 = null
    }
  }
}

export const callSound = new CallAudioSynthesizer()
