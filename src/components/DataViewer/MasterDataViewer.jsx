// ─────────────────────────────────────────────────────────────────────────────
// MasterDataViewer.jsx — "Ver Dato Maestro" tab, Phase 1 (read-only).
//
// Flow: pick area → version → table. We then read ONLY the schema (column names,
// key names) and the row COUNT — never the rows. The user optionally defines
// SERVER-SIDE filters ($filter, resolved by SAP) and presses "Mostrar datos" to
// load the first page. Every read is paginated server-side ($skip/$top) over the
// selected columns ($select) only — we never download a whole table. Editing and
// deletion arrive in later phases; the $select always includes the key columns so
// each row stays addressable then.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  fetchVsmt, buildCatalog, invalidateVsmtCache,
  fetchCount, readEntityPage, fetchFieldNames, fetchKeyNames, fetchDistinctValues,
  fetchCsrf, getTransactionId, initiateParallelProcess, postTransChunk,
  commitTransaction, waitForProcessed, readMessages,
  chunkByBytes, MAX_POST_BYTES, READONLY_FIELDS,
} from '../../services/masterDataApi'
import { getPas, getVersions, getMdts } from '../../services/catalogHelpers'
import { buildConditionFilter, condChip } from '../../services/filterUtils'
import { SearchSelect, MultiValueSelect } from '../Migration/FilterControls'
import ColumnPicker from './ColumnPicker'
import CollapsibleSection from './CollapsibleSection'
import DataGrid from './DataGrid'
import EditReviewModal from './EditReviewModal'

// ── localStorage keys ──
const COLS_KEY     = (connId, mdt) => `ibp:viewer:cols:master:${connId}:${mdt}`
const PAGESIZE_KEY = 'ibp:viewer:pagesize'
const PAGE_SIZES   = [50, 100, 200, 500]

function loadCols(connId, mdt) {
  try { return JSON.parse(localStorage.getItem(COLS_KEY(connId, mdt))) || null } catch { return null }
}
function saveCols(connId, mdt, cols) {
  try { localStorage.setItem(COLS_KEY(connId, mdt), JSON.stringify(cols)) } catch { /* quota */ }
}
function loadPageSize() {
  const n = parseInt(localStorage.getItem(PAGESIZE_KEY) || '500', 10)
  return PAGE_SIZES.includes(n) ? n : 500
}

// Sensible default: keys + descriptions when present, otherwise all columns.
function defaultSelection(allColumns, keyNames) {
  const keySet = new Set(keyNames)
  const sel = allColumns.filter(c => keySet.has(c) || /DESCR/i.test(c))
  return sel.length > 0 ? sel : [...allColumns]
}

function errText(e) {
  if (e == null) return 'Error'
  if (typeof e === 'string') return e
  return e.message || String(e)
}

// ── Styles ──
const SECTION = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }
const LABEL   = { fontSize: 10, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5, display: 'block' }
const SELECT  = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '7px 10px', width: '100%', outline: 'none' }
const BTN_SEC = { background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 12px', cursor: 'pointer' }
function btnPrimary(disabled) {
  return {
    background: disabled ? 'var(--border2)' : 'var(--accent)', border: 'none', borderRadius: 6,
    color: disabled ? 'var(--text3)' : 'var(--text-on-accent)', fontSize: 12, fontWeight: 700,
    padding: '8px 18px', cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

export default function MasterDataViewer({ connection, session }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()

  // ── Catalog ──
  const [catalog, setCatalog]               = useState(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError]     = useState('')
  // Bump to force a fresh catalog read after invalidating the cache ("↺ Actualizar").
  const [catalogTick, setCatalogTick]       = useState(0)

  // ── Collapsible config panels ──
  // Open while configuring; auto-collapse once data is loaded (applyAndShow) and
  // re-open when the table changes (schema effect). Toggleable any time by hand.
  const [selCollapsed, setSelCollapsed]   = useState(false)
  const [dataCollapsed, setDataCollapsed] = useState(false)

  // ── Selection ──
  const [pa, setPa]           = useState('')
  const [version, setVersion] = useState('')   // '' = base / no version
  const [mdt, setMdt]         = useState('')

  // ── Schema of the selected table ──
  const [schema, setSchema]               = useState(null)   // { allColumns, keyNames, total }
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError]     = useState('')
  const [selectedCols, setSelectedCols]   = useState([])   // draft: edited freely, no fetch
  const [appliedCols, setAppliedCols]     = useState([])   // committed on "Aplicar" — what `rows` reflect & the grid renders

  // ── Filters ──
  const [conds, setConds]           = useState([])     // [{ field, op:'in'|'sw', value }]
  const [filterTest, setFilterTest] = useState(null)   // { loading?, n?, total?, error? }

  // ── Grid query (null until "Mostrar datos") ──
  // { page, pageSize, sort:{field,dir}|null, filter, total }
  const [query, setQuery]       = useState(null)
  const [pageSize, setPageSize] = useState(loadPageSize)
  const [rows, setRows]         = useState([])
  const [gridLoading, setGridLoading] = useState(false)
  const [gridError, setGridError]     = useState('')

  // ── Editing (Phase 2) ──
  const [editMode, setEditMode]       = useState(false)
  const [edits, setEdits]             = useState({})    // { [rowKey]: { row, changes } } — persists across pages
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [saving, setSaving]           = useState(false)
  const [saveResult, setSaveResult]   = useState(null)  // { status, count?, errors?, message? }

  const abortRef = useRef(null)

  // ── Load catalog on mount / session change ──
  useEffect(() => {
    let alive = true
    setCatalogLoading(true); setCatalogError('')
    fetchVsmt(connection, session)
      .then(r => { if (alive) setCatalog(buildCatalog(r)) })
      .catch(e => { if (alive) setCatalogError(errText(e)) })
      .finally(() => { if (alive) setCatalogLoading(false) })
    return () => { alive = false }
  }, [connection.id, session?.com0720?.user, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => abortRef.current?.abort(), [])

  // Invalidate the cached VSMT catalog and force a fresh discovery from SAP —
  // recovers an IBP config change (new area/version/table) without waiting out the
  // 24 h cache TTL. Mirrors the "↺ Actualizar" button in the Migration tabs.
  const refreshCatalog = useCallback(() => {
    invalidateVsmtCache(connection.id)
    setCatalogTick(n => n + 1)
  }, [connection.id])

  const pas      = useMemo(() => getPas(catalog), [catalog])
  const versions = useMemo(() => getVersions(catalog, pa), [catalog, pa])
  const mdts     = useMemo(() => getMdts(catalog, pa, version), [catalog, pa, version])

  // Auto-select the only planning area, if there is just one.
  useEffect(() => { if (!pa && pas.length === 1) setPa(pas[0].id) }, [pas, pa])

  // Reset downstream selection when context changes.
  useEffect(() => { setVersion(''); setMdt('') }, [pa])
  useEffect(() => { setMdt('') }, [version])

  // ── On table change: reset grid + read schema (NO rows) ──
  useEffect(() => {
    abortRef.current?.abort()
    setQuery(null); setRows([]); setGridError('')
    setConds([]); setFilterTest(null)
    setSchema(null); setSchemaError('')
    // Drop any unsaved edits and leave edit mode — they belonged to the old table.
    setEdits({}); setEditMode(false); setSaveResult(null)
    // Back to configuring → open both panels so the selection/columns are visible.
    setSelCollapsed(false); setDataCollapsed(false)
    if (!mdt) return
    let alive = true
    const ac = new AbortController()
    setSchemaLoading(true)
    Promise.all([
      // Schema is version-independent; read it WITHOUT the version filter (a
      // version-filtered sample read can be pathologically slow on some tenants).
      fetchFieldNames(connection, session, mdt, { planningArea: pa, versionId: '', signal: ac.signal }),
      fetchKeyNames(connection, session, mdt, { planningArea: pa, versionId: version, signal: ac.signal }),
      fetchCount(connection, session, mdt, { planningArea: pa, versionId: version, retries: 1, timeout: 60000, signal: ac.signal }),
    ]).then(([fields, keys, total]) => {
      if (!alive) return
      const allColumns = fields || []
      const keyNames   = keys || []
      setSchema({ allColumns, keyNames, total })
      const saved = loadCols(connection.id, mdt)
      let validSaved = saved ? saved.filter(c => allColumns.includes(c)) : []
      // Guard against a stale/leaked selection: if the saved set contains NONE of
      // this table's key columns, it's almost certainly not a real choice for this
      // table → discard it and fall back to the default (which includes the keys).
      if (validSaved.length && keyNames.length && !validSaved.some(c => keyNames.includes(c))) {
        validSaved = []
      }
      const initial = validSaved.length ? validSaved : defaultSelection(allColumns, keyNames)
      setSelectedCols(initial)
      setAppliedCols(initial)
    }).catch(e => { if (alive) setSchemaError(errText(e)) })
      .finally(() => { if (alive) setSchemaLoading(false) })
    return () => { alive = false; ac.abort() }
  }, [mdt, pa, version, connection.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the column choice ONLY on explicit user edits for the CURRENT table.
  // (An effect keyed on [selectedCols, mdt] would fire on the transient render
  //  right after a table switch — mdt already new, selectedCols still old — and
  //  save the previous table's columns under the new table's key, corrupting it.)
  const onColumnsChange = useCallback(cols => {
    setSelectedCols(cols)
    if (mdt) saveCols(connection.id, mdt, cols)
  }, [mdt, connection.id])

  // Reorder (drag headers): reflect the new order in the displayed columns AND the
  // draft, keeping any not-yet-applied draft columns at the end. No fetch — same
  // data, just a different column order.
  const onReorderColumns = useCallback(newOrder => {
    setAppliedCols(newOrder)
    setSelectedCols(prev => {
      const prevSet = new Set(prev)
      const ordered = newOrder.filter(c => prevSet.has(c))
      const extras  = prev.filter(c => !newOrder.includes(c))
      const next = [...ordered, ...extras]
      if (mdt) saveCols(connection.id, mdt, next)
      return next
    })
  }, [mdt, connection.id])

  useEffect(() => { try { localStorage.setItem(PAGESIZE_KEY, String(pageSize)) } catch { /* quota */ } }, [pageSize])

  const extraFilter = useMemo(() => buildConditionFilter(conds) || undefined, [conds])

  // ── Editing helpers ──
  // Editable = everything except the business keys and the server-managed
  // read-only fields (PlanningAreaID, VersionID, CREATEDDATE, LASTMODIFIEDDATE).
  const editableCols = useMemo(() => {
    if (!schema) return []
    const keySet = new Set(schema.keyNames)
    return schema.allColumns.filter(c => !keySet.has(c) && !READONLY_FIELDS.has(c))
  }, [schema])

  // Record a cell edit. `row` is the ORIGINAL row snapshot (used to detect reverts
  // and to carry the keys + untouched fields when building the upsert payload).
  const onCellEdit = useCallback((rk, field, value, row) => {
    setEdits(prev => {
      const orig    = row[field]
      const cur     = prev[rk] || { row, changes: {} }
      const changes = { ...cur.changes }
      if (String(value) === String(orig ?? '')) delete changes[field]   // reverted → no longer dirty
      else changes[field] = value
      const next = { ...prev }
      if (Object.keys(changes).length === 0) delete next[rk]
      else next[rk] = { row: cur.row, changes }
      return next
    })
  }, [])

  const editCount    = Object.keys(edits).length
  const discardEdits = useCallback(() => setEdits({}), [])

  // ── Load one page for a given query (server-side $skip/$top/$orderby/$filter) ──
  const runLoad = useCallback(async q => {
    if (!mdt || !schema) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setGridLoading(true); setGridError('')
    const skip    = (q.page - 1) * q.pageSize
    const orderby = q.sort
      ? [`${q.sort.field}${q.sort.dir === 'desc' ? ' desc' : ''}`]
      : (schema.keyNames.length ? schema.keyNames : undefined)
    // Always fetch the key columns (even if hidden) so rows stay addressable for
    // the edit/delete phases; the grid only RENDERS the applied columns.
    const select = [...new Set([...appliedCols, ...schema.keyNames])]
    try {
      const data = await readEntityPage(connection, session, mdt, {
        skip, top: q.pageSize, planningArea: pa, versionId: version,
        select, orderby, extraFilter: q.filter, signal: ac.signal,
      })
      if (ac.signal.aborted) return
      setRows(data)
    } catch (e) {
      if (e?.name === 'AbortError' || ac.signal.aborted) return
      setGridError(t('viewer.loadError', { msg: errText(e) }))
    } finally {
      if (abortRef.current === ac) setGridLoading(false)
    }
  }, [mdt, schema, appliedCols, connection, session, pa, version, t])

  // Reload only when the query changes (page / sort / filter / applied columns).
  // Column edits do NOT fetch — they wait for "Aplicar" (see applyAndShow), so
  // toggling columns can't flood the proxy with one read per click.
  useEffect(() => {
    if (query) runLoad(query)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  // "Mostrar datos" / "Aplicar": (re)count for the active filter, then load page 1.
  const applyAndShow = useCallback(async () => {
    if (!mdt || !schema) return
    // Changing columns/filter re-reads rows → unsaved edits would no longer line up.
    if (Object.keys(edits).length) {
      if (!window.confirm(t('viewer.discardEditsConfirm'))) return
      setEdits({})
    }
    let total = schema.total
    if (extraFilter) {
      try {
        total = await fetchCount(connection, session, mdt, { planningArea: pa, versionId: version, extraFilter, retries: 1, timeout: 60000 })
      } catch { /* keep base total */ }
    }
    // Commit the draft column selection — this is the ONLY place a fetch is
    // triggered for column changes, so editing columns never hits SAP on its own.
    setAppliedCols(selectedCols)
    setQuery({ page: 1, pageSize, sort: null, filter: extraFilter, total })
    // Data is loaded → collapse config to give the grid room.
    setSelCollapsed(true); setDataCollapsed(true)
  }, [mdt, schema, extraFilter, selectedCols, connection, session, pa, version, pageSize, edits, t])

  // ── Save edits: review-confirmed upsert → commit → poll → messages ──
  const doSave = useCallback(async () => {
    const entries = Object.values(edits)
    if (!entries.length || !schema) return
    const keyNames = schema.keyNames
    // Uniform attribute set across the batch (keys + union of all changed fields)
    // so every POSTed row carries the same columns (postTransChunk derives
    // RequestedAttributes from the first row). Untouched fields keep their original
    // value, so they upsert as no-ops rather than getting blanked.
    const union = new Set()
    entries.forEach(e => Object.keys(e.changes).forEach(f => union.add(f)))
    const fields = [...union]
    const postRows = entries.map(({ row, changes }) => {
      const out = {}
      for (const k of keyNames) out[k] = row[k]
      for (const f of fields) out[f] = (f in changes) ? changes[f] : row[f]
      return out
    })

    setSaving(true); setSaveResult(null)
    try {
      let csrf = null
      try { csrf = await fetchCsrf(connection, session) } catch { /* proxy fetches per POST */ }
      const txId = await getTransactionId(connection, session, { versionId: version, masterDataTypeId: mdt, planningArea: pa })
      try { await initiateParallelProcess(connection, session, txId, { planningArea: pa, versionId: version, masterDataTypeId: mdt, transactionName: 'IBP-Viewer-EDIT' }) } catch { /* best effort */ }
      const chunks = chunkByBytes(postRows, MAX_POST_BYTES, 5000)
      for (const chunk of chunks) {
        await postTransChunk(connection, session, mdt, txId, chunk, { deleteEntries: false, planningArea: pa, versionId: version, csrf })
      }
      await commitTransaction(connection, session, txId, { csrf })
      const st   = await waitForProcessed(connection, session, txId, { timeoutMs: 120000 })
      const msgs = await readMessages(connection, session, mdt, txId)
      const errors = (msgs || []).filter(m => ['E', 'A'].includes(m.Severity))
      const status = errors.length ? 'warning' : (st === 'ERROR' ? 'error' : 'ok')
      setSaveResult({ status, count: postRows.length, errors, message: st === 'ERROR' ? t('viewer.saveProcessError') : '' })
      if (status === 'ok') {
        setEdits({})
        if (query) runLoad(query)   // refresh the page so it shows the persisted values
      }
    } catch (e) {
      setSaveResult({ status: 'error', message: errText(e) })
    } finally {
      setSaving(false)
    }
  }, [edits, schema, connection, session, version, mdt, pa, query, runLoad, t])

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

  // ── Filter editor ──
  const addCond    = () => setConds(c => [...c, { field: '', op: 'in', value: '' }])
  const removeCond = i  => setConds(c => c.filter((_, idx) => idx !== i))
  const setCond    = (i, patch) => setConds(c => c.map((x, idx) => idx === i ? { ...x, ...patch } : x))

  const fieldOptions = useMemo(
    () => (schema?.allColumns || []).slice().sort().map(c => ({ value: c, label: c })),
    [schema]
  )

  async function testFilter() {
    if (!mdt) return
    setFilterTest({ loading: true })
    try {
      const n = await fetchCount(connection, session, mdt, { planningArea: pa, versionId: version, extraFilter, retries: 1, timeout: 60000 })
      setFilterTest({ n, total: schema?.total ?? 0 })
    } catch (e) {
      setFilterTest({ error: errText(e) })
    }
  }

  const activeChips = conds.map(condChip).filter(Boolean)

  // Are there column/filter edits not yet reflected in the loaded data? Drives the
  // "Aplicar cambios" hint so the user knows a fetch is pending on their click.
  const pendingChanges = useMemo(() => {
    if (!query) return false
    const a = new Set(appliedCols)
    const colsDirty = selectedCols.length !== appliedCols.length || selectedCols.some(c => !a.has(c))
    const filterDirty = (extraFilter || undefined) !== (query.filter || undefined)
    return colsDirty || filterDirty
  }, [query, selectedCols, appliedCols, extraFilter])

  // Summaries shown in each panel's header when collapsed, so context isn't lost.
  const selSummary = pa
    ? [pa, version || t('viewer.versionBase'), mdt].filter(Boolean).join('  /  ')
    : '—'
  const dataSummary = schema
    ? `${t('viewer.colsSummary', { n: selectedCols.length, total: schema.allColumns.length })} · ${t('viewer.filtersSummary', { n: conds.length })}`
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

        {/* Selection */}
        <CollapsibleSection
          title={t('viewer.secSelection')}
          collapsed={selCollapsed}
          onToggle={() => setSelCollapsed(v => !v)}
          summary={selSummary}
          actions={
            <button
              style={{ ...BTN_SEC, opacity: catalogLoading ? 0.6 : 1, cursor: catalogLoading ? 'wait' : 'pointer' }}
              onClick={refreshCatalog}
              disabled={catalogLoading}
              title={t('viewer.refreshTitle')}
            >
              {t('viewer.refresh')}
            </button>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1.4fr', gap: 12 }}>
            <div>
              <label style={LABEL}>{t('viewer.area')}</label>
              <select style={SELECT} value={pa} onChange={e => setPa(e.target.value)} disabled={catalogLoading}>
                <option value="">{catalogLoading ? '…' : '—'}</option>
                {pas.map(p => <option key={p.id} value={p.id}>{p.id}{p.desc && p.desc !== p.id ? ` — ${p.desc}` : ''}</option>)}
              </select>
            </div>
            <div>
              <label style={LABEL}>{t('viewer.version')}</label>
              <select style={SELECT} value={version} onChange={e => setVersion(e.target.value)} disabled={!pa}>
                <option value="">{t('viewer.versionBase')}</option>
                {versions.map(v => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
              </select>
            </div>
            <div>
              <label style={LABEL}>{t('viewer.table')}</label>
              <SearchSelect
                value={mdt}
                options={mdts.map(m => ({ value: m, label: m }))}
                onChange={setMdt}
                placeholder={pa ? t('viewer.tablePh') : t('viewer.selectAreaFirst')}
                searchPlaceholder={t('viewer.tableSearch')}
              />
            </div>
          </div>
        </CollapsibleSection>

        {/* Schema-dependent controls */}
        {mdt && schemaLoading && (
          <div style={SECTION}>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>{t('viewer.loadingSchema')}</div>
          </div>
        )}
        {mdt && schemaError && !schemaLoading && (
          <div style={SECTION}>
            <div style={{ fontSize: 12, color: 'var(--red)' }}>{t('viewer.schemaError', { msg: schemaError })}</div>
          </div>
        )}
        {mdt && schema && !schemaLoading && (
          <CollapsibleSection
            title={t('viewer.secData')}
            collapsed={dataCollapsed}
            onToggle={() => setDataCollapsed(v => !v)}
            summary={dataSummary}
            actions={
              <button style={btnPrimary(!schema.allColumns.length)} disabled={!schema.allColumns.length} onClick={applyAndShow}>
                {!query ? t('viewer.showData') : (pendingChanges ? t('viewer.applyChanges') : t('viewer.applyFilter'))}
              </button>
            }
          >
              <>
                {/* Toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                  <ColumnPicker
                    allColumns={schema.allColumns}
                    keyNames={schema.keyNames}
                    selected={selectedCols}
                    onChange={onColumnsChange}
                    connId={connection.id}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                    {t('viewer.rowCount', { n: (schema.total ?? 0).toLocaleString() })}
                  </span>
                </div>

                {/* Filters */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
                    {t('flt.title')}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>{t('viewer.filterNote')}</div>

                  {conds.map((c, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ width: isMobile ? '100%' : 200 }}>
                        <SearchSelect
                          value={c.field}
                          options={fieldOptions}
                          onChange={v => setCond(i, { field: v })}
                          placeholder={t('flt.fieldPh')}
                          searchPlaceholder={t('flt.searchPh')}
                        />
                      </div>
                      <select style={{ ...SELECT, width: 'auto' }} value={c.op} onChange={e => setCond(i, { op: e.target.value })}>
                        <option value="in">{t('flt.opIn')}</option>
                        <option value="sw">{t('flt.opSw')}</option>
                      </select>
                      {c.op === 'sw' ? (
                        <input
                          value={c.value}
                          onChange={e => setCond(i, { value: e.target.value })}
                          placeholder={t('flt.valuePh')}
                          style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 11, padding: '4px 8px', flex: 1, minWidth: 120, outline: 'none', fontFamily: 'var(--mono)' }}
                        />
                      ) : (
                        <MultiValueSelect
                          value={c.value}
                          onChange={v => setCond(i, { value: v })}
                          placeholder={t('flt.valuesPh')}
                          disabled={!c.field}
                          loadValues={() => fetchDistinctValues(connection, session, mdt, c.field, { planningArea: pa, versionId: version })}
                        />
                      )}
                      <button title={t('flt.remove')} onClick={() => removeCond(i)} style={{ ...BTN_SEC, padding: '5px 9px', color: 'var(--red)', borderColor: 'var(--border)' }}>×</button>
                    </div>
                  ))}

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                    <button style={BTN_SEC} onClick={addCond}>{t('flt.addCond')}</button>
                    {conds.length > 0 && (
                      <button style={BTN_SEC} onClick={testFilter} disabled={filterTest?.loading}>
                        {filterTest?.loading ? t('flt.testing') : t('flt.test')}
                      </button>
                    )}
                    {filterTest && !filterTest.loading && filterTest.error == null && (
                      <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                        {t('flt.testResult', { n: (filterTest.n ?? 0).toLocaleString(), total: (filterTest.total ?? 0).toLocaleString() })}
                      </span>
                    )}
                    {filterTest?.error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{t('flt.testErr', { msg: filterTest.error })}</span>}
                    {activeChips.length > 0 && (
                      <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{activeChips.join('  ·  ')}</span>
                    )}
                  </div>
                </div>
              </>
          </CollapsibleSection>
        )}
      </div>

      {/* Grid / placeholder */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: isMobile ? '0 12px 12px' : '0 20px 16px' }}>
        {!mdt && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
            {t('viewer.selectAreaFirst')}
          </div>
        )}
        {mdt && schema && !query && !schemaLoading && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
            {t('viewer.notShown')}
          </div>
        )}
        {query && (
          <DataGrid
            columns={appliedCols}
            onReorder={onReorderColumns}
            rows={rows}
            keyNames={schema?.keyNames || []}
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
        keyNames={schema?.keyNames || []}
        saving={saving}
        result={saveResult}
        onConfirm={doSave}
        onClose={() => setShowSaveModal(false)}
      />
    </div>
  )
}
