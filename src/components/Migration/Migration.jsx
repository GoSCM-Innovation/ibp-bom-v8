import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useI18n } from '../../context/I18nContext'
import { useIsMobile } from '../../hooks/useIsMobile'
import { getAll } from '../../services/connectionStorage'
import { getSession, setSession } from '../../services/sessionStorage'
import {
  fetchVsmt, buildCatalog, fetchImportableMdts,
  fetchCount, readEntityPage, readKeyRows, fetchFieldNames, fetchKeyNames, fetchCsrf,
  getTransactionId, initiateParallelProcess, postTransChunk,
  commitTransaction, waitForProcessed, readMessages,
  PAGE_SIZE, CHUNK_SIZE, PARALLEL_R, PARALLEL_W, BASE_VERSION_ID, READONLY_FIELDS,
  chunkSizeFor, pageSizeFor,
} from '../../services/masterDataApi'
import { setMigrationGuard } from '../../services/migrationGuard'

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

// Max attempts to stage+commit a table. Each attempt uses a FRESH transaction;
// a failed attempt is abandoned uncommitted (SAP discards it) and re-staged, so
// retries never duplicate keys within a committed transaction.
const MAX_LOAD_ATTEMPTS = 3

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

// ── Component ─────────────────────────────────────────────────────────────────

export default function Migration({ connection, session }) {
  const { t }      = useI18n()
  const isMobile   = useIsMobile()

  // Refresh trigger — increment to force allConns/connById to re-read localStorage
  const [connsTick, setConnsTick] = useState(0)

  // Other connections with SAP_COM_0720 (potential sources)
  const allConns = useMemo(() =>
    getAll().filter(c => c.id !== connection.id && c.com0720?.url && c.com0720?.user),
    [connection.id, connsTick] // eslint-disable-line react-hooks/exhaustive-deps
  )

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
    const stored   = getSession(srcConnId)
    const com0720  = srcTempCreds || stored?.com0720
    if (!com0720?.password) return null
    return { ...(stored || {}), com0720 }
  }, [srcConnId, srcTempCreds])

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

  // ── Options ──
  const [deleteEntries, setDeleteEntries] = useState(true)

  // ── Run state ──
  const cancelledRef          = useRef(false)
  const abortRef              = useRef(null)    // AbortController for the active run (cuts requests in flight)
  const lastProgressUpdateRef = useRef(0)       // throttle: ms timestamp of last row-count update
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults]   = useState(null)

  // ── Error detail expand ──
  const [expandedMdt, setExpandedMdt] = useState(null)

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
  }, [connection.id, session?.com0720?.user]) // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [connection.id, session?.com0720?.user]) // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [srcConnId, srcTempCreds?.user]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset selectors when catalogs change
  useEffect(() => { setSrcPa(''); setSrcVersion(''); setMdtOrder([]); setMdtMapping({}) }, [srcCatalog])
  useEffect(() => { setDstPa(''); setDstVersion(''); setMdtOrder([]); setMdtMapping({}) }, [dstCatalog])
  useEffect(() => { setMdtOrder([]); setMdtMapping({}) }, [srcPa, srcVersion, dstPa, dstVersion])

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

  // ── Migration ──
  // Compares source vs destination fields per MDT (one sample row each) so we can
  // send only the common fields (avoids HTTP 400) and show the user what differs.
  async function analyzeFields() {
    const clean = arr => (arr ? arr.filter(f => !READONLY_FIELDS.has(f)) : null)
    const byMdt = {}
    for (const srcName of mdtOrder) {
      const dstName = resolveDst(srcName)
      let srcFields = null, dstFields = null
      // The column schema is version-independent, so read the sample WITHOUT the
      // version filter — a version-filtered read can be pathologically slow on some
      // tenants (measured 60+ s) and would time out, breaking the projection.
      try { srcFields = await fetchFieldNames(srcConn, srcSession, srcName, { planningArea: srcPa, versionId: '' }) } catch { /* ignore */ }
      try { dstFields = await fetchFieldNames(connection, session, dstName, { planningArea: dstPa, versionId: '' }) } catch { /* ignore */ }
      const s = clean(srcFields), d = clean(dstFields)
      if (!s || !d) {
        // Couldn't infer schema on one side (empty entity) → send all source fields.
        byMdt[srcName] = { verifiable: false, common: null, omitted: [], unfilled: [] }
        continue
      }
      const dSet = new Set(d), sSet = new Set(s)
      byMdt[srcName] = {
        verifiable: true,
        common:   s.filter(f => dSet.has(f)),
        omitted:  s.filter(f => !dSet.has(f)),   // only in source → dropped
        unfilled: d.filter(f => !sSet.has(f)),   // only in destination → left empty
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

    const mdtList = [...mdtOrder]
    const allResults = []
    // Publish results live so completed tables stay visible during the run.
    const pushResult = r => { allResults.push(r); setResults([...allResults]) }

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
        // Adaptive batch sizes by field count (fewer fields → bigger batches → fewer calls).
        const writeFields = entry?.common?.length || 0
        // With $select we download only the common fields, so size the page by those;
        // without it (unverifiable) we download every column (common + omitted).
        const readFields  = selectFields ? selectFields.length : ((entry?.common?.length || 0) + (entry?.omitted?.length || 0))
        const writeChunk  = writeFields ? chunkSizeFor(writeFields) : CHUNK_SIZE
        const readPage    = readFields  ? pageSizeFor(readFields)  : PAGE_SIZE

        setProgress({ datasetCur: di + 1, datasetTotal: mdtList.length, datasetName: label, rows: 0, totalRows: 0, phase: 'reading' })

        let totalRows = 0
        let loadedRows = 0   // rows actually read from source AND staged (sent to IBP)
        let dstBefore = null

        try {
          totalRows = await fetchCount(srcConn, srcSession, srcName, { planningArea: srcPa, versionId: srcVersion, signal })
        } catch (e) {
          pushResult({ mdt: srcName, dstName, unverified, status: 'error', total: 0, ok: 0, errors: 1, txId: null, errorMsg: errText(e) })
          continue
        }

        // Count destination rows in the TARGET version BEFORE writing (verification baseline).
        try {
          dstBefore = await fetchCount(connection, session, dstName, { planningArea: dstPa, versionId: dstVersion || BASE_VERSION_ID, signal })
        } catch { /* ignore */ }

        let txId = null
        try {
          // Obtain a CSRF token once and reuse it across all POSTs of this table
          // (delete + load + commit) — avoids the proxy re-fetching it per POST.
          let csrf = null
          try { csrf = await fetchCsrf(connection, session, { signal }) } catch { /* proxy will fetch per POST */ }

          // ── Replace mode: clear destination in its OWN transaction ──
          // SAP forbids mixing DeleteEntries true/false in one transaction, so the
          // delete runs as a separate committed transaction before the load.
          if (deleteEntries) {
            setProgress(p => ({ ...p, phase: 'deleting' }))
            const { keyNames, rows: keyRows } = await readKeyRows(connection, session, dstName, { planningArea: dstPa, versionId: dstVersion, signal })
            if (keyRows.length > 0 && keyNames.length > 0) {
              const txDel = await getTransactionId(connection, session, {
                transactionName: 'ibp-bom-migration-del',
                versionId: dstVersion || BASE_VERSION_ID,
                masterDataTypeId: dstName, planningArea: dstPa, signal,
              })
              for (let c = 0; c < keyRows.length; c += writeChunk) {
                if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                await postTransChunk(connection, session, dstName, txDel, keyRows.slice(c, c + writeChunk), {
                  deleteEntries: true, planningArea: dstPa, versionId: dstVersion, signal, csrf,
                })
              }
              await commitTransaction(connection, session, txDel, { signal, csrf })
              await waitForProcessed(connection, session, txDel, { timeoutMs: Math.min(1800000, Math.max(120000, keyRows.length * 4)), signal })
            }
          }

          if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })

          // ── Load source (upsert) — idempotent transaction-level retry ──
          // A chunk is NEVER re-POSTed inside a live transaction (that would
          // stage a duplicate key → SAP error 119 → both copies rejected). If a
          // POST fails transiently we ABANDON the uncommitted transaction (SAP
          // treats it as non-existent) and re-stage everything in a FRESH one.
          // Only data that was read once is ever committed → "llega solo lo que
          // se leyó del origen".
          // Business keys for a stable $orderby (deterministic pagination). Best-effort.
          let srcKeys = []
          try { srcKeys = await fetchKeyNames(srcConn, srcSession, srcName, { planningArea: srcPa, versionId: srcVersion, signal }) } catch { /* read unordered */ }

          setProgress(p => ({ ...p, totalRows }))
          const pages = Math.ceil(totalRows / readPage) || 1

          for (let attempt = 1; ; attempt++) {
            if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
            loadedRows = 0
            try {
              txId = await getTransactionId(connection, session, {
                transactionName: 'ibp-bom-migration',
                versionId: dstVersion || BASE_VERSION_ID,
                masterDataTypeId: dstName, planningArea: dstPa, signal,
              })

              // Best-effort: enable server-side parallel processing (must not abort the run).
              try { await initiateParallelProcess(connection, session, txId, { planningArea: dstPa, versionId: dstVersion, masterDataTypeId: dstName, signal }) } catch { /* ignore */ }

              for (let pageOffset = 0; pageOffset < pages; pageOffset += PARALLEL_R) {
                if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })

                // Read up to PARALLEL_R pages simultaneously (from the SOURCE table)
                const batchPageCount = Math.min(PARALLEL_R, pages - pageOffset)
                const readBatch = Array.from({ length: batchPageCount }, (_, i) =>
                  readEntityPage(srcConn, srcSession, srcName, {
                    skip: (pageOffset + i) * readPage,
                    top: readPage,
                    planningArea: srcPa,
                    versionId: srcVersion,
                    select: selectFields,
                    orderby: srcKeys,
                    signal,
                  })
                )
                setProgress(p => ({ ...p, phase: 'reading' }))
                const pageResults = await Promise.all(readBatch)
                const batchRows = pageResults.flat()
                if (batchRows.length === 0) break

                // Project to common fields (field mapping A): drop fields the destination
                // doesn't have, so SAP won't reject the POST with "Property X is invalid".
                const projected = batchRows.map(r => projectRow(srcName, r))

                // Split into adaptive-size chunks, write PARALLEL_W at a time
                const chunks = []
                for (let c = 0; c < projected.length; c += writeChunk) {
                  chunks.push(projected.slice(c, c + writeChunk))
                }

                setProgress(p => ({ ...p, phase: 'writing' }))
                for (let ci = 0; ci < chunks.length; ci += PARALLEL_W) {
                  if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
                  const writeBatch = chunks.slice(ci, ci + PARALLEL_W)
                  await Promise.all(writeBatch.map(chunk =>
                    postTransChunk(connection, session, dstName, txId, chunk, {
                      deleteEntries: false,
                      planningArea: dstPa,
                      versionId: dstVersion,
                      signal, csrf,
                    })
                  ))
                }

                loadedRows += batchRows.length
                // Throttle row-count re-renders to 500 ms; always update on the last page batch.
                const isLastBatch = pageOffset + PARALLEL_R >= pages
                const now = Date.now()
                if (isLastBatch || now - lastProgressUpdateRef.current >= 500) {
                  lastProgressUpdateRef.current = now
                  setProgress(p => ({ ...p, rows: loadedRows }))
                }
              }

              if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })

              setProgress(p => ({ ...p, phase: 'committing' }))
              await commitTransaction(connection, session, txId, { signal, csrf })
              break   // staged + committed without resending any chunk
            } catch (e) {
              if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) throw e
              const transient = e?.status == null || e.status >= 500   // network/timeout or 5xx
              if (transient && attempt < MAX_LOAD_ATTEMPTS) {
                // Abandon the uncommitted transaction and retry from scratch with a fresh one.
                setProgress(p => ({ ...p, phase: 'retrying' }))
                await new Promise(r => setTimeout(r, 1500 * attempt))
                continue
              }
              throw e
            }
          }

          // SAP commits asynchronously — wait until it finishes applying before
          // reading messages or counting, otherwise we'd see stale data. The
          // timeout scales with row count (large tables take longer to process).
          setProgress(p => ({ ...p, phase: 'processing' }))
          const procStatus = await waitForProcessed(connection, session, txId, { timeoutMs: Math.min(1800000, Math.max(120000, totalRows * 4)), signal })

          setProgress(p => ({ ...p, phase: 'messages' }))
          const messages  = await readMessages(connection, session, dstName, txId, { signal })
          const errorMsgs = messages.filter(m => ['E', 'A'].includes(m.Severity))

          // Count destination AFTER processing. If the status wasn't confirmed
          // PROCESSED, retry a few times while the count catches up.
          let dstAfter = null
          const attempts = procStatus === 'PROCESSED' ? 1 : 3
          for (let a = 0; a < attempts; a++) {
            if (a > 0) await new Promise(r => setTimeout(r, 2500))
            try {
              dstAfter = await fetchCount(connection, session, dstName, { planningArea: dstPa, versionId: dstVersion || BASE_VERSION_ID, signal })
            } catch { dstAfter = null }
            if (dstAfter != null) break
          }

          // Honest counts reflect what SAP IBP actually reported, not the source
          // count: rejected = rows SAP refused (one message per rejected row);
          // sent = rows read from source AND staged (each exactly once now).
          const rejected = errorMsgs.length
          const sent     = loadedRows

          // Status mirrors the IBP job outcome:
          //   ERROR              → error
          //   PROCESSED, 0 rej.  → ok ("Migrado")
          //   PROCESSED, rej.>0  → warning ("Procesado con errores")
          //   couldn't confirm   → processing (still applying in SAP)
          let status
          if (procStatus === 'ERROR')          status = 'error'
          else if (procStatus === 'PROCESSED') status = rejected > 0 ? 'warning' : 'ok'
          else                                 status = 'processing'

          pushResult({
            mdt: srcName, dstName, unverified, txId, procStatus,
            status,
            total:    sent,
            ok:       Math.max(0, sent - rejected),
            errors:   rejected,
            messages: errorMsgs,   // kept for detail panel
            dstBefore, dstAfter,
          })
        } catch (e) {
          // Cancellation: explicit flag, an aborted request, or the cancel ref set.
          if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) {
            pushResult({ mdt: srcName, dstName, unverified, status: 'cancelled', total: loadedRows, ok: 0, errors: 0, txId, dstBefore, dstAfter: null })
            break
          }
          pushResult({ mdt: srcName, dstName, unverified, status: 'error', total: loadedRows, ok: 0, errors: 1, txId, errorMsg: errText(e), dstBefore, dstAfter: null })
        }
      }
    } finally {
      setRunning(false)
      setProgress(null)
      setResults(allResults)

      const totalRowsMigrated = allResults.reduce((s, r) => s + (r.total || 0), 0)
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
        totalRows: totalRowsMigrated,
        status: overallStatus,
      }
      const updated = [entry, ...loadHistory(connection.id)].slice(0, 50)
      saveHistory(connection.id, updated)
      setHistory(updated)
    }
  }, [srcConn, srcSession, srcPa, srcVersion, dstPa, dstVersion, mdtOrder, resolveDst, deleteEntries, connection, session])

  // ── Derived ──
  const canMigrate = !running && !!srcConn && !!srcSession && !!srcPa && !!dstPa && mdtOrder.length > 0
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

  // Result status → label / colour / icon (shared by results table and step panel).
  const statusLabel = s => s === 'ok' ? t('mig.statusOk') : s === 'error' ? t('mig.statusError')
    : s === 'warning' ? t('mig.statusWarning')
    : s === 'processing' ? t('mig.statusProcessing') : t('mig.statusCancelled')
  const statusColor = s => s === 'ok' ? 'var(--green)' : s === 'error' ? 'var(--red)'
    : s === 'warning' ? 'var(--yellow, #e6a817)'
    : s === 'processing' ? 'var(--yellow, #e6a817)' : 'var(--text3)'
  const statusIcon  = s => s === 'ok' ? '✓' : s === 'error' ? '✕' : s === 'warning' ? '⚠'
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
                onClick={() => setConnsTick(n => n + 1)}
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
                  <option key={c.id} value={c.id}>{c.name}</option>
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
                onClick={() => { setMdtOrder([]); setMdtMapping({}) }}>
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
                return (
                  <div
                    key={mdt}
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
                    <select
                      value={resolveDst(mdt)}
                      draggable={false}
                      onPointerDown={e => e.stopPropagation()}
                      onChange={e => setMdtMapping(prev => ({ ...prev, [mdt]: e.target.value }))}
                      title={resolveDst(mdt) === mdt ? '' : t('mig.mappedTo')}
                      style={{
                        ...SELECT, flex: 1, minWidth: 0, fontSize: 11, padding: '3px 6px',
                        fontFamily: 'var(--mono)',
                        borderColor: resolveDst(mdt) === mdt ? 'var(--border)' : 'var(--accent)',
                      }}
                    >
                      {dstCandidates.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
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
        </div>
      )}

      {/* ── Progress (step list — every selected table with its live status) ── */}
      {running && (
        <div style={{ ...SECTION, background: 'color-mix(in srgb, var(--accent) 5%, var(--bg2))' }}>
          <div style={{ ...SECTION_HDR, marginBottom: 10 }}>
            {t('mig.progressTitle', { cur: progress?.datasetCur || 0, total: mdtOrder.length })}
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
                    </div>
                  )}
                  {isCurrent && progress.totalRows > 0 && (
                    <div style={{ marginLeft: 22, marginTop: 5 }}>
                      <div style={{ background: 'var(--border)', borderRadius: 4, height: 5, overflow: 'hidden', marginBottom: 3 }}>
                        <div style={{
                          background: 'var(--accent)', height: '100%', borderRadius: 4,
                          width: `${Math.min(100, (progress.rows / progress.totalRows) * 100)}%`,
                          transition: 'width .3s',
                        }} />
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                        {t('mig.progressRows', { rows: progress.rows.toLocaleString(), total: progress.totalRows.toLocaleString() })}
                      </div>
                    </div>
                  )}
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
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={TH}>{t('mig.colMdt')}</th>
                <th style={TH}>{t('mig.colStatus')}</th>
                <th style={TH}>{t('mig.colTotal')}</th>
                <th style={TH}>{t('mig.colOk')}</th>
                <th style={TH}>{t('mig.colErrors')}</th>
                <th style={TH}>{t('mig.colDst')}</th>
                <th style={TH}>{t('mig.colTxId')}</th>
              </tr>
            </thead>
            <tbody>
              {results.map(r => {
                const isExpanded = expandedMdt === r.mdt
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
                      <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text3)', fontSize: 10 })}>{r.txId || '—'}</td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${r.mdt}-detail`}>
                        <td colSpan={7} style={{ padding: '0 0 8px 24px', borderBottom: '1px solid var(--border)' }}>
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
                style={isProd ? { ...btnPrimary(false), background: 'var(--red)', color: '#fff' } : btnPrimary(false)}
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
