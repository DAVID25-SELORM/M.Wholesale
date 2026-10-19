import { useEffect } from 'react'
import { useAuth } from '@/modules/auth/AuthProvider'
import { useAppSettings } from './useAppSettings'

const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

/**
 * Signs the browser out after the organization's idle time-out (Settings → Security). It protects shared counters and unattended screens. It is a convenience of the
 * app, not a server rule: the server session itself is governed by the hosting dashboard's session settings. Renders nothing.
 */
export function IdleSignOut() {
  const { idleTimeoutMinutes } = useAppSettings()
  const { signOut } = useAuth()

  useEffect(() => {
    if (!idleTimeoutMinutes) return
    const limit = idleTimeoutMinutes * 60_000
    let last = Date.now()
    let timer = 0
    let done = false

    const expire = () => {
      if (done) return
      done = true
      void signOut().finally(() => window.location.assign('/login?idle=1'))
    }
    const arm = () => { window.clearTimeout(timer); timer = window.setTimeout(expire, limit) }
    const touch = () => {
      const now = Date.now()
      if (now - last < 1000) return          // pointer moves fire constantly: once a second is plenty
      last = now
      arm()
    }
    // timers sleep in background tabs and while a laptop is closed: judge by the clock when the tab comes back
    const visible = () => { if (document.visibilityState === 'visible' && Date.now() - last >= limit) expire() }

    arm()
    for (const e of EVENTS) window.addEventListener(e, touch, { passive: true })
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.clearTimeout(timer)
      for (const e of EVENTS) window.removeEventListener(e, touch)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [idleTimeoutMinutes, signOut])

  return null
}

