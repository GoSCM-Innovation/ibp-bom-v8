import { useState, useEffect, useCallback } from 'react'
import { formatSapTs, parseSapTs } from '../../utils/dateUtils'

const MSG_STYLE = {
  A: { label: 'Abort',   color: '#ff6b6b', bg: 'rgba(255,107,107,.08)' },
  E: { label: 'Error',   color: '#ff6b6b', bg: 'rgba(255,107,107,.08)' },
  W: { label: 'Warning', color: '#fbbf24', bg: 'rgba(251,191,36,.08)'  },
  I: { label: 'Info',    color: '#3b82f6', bg: 'rgba(59,130,246,.08)'  },
  S: { label: 'Success', color: '#22c55e', bg: 'rgba(34,197,94,.08)'   },
}

const SEV_STYLE = {
  S: { color: '#22c55e', bg: 'rgba(34,197,94,.12)',   border: 'rgba(34,197,94,.3)'   },
  W: { color: '#fbbf24', bg: 'rgba(251,191,36,.12)',  border: 'rgba(251,191,36,.3)'  },
  E: { color: '#ff6b6b', bg: 'rgba(255,107,107,.12)', border: 'rgba(255,107,107,.3)' },
  A: { color: '#ff6b6b', bg: 'rgba(255,107,107,.12)', border: 'rgba(255,107,107,.3)' },
  I: { color: '#3b82f6', bg: 'rgba(59,130,246,.12)',  border: 'rgba(59,130,246,.3)'  },
}

function enc(val) {
  return `%27${encodeURIComponent(val)}%27`
}

function fmtDuration(ms) {
  if (ms == null || ms < 0 || isNaN(ms)) return null
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const s    = secs % 60
  if (mins < 60) return `${mins}m ${s > 0 ? ` ${s}s` : ''}`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${m > 0 ? ` ${m}m` : ''}`
}

function calcDuration(step, stepsArr, jobEnd) {
  const start = parseSapTs(step.StepStartDateTime)
  if (!start) return null
  const sorted  = [...stepsArr].sort((a, b) => Number(a.StepNumber) - Number(b.StepNumber))
  const idx     = sorted.findIndex(s => Number(s.StepNumber) === Number(step.StepNumber))
  const endTs   = sorted[idx + 1]?.StepStartDateTime ?? jobEnd
  const end     = parseSapTs(endTs)
  if (!end) return null
  return fmtDuration(end - start)
}

export default function StepsPanel({ job, connectionId, statuses, tzMode, onClose }) {
  const [steps,      setSteps]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [expanded,   setExpanded]   = useState(null)
  // logInfos: { [stepNumber]: { loading, records[], error } } — pre-cargado para todos los pasos
  const [logInfos,   setLogInfos]   = useState({})
  // messages: { [stepNumber]: { loading, data[], error } } — lazy al expandir
  const [messages,   setMessages]   = useState({})
  // params: parámetros del job desde JobParamValuesStructGet
  const [params,         setParams]         = useState({ loading: true, data: [], error: '' })
  // paramsExpanded: qué pasos tienen la sección de parámetros abierta
  const [paramsExpanded, setParamsExpanded] = useState({})

  const proxy = useCallback(async (path) => {
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId, path }),
    })
    return res.json()
  }, [connectionId])

  // Parámetros del job (JobParamValuesStructGet) — carga en paralelo con los pasos
  useEffect(() => {
    let cancelled = false
    setParams({ loading: true, data: [], error: '' })
    async function loadParams() {
      try {
        const data = await proxy(
          `/JobParamValuesStructGet?JobName=${enc(job.JobName)}&JobCount=${enc(job.JobRunCount)}`
        )
        if (cancelled) return
        if (data.error) throw new Error(data.error + (data.detail ? '\n' + data.detail : ''))
        setParams({ loading: false, data: data?.d?.results ?? data?.value ?? [], error: '' })
      } catch (e) {
        if (!cancelled) setParams({ loading: false, data: [], error: e.message })
      }
    }
    loadParams()
    return () => { cancelled = true }
  }, [job.JobName, job.JobRunCount, proxy])

  // Fase 1: cargar pasos
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setSteps([]); setExpanded(null); setLogInfos({}); setMessages({})
    async function load() {
      try {
        const data = await proxy(
          `/JobHeaderSet(JobName=${enc(job.JobName)},JobRunCount=${enc(job.JobRunCount)})/JobStepSet`
        )
        if (cancelled) return
        if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
        const results = (data?.d?.results ?? data?.value ?? [])
          .sort((a, b) => (Number(a.StepNumber) || 0) - (Number(b.StepNumber) || 0))
        setSteps(results)
        loadAllLogInfos(results)
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [job.JobName, job.JobRunCount, proxy])

  // Fase 2: cargar JobStepLogInfoSet de todos los pasos con logs en paralelo
  function loadAllLogInfos(stepsArr) {
    const withLogs = stepsArr.filter(s => Number(s.NrOfLogs) > 0)
    if (!withLogs.length) return
    const init = {}
    withLogs.forEach(s => { init[Number(s.StepNumber)] = { loading: true, records: [], error: '' } })
    setLogInfos(init)
    withLogs.forEach(async (step) => {
      const n = Number(step.StepNumber)
      try {
        const data = await proxy(
          `/JobStepSet(JobName=${enc(step.JobName)},JobRunCount=${enc(step.JobRunCount)},StepNumber=${n})/JobStepLogInfoSet`
        )
        if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
        setLogInfos(p => ({ ...p, [n]: { loading: false, records: data?.d?.results ?? data?.value ?? [], error: '' } }))
      } catch (e) {
        setLogInfos(p => ({ ...p, [n]: { loading: false, records: [], error: e.message } }))
      }
    })
  }

  // Fase 3: cuando se expande un paso y sus logInfos ya están listos, cargar mensajes
  const loadMessages = useCallback(async (n, records) => {
    setMessages(p => ({ ...p, [n]: { loading: true, data: [], error: '' } }))
    try {
      const allMsgs = []
      for (const info of records) {
        const data = await proxy(
          `/JobStepLogInfoSet(JobName=${enc(info.JobName)},JobRunCount=${enc(info.JobRunCount)},StepNumber=${Number(info.StepNumber)},LogHandle=${enc(info.LogHandle)})/JobLogMessageSet`
        )
        allMsgs.push(...(data?.d?.results ?? data?.value ?? []))
      }
      setMessages(p => ({ ...p, [n]: { loading: false, data: allMsgs, error: '' } }))
    } catch (e) {
      setMessages(p => ({ ...p, [n]: { loading: false, data: [], error: e.message } }))
    }
  }, [proxy])

  useEffect(() => {
    if (expanded === null) return
    const li = logInfos[expanded]
    if (!li || li.loading || !li.records.length) return
    if (messages[expanded]) return
    loadMessages(expanded, li.records)
  }, [expanded, logInfos, messages, loadMessages])

  function toggleExpand(step) {
    setExpanded(prev => prev === Number(step.StepNumber) ? null : Number(step.StepNumber))
  }

  function statusStyle(code) {
    const s = statuses.find(x => x.JobStatus === code)
    const c = s?.color ?? { bg: 'rgba(156,163,175,.15)', color: '#9ca3af', border: 'rgba(156,163,175,.3)' }
    return { ...c, text: s?.JobStatusText || code || '—' }
  }

  // Suma de conteos de mensajes para un paso (agrega todos sus LogHandles)
  function counts(n) {
    const recs = logInfos[n]?.records ?? []
    const sum  = k => recs.reduce((s, r) => s + (Number(r[k]) || 0), 0)
    return { A: sum('MsgCntA'), E: sum('MsgCntE'), W: sum('MsgCntW'), I: sum('MsgCntI'), S: sum('MsgCntS'), all: sum('MsgCntAll') }
  }

  const jobSt       = statusStyle(job.JobStatus)
  const failedCount = steps.filter(s => ['A', 'U'].includes(s.StepStatus)).length

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 400 }} />

      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(600px, 95vw)',
        background: 'var(--bg)', borderLeft: '1px solid var(--border2)',
        zIndex: 401, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 32px rgba(0,0,0,.4)', animation: 'stepsPanelSlide .2s ease-out',
      }}>

        {/* ── Cabecera del panel ── */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Pasos del job</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {job.JobText || job.JobName}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                {job.JobName} · Run {job.JobRunCount}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: jobSt.bg, color: jobSt.color, border: `1px solid ${jobSt.border}` }}>
                {jobSt.text}
              </span>
              <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', fontSize: 13, cursor: 'pointer', padding: '4px 10px', lineHeight: 1 }}>✕</button>
            </div>
          </div>
          {!loading && steps.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 14, fontSize: 10, color: 'var(--text3)' }}>
              <span>{steps.length} paso{steps.length !== 1 ? 's' : ''}</span>
              <span>{steps.filter(s => s.StepStatus === 'F').length} finalizados</span>
              {failedCount > 0 && <span style={{ color: '#ff6b6b', fontWeight: 700 }}>{failedCount} fallido{failedCount !== 1 ? 's' : ''}</span>}
            </div>
          )}
        </div>

        {/* ── Lista de pasos ── */}
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}>

          {loading &&<div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)', fontSize: 12 }}>Cargando pasos…</div>}
          {error   && <div style={{ background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 8, padding: '12px 16px', color: 'var(--red)', fontSize: 12 }}>✕ {error}</div>}
          {!loading && !error && steps.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)', fontSize: 12 }}>Sin pasos registrados para este job.</div>
          )}

          {steps.map(step => {
            const n       = Number(step.StepNumber)
            const isOpen  = expanded === n
            const st      = statusStyle(step.StepStatus)
            const rcErr   = step.StepAppRC != null && Number(step.StepAppRC) !== 0
            const nrLogs  = Number(step.NrOfLogs) || 0
            const li      = logInfos[n]
            const cnt     = counts(n)
            const dur     = calcDuration(step, steps, job.JobEndDateTime)

            // Primer registro de log info (generalmente 1 por paso)
            const liRec   = li?.records?.[0]

            return (
              <div key={n} style={{
                marginBottom: 8, borderRadius: 8, overflow: 'hidden',
                border: `1px solid ${isOpen ? 'var(--border2)' : 'var(--border)'}`,
                background: isOpen ? 'var(--bg2)' : 'transparent',
              }}>

                {/* ── Fila del paso ── */}
                <div onClick={() => toggleExpand(step)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }}>

                  {/* Número */}
                  <span style={{
                    width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700, color: 'var(--text2)',
                  }}>{n}</span>

                  {/* Descripción + inicio */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {step.JobCatalogEntryText || step.JobCatalogEntryName || `Paso ${n}`}
                    </div>
                    {step.StepStartDateTime && (
                      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>
                        Inicio: {formatSapTs(step.StepStartDateTime, tzMode)}
                      </div>
                    )}
                  </div>

                  {/* Estado */}
                  <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, flexShrink: 0, background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>
                    {st.text}
                  </span>

                  {/* RC error */}
                  {rcErr && (
                    <span style={{ fontSize: 10, fontWeight: 700, flexShrink: 0, color: '#ff6b6b', background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 4, padding: '2px 6px' }}>
                      RC {step.StepAppRC}
                    </span>
                  )}

                  {/* Duración */}
                  {dur && (
                    <span style={{ fontSize: 10, color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', flexShrink: 0 }}>
                      ⏱ {dur}
                    </span>
                  )}

                  {/* Conteo de mensajes por tipo (solo si cargado y hay logs) */}
                  {nrLogs > 0 && li && !li.loading && (
                    <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                      {(cnt.A + cnt.E) > 0 && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#ff6b6b', background: 'rgba(255,107,107,.12)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 3, padding: '1px 5px' }}>
                          E {cnt.A + cnt.E}
                        </span>
                      )}
                      {cnt.W > 0 && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,.12)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 3, padding: '1px 5px' }}>
                          W {cnt.W}
                        </span>
                      )}
                      {(cnt.A + cnt.E + cnt.W) === 0 && cnt.all > 0 && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,.12)', border: '1px solid rgba(34,197,94,.3)', borderRadius: 3, padding: '1px 5px' }}>
                          ✓ {cnt.all}
                        </span>
                      )}
                    </div>
                  )}
                  {nrLogs > 0 && li?.loading && (
                    <span style={{ fontSize: 9, color: 'var(--text3)' }}>…</span>
                  )}

                  <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0, marginLeft: 2 }}>{isOpen ? '▲' : '▼'}</span>
                </div>

                {/* ── Detalle expandido ── */}
                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '14px 14px', background: 'var(--bg3)' }}>

                    {/* Sección: datos técnicos del paso */}
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Detalle del paso</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px' }}>
                        <DetailRow label="Catálogo" value={<span style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{step.JobCatalogEntryName || '—'}</span>} />
                        <DetailRow label="Return Code" value={
                          <span style={{ fontWeight: 700, color: rcErr ? '#ff6b6b' : '#22c55e' }}>{step.StepAppRC ?? '—'}</span>
                        } />
                        <DetailRow label="Inicio" value={formatSapTs(step.StepStartDateTime, tzMode)} />
                        {dur && <DetailRow label="Duración" value={dur} />}
                        <DetailRow label="Resultados" value={step.StepHasResults ? '✓ Sí' : '—'} />
                      </div>
                    </div>

                    {/* Sección: info del log del paso */}
                    {nrLogs > 0 && liRec && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Log de aplicación</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px', marginBottom: 10 }}>
                          <DetailRow label="Severidad" value={
                            (() => {
                              const sv = SEV_STYLE[liRec.Severity] ?? SEV_STYLE.I
                              return (
                                <span style={{ padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: sv.bg, color: sv.color, border: `1px solid ${sv.border}` }}>
                                  {liRec.SeverityText || liRec.Severity || '—'}
                                </span>
                              )
                            })()
                          } />
                          <DetailRow label="Completado" value={formatSapTs(liRec.CreaDateTime, tzMode)} />
                          <DetailRow label="Ejecutado por" value={liRec.CreaUserLong || liRec.CreaUser || '—'} />
                          <DetailRow label="Nº de log" value={<span style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{liRec.LogNumber?.replace(/^0+/, '') || '—'}</span>} />
                        </div>
                        {/* Desglose de conteos por tipo */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {[
                            { key: 'A', label: 'Abort',   v: cnt.A,   c: MSG_STYLE.A },
                            { key: 'E', label: 'Error',   v: cnt.E,   c: MSG_STYLE.E },
                            { key: 'W', label: 'Warning', v: cnt.W,   c: MSG_STYLE.W },
                            { key: 'I', label: 'Info',    v: cnt.I,   c: MSG_STYLE.I },
                            { key: 'S', label: 'Success', v: cnt.S,   c: MSG_STYLE.S },
                          ].map(({ key, label, v, c }) => (
                            <span key={key} style={{
                              fontSize: 10, fontWeight: 600,
                              color: v > 0 ? c.color : 'var(--text3)',
                              background: v > 0 ? c.bg : 'transparent',
                              border: `1px solid ${v > 0 ? c.color + '44' : 'var(--border)'}`,
                              borderRadius: 4, padding: '2px 7px',
                            }}>
                              {label}: {v}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Sección: parámetros del paso (colapsable) */}
                    {(() => {
                      const sp        = params.data.filter(p => String(p.StepNr) === String(step.StepNumber))
                      const isAuthErr = params.error && (params.error.includes('APJ_RT/028') || params.error.includes('not authorized'))
                      const isOpen    = !!paramsExpanded[n]
                      if (!params.loading && !params.error && sp.length === 0) return null
                      return (
                        <div style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                          {/* Cabecera toggle */}
                          <div
                            onClick={() => setParamsExpanded(p => ({ ...p, [n]: !p[n] }))}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', cursor: 'pointer', background: isOpen ? 'rgba(255,255,255,.03)' : 'transparent', userSelect: 'none' }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Parámetros</span>
                              {params.loading && <span style={{ fontSize: 9, color: 'var(--text3)' }}>…</span>}
                              {!params.loading && !params.error && sp.length > 0 && (
                                <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 10, padding: '1px 6px' }}>{sp.length}</span>
                              )}
                              {params.error && !params.loading && (
                                <span style={{ fontSize: 9, color: isAuthErr ? '#fbbf24' : '#ff6b6b' }}>{isAuthErr ? '⚠ sin acceso' : '✕ error'}</span>
                              )}
                            </div>
                            <span style={{ fontSize: 10, color: 'var(--text3)' }}>{isOpen ? '▲' : '▼'}</span>
                          </div>
                          {/* Contenido */}
                          {isOpen && (
                            <div style={{ borderTop: '1px solid var(--border)', padding: '10px 10px' }}>
                              {params.loading && <div style={{ fontSize: 11, color: 'var(--text2)' }}>Cargando…</div>}
                              {params.error && isAuthErr && (
                                <div style={{ fontSize: 11, color: '#fbbf24', lineHeight: 1.5 }}>
                                  ⚠ Sin acceso — se requiere el rol <code style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>SAP_BCG_APPLICATION_JOB_DISP</code> para leer parámetros de jobs de otros usuarios.
                                </div>
                              )}
                              {params.error && !isAuthErr && <div style={{ fontSize: 11, color: 'var(--red)' }}>✕ {params.error}</div>}
                              {sp.length > 0 && (
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr>
                                      {['Parámetro', 'Op', 'Valor'].map(h => (
                                        <th key={h} style={{ textAlign: 'left', fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', paddingBottom: 5, borderBottom: '1px solid var(--border)', paddingRight: 10 }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sp.map((p, i) => {
                                      const label = paramLabel(p.JobParameterName)
                                      const isRaw = label === p.JobParameterName
                                      const op    = OPTION_LABEL[p.Option] ?? p.Option ?? '='
                                      const value = p.High && p.High !== p.Low ? `${p.Low} → ${p.High}` : (p.Low ?? '—')
                                      return (
                                        <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                                          <td style={{ padding: '5px 10px 5px 0', verticalAlign: 'top' }}>
                                            <div style={{ fontSize: 11, color: 'var(--text)' }}>
                                              {isRaw ? <span style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{label}</span> : label}
                                            </div>
                                            {!isRaw && <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 1 }}>{p.JobParameterName}</div>}
                                          </td>
                                          <td style={{ padding: '5px 10px 5px 0', fontSize: 11, color: 'var(--text3)', verticalAlign: 'top' }}>{op}</td>
                                          <td style={{ padding: '5px 0', fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)', wordBreak: 'break-all', verticalAlign: 'top' }}>{value}</td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Sección: mensajes */}
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                        Mensajes {cnt.all > 0 ? `(${cnt.all})` : ''}
                      </div>

                      {nrLogs === 0 && <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>Sin mensajes de log.</div>}
                      {li?.loading     && <div style={{ fontSize: 11, color: 'var(--text2)' }}>Cargando info de log…</div>}
                      {li?.error       && <div style={{ fontSize: 11, color: 'var(--red)' }}>✕ {li.error}</div>}
                      {messages[n]?.loading && <div style={{ fontSize: 11, color: 'var(--text2)' }}>Cargando mensajes…</div>}
                      {messages[n]?.error   && <div style={{ fontSize: 11, color: 'var(--red)' }}>✕ {messages[n].error}</div>}

                      {messages[n]?.data?.length === 0 && !messages[n]?.loading && !messages[n]?.error && nrLogs > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>Sin mensajes disponibles.</div>
                      )}

                      {messages[n]?.data?.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {messages[n].data.map((msg, mi) => {
                            const m    = MSG_STYLE[msg.MsgType] ?? { label: msg.MsgType || '·', color: 'var(--text2)', bg: 'transparent' }
                            const text = msg.MsgText || [msg.MsgId, msg.MsgNo, msg.MsgV1, msg.MsgV2, msg.MsgV3, msg.MsgV4].filter(Boolean).join(' ')
                            const code = msg.MsgId && msg.MsgNo ? `${msg.MsgId}/${msg.MsgNo}` : null
                            return (
                              <div key={mi} style={{ display: 'flex', gap: 8, padding: '5px 8px', borderRadius: 4, background: m.bg, alignItems: 'flex-start' }}>
                                {/* Tipo */}
                                <span style={{ fontSize: 9, fontWeight: 700, flexShrink: 0, lineHeight: 1.4, marginTop: 1, color: m.color, background: `${m.color}22`, border: `1px solid ${m.color}44`, borderRadius: 3, padding: '1px 5px' }}>
                                  {m.label}
                                </span>
                                {/* Texto */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                                    {text || '—'}
                                  </div>
                                  {code && (
                                    <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                                      {code}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <style>{`
        @keyframes stepsPanelSlide {
          from { transform: translateX(40px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  )
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: 11, color: 'var(--text)' }}>{value}</span>
    </div>
  )
}

const OPTION_LABEL = { EQ: '=', NE: '≠', LT: '<', LE: '≤', GT: '>', GE: '≥', BT: '…', CP: '~' }

// Mapeo parcial de nombres técnicos SAP IBP → etiqueta descriptiva
const PARAM_LABEL = {
  P_PTGUID:  'Planning Area',
  P_VRSIO:   'Version',
  P_PSTEP:   'Planning Step',
  P_KEYFIG:  'Key Figure',
  P_HORIZF:  'Horizon From',
  P_HORIZT:  'Horizon To',
  P_DATFR:   'Date From',
  P_DATTO:   'Date To',
  P_SIMVER:  'Sim. Version',
  P_SELOPT:  'Selection Option',
  P_JOBNAM:  'Job Name',
  P_JOBCNT:  'Job Count',
  P_USERID:  'User ID',
  P_RUNMOD:  'Run Mode',
  P_SCENAR:  'Scenario',
}

function paramLabel(name) {
  return PARAM_LABEL[name] ?? name
}
