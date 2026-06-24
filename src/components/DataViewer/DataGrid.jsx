// ─────────────────────────────────────────────────────────────────────────────
// DataGrid.jsx — paginated grid for the Data Viewer (Phase 1 read + Phase 2 edit).
//
// Pure presentation: it renders the rows/columns it is given and delegates sort,
// pagination, page-size and edit events to the parent via callbacks. The parent
// does all data fetching SERVER-SIDE (one page at a time), so this grid never
// holds more than `pageSize` rows.
//
// Per-column text filter: a small input under each column header narrows the rows
// CLIENT-SIDE, by prefix (starts-with, case-insensitive). It only filters the
// rows already on screen (the current page) — server-side filtering happens before
// "Mostrar datos" via the filter panel. A persistent note makes this explicit.
//
// Editing (Phase 2): when `editMode` is on, clicking an editable cell turns it into
// an input. Edits live in the PARENT (so they survive pagination and feed the save
// modal); this grid only overlays them and reports changes via onCellEdit. Key and
// read-only columns are never editable.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useRef } from 'react'
import { useI18n } from '../../context/I18nContext'
import { formatCell } from '../../services/catalogHelpers'

// Default cap for auto-sized columns: they fit their content/header up to this,
// then ellipsize. The user can drag wider or double-click the handle to auto-fit.
const AUTO_MAX = 600
const MIN_COL  = 60

const THCELL = {
  textAlign: 'left', padding: '6px 10px 5px', borderBottom: '1px solid var(--border)',
  background: 'var(--bg2)', position: 'sticky', top: 0, zIndex: 1, verticalAlign: 'top',
}
const THNAME = {
  color: 'var(--text2)', fontWeight: 700, fontSize: 10, textTransform: 'uppercase',
  letterSpacing: '.05em', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
  display: 'flex', alignItems: 'center', gap: 4,
}
const COLFILTER = {
  marginTop: 5, width: '100%', boxSizing: 'border-box',
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 5,
  color: 'var(--text)', fontSize: 11, padding: '3px 6px', outline: 'none',
  fontFamily: 'var(--mono)', fontWeight: 400, textTransform: 'none', letterSpacing: 0,
}
const TD = {
  padding: '5px 10px', borderBottom: '1px solid var(--border)', fontSize: 12,
  whiteSpace: 'nowrap', color: 'var(--text)',
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
const topBtn = {
  background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
  color: 'var(--text2)', fontSize: 11, fontWeight: 600, padding: '4px 10px', cursor: 'pointer',
}
const primaryBtn = {
  background: 'var(--accent)', border: 'none', borderRadius: 6,
  color: 'var(--text-on-accent)', fontSize: 11, fontWeight: 700, padding: '4px 12px', cursor: 'pointer',
}
const dangerBtn = {
  background: 'none', border: '1px solid var(--red)', borderRadius: 6,
  color: 'var(--red)', fontSize: 11, fontWeight: 700, padding: '4px 12px', cursor: 'pointer',
}
const SELCELL = { padding: '0 6px', borderBottom: '1px solid var(--border)', textAlign: 'center', width: 34, minWidth: 34 }
const DIRTY_BG = 'color-mix(in srgb, var(--accent) 16%, transparent)'

const cellText = v => { const c = formatCell(v); return c == null ? '' : String(c) }

export default function DataGrid({
  columns, rows, keyNames = [], loading, error,
  sort, onSort, onReorder,
  page, pageCount, pageSize, total, pageSizeOptions = [50, 100, 200, 500],
  onPageChange, onPageSizeChange,
  // Phase 2 editing (all optional — absent ⇒ read-only grid):
  editMode = false, editableCols = [], edits = {}, editCount = 0, editHint,
  onToggleEdit, onCellEdit, onSaveEdits, onDiscardEdits,
  // Phase 3 row selection / delete (optional — absent ⇒ no checkboxes):
  selectedKeys = {}, selCount = 0, onToggleRow, onToggleAllPage, onDeleteSelected,
  // Fullscreen is controlled by the ViewerTabs shell (so the tab strip stays visible
  // and usable while fullscreen). Absent ⇒ the button is hidden.
  fullscreen = false, onToggleFullscreen,
  // CSV export (optional — absent ⇒ no button). The PARENT does the paged read-all +
  // download (it owns the filter/columns/credentials); this grid only renders the
  // button, or — while running — the progress text + a cancel button.
  onExport, exporting = false, exportProgress = null, onCancelExport,
}) {
  const { t } = useI18n()
  const keySet = new Set(keyNames)
  const editableSet = new Set(editableCols)
  const editHintText = editHint || t('viewer.editHint')
  const [gotoVal, setGotoVal] = useState('')
  const [colFilters, setColFilters] = useState({})   // { [col]: text } — prefix match, current page only
  const [colWidths, setColWidths] = useState({})     // { [col]: px } — explicit width (drag/auto-fit); absent = auto-fit
  const [dragOverCol, setDragOverCol] = useState(null)
  const [editing, setEditing] = useState(null)       // { rk, field } currently in an input
  const [draft, setDraft] = useState('')

  const tableRef   = useRef(null)
  const measureRef = useRef(null)   // reused offscreen canvas for text measurement
  const dragColRef = useRef(null)   // column being dragged to reorder

  const sortIndicator = c => (!sort || sort.field !== c) ? '' : (sort.dir === 'desc' ? ' ▼' : ' ▲')

  // Width style for a column: explicit (pinned) when set, else auto-fit up to AUTO_MAX.
  const widthStyle = c => {
    const w = colWidths[c]
    return w ? { width: w, minWidth: w, maxWidth: w } : { maxWidth: AUTO_MAX }
  }

  // Drag the right edge of a header to resize that column.
  const startResize = (e, c) => {
    e.preventDefault(); e.stopPropagation()
    const th = e.target.closest('th')
    const startW = th ? th.offsetWidth : (colWidths[c] || 120)
    const startX = e.clientX
    const onMove = ev => {
      const w = Math.max(MIN_COL, startW + (ev.clientX - startX))
      setColWidths(p => ({ ...p, [c]: w }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // Double-click the edge: auto-fit the column to the widest of header + visible cells.
  const autoFit = (e, c) => {
    e.preventDefault(); e.stopPropagation()
    const canvas = measureRef.current || (measureRef.current = document.createElement('canvas'))
    const ctx = canvas.getContext('2d')
    const sample = tableRef.current?.querySelector('tbody td') || tableRef.current?.querySelector('th')
    const font = sample ? getComputedStyle(sample).font : ''
    ctx.font = font && font.trim() ? font : '12px monospace'
    let max = ctx.measureText(c).width + (keySet.has(c) ? 22 : 0)   // header (+ key icon allowance)
    for (const r of visibleRows) {
      const w = ctx.measureText(cellText(r[c])).width
      if (w > max) max = w
    }
    const W = Math.min(800, Math.max(MIN_COL, Math.ceil(max) + 28))   // + cell padding & sort arrow
    setColWidths(p => ({ ...p, [c]: W }))
  }

  // Drag a header onto another to reorder — `from` is inserted before `to`.
  const reorderTo = to => {
    const from = dragColRef.current
    if (!from || from === to || !onReorder) return
    const next = columns.slice()
    next.splice(next.indexOf(from), 1)
    next.splice(next.indexOf(to), 0, from)
    onReorder(next)
  }

  // Only consider filters for columns that are currently shown (stale keys for
  // hidden columns are ignored, so no effect-based pruning is needed).
  const colSet = new Set(columns)
  const active = Object.entries(colFilters).filter(([c, v]) => v && v.trim() && colSet.has(c))
  const visibleRows = active.length === 0 ? rows : rows.filter(r =>
    active.every(([c, v]) => cellText(r[c]).toLowerCase().startsWith(v.trim().toLowerCase()))
  )

  const rowKeyOf = r => keyNames.map(k => String(r[k] ?? '')).join('')
  const beginEdit = (rk, field, current) => { setEditing({ rk, field }); setDraft(current == null ? '' : String(current)) }
  const commitEdit = (rk, field, row) => { onCellEdit?.(rk, field, draft, row); setEditing(null) }

  // Row selection (Phase 3 delete) — checkboxes appear only when wired up.
  const selectable  = !!onToggleRow
  const allChecked  = selectable && visibleRows.length > 0 && visibleRows.every(r => selectedKeys[rowKeyOf(r)])
  const someChecked = selectable && visibleRows.some(r => selectedKeys[rowKeyOf(r)])

  // The ViewerTabs shell now provides the fullscreen overlay (so the tab strip stays
  // on top and usable); the grid itself just fills its container in both modes.
  const rootStyle = { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }

  return (
    <div style={rootStyle}>
      {/* Top bar: notes + edit controls + fullscreen */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px 6px', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>ⓘ {t('viewer.colFilterNote')}</span>
        {!editMode && <span style={{ fontSize: 11, color: 'var(--text3)' }}>ⓘ {t('viewer.gridHint')}</span>}
        {editMode && <span style={{ fontSize: 11, color: 'var(--accent)' }}>✎ {editHintText}</span>}
        {active.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--accent)' }}>
            {t('viewer.showingOf', { n: visibleRows.length.toLocaleString(), total: rows.length.toLocaleString() })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {selCount > 0 && (
          <button style={dangerBtn} onClick={() => onDeleteSelected?.()}>{t('viewer.delete', { n: selCount })}</button>
        )}
        {editMode && editCount > 0 && (
          <>
            <button style={primaryBtn} onClick={() => onSaveEdits?.()}>{t('viewer.save', { n: editCount })}</button>
            <button style={topBtn} onClick={() => onDiscardEdits?.()}>{t('viewer.discard')}</button>
          </>
        )}
        {onToggleEdit && (
          <button
            style={{ ...topBtn, ...(editMode ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
            onClick={() => { setEditing(null); onToggleEdit() }}
            title={editHintText}
          >
            ✎ {editMode ? t('viewer.editActive') : t('viewer.edit')}
          </button>
        )}
        {onExport && (
          exporting ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                ⏳ {t('viewer.exporting', { loaded: (exportProgress?.loaded ?? 0).toLocaleString(), total: (exportProgress?.total ?? 0).toLocaleString() })}
              </span>
              <button style={dangerBtn} onClick={() => onCancelExport?.()}>{t('viewer.exportCancel')}</button>
            </span>
          ) : (
            <button style={topBtn} onClick={() => onExport()} title={t('viewer.exportTitle')}>
              ⬇ {t('viewer.export')}
            </button>
          )
        )}
        {onToggleFullscreen && (
          <button
            style={topBtn}
            onClick={onToggleFullscreen}
            title={fullscreen ? t('viewer.exitFullscreenTitle') : t('viewer.fullscreenTitle')}
          >
            {fullscreen ? t('viewer.exitFullscreen') : t('viewer.fullscreen')}
          </button>
        )}
      </div>

      <div style={{
        flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8,
        position: 'relative', background: 'var(--bg)',
      }}>
        {error && <div style={{ padding: 16, color: 'var(--red)', fontSize: 12 }}>{error}</div>}

        {!error && columns.length > 0 && (
          <table ref={tableRef} style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'auto', fontFamily: 'var(--mono)' }}>
            <thead>
              <tr>
                {selectable && (
                  <th style={{ ...THCELL, width: 34, minWidth: 34, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={el => { if (el) el.indeterminate = someChecked && !allChecked }}
                      onChange={e => onToggleAllPage?.(visibleRows.map(r => ({ rk: rowKeyOf(r), row: r })), e.target.checked)}
                      title={t('viewer.selectAllPage')}
                    />
                  </th>
                )}
                {columns.map(c => (
                  <th
                    key={c}
                    style={{ ...THCELL, ...widthStyle(c), boxShadow: dragOverCol === c ? 'inset 2px 0 0 0 var(--accent)' : undefined }}
                    onDragOver={e => { if (onReorder && dragColRef.current && dragColRef.current !== c) { e.preventDefault(); setDragOverCol(c) } }}
                    onDragLeave={() => setDragOverCol(o => (o === c ? null : o))}
                    onDrop={e => { e.preventDefault(); reorderTo(c); setDragOverCol(null) }}
                  >
                    <div
                      style={{ ...THNAME, cursor: onReorder ? 'grab' : 'pointer' }}
                      onClick={() => onSort?.(c)}
                      title={onReorder ? t('viewer.colHeaderHint', { c }) : c}
                      draggable={!!onReorder}
                      onDragStart={e => { dragColRef.current = c; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', c) } catch { /* IE */ } }}
                      onDragEnd={() => { dragColRef.current = null; setDragOverCol(null) }}
                    >
                      {keySet.has(c) && <span style={{ color: 'var(--accent)', flex: '0 0 auto' }}>🔑</span>}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                        {c}{sortIndicator(c)}
                      </span>
                    </div>
                    <input
                      value={colFilters[c] || ''}
                      onChange={e => setColFilters(p => ({ ...p, [c]: e.target.value }))}
                      onClick={e => e.stopPropagation()}
                      placeholder={t('viewer.colFilterPh')}
                      style={COLFILTER}
                    />
                    {/* Resize handle: drag to set width, double-click to auto-fit. */}
                    <div
                      onMouseDown={e => startResize(e, c)}
                      onDoubleClick={e => autoFit(e, c)}
                      onClick={e => e.stopPropagation()}
                      title={t('viewer.resizeHint')}
                      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 7, cursor: 'col-resize', userSelect: 'none', borderRight: '1px solid var(--border)' }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => {
                const rk = rowKeyOf(r)
                const changes = edits[rk]?.changes
                return (
                  <tr key={rk}>
                    {selectable && (
                      <td style={SELCELL}>
                        <input type="checkbox" checked={!!selectedKeys[rk]} onChange={() => onToggleRow?.(rk, r)} />
                      </td>
                    )}
                    {columns.map(c => {
                      const isDirty = changes && Object.prototype.hasOwnProperty.call(changes, c)
                      const rawVal  = isDirty ? changes[c] : r[c]
                      const txt     = cellText(rawVal)
                      const canEdit = editMode && editableSet.has(c)
                      const isEditing = editMode && editing && editing.rk === rk && editing.field === c
                      if (isEditing) {
                        return (
                          <td key={c} style={{ ...TD, ...widthStyle(c), padding: '2px 4px' }}>
                            <input
                              autoFocus
                              value={draft}
                              onChange={e => setDraft(e.target.value)}
                              onBlur={() => commitEdit(rk, c, r)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitEdit(rk, c, r)
                                else if (e.key === 'Escape') setEditing(null)
                              }}
                              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 4, color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', padding: '3px 5px', outline: 'none' }}
                            />
                          </td>
                        )
                      }
                      return (
                        <td
                          key={c}
                          style={{ ...TD, ...widthStyle(c), cursor: canEdit ? 'pointer' : 'default', background: isDirty ? DIRTY_BG : undefined }}
                          title={canEdit ? t('viewer.cellEditHint') : txt}
                          onClick={canEdit ? () => beginEdit(rk, c, rawVal) : undefined}
                        >
                          {txt}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {!error && !loading && rows.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
            {t('viewer.empty')}
          </div>
        )}
        {!error && !loading && rows.length > 0 && visibleRows.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
            {t('viewer.colFilterEmpty')}
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
        {total != null && (
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
            {t('viewer.totalRows', { n: Number(total).toLocaleString() })}
          </span>
        )}
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
