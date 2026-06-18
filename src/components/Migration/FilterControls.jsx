// ─────────────────────────────────────────────────────────────────────────────
// FilterControls.jsx — shared UI for SELECTIVE migrations (master data + KF).
//
// MultiValueSelect is a text input (comma-separated values) + a lazy-loaded
// dropdown of REAL values from the source system, so the user can pick instead
// of typing — with free typing always available as fallback. The $filter
// building helpers live in services/filterUtils.js.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useRef, useEffect } from 'react'
import { useI18n } from '../../context/I18nContext'
import { splitValues, displayValue } from '../../services/filterUtils'

// Dropdown with a built-in TEXT SEARCH — for long option lists (fields, key
// figures, units…) where a native <select> is hard to scan. Click opens a panel
// with a filter input + scrollable list; Enter picks the first match; Escape /
// outside click closes. options: [{ value, label }]. (Moved here from
// KeyFigureMigration so both migration tabs share it.)
export function SearchSelect({ value, options, onChange, placeholder, searchPlaceholder, invalid, style, btnStyle, mono = true }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const h = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const sel = options.find(o => o.value === value)
  const ql = q.toLowerCase()
  const filtered = !q ? options : options.filter(o =>
    String(o.value).toLowerCase().includes(ql) || String(o.label || '').toLowerCase().includes(ql))
  const pick = v => { onChange(v); setOpen(false); setQ('') }
  return (
    <div ref={boxRef} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setQ('') }}
        style={{
          background: 'var(--bg)', border: `1px solid ${invalid ? 'var(--red)' : 'var(--border)'}`, borderRadius: 6,
          color: sel ? 'var(--text)' : 'var(--text3)', fontSize: 12, padding: '7px 10px', width: '100%',
          textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: mono ? 'var(--mono)' : 'inherit', ...btnStyle,
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sel ? sel.label : (placeholder || '—')}
        </span>
        <span style={{ color: 'var(--text3)', fontSize: 9, flexShrink: 0 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, marginTop: 3,
          background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 8,
          boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
        }}>
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'Enter' && filtered.length > 0) pick(filtered[0].value)
            }}
            placeholder={searchPlaceholder || '…'}
            style={{
              background: 'var(--bg)', border: 'none', borderBottom: '1px solid var(--border)',
              color: 'var(--text)', fontSize: 12, padding: '8px 10px', width: '100%', outline: 'none', boxSizing: 'border-box',
            }}
          />
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {filtered.length === 0 && <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text3)' }}>—</div>}
            {filtered.map(o => (
              <div
                key={o.value}
                onClick={() => pick(o.value)}
                style={{
                  padding: '6px 10px', fontSize: 11, cursor: 'pointer',
                  fontFamily: mono ? 'var(--mono)' : 'inherit',
                  color: o.value === value ? 'var(--accent)' : 'var(--text)',
                  background: o.value === value ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent) 16%, transparent)' }}
                onMouseLeave={e => { e.currentTarget.style.background = o.value === value ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent' }}
              >
                {o.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Text input (comma-separated values) + dropdown of real values, lazy-loaded via
// `loadValues` on first open. Picking a value toggles it in the comma list; free
// typing stays available (e.g. when the value list is unavailable or truncated).
export function MultiValueSelect({ value, onChange, loadValues, placeholder, disabled }) {
  const { t } = useI18n()
  const [open, setOpen]       = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(false)
  const [all, setAll]         = useState(null)   // null = not loaded yet
  const [q, setQ]             = useState('')
  const boxRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const h = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const openDropdown = () => {
    setOpen(o => !o)
    if (all == null && !loading) {
      setLoading(true); setError(false)
      Promise.resolve()
        .then(() => loadValues())
        .then(vals => setAll(vals || []))
        .catch(() => { setError(true); setAll([]) })
        .finally(() => setLoading(false))
    }
  }

  const selected = new Set(splitValues(value))
  const toggle = v => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange([...next].join(','))
  }
  const ql = q.toLowerCase()
  // Match against both the raw token and its human label, so a search like "28/7"
  // finds a date value stored as "/Date(...)/".
  const filtered = (all || []).filter(v =>
    !q || v.toLowerCase().includes(ql) || displayValue(v).toLowerCase().includes(ql))

  return (
    <div ref={boxRef} style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', gap: 4 }}>
      <input
        value={value || ''}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--text)', fontSize: 11, padding: '4px 8px', flex: 1, minWidth: 0,
          outline: 'none', fontFamily: 'var(--mono)',
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={openDropdown}
        title={t('flt.loadVals')}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--text2)', fontSize: 10, padding: '4px 7px', cursor: 'pointer', flexShrink: 0,
        }}
      >▾</button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, marginTop: 3,
          background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 8,
          boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
        }}>
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
            placeholder={t('flt.searchPh')}
            style={{
              background: 'var(--bg)', border: 'none', borderBottom: '1px solid var(--border)',
              color: 'var(--text)', fontSize: 11, padding: '7px 10px', width: '100%',
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {loading && <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text3)' }}>{t('flt.valsLoading')}</div>}
            {!loading && error && <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--yellow, #e6a817)' }}>{t('flt.valsErr')}</div>}
            {!loading && !error && all != null && all.length === 0 && (
              <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text3)' }}>{t('flt.valsEmpty')}</div>
            )}
            {!loading && filtered.map(v => (
              <label
                key={v}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '4px 10px',
                  fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer',
                  color: selected.has(v) ? 'var(--accent)' : 'var(--text)',
                  background: selected.has(v) ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                }}
              >
                <input type="checkbox" checked={selected.has(v)} onChange={() => toggle(v)} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayValue(v)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
