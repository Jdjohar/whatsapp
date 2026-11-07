'use client'

import React from 'react'
import { useWhatsAppCalling } from '@/context/calling-context'
import { PhoneOff, Mic, MicOff, User, Volume2, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'

function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function ActiveCallModal() {
  const { activeCall, endCall, toggleMute } = useWhatsAppCalling()

  if (!activeCall) return null

  const isRinging = activeCall.status === 'ringing' || activeCall.status === 'connecting'

  return (
    <div className="fixed bottom-6 right-6 z-50 w-80 rounded-2xl border border-border bg-card/95 backdrop-blur-md p-5 shadow-2xl animate-in slide-in-from-bottom-5 duration-200">
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
                isRinging ? 'animate-ping bg-amber-400' : 'animate-pulse bg-emerald-500'
              }`}
            />
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                isRinging ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
            />
          </span>
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {isRinging ? 'WhatsApp Calling...' : 'Call in Progress'}
          </span>
        </div>

        <span className="font-mono text-xs font-bold text-foreground bg-muted px-2 py-0.5 rounded-md">
          {isRinging ? 'Ringing...' : formatSeconds(activeCall.duration)}
        </span>
      </div>

      <div className="py-4 text-center space-y-1">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-2">
          <User className="h-6 w-6" />
        </div>
        <h4 className="text-base font-bold text-foreground truncate px-2">
          {activeCall.contactName}
        </h4>
        <p className="text-xs text-muted-foreground font-mono">
          {activeCall.contactPhone}
        </p>
      </div>

      <div className="flex items-center justify-center gap-4 pt-2">
        {/* Mute button */}
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={toggleMute}
          disabled={isRinging}
          className={`h-11 w-11 rounded-full border-border transition-colors ${
            activeCall.isMuted
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-500 hover:bg-rose-500/20'
              : 'bg-muted hover:bg-muted/80 text-foreground'
          }`}
          title={activeCall.isMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {activeCall.isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </Button>

        {/* End Call button */}
        <Button
          type="button"
          variant="destructive"
          size="icon"
          onClick={endCall}
          className="h-12 w-12 rounded-full bg-rose-600 hover:bg-rose-700 text-white shadow-lg shadow-rose-600/30 transition-transform active:scale-95"
          title="End Call"
        >
          <PhoneOff className="h-5 w-5" />
        </Button>
      </div>
    </div>
  )
}
