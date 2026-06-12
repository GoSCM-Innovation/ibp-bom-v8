import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useIsMobile } from '../../hooks/useIsMobile'
import { getAll } from '../../services/connectionStorage'
import { getSession, setSession } from '../../services/sessionStorage'
import {
  fetchVsmt, buildCatalog, fetchImportableMdts,
  invalidateVsmtCache, invalidateImportableCache,
  fetchCount, readEntityPage, readKeyRows, fetchFieldNames, fetchKeyNames, fetchCsrf,
  getTransactionId, initiateParallelProcess, postTransChunk,
  commitTransaction, waitForProcessed, readMessages,
  PAGE_SIZE, PARALLEL_R, PARALLEL_W, BASE_VERSION_ID, READONLY_FIELDS,
  pageSizeFor, measureRowBytes, pageSizeForBytes,
  chunkByBytes, MAX_POST_BYTES, fetchDistinctValues,
} from '../../services/masterDataApi'
import { setMigrationGuard } from '../../services/migrationGuard'
import { buildConditionFilter, condChip } from '../../services/filterUtils'
import { MultiValueSelect, SearchSelect } from './FilterControls'
import {
  MASTER_MAX_WARN as MAX_ROWS_WARN, MASTER_MAX_HARD as MAX_ROWS_HARD, isLocalRun,
} from '../../config/migrationLimits'

// ── History persistence ───────────────────────────────────────────────────────

const HIST_KEY = id => `ibp:migrations:${id}`

function loadHistory(connId) {
  try { return JSON.parse(localStorage.getItem(HIST_KEY(connId))) || [] } catch { return [] }
}
function saveHistory(connId, entries) {
  try { localStorage.setItem(HIST_KEY(connId), JSON.stringify(entries.slice(0, 50))) } catch {}
}

// ── Catalog helpers ───────────────────────────────────────────────────────────

function getPas(catalog) {
  if (!catalog) return []
  return Object.entries(catalog)
    .map(([id, { desc }]) => ({ id, desc }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function getVersions(catalog, pa) {
  if (!catalog || !pa) return []
  return catalog[pa]?.versions || []
}

// When version is '' → __BASE: return union of all MDTs for that PA
function getMdts(catalog, pa, version) {
  if (!catalog || !pa) return []
  const paEntry = catalog[pa]
  if (!paEntry) return []
  if (!version) {
    const all = new Set()
    paEntry.versions.forEach(v => v.mdts.forEach(m => all.add(m)))
    return [...all].sort()
  }
  const vEntry = paEntry.versions.find(v => v.id === version)
  return vEntry ? [...vEntry.mdts].sort() : []
}

// ── Table pairing (root match) ──────────────────────────────────────────────
// Tables can be named differently across systems (e.g. AS1PRODUCT vs AS4PRODUCT).
// We "share a root" if, after trimming a short area prefix (0–4 chars) from each
// name, the remainder matches exactly and is long enough (>= 4) to be meaningful.

// Rows per COMMITTED segment. The table is loaded in segments of this size, each
// committed before the next — so a transient failure only re-does the CURRENT
// segment (in a fresh transaction), never the whole table, and already-committed
// segments are kept. Smaller = more durable but more commits.
const SEGMENT_SIZE = 20000
// Max attempts PER SEGMENT. A failed attempt abandons its uncommitted transaction
// (SAP discards it) and re-stages that segment, so retries never duplicate keys
// within a committed transaction. Higher than before because each retry is now
// cheap (one segment, not the whole table).
const MAX_SEGMENT_ATTEMPTS = 5
// How many segments to process CONCURRENTLY. Segments are independent transactions
// (distinct key ranges), so K workers run in parallel: while one writes, another
// reads → reads overlap writes and POSTs run concurrently across transactions. A
// live ceiling test showed throughput scaling linearly with no errors up to ~20
// concurrent POSTs. Measured end-to-end (read+write+commit) over 240k rows with 0
// errors: K=4 → 821 rows/s, K=6 → 1505 rows/s (~18 min for 1.6M). 6 hits the target.
const CONCURRENT_SEGMENTS = 6

// ── Guardabarrera de volumen ──
// El conteo viene del pre-vuelo ($count en analyzeFields), así que NO hay round-trip extra.
//   · suma de la corrida > MAX_ROWS_HARD  → CORRIDA bloqueada (no se transfiere nada).
//   · tabla individual > MAX_ROWS_HARD     → tabla omitida.
//   · MAX_ROWS_WARN..HARD                  → procede, marcado en el modal para confirmación.
// Topes (MAX_ROWS_WARN/HARD) e isLocalRun vienen de config/migrationLimits.js. En LOCAL
// (localhost) isLocalRun()=true y los topes NO aplican: ahí se migra sin límite.

const MIN_ROOT_LEN = 4
function rootCandidates(name) {
  const out = []
  for (let k = 0; k <= 4 && name.length - k >= MIN_ROOT_LEN; k++) out.push(name.slice(k))
  return out
}

// Suggests the best destination name for a source table among the candidates:
// exact name wins; otherwise the candidate sharing the longest root. null if none.
function suggestDstName(src, candidates) {
  if (candidates.includes(src)) return src
  const srcRoots = new Set(rootCandidates(src))
  let best = null, bestLen = 0
  for (const d of candidates) {
    if (d === src) return src
    for (const r of rootCandidates(d)) {
      if (srcRoots.has(r) && r.length > bestLen) { best = d; bestLen = r.length }
    }
  }
  return best
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SECTION = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: 10, padding: '16px 20px', marginBottom: 16,
}
const SECTION_HDR = {
  fontSize: 11, fontWeight: 700, color: 'var(--accent)',
  textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 14,
}
const LABEL = {
  fontSize: 10, fontWeight: 700, color: 'var(--text2)',
  textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5, display: 'block',
}
const SELECT = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text)', fontSize: 12, padding: '7px 10px', width: '100%', outline: 'none',
}
const INPUT = { ...SELECT }
const BTN_SEC = {
  background: 'none', border: '1px solid var(--border2)', borderRadius: 6,
  color: 'var(--text2)', fontSize: 12, fontWeight: 600, padding: '7px 14px', cursor: 'pointer',
}
const BTN_DANGER = {
  background: 'none', border: '1px solid var(--red)', borderRadius: 6,
  color: 'var(--red)', fontSize: 12, fontWeight: 600, padding: '7px 14px', cursor: 'pointer',
}
function btnPrimary(disabled) {
  return {
    background: disabled ? 'var(--border2)' : 'var(--accent)', border: 'none', borderRadius: 6,
    color: disabled ? 'var(--text3)' : 'var(--text-on-accent)', fontSize: 12, fontWeight: 700,
    padding: '7px 18px', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background .15s',
  }
}
const TH = {
  textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)',
  color: 'var(--text2)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em',
}
function td(extra) {
  return { padding: '6px 8px', borderBottom: '1px solid var(--border)', ...extra }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extracts a readable message from anything thrown, never returning "[object Object]".
function errText(e) {
  if (e == null) return 'Error desconocido'
  if (typeof e === 'string') return e
  const m = e.message
  if (typeof m === 'string' && m && m !== '[object Object]') return m
  try { const s = JSON.stringify(e); if (s && s !== '{}') return s } catch { /* ignore */ }
  return String(e)
}

// Converts OData v2 date strings like /Date(1764247462000+0000)/ to locale format.
function formatCell(val) {
  if (typeof val !== 'string') return val ?? ''
  const m = val.match(/^\/Date\((\d+)([+-]\d{4})?\)\/$/)
  if (m) return new Date(parseInt(m[1], 10)).toLocaleString()
  return val
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

// Phases shown in the per-table breakdown, in execution order.
const TIMED_PHASES = ['reading', 'deleting', 'writing', 'committing', 'processing', 'messages', 'retrying']

// ── Component ─────────────────────────────────────────────────────────────────

export default function Migration({ connection, session }) {
  const { t }      = useI18n()
  const isMobile   = useIsMobile()

  // Refresh trigger — increment to force allConns/connById to re-read localStorage
  const [connsTick, setConnsTick] = useState(0)
  // Catalog refresh trigger — increment to force the VSMT/importable catalogs to
  // re-fetch from SAP (after invalidating their caches). Decoupled from connsTick
  // so "↺ Actualizar" can also recover from a stale/empty catalog cache.
  const [catalogTick, setCatalogTick] = useState(0)

  // Source candidates: OTHER connections with SAP_COM_0720, plus THIS connection
  // itself (listed first) — to migrate between areas/versions of the same system.
  const allConns = useMemo(() => {
    const others = getAll().filter(c => c.id !== connection.id && c.com0720?.url && c.com0720?.user)
    const self   = (connection.com0720?.url && connection.com0720?.user) ? [connection] : []
    return [...self, ...others]
  }, [connection, connsTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // All connections by ID — for resolving names in history even after rename
  const connById = useMemo(() => {
    const m = {}
    getAll().forEach(c => { m[c.id] = c })
    return m
  }, [connsTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Source state ──
  const [srcConnId, setSrcConnId]     = useState(null)
  const [srcTempCreds, setSrcTempCreds] = useState(null) // { user, password } entered via inline form
  const [srcLoginForm, setSrcLoginForm] = useState({ user: '', password: '' })
  const [srcLoginLoading, setSrcLoginLoading] = useState(false)
  const [srcLoginError, setSrcLoginError]     = useState('')

  const srcConn = useMemo(() => allConns.find(c => c.id === srcConnId) || null, [allConns, srcConnId])

  const srcSession = useMemo(() => {
    if (!srcConnId) return null
    if (srcConnId === connection.id) return session   // same system → reuse the active session (no extra login)
    const stored   = getSession(srcConnId)
    const com0720  = srcTempCreds || stored?.com0720
    if (!com0720?.password) return null
    return { ...(stored || {}), com0720 }
  }, [srcConnId, srcTempCreds, connection.id, session])

  const needsSrcLogin = !!(srcConn && !srcSession)

  // ── Catalog state ──
  const [srcCatalog, setSrcCatalog]   = useState(null)
  const [dstCatalog, setDstCatalog]   = useState(null)
  const [dstLoading, setDstLoading]   = useState(false)
  const [srcLoading, setSrcLoading]   = useState(false)
  const [catalogError, setCatalogError] = useState('')

  // Set of MDTs importable into the destination (those exposing a <MDT>Trans
  // entity set). null = not loaded yet → no filtering applied (safe fallback).
  const [importableSet, setImportableSet] = useState(null)

  // ── PA / Version selectors ──
  const [srcPa, setSrcPa]         = useState('')
  const [srcVersion, setSrcVersion] = useState('')
  const [dstPa, setDstPa]         = useState('')
  const [dstVersion, setDstVersion] = useState('')

  // ── MDT selection & order ──
  const [mdtSearch, setMdtSearch] = useState('')
  const [mdtOrder, setMdtOrder]   = useState([])   // ordered array of SOURCE mdt names
  // Source→destination table mapping for tables named differently across systems
  // (e.g. AS1PRODUCT → AS4PRODUCT). Auto-filled with the root-match suggestion on
  // selection; editable per row. Resolution goes through resolveDst (declared below).
  const [mdtMapping, setMdtMapping] = useState({})  // { [srcName]: dstName }

  // ── Drag-and-drop (order panel) ──
  const dragId  = useRef(null)
  const [dragOver, setDragOver] = useState(null)

  // ── Per-MDT source filters (selective migration) ──
  // { [srcMdt]: [{ field, op: 'in'|'sw', value: 'A,B' }] } — applied to the SOURCE
  // read only (count + measurement + pages); the destination is untouched by them.
  const [mdtFilters, setMdtFilters]     = useState({})
  const [filterOpen, setFilterOpen]     = useState(null)   // srcMdt with the editor expanded
  const [mdtFieldOpts, setMdtFieldOpts] = useState({})     // { [srcMdt]: string[] | 'loading' | 'error' }
  const [filterTest, setFilterTest]     = useState({})     // { [srcMdt]: { loading?, n?, total?, error? } }

  // ── Options ──
  // Off by default: the delete pass re-reads ALL destination keys and re-POSTs
  // them as deletions before loading, which doubles the migration's data transfer.
  // Opt in explicitly when a full replace is actually needed.
  const [deleteEntries, setDeleteEntries] = useState(false)
  const [txNameLoad, setTxNameLoad] = useState('IBP-ControlTower-MD')   // SAP transaction label for the load
  const [txNameDel, setTxNameDel]   = useState('IBP-ControlTower-DEL')  // SAP transaction label for the delete pass

  // ── Run state ──
  const cancelledRef          = useRef(false)
  const abortRef              = useRef(null)    // AbortController for the active run (cuts requests in flight)
  const lastProgressUpdateRef = useRef(0)       // throttle: ms timestamp of last row-count update
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults]   = useState(null)

  // ── Error detail expand ──
  const [expandedMdt, setExpandedMdt] = useState(null)
  // ── Phase-timing detail expand (per result row) ──
  const [expandedTimeMdt, setExpandedTimeMdt] = useState(null)

  // ── Live elapsed clock (ticks once per second while a run is active) ──
  const runStartRef = useRef(0)
  const [runElapsed, setRunElapsed] = useState(0)

  // ── Preview ──
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewData, setPreviewData]       = useState(null)

  // ── Pre-migration confirmation (field analysis + production warning) ──
  const [showConfirm, setShowConfirm] = useState(false)
  const [analyzing, setAnalyzing]     = useState(false)
  const [analysis, setAnalysis]       = useState(null)   // { byMdt, hasConflicts, error } for the modal
  const analysisRef                   = useRef(null)      // common-fields map consumed by runMigration

  // ── Cancel confirmation (mid-run) ──
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // ── History ──
  const [history, setHistory]         = useState(() => loadHistory(connection.id))
  const [showHistory, setShowHistory] = useState(false)

  // ── Load destination catalog on mount ──
  useEffect(() => {
    let alive = true
    setDstLoading(true)
    setCatalogError('')
    fetchVsmt(connection, session)
      .then(rows => { if (alive) setDstCatalog(buildCatalog(rows)) })
      .catch(e   => { if (alive) setCatalogError(t('mig.catalogError', { msg: e.message })) })
      .finally(  () => { if (alive) setDstLoading(false) })
    return () => { alive = false }
  }, [connection.id, session?.com0720?.user, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load importable-MDT set for the destination (best-effort) ──
  // Reference/virtual MDTs (no <MDT>Trans) are excluded from the selection list.
  // On failure we leave importableSet null → no filtering, so the tab still works.
  useEffect(() => {
    let alive = true
    setImportableSet(null)
    fetchImportableMdts(connection, session)
      .then(set => { if (alive) setImportableSet(set) })
      .catch(()  => { if (alive) setImportableSet(null) })
    return () => { alive = false }
  }, [connection.id, session?.com0720?.user, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Leave guard: warn before navigating away while a migration is running ──
  // Tells the navigation guard (consulted by SystemView/App) that leaving will
  // cancel the run. Also blocks browser reload/close via beforeunload.
  useEffect(() => {
    setMigrationGuard(running, t('mig.leaveWarning'))
    return () => setMigrationGuard(false)
  }, [running, t])

  useEffect(() => {
    if (!running) return
    const handler = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [running])

  // On unmount (e.g. user confirmed leaving the tab/connection), abort the run.
  useEffect(() => () => { cancelledRef.current = true; abortRef.current?.abort() }, [])

  // Tick the live elapsed clock every second while running.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setRunElapsed(Date.now() - runStartRef.current), 1000)
    return () => clearInterval(id)
  }, [running])

  // ── Load source catalog when source + session become available ──
  useEffect(() => {
    if (!srcConn || !srcSession) { setSrcCatalog(null); return }
    let alive = true
    setSrcLoading(true)
    setCatalogError('')
    fetchVsmt(srcConn, srcSession)
      .then(rows => { if (alive) setSrcCatalog(buildCatalog(rows)) })
      .catch(e   => { if (alive) setCatalogError(t('mig.catalogError', { msg: e.message })) })
      .finally(  () => { if (alive) setSrcLoading(false) })
    return () => { alive = false }
  }, [srcConnId, srcTempCreds?.user, catalogTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset selectors when catalogs change
  useEffect(() => { setSrcPa(''); setSrcVersion(''); setMdtOrder([]); setMdtMapping({}) }, [srcCatalog])
  useEffect(() => { setDstPa(''); setDstVersion(''); setMdtOrder([]); setMdtMapping({}) }, [dstCatalog])
  useEffect(() => { setMdtOrder([]); setMdtMapping({}) }, [srcPa, srcVersion, dstPa, dstVersion])
  // Filters are per source table: drop them whenever the selection context changes.
  useEffect(() => { setMdtFilters({}); setFilterOpen(null); setMdtFieldOpts({}); setFilterTest({}) },
    [srcCatalog, dstCatalog, srcPa, srcVersion, dstPa, dstVersion])

  // The effective OData fragment per selected MDT ('' when no complete condition).
  const mdtExtraFilter = useCallback(mdt => buildConditionFilter(mdtFilters[mdt]), [mdtFilters])
  const hasAnyFilter = useMemo(() => mdtOrder.some(m => mdtExtraFilter(m)), [mdtOrder, mdtExtraFilter])

  // Filters + full-replace is dangerous (the delete clears EVERYTHING, the load
  // restores only the filtered rows): auto-uncheck "delete destination" the moment
  // filters become active. The user may re-check it — the confirm modal warns in red.
  const prevHadFilterRef = useRef(false)
  useEffect(() => {
    if (hasAnyFilter && !prevHadFilterRef.current) setDeleteEntries(false)
    prevHadFilterRef.current = hasAnyFilter
  }, [hasAnyFilter])

  // ── Available MDTs ──
  const srcMdts = useMemo(() => getMdts(srcCatalog, srcPa, srcVersion), [srcCatalog, srcPa, srcVersion])
  const dstMdts = useMemo(() => getMdts(dstCatalog, dstPa, dstVersion), [dstCatalog, dstPa, dstVersion])

  // Importable destination tables present in the chosen destination area/version.
  // These are the candidates a source table can be paired to.
  const dstCandidates = useMemo(() =>
    importableSet ? dstMdts.filter(m => importableSet.has(m)) : [...dstMdts],
    [dstMdts, importableSet]
  )

  // Source tables that have a destination match (exact name or by root). A source
  // table with no importable counterpart in the destination is hidden.
  const availableMdts = useMemo(() => {
    if (!srcPa || !dstPa) return []
    return srcMdts.filter(src => suggestDstName(src, dstCandidates) != null).sort()
  }, [srcMdts, dstCandidates, srcPa, dstPa])

  // Resolves the destination table for a source: user override → suggestion → self.
  const resolveDst = useCallback(
    src => mdtMapping[src] || suggestDstName(src, dstCandidates) || src,
    [mdtMapping, dstCandidates]
  )

  const filteredMdts = useMemo(() =>
    availableMdts.filter(m => !mdtSearch || m.toLowerCase().includes(mdtSearch.toLowerCase())),
    [availableMdts, mdtSearch]
  )

  // Selected MDTs whose DESTINATION table is NOT version-specific in the chosen
  // version's VSMT. SAP IBP writes these to the base version regardless.
  const nonVersionMdts = useMemo(() => {
    if (!dstVersion) return []
    const dstSet = new Set(dstMdts)
    return mdtOrder.filter(src => !dstSet.has(resolveDst(src)))
  }, [dstVersion, dstMdts, mdtOrder, resolveDst])

  // ── Source inline login ──
  async function handleSrcLogin(e) {
    e.preventDefault()
    if (!srcLoginForm.user)     { setSrcLoginError(t('login.errUserRequired', { name: 'SAP_COM_0720' })); return }
    if (!srcLoginForm.password) { setSrcLoginError(t('login.errPwdRequired',  { name: 'SAP_COM_0720' })); return }
    setSrcLoginLoading(true)
    setSrcLoginError('')
    try {
      const serviceRoot = srcConn.com0720.url
      // Use a lightweight endpoint — MASTER_DATA_API_SRV/$metadata is ~4.8 MB
      // and exceeds Vercel's serverless response limit causing a silent hang.
      const resp = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: serviceRoot + '/VersionSpecificMasterDataTypes?$format=json&$top=0',
          serviceRoot,
          user: srcLoginForm.user,
          password: srcLoginForm.password,
          method: 'GET',
        }),
      })
      if (resp.status === 401) { setSrcLoginError(t('mig.srcLoginErr401')); return }
      if (!resp.ok)            { setSrcLoginError(t('mig.srcLoginErrNetwork')); return }
      const creds = { user: srcLoginForm.user, password: srcLoginForm.password }
      setSrcTempCreds(creds)
      // Persist so re-opening the tab doesn't require re-login
      const existing = getSession(srcConnId) || {}
      setSession(srcConnId, { ...existing, com0720: creds })
    } catch {
      setSrcLoginError(t('mig.srcLoginErrNetwork'))
    } finally {
      setSrcLoginLoading(false)
    }
  }

  // ── Preview ──
  async function handlePreview(mdtName) {
    if (!srcConn || !srcSession) return
    setPreviewLoading(true)
    setPreviewData(null)
    try {
      const [count, rows] = await Promise.all([
        fetchCount(srcConn, srcSession, mdtName, { planningArea: srcPa, versionId: srcVersion }),
        readEntityPage(srcConn, srcSession, mdtName, { skip: 0, top: 100, planningArea: srcPa, versionId: srcVersion }),
      ])
      setPreviewData({ name: mdtName, count, rows })
    } catch (e) {
      setPreviewData({ name: mdtName, count: 0, rows: [], error: e.message })
    } finally {
      setPreviewLoading(false)
    }
  }

  // ── Per-MDT filter editor ──
  // Opens/closes the inline editor; field names are read once per table (a 1-row
  // sample of the SOURCE) and cached in state for the session.
  function handleToggleFilter(mdt) {
    const opening = filterOpen !== mdt
    setFilterOpen(opening ? mdt : null)
    if (!opening) return
    // Seed an empty condition so the editor opens ready to use.
    if (!(mdtFilters[mdt] || []).length) setMdtFilters(p => ({ ...p, [mdt]: [{ field: '', op: 'in', value: '' }] }))
    if (mdtFieldOpts[mdt]) return
    setMdtFieldOpts(p => ({ ...p, [mdt]: 'loading' }))
    fetchFieldNames(srcConn, srcSession, mdt, { planningArea: srcPa, versionId: '' })
      .then(fields => setMdtFieldOpts(p => ({ ...p, [mdt]: (fields || []).filter(f => !READONLY_FIELDS.has(f)).sort() })))
      .catch(() => setMdtFieldOpts(p => ({ ...p, [mdt]: 'error' })))
  }

  // Counts how many SOURCE records match the filter (vs the unfiltered total) so
  // the user validates the filter BEFORE migrating.
  async function handleTestFilter(mdt) {
    const extra = mdtExtraFilter(mdt)
    setFilterTest(p => ({ ...p, [mdt]: { loading: true } }))
    try {
      const [n, total] = await Promise.all([
        fetchCount(srcConn, srcSession, mdt, { planningArea: srcPa, versionId: srcVersion, extraFilter: extra || undefined, retries: 1, timeout: 60000 }),
        fetchCount(srcConn, srcSession, mdt, { planningArea: srcPa, versionId: srcVersion, retries: 1, timeout: 60000 }),
      ])
      setFilterTest(p => ({ ...p, [mdt]: { n, total } }))
    } catch (e) {
      setFilterTest(p => ({ ...p, [mdt]: { error: errText(e) } }))
    }
  }

  // ── Migration ──
  // Compares source vs destination fields per MDT (one sample row each) so we can
  // send only the common fields (avoids HTTP 400) and show the user what differs.
  async function analyzeFields() {
    const clean = arr => (arr ? arr.filter(f => !READONLY_FIELDS.has(f)) : null)
    const byMdt = {}
    for (const srcName of mdtOrder) {
      const dstName = resolveDst(srcName)
      // Pre-flight row count (SOURCE, with the table's migration filter applied) — drives
      // the volume guardrail AND is reused as totalRows in runMigration (no extra $count).
      // null = count couldn't be obtained → runMigration falls back to its own count.
      let count = null
      try {
        count = await fetchCount(srcConn, srcSession, srcName, {
          planningArea: srcPa, versionId: srcVersion,
          extraFilter: mdtExtraFilter(srcName) || undefined, retries: 1, timeout: 60000,
        })
      } catch { /* count unknown */ }
      let srcFields = null, dstFields = null
      // The column schema is version-independent, so read the sample WITHOUT the
      // version filter — a version-filtered read can be pathologically slow on some
      // tenants (measured 60+ s) and would time out, breaking the projection.
      try { srcFields = await fetchFieldNames(srcConn, srcSession, srcName, { planningArea: srcPa, versionId: '' }) } catch { /* ignore */ }
      try { dstFields = await fetchFieldNames(connection, session, dstName, { planningArea: dstPa, versionId: '' }) } catch { /* ignore */ }
      const s = clean(srcFields), d = clean(dstFields)
      if (!s || !d) {
        // Couldn't infer schema on one side (empty entity) → send all source fields.
        byMdt[srcName] = { verifiable: false, common: null, omitted: [], unfilled: [], count }
        continue
      }
      const dSet = new Set(d), sSet = new Set(s)
      byMdt[srcName] = {
        verifiable: true,
        common:   s.filter(f => dSet.has(f)),
        omitted:  s.filter(f => !dSet.has(f)),   // only in source → dropped
        unfilled: d.filter(f => !sSet.has(f)),   // only in destination → left empty
        count,
      }
    }
    const hasConflicts = Object.values(byMdt).some(
      x => !x.verifiable || x.omitted.length > 0 || x.unfilled.length > 0
    )
    return { byMdt, hasConflicts }
  }

  async function handleMigrateClick() {
    setAnalyzing(true)
    setAnalysis(null)
    let result
    try {
      result = await analyzeFields()
    } catch (e) {
      result = { byMdt: {}, hasConflicts: false, error: e.message }
    }
    analysisRef.current = result
    setAnalysis(result)
    setAnalyzing(false)
    setShowConfirm(true)   // modal shows field diffs (+ production warning if applicable)
  }

  // Projects a row down to the agreed common fields for the MDT (when verifiable).
  function projectRow(mdt, row) {
    const entry = analysisRef.current?.byMdt?.[mdt]
    if (!entry || !entry.common) return row   // fallback: send all fields
    const out = {}
    for (const k of entry.common) if (k in row) out[k] = row[k]
    return out
  }

  const runMigration = useCallback(async () => {
    setShowConfirm(false)
    setRunning(true)
    setResults([])
    cancelledRef.current = false
    abortRef.current = new AbortController()
    const signal = abortRef.current.signal
    runStartRef.current = Date.now()
    setRunElapsed(0)

    const mdtList = [...mdtOrder]
    const allResults = []
    // Publish results live so completed tables stay visible during the run.
    const pushResult = r => { allResults.push(r); setResults([...allResults]) }

    // Guardabarrera por CORRIDA: suma de filas de todas las tablas seleccionadas.
    // En local (isLocalRun) no aplica. Bloquea ANTES de transferir nada.
    const runTotal = mdtList.reduce((s, m) => s + (analysisRef.current?.byMdt?.[m]?.count || 0), 0)
    if (!isLocalRun() && runTotal > MAX_ROWS_HARD) {
      setResults([{ mdt: '—', dstName: '—', unverified: false, status: 'skipped', total: 0, ok: 0, errors: 0, txId: null, errorMsg: t('mig.limitRunBlocked', { max: MAX_ROWS_HARD.toLocaleString(), n: runTotal.toLocaleString() }), phaseTimes: {}, durationMs: 0 }])
      setRunning(false)
      return
    }

    try {
      for (let di = 0; di < mdtList.length; di++) {
        if (cancelledRef.current) break
        const srcName = mdtList[di]
        const dstName = resolveDst(srcName)
        const label   = srcName === dstName ? srcName : `${srcName} → ${dstName}`
        // Destination schema couldn't be verified → fields were not projected (all sent).
        const entry = analysisRef.current?.byMdt?.[srcName]
        const unverified = entry?.verifiable === false
        // When the schema is verifiable we read only the fields we'll actually
        // import (the common fields) via $select — smaller payloads, bigger pages.
        // Unverifiable → selectFields null → read all columns (current behaviour).
        const selectFields = (entry?.common && entry.common.length) ? entry.common : null
        // Selective migration: user-defined record filter, applied to every SOURCE
        // read of this table (count, sizing sample, pages). Destination reads/deletes
        // are deliberately NOT filtered.
        const extraFilter = mdtExtraFilter(srcName) || undefined
        // With $select we download only the common fields, so size the page by those;
        // without it (unverifiable) we download every column (common + omitted).
        const readFields  = selectFields ? selectFields.length : ((entry?.common?.length || 0) + (entry?.omitted?.length || 0))
        // Field-count estimate — only a FALLBACK if the live measurement (below)
        // fails. (Write chunks don't need sizing here: they are built byte-accurate
        // at write time via chunkByBytes.)
        let readPage = pageSizeFor(readFields || 60)

        // Per-table timing: `tableStart` gives the WALL total; `phaseAcc` accumulates
        // ms per phase, summed across the concurrent workers (each worker times its
        // own reads/writes/commits — a shared single-cursor timer would get corrupted
        // by 6 workers marking phases at once).
        const tableStart = Date.now()
        const phaseAcc = {}
        const addPhase = (k, ms) => { phaseAcc[k] = (phaseAcc[k] || 0) + ms }
        setProgress({ datasetCur: di + 1, datasetTotal: mdtList.length, datasetName: label, rows: 0, totalRows: 0, phase: 'reading', tableStart, segsDone: 0, totalSegs: 0 })

        let totalRows = 0
        let loadedRows = 0   // rows actually read from source AND staged (sent to IBP)
        let dstBefore = null

        try {
          // Reuse the pre-flight count from analyzeFields when available (no extra $count);
          // otherwise count here. Bounded (1 retry, 60 s) — fails fast instead of ~8 min.
          const preCount = analysisRef.current?.byMdt?.[srcName]?.count
          if (typeof preCount === 'number') {
            totalRows = preCount
          } else {
            const t0 = Date.now()
            try {
              totalRows = await fetchCount(srcConn, srcSession, srcName, { planningArea: srcPa, versionId: srcVersion, extraFilter, signal, retries: 1, timeout: 60000 })
            } finally { addPhase('reading', Date.now() - t0) }
          }
        } catch (e) {
          pushResult({ mdt: srcName, dstName, unverified, status: 'error', total: 0, ok: 0, errors: 1, txId: null, errorMsg: errText(e), phaseTimes: { ...phaseAcc }, durationMs: Date.now() - tableStart })
          continue
        }

        // Volume guardrail: a table over the hard cap is BLOCKED — never transferred.
        // (Tables in the WARN..HARD band were already surfaced for confirmation in the modal.)
        if (!isLocalRun() && totalRows > MAX_ROWS_HARD) {
          pushResult({ mdt: srcName, dstName, unverified, status: 'skipped', total: 0, ok: 0, errors: 0, txId: null, errorMsg: t('mig.limitBlockedMsg', { max: MAX_ROWS_HARD.toLocaleString(), n: totalRows.toLocaleString() }), phaseTimes: { ...phaseAcc }, durationMs: Date.now() - tableStart })
          continue
        }

        // Count destination rows in the TARGET version BEFORE writing (verification baseline).
        try {
          dstBefore = await fetchCount(connection, session, dstName, { planningArea: dstPa, versionId: dstVersion || BASE_VERSION_ID, signal })
        } catch { /* ignore */ }

        // Size batches by MEASURED bytes/row (a small live sample), not by column
        // count. Crucial for value-heavy tables: a column-count estimate picked
        // read pages/POST bodies far larger than reality → read truncation and POST
        // bodies over Vercel's ~4.5 MB limit (413, non-retryable → table fails).
        if (totalRows > 0) {
          try {
            const m = await measureRowBytes(srcConn, srcSession, srcName, { select: selectFields, planningArea: srcPa, versionId: srcVersion, extraFilter, signal })
            if (m) readPage = pageSizeForBytes(m.readBpr)
          } catch { /* keep field-count fallback */ }
        }

        let segmentTxIds = []   // committed transactions (one per segment) — declared here so the catch can report the last one
        try {
          // Obtain a CSRF token once and reuse it across all POSTs of this table
          // (delete + load + commit) — avoids the proxy re-fetching it per POST.
          let csrf = null
          try { csrf = await fetchCsrf(connection, session, { signal }) } catch { /* proxy will fetch per POST */ }

          // ── Replace mode: clear destination in COMMITTED SEGMENTS ──
          // SAP forbids mixing DeleteEntries true/false in one transaction, so the
          // delete runs as separate committed transactions BEFORE the load. Like the
          // load it is now segmented + retried per segment (a single 500 no longer
          // dooms the whole delete) and posts byte-accurate chunks in parallel. We
          // delete by EXPLICIT keys (a snapshot), so committing segments mid-way can
          // never shift a $skip window. ALL deletes must finish processing before the
          // load — otherwise a re-added (upserted) key could be removed by a still-
          // pending delete.
          if (deleteEntries) {
            const tDel = Date.now()
            setProgress(p => ({ ...p, phase: 'deleting' }))
            const { keyNames, rows: keyRows } = await readKeyRows(connection, session, dstName, { planningArea: dstPa, versionId: dstVersion, signal })
            if (keyRows.length > 0 && keyNames.length > 0) {
              const delTxIds = []
              for (let ds = 0; ds < keyRows.length; ds += SEGMENT_SIZE) {
                const segKeys = keyRows.slice(ds, ds + SEGMENT_SIZE)
                for (let attempt = 1; ; attempt++) {
                  if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                  try {
                    // Pass the raw dstVersion ('' = base): an empty version makes
                    // the write helpers omit PlanningArea + VersionID (base mode).
                    const txDel = await getTransactionId(connection, session, {
                      versionId: dstVersion,
                      masterDataTypeId: dstName, planningArea: dstPa, signal,
                    })
                    // TransactionName MUST go here — GetTransactionID ignores it (no params in $metadata).
                    try { await initiateParallelProcess(connection, session, txDel, { planningArea: dstPa, versionId: dstVersion, masterDataTypeId: dstName, transactionName: txNameDel.trim() || 'IBP-ControlTower-DEL', signal }) } catch { /* ignore */ }
                    const delChunks = chunkByBytes(segKeys, MAX_POST_BYTES, 5000)
                    for (let ci = 0; ci < delChunks.length; ci += PARALLEL_W) {
                      if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                      await Promise.all(delChunks.slice(ci, ci + PARALLEL_W).map(chunk =>
                        postTransChunk(connection, session, dstName, txDel, chunk, {
                          deleteEntries: true, planningArea: dstPa, versionId: dstVersion, signal, csrf,
                        })))
                    }
                    await commitTransaction(connection, session, txDel, { signal, csrf })
                    delTxIds.push(txDel)
                    break
                  } catch (e) {
                    if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) throw e
                    if (e?.status === 403) { try { csrf = await fetchCsrf(connection, session, { signal }) } catch { /* ignore */ } }
                    const transient = e?.status === 403 || e?.status == null || e.status >= 500
                    if (transient && attempt < MAX_SEGMENT_ATTEMPTS) { await new Promise(r => setTimeout(r, 1500 * attempt)); continue }
                    throw e
                  }
                }
              }
              for (const tx of delTxIds) {
                if (cancelledRef.current) break
                await waitForProcessed(connection, session, tx, { timeoutMs: Math.min(1800000, Math.max(120000, SEGMENT_SIZE * 4)), signal })
              }
            }
            addPhase('deleting', Date.now() - tDel)
          }

          if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })

          // ── Load source by COMMITTED SEGMENTS ──
          // The table is loaded in segments of SEGMENT_SIZE rows; EACH segment is
          // its own transaction that we commit before moving on. This makes
          // progress DURABLE: a transient failure only re-does the CURRENT segment
          // (≤ SEGMENT_SIZE rows) in a fresh transaction — never the whole table —
          // and already-committed segments are kept. Still duplicate-safe: within
          // a segment a chunk is NEVER re-POSTed (would stage a duplicate key →
          // SAP error 119 → both copies rejected); across committed segments a
          // re-load is an idempotent upsert.
          // Stable $orderby (deterministic pagination). If the keys can't be
          // discovered, read SERIALLY (effParR = 1) so concurrent $skip windows can't
          // overlap or skip rows (#4).
          let srcKeys = []
          try { srcKeys = await fetchKeyNames(srcConn, srcSession, srcName, { planningArea: srcPa, versionId: srcVersion, signal }) } catch { /* read unordered */ }
          const effParR = srcKeys.length ? PARALLEL_R : 1

          setProgress(p => ({ ...p, totalRows }))

          // ── Concurrent COMMITTED segments ──
          // Segments are independent transactions (distinct key ranges), so
          // CONCURRENT_SEGMENTS workers process them in parallel: while one writes,
          // another reads → reads overlap writes and POSTs run concurrently across
          // transactions. Each segment still commits on its own (durable) and never
          // re-POSTs a chunk in a live tx (duplicate-safe).
          const segStarts = []
          for (let s = 0; s < totalRows; s += SEGMENT_SIZE) segStarts.push(s)
          setProgress(p => ({ ...p, totalSegs: segStarts.length }))
          let nextSeg = 0
          let committedRows = 0     // durable baseline — never reset on a retry (segmentTxIds declared at table scope above)

          const worker = async () => {
            for (;;) {
              if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
              const myIdx = nextSeg++
              if (myIdx >= segStarts.length) return
              const segStart = segStarts[myIdx]
              const segEnd = Math.min(segStart + SEGMENT_SIZE, totalRows)

              for (let attempt = 1; ; attempt++) {
                if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                let segLoaded = 0       // rows staged in THIS attempt (reset on retry)
                let myTx = null
                try {
                  // Raw dstVersion ('' = base) → write helpers omit PA + VersionID.
                  myTx = await getTransactionId(connection, session, {
                    versionId: dstVersion,
                    masterDataTypeId: dstName, planningArea: dstPa, signal,
                  })
                  // TransactionName MUST go here — GetTransactionID ignores it (no params in $metadata).
                  try { await initiateParallelProcess(connection, session, myTx, { planningArea: dstPa, versionId: dstVersion, masterDataTypeId: dstName, transactionName: txNameLoad.trim() || 'IBP-ControlTower-MD', signal }) } catch { /* ignore */ }

                  // Read the whole segment (effParR pages at a time) → buffer.
                  const segBuf = []
                  const tRead = Date.now()
                  for (let pageStart = segStart; pageStart < segEnd; pageStart += readPage * effParR) {
                    if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                    const batchPageCount = Math.min(effParR, Math.ceil((segEnd - pageStart) / readPage))
                    const readBatch = Array.from({ length: batchPageCount }, (_, i) => {
                      const skip = pageStart + i * readPage
                      const top  = Math.min(readPage, segEnd - skip)
                      return readEntityPage(srcConn, srcSession, srcName, {
                        skip, top, planningArea: srcPa, versionId: srcVersion, extraFilter,
                        select: selectFields, orderby: srcKeys, signal,
                      })
                    })
                    setProgress(p => ({ ...p, phase: 'reading' }))
                    const batchRows = (await Promise.all(readBatch)).flat()
                    if (batchRows.length === 0) break
                    for (const r of batchRows) segBuf.push(projectRow(srcName, r))
                    segLoaded += batchRows.length
                    const now = Date.now()
                    if (now - lastProgressUpdateRef.current >= 500) {
                      lastProgressUpdateRef.current = now
                      setProgress(p => ({ ...p, rows: committedRows + segLoaded }))
                    }
                  }
                  addPhase('reading', Date.now() - tRead)

                  // Write the whole segment as byte-accurate chunks, PARALLEL_W in parallel.
                  if (segBuf.length > 0) {
                    const chunks = chunkByBytes(segBuf, MAX_POST_BYTES, 5000)
                    setProgress(p => ({ ...p, phase: 'writing' }))
                    const tWrite = Date.now()
                    for (let ci = 0; ci < chunks.length; ci += PARALLEL_W) {
                      if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                      await Promise.all(chunks.slice(ci, ci + PARALLEL_W).map(chunk =>
                        postTransChunk(connection, session, dstName, myTx, chunk, {
                          deleteEntries: false, planningArea: dstPa, versionId: dstVersion, signal, csrf,
                        })
                      ))
                    }
                    addPhase('writing', Date.now() - tWrite)
                  }

                  if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })

                  setProgress(p => ({ ...p, phase: 'committing' }))
                  const tCommit = Date.now()
                  await commitTransaction(connection, session, myTx, { signal, csrf })
                  addPhase('committing', Date.now() - tCommit)

                  // Segment committed → durable. Advance the baseline (single-threaded
                  // event loop → these shared-state updates don't race).
                  committedRows += segLoaded
                  loadedRows = committedRows
                  segmentTxIds.push(myTx)
                  setProgress(p => ({ ...p, rows: committedRows, segsDone: (p.segsDone || 0) + 1 }))
                  break   // segment done; pull the next one
                } catch (e) {
                  if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) throw e
                  // CSRF expired mid-run → refresh once and retry. A 403 stages nothing,
                  // so re-staging the segment in a fresh tx is safe (#2).
                  if (e?.status === 403) { try { csrf = await fetchCsrf(connection, session, { signal }) } catch { /* ignore */ } }
                  const transient = e?.status === 403 || e?.status == null || e.status >= 500
                  if (transient && attempt < MAX_SEGMENT_ATTEMPTS) {
                    setProgress(p => ({ ...p, phase: 'retrying' }))
                    await new Promise(r => setTimeout(r, 1500 * attempt))
                    addPhase('retrying', 1500 * attempt)
                    continue
                  }
                  throw e
                }
              }
            }
          }
          // Without a stable $orderby, concurrent $skip windows could overlap or skip
          // rows → run fully serial (1 worker) in that rare case (#2).
          const workerCount = srcKeys.length ? Math.min(CONCURRENT_SEGMENTS, segStarts.length || 1) : 1
          await Promise.all(Array.from({ length: workerCount }, () => worker()))

          // SAP commits asynchronously — each segment was committed independently,
          // so wait for processing and read messages across ALL segment
          // transactions before counting (otherwise we'd see stale data). By now
          // the earlier segments are typically already processed.
          setProgress(p => ({ ...p, phase: 'processing' }))
          const tProc = Date.now()
          let anyError = false, anyUnconfirmed = false
          const errorMsgs = []
          for (const tx of segmentTxIds) {
            if (cancelledRef.current) break
            const st = await waitForProcessed(connection, session, tx, { timeoutMs: Math.min(1800000, Math.max(120000, SEGMENT_SIZE * 4)), signal })
            if (st === 'ERROR') anyError = true
            else if (st !== 'PROCESSED') anyUnconfirmed = true
            setProgress(p => ({ ...p, phase: 'messages' }))
            const msgs = await readMessages(connection, session, dstName, tx, { signal })
            errorMsgs.push(...msgs.filter(m => ['E', 'A'].includes(m.Severity)))
          }
          addPhase('processing', Date.now() - tProc)

          // Count destination AFTER processing. If anything wasn't confirmed
          // PROCESSED, retry a few times while the count catches up.
          let dstAfter = null
          const attempts = (!anyError && !anyUnconfirmed) ? 1 : 3
          for (let a = 0; a < attempts; a++) {
            if (a > 0) await new Promise(r => setTimeout(r, 2500))
            try {
              dstAfter = await fetchCount(connection, session, dstName, { planningArea: dstPa, versionId: dstVersion || BASE_VERSION_ID, signal })
            } catch { dstAfter = null }
            if (dstAfter != null) break
          }

          // Honest counts: rejected = rows SAP refused (one message per rejected
          // row, across all segments); sent = rows read AND committed.
          const rejected = errorMsgs.length
          const sent     = committedRows

          // Status: any segment ERROR → error; rejections → warning; unconfirmed
          // → processing (still applying in SAP); else ok.
          let status
          if (anyError)            status = 'error'
          else if (rejected > 0)   status = 'warning'
          else if (anyUnconfirmed) status = 'processing'
          else                     status = 'ok'

          const phaseTimes = { ...phaseAcc }
          const durationMs = Date.now() - tableStart
          pushResult({
            mdt: srcName, dstName, unverified,
            txId: segmentTxIds[segmentTxIds.length - 1] || null,
            segments: segmentTxIds.length,
            status,
            total:    sent,
            ok:       Math.max(0, sent - rejected),
            errors:   rejected,
            messages: errorMsgs,   // kept for detail panel
            dstBefore, dstAfter,
            phaseTimes, durationMs,
          })
        } catch (e) {
          const phaseTimes = { ...phaseAcc }
          const durationMs = Date.now() - tableStart
          const lastTx = segmentTxIds.length ? segmentTxIds[segmentTxIds.length - 1] : null
          // Cancellation: explicit flag, an aborted request, or the cancel ref set.
          if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) {
            pushResult({ mdt: srcName, dstName, unverified, status: 'cancelled', total: loadedRows, ok: 0, errors: 0, txId: lastTx, dstBefore, dstAfter: null, phaseTimes, durationMs })
            break
          }
          pushResult({ mdt: srcName, dstName, unverified, status: 'error', total: loadedRows, ok: 0, errors: 1, txId: lastTx, errorMsg: errText(e), dstBefore, dstAfter: null, phaseTimes, durationMs })
        }
      }
    } finally {
      setRunning(false)
      setProgress(null)
      setResults(allResults)

      const totalRowsMigrated = allResults.reduce((s, r) => s + (r.total || 0), 0)
      const runDurationMs = Date.now() - runStartRef.current
      const overallStatus = allResults.some(r => r.status === 'cancelled') ? 'cancelled'
        : allResults.some(r => r.status === 'error') ? 'error'
        : allResults.some(r => r.status === 'processing') ? 'processing'
        : allResults.some(r => r.status === 'warning') ? 'warning' : 'ok'
      const entry = {
        date: new Date().toISOString(),
        srcConnId:   srcConn?.id   || '',
        srcConnName: srcConn?.name || '',
        srcPa, srcVersion, dstPa, dstVersion,
        mdts: mdtList,
        filters: Object.fromEntries(mdtList.map(m => [m, mdtExtraFilter(m)]).filter(([, f]) => f)),
        totalRows: totalRowsMigrated,
        status: overallStatus,
        durationMs: runDurationMs,
        timings: allResults.map(r => ({ mdt: r.mdt, durationMs: r.durationMs, phaseTimes: r.phaseTimes })),
      }
      const updated = [entry, ...loadHistory(connection.id)].slice(0, 50)
      saveHistory(connection.id, updated)
      setHistory(updated)
    }
  }, [srcConn, srcSession, srcPa, srcVersion, dstPa, dstVersion, mdtOrder, resolveDst, deleteEntries, mdtExtraFilter, connection, session, txNameLoad, txNameDel])

  // ── Derived ──
  // Identical origin/target is BLOCKED: with "delete destination first" it would
  // wipe the source before reading it (total data loss). Same system with a
  // DIFFERENT area or version is the supported intra-system migration.
  const sameTarget = !!srcConn && srcConn.id === connection.id && !!srcPa && srcPa === dstPa && (srcVersion || '') === (dstVersion || '')
  const canMigrate = !running && !!srcConn && !!srcSession && !!srcPa && !!dstPa && mdtOrder.length > 0 && !sameTarget
  const oneSel     = !running && mdtOrder.length === 1

  const PHASE_LABEL = {
    reading:    t('mig.phaseReading'),
    deleting:   t('mig.phaseDeleting'),
    writing:    t('mig.phaseWriting'),
    committing: t('mig.phaseCommitting'),
    processing: t('mig.phaseProcessing'),
    messages:   t('mig.phaseMessages'),
    retrying:   t('mig.phaseRetrying'),
  }
  // Concise phase names for the per-table timing breakdown.
  const PHASE_SHORT = {
    reading:    t('mig.tReading'),
    deleting:   t('mig.tDeleting'),
    writing:    t('mig.tWriting'),
    committing: t('mig.tCommitting'),
    processing: t('mig.tProcessing'),
    messages:   t('mig.tMessages'),
    retrying:   t('mig.tRetrying'),
  }

  // Result status → label / colour / icon (shared by results table and step panel).
  const statusLabel = s => s === 'ok' ? t('mig.statusOk') : s === 'error' ? t('mig.statusError')
    : s === 'warning' ? t('mig.statusWarning')
    : s === 'skipped' ? t('mig.statusSkipped')
    : s === 'processing' ? t('mig.statusProcessing') : t('mig.statusCancelled')
  const statusColor = s => s === 'ok' ? 'var(--green)' : s === 'error' ? 'var(--red)'
    : s === 'warning' ? 'var(--yellow, #e6a817)'
    : s === 'skipped' ? 'var(--text3)'
    : s === 'processing' ? 'var(--yellow, #e6a817)' : 'var(--text3)'
  const statusIcon  = s => s === 'ok' ? '✓' : s === 'error' ? '✕' : s === 'warning' ? '⚠'
    : s === 'skipped' ? '⊘'
    : s === 'processing' ? '⧗' : '⊘'

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>

      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 20 }}>
        {t('mig.title')}
      </div>

      {/* ── Config section ── */}
      <div style={SECTION}>
        <div style={SECTION_HDR}>{t('mig.sectionConfig')}</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>

          {/* Source */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <label style={{ ...LABEL, marginBottom: 0 }}>{t('mig.srcLabel')}</label>
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'var(--text3)', padding: '0 2px' }}
                onClick={() => {
                  // Refresh BOTH the connection list AND the catalogs: invalidate the
                  // cached VSMT/importable sets (for destination + source) so a stale or
                  // empty cache can't leave the area dropdown permanently empty, then
                  // bump catalogTick to force a fresh fetch from SAP.
                  invalidateVsmtCache(connection.id)
                  invalidateImportableCache(connection.id)
                  if (srcConn) { invalidateVsmtCache(srcConn.id); invalidateImportableCache(srcConn.id) }
                  setConnsTick(n => n + 1)
                  setCatalogTick(n => n + 1)
                }}
                title={t('mig.refreshConns')}
              >
                {t('mig.refreshConns')}
              </button>
            </div>

            {allConns.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text3)', padding: '6px 0' }}>
                {t('mig.noSourceOptions')}
              </div>
            ) : (
              <select
                style={SELECT}
                value={srcConnId || ''}
                onChange={e => {
                  const id  = e.target.value || null
                  const usr = id ? allConns.find(c => c.id === id)?.com0720?.user || '' : ''
                  setSrcConnId(id)
                  setSrcTempCreds(null)
                  setSrcLoginForm({ user: usr, password: '' })
                  setSrcLoginError('')
                }}
              >
                <option value="">{t('mig.noSource')}</option>
                {allConns.map(c => (
                  <option key={c.id} value={c.id}>{c.id === connection.id ? t('mig.srcSelf', { name: c.name }) : c.name}</option>
                ))}
              </select>
            )}

            {/* Inline login */}
            {needsSrcLogin && (
              <form onSubmit={handleSrcLogin} style={{
                marginTop: 12, background: 'var(--bg)',
                border: '1px solid var(--border2)', borderRadius: 8, padding: 14,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 10 }}>
                  {t('mig.srcLoginTitle')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <label style={LABEL}>{t('login.user')}</label>
                    <input style={INPUT} value={srcLoginForm.user} placeholder="COM_USER"
                      onChange={e => setSrcLoginForm(p => ({ ...p, user: e.target.value }))} />
                  </div>
                  <div>
                    <label style={LABEL}>{t('login.password')}</label>
                    <input style={INPUT} type="password" value={srcLoginForm.password} placeholder="••••••••"
                      onChange={e => setSrcLoginForm(p => ({ ...p, password: e.target.value }))} />
                  </div>
                </div>
                {srcLoginError && (
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 6 }}>✕ {srcLoginError}</div>
                )}
                <button type="submit" disabled={srcLoginLoading} style={{ ...btnPrimary(srcLoginLoading), marginTop: 10, width: '100%' }}>
                  {srcLoginLoading ? t('mig.srcLoginVerifying') : t('mig.srcLoginBtn')}
                </button>
              </form>
            )}

            {/* Source PA / Version */}
            {srcConn && srcSession && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {srcLoading ? (
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>{t('mig.loadingCatalog')}</div>
                ) : (
                  <>
                    <div>
                      <label style={LABEL}>{t('mig.paLabel')}</label>
                      <select style={SELECT} value={srcPa} onChange={e => setSrcPa(e.target.value)}>
                        <option value="">{t('mig.selectPa')}</option>
                        {getPas(srcCatalog).map(p => (
                          <option key={p.id} value={p.id}>{p.desc ? `${p.id} — ${p.desc}` : p.id}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label style={LABEL}>{t('mig.versionLabel')}</label>
                      <select style={SELECT} value={srcVersion} onChange={e => setSrcVersion(e.target.value)}>
                        <option value="">{t('mig.baseVersion')}</option>
                        {getVersions(srcCatalog, srcPa).map(v => (
                          <option key={v.id} value={v.id}>{v.name ? `${v.name} (${v.id})` : v.id}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Destination */}
          <div>
            <label style={LABEL}>{t('mig.dstLabel')}</label>
            <div style={{
              background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
              borderRadius: 6, padding: '7px 10px', fontSize: 12, fontWeight: 600, color: 'var(--text)',
            }}>
              {connection.name}
              {connection.ambiente && (
                <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 8 }}>
                  ({connection.ambiente})
                </span>
              )}
            </div>

            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {dstLoading ? (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>{t('mig.loadingCatalog')}</div>
              ) : (
                <>
                  <div>
                    <label style={LABEL}>{t('mig.paLabel')}</label>
                    <select style={SELECT} value={dstPa} onChange={e => setDstPa(e.target.value)}>
                      <option value="">{t('mig.selectPa')}</option>
                      {getPas(dstCatalog).map(p => (
                        <option key={p.id} value={p.id}>{p.desc ? `${p.id} — ${p.desc}` : p.id}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={LABEL}>{t('mig.versionLabel')}</label>
                    <select style={SELECT} value={dstVersion} onChange={e => setDstVersion(e.target.value)}>
                      <option value="">{t('mig.baseVersion')}</option>
                      {getVersions(dstCatalog, dstPa).map(v => (
                        <option key={v.id} value={v.id}>{v.name ? `${v.name} (${v.id})` : v.id}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {catalogError && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>✕ {catalogError}</div>
        )}
      </div>

      {/* ── MDT selector ── */}
      {srcPa && dstPa && (
        <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={SECTION_HDR}>{t('mig.mdtTitle')}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {mdtOrder.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {t('mig.mdtCountSelected', { n: mdtOrder.length })}
                </span>
              )}
              <button style={{ ...BTN_SEC, padding: '4px 10px', fontSize: 11 }}
                onClick={() => {
                  setMdtOrder([...availableMdts])
                  setMdtMapping(Object.fromEntries(availableMdts.map(src => [src, suggestDstName(src, dstCandidates) || src])))
                }}>
                {t('mig.mdtSelectAll')}
              </button>
              <button style={{ ...BTN_SEC, padding: '4px 10px', fontSize: 11 }}
                onClick={() => { setMdtOrder([]); setMdtMapping({}); setMdtFilters({}); setFilterOpen(null) }}>
                {t('mig.mdtNone')}
              </button>
            </div>
          </div>

          <input
            style={{ ...INPUT, marginBottom: 10 }}
            placeholder={t('mig.mdtSearch')}
            value={mdtSearch}
            onChange={e => setMdtSearch(e.target.value)}
          />

          {(!srcVersion || !dstVersion) && (
            <div style={{
              fontSize: 11, color: 'var(--yellow, #e6a817)',
              background: 'color-mix(in srgb, var(--yellow, #e6a817) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--yellow, #e6a817) 30%, transparent)',
              borderRadius: 6, padding: '5px 10px', marginBottom: 10,
            }}>
              {t('mig.baseWarning')}
            </div>
          )}

          {availableMdts.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text3)', padding: '6px 0' }}>
              {t('mig.mdtNoIntersection')}
            </div>
          ) : (
            <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filteredMdts.map(mdt => (
                <label key={mdt} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '4px 2px' }}>
                  <input
                    type="checkbox"
                    checked={mdtOrder.includes(mdt)}
                    onChange={e => {
                      if (e.target.checked) {
                        setMdtOrder(prev => [...prev, mdt])
                        setMdtMapping(prev => ({ ...prev, [mdt]: suggestDstName(mdt, dstCandidates) || mdt }))
                      } else {
                        setMdtOrder(prev => prev.filter(m => m !== mdt))
                        setMdtMapping(prev => { const n = { ...prev }; delete n[mdt]; return n })
                        setMdtFilters(prev => { const n = { ...prev }; delete n[mdt]; return n })
                        if (filterOpen === mdt) setFilterOpen(null)
                      }
                    }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)', flex: 1 }}>{mdt}</span>
                  {oneSel && mdtOrder.includes(mdt) && (
                    <button
                      style={{ ...BTN_SEC, padding: '2px 8px', fontSize: 10, marginLeft: 4, flexShrink: 0 }}
                      onClick={e => { e.preventDefault(); handlePreview(mdt) }}
                    >
                      {t('mig.previewBtn')}
                    </button>
                  )}
                </label>
              ))}
            </div>
          )}

          {/* ── Orden de migración ── */}
          {mdtOrder.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ ...SECTION_HDR, marginBottom: 8 }}>{t('mig.orderTitle')}</div>
              {mdtOrder.map((mdt, idx) => {
                const isOver  = dragOver?.id === mdt
                const overPos = isOver ? dragOver.pos : null
                const conds      = mdtFilters[mdt] || []
                const hasFilter  = !!mdtExtraFilter(mdt)
                const editorOpen = filterOpen === mdt
                return (
                  <Fragment key={mdt}>
                  <div
                    draggable={!isMobile}
                    onDragStart={e => { dragId.current = mdt; e.dataTransfer.effectAllowed = 'move' }}
                    onDragEnd={() => setDragOver(null)}
                    onDragOver={e => {
                      e.preventDefault()
                      if (!dragId.current || dragId.current === mdt) { setDragOver(null); return }
                      const rect = e.currentTarget.getBoundingClientRect()
                      const pos  = (e.clientY - rect.top) < rect.height / 2 ? 'top' : 'bottom'
                      setDragOver({ id: mdt, pos })
                    }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={e => {
                      e.preventDefault()
                      const from = dragId.current
                      dragId.current = null
                      setDragOver(null)
                      if (!from || from === mdt) return
                      setMdtOrder(prev => {
                        const fromIdx = prev.indexOf(from)
                        const toIdx   = prev.indexOf(mdt)
                        if (fromIdx < 0 || toIdx < 0) return prev
                        const pos = dragOver?.pos ?? 'bottom'
                        const insertIdx = pos === 'top'
                          ? (fromIdx < toIdx ? toIdx - 1 : toIdx)
                          : (fromIdx < toIdx ? toIdx : toIdx + 1)
                        const next = [...prev]
                        const [moved] = next.splice(fromIdx, 1)
                        next.splice(insertIdx, 0, moved)
                        return next
                      })
                    }}
                    style={{
                      position: 'relative',
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 8px', marginBottom: 4,
                      background: 'var(--bg)', border: '1px solid var(--border)',
                      borderRadius: 7,
                      cursor: isMobile ? 'default' : 'grab',
                      transition: 'opacity .15s',
                    }}
                  >
                    {/* Línea de destino */}
                    {isOver && (
                      <div style={{
                        position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2,
                        background: 'rgba(34,197,94,.8)', pointerEvents: 'none',
                        top:    overPos === 'top'    ? -2 : undefined,
                        bottom: overPos === 'bottom' ? -2 : undefined,
                      }} />
                    )}
                    {/* Handle (solo desktop) */}
                    {!isMobile && (
                      <span style={{ color: 'var(--text3)', opacity: 0.45, fontSize: 14, userSelect: 'none', flexShrink: 0 }}>⠿</span>
                    )}
                    {/* Número */}
                    <div style={{
                      width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 9, fontWeight: 700, color: 'var(--text2)',
                      background: 'var(--bg2)', border: '1px solid var(--border)',
                    }}>
                      {idx + 1}
                    </div>
                    {/* Origen → Destino (mapeo de tabla) */}
                    <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', flexShrink: 0, maxWidth: '38%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mdt}>{mdt}</span>
                    <span style={{ color: 'var(--text3)', fontSize: 12, flexShrink: 0 }}>→</span>
                    <div
                      draggable={false}
                      onPointerDown={e => e.stopPropagation()}
                      title={resolveDst(mdt) === mdt ? '' : t('mig.mappedTo')}
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      <SearchSelect
                        value={resolveDst(mdt)}
                        options={dstCandidates.map(d => ({ value: d, label: d }))}
                        onChange={v => setMdtMapping(prev => ({ ...prev, [mdt]: v }))}
                        searchPlaceholder={t('kfm.typeToFilter')}
                        btnStyle={{
                          fontSize: 11, padding: '3px 6px',
                          borderColor: resolveDst(mdt) === mdt ? 'var(--border)' : 'var(--accent)',
                        }}
                      />
                    </div>
                    {/* Filtro de registros (migración selectiva) */}
                    <button
                      onPointerDown={e => e.stopPropagation()}
                      onClick={() => handleToggleFilter(mdt)}
                      title={t('flt.btn')}
                      style={{
                        ...BTN_SEC, padding: '2px 9px', fontSize: 10, flexShrink: 0, whiteSpace: 'nowrap',
                        borderColor: hasFilter ? 'var(--accent)' : 'var(--border2)',
                        color: hasFilter ? 'var(--accent)' : 'var(--text2)',
                        fontWeight: hasFilter ? 700 : 600,
                        background: editorOpen ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'none',
                      }}
                    >
                      ⧩ {t('flt.btnShort')}{hasFilter ? ` (${conds.filter(c => condChip(c)).length})` : ''} {editorOpen ? '▾' : '▸'}
                    </button>
                    {/* ↑ ↓ */}
                    <button
                      disabled={idx === 0}
                      onClick={() => setMdtOrder(prev => {
                        const a = [...prev];[a[idx], a[idx - 1]] = [a[idx - 1], a[idx]]; return a
                      })}
                      style={{ ...BTN_SEC, padding: '2px 7px', fontSize: 10, opacity: idx === 0 ? 0.25 : 1 }}
                    >↑</button>
                    <button
                      disabled={idx === mdtOrder.length - 1}
                      onClick={() => setMdtOrder(prev => {
                        const a = [...prev];[a[idx], a[idx + 1]] = [a[idx + 1], a[idx]]; return a
                      })}
                      style={{ ...BTN_SEC, padding: '2px 7px', fontSize: 10, opacity: idx === mdtOrder.length - 1 ? 0.25 : 1 }}
                    >↓</button>
                  </div>

                  {/* Chips del filtro activo (editor cerrado) */}
                  {hasFilter && !editorOpen && (
                    <div style={{ margin: '-2px 0 6px 36px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {conds.map((c, ci) => {
                        const chip = condChip(c)
                        return chip ? (
                          <span key={ci} style={{
                            fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--accent)',
                            background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                            borderRadius: 5, padding: '1px 7px',
                          }}>{chip}</span>
                        ) : null
                      })}
                    </div>
                  )}

                  {/* Editor de filtro */}
                  {editorOpen && (
                    <div style={{
                      margin: '-2px 0 8px 36px', padding: '10px 12px',
                      background: 'var(--bg)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                      borderRadius: 7,
                    }}>
                      <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>{t('flt.note')}</div>
                      {mdtFieldOpts[mdt] === 'loading' && (
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>{t('flt.fieldsLoading')}</div>
                      )}
                      {mdtFieldOpts[mdt] === 'error' && (
                        <div style={{ fontSize: 11, color: 'var(--red)' }}>✕ {t('flt.fieldsErr')}</div>
                      )}
                      {Array.isArray(mdtFieldOpts[mdt]) && (
                        <>
                          {conds.map((c, ci) => (
                            <div key={ci} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                              <SearchSelect
                                value={c.field}
                                options={mdtFieldOpts[mdt].map(f => ({ value: f, label: f }))}
                                onChange={v => setMdtFilters(p => ({ ...p, [mdt]: conds.map((x, xi) => xi === ci ? { ...x, field: v, value: '' } : x) }))}
                                placeholder={t('flt.fieldPh')}
                                searchPlaceholder={t('kfm.typeToFilter')}
                                style={{ flex: '0 0 32%', minWidth: 0 }}
                                btnStyle={{ fontSize: 11, padding: '4px 8px' }}
                              />
                              <select
                                value={c.op}
                                onChange={e => setMdtFilters(p => ({ ...p, [mdt]: conds.map((x, xi) => xi === ci ? { ...x, op: e.target.value } : x) }))}
                                style={{ ...SELECT, flex: '0 0 150px', fontSize: 11, padding: '4px 6px' }}
                              >
                                <option value="in">{t('flt.opIn')}</option>
                                <option value="sw">{t('flt.opSw')}</option>
                              </select>
                              {c.op === 'sw' ? (
                                <input
                                  value={c.value}
                                  onChange={e => setMdtFilters(p => ({ ...p, [mdt]: conds.map((x, xi) => xi === ci ? { ...x, value: e.target.value } : x) }))}
                                  placeholder={t('flt.valuePh')}
                                  style={{ ...INPUT, flex: 1, minWidth: 0, fontSize: 11, padding: '4px 8px', fontFamily: 'var(--mono)' }}
                                />
                              ) : (
                                <MultiValueSelect
                                  value={c.value}
                                  onChange={v => setMdtFilters(p => ({ ...p, [mdt]: conds.map((x, xi) => xi === ci ? { ...x, value: v } : x) }))}
                                  loadValues={() => fetchDistinctValues(srcConn, srcSession, mdt, c.field, { planningArea: srcPa, versionId: srcVersion })}
                                  placeholder={t('flt.valuesPh')}
                                  disabled={!c.field}
                                />
                              )}
                              <button
                                onClick={() => setMdtFilters(p => {
                                  const next = conds.filter((_, xi) => xi !== ci)
                                  const n = { ...p }
                                  if (next.length) n[mdt] = next; else delete n[mdt]
                                  return n
                                })}
                                title={t('flt.remove')}
                                style={{ ...BTN_SEC, padding: '2px 7px', fontSize: 10, flexShrink: 0, color: 'var(--red)', borderColor: 'var(--red)' }}
                              >✕</button>
                            </div>
                          ))}
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                            <button
                              onClick={() => setMdtFilters(p => ({ ...p, [mdt]: [...conds, { field: '', op: 'in', value: '' }] }))}
                              style={{ ...BTN_SEC, padding: '3px 10px', fontSize: 10 }}
                            >
                              {t('flt.addCond')}
                            </button>
                            {hasFilter && (
                              <button
                                onClick={() => handleTestFilter(mdt)}
                                disabled={filterTest[mdt]?.loading}
                                style={{ ...BTN_SEC, padding: '3px 10px', fontSize: 10, borderColor: 'var(--accent)', color: 'var(--accent)' }}
                              >
                                {filterTest[mdt]?.loading ? t('flt.testing') : t('flt.test')}
                              </button>
                            )}
                            {filterTest[mdt]?.n != null && (
                              <span style={{ fontSize: 11, color: 'var(--green)', fontFamily: 'var(--mono)' }}>
                                ✓ {t('flt.testResult', { n: filterTest[mdt].n.toLocaleString(), total: (filterTest[mdt].total ?? 0).toLocaleString() })}
                              </span>
                            )}
                            {filterTest[mdt]?.error && (
                              <span style={{ fontSize: 11, color: 'var(--red)' }}>✕ {t('flt.testErr', { msg: filterTest[mdt].error })}</span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  </Fragment>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Options ── */}
      {srcPa && dstPa && mdtOrder.length > 0 && (
        <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
          <div style={SECTION_HDR}>{t('mig.sectionOptions')}</div>

          {nonVersionMdts.length > 0 && (
            <div style={{
              fontSize: 11, color: 'var(--yellow, #e6a817)',
              background: 'color-mix(in srgb, var(--yellow, #e6a817) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--yellow, #e6a817) 30%, transparent)',
              borderRadius: 6, padding: '7px 10px', marginBottom: 12,
            }}>
              {t('mig.versionIndepWarning', { mdts: nonVersionMdts.join(', ') })}
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={deleteEntries} onChange={e => setDeleteEntries(e.target.checked)} style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{t('mig.deleteEntries')}</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{t('mig.deleteEntriesNote')}</div>
            </div>
          </label>

          {hasAnyFilter && !deleteEntries && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, marginLeft: 26 }}>
              ⓘ {t('flt.deleteAutoOff')}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
            <div>
              <label style={LABEL}>{t('mig.txNameLoad')}</label>
              <input style={INPUT} value={txNameLoad} onChange={e => setTxNameLoad(e.target.value)} placeholder="IBP-ControlTower-MD" maxLength={40} />
            </div>
            <div>
              <label style={LABEL}>{t('mig.txNameDel')}</label>
              <input style={{ ...INPUT, ...(deleteEntries ? {} : { opacity: 0.5 }) }} value={txNameDel} onChange={e => setTxNameDel(e.target.value)} placeholder="IBP-ControlTower-DEL" maxLength={40} disabled={!deleteEntries} />
            </div>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>{t('mig.txNameNote')}</div>
          {hasAnyFilter && deleteEntries && (
            <div style={{
              fontSize: 11, color: 'var(--red)', lineHeight: 1.5, marginTop: 10,
              background: 'color-mix(in srgb, var(--red) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
              borderRadius: 6, padding: '7px 10px',
            }}>
              ⚠ {t('flt.deleteConflict')}
            </div>
          )}
        </div>
      )}

      {/* ── Action bar ── */}
      {srcPa && dstPa && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          {running ? (
            <button style={BTN_DANGER} onClick={() => setShowCancelConfirm(true)}>
              {t('mig.cancelBtn')}
            </button>
          ) : (
            <button style={btnPrimary(!canMigrate || analyzing)} disabled={!canMigrate || analyzing} onClick={handleMigrateClick}>
              {analyzing ? t('mig.analyzing') : t('mig.migrateBtn')}
            </button>
          )}
          {sameTarget && (
            <span style={{ fontSize: 11, color: 'var(--red)', alignSelf: 'center' }}>✕ {t('mig.sameTargetWarning')}</span>
          )}
        </div>
      )}

      {/* ── Progress (step list — every selected table with its live status) ── */}
      {running && (
        <div style={{ ...SECTION, background: 'color-mix(in srgb, var(--accent) 5%, var(--bg2))' }}>
          <div style={{ ...SECTION_HDR, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{t('mig.progressTitle', { cur: progress?.datasetCur || 0, total: mdtOrder.length })}</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text2)', letterSpacing: 0 }}>⏱ {fmtDuration(runElapsed)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {mdtOrder.map((srcName, i) => {
              const done      = (results || []).find(r => r.mdt === srcName)
              const isCurrent = !done && progress && progress.datasetCur === i + 1
              const dstName   = resolveDst(srcName)
              const label     = srcName === dstName ? srcName : `${srcName} → ${dstName}`
              const icon  = done ? statusIcon(done.status) : isCurrent ? '⏳' : '○'
              const color = done ? statusColor(done.status) : isCurrent ? 'var(--accent)' : 'var(--text3)'
              const deltaStr = done && done.dstBefore != null && done.dstAfter != null
                ? `${done.dstBefore.toLocaleString()}→${done.dstAfter.toLocaleString()}` : null
              return (
                <div key={srcName} style={{
                  border: '1px solid var(--border)', borderRadius: 7, padding: '7px 10px',
                  background: 'var(--bg)', opacity: (!done && !isCurrent) ? 0.55 : 1,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color, fontSize: 12, flexShrink: 0, width: 14, textAlign: 'center' }}>{icon}</span>
                    <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                    <span style={{ fontSize: 11, color, flexShrink: 0 }} title={done?.status === 'processing' ? t('mig.statusProcessingNote') : ''}>
                      {done
                        ? statusLabel(done.status)
                        : isCurrent ? (PHASE_LABEL[progress.phase] || '') : t('mig.stepPending')}
                    </span>
                  </div>
                  {done && (
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 22, marginTop: 2 }}>
                      {(done.total || 0).toLocaleString()} {t('mig.colTotal').toLowerCase()}
                      {done.errors > 0 ? ` · ${done.errors} ${t('mig.colErrors').toLowerCase()}` : ''}
                      {deltaStr ? ` · ${deltaStr}` : ''}
                      {done.durationMs != null ? ` · ${fmtDuration(done.durationMs)}` : ''}
                    </div>
                  )}
                  {isCurrent && (() => {
                    const elapsedS = Math.max(1, (Date.now() - (progress.tableStart || Date.now())) / 1000)
                    const rate = progress.rows > 0 ? Math.round(progress.rows / elapsedS) : 0
                    const pct  = progress.totalRows > 0 ? Math.min(100, (progress.rows / progress.totalRows) * 100) : null
                    const etaS = (pct != null && rate > 0) ? Math.max(0, (progress.totalRows - progress.rows) / rate) : null
                    return (
                      <div style={{ marginLeft: 22, marginTop: 5 }}>
                        {pct != null && (
                          <div style={{ background: 'var(--border)', borderRadius: 4, height: 5, overflow: 'hidden', marginBottom: 3 }}>
                            <div style={{
                              background: 'var(--accent)', height: '100%', borderRadius: 4,
                              width: `${pct}%`, transition: 'width .3s',
                            }} />
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
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Results (final, after the run) ── */}
      {!running && results && results.length > 0 && (
        <div style={SECTION}>
          <div style={SECTION_HDR}>{t('mig.resultsTitle')}</div>

          {/* ── Timing summary ── */}
          {(() => {
            const totalRun = results.reduce((s, r) => s + (r.durationMs || 0), 0)
            const phaseTotals = {}
            results.forEach(r => Object.entries(r.phaseTimes || {}).forEach(([p, ms]) => { phaseTotals[p] = (phaseTotals[p] || 0) + ms }))
            const slowest = results.reduce((a, b) => ((b.durationMs || 0) > (a?.durationMs || 0) ? b : a), null)
            return (
              <div style={{
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
                padding: '10px 12px', marginBottom: 14, fontSize: 12,
              }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 700, color: 'var(--text)' }}>
                    {t('mig.summaryTotal', { dur: fmtDuration(totalRun) })}
                  </span>
                  {slowest && (
                    <span style={{ color: 'var(--text2)' }}>
                      {t('mig.summarySlowest', { name: slowest.mdt, dur: fmtDuration(slowest.durationMs) })}
                    </span>
                  )}
                </div>
                {Object.keys(phaseTotals).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6, color: 'var(--text3)', fontSize: 11 }}>
                    {TIMED_PHASES.filter(p => phaseTotals[p]).map(p => (
                      <span key={p}>{PHASE_SHORT[p]}: <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}>{fmtDuration(phaseTotals[p])}</span></span>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={TH}>{t('mig.colMdt')}</th>
                <th style={TH}>{t('mig.colStatus')}</th>
                <th style={TH}>{t('mig.colTotal')}</th>
                <th style={TH}>{t('mig.colOk')}</th>
                <th style={TH}>{t('mig.colErrors')}</th>
                <th style={TH}>{t('mig.colDst')}</th>
                <th style={TH}>{t('mig.colTime')}</th>
                <th style={TH}>{t('mig.colTxId')}</th>
              </tr>
            </thead>
            <tbody>
              {results.map(r => {
                const isExpanded = expandedMdt === r.mdt
                const isTimeExpanded = expandedTimeMdt === r.mdt
                const detailMsgs = r.messages || []
                const msgCols    = detailMsgs.length > 0
                  ? Object.keys(detailMsgs[0]).filter(k => k !== '__metadata')
                  : []
                return (
                  <>
                    <tr key={r.mdt}>
                      <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text)' })}>
                        {r.mdt}{r.dstName && r.dstName !== r.mdt ? ` → ${r.dstName}` : ''}
                        {r.unverified && (
                          <span title={t('mig.unverifiedSchema')} style={{ color: 'var(--yellow, #e6a817)', marginLeft: 6, cursor: 'help' }}>⚠</span>
                        )}
                      </td>
                      <td style={td({ fontWeight: 600, color: statusColor(r.status) })} title={r.status === 'processing' ? t('mig.statusProcessingNote') : ''}>
                        {statusLabel(r.status)}{r.status === 'processing' ? ' ⓘ' : ''}
                      </td>
                      <td style={td({ color: 'var(--text2)' })}>{(r.total || 0).toLocaleString()}</td>
                      <td style={td({ color: 'var(--text2)' })}>{(r.ok || 0).toLocaleString()}</td>
                      <td style={td({ color: r.errors > 0 ? 'var(--red)' : 'var(--text3)' })}>
                        {r.errors > 0 ? (
                          <button
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 11, fontWeight: 600, padding: 0 }}
                            onClick={() => setExpandedMdt(isExpanded ? null : r.mdt)}
                          >
                            {isExpanded ? t('mig.errDetailHide') : t('mig.errDetail', { n: r.errors })}
                          </button>
                        ) : (r.errors || 0).toLocaleString()}
                      </td>
                      <td style={td({ color: 'var(--text2)', fontSize: 11, whiteSpace: 'nowrap' })}>
                        {r.dstBefore == null
                          ? '—'
                          : (() => {
                              const after = r.dstAfter == null ? null : r.dstAfter
                              const delta = after == null ? null : after - r.dstBefore
                              return (
                                <span>
                                  {r.dstBefore.toLocaleString()} → {after == null ? '?' : after.toLocaleString()}
                                  {delta != null && delta !== 0 && (
                                    <span style={{ color: delta > 0 ? 'var(--green)' : 'var(--red)', marginLeft: 5, fontWeight: 600 }}>
                                      ({delta > 0 ? '+' : ''}{delta.toLocaleString()})
                                    </span>
                                  )}
                                </span>
                              )
                            })()}
                      </td>
                      <td style={td({ color: 'var(--text2)', fontSize: 11, whiteSpace: 'nowrap' })}>
                        {r.durationMs == null ? '—' : (
                          <button
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', fontSize: 11, padding: 0, fontFamily: 'var(--mono)' }}
                            title={t('mig.timeBreakdownHint')}
                            onClick={() => setExpandedTimeMdt(isTimeExpanded ? null : r.mdt)}
                          >
                            {fmtDuration(r.durationMs)} {isTimeExpanded ? '▾' : '▸'}
                          </button>
                        )}
                      </td>
                      <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text3)', fontSize: 10 })}>{r.txId || '—'}</td>
                    </tr>
                    {isTimeExpanded && (
                      <tr key={`${r.mdt}-time`}>
                        <td colSpan={8} style={{ padding: '4px 0 8px 24px', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 11, color: 'var(--text3)' }}>
                            {TIMED_PHASES.filter(p => r.phaseTimes?.[p]).map(p => (
                              <span key={p}>{PHASE_SHORT[p]}: <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}>{fmtDuration(r.phaseTimes[p])}</span></span>
                            ))}
                            {(!r.phaseTimes || Object.keys(r.phaseTimes).length === 0) && (
                              <span>{t('mig.noTimeDetail')}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {isExpanded && (
                      <tr key={`${r.mdt}-detail`}>
                        <td colSpan={8} style={{ padding: '0 0 8px 24px', borderBottom: '1px solid var(--border)' }}>
                          {detailMsgs.length === 0 ? (
                            <div style={{ fontSize: 11, color: 'var(--text3)', padding: '6px 0' }}>{t('mig.noErrDetail')}</div>
                          ) : (
                            <div style={{ overflowX: 'auto' }}>
                              <table style={{ borderCollapse: 'collapse', fontSize: 11, marginTop: 6 }}>
                                <thead>
                                  <tr>
                                    {msgCols.map(c => (
                                      <th key={c} style={{ ...TH, fontSize: 9 }}>{c}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {detailMsgs.map((msg, mi) => (
                                    <tr key={mi}>
                                      {msgCols.map(c => (
                                        <td key={c} style={{ padding: '3px 8px', borderBottom: '1px solid var(--border)', color: msg.Severity === 'E' || msg.Severity === 'A' ? 'var(--red)' : 'var(--text2)', fontFamily: 'var(--mono)' }}>
                                          {msg[c] ?? ''}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
          {results.some(r => r.errorMsg) && (
            <div style={{ marginTop: 10 }}>
              {results.filter(r => r.errorMsg).map(r => (
                <div key={r.mdt} style={{ fontSize: 11, color: 'var(--red)' }}>{r.mdt}: {r.errorMsg}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── History ── */}
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
                    <th style={TH}>{t('mig.histDatasets')}</th>
                    <th style={TH}>{t('mig.histRows')}</th>
                    <th style={TH}>{t('mig.histTime')}</th>
                    <th style={TH}>{t('mig.histStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => {
                    const srcName = (h.srcConnId && connById[h.srcConnId]?.name) || h.srcConnName || h.srcConnId || '—'
                    return (
                      <tr key={i}>
                        <td style={td({ color: 'var(--text3)', fontSize: 11 })}>{new Date(h.date).toLocaleString()}</td>
                        <td style={td({ color: 'var(--text2)' })}>{srcName} / {h.srcPa}</td>
                        <td style={td({ color: 'var(--text2)' })}>{connection.name} / {h.dstPa}</td>
                        <td style={td({ color: 'var(--text2)' })}>{h.mdts?.length || 0}</td>
                        <td style={td({ color: 'var(--text2)' })}>{(h.totalRows || 0).toLocaleString()}</td>
                        <td style={td({ color: 'var(--text2)', fontFamily: 'var(--mono)' })}>{fmtDuration(h.durationMs)}</td>
                        <td style={td({ fontWeight: 600, color: statusColor(h.status) })}>
                          {statusLabel(h.status)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Preview modal ── */}
      {(previewLoading || previewData) && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'var(--overlay)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => { setPreviewData(null); setPreviewLoading(false) }}
        >
          <div
            style={{
              background: 'var(--bg2)', border: '1px solid var(--border2)',
              borderRadius: 12, padding: 24, width: '82vw', maxWidth: 960, maxHeight: '80vh',
              display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)',
            }}
            onClick={e => e.stopPropagation()}
          >
            {previewLoading ? (
              <div style={{ textAlign: 'center', color: 'var(--text3)', padding: 40 }}>
                {t('mig.previewLoading')}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                      {t('mig.previewTitle', { name: previewData.name })}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                      {t('mig.previewCount', { count: previewData.count.toLocaleString(), shown: previewData.rows.length })}
                    </div>
                    {previewData.error && (
                      <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>✕ {previewData.error}</div>
                    )}
                  </div>
                  <button style={{ ...BTN_SEC, flexShrink: 0 }} onClick={() => setPreviewData(null)}>
                    {t('mig.previewClose')}
                  </button>
                </div>
                {previewData.rows.length > 0 && (() => {
                  const cols = Object.keys(previewData.rows[0])
                  return (
                    <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
                      <table style={{ borderCollapse: 'collapse', fontSize: 11, whiteSpace: 'nowrap' }}>
                        <thead>
                          <tr>
                            {cols.map(c => (
                              <th key={c} style={{ ...TH, padding: '4px 10px' }}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewData.rows.map((row, i) => (
                            <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg)' }}>
                              {cols.map(c => (
                                <td key={c} style={{ padding: '4px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)' }}>
                                  {formatCell(row[c])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Cancel confirmation modal ── */}
      {showCancelConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1001,
          background: 'var(--overlay)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)',
            borderRadius: 12, padding: 28, width: 400, maxWidth: '90vw',
            boxShadow: 'var(--shadow-lg)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>
              {t('mig.cancelConfirmTitle')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 22 }}>
              {t('mig.cancelConfirmMsg')}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button style={BTN_SEC} onClick={() => setShowCancelConfirm(false)}>
                {t('mig.cancelConfirmBack')}
              </button>
              <button
                style={{ ...btnPrimary(false), background: 'var(--red)', color: '#fff' }}
                onClick={() => { cancelledRef.current = true; abortRef.current?.abort(); setShowCancelConfirm(false) }}
              >
                {t('mig.cancelConfirmStop')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Pre-migration confirmation modal (field analysis + production warning) ── */}
      {showConfirm && analysis && (() => {
        const isProd = ['Producción', 'Production'].includes(connection.ambiente)
        // Suma de filas de la corrida → bloquea si supera el tope de la web (no en local).
        const runTotal   = mdtOrder.reduce((s, m) => s + (analysis.byMdt?.[m]?.count || 0), 0)
        const runBlocked = !isLocalRun() && runTotal > MAX_ROWS_HARD
        return (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'var(--overlay)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)',
            borderRadius: 12, padding: 24, width: 560, maxWidth: '92vw', maxHeight: '82vh',
            display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>
              {t('mig.analyzeTitle')}
            </div>

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

            {runBlocked && (
              <div style={{
                fontSize: 11, color: 'var(--red)', lineHeight: 1.5, marginBottom: 12,
                background: 'color-mix(in srgb, var(--red) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
                borderRadius: 6, padding: '7px 10px',
              }}>
                ⊘ {t('mig.limitRunBlocked', { max: MAX_ROWS_HARD.toLocaleString(), n: runTotal.toLocaleString() })}
              </div>
            )}

            {hasAnyFilter && (
              <div style={{
                fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 12,
                background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
                borderRadius: 6, padding: '7px 10px',
              }}>
                <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 3 }}>⧩ {t('flt.confirmTitle')}</div>
                {mdtOrder.filter(m => mdtExtraFilter(m)).map(m => (
                  <div key={m} style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>
                    {m}: {(mdtFilters[m] || []).map(condChip).filter(Boolean).join(' · ')}
                  </div>
                ))}
              </div>
            )}

            {hasAnyFilter && deleteEntries && (
              <div style={{
                fontSize: 11, color: 'var(--red)', lineHeight: 1.5, marginBottom: 12,
                background: 'color-mix(in srgb, var(--red) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
                borderRadius: 6, padding: '7px 10px',
              }}>
                ⚠ {t('flt.deleteConflict')}
              </div>
            )}

            {analysis.error ? (
              <div style={{ fontSize: 12, color: 'var(--red)' }}>✕ {t('mig.analyzeError', { msg: analysis.error })}</div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>{t('mig.analyzeIntro')}</div>
                <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {mdtOrder.map(mdt => {
                    const a = analysis.byMdt[mdt] || {}
                    const ok = a.verifiable && a.omitted.length === 0 && a.unfilled.length === 0
                    return (
                      <div key={mdt} style={{
                        border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px',
                        background: 'var(--bg)',
                      }}>
                        <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text)', marginBottom: 4 }}>{mdt}</div>
                        {typeof a.count === 'number' && (() => {
                          const blocked = !isLocalRun() && a.count > MAX_ROWS_HARD
                          const warned  = !isLocalRun() && !blocked && a.count > MAX_ROWS_WARN
                          const col = blocked ? 'var(--red)' : warned ? 'var(--yellow, #e6a817)' : 'var(--text3)'
                          return (
                            <div style={{ fontSize: 11, color: col, marginBottom: 4 }}>
                              {blocked ? '⊘ ' : warned ? '⚠ ' : ''}
                              {t('mig.rowCount', { n: a.count.toLocaleString() })}
                              {blocked && ` — ${t('mig.limitBlockedTag', { max: MAX_ROWS_HARD.toLocaleString() })}`}
                              {warned && ` — ${t('mig.limitWarnTag', { max: MAX_ROWS_WARN.toLocaleString() })}`}
                            </div>
                          )
                        })()}
                        {!a.verifiable ? (
                          <div style={{ fontSize: 11, color: 'var(--yellow, #e6a817)' }}>⚠ {t('mig.fieldsUnverifiable')}</div>
                        ) : ok ? (
                          <div style={{ fontSize: 11, color: 'var(--green)' }}>✓ {t('mig.fieldsMatch', { n: a.common.length })}</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {a.common.length > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                                <span style={{ color: 'var(--green)' }}>✓ {t('mig.fieldsMigrated', { n: a.common.length })}:</span> <span style={{ fontFamily: 'var(--mono)' }}>{a.common.join(', ')}</span>
                              </div>
                            )}
                            {a.omitted.length > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                                <span style={{ color: 'var(--yellow, #e6a817)' }}>↪ {t('mig.fieldsOmitted')}:</span> <span style={{ fontFamily: 'var(--mono)' }}>{a.omitted.join(', ')}</span>
                              </div>
                            )}
                            {a.unfilled.length > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                                <span style={{ color: 'var(--yellow, #e6a817)' }}>○ {t('mig.fieldsUnfilled')}:</span> <span style={{ fontFamily: 'var(--mono)' }}>{a.unfilled.join(', ')}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={BTN_SEC} onClick={() => setShowConfirm(false)}>
                {t('mig.confirmCancel')}
              </button>
              <button
                disabled={runBlocked}
                style={runBlocked ? btnPrimary(true) : (isProd ? { ...btnPrimary(false), background: 'var(--red)', color: '#fff' } : btnPrimary(false))}
                onClick={runMigration}
              >
                {t('mig.confirmBtn')}
              </button>
            </div>
          </div>
        </div>
        )
      })()}

    </div>
  )
}
