// ─────────────────────────────────────────────────────────────────────────────
// DataGrid.jsx — read-only paginated grid (Phase 1 of the Data Viewer).
//
// Pure presentation: it renders the rows/columns it is given and delegates sort,
// pagination and page-size changes to the parent via callbacks. The parent does
// all data fetching SERVER-SIDE (one page at a time), so this grid never holds
// more than `pageSize` rows. Editing/selection arrive in later phases.
// ─────────────────────────────────────────────────────────────────────────────
import { useState } from 'react'
import { useI18n } from '../../context/I18nContext'
import { formatCell } from '../../services/catalogHelpers'

const TH = {
  textAlign: 'left', padding: '7px 10px', borderBottom: '1px solid var(--border)',
  color: 'var(--text2)', fontWeight: 700, fontSize: 10, textTransform: 'uppercase',
  letterSpacing: '.05em', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
  background: 'var(--bg2)', position: 'sticky', top: 0, zIndex: 1,
}
const TD = {
  padding: '5px 10px', borderBottom: '1px solid var(--border)', fontSize: 12,
  whiteSpace: 'nowrap', color: 'var(--text)', maxWidth: 360,
  overflow: 'hidden', textOverflow: 'ellipsis',
}
const navBtn = disabled => ({
  background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
  color: disabled ? 'var(--text3)' : 'var(--text2)', fontSize: 11, fontWeight: 600,
  padding: '5px 11px', cursor: disabled ? 'not-allowed' : 'pointer',
})
const inputSm = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text)', fontSize: 11, padding: '4px 7px', outline: 'none',
}

export default function DataGrid({
  columns, rows, keyNames = [], loading, error,
  sort, onSort,
  page, pageCount, pageSize, pageSizeOptions = [50, 100, 200, 500],
  onPageChange, onPageSizeChange,
}) {
  const { t } = useI18n()
  const keySet = new Set(keyNames)
  const [gotoVal, setGotoVal] = useState('')

  const sortIndicator = c => (!sort || sort.field !== c) ? '' : (sort.dir === 'desc' ? ' ▼' : ' ▲')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8,
        position: 'relative', background: 'var(--bg)',
      }}>
        {error && <div style={{ padding: 16, color: 'var(--red)', fontSize: 12 }}>{error}</div>}

        {!error && columns.length > 0 && (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--mono)' }}>
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c} style={TH} onClick={() => onSort?.(c)} title={c}>
                    {keySet.has(c) && <span style={{ color: 'var(--accent)', marginRight: 4 }}>🔑</span>}
                    {c}{sortIndicator(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {columns.map(c => {
                    const v = formatCell(r[c])
                    return <td key={c} style={TD} title={v == null ? '' : String(v)}>{v}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!error && !loading && rows.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
            {t('viewer.empty')}
          </div>
        )}

        {loading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--bg) 55%, transparent)', fontSize: 12, color: 'var(--text2)',
          }}>
            {t('viewer.loading')}
          </div>
        )}
      </div>

      {/* Pagination bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 2px', flexShrink: 0, flexWrap: 'wrap' }}>
        <button disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)} style={navBtn(loading || page <= 1)}>
          {t('viewer.prev')}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text2)' }}>{t('viewer.pageOf', { page, pages: pageCount })}</span>
        <button disabled={loading || page >= pageCount} onClick={() => onPageChange(page + 1)} style={navBtn(loading || page >= pageCount)}>
          {t('viewer.next')}
        </button>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{t('viewer.goto')}</span>
          <input
            value={gotoVal}
            onChange={e => setGotoVal(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={e => {
              if (e.key === 'Enter' && gotoVal) {
                const p = Math.min(pageCount, Math.max(1, parseInt(gotoVal, 10)))
                onPageChange(p); setGotoVal('')
              }
            }}
            placeholder="#"
            style={{ width: 52, ...inputSm }}
          />
        </span>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('viewer.pageSize')}
          <select value={pageSize} onChange={e => onPageSizeChange(parseInt(e.target.value, 10))} style={inputSm}>
            {pageSizeOptions.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}
