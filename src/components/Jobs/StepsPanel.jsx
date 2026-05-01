import { useState, useEffect, useCallback } from 'react'
import { formatSapTs } from '../../utils/dateUtils'

const MSG_STYLE = {
  A: { label: 'Abort',   color: '#ff6b6b', bg: 'rgba(255,107,107,.08)' },
  E: { label: 'Error',   color: '#ff6b6b', bg: 'rgba(255,107,107,.08)' },
  W: { label: 'Warning', color: '#fbbf24', bg: 'rgba(251,191,36,.08)'  },
  I: { label: 'Info',    color: '#3b82f6', bg: 'rgba(59,130,246,.08)'  },
  S: { label: 'Success', color: '#22c55e', bg: 'rgba(34,197,94,.08)'   },
}

function enc(val) {
  return `%27${encodeURIComponent(val)}%27`
}

export default function StepsPanel({ job, connectionId, statuses, tzMode, onClose }) {
  const [steps, setSteps]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [expanded, setExpanded] = useState(null)
  const [logs, setLogs]         = useState({})

  const proxy = useCallback(async (path) => {
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId, path }),
    })
    return res.json()
  }, [connectionId])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setSteps([]); setExpanded(null); setLogs({})
    async function load() {
      try {
        const path = `/JobHeaderSet(JobName=${enc(job.JobName)},JobRunCount=${enc(job.JobRunCount)})/JobStepSet`
        const data = await proxy(path)
        if (cancelled) return
        if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
        const results = (data?.d?.results ?? data?.value ?? [])
          .sort((a, b) => (Number(a.StepNumber) || 0) - (Number(b.StepNumber) || 0))
        setSteps(results)
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [job.JobName, job.JobRunCount, proxy])

  async function expandStep(step) {
    const n = Number(step.StepNumber)
    if (expanded === n) { setExpanded(null); return }
    setExpanded(n)
    const nrLogs = Number(step.NrOfLogs) || 0
    if (nrLogs === 0 || logs[n]) return
    setLogs(p => ({ ...p, [n]: { loading: true, messages: null, error: '' } }))
    try {
      const infoPath = `/JobStepSet(JobName=${enc(step.JobName)},JobRunCount=${enc(step.JobRunCount)},StepNumber=${n})/JobStepLogInfoSet`
      const infoData = await proxy(infoPath)
      if (infoData.error) throw new Error(infoData.error + (infoData.detail ? ': ' + infoData.detail : ''))
      const infos = infoData?.d?.results ?? infoData?.value ?? []
      const allMsgs = []
      for (const info of infos) {
        const msgPath = `/JobStepLogInfoSet(JobName=${enc(info.JobName)},JobRunCount=${enc(info.JobRunCount)},StepNumber=${Number(info.StepNumber)},LogHandle=${enc(info.LogHandle)})/JobLogMessageSet`
        const msgData = await proxy(msgPath)
        const msgs = msgData?.d?.results ?? msgData?.value ?? []
        allMsgs.push(...msgs)
      }
      setLogs(p => ({ ...p, [n]: { loading: false, messages: allMsgs, error: '' } }))
    } catch (e) {
      setLogs(p => ({ ...p, [n]: { loading: false, messages: [], error: e.message } }))
    }
  }

  function statusStyle(code) {
    const s = statuses.find(x => x.JobStatus === code)
    const c = s?.color ?? { bg: 'rgba(156,163,175,.15)', color: '#9ca3af', border: 'rgba(156,163,175,.3)' }
    return { ...c, text: s?.JobStatusText || code || '—' }
  }

  const jobSt       = statusStyle(job.JobStatus)
  const failedCount = steps.filter(s => ['A', 'U'].includes(s.StepStatus)).length

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 400 }}
      />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 'min(580px, 95vw)',
        background: 'var(--bg)', borderLeft: '1px solid var(--border2)',
        zIndex: 401, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 32px rgba(0,0,0,.4)',
        animation: 'stepsPanelSlide .2s ease-out',
      }}>

        {/* Panel header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                Pasos del job
              </div>
              <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {job.JobText || job.JobName}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                {job.JobName} · Run {job.JobRunCount}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                background: jobSt.bg, color: jobSt.color, border: `1px solid ${jobSt.border}`,
              }}>
                {jobSt.text}
              </span>
              <button
                onClick={onClose}
                style={{
                  background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                  color: 'var(--text2)', fontSize: 13, cursor: 'pointer',
                  padding: '4px 10px', lineHeight: 1,
                }}
              >✕</button>
            </div>
          </div>

          {!loading && steps.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 14, fontSize: 10, color: 'var(--text3)' }}>
              <span>{steps.length} paso{steps.length !== 1 ? 's' : ''}</span>
              <span>{steps.filter(s => s.StepStatus === 'F').length} finalizados</span>
              {failedCount > 0 && (
                <span style={{ color: '#ff6b6b', fontWeight: 700 }}>
                  {failedCount} fallido{failedCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Steps content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}>

          {loading && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)', fontSize: 12 }}>
              Cargando pasos…
            </div>
          )}

          {error && (
            <div style={{
              background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)',
              borderRadius: 8, padding: '12px 16px', color: 'var(--red)', fontSize: 12,
            }}>✕ {error}</div>
          )}

          {!loading && !error && steps.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text2)', fontSize: 12 }}>
              Sin pasos registrados para este job.
            </div>
          )}

          {steps.map(step => {
            const n       = Number(step.StepNumber)
            const isOpen  = expanded === n
            const logSt   = logs[n]
            const st      = statusStyle(step.StepStatus)
            const rcError = step.StepAppRC != null && Number(step.StepAppRC) !== 0
            const nrLogs  = Number(step.NrOfLogs) || 0

            return (
              <div
                key={n}
                style={{
                  marginBottom: 8, borderRadius: 8, overflow: 'hidden',
                  border: `1px solid ${isOpen ? 'var(--border2)' : 'var(--border)'}`,
                  background: isOpen ? 'var(--bg2)' : 'transparent',
                }}
              >
                {/* Step row */}
                <div
                  onClick={() => expandStep(step)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }}
                >
                  {/* Step number bubble */}
                  <span style={{
                    width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700, color: 'var(--text2)',
                  }}>{n}</span>

                  {/* Description + timestamp */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 600, color: '#fff',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {step.JobCatalogEntryText || step.JobCatalogEntryName || `Paso ${n}`}
                    </div>
                    {step.StepStartDateTime && (
                      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>
                        {formatSapTs(step.StepStartDateTime, tzMode)}
                      </div>
                    )}
                  </div>

                  {/* Status badge */}
                  <span style={{
                    padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, flexShrink: 0,
                    background: st.bg, color: st.color, border: `1px solid ${st.border}`,
                  }}>
                    {st.text}
                  </span>

                  {/* RC error badge */}
                  {rcError && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, flexShrink: 0,
                      color: '#ff6b6b', background: 'rgba(255,107,107,.1)',
                      border: '1px solid rgba(255,107,107,.3)', borderRadius: 4, padding: '2px 6px',
                    }}>
                      RC {step.StepAppRC}
                    </span>
                  )}

                  {/* Logs count badge */}
                  {nrLogs > 0 && (
                    <span style={{
                      fontSize: 10, color: 'var(--text3)', flexShrink: 0,
                      background: 'var(--bg3)', border: '1px solid var(--border)',
                      borderRadius: 4, padding: '2px 6px',
                    }}>
                      {nrLogs} log{nrLogs !== 1 ? 's' : ''}
                    </span>
                  )}

                  <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0, marginLeft: 2 }}>
                    {isOpen ? '▲' : '▼'}
                  </span>
                </div>

                {/* Expanded detail */}
                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', background: 'var(--bg3)' }}>

                    {/* Metadata row */}
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 11 }}>
                      <span>
                        <span style={{ color: 'var(--text3)' }}>Catálogo: </span>
                        <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 10 }}>
                          {step.JobCatalogEntryName || '—'}
                        </span>
                      </span>
                      <span>
                        <span style={{ color: 'var(--text3)' }}>RC: </span>
                        <span style={{ color: rcError ? '#ff6b6b' : '#22c55e', fontWeight: 700 }}>
                          {step.StepAppRC ?? '—'}
                        </span>
                      </span>
                      <span>
                        <span style={{ color: 'var(--text3)' }}>Resultados: </span>
                        <span style={{ color: 'var(--text)' }}>{step.StepHasResults ? '✓ Sí' : '—'}</span>
                      </span>
                    </div>

                    {/* Log messages area */}
                    {nrLogs === 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
                        Sin mensajes de log.
                      </div>
                    )}
                    {logSt?.loading && (
                      <div style={{ fontSize: 11, color: 'var(--text2)' }}>Cargando mensajes…</div>
                    )}
                    {logSt?.error && (
                      <div style={{ fontSize: 11, color: 'var(--red)' }}>✕ {logSt.error}</div>
                    )}
                    {logSt?.messages?.length === 0 && !logSt?.loading && !logSt?.error && (
                      <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>Sin mensajes.</div>
                    )}
                    {logSt?.messages?.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {logSt.messages.map((msg, mi) => {
                          const m    = MSG_STYLE[msg.MsgType] ?? { label: msg.MsgType || '·', color: 'var(--text2)', bg: 'transparent' }
                          const text = msg.MsgText
                            || [msg.MsgId, msg.MsgNo, msg.MsgV1, msg.MsgV2, msg.MsgV3, msg.MsgV4]
                                .filter(Boolean).join(' ')
                          return (
                            <div
                              key={mi}
                              style={{
                                display: 'flex', gap: 8, padding: '5px 8px',
                                borderRadius: 4, background: m.bg, alignItems: 'flex-start',
                              }}
                            >
                              <span style={{
                                fontSize: 9, fontWeight: 700, flexShrink: 0, lineHeight: 1.4, marginTop: 1,
                                color: m.color, background: `${m.color}22`,
                                border: `1px solid ${m.color}44`, borderRadius: 3, padding: '1px 5px',
                              }}>
                                {m.label}
                              </span>
                              <span style={{
                                fontSize: 11, color: 'var(--text)', lineHeight: 1.5, wordBreak: 'break-word',
                              }}>
                                {text || '—'}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
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
