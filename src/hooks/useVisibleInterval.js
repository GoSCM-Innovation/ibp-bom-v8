import { useEffect, useRef } from 'react'

// Runs `callback` every `delay` ms, but ONLY while the browser tab is visible.
// When the tab is hidden the timer is cleared (no background polling → no wasted
// proxy calls / Vercel usage). When it becomes visible again, `callback` fires
// once immediately to refresh stale data and the timer resumes.
//
// Pass delay = null/undefined to disable the interval entirely (e.g. when there
// is nothing to load yet).
export function useVisibleInterval(callback, delay) {
  const savedCallback = useRef(callback)
  useEffect(() => { savedCallback.current = callback }, [callback])

  useEffect(() => {
    if (delay == null) return
    let timer = null
    const tick = () => savedCallback.current()
    const start = () => { if (timer == null) timer = setInterval(tick, delay) }
    const stop  = () => { if (timer != null) { clearInterval(timer); timer = null } }

    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        savedCallback.current()   // refresh immediately when the user comes back
        start()
      }
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [delay])
}
