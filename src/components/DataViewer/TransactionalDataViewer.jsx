// ─────────────────────────────────────────────────────────────────────────────
// TransactionalDataViewer.jsx — "Ver Dato Transaccional" tab, Phase 1 (read-only).
//
// Key figures, not master attributes: the user picks a planning area, version and
// a LEVEL (dimensions + time granularity) plus the key figures to show. SAP
// AGGREGATES to that level, so the chosen columns define the data, not just the
// view. Reads are paginated server-side (readKfPage: $select + $skip/$top), exactly
// like the master-data viewer — we never download the whole area.
//
// Value/quantity KFs may require a target unit (UOMTOID) or currency (CURRTOID) in
// the filter; when SAP asks for one we surface a clear hint and the selectors are
// right there. Editing / blanking arrive in later phases.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  fetchKfCatalog, invalidateKfCatalog, fetchConversionValues,
  countKf, readKfPage,
  fetchCsrf, getTransactionId, initiateParallelProcess, postKfChunk,
  commitTransaction, waitForProcessed, readMessages,
  odataDateToIso, chunkByBytes, MAX_POST_BYTES,
} from '../../services/planningDataApi'
import { buildConditionFilter, condChip } from '../../services/filterUtils'
import { SearchSelect } from '../Migration/FilterControls'
import CollapsibleSection from './CollapsibleSection'
import DataGrid from './DataGrid'
import EditReviewModal from './EditReviewModal'

// Standard SAP IBP time levels (timestamp fields). week is the usual default.
const TIME_LEVELS = [
  { field: 'PERIODID4_TSTAMP', key: 'week' },
  { field: 'PERIODID3_TSTAMP', key: 'month' },
  { field: 'PERIODID2_TSTAMP', key: 'quarter' },
  { field: 'PERIODID1_TSTAMP', key: 'year' },
  { field: 'PERIODID0_TSTAMP', key: 'day' },
  { field: 'PERIODID5_TSTAMP', key: 'techweek' },
]
const READONLY_ATTRS = new Set(['VERSIONID', 'VERSIONNAME', 'SCENARIOID', 'SCENARIONAME', 'MASTER_DATA_TYPE', 'AGGREGATE', 'LASTMODIFIEDDATE', 'CREATEDDATE'])
const PAGESIZE_KEY = 'ibp:viewer:pagesize'
const PAGE_SIZES = [50, 100, 200, 500]

function loadPageSize() {
  const n = parseInt(localStorage.getItem(PAGESIZE_KEY) || '500', 10)
  return PAGE_SIZES.includes(n) ? n : 500
}
function errText(e) {
  if (e == null) return 'Error'
  if (typeof e === 'string') return e
  return e.message || String(e)
}
// SAP names the missing conversion attribute when a value/quantity KF needs one.
function convHint(e, t) {
  const d = (e?.detail || e?.message || '').toUpperCase()
  if (d.includes('UOMTOID')) return t('viewer.txNeedUom')
  if (d.includes('CURRTOID')) return t('viewer.txNeedCurr')
  return null
}

// ── Styles ──
const SECTION = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }
const LABEL   = { fontSize: 10, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5, display: 'block' }
const SELECT  = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '7px 10px', width: '100%', outline: 'none' }
const INPUT   = { ...SELECT }
const BTN_SEC = { background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 12px', cursor: 'pointer' }
function btnPrimary(disabled) {
  return { background: disabled ? 'var(--border2)' : 'var(--accent)', border: 'none', borderRadius: 6, color: disabled ? 'var(--text3)' : 'var(--text-on-accent)', fontSize: 12, fontWeight: 700, padding: '8px 18px', cursor: disabled ? 'not-allowed' : 'pointer' }
}

// ── Small multi-select with search (for dimensions and key figures) ──
const pickBtn = { ...BTN_SEC, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }
const pickPanel = { position: 'absolute', top: '100%', left: 0, zIndex: 60, marginTop: 4, width: 300, background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 8, boxShadow: 'var(--shadow-lg)', overflow: 'hidden' }
const pickItem = sel => ({ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', color: sel ? 'var(--accent)' : 'var(--text)', background: sel ? 'color-mix(in srgb, var(--accent) 9%, transparent)' : 'transparent' })

function MultiPick({ label, options, selected, onChange, labels = {}, t }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const sel = new Set(selected)
  const toggle = c => sel.has(c) ? onChange(selected.filter(x => x !== c)) : onChange([...selected, c])
  const ql = q.toLowerCase()
  const filtered = options.filter(o => !q || o.toLowerCase().includes(ql) || String(labels[o] || '').toLowerCase().includes(ql))
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)} style={pickBtn}>
        {label} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>({selected.length})</span> <span style={{ color: 'var(--text3)', fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div style={pickPanel}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t('viewer.txPickSearch')}
            style={{ background: 'var(--bg)', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text)', fontSize: 12, padding: '8px 10px', width: '100%', outline: 'none', boxSizing: 'border-box' }} />
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.map(o => (
              <label key={o} style={pickItem(sel.has(o))} title={labels[o] || o}>
                <input type="checkbox" checked={sel.has(o)} onChange={() => toggle(o)} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o}{labels[o] && labels[o] !== o ? <span style={{ color: 'var(--text3)' }}> — {labels[o]}</span> : null}
                </span>
              </label>
            ))}
            {filtered.length === 0 && <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text3)' }}>—</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export default function TransactionalDataViewer({ connection, session }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()

  // ── Catalog ──
  const [catalog, setCatalog]               = useState(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError]     = useState('')
  const [catalogTick, setCatalogTick]       = useState(0)

  const [selCollapsed, setSelCollapsed]   = useState(false)
  const [dataCollapsed, setDataCollapsed] = useState(false)

  // ── Selection ──
  const [area, setArea]       = useState('')
  const [version, setVersion] = useState('')   // '' = base
  const [selectedAttrs, setSelectedAttrs] = useState([])
  const [timeField, setTimeField]         = useState('')
  const [selectedKfs, setSelectedKfs]     = useState([])

  // ── Conversions ──
  const [units, setUnits]           = useState([])
  const [currencies, setCurrencies] = useState([])
  const [selUom, setSelUom]   = useState('')
  const [selCurr, setSelCurr] = useState('')

  // ── Filters ──
  const [conds, setConds]       = useState([])   // attribute conditions
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  // ── Grid query ──
  const [query, setQuery]       = useState(null)   // { page, pageSize, sort, filter, total, columns, keyNames }
  const [pageSize, setPageSize] = useState(loadPageSize)
  const [rows, setRows]         = useState([])
  const [gridLoading, setGridLoading] = useState(false)
  const [gridError, setGridError]     = useState('')
  const [applyError, setApplyError]   = useState('')   // pre-show errors (count / conversion)

  // ── Editing (Phase 2): only key figures are editable; level (dims+time) locked ──
  const [editMode, setEditMode]       = useState(false)
  const [edits, setEdits]             = useState({})    // { [rowKey]: { row, changes } }
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [saving, setSaving]           = useState(false)
  const [saveResult, setSaveResult]   = useState(null)

  const abortRef = useRef(null)

  // ── Load catalog (per area) ──
  useEffect(() => {
    let alive = true
    setCatalogLoading(true); setCatalogError('')
    fetchKfCatalog(connection, session, { pa: area || undefined })
      .then(cat => {
        if (!alive) return
        setCatalog(cat)
        if (!area) setArea(cat.pa)
      })
      .catch(e => { if (alive) setCatalogError(errText(e)) })
      .finally(() => { if (alive) setCatalogLoading(false) })
    return () => { alive = false }
  }, [connection.id, session?.com0720?.user, area, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => abortRef.current?.abort(), [])

  const refreshCatalog = useCallback(() => {
    invalidateKfCatalog(connection.id)
    setCatalogTick(n => n + 1)
  }, [connection.id])

  // Load conversion master (units/currencies) for the area — best effort.
  useEffect(() => {
    if (!catalog?.pa) return
    let alive = true
    fetchConversionValues(connection, session, catalog.pa, 'UOM').then(u => { if (alive) setUnits(u) }).catch(() => {})
    fetchConversionValues(connection, session, catalog.pa, 'CURR').then(c => { if (alive) setCurrencies(c) }).catch(() => {})
    return () => { alive = false }
  }, [connection.id, session?.com0720?.user, catalog?.pa]) // eslint-disable-line react-hooks/exhaustive-deps

  const areas    = catalog?.areas || []
  const dims     = useMemo(() => catalog?.dims || [], [catalog])
  const labels   = useMemo(() => catalog?.labels || {}, [catalog])
  const versions = catalog?.versions || []
  const attrList = useMemo(() => dims.filter(d => !d.startsWith('PERIODID') && !READONLY_ATTRS.has(d)).sort(), [dims])
  const kfList   = useMemo(() => (catalog?.measures || []).slice().sort(), [catalog])
  const timeLevelsAvail = useMemo(() => TIME_LEVELS.filter(tl => dims.includes(tl.field)), [dims])

  // Default the time level to the first available (week preferred by TIME_LEVELS order).
  useEffect(() => {
    if (timeLevelsAvail.length && !timeLevelsAvail.some(tl => tl.field === timeField)) {
      setTimeField(timeLevelsAvail[0].field)
    }
  }, [timeLevelsAvail, timeField])

  // Reset level + grid when the area/version changes.
  useEffect(() => {
    abortRef.current?.abort()
    setSelectedAttrs([]); setSelectedKfs([])
    setConds([]); setDateFrom(''); setDateTo(''); setSelUom(''); setSelCurr('')
    setQuery(null); setRows([]); setGridError(''); setApplyError('')
    setEdits({}); setEditMode(false); setSaveResult(null)
    setSelCollapsed(false); setDataCollapsed(false)
  }, [area, version])

  useEffect(() => { try { localStorage.setItem(PAGESIZE_KEY, String(pageSize)) } catch { /* quota */ } }, [pageSize])

  // Server-side $filter: attribute conditions + date range + conversions.
  const kfFilter = useMemo(() => {
    const esc = v => String(v).replace(/'/g, "''")
    const parts = []
    const cf = buildConditionFilter(conds); if (cf) parts.push(cf)
    if (timeField && dateFrom) parts.push(`${timeField} ge datetime'${dateFrom}T00:00:00'`)
    if (timeField && dateTo)   parts.push(`${timeField} le datetime'${dateTo}T23:59:59'`)
    if (selUom)  parts.push(`UOMTOID eq '${esc(selUom)}'`)
    if (selCurr) parts.push(`CURRTOID eq '${esc(selCurr)}'`)
    return parts.join(' and ') || undefined
  }, [conds, timeField, dateFrom, dateTo, selUom, selCurr])

  // ── Load one page (server-side) ──
  const runLoad = useCallback(async q => {
    if (!catalog?.pa) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setGridLoading(true); setGridError('')
    const select  = q.columns.join(',')
    const orderby = q.sort ? [`${q.sort.field}${q.sort.dir === 'desc' ? ' desc' : ''}`] : q.keyNames
    const skip    = (q.page - 1) * q.pageSize
    try {
      const data = await readKfPage(connection, session, catalog.pa, {
        select, filter: q.filter, skip, top: q.pageSize, orderby, signal: ac.signal,
      })
      if (ac.signal.aborted) return
      setRows(data)
    } catch (e) {
      if (e?.name === 'AbortError' || ac.signal.aborted) return
      setGridError(convHint(e, t) || t('viewer.loadError', { msg: errText(e) }))
    } finally {
      if (abortRef.current === ac) setGridLoading(false)
    }
  }, [catalog, connection, session, t])

  useEffect(() => { if (query) runLoad(query) }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  const canShow = !!catalog?.pa && !!timeField && selectedKfs.length > 0

  // "Mostrar datos" / "Aplicar": validate, count, then load page 1.
  const applyAndShow = useCallback(async () => {
    if (!canShow) { setApplyError(t('viewer.txNeedKf')); return }
    // Re-reading at a new level/filter invalidates unsaved KF edits.
    if (Object.keys(edits).length) {
      if (!window.confirm(t('viewer.discardEditsConfirm'))) return
      setEdits({})
    }
    setApplyError('')
    const columns  = [...selectedAttrs, timeField, ...selectedKfs]
    const keyNames = [...selectedAttrs, timeField]
    const select   = columns.join(',')
    let total = 0
    try {
      total = await countKf(connection, session, catalog.pa, { select, filter: kfFilter, retries: 1, timeout: 60000 })
    } catch (e) {
      setApplyError(convHint(e, t) || t('viewer.loadError', { msg: errText(e) }))
      return
    }
    // Snapshot the APPLIED level into the query so a later edit/save uses exactly
    // what was loaded (not drafts the user may have changed since).
    setQuery({ page: 1, pageSize, sort: null, filter: kfFilter, total, columns, keyNames, attrs: [...selectedAttrs], timeField, kfs: [...selectedKfs] })
    setSelCollapsed(true); setDataCollapsed(true)
  }, [canShow, selectedAttrs, timeField, selectedKfs, kfFilter, pageSize, connection, session, catalog, edits, t])

  // ── Editing helpers — only key figures (measures) of the applied query ──
  const editableCols = query?.kfs || []
  const onCellEdit = useCallback((rk, field, value, row) => {
    setEdits(prev => {
      const orig    = row[field]
      const cur     = prev[rk] || { row, changes: {} }
      const changes = { ...cur.changes }
      if (String(value) === String(orig ?? '')) delete changes[field]
      else changes[field] = value
      const next = { ...prev }
      if (Object.keys(changes).length === 0) delete next[rk]
      else next[rk] = { row: cur.row, changes }
      return next
    })
  }, [])
  const editCount    = Object.keys(edits).length
  const discardEdits = useCallback(() => setEdits({}), [])

  // ── Save KF edits: getTransactionID → [IPP] → postKfChunk → commit → poll → msgs ──
  const doSave = useCallback(async () => {
    const entries = Object.values(edits)
    if (!entries.length || !query) return
    const { attrs, timeField: tf, kfs } = query
    // Only the key figures actually changed (in their applied order).
    const union = new Set()
    entries.forEach(e => Object.keys(e.changes).forEach(f => union.add(f)))
    const changedKfs = kfs.filter(k => union.has(k))
    if (!changedKfs.length) return
    // AggregationLevelFieldsString = level dims + changed KFs + time (mirrors the KF
    // migration's field order). Each row carries the level identity, the time period
    // as ISO (the import body format), and the KF values (changed → new; untouched in
    // this row but in the batch's union → original value, an idempotent no-op).
    const fields = [...attrs, ...changedKfs, tf].join(',')
    const postRows = entries.map(({ row, changes }) => {
      const o = {}
      for (const a of attrs) o[a] = row[a] ?? ''
      o[tf] = odataDateToIso(row[tf])
      for (const k of changedKfs) o[k] = (k in changes) ? changes[k] : (row[k] ?? '0')
      return o
    })

    setSaving(true); setSaveResult(null)
    try {
      let csrf = null
      try { csrf = await fetchCsrf(connection, session) } catch { /* proxy fetches per POST */ }
      const txId = await getTransactionId(connection, session)
      try { await initiateParallelProcess(connection, session, txId, { planningArea: catalog.pa, versionId: version, transactionName: 'IBP-Viewer-KF-EDIT' }) } catch { /* best effort */ }
      const chunks = chunkByBytes(postRows, MAX_POST_BYTES, 5000)
      for (const chunk of chunks) {
        await postKfChunk(connection, session, catalog.pa, txId, chunk, { fields, versionId: version, doCommit: false, csrf })
      }
      await commitTransaction(connection, session, txId, { csrf })
      const st   = await waitForProcessed(connection, session, txId, { timeoutMs: 120000 })
      const msgs = await readMessages(connection, session, catalog.pa, txId)
      const errors = (msgs || []).filter(m => ['E', 'A'].includes(m.Severity))
      const status = errors.length ? 'warning' : (st === 'ERROR' ? 'error' : 'ok')
      setSaveResult({ status, count: postRows.length, errors, message: st === 'ERROR' ? t('viewer.saveProcessError') : '' })
      if (status === 'ok') { setEdits({}); runLoad(query) }
    } catch (e) {
      // A calculated key figure rejects the POST (HTTP 500 "invalid column name").
      const msg = e?.isCalculated ? t('viewer.txCalcKf', { kf: e.calculatedKf || '' }) : errText(e)
      setSaveResult({ status: 'error', message: msg })
    } finally {
      setSaving(false)
    }
  }, [edits, query, connection, session, version, catalog, runLoad, t])

  const onPageChange     = p  => setQuery(q => q ? { ...q, page: Math.min(Math.max(1, p), pageCount) } : q)
  const onPageSizeChange = sz => { setPageSize(sz); setQuery(q => q ? { ...q, pageSize: sz, page: 1 } : q) }
  const onSort = field => setQuery(q => {
    if (!q) return q
    let sort
    if (!q.sort || q.sort.field !== field) sort = { field, dir: 'asc' }
    else if (q.sort.dir === 'asc')         sort = { field, dir: 'desc' }
    else                                   sort = null
    return { ...q, sort, page: 1 }
  })
  const pageCount = Math.max(1, Math.ceil((query?.total || 0) / (query?.pageSize || pageSize)))

  // ── Filter editor (attribute conditions) ──
  const addCond    = () => setConds(c => [...c, { field: '', op: 'in', value: '' }])
  const removeCond = i  => setConds(c => c.filter((_, idx) => idx !== i))
  const setCond    = (i, patch) => setConds(c => c.map((x, idx) => idx === i ? { ...x, ...patch } : x))
  const fieldOptions = useMemo(() => attrList.map(c => ({ value: c, label: labels[c] && labels[c] !== c ? `${c} — ${labels[c]}` : c })), [attrList, labels])
  const activeChips = conds.map(condChip).filter(Boolean)

  const timeLabel = f => { const tl = TIME_LEVELS.find(x => x.field === f); return tl ? t(`kfm.time_${tl.key}`) : f }

  const selSummary = area ? [area, version || t('viewer.versionBase')].join('  /  ') : '—'
  const levelSummary = catalog
    ? `${t('viewer.txLevelSummary', { attrs: selectedAttrs.length, time: timeLabel(timeField) })} · ${t('viewer.txKfSummary', { n: selectedKfs.length })}`
    : ''

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: isMobile ? '12px' : '16px 20px', flexShrink: 0 }}>
        {catalogError && (
          <div style={{ ...SECTION, borderColor: 'var(--red)', color: 'var(--red)', fontSize: 12 }}>
            {t('viewer.catalogError', { msg: catalogError })}
          </div>
        )}

        {/* Area / version */}
        <CollapsibleSection
          title={t('viewer.secSelection')}
          collapsed={selCollapsed}
          onToggle={() => setSelCollapsed(v => !v)}
          summary={selSummary}
          actions={
            <button style={{ ...BTN_SEC, opacity: catalogLoading ? 0.6 : 1 }} onClick={refreshCatalog} disabled={catalogLoading} title={t('viewer.refreshTitle')}>
              {t('viewer.refresh')}
            </button>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <div>
              <label style={LABEL}>{t('viewer.area')}</label>
              <select style={SELECT} value={area} onChange={e => setArea(e.target.value)} disabled={catalogLoading || areas.length <= 1}>
                {areas.length === 0 && <option value="">{catalogLoading ? '…' : '—'}</option>}
                {areas.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label style={LABEL}>{t('viewer.version')}</label>
              <select style={SELECT} value={version} onChange={e => setVersion(e.target.value)} disabled={!catalog}>
                <option value="">{t('viewer.versionBase')}</option>
                {versions.filter(v => v.id).map(v => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
              </select>
            </div>
          </div>
        </CollapsibleSection>

        {/* Level + key figures + filters */}
        {catalog && (
          <CollapsibleSection
            title={t('viewer.secData')}
            collapsed={dataCollapsed}
            onToggle={() => setDataCollapsed(v => !v)}
            summary={levelSummary}
            actions={
              <button style={btnPrimary(!canShow)} disabled={!canShow} onClick={applyAndShow}>
                {!query ? t('viewer.showData') : t('viewer.applyFilter')}
              </button>
            }
          >
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>{t('viewer.txLevelNote')}</div>

            {/* Level row */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
              <div>
                <label style={LABEL}>{t('viewer.txAttrs')}</label>
                <MultiPick label={t('viewer.txAttrs')} options={attrList} selected={selectedAttrs} onChange={setSelectedAttrs} labels={labels} t={t} />
              </div>
              <div>
                <label style={LABEL}>{t('viewer.txTime')}</label>
                <select style={{ ...SELECT, width: 'auto' }} value={timeField} onChange={e => setTimeField(e.target.value)}>
                  {timeLevelsAvail.map(tl => <option key={tl.field} value={tl.field}>{t(`kfm.time_${tl.key}`)}</option>)}
                </select>
              </div>
              <div>
                <label style={LABEL}>{t('viewer.txKfs')}</label>
                <MultiPick label={t('viewer.txKfs')} options={kfList} selected={selectedKfs} onChange={setSelectedKfs} labels={labels} t={t} />
              </div>
              {units.length > 0 && (
                <div>
                  <label style={LABEL}>{t('viewer.txUom')}</label>
                  <select style={{ ...SELECT, width: 'auto' }} value={selUom} onChange={e => setSelUom(e.target.value)}>
                    <option value="">—</option>
                    {units.map(u => <option key={u.id} value={u.id}>{u.id}{u.desc && u.desc !== u.id ? ` — ${u.desc}` : ''}</option>)}
                  </select>
                </div>
              )}
              {currencies.length > 0 && (
                <div>
                  <label style={LABEL}>{t('viewer.txCurr')}</label>
                  <select style={{ ...SELECT, width: 'auto' }} value={selCurr} onChange={e => setSelCurr(e.target.value)}>
                    <option value="">—</option>
                    {currencies.map(c => <option key={c.id} value={c.id}>{c.id}{c.desc && c.desc !== c.id ? ` — ${c.desc}` : ''}</option>)}
                  </select>
                </div>
              )}
            </div>

            {/* Date range */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
              <div>
                <label style={LABEL}>{t('viewer.txDateFrom')} ({timeLabel(timeField)})</label>
                <input type="date" style={{ ...INPUT, width: 'auto' }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              </div>
              <div>
                <label style={LABEL}>{t('viewer.txDateTo')}</label>
                <input type="date" style={{ ...INPUT, width: 'auto' }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
              </div>
            </div>

            {/* Attribute filters */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{t('flt.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>{t('viewer.filterNote')}</div>
              {conds.map((c, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ width: isMobile ? '100%' : 220 }}>
                    <SearchSelect value={c.field} options={fieldOptions} onChange={v => setCond(i, { field: v })} placeholder={t('flt.fieldPh')} searchPlaceholder={t('flt.searchPh')} />
                  </div>
                  <select style={{ ...SELECT, width: 'auto' }} value={c.op} onChange={e => setCond(i, { op: e.target.value })}>
                    <option value="in">{t('flt.opIn')}</option>
                    <option value="sw">{t('flt.opSw')}</option>
                  </select>
                  <input value={c.value} onChange={e => setCond(i, { value: e.target.value })}
                    placeholder={c.op === 'sw' ? t('flt.valuePh') : t('flt.valuesPh')}
                    style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 11, padding: '4px 8px', flex: 1, minWidth: 140, outline: 'none', fontFamily: 'var(--mono)' }} />
                  <button title={t('flt.remove')} onClick={() => removeCond(i)} style={{ ...BTN_SEC, padding: '5px 9px', color: 'var(--red)', borderColor: 'var(--border)' }}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <button style={BTN_SEC} onClick={addCond}>{t('flt.addCond')}</button>
                {activeChips.length > 0 && <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{activeChips.join('  ·  ')}</span>}
              </div>
            </div>

            {applyError && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{applyError}</div>}
          </CollapsibleSection>
        )}
      </div>

      {/* Grid / placeholder */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: isMobile ? '0 12px 12px' : '0 20px 16px' }}>
        {!catalog && !catalogError && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{t('viewer.loadingSchema')}</div>
        )}
        {catalog && !query && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{t('viewer.txSelectLevel')}</div>
        )}
        {query && (
          <DataGrid
            columns={query.columns}
            rows={rows}
            keyNames={query.keyNames}
            loading={gridLoading}
            error={gridError}
            sort={query.sort}
            onSort={onSort}
            page={query.page}
            pageCount={pageCount}
            pageSize={query.pageSize}
            pageSizeOptions={PAGE_SIZES}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
            editMode={editMode}
            editableCols={editableCols}
            edits={edits}
            editCount={editCount}
            editHint={t('viewer.txEditHint')}
            onToggleEdit={() => setEditMode(v => !v)}
            onCellEdit={onCellEdit}
            onSaveEdits={() => { setSaveResult(null); setShowSaveModal(true) }}
            onDiscardEdits={discardEdits}
          />
        )}
      </div>

      <EditReviewModal
        open={showSaveModal}
        edits={edits}
        keyNames={query?.keyNames || []}
        saving={saving}
        result={saveResult}
        onConfirm={doSave}
        onClose={() => setShowSaveModal(false)}
      />
    </div>
  )
}
