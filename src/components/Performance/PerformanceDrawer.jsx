import { useEffect, useState, useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'

function parseOdataDate(s) {
  if (!s || typeof s !== 'string') return null
  const m = /\/Date\((-?\d+)([+-]\d+)?\)\//.exec(s)
  return m ? parseInt(m[1], 10) : null
}

function fmtBytes(b) {
  const n = Number(b)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}
function fmtMicroSec(us) {
  const n = Number(us)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1000) return `${n} µs`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} ms`
  return `${(n / 1_000_000).toFixed(2)} s`
}
function fmtDate(ms, mode) {
  if (!ms) return '—'
  const d = new Date(ms); const p = n => String(n).padStart(2,'0')
  return mode === 'local'
    ? `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    : `${p(d.getUTCDate())}/${p(d.getUTCMonth()+1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

async function proxy(connectionId, path, addLog) {
  const start = performance.now()
  const res = await fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, path, com: '0068_taskmon' }),
  })
  const data = await res.json()
  addLog?.({ method: 'POST', path, status: res.status, duration: Math.round(performance.now() - start), detail: data.error || 'OK' })
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
  return data
}

/**
 * Props:
 *  - connection
 *  - activity: objeto mapeado (si ya se tiene)
 *  - jobRef: { JobName, JobCount } para resolver el activity por job
 *  - tzMode
 *  - onClose, addLog
 */
export default function PerformanceDrawer({ connection, activity, jobRef, tzMode, onClose, addLog }) {
  const [tab, setTab] = useState('info')
  const [mainRec, setMainRec] = useState(activity || null)
  const [info, setInfo] = useState([])
  const [kpis, setKpis] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true); setError(''); setInfo([]); setKpis([])
      try {
        let activityId = activity?.ActivityId
        let record = activity

        // Si nos pasaron jobRef en lugar de activity, resolver primero
        if (!activityId && jobRef?.JobName) {
          const filter = `JobName eq '${jobRef.JobName}'` + (jobRef.JobCount ? ` and JobCount eq '${jobRef.JobCount}'` : '')
          const path = `/xIBPxC_TASKMON_EXT_MAIN?$format=json&$top=1&$orderby=StartTime desc&$filter=${encodeURIComponent(filter)}`
          const data = await proxy(connection.id, path, addLog)
          const r = data?.d?.results?.[0]
          if (!r) throw new Error(`Sin telemetría para ${jobRef.JobName}/${jobRef.JobCount}`)
          activityId = r.ActivityId
          record = {
            ActivityId: r.ActivityId, ComponentName: r.ComponentName, ActivityName: r.ActivityName,
            TaskType: r.TaskType, JobName: r.JobName, JobCount: r.JobCount, FullName: r.FullName,
            JobStepNumber: Number(r.JobStepNumber) || 0,
            StartMs: parseOdataDate(r.StartTime), EndMs: parseOdataDate(r.EndTime),
            DurationSec: Number(r.DurationSeconds) || 0, DurationFmt: r.DurationFormatted || '',
            HanaMaxMemory: Number(r.HanaMaxMemory) || 0, HanaCpuTime: Number(r.HanaCpuTime) || 0,
            ProcessingTime: Number(r.ProcessingTime) || 0, ResponseTime: Number(r.ResponseTime) || 0,
            PctHanaMaxMemory: Number(r.PctHanaMaxMemory) || 0,
          }
          if (cancelled) return
          setMainRec(record)
        }

        if (!activityId) throw new Error('Actividad sin ID')

        const [infoRes, kpiRes] = await Promise.all([
          proxy(connection.id, `/xIBPxC_TASKMON_EXT_MAIN('${activityId}')/to_info?$format=json&$top=200`, addLog),
          proxy(connection.id, `/xIBPxC_TASKMON_EXT_MAIN('${activityId}')/to_kpis?$format=json&$top=500&$orderby=timestamp asc`, addLog),
        ])
        if (cancelled) return
        setInfo(infoRes?.d?.results ?? [])
        setKpis(kpiRes?.d?.results ?? [])
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [activity, jobRef, connection.id, addLog])

  // Agrupa KPIs por nombre → series separadas para LineChart
  const kpiSeries = useMemo(() => {
    const byName = {}
    kpis.forEach(k => {
      const ts = parseOdataDate(k.timestamp); if (!ts) return
      const name = k.kpi_name || '?'
      const val = parseFloat(k.kpi_value)
      if (!Number.isFinite(val)) return
      if (!byName[name]) byName[name] = []
      byName[name].push({ ts, [name]: val })
    })
    // Unificar en un solo dataset por timestamp
    const all = {}
    Object.values(byName).flat().forEach(row => {
      if (!all[row.ts]) all[row.ts] = { ts: row.ts }
      Object.assign(all[row.ts], row)
    })
    return {
      data: Object.values(all).sort((a,b) => a.ts - b.ts),
      names: Object.keys(byName),
    }
  }, [kpis])

  const r = mainRec

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 400,
      }} />
      <aside style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(620px, 92vw)',
        background: 'var(--bg)', borderLeft: '1px solid var(--border2)',
        boxShadow: '-8px 0 32px rgba(0,0,0,.5)', zIndex: 410,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Telemetría de actividad</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                {r?.ActivityId || (jobRef ? `${jobRef.JobName} · ${jobRef.JobCount || ''}` : '')}
              </div>
            </div>
            <button onClick={onClose} style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 6,
              color: 'var(--text2)', cursor: 'pointer', padding: '4px 10px', fontSize: 14,
            }}>✕</button>
          </div>
        </div>

        {/* Resumen */}
        {error ? (
          <div style={{ padding: 20, color: 'var(--red)', fontSize: 12 }}>✕ {error}</div>
        ) : !r ? (
          <div style={{ padding: 20, color: 'var(--text2)', fontSize: 12 }}>Cargando…</div>
        ) : (
          <>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
              <Kv label="Actividad" value={r.ActivityName} />
              <Kv label="Componente" value={r.ComponentName} />
              <Kv label="Job" value={r.JobName || '—'} mono />
              <Kv label="Step" value={r.JobStepNumber || '—'} />
              <Kv label="Inicio" value={fmtDate(r.StartMs, tzMode)} mono />
              <Kv label="Fin" value={fmtDate(r.EndMs, tzMode)} mono />
              <Kv label="Duración" value={r.DurationFmt || `${r.DurationSec?.toFixed(3)}s`} color="var(--cyan)" />
              <Kv label="Mem HANA pico" value={fmtBytes(r.HanaMaxMemory)} color="var(--purple)" />
              <Kv label="CPU HANA" value={fmtMicroSec(r.HanaCpuTime)} color="var(--accent)" />
              <Kv label="Response" value={fmtMicroSec(r.ResponseTime * 1000)} />
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', padding: '0 20px', flexShrink: 0 }}>
              {[{id:'info', label:`Info (${info.length})`}, {id:'kpis', label:`KPIs (${kpis.length})`}].map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  padding: '10px 14px', fontSize: 12, background: 'none', border: 'none',
                  borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
                  color: tab === t.id ? 'var(--text)' : 'var(--text2)',
                  fontWeight: tab === t.id ? 700 : 400, cursor: 'pointer',
                }}>{t.label}</button>
              ))}
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
              {loading ? (
                <div style={{ color: 'var(--text2)', fontSize: 12 }}>Cargando detalle…</div>
              ) : tab === 'info' ? (
                info.length === 0
                  ? <div style={{ color: 'var(--text3)', fontSize: 12 }}>Sin info adicional</div>
                  : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: 'var(--bg2)' }}>
                          <th style={thStyle}>Descripción</th>
                          <th style={thStyle}>Valor</th>
                          <th style={thStyle}>Descripción valor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {info.map((i, idx) => (
                          <tr key={idx} style={{ background: idx%2===0 ? 'transparent' : 'var(--bg2)' }}>
                            <td style={tdStyle}>{i.InfoDesc}</td>
                            <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{i.InfoValue || '—'}</td>
                            <td style={tdStyle}>{i.InfoValuedesc || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
              ) : (
                kpiSeries.names.length === 0
                  ? <div style={{ color: 'var(--text3)', fontSize: 12 }}>Sin KPIs time-series para esta actividad</div>
                  : (
                    <>
                      <ResponsiveContainer width="100%" height={260}>
                        <LineChart data={kpiSeries.data} margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="ts" tickFormatter={ts => {
                            const d = new Date(ts); const p = n => String(n).padStart(2,'0')
                            return tzMode === 'local'
                              ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
                              : `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
                          }} tick={{ fontSize: 10, fill: 'var(--text2)' }} />
                          <YAxis tick={{ fontSize: 10, fill: 'var(--text2)' }} />
                          <Tooltip
                            contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
                            labelFormatter={ts => fmtDate(ts, tzMode)}
                          />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          {kpiSeries.names.map((n, i) => (
                            <Line key={n} type="monotone" dataKey={n} stroke={['#06b6d4','#a78bfa','#34d399','#fbbf24','#ff6b6b','#f97316'][i%6]} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 14 }}>
                        <thead>
                          <tr style={{ background: 'var(--bg2)' }}>
                            <th style={thStyle}>Timestamp</th>
                            <th style={thStyle}>KPI</th>
                            <th style={thStyle}>Valor</th>
                            <th style={thStyle}>UoM</th>
                            <th style={thStyle}>Objeto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {kpis.slice(0, 200).map((k, idx) => (
                            <tr key={idx} style={{ background: idx%2===0 ? 'transparent' : 'var(--bg2)' }}>
                              <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmtDate(parseOdataDate(k.timestamp), tzMode)}</td>
                              <td style={tdStyle}>{k.kpi_name}</td>
                              <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{k.kpi_value}</td>
                              <td style={tdStyle}>{k.kpi_uom || '—'}</td>
                              <td style={tdStyle}>{k.obj_id_description || k.obj_id || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )
              )}
            </div>
          </>
        )}
      </aside>
    </>
  )
}

function Kv({ label, value, mono, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>{label}</div>
      <div style={{
        fontSize: 12, color: color || 'var(--text)', fontWeight: color ? 700 : 500,
        fontFamily: mono ? 'var(--mono)' : 'var(--font)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{value ?? '—'}</div>
    </div>
  )
}

const thStyle = {
  padding: '8px 10px', textAlign: 'left', color: 'var(--text2)',
  fontWeight: 600, borderBottom: '1px solid var(--border)', fontSize: 10,
  textTransform: 'uppercase', letterSpacing: '.05em',
}
const tdStyle = {
  padding: '6px 10px', color: 'var(--text)',
  borderBottom: '1px solid var(--border)', fontSize: 11,
}
