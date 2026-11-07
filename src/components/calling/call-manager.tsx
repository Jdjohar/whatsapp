'use client'

import React from 'react'
import { IncomingCallModal } from './incoming-call-modal'
import { ActiveCallModal } from './active-call-modal'

export function CallManager() {
  return (
    <>
      <IncomingCallModal />
      <ActiveCallModal />
    </>
  )
}
