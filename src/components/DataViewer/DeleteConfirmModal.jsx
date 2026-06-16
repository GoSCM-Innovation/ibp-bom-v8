// ─────────────────────────────────────────────────────────────────────────────
// DeleteConfirmModal.jsx — confirm-before-delete dialog for master data (Phase 3).
//
// Deletion is IRREVERSIBLE in SAP IBP, so this dialog states that plainly, lists
// the exact records (by business key) that will be removed, and requires a
// deliberate confirm. While deleting it shows progress; afterwards the result
// (ok / SAP rejections / error). The actual delete (deleteEntries=true upsert →
// commit → poll → messages) runs in the parent.
// ─────────────────────────────────────────────────────────────────────────────
import { useI18n } from '../../context/I18nContext'
import { formatCell } from '../../services/catalogHelpers'

const MAX_SHOWN = 300

const backdrop = {
  position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.5)',
  backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
}
const card = {
  background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 12,
  boxShadow: 'var(--shadow-lg)', width: 'min(640px, 100%)', maxHeight: '85vh',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
}
const TD = { padding: '4px 10px', fontSize: 12, borderBottom: '1px solid var(--border)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const btnSec = { background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '8px 16px', cursor: 'pointer' }
const btnDanger = { background: 'var(--red)', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, fontWeight: 700, padding: '8px 18px', cursor: 'pointer' }

const cellText = v => { const c = formatCell(v); return c == null ? '' : String(c) }

export default function DeleteConfirmModal({ open, rows, keyNames = [], onConfirm, onClose, deleting, result }) {
  const { t } = useI18n()
  if (!open) return null

  const keys = (rows || []).map(r => keyNames.map(k => cellText(r[k])).join(' · ') || '—')
  const shown = keys.slice(0, MAX_SHOWN)
  const extra = keys.length - shown.length
  const statusColor = s => s === 'ok' ? 'var(--green)' : s === 'warning' ? 'var(--yellow, #e6a817)' : 'var(--red)'

  return (
    <div style={backdrop} onClick={deleting ? undefined : onClose}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{t('viewer.deleteTitle')}</div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
          {result ? (
            <div style={{ fontSize: 13 }}>
              <div style={{ color: statusColor(result.status), fontWeight: 700, marginBottom: 8 }}>
                {result.status === 'ok' && t('viewer.deleteOk', { n: (result.count ?? 0).toLocaleString() })}
                {result.status === 'warning' && t('viewer.deleteRejected', { n: (result.errors?.length ?? 0).toLocaleString() })}
                {result.status === 'error' && t('viewer.deleteErr', { msg: result.message || '' })}
              </div>
              {result.errors?.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text2)', fontSize: 12 }}>
                  {result.errors.slice(0, 50).map((m, i) => (
                    <li key={i} style={{ marginBottom: 3 }}>{m.Message || m.message || JSON.stringify(m)}</li>
                  ))}
                  {result.errors.length > 50 && <li>{t('viewer.reviewMore', { n: result.errors.length - 50 })}</li>}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div style={{
                background: 'color-mix(in srgb, var(--red) 12%, transparent)', border: '1px solid var(--red)',
                borderRadius: 8, padding: '10px 12px', color: 'var(--red)', fontSize: 12, marginBottom: 14,
              }}>
                ⚠ {t('viewer.deleteWarn')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>
                {t('viewer.deleteIntro', { n: keys.length.toLocaleString() })}
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <tbody>
                    {shown.map((k, i) => (
                      <tr key={i}><td style={{ ...TD, color: 'var(--text)' }} title={k}>{k}</td></tr>
                    ))}
                  </tbody>
                </table>
                {extra > 0 && <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text3)' }}>{t('viewer.reviewMore', { n: extra })}</div>}
              </div>
            </>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 10, alignItems: 'center' }}>
          {deleting && <span style={{ fontSize: 12, color: 'var(--text2)', marginRight: 'auto' }}>{t('viewer.deleting')}</span>}
          {result ? (
            <button style={btnSec} onClick={onClose}>{t('viewer.close')}</button>
          ) : (
            <>
              <button style={btnSec} onClick={onClose} disabled={deleting}>{t('viewer.cancel')}</button>
              <button style={{ ...btnDanger, opacity: deleting ? 0.6 : 1, cursor: deleting ? 'wait' : 'pointer' }} onClick={onConfirm} disabled={deleting}>
                {t('viewer.deleteConfirm')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
