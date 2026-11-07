'use client'

import React from 'react'
import { useWhatsAppCalling } from '@/context/calling-context'
import { Phone, PhoneOff, PhoneCall } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function IncomingCallModal() {
  const { incomingCall, acceptIncomingCall, rejectIncomingCall } = useWhatsAppCalling()

  if (!incomingCall) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in">
      <div className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl text-center space-y-6">
        {/* Animated pulsing call avatar */}
        <div className="relative mx-auto flex h-24 w-24 items-center justify-center">
          <div className="absolute inset-0 animate-ping rounded-full bg-emerald-500/20" />
          <div className="absolute inset-2 animate-pulse rounded-full bg-emerald-500/30" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg">
            <PhoneCall className="h-8 w-8 animate-bounce" />
          </div>
        </div>

        {/* Caller Info */}
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-500">
            Incoming WhatsApp Voice Call
          </span>
          <h3 className="text-xl font-bold text-foreground">
            {incomingCall.callerName}
          </h3>
          <p className="text-sm text-muted-foreground tracking-wide font-mono">
            {incomingCall.callerPhone}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-center gap-6 pt-2">
          {/* Decline */}
          <div className="flex flex-col items-center gap-1.5">
            <Button
              type="button"
              variant="destructive"
              size="icon"
              onClick={rejectIncomingCall}
              className="h-14 w-14 rounded-full bg-rose-600 hover:bg-rose-700 shadow-md transition-transform hover:scale-105 active:scale-95"
            >
              <PhoneOff className="h-6 w-6" />
            </Button>
            <span className="text-xs text-muted-foreground font-medium">Decline</span>
          </div>

          {/* Accept */}
          <div className="flex flex-col items-center gap-1.5">
            <Button
              type="button"
              size="icon"
              onClick={acceptIncomingCall}
              className="h-14 w-14 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-600/30 transition-transform hover:scale-105 active:scale-95"
            >
              <Phone className="h-6 w-6" />
            </Button>
            <span className="text-xs text-emerald-500 font-semibold">Answer</span>
          </div>
        </div>
      </div>
    </div>
  )
}
