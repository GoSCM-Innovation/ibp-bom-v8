import { useState, useEffect } from 'react'

export function useIsMobile(breakpoint = 640) {
  const [is, setIs] = useState(() => window.innerWidth <= breakpoint)
  useEffect(() => {
    const fn = () => setIs(window.innerWidth <= breakpoint)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [breakpoint])
  return is
}
