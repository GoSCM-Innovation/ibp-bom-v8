// ─────────────────────────────────────────────────────────────────────────────
// EditReviewModal.jsx — review-before-send dialog for master-data edits (Phase 2).
//
// Shows every pending change (row key + field: before → after) so the user
// confirms exactly what will be written to SAP. While saving it shows progress;
// afterwards it shows the result (ok / SAP rejections / error) before closing.
// The actual write (upsert → commit → poll → messages) is run by the parent.
// ─────────────────────────────────────────────────────────────────────────────
import { useI18n } from '../../context/I18nContext'
import { formatCell } from '../../services/catalogHelpers'

const MAX_SHOWN = 200   // cap rendered change rows; the rest are summarised

const backdrop = {
  position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.5)',
  backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
}
const card = {
  background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 12,
  boxShadow: 'var(--shadow-lg)', width: 'min(720px, 100%)', maxHeight: '85vh',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
}
const TH = { textAlign: 'left', padding: '5px 10px', fontSize: 10, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg2)' }
const TD = { padding: '5px 10px', fontSize: 12, borderBottom: '1px solid var(--border)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }
const btnSec = { background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '8px 16px', cursor: 'pointer' }
const btnPri = { background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'var(--text-on-accent)', fontSize: 12, fontWeight: 700, padding: '8px 18px', cursor: 'pointer' }

const cellText = v => { const c = formatCell(v); return c == null ? '' : String(c) }

export default function EditReviewModal({ open, edits, keyNames = [], onConfirm, onClose, saving, result }) {
  const { t } = useI18n()
  if (!open) return null

  // Flatten edits into per-field change rows for the table.
  const changeRows = []
  for (const { row, changes } of Object.values(edits)) {
    const key = keyNames.map(k => cellText(row[k])).join(' · ') || '—'
    for (const [field, val] of Object.entries(changes)) {
      changeRows.push({ key, field, before: cellText(row[field]), after: cellText(val) })
    }
  }
  const rowCount = Object.keys(edits).length
  const shown = changeRows.slice(0, MAX_SHOWN)
  const extra = changeRows.length - shown.length

  const statusColor = s => s === 'ok' ? 'var(--green)' : s === 'warning' ? 'var(--yellow, #e6a817)' : 'var(--red)'

  return (
    <div style={backdrop} onClick={saving ? undefined : onClose}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{t('viewer.reviewTitle')}</div>
          {!result && (
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
              {t('viewer.reviewIntro', { rows: rowCount.toLocaleString(), changes: changeRows.length.toLocaleString() })}
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: result ? 18 : 0 }}>
          {result ? (
            <div style={{ fontSize: 13 }}>
              <div style={{ color: statusColor(result.status), fontWeight: 700, marginBottom: 8 }}>
                {result.status === 'ok' && t('viewer.saveOk', { n: (result.count ?? 0).toLocaleString() })}
                {result.status === 'warning' && t('viewer.saveWarn', { n: (result.errors?.length ?? 0).toLocaleString() })}
                {result.status === 'error' && t('viewer.saveErr', { msg: result.message || '' })}
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
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={TH}>{t('viewer.reviewRow')}</th>
                  <th style={TH}>{t('viewer.reviewField')}</th>
                  <th style={TH}>{t('viewer.reviewOld')}</th>
                  <th style={TH}>{t('viewer.reviewNew')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c, i) => (
                  <tr key={i}>
                    <td style={{ ...TD, color: 'var(--text2)' }} title={c.key}>{c.key}</td>
                    <td style={TD} title={c.field}>{c.field}</td>
                    <td style={{ ...TD, color: 'var(--text3)' }} title={c.before}>{c.before || '∅'}</td>
                    <td style={{ ...TD, color: 'var(--accent)' }} title={c.after}>{c.after || '∅'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!result && extra > 0 && (
            <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text3)' }}>{t('viewer.reviewMore', { n: extra })}</div>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 10, alignItems: 'center' }}>
          {saving && <span style={{ fontSize: 12, color: 'var(--text2)', marginRight: 'auto' }}>{t('viewer.saving')}</span>}
          {result ? (
            <button style={btnPri} onClick={onClose}>{t('viewer.close')}</button>
          ) : (
            <>
              <button style={btnSec} onClick={onClose} disabled={saving}>{t('viewer.cancel')}</button>
              <button style={{ ...btnPri, opacity: saving ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer' }} onClick={onConfirm} disabled={saving}>
                {t('viewer.reviewConfirm')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
