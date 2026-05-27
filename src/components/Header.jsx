import { useState, useRef, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { useTheme } from '../hooks/useTheme'
import { useI18n } from '../context/I18nContext'

function ThemeToggle({ theme, onToggle }) {
  const { t } = useI18n()
  const isLight = theme === 'light'
  const btnRef = useRef(null)

  function handleToggle() {
    if (!document.startViewTransition) {
      onToggle()
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
    const maxR = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    )
    const vt = document.startViewTransition(() => { flushSync(onToggle) })
    vt.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`] },
        { duration: 500, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' }
      )
    })
  }

  return (
    <button
      ref={btnRef}
      onClick={handleToggle}
      role="switch"
      aria-checked={isLight}
      title={isLight ? t('header.themeToDark') : t('header.themeToLight')}
      style={{
        position: 'relative',
        width: 46, height: 24,
        borderRadius: 12,
        background: isLight ? 'var(--surface-glass-strong)' : 'var(--surface-glass)',
        border: '1px solid var(--border)',
        padding: 0,
        cursor: 'pointer',
        transition: 'background .2s ease, border-color .2s ease',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2, left: 2,
          width: 18, height: 18,
          borderRadius: '50%',
          background: 'var(--accent)',
          boxShadow: '0 1px 4px rgba(0,0,0,.25)',
          transform: isLight ? 'translateX(22px)' : 'translateX(0)',
          transition: 'transform .22s ease',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, lineHeight: 1,
          color: 'var(--text-on-accent)',
        }}
      >
        {isLight ? '☀' : '🌙'}
      </span>
    </button>
  )
}

export default function Header({ onMenuToggle }) {
  const { t } = useI18n()
  const [showReqs, setShowReqs] = useState(false)
  const panelRef = useRef(null)
  const { theme, toggle } = useTheme()

  const requirements = [
    { title: t('header.req0title'), detail: t('header.req0detail') },
    { title: t('header.req1title'), detail: t('header.req1detail') },
    { title: t('header.req2title'), detail: t('header.req2detail') },
    { title: t('header.req3title'), detail: t('header.req3detail') },
    { title: t('header.req4title'), detail: t('header.req4detail') },
  ]

  useEffect(() => {
    if (!showReqs) return
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setShowReqs(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showReqs])

  return (
    <header style={{
      background: 'var(--header-bg)',
      borderBottom: '2px solid var(--header-border)',
      padding: '0 24px',
      height: 'var(--header-h)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      position: 'sticky',
      top: 0,
      zIndex: 200,
      boxShadow: 'var(--shadow)',
      flexShrink: 0,
    }}>
      {/* Hamburger — mobile only */}
      {onMenuToggle && (
        <button
          onClick={onMenuToggle}
          className="hamburger-btn"
          style={{
            display: 'none',
            background: 'none', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text2)', padding: '5px 9px',
            fontSize: 16, cursor: 'pointer', flexShrink: 0,
          }}
        >☰</button>
      )}
      {/* Logo + title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <img
          src="/logo-goscm.png"
          alt="GoSCM"
          style={{ height: 32, width: 'auto', objectFit: 'contain', flexShrink: 0 }}
        />
        <div className="header-sep" style={{ width: 1, height: 28, background: 'var(--divider)' }} />
        <div className="header-title">
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', letterSpacing: '.01em', lineHeight: 1.2 }}>
            SAP IBP Control Tower
          </div>
        </div>
      </div>

      {/* Right cluster: theme toggle + Requirements */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ThemeToggle theme={theme} onToggle={toggle} />

        <div style={{ position: 'relative' }} ref={panelRef}>
          <button
            onClick={() => setShowReqs(p => !p)}
            style={{
              background: showReqs ? 'var(--accent-bg-soft)' : 'var(--surface-glass)',
              border: `1px solid ${showReqs ? 'var(--accent-border-soft)' : 'var(--border)'}`,
              borderRadius: 7, color: showReqs ? 'var(--accent)' : 'var(--text2)',
              fontSize: 12, fontWeight: 600, padding: '6px 14px',
              cursor: 'pointer', transition: 'all .15s', display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: 14 }}>📋</span><span className="header-btn-label"> {t('header.reqBtn')}</span>
          </button>

          {showReqs && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 10px)', right: 0,
              width: 'min(420px, 92vw)', background: 'var(--modal-bg)',
              border: '1px solid var(--header-border)', borderRadius: 10,
              boxShadow: 'var(--shadow-lg)', padding: 20, zIndex: 300,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>📋</span> {t('header.reqPanel')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {requirements.map((r, i) => (
                  <div key={i} style={{
                    background: 'var(--surface-glass-soft)', borderRadius: 7,
                    border: '1px solid var(--border)', padding: '10px 14px',
                    overflow: 'hidden',
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', marginBottom: 4, wordBreak: 'break-word' }}>
                      {r.title}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5, wordBreak: 'break-word', overflowWrap: 'break-word' }}>{r.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
