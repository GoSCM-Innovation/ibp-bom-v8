import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react'
import { useI18n } from '../../context/I18nContext'
import { getAll } from '../../services/connectionStorage'
import { getSession, setSession } from '../../services/sessionStorage'
import { setMigrationGuard } from '../../services/migrationGuard'
import {
  fetchKfCatalog, fetchKfAreas, invalidateKfCatalog, planningServiceRoot, fetchConversionValues,
  countKf, readKfPage, detectConversions, fetchTimeBuckets,
  fetchCsrf, getTransactionId, initiateParallelProcess, postKfChunk,
  commitTransaction, waitForProcessed, readMessages,
  odataDateToIso, rowsPerChunk, readRowsPerPage, measureKfRowBytes, readRowsPerPageBytes, rowsPerChunkBytes,
  chunkByBytes, MAX_POST_BYTES, PARALLEL_R, PARALLEL_W, SEGMENT_SIZE, MAX_SEGMENT_ATTEMPTS, CONCURRENT_SEGMENTS,
} from '../../services/planningDataApi'
import { fetchAttrDistinctValues } from '../../services/masterDataApi'
import { buildConditionFilter, condChip } from '../../services/filterUtils'
import { MultiValueSelect, SearchSelect } from './FilterControls'
import { KF_MAX_HARD, isLocalRun } from '../../config/migrationLimits'

// ── Styles (shared visual language with Migration.jsx) ──────────────────────────
const SECTION     = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }
const SECTION_HDR = { fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 14 }
const LABEL       = { fontSize: 10, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5, display: 'block' }
const SELECT      = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '7px 10px', width: '100%', outline: 'none' }
const INPUT       = { ...SELECT }
const BTN_SEC     = { background: 'none', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 14px', cursor: 'pointer' }
const BTN_DANGER  = { background: 'none', border: '1px solid var(--red)', borderRadius: 6, color: 'var(--red)', fontSize: 12, fontWeight: 600, padding: '7px 14px', cursor: 'pointer' }
function btnPrimary(disabled) {
  return { background: disabled ? 'var(--border2)' : 'var(--accent)', border: 'none', borderRadius: 6, color: disabled ? 'var(--text3)' : 'var(--text-on-accent)', fontSize: 12, fontWeight: 700, padding: '7px 18px', cursor: disabled ? 'not-allowed' : 'pointer' }
}
const TH = { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text2)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }
const td = extra => ({ padding: '6px 8px', borderBottom: '1px solid var(--border)', ...extra })

// Standard time levels in SAP IBP (timestamp fields). PERIODID4 = week is the default.
const TIME_LEVELS = [
  { field: 'PERIODID4_TSTAMP', key: 'week'  },
  { field: 'PERIODID3_TSTAMP', key: 'month' },
  { field: 'PERIODID2_TSTAMP', key: 'quarter' },
  { field: 'PERIODID1_TSTAMP', key: 'year' },
  { field: 'PERIODID0_TSTAMP', key: 'day'  },
  { field: 'PERIODID5_TSTAMP', key: 'techweek' },
]
const READONLY_ATTRS = new Set(['VERSIONID','VERSIONNAME','SCENARIOID','SCENARIONAME','MASTER_DATA_TYPE','AGGREGATE','LASTMODIFIEDDATE','CREATEDDATE'])
// Above this row count, the source read is partitioned by time bucket (one period
// per segment) to bound each query and avoid very deep $skip offsets on huge volumes.
const TIME_PARTITION_THRESHOLD = 100000

function errText(e) {
  if (e == null) return 'Error desconocido'
  if (typeof e === 'string') return e
  return (typeof e.message === 'string' && e.message) || String(e)
}

// ── History persistence (per destination connection, like master data) ───────
const KF_HIST_KEY = id => `ibp:kfmigrations:${id}`
function loadKfHistory(connId) {
  try { return JSON.parse(localStorage.getItem(KF_HIST_KEY(connId))) || [] } catch { return [] }
}
function saveKfHistory(connId, entries) {
  try { localStorage.setItem(KF_HIST_KEY(connId), JSON.stringify(entries.slice(0, 50))) } catch { /* quota */ }
}

// Formats a millisecond duration compactly: "1h 02m", "2m 14s", "4,2 s", "850 ms".
function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1).replace('.', ',')} s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

// Phases shown in the per-KF timing breakdown, in execution order.
const KF_TIMED_PHASES = ['count', 'reading', 'writing', 'committing', 'processing', 'messages']

export default function KeyFigureMigration({ connection, session }) {
  const { t } = useI18n()

  // Destination = current connection; source = another connection with SAP_COM_0720.
  // Other connections with COM_0720, plus THIS connection itself (listed first) —
  // to migrate between areas/versions of the same system.
  const allConns = useMemo(() => {
    const others = getAll().filter(c => c.id !== connection.id && c.com0720?.url && c.com0720?.user)
    const self   = (connection.com0720?.url && connection.com0720?.user) ? [connection] : []
    return [...self, ...others]
  }, [connection])

  // ── Source connection + inline login ──
  const [srcConnId, setSrcConnId]       = useState(null)
  const [srcTempCreds, setSrcTempCreds] = useState(null)
  const [srcLoginForm, setSrcLoginForm] = useState({ user: '', password: '' })
  const [srcLoginErr, setSrcLoginErr]   = useState('')
  const [srcLoginLoading, setSrcLoginLoading] = useState(false)
  const srcConn = useMemo(() => allConns.find(c => c.id === srcConnId) || null, [allConns, srcConnId])
  const srcSession = useMemo(() => {
    if (!srcConnId) return null
    if (srcConnId === connection.id) return session   // same system → reuse the active session (no extra login)
    const stored = getSession(srcConnId)
    const com0720 = srcTempCreds || stored?.com0720
    if (!com0720?.password) return null
    return { ...(stored || {}), com0720 }
  }, [srcConnId, srcTempCreds, connection.id, session])
  const needsSrcLogin = !!(srcConn && !srcSession)

  // ── Catalogs + planning-area selection ──
  const [dstAreas, setDstAreas] = useState([])
  const [srcAreas, setSrcAreas] = useState([])
  const [dstPa, setDstPa]   = useState('')   // selected destination planning area
  const [srcPa, setSrcPa]   = useState('')   // selected source planning area
  const [dstCat, setDstCat] = useState(null)
  const [srcCat, setSrcCat] = useState(null)
  const [dstLoading, setDstLoading] = useState(false)
  const [srcLoading, setSrcLoading] = useState(false)
  const [catError, setCatError] = useState('')
  // Catalog refresh trigger — bump to force areas/catalog (source + destination)
  // to re-discover from SAP after invalidating their caches ("↺ Actualizar").
  const [catalogTick, setCatalogTick] = useState(0)

  // Invalidate the cached KF areas/catalog (destination + source) and force a
  // fresh discovery — recovers from a stale or empty catalog cache without waiting
  // out the 24 h TTL. Mirrors the master-data "Actualizar" button.
  function refreshCatalogs() {
    invalidateKfCatalog(connection.id)
    if (srcConn) invalidateKfCatalog(srcConn.id)
    setCatalogTick(n => n + 1)
  }

  // ── Selections ──
  const [dstVersion, setDstVersion] = useState('')   // '' = base
  const [srcVersion, setSrcVersion] = useState('')
  const [txName, setTxName]         = useState('IBP-ControlTower-KF')  // SAP transaction label (registered in destination)
  const [timeField, setTimeField]   = useState('PERIODID4_TSTAMP')
  const [levelAttrs, setLevelAttrs] = useState([])   // destination attribute names (root level)
  const [attrSearch, setAttrSearch] = useState('')
  const [steps, setSteps]           = useState([])   // [{ dstKf, srcKf }]
  const [kfSearch, setKfSearch]     = useState('')
  // Per-destination-attribute → source attribute mapping (only when names differ)
  const [attrMap, setAttrMap]       = useState({})
  // ── Pre-migration source filters (selective migration) ──
  // Attribute conditions use SOURCE attribute names (the filter only travels in the
  // source read); validated live: a derived attribute (e.g. BRAND) NOT in $select
  // still filters correctly. Date range applies to the chosen time level field.
  const [attrFilters, setAttrFilters] = useState([])   // [{ field, op: 'in'|'sw', value }]
  const [dateFrom, setDateFrom]       = useState('')   // YYYY-MM-DD
  const [dateTo, setDateTo]           = useState('')
  const [fltCount, setFltCount]       = useState(null) // { loading?, n?, kf?, error? }
  // Conversion (UOM / currency) — values from the SOURCE master data, user-selected
  const [units, setUnits]           = useState([])
  const [currencies, setCurrencies] = useState([])
  const [selUom, setSelUom]         = useState('')
  const [selCurr, setSelCurr]       = useState('')

  // ── Run state ──
  const cancelledRef = useRef(false)
  const abortRef     = useRef(null)
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults]   = useState(null)
  const [expanded, setExpanded] = useState(null)

  // ── Pre-migration level check (deduce each KF's level from the chosen dims) ──
  const [showConfirm, setShowConfirm] = useState(false)

  // ── Live elapsed clock (ticks once per second while a run is active) ──
  const runStartRef = useRef(0)
  const [runElapsed, setRunElapsed] = useState(0)
  // ── Phase-timing detail expand (per result row) ──
  const [expandedTimeKf, setExpandedTimeKf] = useState(null)

  // ── History (persisted per destination connection) ──
  const [history, setHistory]         = useState(() => loadKfHistory(connection.id))
  const [showHistory, setShowHistory] = useState(false)

  // ── Discover destination planning areas on mount (auto-select if only one) ──
  useEffect(() => {
    let alive = true
    setDstLoading(true); setCatError('')
    setDstPa(''); setDstCat(null)
    fetchKfAreas(connection, session)
      .then(areas => { if (!alive) return; setDstAreas(areas); if (areas.length === 1) setDstPa(areas[0]) })
      .catch(e => { if (alive) setCatError(t('kfm.catErr', { msg: errText(e) })) })
      .finally(() => { if (alive) setDstLoading(false) })
    return () => { alive = false }
  }, [connection.id, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load destination catalog for the selected area ──
  useEffect(() => {
    if (!dstPa) { setDstCat(null); return }
    let alive = true
    setDstLoading(true); setCatError('')
    fetchKfCatalog(connection, session, { pa: dstPa })
      .then(c => { if (alive) setDstCat(c) })
      .catch(e => { if (alive) setCatError(t('kfm.catErr', { msg: errText(e) })) })
      .finally(() => { if (alive) setDstLoading(false) })
    return () => { alive = false }
  }, [connection.id, dstPa, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keep the selected time level VALID for the destination area ──
  // The default (PERIODID4_TSTAMP / week) does not exist in every area's time
  // profile — e.g. a daily area like CTCNDIA exposes only PERIODID0. When the
  // current timeField isn't among the area's available levels, the <select> shows
  // the first option while the state stays on the (invalid) default: the dropdown
  // desyncs from the level summary AND the migration would read a non-existent
  // field. Snap timeField to the first available level whenever it falls out.
  useEffect(() => {
    const available = TIME_LEVELS.filter(tl => (dstCat?.dims || []).includes(tl.field))
    if (available.length === 0) return
    if (!available.some(tl => tl.field === timeField)) setTimeField(available[0].field)
  }, [dstCat]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Discover source planning areas when source session is available ──
  useEffect(() => {
    if (!srcConn || !srcSession) { setSrcAreas([]); setSrcPa(''); setSrcCat(null); return }
    let alive = true
    setSrcLoading(true); setCatError('')
    setSrcPa(''); setSrcCat(null)
    fetchKfAreas(srcConn, srcSession)
      .then(areas => { if (!alive) return; setSrcAreas(areas); if (areas.length === 1) setSrcPa(areas[0]) })
      .catch(e => { if (alive) setCatError(t('kfm.catErr', { msg: errText(e) })) })
      .finally(() => { if (alive) setSrcLoading(false) })
    return () => { alive = false }
  }, [srcConnId, srcTempCreds?.user, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load source catalog for the selected area ──
  useEffect(() => {
    if (!srcConn || !srcSession || !srcPa) { setSrcCat(null); return }
    let alive = true
    setSrcLoading(true); setCatError('')
    fetchKfCatalog(srcConn, srcSession, { pa: srcPa })
      .then(c => { if (alive) setSrcCat(c) })
      .catch(e => { if (alive) setCatError(t('kfm.catErr', { msg: errText(e) })) })
      .finally(() => { if (alive) setSrcLoading(false) })
    return () => { alive = false }
  }, [srcConnId, srcPa, srcTempCreds?.user, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Leave guard while running ──
  useEffect(() => { setMigrationGuard(running, t('mig.leaveWarning')); return () => setMigrationGuard(false) }, [running, t])
  useEffect(() => () => { cancelledRef.current = true; abortRef.current?.abort() }, [])

  // Tick the live elapsed clock every second while running (also drives the live
  // rate/ETA re-render in the progress panel).
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setRunElapsed(Date.now() - runStartRef.current), 1000)
    return () => clearInterval(id)
  }, [running])

  // Reset selections when catalogs change
  useEffect(() => { setLevelAttrs([]); setSteps([]); setAttrMap({}) }, [dstCat])
  useEffect(() => { setAttrFilters([]); setDateFrom(''); setDateTo(''); setFltCount(null) }, [srcCat])

  // Combined OData fragment for the selective filters ('' = no filter → full level).
  const extraKfFilter = useMemo(() => {
    const parts = []
    const cond = buildConditionFilter(attrFilters)
    if (cond) parts.push(cond)
    if (dateFrom) parts.push(`${timeField} ge datetime'${dateFrom}T00:00:00'`)
    if (dateTo)   parts.push(`${timeField} le datetime'${dateTo}T23:59:59'`)
    return parts.join(' and ')
  }, [attrFilters, dateFrom, dateTo, timeField])
  // Stale count guard: the preview belongs to the filters it was computed with.
  useEffect(() => { setFltCount(null) }, [extraKfFilter, srcVersion])

  // Load conversion master data (units & currencies) from the SOURCE when available
  useEffect(() => {
    if (!srcConn || !srcSession || !srcCat) { setUnits([]); setCurrencies([]); setSelUom(''); setSelCurr(''); return }
    let alive = true
    fetchConversionValues(srcConn, srcSession, srcCat.pa, 'UOM').then(u => { if (alive) setUnits(u) }).catch(() => {})
    fetchConversionValues(srcConn, srcSession, srcCat.pa, 'CURR').then(c => { if (alive) setCurrencies(c) }).catch(() => {})
    return () => { alive = false }
  }, [srcConnId, srcCat?.pa]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived option lists ──
  const dstAttrs = useMemo(() => (dstCat?.dims || []).filter(a => !a.startsWith('PERIODID') && !READONLY_ATTRS.has(a)).sort(), [dstCat])
  const dstKfs   = useMemo(() => (dstCat?.measures || []).slice().sort(), [dstCat])
  const srcKfSet = useMemo(() => new Set(srcCat?.measures || []), [srcCat])
  // Options for the searchable source-KF picker (label = name, like the list).
  const srcKfOptions = useMemo(() => [...srcKfSet].sort().map(sk => ({ value: sk, label: sk })), [srcKfSet])
  const srcAttrSet = useMemo(() => new Set(srcCat?.dims || []), [srcCat])

  // Source attributes offered for FILTERS (any dim of the source area, level or
  // derived — a derived attr like BRAND filters fine without being in the level).
  const srcFilterAttrs = useMemo(() =>
    (srcCat?.dims || []).filter(a => !a.startsWith('PERIODID') && !READONLY_ATTRS.has(a)).sort(), [srcCat])
  const srcFilterAttrOptions = useMemo(() =>
    srcFilterAttrs.map(a => {
      const lbl = srcCat?.labels?.[a]
      return { value: a, label: lbl && lbl !== a ? `${a} — ${lbl}` : a }
    }), [srcFilterAttrs, srcCat])

  const filteredAttrs = useMemo(() => dstAttrs.filter(a => !attrSearch || a.toLowerCase().includes(attrSearch.toLowerCase()) || (dstCat?.labels?.[a] || '').toLowerCase().includes(attrSearch.toLowerCase())), [dstAttrs, attrSearch, dstCat])
  const filteredKfs   = useMemo(() => dstKfs.filter(k => !kfSearch || k.toLowerCase().includes(kfSearch.toLowerCase()) || (dstCat?.labels?.[k] || '').toLowerCase().includes(kfSearch.toLowerCase())), [dstKfs, kfSearch, dstCat])

  // Resolve the source name of a destination attribute: explicit map → same name → null
  const resolveSrcAttr = useCallback(a => attrMap[a] || (srcAttrSet.has(a) ? a : null), [attrMap, srcAttrSet])
  // Attributes whose source counterpart is unknown (custom, different name) → need mapping
  const unmappedAttrs = useMemo(() => srcCat ? levelAttrs.filter(a => !resolveSrcAttr(a)) : [], [levelAttrs, srcCat, resolveSrcAttr])

  // Resolve source KF of a step: explicit → same name if present → dst name (best effort)
  function defaultSrcKf(dstKf) { return srcKfSet.has(dstKf) ? dstKf : '' }

  // ── Source inline login ──
  async function handleSrcLogin(e) {
    e.preventDefault()
    if (!srcLoginForm.user || !srcLoginForm.password) { setSrcLoginErr(t('kfm.loginMissing')); return }
    setSrcLoginLoading(true); setSrcLoginErr('')
    try {
      const serviceRoot = planningServiceRoot(srcConn)
      const resp = await fetch('/api/proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: serviceRoot + '/?$format=json', serviceRoot, user: srcLoginForm.user, password: srcLoginForm.password, method: 'GET' }),
      })
      if (resp.status === 401) { setSrcLoginErr(t('kfm.login401')); return }
      if (!resp.ok)            { setSrcLoginErr(t('kfm.loginNet')); return }
      const creds = { user: srcLoginForm.user, password: srcLoginForm.password }
      setSrcTempCreds(creds)
      setSession(srcConnId, { ...(getSession(srcConnId) || {}), com0720: creds })
    } catch { setSrcLoginErr(t('kfm.loginNet')) }
    finally { setSrcLoginLoading(false) }
  }

  // ── Migration engine ──
  const needsUom  = steps.some(s => s.convs?.includes('UOM'))
  const needsCurr = steps.some(s => s.convs?.includes('CURR'))
  // Identical origin/target (same system + area + version) is blocked — it would
  // just overwrite values with themselves. Same system with a different area or
  // version is the supported intra-system migration.
  const sameTarget = !!srcConn && srcConn.id === connection.id && !!srcPa && srcPa === dstPa && (srcVersion || '') === (dstVersion || '')
  const canMigrate = !running && !!srcConn && !!srcSession && !!dstCat && !!srcCat &&
    levelAttrs.length > 0 && steps.length > 0 && steps.every(s => s.srcKf) && unmappedAttrs.length === 0 &&
    (!needsUom || selUom) && (!needsCurr || selCurr) && !sameTarget

  // Opens the confirmation INSTANTLY. The old pre-migration "level analysis"
  // (counting the level with/without each dimension per KF) was removed: on big
  // versions those counts were far too slow for the UI and usually ended in
  // "unverifiable" — a useless gate. The migration itself validates everything
  // that matters (SAP rejects bad levels per row and the result reports it).
  function handleMigrateClick() { setShowConfirm(true) }

  // ── Filter count preview ──
  // Counts the source rows matching the filters at the configured level, using the
  // first mapped KF (the planning service requires a KF in $select; the non-zero
  // clause mirrors what the migration will read). Advisory: errors don't block.
  async function handleFilterCount() {
    const step = steps.find(s => s.srcKf)
    if (!step || !srcCat) return
    setFltCount({ loading: true })
    try {
      const srcLevelCols = levelAttrs.map(resolveSrcAttr).filter(Boolean)
      // A KF may require BOTH a target unit and a target currency — add every
      // conversion filter it asked for (mirrors the migration read).
      const convs = step.convs || []
      let f = srcVersion ? `VERSIONID eq '${srcVersion}'` : ''
      const cols = [...srcLevelCols]
      for (const c of convs) {
        const convAttr = c === 'UOM' ? 'UOMTOID' : 'CURRTOID'
        const convVal  = c === 'UOM' ? selUom : selCurr
        if (convVal) { f += `${f ? ' and ' : ''}${convAttr} eq '${convVal}'`; cols.push(convAttr) }
      }
      if (extraKfFilter) f += `${f ? ' and ' : ''}(${extraKfFilter})`
      f += `${f ? ' and ' : ''}(${step.srcKf} gt 0 or ${step.srcKf} lt 0)`
      const select = [...cols, step.srcKf, timeField].join(',')
      const n = await countKf(srcConn, srcSession, srcCat.pa, { select, filter: f, retries: 0, timeout: 60000 })
      setFltCount({ n, kf: step.srcKf })
    } catch (e) {
      setFltCount({ error: errText(e) })
    }
  }

  // Human label of the selected time level (for the proposed/deduced level display).
  const timeLabel = t(`kfm.time_${(TIME_LEVELS.find(x => x.field === timeField) || {}).key}`)
  const levelStr = dims => [...dims, timeLabel].join(' × ')

  const runMigration = useCallback(async () => {
    setShowConfirm(false)
    setRunning(true); setResults([])
    cancelledRef.current = false
    abortRef.current = new AbortController()
    const signal = abortRef.current.signal
    runStartRef.current = Date.now()
    setRunElapsed(0)
    const dstPa = dstCat.pa, srcPa = srcCat.pa
    const all = []
    const push = r => { all.push(r); setResults([...all]) }

    try {
      let csrf = null
      try { csrf = await fetchCsrf(connection, session, { signal }) } catch { /* proxy fetches per POST */ }

      // Resolve each step's conversion (cached on the step or detected now). Each KF
      // is then migrated ON ITS OWN, sequentially — one source sweep, one set of
      // transactions and one result per KF (mirrors the master-data table loop).
      // Rationale (product decision): step-by-step results (KF i/N as each finishes),
      // bounded system load (only one KF in flight), and a lighter per-request cost
      // (a 1-KF aggregated read is ~1.5× faster than a 3-KF one). KFs are NOT grouped:
      // grouping only paid off when KFs shared rows, and re-reading is cheap here.
      const resolved = []
      for (const s of steps) {
        let convs = s.convs
        if (convs === undefined) { try { convs = await detectConversions(srcConn, srcSession, srcPa, s.srcKf, { signal }) } catch { convs = [] } }
        resolved.push({ ...s, convs: convs || [] })
      }
      // One "group" per KF → the loop below processes each key figure independently.
      const order = [], groups = {}
      resolved.forEach((s, i) => { const k = `kf${i}`; groups[k] = [s]; order.push(k) })

      let done = 0
      let runRows = 0   // acumulado de filas de la corrida (para el tope de la web)
      for (const gk of order) {
        if (cancelledRef.current) break
        const g = groups[gk]
        const convs = g[0].convs || []
        const srcKfs = g.map(s => s.srcKf)
        const dstKfs = g.map(s => s.dstKf)
        const label  = dstKfs.join(', ')

        const srcLevelCols = levelAttrs.map(resolveSrcAttr)
        const dstLevelCols = [...levelAttrs]
        let filter = srcVersion ? `VERSIONID eq '${srcVersion}'` : ''
        // Selective migration: user filters (attribute values + date range) travel in
        // every source read of the group — count, time buckets, sizing and pages.
        if (extraKfFilter) filter += `${filter ? ' and ' : ''}(${extraKfFilter})`
        // Add every conversion attribute this group needs (a KF can require BOTH
        // a target unit and a target currency). Missing a selected value aborts
        // the group with a clear error rather than letting SAP 400.
        let missingConv = false
        for (const c of convs) {
          const convAttr = c === 'UOM' ? 'UOMTOID' : 'CURRTOID'
          const convVal  = c === 'UOM' ? selUom : selCurr
          if (!convVal) { missingConv = true; break }
          filter += `${filter ? ' and ' : ''}${convAttr} eq '${convVal}'`
          srcLevelCols.push(convAttr)
        }
        if (missingConv) {
          for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, status: 'error', total: 0, ok: 0, errors: 1, errorMsg: t('kfm.errNoUnit', { kf: s.srcKf }) })
          done += g.length; continue
        }
        const srcSelect = [...srcLevelCols, ...srcKfs, timeField].join(',')
        const dstFields = [...dstLevelCols, ...dstKfs, timeField].join(',')

        const groupStart = Date.now()
        const phaseAcc = {}   // cumulative ms per phase (summed across concurrent workers)
        const addPhase = (k, ms) => { phaseAcc[k] = (phaseAcc[k] || 0) + ms }
        setProgress({ cur: done + 1, total: steps.length, name: label, rows: 0, totalRows: 0, phase: 'count', groupStart, segsDone: 0, totalSegs: 0 })

        try {
          // Source-side NON-ZERO filter: read only rows where ANY group KF is
          // non-zero — positives AND negatives. (`ne 0` is silently ignored by SAP,
          // so we use `gt 0 or lt 0`; verified the OR count = gt0 + lt0.) This reads
          // far less than the whole planning level. Falls back to the base filter if
          // a tenant rejects the KF-value filter; the client-side empty/0/null skip
          // in projectBatch stays as a safety net either way.
          //
          // The count is BOUNDED (1 retry, 60 s). If it still fails: in LOCAL the
          // migration starts anyway with an unknown total (progress shows rows +
          // speed without a percentage); in the WEB the count is MANDATORY — the
          // volume cap can't be enforced without it, so the KF errors instead.
          const baseFilter = filter
          const nzClause = '(' + srcKfs.map(kf => `${kf} gt 0 or ${kf} lt 0`).join(' or ') + ')'
          const nzFilter = baseFilter ? `${baseFilter} and ${nzClause}` : nzClause
          let totalRows = 0
          let countKnown = false   // distinguishes "count failed" from a legitimate 0
          const t0count = Date.now()
          try {
            totalRows = await countKf(srcConn, srcSession, srcPa, { select: srcSelect, filter: nzFilter, signal, retries: 1, timeout: 60000 })
            countKnown = true
            filter = nzFilter   // adopt for time buckets + reads + measurement below
          } catch {
            try {
              totalRows = await countKf(srcConn, srcSession, srcPa, { select: srcSelect, filter: baseFilter || undefined, signal, retries: 1, timeout: 60000 })
              countKnown = true
            } catch { /* unknown total — only acceptable in local */ }
          }
          addPhase('count', Date.now() - t0count)
          setProgress(p => ({ ...p, totalRows, totalSegs: totalRows > 0 ? Math.ceil(totalRows / SEGMENT_SIZE) : 0 }))

          // En la web el conteo es OBLIGATORIO: sin total no se puede aplicar el tope.
          if (!isLocalRun() && !countKnown) {
            for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, status: 'error', total: 0, ok: 0, errors: 1, errorMsg: t('kfm.errCountRequired'), durationMs: Date.now() - groupStart, phaseTimes: { ...phaseAcc } })
            done += g.length
            continue
          }

          // Tope por CORRIDA (acumulado de KF). En local (isLocalRun) no aplica.
          if (!isLocalRun() && totalRows > 0 && runRows + totalRows > KF_MAX_HARD) {
            for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, status: 'skipped', total: 0, ok: 0, errors: 0, errorMsg: t('kfm.limitBlockedMsg', { max: KF_MAX_HARD.toLocaleString(), n: totalRows.toLocaleString() }), durationMs: Date.now() - groupStart, phaseTimes: { ...phaseAcc } })
            done += g.length
            continue
          }
          runRows += totalRows

          // Batch sizes by MEASURED bytes/row (small live sample), not column count
          // — the estimate underestimates value-heavy rows (time series), producing
          // read pages over the truncation zone and POST bodies over Vercel's ~4.5 MB
          // limit. Field-count is only the fallback if measurement fails.
          let readPageSize = readRowsPerPage(srcLevelCols.length + srcKfs.length + 1)
          let chunkRows    = rowsPerChunk(dstKfs.length, dstLevelCols.length + dstKfs.length + 1)
          if (totalRows > 0) {
            try {
              const mm = await measureKfRowBytes(srcConn, srcSession, srcPa, { select: srcSelect, filter: filter || undefined, signal })
              if (mm) { readPageSize = readRowsPerPageBytes(mm.readBpr); chunkRows = rowsPerChunkBytes(dstKfs.length, mm.writeBpr) }
            } catch { /* keep field-count fallback */ }
          }
          const orderby      = [...srcLevelCols, timeField]

          // For huge volumes, partition the source read by time bucket (one period
          // per segment). Computed once and reused across retries.
          let segFilters = [filter]
          if (timeField && totalRows > TIME_PARTITION_THRESHOLD) {
            try {
              const buckets = await fetchTimeBuckets(srcConn, srcSession, srcPa, { timeField, kf: srcKfs[0], filter: filter || undefined, signal })
              if (buckets.length > 1) segFilters = buckets.map(iso => `${filter ? filter + ' and ' : ''}${timeField} eq datetime'${iso}'`)
            } catch { /* fall back to a single segment */ }
          }

          // In IBP a useful transactional value is one that HAS a value. Rows whose
          // key figures are ALL null/0/empty carry no information — skip them: fewer
          // POSTs, no pointless disaggregation, cleaner destination.
          const isEmpty = v => v == null || String(v).trim() === '' || Number(v) === 0

          // ── Stage + commit by COMMITTED SEGMENTS ──
          // The group is loaded in segments of ~SEGMENT_SIZE read rows (kept within a
          // time bucket), each in its own transaction that is COMMITTED before the
          // next. A transient failure only re-does the CURRENT segment in a fresh
          // transaction — never the whole group — and committed segments are kept
          // (durable progress). Still duplicate-safe: within a segment a chunk is
          // never re-POSTed; across committed segments a re-load is idempotent upsert.
          const projectBatch = rowsRead => {
            const out = []
            for (const r of rowsRead) {
              const o = {}
              for (const dstA of dstLevelCols) o[dstA] = r[resolveSrcAttr(dstA)] ?? ''
              o[timeField] = odataDateToIso(r[timeField])
              let hasValue = false
              for (let gi = 0; gi < dstKfs.length; gi++) {
                const val = r[srcKfs[gi]]
                o[dstKfs[gi]] = val ?? '0'
                if (!isEmpty(val)) hasValue = true
              }
              if (hasValue) out.push(o)
            }
            return out
          }

          const segmentTxIds = []   // one committed transaction per non-empty segment
          let committedRows = 0     // read rows confirmed — durable baseline (never reset)
          let inflightRows  = 0     // rows read by ALL workers but not yet committed (shared)
          let totalWritten  = 0     // values actually written across all segments
          // Live row count = committed + in-flight, summed across every concurrent
          // worker (the old `committedRows + segLoaded` used only ONE worker's local
          // partial, so 5/6 of the in-flight rows were invisible → rate/ETA way off).
          const liveRows = () => committedRows + inflightRows
          const effParR = orderby.length ? PARALLEL_R : 1   // serial reads if no stable $orderby (#4)

          // ── Concurrent COMMITTED segments (position-segmented per bucket) ──
          // K workers pull (bucket, segStart) work items from a shared cursor and
          // process each segment independently (own transaction, durable, dedupe-safe).
          // Each bucket is segmented BY POSITION, so the same bucket is read by several
          // workers at disjoint $skip windows → full K-way concurrency even with a
          // SINGLE bucket (parity with master data). A bucket is marked done when a
          // segment read comes up short (no rows beyond it); workers that already
          // grabbed a past-the-end window just read empty (harmless, duplicate-safe).
          const buckets = segFilters.map(f => ({ filter: f, skip: 0, done: false }))
          // Refine the segment-count denominator now that time-bucket partitioning is
          // known. Each non-empty bucket commits ≥1 segment, so the real total is at
          // least the bucket count (the initial ceil(totalRows/SEGMENT_SIZE) ignores
          // partitioning → a time-partitioned KF otherwise showed e.g. "117/9").
          setProgress(p => ({ ...p, totalSegs: Math.max(totalRows > 0 ? Math.ceil(totalRows / SEGMENT_SIZE) : 0, buckets.length) }))
          const nextWork = () => {
            for (const b of buckets) {
              if (!b.done) { const segStart = b.skip; b.skip += SEGMENT_SIZE; return { b, segStart } }
            }
            return null
          }
          const worker = async () => {
            for (;;) {
              if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
              const w = nextWork()
              if (!w) return
              const { b, segStart } = w
              const segEnd = segStart + SEGMENT_SIZE

              for (let attempt = 1; ; attempt++) {
                if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                let segLoaded = 0, segWritten = 0, reachedEnd = false
                try {
                  const txId = await getTransactionId(connection, session, { signal })
                  try { await initiateParallelProcess(connection, session, txId, { planningArea: dstPa, versionId: dstVersion, transactionName: txName.trim() || 'IBP-ControlTower-KF' }) } catch { /* best-effort */ }

                  // Read this segment [segStart, segEnd) of the bucket, effParR pages at a time.
                  const segBuf = []
                  const tRead = Date.now()
                  for (let pageStart = segStart; pageStart < segEnd; pageStart += readPageSize * effParR) {
                    if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                    const batchPageCount = Math.min(effParR, Math.ceil((segEnd - pageStart) / readPageSize))
                    const batch = Array.from({ length: batchPageCount }, (_, j) => {
                      const sk = pageStart + j * readPageSize
                      const tp = Math.min(readPageSize, segEnd - sk)
                      return readKfPage(srcConn, srcSession, srcPa, { select: srcSelect, filter: b.filter || undefined, skip: sk, top: tp, orderby, signal })
                    })
                    setProgress(p => ({ ...p, phase: 'reading' }))
                    const rowsRead = (await Promise.all(batch)).flat()
                    if (rowsRead.length === 0) { reachedEnd = true; break }
                    for (const r of projectBatch(rowsRead)) segBuf.push(r)
                    segLoaded += rowsRead.length
                    inflightRows += rowsRead.length
                    setProgress(p => ({ ...p, rows: liveRows() }))
                    const want = Math.min(readPageSize * effParR, segEnd - pageStart)
                    if (rowsRead.length < want) { reachedEnd = true; break }   // bucket ended within this segment
                  }
                  if (reachedEnd) b.done = true
                  addPhase('reading', Date.now() - tRead)

                  // Write the whole segment as byte-accurate chunks, PARALLEL_W in parallel.
                  if (segBuf.length > 0) {
                    setProgress(p => ({ ...p, phase: 'writing' }))
                    const tWrite = Date.now()
                    const chunks = chunkByBytes(segBuf, MAX_POST_BYTES, chunkRows)
                    for (let ci = 0; ci < chunks.length; ci += PARALLEL_W) {
                      if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                      await Promise.all(chunks.slice(ci, ci + PARALLEL_W).map(chunk =>
                        postKfChunk(connection, session, dstPa, txId, chunk, { fields: dstFields, versionId: dstVersion, doCommit: false, signal, csrf })
                      ))
                    }
                    segWritten = segBuf.length
                    addPhase('writing', Date.now() - tWrite)
                  }

                  // Commit (only if it staged something; an all-empty segment is abandoned).
                  if (segWritten > 0) {
                    setProgress(p => ({ ...p, phase: 'committing' }))
                    const tCommit = Date.now()
                    await commitTransaction(connection, session, txId, { signal, csrf })
                    addPhase('committing', Date.now() - tCommit)
                    segmentTxIds.push(txId)
                    totalWritten += segWritten
                  }
                  // Move this segment's rows from in-flight to the durable baseline.
                  committedRows += segLoaded
                  inflightRows  -= segLoaded
                  setProgress(p => ({ ...p, rows: liveRows(), segsDone: (p.segsDone || 0) + 1 }))
                  break   // segment done; pull the next one
                } catch (e) {
                  // Roll this attempt's partial reads back out of the in-flight count
                  // (a retry re-reads them; a throw ends the run). Keeps liveRows() honest.
                  inflightRows -= segLoaded
                  if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) throw e
                  if (e.isCalculated) throw e   // permanent (calculated KF) — don't retry
                  // CSRF expired → refresh and retry (a 403 stages nothing, safe) (#2).
                  if (e?.status === 403) { try { csrf = await fetchCsrf(connection, session, { signal }) } catch { /* ignore */ } }
                  const transient = e?.status === 403 || e?.status == null || e.status >= 500
                  if (transient && attempt < MAX_SEGMENT_ATTEMPTS) {
                    setProgress(p => ({ ...p, phase: 'retrying' }))
                    await new Promise(r => setTimeout(r, 1500 * attempt))
                    continue
                  }
                  throw e
                }
              }
            }
          }
          // Mark when actual reading starts (after count/measure/buckets) so the live
          // rate & ETA reflect real throughput, not the fixed setup overhead.
          setProgress(p => ({ ...p, readStart: Date.now() }))
          // Without a stable $orderby, concurrent $skip windows could overlap or skip
          // rows → run fully serial (1 worker) in that rare case (#2).
          await Promise.all(Array.from({ length: orderby.length ? CONCURRENT_SEGMENTS : 1 }, () => worker()))

          // Nothing had a value → nothing migrated (and nothing committed).
          if (totalWritten === 0) {
            for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, txId: null, status: 'ok', total: 0, ok: 0, errors: 0, durationMs: Date.now() - groupStart, phaseTimes: { ...phaseAcc } })
            done += g.length
            continue
          }

          // Confirm processing + collect messages across ALL segment transactions,
          // CONCURRENTLY (bounded pool). Each segment committed its own transaction, so
          // they can be polled in parallel — this collapses what used to be ~N serial
          // round-trips (the invisible "processing" tail on big runs). readMessages is
          // only fetched when a transaction did NOT come back cleanly PROCESSED (a clean
          // PROCESSED has no error messages, so the extra round-trip is wasted).
          setProgress(p => ({ ...p, phase: 'processing' }))
          const tProc = Date.now()
          let anyError = false, anyWarning = false, anyUnconfirmed = false
          const msgs = []
          const txQueue = [...segmentTxIds]
          const confirmWorker = async () => {
            for (;;) {
              if (cancelledRef.current) break
              const tx = txQueue.shift()
              if (!tx) break
              const st0 = await waitForProcessed(connection, session, tx, { timeoutMs: Math.min(1800000, Math.max(120000, SEGMENT_SIZE * 3)), signal })
              if (st0 === 'ERROR') anyError = true
              else if (st0 === 'PROCESSED_WITH_ERRORS') anyWarning = true
              else if (st0 !== 'PROCESSED') anyUnconfirmed = true
              if (st0 !== 'PROCESSED') {
                const m = await readMessages(connection, session, dstPa, tx, { signal })
                // Count only error/abort messages (E/A). If the tenant's Message set has
                // no Severity field, keep all (preserves prior behaviour) (#5).
                msgs.push(...m.filter(x => x.Severity == null || ['E', 'A'].includes(x.Severity)))
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(CONCURRENT_SEGMENTS, Math.max(1, segmentTxIds.length)) }, () => confirmWorker()))
          addPhase('processing', Date.now() - tProc)
          // Honest status: any ERROR → error; rejections/warnings → warning;
          // unconfirmed → processing; else ok.
          const st = anyError ? 'error'
                   : (msgs.length > 0 || anyWarning) ? 'warning'
                   : anyUnconfirmed ? 'processing' : 'ok'
          // One result row per KF of the group. total = values actually written.
          // durationMs = group wall time; phaseTimes = cumulative effort per phase
          // (summed across concurrent workers — can exceed wall time, by design).
          const lastTx = segmentTxIds[segmentTxIds.length - 1] || null
          const groupDur = Date.now() - groupStart
          for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, txId: lastTx, status: st, total: totalWritten, ok: Math.max(0, totalWritten - msgs.length), errors: msgs.length, messages: msgs, durationMs: groupDur, phaseTimes: { ...phaseAcc }, segments: segmentTxIds.length })
        } catch (e) {
          const groupDur = Date.now() - groupStart
          if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) {
            for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, status: 'cancelled', total: 0, ok: 0, errors: 0, durationMs: groupDur, phaseTimes: { ...phaseAcc } })
            break
          }
          // A calculated KF in the group fails the whole group's POST; report the
          // offending KF (from "invalid column name") so the user can remove it.
          const msg = e.isCalculated ? t('kfm.errCalculated', { kf: e.calculatedKf || label }) : errText(e)
          for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, status: 'error', total: 0, ok: 0, errors: 1, errorMsg: msg, durationMs: groupDur, phaseTimes: { ...phaseAcc } })
        }
        done += g.length
      }
    } finally {
      setRunning(false); setProgress(null); setResults(all)

      // Persist the run in the per-connection history. Rows are deduped by txId
      // (KFs of the same group share a transaction and report the same total).
      const seen = new Set()
      let totalRowsMigrated = 0
      for (const r of all) { const k = r.txId || r.kf; if (seen.has(k)) continue; seen.add(k); totalRowsMigrated += (r.total || 0) }
      const overallStatus = all.some(r => r.status === 'cancelled') ? 'cancelled'
        : all.some(r => r.status === 'error') ? 'error'
        : all.some(r => r.status === 'processing') ? 'processing'
        : all.some(r => r.status === 'warning') ? 'warning' : 'ok'
      const entry = {
        date: new Date().toISOString(),
        srcConnId: srcConn?.id || '', srcConnName: srcConn?.name || '',
        srcPa, srcVersion, dstPa, dstVersion,
        kfs: steps.map(s => s.dstKf),
        filters: extraKfFilter || '',
        totalRows: totalRowsMigrated,
        status: overallStatus,
        durationMs: Date.now() - runStartRef.current,
        timings: all.map(r => ({ kf: r.kf, durationMs: r.durationMs, phaseTimes: r.phaseTimes })),
      }
      const updated = [entry, ...loadKfHistory(connection.id)].slice(0, 50)
      saveKfHistory(connection.id, updated)
      setHistory(updated)
    }
  }, [connection, session, srcConn, srcSession, dstCat, srcCat, steps, levelAttrs, dstVersion, srcVersion, timeField, selUom, selCurr, resolveSrcAttr, extraKfFilter, txName]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusLabel = s => s === 'ok' ? t('kfm.stOk') : s === 'error' ? t('kfm.stErr') : s === 'warning' ? t('kfm.stWarning') : s === 'processing' ? t('kfm.stProc') : s === 'skipped' ? t('mig.statusSkipped') : t('kfm.stCancel')
  const statusColor = s => s === 'ok' ? 'var(--green)' : s === 'error' ? 'var(--red)' : s === 'warning' ? 'var(--yellow, #e6a817)' : s === 'processing' ? 'var(--yellow, #e6a817)' : 'var(--text3)'
  const PHASE = { detect: t('kfm.phDetect'), count: t('kfm.phCount'), reading: t('kfm.phReading'), writing: t('kfm.phWriting'), committing: t('kfm.phCommit'), processing: t('kfm.phProcessing'), retrying: t('kfm.phRetrying') }
  // Concise phase names for the timing breakdown (reuses the master-data keys).
  const PHASE_SHORT = { count: t('kfm.tCount'), reading: t('mig.tReading'), writing: t('mig.tWriting'), committing: t('mig.tCommitting'), processing: t('mig.tProcessing'), messages: t('mig.tMessages') }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>{t('kfm.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 20 }}>{t('kfm.subtitle')}</div>

      {/* ── Source / destination ── */}
      <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
        <div style={{ ...SECTION_HDR, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{t('kfm.sectionConn')}</span>
          <button
            type="button"
            onClick={refreshCatalogs}
            disabled={dstLoading || srcLoading}
            title={t('mig.refreshConns')}
            style={{ background: 'none', border: 'none', cursor: (dstLoading || srcLoading) ? 'default' : 'pointer', fontSize: 10, color: 'var(--text3)', padding: '0 2px', textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}
          >
            {t('mig.refreshConns')}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Source */}
          <div>
            <label style={LABEL}>{t('kfm.srcLabel')}</label>
            {allConns.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>{t('kfm.noSource')}</div>
            ) : (
              <select style={SELECT} value={srcConnId || ''} onChange={e => {
                const id = e.target.value || null
                const usr = id ? allConns.find(c => c.id === id)?.com0720?.user || '' : ''
                setSrcConnId(id); setSrcTempCreds(null); setSrcLoginForm({ user: usr, password: '' }); setSrcLoginErr('')
                setSrcVersion('')
              }}>
                <option value="">{t('kfm.selectSource')}</option>
                {allConns.map(c => <option key={c.id} value={c.id}>{c.id === connection.id ? t('mig.srcSelf', { name: c.name }) : c.name}</option>)}
              </select>
            )}
            {needsSrcLogin && (
              <form onSubmit={handleSrcLogin} style={{ marginTop: 12, background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 8, padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 10 }}>{t('kfm.loginTitle')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input style={INPUT} placeholder={t('login.user')} value={srcLoginForm.user} onChange={e => setSrcLoginForm(p => ({ ...p, user: e.target.value }))} />
                  <input style={INPUT} type="password" placeholder={t('login.password')} value={srcLoginForm.password} onChange={e => setSrcLoginForm(p => ({ ...p, password: e.target.value }))} />
                </div>
                {srcLoginErr && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 6 }}>✕ {srcLoginErr}</div>}
                <button type="submit" disabled={srcLoginLoading} style={{ ...btnPrimary(srcLoginLoading), marginTop: 10, width: '100%' }}>
                  {srcLoginLoading ? t('kfm.loginVerifying') : t('kfm.loginBtn')}
                </button>
              </form>
            )}
            {srcConn && srcSession && (
              <div style={{ marginTop: 12 }}>
                <label style={LABEL}>{t('kfm.area')}</label>
                <select style={SELECT} value={srcPa} onChange={e => setSrcPa(e.target.value)} disabled={srcAreas.length <= 1}>
                  {srcAreas.length !== 1 && <option value="">{srcLoading ? t('kfm.loadingCat') : t('kfm.selectArea')}</option>}
                  {srcAreas.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <label style={{ ...LABEL, marginTop: 10 }}>{t('kfm.srcVersion')}</label>
                <select style={SELECT} value={srcVersion} onChange={e => setSrcVersion(e.target.value)} disabled={!srcCat}>
                  <option value="">{t('kfm.baseVersion')}</option>
                  {(srcCat?.versions || []).filter(v => v.id && v.id !== '__BASELINE').map(v => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
                </select>
              </div>
            )}
          </div>
          {/* Destination */}
          <div>
            <label style={LABEL}>{t('kfm.dstLabel')}</label>
            <div style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', borderRadius: 6, padding: '7px 10px', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
              {connection.name}
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={LABEL}>{t('kfm.area')}</label>
              <select style={SELECT} value={dstPa} onChange={e => setDstPa(e.target.value)} disabled={dstAreas.length <= 1}>
                {dstAreas.length !== 1 && <option value="">{dstLoading ? t('kfm.loadingCat') : t('kfm.selectArea')}</option>}
                {dstAreas.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={LABEL}>{t('kfm.dstVersion')}</label>
              <select style={SELECT} value={dstVersion} onChange={e => setDstVersion(e.target.value)} disabled={!dstCat}>
                <option value="">{t('kfm.baseVersion')}</option>
                {(dstCat?.versions || []).filter(v => v.id && v.id !== '__BASELINE').map(v => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
              </select>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={LABEL}>{t('kfm.txName')}</label>
              <input style={INPUT} value={txName} onChange={e => setTxName(e.target.value)} placeholder="IBP-ControlTower-KF" maxLength={40} />
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>{t('kfm.txNameNote')}</div>
            </div>
          </div>
        </div>
        {catError && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>✕ {catError}</div>}
      </div>

      {/* ── Level (destination attributes + time) ── */}
      {dstCat && srcCat && (
        <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
          <div style={SECTION_HDR}>{t('kfm.sectionLevel')}</div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: '0 0 220px' }}>
              <label style={LABEL}>{t('kfm.timeLevel')}</label>
              <select style={SELECT} value={timeField} onChange={e => setTimeField(e.target.value)}>
                {TIME_LEVELS.filter(tl => (dstCat.dims || []).includes(tl.field)).map(tl => (
                  <option key={tl.field} value={tl.field}>{t(`kfm.time_${tl.key}`)}</option>
                ))}
              </select>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              {levelAttrs.length > 0 ? t('kfm.levelPreview', { attrs: [...levelAttrs, t(`kfm.time_${(TIME_LEVELS.find(x=>x.field===timeField)||{}).key}`)].join(' · ') }) : t('kfm.levelHint')}
            </div>
          </div>
          <input style={{ ...INPUT, marginBottom: 8 }} placeholder={t('kfm.attrSearch')} value={attrSearch} onChange={e => setAttrSearch(e.target.value)} />
          <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {filteredAttrs.slice(0, 200).map(a => {
              const sel = levelAttrs.includes(a)
              const inSrc = srcAttrSet.has(a)
              return (
                <button key={a} onClick={() => setLevelAttrs(p => sel ? p.filter(x => x !== a) : [...p, a])}
                  title={dstCat.labels?.[a] || a}
                  style={{ fontSize: 11, fontFamily: 'var(--mono)', padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                    border: `1px solid ${sel ? 'var(--accent)' : 'var(--border)'}`,
                    background: sel ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg)',
                    color: sel ? 'var(--text)' : 'var(--text2)' }}>
                  {a}{!inSrc && <span title={t('kfm.attrNeedsMap')} style={{ color: 'var(--yellow, #e6a817)', marginLeft: 4 }}>⚠</span>}
                </button>
              )
            })}
          </div>

          {/* Attribute mapping (only custom attrs whose source name differs) */}
          {unmappedAttrs.length > 0 && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--yellow, #e6a817)', marginBottom: 8 }}>{t('kfm.attrMapHint')}</div>
              {unmappedAttrs.map(a => (
                <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', flex: '0 0 200px' }}>{a} ({t('kfm.dst')})</span>
                  <span style={{ color: 'var(--text3)' }}>←</span>
                  <select style={{ ...SELECT, flex: 1 }} value={attrMap[a] || ''} onChange={e => setAttrMap(p => ({ ...p, [a]: e.target.value }))}>
                    <option value="">{t('kfm.selectSrcAttr')}</option>
                    {[...srcAttrSet].filter(s => !s.startsWith('PERIODID')).sort().map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Filtros previos (migración selectiva) ── */}
      {dstCat && srcCat && (
        <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ ...SECTION_HDR, marginBottom: 0 }}>⧩ {t('flt.title')}</div>
            {extraKfFilter && (
              <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>
                {t('kfm.fltActive')}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>{t('kfm.fltHint')}</div>

          {/* Rango de fechas (nivel de tiempo elegido) */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ flex: '0 0 170px' }}>
              <label style={LABEL}>{t('kfm.fltDateFrom')}</label>
              <input type="date" style={INPUT} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </div>
            <div style={{ flex: '0 0 170px' }}>
              <label style={LABEL}>{t('kfm.fltDateTo')}</label>
              <input type="date" style={INPUT} value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', paddingBottom: 8 }}>
              {t('kfm.fltDateHint', { time: timeLabel })}
            </div>
          </div>

          {/* Condiciones por atributo del origen */}
          {attrFilters.map((c, ci) => (
            <div key={ci} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <SearchSelect
                value={c.field}
                options={srcFilterAttrOptions}
                onChange={v => setAttrFilters(p => p.map((x, xi) => xi === ci ? { ...x, field: v, value: '' } : x))}
                placeholder={t('kfm.fltAttrPh')}
                searchPlaceholder={t('kfm.typeToFilter')}
                style={{ flex: '0 0 32%', minWidth: 0 }}
                btnStyle={{ fontSize: 11, padding: '4px 8px' }}
              />
              <select
                value={c.op}
                onChange={e => setAttrFilters(p => p.map((x, xi) => xi === ci ? { ...x, op: e.target.value } : x))}
                style={{ ...SELECT, flex: '0 0 150px', fontSize: 11, padding: '4px 6px' }}
              >
                <option value="in">{t('flt.opIn')}</option>
                <option value="sw">{t('flt.opSw')}</option>
              </select>
              {c.op === 'sw' ? (
                <input
                  value={c.value}
                  onChange={e => setAttrFilters(p => p.map((x, xi) => xi === ci ? { ...x, value: e.target.value } : x))}
                  placeholder={t('flt.valuePh')}
                  style={{ ...INPUT, flex: 1, minWidth: 0, fontSize: 11, padding: '4px 8px', fontFamily: 'var(--mono)' }}
                />
              ) : (
                <MultiValueSelect
                  value={c.value}
                  onChange={v => setAttrFilters(p => p.map((x, xi) => xi === ci ? { ...x, value: v } : x))}
                  loadValues={() => fetchAttrDistinctValues(srcConn, srcSession, c.field, { planningArea: srcCat.pa })}
                  placeholder={t('flt.valuesPh')}
                  disabled={!c.field}
                />
              )}
              <button
                onClick={() => setAttrFilters(p => p.filter((_, xi) => xi !== ci))}
                title={t('flt.remove')}
                style={{ ...BTN_SEC, padding: '2px 7px', fontSize: 10, flexShrink: 0, color: 'var(--red)', borderColor: 'var(--red)' }}
              >✕</button>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <button
              onClick={() => setAttrFilters(p => [...p, { field: '', op: 'in', value: '' }])}
              style={{ ...BTN_SEC, padding: '3px 10px', fontSize: 10 }}
            >
              {t('kfm.fltAddAttr')}
            </button>
            {extraKfFilter && (
              <button
                onClick={handleFilterCount}
                disabled={fltCount?.loading || !steps.some(s => s.srcKf)}
                title={!steps.some(s => s.srcKf) ? t('kfm.fltCountNeedKf') : ''}
                style={{ ...BTN_SEC, padding: '3px 10px', fontSize: 10, borderColor: 'var(--accent)', color: 'var(--accent)', opacity: !steps.some(s => s.srcKf) ? 0.5 : 1 }}
              >
                {fltCount?.loading ? t('flt.testing') : t('kfm.fltCountBtn')}
              </button>
            )}
            {extraKfFilter && !steps.some(s => s.srcKf) && (
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>{t('kfm.fltCountNeedKf')}</span>
            )}
            {fltCount?.n != null && (
              <span style={{ fontSize: 11, color: 'var(--green)', fontFamily: 'var(--mono)' }}>
                ✓ {t('kfm.fltCountResult', { n: fltCount.n.toLocaleString(), kf: fltCount.kf })}
              </span>
            )}
            {fltCount?.error && (
              <span style={{ fontSize: 11, color: 'var(--red)' }}>✕ {t('flt.testErr', { msg: fltCount.error })}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Key figures (steps) ── */}
      {dstCat && srcCat && levelAttrs.length > 0 && (
        <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={SECTION_HDR}>{t('kfm.sectionKf', { n: steps.length })}</div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
            {t('kfm.kfHint', { dst: connection.name, src: srcConn?.name || t('kfm.srcLabel') })}
          </div>
          <input style={{ ...INPUT, marginBottom: 8 }} placeholder={t('kfm.kfSearch')} value={kfSearch} onChange={e => setKfSearch(e.target.value)} />
          <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filteredKfs.slice(0, 300).map(k => {
              const idx = steps.findIndex(s => s.dstKf === k)
              const sel = idx >= 0
              return (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '3px 2px' }} title={dstCat.labels?.[k] || k}>
                  <input type="checkbox" checked={sel} onChange={e => {
                    if (e.target.checked) {
                      setSteps(p => [...p, { dstKf: k, srcKf: defaultSrcKf(k), convs: undefined }])
                      const sk = defaultSrcKf(k) || k
                      detectConversions(srcConn, srcSession, srcCat.pa, sk)
                        .then(convs => setSteps(p => p.map(s => s.dstKf === k ? { ...s, convs } : s)))
                        .catch(() => {})
                    } else setSteps(p => p.filter(s => s.dstKf !== k))
                  }} />
                  <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)', flex: 1 }}>{k}</span>
                </label>
              )
            })}
          </div>

          {/* Ordered steps with KF mapping */}
          {steps.length > 0 && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ ...SECTION_HDR, marginBottom: 8 }}>{t('kfm.orderTitle')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 4px', fontSize: 9, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                <span style={{ width: 22, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>{t('kfm.colSrc', { sys: srcConn?.name || '' })}</span>
                <span style={{ width: 12, flexShrink: 0 }} />
                <span style={{ flex: '0 0 38%' }}>{t('kfm.colDst', { sys: connection.name })}</span>
                <span style={{ width: 58, flexShrink: 0 }} />
              </div>
              {steps.map((s, idx) => (
                <div key={s.dstKf} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', marginBottom: 4, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7 }}>
                  <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'var(--text2)', background: 'var(--bg2)', border: '1px solid var(--border)' }}>{idx + 1}</div>
                  {/* source KF picker — searchable (hundreds of KFs make a native select unusable) */}
                  <SearchSelect
                    value={s.srcKf}
                    options={srcKfOptions}
                    onChange={v => setSteps(p => p.map(x => x.dstKf === s.dstKf ? { ...x, srcKf: v } : x))}
                    placeholder={t('kfm.selectSrcKf')}
                    searchPlaceholder={t('kfm.typeToFilter')}
                    invalid={!s.srcKf}
                    style={{ flex: 1, minWidth: 0 }}
                    btnStyle={{ fontSize: 11, padding: '3px 6px' }}
                  />
                  <span style={{ color: 'var(--text3)', fontSize: 12 }}>→</span>
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', flex: '0 0 38%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.dstKf}>{s.dstKf}</span>
                  <button disabled={idx === 0} onClick={() => setSteps(p => { const a = [...p];[a[idx], a[idx - 1]] = [a[idx - 1], a[idx]]; return a })} style={{ ...BTN_SEC, padding: '2px 7px', fontSize: 10, opacity: idx === 0 ? 0.25 : 1 }}>↑</button>
                  <button disabled={idx === steps.length - 1} onClick={() => setSteps(p => { const a = [...p];[a[idx], a[idx + 1]] = [a[idx + 1], a[idx]]; return a })} style={{ ...BTN_SEC, padding: '2px 7px', fontSize: 10, opacity: idx === steps.length - 1 ? 0.25 : 1 }}>↓</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Conversion (UOM / currency) ── */}
      {dstCat && srcCat && (needsUom || needsCurr) && (
        <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
          <div style={SECTION_HDR}>{t('kfm.sectionConv')}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>{t('kfm.convHint')}</div>
          <div style={{ display: 'flex', gap: 24 }}>
            {needsUom && (
              <div style={{ flex: 1 }}>
                <label style={LABEL}>{t('kfm.uomLabel')}</label>
                <SearchSelect
                  value={selUom}
                  options={units.map(u => ({ value: u.id, label: u.id + (u.desc && u.desc !== u.id ? ` — ${u.desc}` : '') }))}
                  onChange={setSelUom}
                  placeholder={t('kfm.selectUom')}
                  searchPlaceholder={t('kfm.typeToFilter')}
                  invalid={!selUom}
                  mono={false}
                />
              </div>
            )}
            {needsCurr && (
              <div style={{ flex: 1 }}>
                <label style={LABEL}>{t('kfm.currLabel')}</label>
                <SearchSelect
                  value={selCurr}
                  options={currencies.map(c => ({ value: c.id, label: c.id + (c.desc && c.desc !== c.id ? ` — ${c.desc}` : '') }))}
                  onChange={setSelCurr}
                  placeholder={t('kfm.selectCurr')}
                  searchPlaceholder={t('kfm.typeToFilter')}
                  invalid={!selCurr}
                  mono={false}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Action bar ── */}
      {dstCat && srcCat && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
          {running ? (
            <button style={BTN_DANGER} onClick={() => { cancelledRef.current = true; abortRef.current?.abort() }}>{t('kfm.cancelBtn')}</button>
          ) : (
            <button style={btnPrimary(!canMigrate)} disabled={!canMigrate} onClick={handleMigrateClick}>{t('kfm.migrateBtn')}</button>
          )}
          {sameTarget && <span style={{ fontSize: 11, color: 'var(--red)' }}>✕ {t('mig.sameTargetWarning')}</span>}
          {!dstVersion && <span style={{ fontSize: 11, color: 'var(--yellow, #e6a817)' }}>{t('kfm.baseWarning')}</span>}
        </div>
      )}

      {/* ── Progress — live clock, per-KF step list, %, rate, ETA, durable segments ── */}
      {running && progress && (
        <div style={{ ...SECTION, background: 'color-mix(in srgb, var(--accent) 5%, var(--bg2))' }}>
          <div style={{ ...SECTION_HDR, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{t('kfm.progressTitle', { cur: progress.cur, total: progress.total })}</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text2)', letterSpacing: 0 }}>⏱ {fmtDuration(runElapsed)}</span>
          </div>

          {/* Step list — every selected KF with its live status */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {steps.map(s => {
              const doneR = (results || []).find(r => r.kf === s.dstKf)
              const isCurrent = !doneR && String(progress.name || '').split(', ').includes(s.dstKf)
              const icon = doneR
                ? (doneR.status === 'ok' ? '✓' : doneR.status === 'error' ? '✕' : doneR.status === 'warning' ? '⚠' : doneR.status === 'processing' ? '⧗' : '⊘')
                : isCurrent ? '⏳' : '○'
              const color = doneR ? statusColor(doneR.status) : isCurrent ? 'var(--accent)' : 'var(--text3)'
              return (
                <div key={s.dstKf} style={{ border: '1px solid var(--border)', borderRadius: 7, padding: '6px 10px', background: 'var(--bg)', opacity: (!doneR && !isCurrent) ? 0.55 : 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color, fontSize: 12, width: 14, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.srcKf && s.srcKf !== s.dstKf ? `${s.srcKf} → ${s.dstKf}` : s.dstKf}
                  </span>
                  <span style={{ fontSize: 11, color, flexShrink: 0 }}>
                    {doneR
                      ? `${statusLabel(doneR.status)} · ${(doneR.total || 0).toLocaleString()} · ${fmtDuration(doneR.durationMs)}`
                      : isCurrent ? (PHASE[progress.phase] || '') : t('mig.stepPending')}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Current KF — bar + %, live speed, ETA and committed segments */}
          {(() => {
            // Rate measured from when READING started (readStart), not from groupStart —
            // otherwise the fixed setup (count + buckets + measure) drags the rate/ETA
            // down. progress.rows is the SHARED live count (committed + in-flight across
            // all workers), so the rate now reflects real throughput.
            const rateClock = progress.readStart || progress.groupStart || Date.now()
            const elapsedS = Math.max(1, (Date.now() - rateClock) / 1000)
            const rate = (progress.rows > 0 && progress.readStart) ? Math.round(progress.rows / elapsedS) : 0
            const pct = progress.totalRows > 0 ? Math.min(100, (progress.rows / progress.totalRows) * 100) : null
            const etaS = (pct != null && rate > 0) ? Math.max(0, (progress.totalRows - progress.rows) / rate) : null
            return (
              <>
                {pct != null && (
                  <div style={{ background: 'var(--border)', borderRadius: 4, height: 6, overflow: 'hidden', marginBottom: 4 }}>
                    <div style={{ background: 'var(--accent)', height: '100%', width: `${pct}%`, transition: 'width .3s' }} />
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--text3)', display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
                  <span style={{ fontFamily: 'var(--mono)' }}>
                    {progress.rows.toLocaleString()}{progress.totalRows > 0 ? ` / ${progress.totalRows.toLocaleString()} (${Math.floor(pct)}%)` : ` ${t('kfm.rowsNoTotal')}`}
                  </span>
                  {rate > 0 && <span>{t('kfm.rate', { n: rate.toLocaleString() })}</span>}
                  {etaS != null && etaS > 1 && <span>{t('kfm.eta', { t: fmtDuration(etaS * 1000) })}</span>}
                  {(progress.segsDone || 0) > 0 && <span>{t('kfm.segs', { a: progress.segsDone, b: progress.totalSegs > 0 ? progress.totalSegs : '?' })}</span>}
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* ── Results — with per-KF timing, expandable phase breakdown and a summary ── */}
      {!running && results && results.length > 0 && (
        <div style={SECTION}>
          <div style={SECTION_HDR}>{t('kfm.resultsTitle')}</div>

          {/* Timing summary (groups share a transaction → dedupe by txId) */}
          {(() => {
            const seen = new Set()
            const phaseTotals = {}
            let slowest = null
            for (const r of results) {
              const key = r.txId || r.kf
              if (seen.has(key)) continue
              seen.add(key)
              Object.entries(r.phaseTimes || {}).forEach(([p, ms]) => { phaseTotals[p] = (phaseTotals[p] || 0) + ms })
              if ((r.durationMs || 0) > (slowest?.durationMs || 0)) slowest = r
            }
            return (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontSize: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 700, color: 'var(--text)' }}>{t('mig.summaryTotal', { dur: fmtDuration(runElapsed) })}</span>
                  {slowest && <span style={{ color: 'var(--text2)' }}>{t('mig.summarySlowest', { name: slowest.kf, dur: fmtDuration(slowest.durationMs) })}</span>}
                </div>
                {Object.keys(phaseTotals).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6, color: 'var(--text3)', fontSize: 11 }}>
                    {KF_TIMED_PHASES.filter(p => phaseTotals[p]).map(p => (
                      <span key={p}>{PHASE_SHORT[p]}: <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}>{fmtDuration(phaseTotals[p])}</span></span>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr>
              <th style={TH}>{t('kfm.colKf')}</th><th style={TH}>{t('kfm.colStatus')}</th>
              <th style={TH}>{t('kfm.colTotal')}</th><th style={TH}>{t('kfm.colErrors')}</th>
              <th style={TH}>{t('mig.colTime')}</th><th style={TH}>{t('kfm.colTx')}</th>
            </tr></thead>
            <tbody>
              {results.map(r => {
                const isTimeOpen = expandedTimeKf === r.kf
                return (
                  <Fragment key={r.kf}>
                    <tr>
                      <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text)' })}>{r.srcKf && r.srcKf !== r.kf ? `${r.srcKf} → ${r.kf}` : r.kf}</td>
                      <td style={td({ fontWeight: 600, color: statusColor(r.status) })}>{statusLabel(r.status)}</td>
                      <td style={td({ color: 'var(--text2)' })}>{(r.total || 0).toLocaleString()}</td>
                      <td style={td({ color: r.errors > 0 ? 'var(--red)' : 'var(--text3)' })}>
                        {r.errors > 0 ? <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 11, fontWeight: 600 }} onClick={() => setExpanded(expanded === r.kf ? null : r.kf)}>{r.errors}</button> : (r.errors || 0)}
                        {r.errorMsg && <div style={{ fontSize: 10, color: 'var(--red)' }}>{r.errorMsg}</div>}
                      </td>
                      <td style={td({ color: 'var(--text2)', fontSize: 11, whiteSpace: 'nowrap' })}>
                        {r.durationMs == null ? '—' : (
                          <button
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', fontSize: 11, padding: 0, fontFamily: 'var(--mono)' }}
                            title={t('mig.timeBreakdownHint')}
                            onClick={() => setExpandedTimeKf(isTimeOpen ? null : r.kf)}
                          >
                            {fmtDuration(r.durationMs)} {isTimeOpen ? '▾' : '▸'}
                          </button>
                        )}
                      </td>
                      <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text3)', fontSize: 10 })}>{r.txId || '—'}</td>
                    </tr>
                    {isTimeOpen && (
                      <tr>
                        <td colSpan={6} style={{ padding: '4px 0 8px 24px', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 11, color: 'var(--text3)' }}>
                            {KF_TIMED_PHASES.filter(p => r.phaseTimes?.[p]).map(p => (
                              <span key={p}>{PHASE_SHORT[p]}: <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}>{fmtDuration(r.phaseTimes[p])}</span></span>
                            ))}
                            {r.segments > 0 && <span>{t('kfm.segs', { a: r.segments, b: r.segments })}</span>}
                            {(!r.phaseTimes || Object.keys(r.phaseTimes).length === 0) && <span>{t('mig.noTimeDetail')}</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          {expanded && (results.find(r => r.kf === expanded)?.messages || []).length > 0 && (
            <div style={{ marginTop: 10, maxHeight: 200, overflowY: 'auto', fontSize: 11 }}>
              {(results.find(r => r.kf === expanded).messages).map((m, i) => (
                <div key={i} style={{ color: 'var(--red)', fontFamily: 'var(--mono)', padding: '2px 0' }}>{m.ExceptionId}: {m.MsgText}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── History (persisted per destination connection) ── */}
      {history.length > 0 && (
        <div style={SECTION}>
          <button
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text2)', fontWeight: 600, padding: 0 }}
            onClick={() => setShowHistory(p => !p)}
          >
            {showHistory ? t('mig.histToggleClose') : t('mig.histToggleOpen')}
          </button>
          {showHistory && (
            <div style={{ marginTop: 12, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={TH}>{t('mig.histDate')}</th>
                    <th style={TH}>{t('mig.histSrc')}</th>
                    <th style={TH}>{t('mig.histDst')}</th>
                    <th style={TH}>{t('kfm.histKfs')}</th>
                    <th style={TH}>{t('mig.histRows')}</th>
                    <th style={TH}>{t('mig.histTime')}</th>
                    <th style={TH}>{t('mig.histStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i}>
                      <td style={td({ color: 'var(--text3)', fontSize: 11 })}>{new Date(h.date).toLocaleString()}</td>
                      <td style={td({ color: 'var(--text2)' })}>{h.srcConnName || '—'} / {h.srcPa}{h.srcVersion ? ` / ${h.srcVersion}` : ''}</td>
                      <td style={td({ color: 'var(--text2)' })}>{connection.name} / {h.dstPa}{h.dstVersion ? ` / ${h.dstVersion}` : ''}</td>
                      <td style={td({ color: 'var(--text2)' })} title={(h.kfs || []).join(', ')}>{h.kfs?.length || 0}</td>
                      <td style={td({ color: 'var(--text2)' })}>{(h.totalRows || 0).toLocaleString()}</td>
                      <td style={td({ color: 'var(--text2)', fontFamily: 'var(--mono)' })}>{fmtDuration(h.durationMs)}</td>
                      <td style={td({ fontWeight: 600, color: statusColor(h.status) })}>{statusLabel(h.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Pre-migration confirmation — INSTANT summary (no slow pre-analysis) ── */}
      {showConfirm && (() => {
        const isProd = ['Producción', 'Production'].includes(connection.ambiente)
        return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--overlay)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 12, padding: 24, width: 580, maxWidth: '92vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>{t('kfm.confirmTitle')}</div>
            {isProd && (
              <div style={{
                fontSize: 11, color: 'var(--red)', lineHeight: 1.5, marginBottom: 12,
                background: 'color-mix(in srgb, var(--red) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
                borderRadius: 6, padding: '7px 10px',
              }}>
                ⚠ {t('mig.confirmMsg', { name: connection.name })}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>
              {t('kfm.confirmSimpleIntro', { n: steps.length, ver: dstVersion || 'Base' })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 10 }}>
              {t('kfm.confirmLevel')}: <span style={{ fontFamily: 'var(--mono)' }}>{levelStr(levelAttrs)}</span>
            </div>
            {extraKfFilter && (
              <div style={{
                fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 10,
                background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
                borderRadius: 6, padding: '7px 10px',
              }}>
                <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 3 }}>⧩ {t('flt.confirmTitle')}</div>
                {attrFilters.map((c, ci) => {
                  const chip = condChip(c)
                  return chip ? <div key={ci} style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{chip}</div> : null
                })}
                {(dateFrom || dateTo) && (
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>
                    {timeLabel}: {dateFrom || '…'} → {dateTo || '…'}
                  </div>
                )}
              </div>
            )}
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {steps.map(s => (
                <div key={s.dstKf} style={{ border: '1px solid var(--border)', borderRadius: 7, padding: '7px 10px', background: 'var(--bg)', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                  {s.srcKf && s.srcKf !== s.dstKf ? `${s.srcKf} → ${s.dstKf}` : s.dstKf}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={BTN_SEC} onClick={() => setShowConfirm(false)}>{t('kfm.confirmCancel')}</button>
              <button style={isProd ? { ...btnPrimary(false), background: 'var(--red)', color: '#fff' } : btnPrimary(false)} onClick={runMigration}>{t('kfm.confirmMigrate')}</button>
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}
