import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useI18n } from '../../context/I18nContext'
import { getAll } from '../../services/connectionStorage'
import { getSession, setSession } from '../../services/sessionStorage'
import { setMigrationGuard } from '../../services/migrationGuard'
import {
  fetchKfCatalog, fetchKfAreas, planningServiceRoot, fetchConversionValues,
  countKf, readKfPage, detectConversion, fetchTimeBuckets,
  fetchCsrf, getTransactionId, initiateParallelProcess, postKfChunk,
  commitTransaction, waitForProcessed, readMessages,
  odataDateToIso, rowsPerChunk, readRowsPerPage, measureKfRowBytes, readRowsPerPageBytes, rowsPerChunkBytes,
  chunkByBytes, MAX_POST_BYTES, PARALLEL_R, PARALLEL_W, SEGMENT_SIZE, MAX_SEGMENT_ATTEMPTS, CONCURRENT_SEGMENTS,
} from '../../services/planningDataApi'

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

export default function KeyFigureMigration({ connection, session }) {
  const { t } = useI18n()

  // Destination = current connection; source = another connection with SAP_COM_0720.
  const allConns = useMemo(() => getAll().filter(c => c.id !== connection.id && c.com0720?.url && c.com0720?.user), [connection.id])

  // ── Source connection + inline login ──
  const [srcConnId, setSrcConnId]       = useState(null)
  const [srcTempCreds, setSrcTempCreds] = useState(null)
  const [srcLoginForm, setSrcLoginForm] = useState({ user: '', password: '' })
  const [srcLoginErr, setSrcLoginErr]   = useState('')
  const [srcLoginLoading, setSrcLoginLoading] = useState(false)
  const srcConn = useMemo(() => allConns.find(c => c.id === srcConnId) || null, [allConns, srcConnId])
  const srcSession = useMemo(() => {
    if (!srcConnId) return null
    const stored = getSession(srcConnId)
    const com0720 = srcTempCreds || stored?.com0720
    if (!com0720?.password) return null
    return { ...(stored || {}), com0720 }
  }, [srcConnId, srcTempCreds])
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

  // ── Selections ──
  const [dstVersion, setDstVersion] = useState('')   // '' = base
  const [srcVersion, setSrcVersion] = useState('')
  const [timeField, setTimeField]   = useState('PERIODID4_TSTAMP')
  const [levelAttrs, setLevelAttrs] = useState([])   // destination attribute names (root level)
  const [attrSearch, setAttrSearch] = useState('')
  const [steps, setSteps]           = useState([])   // [{ dstKf, srcKf }]
  const [kfSearch, setKfSearch]     = useState('')
  // Per-destination-attribute → source attribute mapping (only when names differ)
  const [attrMap, setAttrMap]       = useState({})
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
  const [analyzing, setAnalyzing]   = useState(false)
  const [analysis, setAnalysis]     = useState(null)   // { byKf, error? }
  const [showConfirm, setShowConfirm] = useState(false)

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
  }, [connection.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [connection.id, dstPa]) // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [srcConnId, srcTempCreds?.user]) // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [srcConnId, srcPa, srcTempCreds?.user]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Leave guard while running ──
  useEffect(() => { setMigrationGuard(running, t('mig.leaveWarning')); return () => setMigrationGuard(false) }, [running, t])
  useEffect(() => () => { cancelledRef.current = true; abortRef.current?.abort() }, [])

  // Reset selections when catalogs change
  useEffect(() => { setLevelAttrs([]); setSteps([]); setAttrMap({}) }, [dstCat])

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
  const srcAttrSet = useMemo(() => new Set(srcCat?.dims || []), [srcCat])

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
  const needsUom  = steps.some(s => s.conv === 'UOM')
  const needsCurr = steps.some(s => s.conv === 'CURR')
  const canMigrate = !running && !!srcConn && !!srcSession && !!dstCat && !!srcCat &&
    levelAttrs.length > 0 && steps.length > 0 && steps.every(s => s.srcKf) && unmappedAttrs.length === 0 &&
    (!needsUom || selUom) && (!needsCurr || selCurr)

  // Deduce each KF's planning level USING ONLY the level the user configured:
  // for every chosen dimension, count with vs without it — if removing it lowers
  // the count, the dimension is a genuine root of the KF; if not, it doesn't
  // apply (the KF's level is more aggregated). Verdict per KF: identical to the
  // proposed level, or different (which chosen dims don't apply). Advisory only.
  async function analyzeLevels() {
    const srcPa = srcCat.pa
    const byKf = {}
    // ADVISORY check — it must NEVER hang the UI. Counts at a detailed level on a
    // big version can exceed the proxy timeout; with countKf's default retries that
    // froze the button for ~10 min per count. So here: NO retries + short timeout
    // (a failure just marks the KF "unverifiable" in the modal and the user can
    // proceed), all KFs AND all per-dimension counts in PARALLEL, and counting the
    // much smaller NON-ZERO set first (base-filter fallback if rejected).
    const CNT = { retries: 0, timeout: 45000 }
    await Promise.all(steps.map(async s => {
      let conv = s.conv
      if (conv === undefined) { try { conv = await detectConversion(srcConn, srcSession, srcPa, s.srcKf) } catch { conv = null } }
      const convAttr = conv === 'UOM' ? 'UOMTOID' : conv === 'CURR' ? 'CURRTOID' : null
      const convVal  = conv === 'UOM' ? selUom : conv === 'CURR' ? selCurr : null
      let filter = srcVersion ? `VERSIONID eq '${srcVersion}'` : ''
      if (convAttr && convVal) filter += `${filter ? ' and ' : ''}${convAttr} eq '${convVal}'`
      const srcLevelCols = levelAttrs.map(resolveSrcAttr)
      const fixed = convAttr ? [convAttr] : []
      const sel = cols => [...cols, ...fixed, timeField, s.srcKf].join(',')
      const count = (cols, flt) => countKf(srcConn, srcSession, srcPa, { select: sel(cols), filter: flt || undefined, ...CNT })
      try {
        const nz = `(${s.srcKf} gt 0 or ${s.srcKf} lt 0)`
        let flt = filter ? `${filter} and ${nz}` : nz
        let full
        try { full = await count(srcLevelCols, flt) }
        catch { flt = filter; full = await count(srcLevelCols, flt) }   // tenant rejected the KF-value filter
        const dimResults = await Promise.all(levelAttrs.map(async (dstDim, i) => {
          const without = srcLevelCols.filter((_, j) => j !== i)
          const c = await count(without, flt)
          return { dstDim, root: full > c }
        }))
        const extra = dimResults.filter(d => !d.root).map(d => d.dstDim)   // chosen but not a root
        byKf[s.dstKf] = {
          verifiable: true,
          proposed: [...levelAttrs],
          deduced:  dimResults.filter(d => d.root).map(d => d.dstDim),
          extra,
          identical: extra.length === 0,
        }
      } catch (e) {
        byKf[s.dstKf] = { verifiable: false, error: errText(e) }
      }
    }))
    return { byKf }
  }

  async function handleMigrateClick() {
    setAnalyzing(true); setAnalysis(null)
    let result
    try { result = await analyzeLevels() } catch (e) { result = { byKf: {}, error: errText(e) } }
    setAnalysis(result); setAnalyzing(false); setShowConfirm(true)
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
    const dstPa = dstCat.pa, srcPa = srcCat.pa
    const all = []
    const push = r => { all.push(r); setResults([...all]) }

    try {
      let csrf = null
      try { csrf = await fetchCsrf(connection, session, { signal }) } catch { /* proxy fetches per POST */ }

      // Resolve each step's conversion (cached on the step or detected now), then
      // GROUP key figures that share the same conversion (none / UOM / currency).
      // All KF of a group share the planning level, so they are read in ONE source
      // sweep and written in shared POSTs (rows × nKf ≤ 5000) — one transaction per
      // group. This avoids re-reading the (huge) level once per key figure.
      const resolved = []
      for (const s of steps) {
        let conv = s.conv
        if (conv === undefined) { try { conv = await detectConversion(srcConn, srcSession, srcPa, s.srcKf, { signal }) } catch { conv = null } }
        resolved.push({ ...s, conv: conv || null })
      }
      const order = [], groups = {}
      for (const s of resolved) {
        const k = s.conv || 'none'
        if (!groups[k]) { groups[k] = []; order.push(k) }
        groups[k].push(s)
      }

      let done = 0
      for (const gk of order) {
        if (cancelledRef.current) break
        const g = groups[gk]
        const conv = g[0].conv
        const convAttr = conv === 'UOM' ? 'UOMTOID' : conv === 'CURR' ? 'CURRTOID' : null
        const convVal  = conv === 'UOM' ? selUom : conv === 'CURR' ? selCurr : null
        const srcKfs = g.map(s => s.srcKf)
        const dstKfs = g.map(s => s.dstKf)
        const label  = dstKfs.join(', ')

        const srcLevelCols = levelAttrs.map(resolveSrcAttr)
        const dstLevelCols = [...levelAttrs]
        let filter = srcVersion ? `VERSIONID eq '${srcVersion}'` : ''
        if (convAttr) {
          if (!convVal) {
            for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, status: 'error', total: 0, ok: 0, errors: 1, errorMsg: t('kfm.errNoUnit', { kf: s.srcKf }) })
            done += g.length; continue
          }
          filter += `${filter ? ' and ' : ''}${convAttr} eq '${convVal}'`
          srcLevelCols.push(convAttr)
        }
        const srcSelect = [...srcLevelCols, ...srcKfs, timeField].join(',')
        const dstFields = [...dstLevelCols, ...dstKfs, timeField].join(',')

        setProgress({ cur: done + 1, total: steps.length, name: label, rows: 0, totalRows: 0, phase: 'count' })

        try {
          // Source-side NON-ZERO filter: read only rows where ANY group KF is
          // non-zero — positives AND negatives. (`ne 0` is silently ignored by SAP,
          // so we use `gt 0 or lt 0`; verified the OR count = gt0 + lt0.) This reads
          // far less than the whole planning level. Falls back to the base filter if
          // a tenant rejects the KF-value filter; the client-side empty/0/null skip
          // in projectBatch stays as a safety net either way.
          const baseFilter = filter
          const nzClause = '(' + srcKfs.map(kf => `${kf} gt 0 or ${kf} lt 0`).join(' or ') + ')'
          const nzFilter = baseFilter ? `${baseFilter} and ${nzClause}` : nzClause
          let totalRows
          try {
            totalRows = await countKf(srcConn, srcSession, srcPa, { select: srcSelect, filter: nzFilter, signal })
            filter = nzFilter   // adopt for time buckets + reads + measurement below
          } catch {
            totalRows = await countKf(srcConn, srcSession, srcPa, { select: srcSelect, filter: baseFilter || undefined, signal })
          }
          setProgress(p => ({ ...p, totalRows }))

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
          let totalWritten  = 0     // values actually written across all segments
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
                  try { await initiateParallelProcess(connection, session, txId, { planningArea: dstPa, versionId: dstVersion }) } catch { /* best-effort */ }

                  // Read this segment [segStart, segEnd) of the bucket, effParR pages at a time.
                  const segBuf = []
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
                    setProgress(p => ({ ...p, rows: committedRows + segLoaded }))
                    const want = Math.min(readPageSize * effParR, segEnd - pageStart)
                    if (rowsRead.length < want) { reachedEnd = true; break }   // bucket ended within this segment
                  }
                  if (reachedEnd) b.done = true

                  // Write the whole segment as byte-accurate chunks, PARALLEL_W in parallel.
                  if (segBuf.length > 0) {
                    setProgress(p => ({ ...p, phase: 'writing' }))
                    const chunks = chunkByBytes(segBuf, MAX_POST_BYTES, chunkRows)
                    for (let ci = 0; ci < chunks.length; ci += PARALLEL_W) {
                      if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                      await Promise.all(chunks.slice(ci, ci + PARALLEL_W).map(chunk =>
                        postKfChunk(connection, session, dstPa, txId, chunk, { fields: dstFields, versionId: dstVersion, doCommit: false, signal, csrf })
                      ))
                    }
                    segWritten = segBuf.length
                  }

                  // Commit (only if it staged something; an all-empty segment is abandoned).
                  if (segWritten > 0) {
                    setProgress(p => ({ ...p, phase: 'committing' }))
                    await commitTransaction(connection, session, txId, { signal, csrf })
                    segmentTxIds.push(txId)
                    totalWritten += segWritten
                  }
                  committedRows += segLoaded
                  setProgress(p => ({ ...p, rows: committedRows }))
                  break   // segment done; pull the next one
                } catch (e) {
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
          await Promise.all(Array.from({ length: CONCURRENT_SEGMENTS }, () => worker()))

          // Nothing had a value → nothing migrated (and nothing committed).
          if (totalWritten === 0) {
            for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, txId: null, status: 'ok', total: 0, ok: 0, errors: 0 })
            done += g.length
            continue
          }

          // Confirm processing + collect messages across ALL segment transactions.
          setProgress(p => ({ ...p, phase: 'processing' }))
          let anyError = false, anyWarning = false, anyUnconfirmed = false
          const msgs = []
          for (const tx of segmentTxIds) {
            if (cancelledRef.current) break
            const st0 = await waitForProcessed(connection, session, tx, { timeoutMs: Math.min(1800000, Math.max(120000, SEGMENT_SIZE * 3)), signal })
            if (st0 === 'ERROR') anyError = true
            else if (st0 === 'PROCESSED_WITH_ERRORS') anyWarning = true
            else if (st0 !== 'PROCESSED') anyUnconfirmed = true
            const m = await readMessages(connection, session, dstPa, tx, { signal })
            // Count only error/abort messages (E/A). If the tenant's Message set has no
            // Severity field, keep all (preserves prior behaviour) (#5).
            msgs.push(...m.filter(x => x.Severity == null || ['E', 'A'].includes(x.Severity)))
          }
          // Honest status: any ERROR → error; rejections/warnings → warning;
          // unconfirmed → processing; else ok.
          const st = anyError ? 'error'
                   : (msgs.length > 0 || anyWarning) ? 'warning'
                   : anyUnconfirmed ? 'processing' : 'ok'
          // One result row per KF of the group. total = values actually written.
          const lastTx = segmentTxIds[segmentTxIds.length - 1] || null
          for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, txId: lastTx, status: st, total: totalWritten, ok: Math.max(0, totalWritten - msgs.length), errors: msgs.length, messages: msgs })
        } catch (e) {
          if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) {
            for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, status: 'cancelled', total: 0, ok: 0, errors: 0 })
            break
          }
          // A calculated KF in the group fails the whole group's POST; report the
          // offending KF (from "invalid column name") so the user can remove it.
          const msg = e.isCalculated ? t('kfm.errCalculated', { kf: e.calculatedKf || label }) : errText(e)
          for (const s of g) push({ kf: s.dstKf, srcKf: s.srcKf, status: 'error', total: 0, ok: 0, errors: 1, errorMsg: msg })
        }
        done += g.length
      }
    } finally {
      setRunning(false); setProgress(null); setResults(all)
    }
  }, [connection, session, srcConn, srcSession, dstCat, srcCat, steps, levelAttrs, dstVersion, srcVersion, timeField, selUom, selCurr, resolveSrcAttr]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusLabel = s => s === 'ok' ? t('kfm.stOk') : s === 'error' ? t('kfm.stErr') : s === 'warning' ? t('kfm.stWarning') : s === 'processing' ? t('kfm.stProc') : t('kfm.stCancel')
  const statusColor = s => s === 'ok' ? 'var(--green)' : s === 'error' ? 'var(--red)' : s === 'warning' ? 'var(--yellow, #e6a817)' : s === 'processing' ? 'var(--yellow, #e6a817)' : 'var(--text3)'
  const PHASE = { detect: t('kfm.phDetect'), count: t('kfm.phCount'), reading: t('kfm.phReading'), writing: t('kfm.phWriting'), committing: t('kfm.phCommit'), processing: t('kfm.phProcessing'), retrying: t('kfm.phRetrying') }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>{t('kfm.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 20 }}>{t('kfm.subtitle')}</div>

      {/* ── Source / destination ── */}
      <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
        <div style={SECTION_HDR}>{t('kfm.sectionConn')}</div>
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
                {allConns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
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
                      setSteps(p => [...p, { dstKf: k, srcKf: defaultSrcKf(k), conv: undefined }])
                      const sk = defaultSrcKf(k) || k
                      detectConversion(srcConn, srcSession, srcCat.pa, sk)
                        .then(conv => setSteps(p => p.map(s => s.dstKf === k ? { ...s, conv } : s)))
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
                  {/* source KF select */}
                  <select value={s.srcKf} onChange={e => setSteps(p => p.map(x => x.dstKf === s.dstKf ? { ...x, srcKf: e.target.value } : x))}
                    style={{ ...SELECT, flex: 1, minWidth: 0, fontSize: 11, padding: '3px 6px', fontFamily: 'var(--mono)', borderColor: s.srcKf ? 'var(--border)' : 'var(--red)' }}>
                    <option value="">{t('kfm.selectSrcKf')}</option>
                    {[...srcKfSet].sort().map(sk => <option key={sk} value={sk}>{sk}</option>)}
                  </select>
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
                <select style={{ ...SELECT, borderColor: selUom ? 'var(--border)' : 'var(--red)' }} value={selUom} onChange={e => setSelUom(e.target.value)}>
                  <option value="">{t('kfm.selectUom')}</option>
                  {units.map(u => <option key={u.id} value={u.id}>{u.id}{u.desc && u.desc !== u.id ? ` — ${u.desc}` : ''}</option>)}
                </select>
              </div>
            )}
            {needsCurr && (
              <div style={{ flex: 1 }}>
                <label style={LABEL}>{t('kfm.currLabel')}</label>
                <select style={{ ...SELECT, borderColor: selCurr ? 'var(--border)' : 'var(--red)' }} value={selCurr} onChange={e => setSelCurr(e.target.value)}>
                  <option value="">{t('kfm.selectCurr')}</option>
                  {currencies.map(c => <option key={c.id} value={c.id}>{c.id}{c.desc && c.desc !== c.id ? ` — ${c.desc}` : ''}</option>)}
                </select>
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
            <button style={btnPrimary(!canMigrate || analyzing)} disabled={!canMigrate || analyzing} onClick={handleMigrateClick}>{analyzing ? t('kfm.analyzing') : t('kfm.migrateBtn')}</button>
          )}
          {!dstVersion && <span style={{ fontSize: 11, color: 'var(--yellow, #e6a817)' }}>{t('kfm.baseWarning')}</span>}
        </div>
      )}

      {/* ── Progress ── */}
      {running && progress && (
        <div style={{ ...SECTION, background: 'color-mix(in srgb, var(--accent) 5%, var(--bg2))' }}>
          <div style={{ ...SECTION_HDR, marginBottom: 10 }}>{t('kfm.progressTitle', { cur: progress.cur, total: progress.total })}</div>
          <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)', marginBottom: 6 }}>{progress.name} — {PHASE[progress.phase] || ''}</div>
          {progress.totalRows > 0 && (
            <>
              <div style={{ background: 'var(--border)', borderRadius: 4, height: 6, overflow: 'hidden', marginBottom: 4 }}>
                <div style={{ background: 'var(--accent)', height: '100%', width: `${Math.min(100, (progress.rows / progress.totalRows) * 100)}%`, transition: 'width .3s' }} />
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)' }}>{progress.rows.toLocaleString()} / {progress.totalRows.toLocaleString()}</div>
            </>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {!running && results && results.length > 0 && (
        <div style={SECTION}>
          <div style={SECTION_HDR}>{t('kfm.resultsTitle')}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr>
              <th style={TH}>{t('kfm.colKf')}</th><th style={TH}>{t('kfm.colStatus')}</th>
              <th style={TH}>{t('kfm.colTotal')}</th><th style={TH}>{t('kfm.colErrors')}</th><th style={TH}>{t('kfm.colTx')}</th>
            </tr></thead>
            <tbody>
              {results.map(r => (
                <tr key={r.kf}>
                  <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text)' })}>{r.srcKf && r.srcKf !== r.kf ? `${r.srcKf} → ${r.kf}` : r.kf}</td>
                  <td style={td({ fontWeight: 600, color: statusColor(r.status) })}>{statusLabel(r.status)}</td>
                  <td style={td({ color: 'var(--text2)' })}>{(r.total || 0).toLocaleString()}</td>
                  <td style={td({ color: r.errors > 0 ? 'var(--red)' : 'var(--text3)' })}>
                    {r.errors > 0 ? <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 11, fontWeight: 600 }} onClick={() => setExpanded(expanded === r.kf ? null : r.kf)}>{r.errors}</button> : (r.errors || 0)}
                    {r.errorMsg && <div style={{ fontSize: 10, color: 'var(--red)' }}>{r.errorMsg}</div>}
                  </td>
                  <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text3)', fontSize: 10 })}>{r.txId || '—'}</td>
                </tr>
              ))}
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

      {/* ── Pre-migration level confirmation (deduced level vs proposed) ── */}
      {showConfirm && analysis && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--overlay)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 12, padding: 24, width: 580, maxWidth: '92vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>{t('kfm.confirmTitle')}</div>
            {analysis.error ? (
              <div style={{ fontSize: 12, color: 'var(--red)' }}>✕ {analysis.error}</div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>{t('kfm.confirmIntro')}</div>
                <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {steps.map(s => {
                    const a = analysis.byKf[s.dstKf] || {}
                    return (
                      <div key={s.dstKf} style={{ border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px', background: 'var(--bg)' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text)', marginBottom: 4 }}>
                          {s.srcKf && s.srcKf !== s.dstKf ? `${s.srcKf} → ${s.dstKf}` : s.dstKf}
                        </div>
                        {!a.verifiable ? (
                          <div style={{ fontSize: 11, color: 'var(--yellow, #e6a817)' }}>⚠ {t('kfm.levelUnverifiable')}</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
                            <div style={{ color: 'var(--text2)' }}>{t('kfm.proposedLevel')}: <span style={{ fontFamily: 'var(--mono)' }}>{levelStr(a.proposed)}</span></div>
                            <div style={{ color: 'var(--text2)' }}>{t('kfm.deducedLevel')}: <span style={{ fontFamily: 'var(--mono)' }}>{levelStr(a.deduced)}</span></div>
                            {a.identical
                              ? <div style={{ color: 'var(--green)' }}>✓ {t('kfm.levelIdentical')}</div>
                              : <div style={{ color: 'var(--yellow, #e6a817)' }}>⚠ {t('kfm.levelDiffers', { dims: a.extra.join(', ') })}</div>}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={BTN_SEC} onClick={() => setShowConfirm(false)}>{t('kfm.confirmCancel')}</button>
              <button style={btnPrimary(false)} onClick={runMigration}>{t('kfm.confirmMigrate')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
