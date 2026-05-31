import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useI18n } from '../../context/I18nContext'
import { getAll } from '../../services/connectionStorage'
import { getSession, setSession } from '../../services/sessionStorage'
import { setMigrationGuard } from '../../services/migrationGuard'
import {
  fetchKfCatalog, planningServiceRoot,
  countKf, readKfPage, detectConversion,
  fetchCsrf, getTransactionId, initiateParallelProcess, postKfChunk,
  commitTransaction, waitForProcessed, readMessages,
  odataDateToIso, rowsPerChunk, PARALLEL_R, PARALLEL_W,
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

  // ── Catalogs ──
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

  // ── Run state ──
  const cancelledRef = useRef(false)
  const abortRef     = useRef(null)
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults]   = useState(null)
  const [expanded, setExpanded] = useState(null)

  // ── Load destination catalog on mount ──
  useEffect(() => {
    let alive = true
    setDstLoading(true); setCatError('')
    fetchKfCatalog(connection, session)
      .then(c => { if (alive) setDstCat(c) })
      .catch(e => { if (alive) setCatError(t('kfm.catErr', { msg: errText(e) })) })
      .finally(() => { if (alive) setDstLoading(false) })
    return () => { alive = false }
  }, [connection.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load source catalog when source session is available ──
  useEffect(() => {
    if (!srcConn || !srcSession) { setSrcCat(null); return }
    let alive = true
    setSrcLoading(true); setCatError('')
    fetchKfCatalog(srcConn, srcSession)
      .then(c => { if (alive) setSrcCat(c) })
      .catch(e => { if (alive) setCatError(t('kfm.catErr', { msg: errText(e) })) })
      .finally(() => { if (alive) setSrcLoading(false) })
    return () => { alive = false }
  }, [srcConnId, srcTempCreds?.user]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Leave guard while running ──
  useEffect(() => { setMigrationGuard(running, t('mig.leaveWarning')); return () => setMigrationGuard(false) }, [running, t])
  useEffect(() => () => { cancelledRef.current = true; abortRef.current?.abort() }, [])

  // Reset selections when catalogs change
  useEffect(() => { setLevelAttrs([]); setSteps([]); setAttrMap({}) }, [dstCat])

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
  const canMigrate = !running && !!srcConn && !!srcSession && !!dstCat && !!srcCat &&
    levelAttrs.length > 0 && steps.length > 0 && steps.every(s => s.srcKf) && unmappedAttrs.length === 0

  const runMigration = useCallback(async () => {
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

      for (let i = 0; i < steps.length; i++) {
        if (cancelledRef.current) break
        const { dstKf, srcKf } = steps[i]
        const label = srcKf === dstKf ? dstKf : `${srcKf} → ${dstKf}`
        setProgress({ cur: i + 1, total: steps.length, name: label, rows: 0, totalRows: 0, phase: 'detect' })

        // Source/destination column lists (root attrs mapped to each side) + time + KF.
        const srcLevelCols = levelAttrs.map(resolveSrcAttr)
        const dstLevelCols = [...levelAttrs]

        try {
          // Conversion attribute required by this KF (UOM / currency).
          const conv = await detectConversion(srcConn, srcSession, srcPa, srcKf, { signal })
          // For 'misma UOM' we read in the product's base unit by not forcing a target;
          // SAP still requires the attribute present — request it so the read is valid.
          const convAttr = conv === 'UOM' ? 'UOMTOID' : conv === 'CURR' ? 'CURRTOID' : null

          const srcSelect = [...srcLevelCols, srcKf, timeField, ...(convAttr ? [convAttr] : [])].join(',')
          // Source $filter: version + (added below) the required conversion unit.
          let filter = srcVersion ? `VERSIONID eq '${srcVersion}'` : ''

          if (convAttr) {
            // Without a concrete UOM/CURR SAP rejects the read. We pick the most common
            // value by sampling one row, then read everything in that unit (misma UOM).
            const sample = await readKfPage(srcConn, srcSession, srcPa, {
              select: [...srcLevelCols, srcKf, timeField, convAttr].join(','),
              filter: filter || undefined, skip: 0, top: 1, signal,
            }).catch(() => [])
            const unit = sample[0]?.[convAttr]
            if (!unit) {
              push({ kf: dstKf, srcKf, status: 'error', total: 0, ok: 0, errors: 1, errorMsg: t('kfm.errNoUnit', { kf: srcKf }) })
              continue
            }
            filter += `${filter ? ' and ' : ''}${convAttr} eq '${unit}'`
            srcLevelCols.push(convAttr)  // carry the unit so the value matches on write context
          }

          // Count (safe: small top, never 0)
          setProgress(p => ({ ...p, phase: 'count' }))
          const totalRows = await countKf(srcConn, srcSession, srcPa, { select: srcSelect, filter: filter || undefined, signal })
          setProgress(p => ({ ...p, totalRows }))

          // Transaction
          const txId = await getTransactionId(connection, session, { signal })
          try { await initiateParallelProcess(connection, session, txId, { planningArea: dstPa, versionId: dstVersion }) } catch { /* best-effort */ }

          const dstFields = [...dstLevelCols, dstKf, timeField].join(',')
          const chunkRows = rowsPerChunk(1)   // one KF per step
          const pageSize  = 5000
          const pages = Math.max(1, Math.ceil(totalRows / pageSize))
          let loaded = 0, errors = 0
          const errMsgsAll = []

          for (let pg = 0; pg < pages; pg += PARALLEL_R) {
            if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
            setProgress(p => ({ ...p, phase: 'reading' }))
            const batch = Array.from({ length: Math.min(PARALLEL_R, pages - pg) }, (_, j) =>
              readKfPage(srcConn, srcSession, srcPa, { select: srcSelect, filter: filter || undefined, skip: (pg + j) * pageSize, top: pageSize, signal })
            )
            const rowsRead = (await Promise.all(batch)).flat()
            if (rowsRead.length === 0) break

            // Project each row to the destination write shape: root attrs (renamed) +
            // time (ISO) + KF (renamed). Derived attrs are NOT sent (destination fills them).
            const projected = rowsRead.map(r => {
              const o = {}
              for (const dstA of dstLevelCols) {
                const srcA = resolveSrcAttr(dstA)
                o[dstA] = r[srcA] ?? ''
              }
              o[timeField] = odataDateToIso(r[timeField])
              o[dstKf] = r[srcKf] ?? '0'
              return o
            })

            setProgress(p => ({ ...p, phase: 'writing' }))
            const chunks = []
            for (let c = 0; c < projected.length; c += chunkRows) chunks.push(projected.slice(c, c + chunkRows))
            for (let ci = 0; ci < chunks.length; ci += PARALLEL_W) {
              if (cancelledRef.current) throw Object.assign(new Error('cancelled'), { isCancelled: true })
              await Promise.all(chunks.slice(ci, ci + PARALLEL_W).map(chunk =>
                postKfChunk(connection, session, dstPa, txId, chunk, { fields: dstFields, versionId: dstVersion, doCommit: false, signal, csrf })
              ))
            }
            loaded += rowsRead.length
            setProgress(p => ({ ...p, rows: loaded }))
          }

          setProgress(p => ({ ...p, phase: 'committing' }))
          await commitTransaction(connection, session, txId, { signal, csrf })
          setProgress(p => ({ ...p, phase: 'processing' }))
          const status = await waitForProcessed(connection, session, txId, { timeoutMs: Math.min(1800000, Math.max(120000, totalRows * 3)), signal })
          const msgs = await readMessages(connection, session, dstPa, txId, { signal })
          errors = msgs.length
          errMsgsAll.push(...msgs)

          push({
            kf: dstKf, srcKf, txId,
            status: errors > 0 || status === 'PROCESSED_WITH_ERRORS' || status === 'ERROR' ? 'error'
                  : status === 'PROCESSED' ? 'ok' : 'processing',
            total: loaded, ok: loaded - errors, errors, messages: errMsgsAll,
          })
        } catch (e) {
          if (e.isCancelled || e.name === 'AbortError' || cancelledRef.current) {
            push({ kf: dstKf, srcKf, status: 'cancelled', total: 0, ok: 0, errors: 0 }); break
          }
          // Calculated KF detection surfaces here.
          const msg = e.isCalculated ? t('kfm.errCalculated', { kf: e.calculatedKf || dstKf }) : errText(e)
          push({ kf: dstKf, srcKf, status: 'error', total: 0, ok: 0, errors: 1, errorMsg: msg })
        }
      }
    } finally {
      setRunning(false); setProgress(null); setResults(all)
    }
  }, [connection, session, srcConn, srcSession, dstCat, srcCat, steps, levelAttrs, dstVersion, srcVersion, timeField, resolveSrcAttr]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusLabel = s => s === 'ok' ? t('kfm.stOk') : s === 'error' ? t('kfm.stErr') : s === 'processing' ? t('kfm.stProc') : t('kfm.stCancel')
  const statusColor = s => s === 'ok' ? 'var(--green)' : s === 'error' ? 'var(--red)' : s === 'processing' ? 'var(--yellow, #e6a817)' : 'var(--text3)'
  const PHASE = { detect: t('kfm.phDetect'), count: t('kfm.phCount'), reading: t('kfm.phReading'), writing: t('kfm.phWriting'), committing: t('kfm.phCommit'), processing: t('kfm.phProcessing') }

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
                <label style={LABEL}>{t('kfm.srcVersion')}</label>
                {srcLoading ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>{t('kfm.loadingCat')}</div> : (
                  <select style={SELECT} value={srcVersion} onChange={e => setSrcVersion(e.target.value)}>
                    <option value="">{t('kfm.baseVersion')}</option>
                    {(srcCat?.versions || []).filter(v => v.id && v.id !== '__BASELINE').map(v => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
                  </select>
                )}
                {srcCat && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>{t('kfm.areaIs', { pa: srcCat.pa })}</div>}
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
              <label style={LABEL}>{t('kfm.dstVersion')}</label>
              {dstLoading ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>{t('kfm.loadingCat')}</div> : (
                <select style={SELECT} value={dstVersion} onChange={e => setDstVersion(e.target.value)}>
                  <option value="">{t('kfm.baseVersion')}</option>
                  {(dstCat?.versions || []).filter(v => v.id && v.id !== '__BASELINE').map(v => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
                </select>
              )}
              {dstCat && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>{t('kfm.areaIs', { pa: dstCat.pa })}</div>}
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
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={SECTION_HDR}>{t('kfm.sectionKf', { n: steps.length })}</div>
          </div>
          <input style={{ ...INPUT, marginBottom: 8 }} placeholder={t('kfm.kfSearch')} value={kfSearch} onChange={e => setKfSearch(e.target.value)} />
          <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filteredKfs.slice(0, 300).map(k => {
              const idx = steps.findIndex(s => s.dstKf === k)
              const sel = idx >= 0
              return (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '3px 2px' }} title={dstCat.labels?.[k] || k}>
                  <input type="checkbox" checked={sel} onChange={e => {
                    if (e.target.checked) setSteps(p => [...p, { dstKf: k, srcKf: defaultSrcKf(k) }])
                    else setSteps(p => p.filter(s => s.dstKf !== k))
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

      {/* ── Action bar ── */}
      {dstCat && srcCat && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
          {running ? (
            <button style={BTN_DANGER} onClick={() => { cancelledRef.current = true; abortRef.current?.abort() }}>{t('kfm.cancelBtn')}</button>
          ) : (
            <button style={btnPrimary(!canMigrate)} disabled={!canMigrate} onClick={runMigration}>{t('kfm.migrateBtn')}</button>
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
    </div>
  )
}
