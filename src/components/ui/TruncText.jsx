import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export default function TruncText({ text, style }) {
  const [pos, setPos] = useState(null)
  const ref = useRef()

  useEffect(() => {
    if (!pos) return
    function close() { setPos(null) }
    document.addEventListener('pointerdown', close, { capture: true, once: true })
    return () => document.removeEventListener('pointerdown', close, { capture: true })
  }, [pos])

  function handleClick(e) {
    e.stopPropagation()
    if (!text) return
    if (pos) { setPos(null); return }
    const rect = ref.current.getBoundingClientRect()
    setPos({
      top: rect.bottom + 6,
      left: Math.min(rect.left, window.innerWidth - 296),
    })
  }

  return (
    <>
      <span
        ref={ref}
        title={text}
        onClick={handleClick}
        style={{
          display: 'block',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          cursor: text ? 'pointer' : 'default',
          ...style,
        }}
      >
        {text || '—'}
      </span>
      {pos && createPortal(
        <div
          onPointerDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            zIndex: 9999,
            background: 'var(--bg2)',
            border: '1px solid var(--border2)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 11,
            color: 'var(--text)',
            lineHeight: 1.6,
            maxWidth: 280,
            wordBreak: 'break-word',
            boxShadow: 'var(--shadow)',
          }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  )
}
