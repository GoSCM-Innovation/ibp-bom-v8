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
  fetchVsmt, buildCatalog,
  fetchCount, readEntityPage, fetchFieldNames, fetchKeyNames, fetchDistinctValues,
} from '../../services/masterDataApi'
import { getPas, getVersions, getMdts } from '../../services/catalogHelpers'
import { buildConditionFilter, condChip } from '../../services/filterUtils'
import { SearchSelect, MultiValueSelect } from '../Migration/FilterControls'
import ColumnPicker from './ColumnPicker'
import DataGrid from './DataGrid'

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

  // ── Selection ──
  const [pa, setPa]           = useState('')
  const [version, setVersion] = useState('')   // '' = base / no version
  const [mdt, setMdt]         = useState('')

  // ── Schema of the selected table ──
  const [schema, setSchema]               = useState(null)   // { allColumns, keyNames, total }
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError]     = useState('')
  const [selectedCols, setSelectedCols]   = useState([])

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
  }, [connection.id, session?.com0720?.user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => abortRef.current?.abort(), [])

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
      const validSaved = saved ? saved.filter(c => allColumns.includes(c)) : []
      setSelectedCols(validSaved.length ? validSaved : defaultSelection(allColumns, keyNames))
    }).catch(e => { if (alive) setSchemaError(errText(e)) })
      .finally(() => { if (alive) setSchemaLoading(false) })
    return () => { alive = false; ac.abort() }
  }, [mdt, pa, version, connection.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist column selection per connection+table.
  useEffect(() => {
    if (mdt && selectedCols.length) saveCols(connection.id, mdt, selectedCols)
  }, [selectedCols, mdt, connection.id])

  useEffect(() => { try { localStorage.setItem(PAGESIZE_KEY, String(pageSize)) } catch { /* quota */ } }, [pageSize])

  const extraFilter = useMemo(() => buildConditionFilter(conds) || undefined, [conds])

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
    // the edit/delete phases; the grid only RENDERS the selected columns.
    const select = [...new Set([...selectedCols, ...schema.keyNames])]
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
  }, [mdt, schema, selectedCols, connection, session, pa, version, t])

  // Reload whenever the query OR the displayed columns change.
  useEffect(() => {
    if (query) runLoad(query)
  }, [query, selectedCols]) // eslint-disable-line react-hooks/exhaustive-deps

  // "Mostrar datos" / "Aplicar": (re)count for the active filter, then load page 1.
  const applyAndShow = useCallback(async () => {
    if (!mdt || !schema) return
    let total = schema.total
    if (extraFilter) {
      try {
        total = await fetchCount(connection, session, mdt, { planningArea: pa, versionId: version, extraFilter, retries: 1, timeout: 60000 })
      } catch { /* keep base total */ }
    }
    setQuery({ page: 1, pageSize, sort: null, filter: extraFilter, total })
  }, [mdt, schema, extraFilter, connection, session, pa, version, pageSize])

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
        <div style={SECTION}>
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
        </div>

        {/* Schema-dependent controls */}
        {mdt && (
          <div style={SECTION}>
            {schemaLoading && <div style={{ fontSize: 12, color: 'var(--text2)' }}>{t('viewer.loadingSchema')}</div>}
            {schemaError   && <div style={{ fontSize: 12, color: 'var(--red)' }}>{t('viewer.schemaError', { msg: schemaError })}</div>}

            {schema && !schemaLoading && (
              <>
                {/* Toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                  <ColumnPicker
                    allColumns={schema.allColumns}
                    keyNames={schema.keyNames}
                    selected={selectedCols}
                    onChange={setSelectedCols}
                    connId={connection.id}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                    {t('viewer.rowCount', { n: (schema.total ?? 0).toLocaleString() })}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button style={btnPrimary(!schema.allColumns.length)} disabled={!schema.allColumns.length} onClick={applyAndShow}>
                    {query ? t('viewer.applyFilter') : t('viewer.showData')}
                  </button>
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
            )}
          </div>
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
            columns={selectedCols}
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
          />
        )}
      </div>
    </div>
  )
}
