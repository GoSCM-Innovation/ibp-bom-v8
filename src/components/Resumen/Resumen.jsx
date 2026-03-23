import { useState, useEffect, useCallback, useRef } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts'

const DEFAULT_HOURS = 24
const REFRESH_MS = 5 * 60 * 1000 // 5 minutos

const STATUS_COLORS = {
  F: '#34d399', W: '#fbbf24', A: '#ff6b6b', U: '#f97316',
  R: '#3b82f6', S: '#8b5cf6', P: '#06b6d4', Y: '#a78bfa',
  C: '#9ca3af', c: '#9ca3af', D: '#4b5563', K: '#6b7280',
  X: '#374151', k: '#6b7280',
}

function toSapTs(date) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth()+1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.0000000`
}

function formatSapTs(ts) {
  if (!ts || ts.length < 14) return '—'
  return `${ts.slice(6,8)}/${ts.slice(4,6)}/${ts.slice(0,4)} ${ts.slice(8,10)}:${ts.slice(10,12)}`
}

function parseSapTs(ts) {
  if (!ts || ts.length < 8) return null
  return new Date(
    parseInt(ts.slice(0,4)), parseInt(ts.slice(4,6))-1, parseInt(ts.slice(6,8)),
    parseInt(ts.slice(8,10)||0), parseInt(ts.slice(10,12)||0)
  )
}

function dayLabel(ts) {
  const d = parseSapTs(ts)
  if (!d) return '?'
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`
}

function toInputDate(date) {
  return date.toISOString().slice(0, 16)
}

export default function Resumen({ connection }) {
  const [rows, setRows]           = useState([])
  const [statuses, setStatuses]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [lastRefresh, setLastRefresh] = useState(null)
  const timerRef = useRef(null)

  const defaultFrom = new Date(Date.now() - DEFAULT_HOURS * 3600 * 1000)
  const defaultTo   = new Date(Date.now() + DEFAULT_HOURS * 3600 * 1000)
  const [fromDate, setFromDate] = useState(toInputDate(defaultFrom))
  const [toDate,   setToDate]   = useState(toInputDate(defaultTo))

  const proxyPost = useCallback(path =>
    fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id, path }),
    }).then(r => r.json())
  , [connection.id])

  useEffect(() => {
    proxyPost('/JobStatusInfoSet').then(data => {
      setStatuses(data?.d?.results ?? data?.value ?? [])
    }).catch(() => {})
  }, [proxyPost])

  const loadData = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await proxyPost('/JobHeaderSet')
      if (data.error) throw new Error(data.error)
      setRows(data?.d?.results ?? data?.value ?? [])
      setLastRefresh(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [proxyPost])

  useEffect(() => {
    loadData()
    timerRef.current = setInterval(loadData, REFRESH_MS)
    return () => clearInterval(timerRef.current)
  }, [loadData])

  function statusLabel(code) {
    return statuses.find(s => s.JobStatus === code)?.JobStatusText || code
  }

  // Filter — mismo criterio que Job Monitor
  const fromTs = toSapTs(new Date(fromDate))
  const toTs   = toSapTs(new Date(toDate))
  const filtered = rows.filter(r => {
    const ts = r.JobPlannedStartDateTime || ''
    if (ts && (ts < fromTs || ts > toTs)) return false
    return true
  })

  // KPIs
  const total    = filtered.length
  const running  = filtered.filter(r => r.JobStatus === 'R').length
  const scheduled= filtered.filter(r => ['S','P','Y'].includes(r.JobStatus)).length
  const finished = filtered.filter(r => r.JobStatus === 'F').length
  const failed   = filtered.filter(r => ['A','U'].includes(r.JobStatus)).length
  const warned   = filtered.filter(r => r.JobStatus === 'W').length
  const successRate = total > 0 ? Math.round(((finished + warned) / total) * 100) : 0

  // Donut — by status
  const statusCount = {}
  filtered.forEach(r => { statusCount[r.JobStatus] = (statusCount[r.JobStatus] || 0) + 1 })
  const donutData = Object.entries(statusCount)
    .map(([code, count]) => ({ name: statusLabel(code), value: count, code }))
    .sort((a, b) => b.value - a.value)

  // Bars — jobs per day
  const dayMap = {}
  filtered.forEach(r => {
    const d = dayLabel(r.JobPlannedStartDateTime)
    if (!dayMap[d]) dayMap[d] = { day: d, Finalizados: 0, Fallidos: 0, Otros: 0 }
    if (r.JobStatus === 'F' || r.JobStatus === 'W') dayMap[d].Finalizados++
    else if (r.JobStatus === 'A' || r.JobStatus === 'U') dayMap[d].Fallidos++
    else dayMap[d].Otros++
  })
  const barData = Object.values(dayMap).sort((a, b) => a.day.localeCompare(b.day)).slice(-14)

  // Top jobs ejecutados
  const tplMap = {}
  filtered.forEach(r => {
    const k = r.JobText || '—'
    tplMap[k] = (tplMap[k] || 0) + 1
  })
  const topTemplates = Object.entries(tplMap).sort((a,b) => b[1]-a[1]).slice(0,5)

  // Top users
  const userMap = {}
  filtered.forEach(r => {
    const k = r.JobCreatedByFormattedName || r.JobCreatedBy || '—'
    userMap[k] = (userMap[k] || 0) + 1
  })
  const topUsers = Object.entries(userMap).sort((a,b) => b[1]-a[1]).slice(0,5)

  // Top 5 templates by average duration (only F/W jobs with both start+end)
  const durationMap = {}
  filtered.forEach(r => {
    if (!['F','W'].includes(r.JobStatus)) return
    const start = parseSapTs(r.JobStartDateTime)
    const end   = parseSapTs(r.JobEndDateTime)
    if (!start || !end || end <= start) return
    const mins = (end - start) / 60000
    const k = r.JobText || '—'
    if (!durationMap[k]) durationMap[k] = { total: 0, count: 0 }
    durationMap[k].total += mins
    durationMap[k].count += 1
  })
  const topDuration = Object.entries(durationMap)
    .map(([name, { total, count }]) => ({ name, avg: total / count }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5)

  function fmtDuration(mins) {
    if (mins < 1)   return `${Math.round(mins * 60)}s`
    if (mins < 60)  return `${Math.round(mins)} min`
    const h = Math.floor(mins / 60)
    const m = Math.round(mins % 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }

  // Recent failed
  const recentFailed = filtered
    .filter(r => ['A','U'].includes(r.JobStatus))
    .sort((a,b) => (b.JobPlannedStartDateTime||'').localeCompare(a.JobPlannedStartDateTime||''))
    .slice(0,5)

  if (loading) return (
    <div style={{ padding: 32, color: 'var(--text2)', fontSize: 13 }}>
      Cargando resumen de {connection.name}…
    </div>
  )

  if (error) return (
    <div style={{ padding: 32 }}>
      <div style={{ background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 8, padding: '12px 16px', color: 'var(--red)', fontSize: 12 }}>✕ {error}</div>
    </div>
  )

  return (
    <div style={{ padding: 28, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Resumen</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
            {connection.name} · {total} jobs en el período
            {lastRefresh && !loading && (
              <span style={{ marginLeft: 8, opacity: .6 }}>· Actualizado {lastRefresh.toLocaleTimeString()}</span>
            )}
          </div>
        </div>
        {/* Date range + refresh */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="datetime-local" value={fromDate} onChange={e => setFromDate(e.target.value)} style={inputStyle} />
          <span style={{ color: 'var(--text2)', fontSize: 11 }}>→</span>
          <input type="datetime-local" value={toDate} onChange={e => setToDate(e.target.value)} style={inputStyle} />
          <button onClick={loadData} disabled={loading} style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 6,
            color: 'var(--text2)', fontSize: 11, fontWeight: 600, padding: '6px 12px', cursor: 'pointer',
          }}>↺ Refresh</button>
          <span style={{
            fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap',
            padding: '4px 8px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
          }}>🔄 Auto-refresh cada 5 min</span>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid-kpi">
        <KpiCard label="Total jobs"    value={total}        color="var(--text)" />
        <KpiCard label="En ejecución"  value={running}      color="var(--cyan)" />
        <KpiCard label="Programados"   value={scheduled}    color="var(--purple)" />
        <KpiCard label="Finalizados"   value={finished}     color="var(--green)" />
        <KpiCard label="Fallidos"      value={failed}       color="var(--red)" />
        <KpiCard label="Tasa de éxito" value={`${successRate}%`} color={successRate >= 90 ? 'var(--green)' : successRate >= 70 ? 'var(--accent)' : 'var(--red)'} />
      </div>

      {/* Charts row */}
      <div className="grid-charts">

        {/* Donut */}
        <div style={cardStyle}>
          <div style={cardTitle}>Distribución por estado</div>
          {donutData.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={donutData} cx="50%" cy="50%" innerRadius={55} outerRadius={85}
                  paddingAngle={2} dataKey="value">
                  {donutData.map((entry, i) => (
                    <Cell key={i} fill={STATUS_COLORS[entry.code] || '#6b7280'} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
                  formatter={(v, n) => [v, n]}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8 }}>
            {donutData.map((d, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text2)' }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLORS[d.code] || '#6b7280', flexShrink: 0 }} />
                {d.name} ({d.value})
              </div>
            ))}
          </div>
        </div>

        {/* Bars */}
        <div style={cardStyle}>
          <div style={cardTitle}>Jobs por día</div>
          {barData.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={barData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text2)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text2)' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text2)' }} />
                <Bar dataKey="Finalizados" stackId="a" fill="#34d399" radius={[0,0,0,0]} />
                <Bar dataKey="Fallidos"    stackId="a" fill="#ff6b6b" radius={[0,0,0,0]} />
                <Bar dataKey="Otros"       stackId="a" fill="#6b7280" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Bottom rows — 2×2 */}
      <div className="grid-stats">

        {/* Top templates */}
        <div style={cardStyle}>
          <div style={cardTitle}>Top jobs ejecutados</div>
          {topTemplates.length === 0 ? <Empty /> : topTemplates.map(([name, count], i) => (
            <RankRow key={i} rank={i+1} label={name} count={count} max={topTemplates[0][1]} color="var(--cyan)" />
          ))}
        </div>

        {/* Top users */}
        <div style={cardStyle}>
          <div style={cardTitle}>Usuarios más activos</div>
          {topUsers.length === 0 ? <Empty /> : topUsers.map(([name, count], i) => (
            <RankRow key={i} rank={i+1} label={name} count={count} max={topUsers[0][1]} color="var(--purple)" />
          ))}
        </div>

        {/* Top duration */}
        <div style={cardStyle}>
          <div style={cardTitle}>Top jobs más lentos (prom.)</div>
          {topDuration.length === 0
            ? <Empty />
            : topDuration.map((d, i) => (
              <RankRow
                key={i} rank={i+1} label={d.name}
                count={fmtDuration(d.avg)} max={topDuration[0].avg}
                rawValue={d.avg} color="var(--accent)"
              />
            ))
          }
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 10 }}>
            Solo jobs Finalizados con inicio y fin registrados
          </div>
        </div>

        {/* Recent failed */}
        <div style={cardStyle}>
          <div style={cardTitle}>Últimos jobs fallidos</div>
          {recentFailed.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 8 }}>✓ Sin fallos en el período</div>
            : recentFailed.map((r, i) => (
              <div key={i} style={{ padding: '7px 0', borderBottom: i < recentFailed.length-1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.JobText || '—'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{r.JobCreatedByFormattedName || r.JobCreatedBy}</span>
                  <span>{formatSapTs(r.JobPlannedStartDateTime)}</span>
                </div>
              </div>
            ))
          }
        </div>
      </div>
    </div>
  )
}

function KpiCard({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
    </div>
  )
}

function RankRow({ rank, label, count, max, color, suffix = '', rawValue }) {
  const numeric = rawValue !== undefined ? rawValue : count
  const pct = max > 0 ? (numeric / max) * 100 : 0
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <div style={{ fontSize: 11, color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <span style={{ color: 'var(--text3)', fontWeight: 700, flexShrink: 0 }}>#{rank}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color, flexShrink: 0, marginLeft: 8 }}>{count}{suffix}</span>
      </div>
      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width .4s' }} />
      </div>
    </div>
  )
}

function Empty() {
  return <div style={{ fontSize: 12, color: 'var(--text3)', padding: '16px 0' }}>Sin datos en el período</div>
}

const cardStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: 10, padding: '16px 18px',
}

const cardTitle = {
  fontSize: 11, fontWeight: 700, color: 'var(--text2)',
  textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 12,
}

const inputStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text)', fontSize: 11,
  padding: '6px 10px', outline: 'none',
}
