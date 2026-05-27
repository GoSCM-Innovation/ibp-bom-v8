import { useState, useMemo } from 'react'
import { useI18n } from '../../context/I18nContext'

function sameConn(a, b) {
  return (
    (a.name     || '').trim().toLowerCase() === (b.name     || '').trim().toLowerCase() &&
    (a.ambiente || '').trim().toLowerCase() === (b.ambiente || '').trim().toLowerCase()
  )
}

export default function ImportConnectionsModal({ parsed, existing, fileName, onConfirm, onCancel }) {
  const { t } = useI18n()
  const [replaceDuplicates, setReplaceDuplicates] = useState(false)

  const classified = useMemo(
    () => parsed.connections.map(c => ({ ...c, _dup: existing.some(e => sameConn(e, c)) })),
    [parsed.connections, existing]
  )

  const newCount    = classified.filter(c => !c._dup).length
  const dupCount    = classified.filter(c =>  c._dup).length
  const willImport  = newCount + (replaceDuplicates ? dupCount : 0)
  const hasInvalid  = parsed.invalid && parsed.invalid.length > 0
  const empty       = parsed.connections.length === 0

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 12,
        width: 'min(640px, 95vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{t('import.title')}</div>
          {fileName && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, fontFamily: 'var(--mono)' }}>
              {fileName}
            </div>
          )}
        </div>

        {/* Summary pills */}
        <div style={{ padding: '14px 22px', display: 'flex', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Pill color="#3b82f6" label={t('import.found', { n: parsed.connections.length })} />
          <Pill color="#34d399" label={t('import.new', { n: newCount })} />
          <Pill color="#fbbf24" label={t('import.exists', { n: dupCount })} />
          {hasInvalid && <Pill color="#ff6b6b" label={t('import.invalid', { n: parsed.invalid.length })} />}
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 22px' }}>
          {empty ? (
            <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
              {t('import.empty')}
            </div>
          ) : (
            classified.map((c, i) => (
              <div key={i} style={{
                padding: '10px 0', borderBottom: '1px solid var(--border)',
                display: 'flex', gap: 10, alignItems: 'center',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.name}
                    <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>
                      {c.ambiente}
                    </span>
                  </div>
                  {c.com0326?.url && (
                    <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.com0326.url}
                    </div>
                  )}
                </div>
                <Tag dup={c._dup} willSkip={c._dup && !replaceDuplicates} t={t} />
              </div>
            ))
          )}

          {hasInvalid && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: 'color-mix(in srgb, var(--red) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)', borderRadius: 6, fontSize: 11, color: 'var(--text2)' }}>
              <div style={{ fontWeight: 600, color: 'var(--red)', marginBottom: 4 }}>
                {t('import.invalidSection', { n: parsed.invalid.length })}
              </div>
              {parsed.invalid.slice(0, 5).map((e, i) => (
                <div key={i} style={{ fontSize: 10, color: 'var(--text3)' }}>#{e.index + 1}: {e.reason}</div>
              ))}
              {parsed.invalid.length > 5 && (
                <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>…{t('import.invalid', { n: parsed.invalid.length - 5 })}</div>
              )}
            </div>
          )}
        </div>

        {/* Duplicate strategy */}
        {dupCount > 0 && (
          <div style={{ padding: '12px 22px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={replaceDuplicates}
                onChange={e => setReplaceDuplicates(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              {t('import.replaceConnCheck', { n: dupCount })}
            </label>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4, paddingLeft: 22 }}>
              {t('import.skipHint')}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0 }}>
          <button onClick={onCancel} style={{
            background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
            color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 18px', cursor: 'pointer',
          }}>
            {t('import.cancel')}
          </button>
          <button
            onClick={() => onConfirm({ replaceDuplicates })}
            disabled={willImport === 0}
            style={{
              background: willImport === 0 ? 'var(--bg3)' : 'var(--accent)',
              border: 'none', borderRadius: 6,
              color: willImport === 0 ? 'var(--text3)' : 'var(--text-on-accent)',
              fontSize: 12, fontWeight: 700, padding: '7px 18px',
              cursor: willImport === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {willImport > 0 ? t('import.importBtn', { n: willImport }) : t('import.importBtn', { n: '' }).trim()}
          </button>
        </div>
      </div>
    </div>
  )
}

function Pill({ color, label }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 10,
      background: color + '22', color, border: `1px solid ${color}44`,
    }}>
      {label}
    </span>
  )
}

function Tag({ dup, willSkip, t }) {
  if (!dup)      return <Pill color="#34d399" label={t('import.tagNew')} />
  if (willSkip)  return <Pill color="#9ca3af" label={t('import.tagSkip')} />
  return               <Pill color="#fbbf24" label={t('import.tagReplace')} />
}
