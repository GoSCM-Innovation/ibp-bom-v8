import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useI18n } from '../../context/I18nContext'
import { getAll } from '../../services/connectionStorage'
import { getSession, setSession } from '../../services/sessionStorage'
import {
  fetchVsmt, buildCatalog,
  fetchCount, readEntityPage,
  getTransactionId, initiateParallelProcess, postTransChunk,
  commitTransaction, getExportResult, readMessages,
  PAGE_SIZE, CHUNK_SIZE, PARALLEL_R, PARALLEL_W,
} from '../../services/masterDataApi'

// Parse a count that may arrive as string or number; returns null if invalid.
function parseCount(v) {
  if (v == null) return null
  const n = parseInt(v, 10)
  return isNaN(n) ? null : n
}

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

// ── Component ─────────────────────────────────────────────────────────────────

export default function Migration({ connection, session }) {
  const { t } = useI18n()

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

  // ── PA / Version selectors ──
  const [srcPa, setSrcPa]         = useState('')
  const [srcVersion, setSrcVersion] = useState('')
  const [dstPa, setDstPa]         = useState('')
  const [dstVersion, setDstVersion] = useState('')

  // ── MDT selection ──
  const [mdtSearch, setMdtSearch]     = useState('')
  const [selectedMdts, setSelectedMdts] = useState(new Set())

  // ── Options ──
  const [deleteEntries, setDeleteEntries] = useState(true)

  // ── Run state ──
  const cancelledRef          = useRef(false)
  const lastProgressUpdateRef = useRef(0)       // throttle: ms timestamp of last row-count update
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults]   = useState(null)

  // ── Error detail expand ──
  const [expandedMdt, setExpandedMdt] = useState(null)

  // ── Preview ──
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewData, setPreviewData]       = useState(null)

  // ── Production confirmation ──
  const [showConfirm, setShowConfirm] = useState(false)

  // ── Cancel confirmation (mid-run) ──
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // ── Extra MDTs (comma-separated, for types only in __BASE) ──
  const [extraMdts, setExtraMdts] = useState('')

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
  useEffect(() => { setSrcPa(''); setSrcVersion(''); setSelectedMdts(new Set()) }, [srcCatalog])
  useEffect(() => { setDstPa(''); setDstVersion(''); setSelectedMdts(new Set()) }, [dstCatalog])
  useEffect(() => { setSelectedMdts(new Set()) }, [srcPa, srcVersion, dstPa, dstVersion])

  // ── Available MDTs (intersection) ──
  const srcMdts = useMemo(() => getMdts(srcCatalog, srcPa, srcVersion), [srcCatalog, srcPa, srcVersion])
  const dstMdts = useMemo(() => getMdts(dstCatalog, dstPa, dstVersion), [dstCatalog, dstPa, dstVersion])
  const availableMdts = useMemo(() => {
    if (!srcPa || !dstPa) return []
    const dstSet = new Set(dstMdts)
    const base  = srcMdts.filter(m => dstSet.has(m))
    const extra = extraMdts.split(',').map(s => s.trim()).filter(s => s && !base.includes(s))
    return [...new Set([...base, ...extra])].sort()
  }, [srcMdts, dstMdts, srcPa, dstPa, extraMdts])

  const filteredMdts = useMemo(() =>
    availableMdts.filter(m => !mdtSearch || m.toLowerCase().includes(mdtSearch.toLowerCase())),
    [availableMdts, mdtSearch]
  )

  // ── Source inline login ──
  async function handleSrcLogin(e) {
    e.preventDefault()
    if (!srcLoginForm.user)     { setSrcLoginError(t('login.errUserRequired', { name: 'SAP_COM_0720' })); return }
    if (!srcLoginForm.password) { setSrcLoginError(t('login.errPwdRequired',  { name: 'SAP_COM_0720' })); return }
    setSrcLoginLoading(true)
    setSrcLoginError('')
    try {
      const serviceRoot = srcConn.com0720.url
      const resp = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: serviceRoot + '/$metadata',
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
  function handleMigrateClick() {
    const isProd = ['Producción', 'Production'].includes(connection.ambiente)
    if (isProd) { setShowConfirm(true); return }
    runMigration()
  }

  const runMigration = useCallback(async () => {
    setShowConfirm(false)
    setRunning(true)
    setResults(null)
    cancelledRef.current = false

    const mdtList = [...selectedMdts].sort()
    const allResults = []

    try {
      for (let di = 0; di < mdtList.length; di++) {
        if (cancelledRef.current) break
        const mdt = mdtList[di]

        setProgress({ datasetCur: di + 1, datasetTotal: mdtList.length, datasetName: mdt, rows: 0, totalRows: 0, phase: 'reading' })

        let totalRows = 0
        let txId = null

        try {
          totalRows = await fetchCount(srcConn, srcSession, mdt, { planningArea: srcPa, versionId: srcVersion })
          txId = await getTransactionId(connection, session, {
            transactionName: 'ibp-bom-migration',
            versionId: dstVersion || '__BASE',
            masterDataTypeId: mdt,
            planningArea: dstPa,
          })
          // Best-effort: enable server-side parallel processing. Silently skipped if unsupported.
          await initiateParallelProcess(connection, session, txId)
        } catch (e) {
          allResults.push({ mdt, status: 'error', total: 0, ok: 0, errors: 1, txId: null, errorMsg: e.message })
          continue
        }

        setProgress(p => ({ ...p, totalRows }))

        const pages = Math.ceil(totalRows / PAGE_SIZE) || 1
        let loadedRows = 0

        try {
          for (let pageOffset = 0; pageOffset < pages; pageOffset += PARALLEL_R) {
            if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })

            // Read up to PARALLEL_R pages simultaneously
            const batchPageCount = Math.min(PARALLEL_R, pages - pageOffset)
            const readBatch = Array.from({ length: batchPageCount }, (_, i) =>
              readEntityPage(srcConn, srcSession, mdt, {
                skip: (pageOffset + i) * PAGE_SIZE,
                top: PAGE_SIZE,
                planningArea: srcPa,
                versionId: srcVersion,
              })
            )
            setProgress(p => ({ ...p, phase: 'reading' }))
            const pageResults = await Promise.all(readBatch)
            const batchRows = pageResults.flat()
            if (batchRows.length === 0) break

            // Split into CHUNK_SIZE chunks, write PARALLEL_W at a time
            const chunks = []
            for (let c = 0; c < batchRows.length; c += CHUNK_SIZE) {
              chunks.push(batchRows.slice(c, c + CHUNK_SIZE))
            }

            setProgress(p => ({ ...p, phase: 'writing' }))
            for (let ci = 0; ci < chunks.length; ci += PARALLEL_W) {
              if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
              const writeBatch = chunks.slice(ci, ci + PARALLEL_W)
              await Promise.all(writeBatch.map((chunk, bi) =>
                postTransChunk(connection, session, mdt, txId, chunk, {
                  deleteEntries: deleteEntries && pageOffset === 0 && ci === 0 && bi === 0,
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
          await commitTransaction(connection, session, txId)

          setProgress(p => ({ ...p, phase: 'messages' }))
          // GetExportResult: server-side aggregate counts (best-effort, null if unsupported)
          const exportResult = await getExportResult(connection, session, txId)
          const serverTotal  = parseCount(exportResult?.TotalCount   ?? exportResult?.RecordsTotal)
          const serverOk     = parseCount(exportResult?.SuccessCount ?? exportResult?.RecordsSuccessful)
          const serverErrors = parseCount(exportResult?.ErrorCount   ?? exportResult?.RecordsError)

          const messages  = await readMessages(connection, session, mdt, txId)
          const errorMsgs = messages.filter(m => ['E', 'A'].includes(m.Severity))

          const resolvedErrors = serverErrors ?? errorMsgs.length
          allResults.push({
            mdt, txId,
            status:   resolvedErrors > 0 ? 'error' : 'ok',
            total:    serverTotal  ?? totalRows,
            ok:       serverOk     ?? (totalRows - errorMsgs.length),
            errors:   resolvedErrors,
            messages: errorMsgs,   // kept for detail panel (Commit 5)
          })
        } catch (e) {
          if (e.isCancelled) {
            allResults.push({ mdt, status: 'cancelled', total: totalRows, ok: 0, errors: 0, txId })
            break
          }
          allResults.push({ mdt, status: 'error', total: totalRows, ok: 0, errors: 1, txId, errorMsg: e.message })
        }
      }
    } finally {
      setRunning(false)
      setProgress(null)
      setResults(allResults)

      const totalRowsMigrated = allResults.reduce((s, r) => s + (r.total || 0), 0)
      const overallStatus = allResults.some(r => r.status === 'cancelled') ? 'cancelled'
        : allResults.some(r => r.status === 'error') ? 'error' : 'ok'
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
  }, [srcConn, srcSession, srcPa, srcVersion, dstPa, dstVersion, selectedMdts, deleteEntries, connection, session])

  // ── Derived ──
  const canMigrate = !running && !!srcConn && !!srcSession && !!srcPa && !!dstPa && selectedMdts.size > 0
  const oneSel     = !running && selectedMdts.size === 1

  const PHASE_LABEL = {
    reading:    t('mig.phaseReading'),
    writing:    t('mig.phaseWriting'),
    committing: t('mig.phaseCommitting'),
    messages:   t('mig.phaseMessages'),
  }

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
              {selectedMdts.size > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {t('mig.mdtCountSelected', { n: selectedMdts.size })}
                </span>
              )}
              <button style={{ ...BTN_SEC, padding: '4px 10px', fontSize: 11 }}
                onClick={() => setSelectedMdts(new Set(availableMdts))}>
                {t('mig.mdtSelectAll')}
              </button>
              <button style={{ ...BTN_SEC, padding: '4px 10px', fontSize: 11 }}
                onClick={() => setSelectedMdts(new Set())}>
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

          <div style={{ marginBottom: 10 }}>
            <label style={LABEL}>{t('mig.extraMdtLabel')}</label>
            <input
              style={INPUT}
              placeholder={t('mig.extraMdtPlaceholder')}
              value={extraMdts}
              onChange={e => setExtraMdts(e.target.value)}
            />
          </div>

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
                    checked={selectedMdts.has(mdt)}
                    onChange={e => setSelectedMdts(prev => {
                      const n = new Set(prev)
                      e.target.checked ? n.add(mdt) : n.delete(mdt)
                      return n
                    })}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)', flex: 1 }}>{mdt}</span>
                  {oneSel && selectedMdts.has(mdt) && (
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
        </div>
      )}

      {/* ── Options ── */}
      {srcPa && dstPa && selectedMdts.size > 0 && (
        <div style={{ ...SECTION, opacity: running ? 0.5 : 1, pointerEvents: running ? 'none' : 'auto' }}>
          <div style={SECTION_HDR}>{t('mig.sectionOptions')}</div>
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
            <button style={btnPrimary(!canMigrate)} disabled={!canMigrate} onClick={handleMigrateClick}>
              {t('mig.migrateBtn')}
            </button>
          )}
        </div>
      )}

      {/* ── Progress ── */}
      {running && progress && (
        <div style={{ ...SECTION, background: 'color-mix(in srgb, var(--accent) 5%, var(--bg2))' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            {t('mig.progressDataset', { cur: progress.datasetCur, total: progress.datasetTotal, name: progress.datasetName })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 8 }}>
            {PHASE_LABEL[progress.phase] || ''}
          </div>
          {progress.totalRows > 0 && (
            <>
              <div style={{ background: 'var(--border)', borderRadius: 4, height: 6, overflow: 'hidden', marginBottom: 6 }}>
                <div style={{
                  background: 'var(--accent)', height: '100%', borderRadius: 4,
                  width: `${Math.min(100, (progress.rows / progress.totalRows) * 100)}%`,
                  transition: 'width .3s',
                }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                {t('mig.progressRows', { rows: progress.rows.toLocaleString(), total: progress.totalRows.toLocaleString() })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {results && (
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
                      <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text)' })}>{r.mdt}</td>
                      <td style={td({ fontWeight: 600, color: r.status === 'ok' ? 'var(--green)' : r.status === 'error' ? 'var(--red)' : 'var(--text3)' })}>
                        {r.status === 'ok' ? t('mig.statusOk') : r.status === 'error' ? t('mig.statusError') : t('mig.statusCancelled')}
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
                      <td style={td({ fontFamily: 'var(--mono)', color: 'var(--text3)', fontSize: 10 })}>{r.txId || '—'}</td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${r.mdt}-detail`}>
                        <td colSpan={6} style={{ padding: '0 0 8px 24px', borderBottom: '1px solid var(--border)' }}>
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
                        <td style={td({ fontWeight: 600, color: h.status === 'ok' ? 'var(--green)' : h.status === 'error' ? 'var(--red)' : 'var(--text3)' })}>
                          {h.status === 'ok' ? t('mig.statusOk') : h.status === 'error' ? t('mig.statusError') : t('mig.statusCancelled')}
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
                      {t('mig.previewCount', { count: previewData.count.toLocaleString() })}
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
                                  {row[c] ?? ''}
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
                onClick={() => { cancelledRef.current = true; setShowCancelConfirm(false) }}
              >
                {t('mig.cancelConfirmStop')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Production confirmation modal ── */}
      {showConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'var(--overlay)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)',
            borderRadius: 12, padding: 28, width: 420, maxWidth: '90vw',
            boxShadow: 'var(--shadow-lg)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>
              {t('mig.confirmTitle')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 22 }}>
              {t('mig.confirmMsg', { name: connection.name })}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button style={BTN_SEC} onClick={() => setShowConfirm(false)}>
                {t('mig.confirmCancel')}
              </button>
              <button
                style={{ ...btnPrimary(false), background: 'var(--red)', color: '#fff' }}
                onClick={runMigration}
              >
                {t('mig.confirmBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
