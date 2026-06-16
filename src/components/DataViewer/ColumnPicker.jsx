// ─────────────────────────────────────────────────────────────────────────────
// ColumnPicker.jsx — column selection + presets for the Data Viewer.
//
// Built-in presets: "only keys", "keys + descriptions", "all". Custom presets are
// saved per connection in localStorage. The selection drives the grid's $select
// (the parent always unions the key columns in for later edit/delete phases).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useRef, useEffect } from 'react'
import { useI18n } from '../../context/I18nContext'

const PRESET_KEY = connId => `ibp:viewer:presets:master:${connId}`

function loadPresets(connId) {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY(connId))) || {} } catch { return {} }
}
function savePresets(connId, obj) {
  try { localStorage.setItem(PRESET_KEY(connId), JSON.stringify(obj)) } catch { /* quota */ }
}

const btn = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text)', fontSize: 12, fontWeight: 600, padding: '7px 12px',
  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
}
const panel = {
  position: 'absolute', top: '100%', left: 0, zIndex: 60, marginTop: 4, width: 320,
  background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 8,
  boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
}
const chip = {
  background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 5,
  color: 'var(--text2)', fontSize: 11, fontWeight: 600, padding: '4px 9px', cursor: 'pointer',
}
const linkBtn = {
  background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11,
  fontWeight: 600, padding: 0, cursor: 'pointer',
}
const search = {
  background: 'var(--bg)', border: 'none', borderBottom: '1px solid var(--border)',
  color: 'var(--text)', fontSize: 12, padding: '8px 10px', width: '100%', outline: 'none', boxSizing: 'border-box',
}
const item = sel => ({
  display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
  fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer',
  color: sel ? 'var(--accent)' : 'var(--text)',
  background: sel ? 'color-mix(in srgb, var(--accent) 9%, transparent)' : 'transparent',
})

const isDesc = c => /DESCR/i.test(c)

export default function ColumnPicker({ allColumns, keyNames = [], selected, onChange, connId }) {
  const { t } = useI18n()
  const [open, setOpen]       = useState(false)
  const [q, setQ]             = useState('')
  const [presets, setPresets] = useState(() => loadPresets(connId))
  const boxRef = useRef(null)

  useEffect(() => { setPresets(loadPresets(connId)) }, [connId])
  useEffect(() => {
    if (!open) return
    const h = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const selSet   = new Set(selected)
  const hasDesc  = allColumns.some(isDesc)
  const keySet   = new Set(keyNames)

  // Presets preserve the original column order.
  const applyKeys     = () => onChange(allColumns.filter(c => keySet.has(c)))
  const applyKeysDesc = () => onChange(allColumns.filter(c => keySet.has(c) || isDesc(c)))
  const applyAll      = () => onChange([...allColumns])

  const toggle = c => {
    const next = new Set(selSet)
    if (next.has(c)) next.delete(c); else next.add(c)
    onChange(allColumns.filter(x => next.has(x)))
  }

  const saveCurrent = () => {
    const name = window.prompt(t('viewer.savePresetPrompt'))
    if (!name || !name.trim()) return
    const next = { ...presets, [name.trim()]: [...selected] }
    setPresets(next); savePresets(connId, next)
  }
  const applyCustom  = name => onChange(allColumns.filter(c => (presets[name] || []).includes(c)))
  const deleteCustom = name => {
    const next = { ...presets }; delete next[name]
    setPresets(next); savePresets(connId, next)
  }

  const ql = q.toLowerCase()
  const filtered = allColumns.filter(c => !q || c.toLowerCase().includes(ql))
  const customNames = Object.keys(presets)

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)} style={btn}>
        ▦ {t('viewer.columns')}
        <span style={{ color: 'var(--text3)', fontWeight: 400 }}>
          {t('viewer.columnsOf', { n: selected.length, total: allColumns.length })}
        </span>
      </button>
      {open && (
        <div style={panel}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button style={chip} onClick={applyKeys}>{t('viewer.presetKeys')}</button>
            {hasDesc && <button style={chip} onClick={applyKeysDesc}>{t('viewer.presetKeysDesc')}</button>}
            <button style={chip} onClick={applyAll}>{t('viewer.presetAll')}</button>
            <span style={{ flex: 1 }} />
            <button style={linkBtn} onClick={saveCurrent}>{t('viewer.savePreset')}</button>
          </div>

          {customNames.length > 0 && (
            <div style={{ padding: 10, borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
                {t('viewer.customPresets')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {customNames.map(name => (
                  <span key={name} style={{ display: 'inline-flex', alignItems: 'center' }}>
                    <button style={{ ...chip, borderRadius: '5px 0 0 5px' }} onClick={() => applyCustom(name)}>{name}</button>
                    <button title={t('viewer.deletePreset')} onClick={() => deleteCustom(name)}
                      style={{ ...chip, borderLeft: 'none', borderRadius: '0 5px 5px 0', color: 'var(--red)', padding: '4px 7px' }}>×</button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t('viewer.colSearch')} style={search} />

          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.map(c => (
              <label key={c} style={item(selSet.has(c))}>
                <input type="checkbox" checked={selSet.has(c)} onChange={() => toggle(c)} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c}</span>
                {keySet.has(c) && <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--accent)', flexShrink: 0 }}>{t('viewer.keyTag')}</span>}
              </label>
            ))}
            {filtered.length === 0 && <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text3)' }}>—</div>}
          </div>
        </div>
      )}
    </div>
  )
}
