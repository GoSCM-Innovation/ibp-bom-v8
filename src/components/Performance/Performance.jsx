import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts'
import TechLogs, { useTechLogs } from '../TechLogs'
import PerformanceDrawer from './PerformanceDrawer'
import {
  toInputDate, inputDateToDate,
  getTzMode, setTzMode as saveTzMode, getTzLabel,
} from '../../utils/dateUtils'

const DEFAULT_HOURS = 24
const MAX_DAYS      = 90

// OData /Date(ms+0000)/ → ms
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

function fmtDateCell(ms, mode) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  if (mode === 'local') {
    return `${p(d.getDate())}/${p(d.getMonth()+1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth()+1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

const COMPONENT_COLORS = ['#06b6d4', '#a78bfa', '#34d399', '#fbbf24', '#ff6b6b', '#f97316', '#3b82f6', '#8b5cf6']
const TASKTYPE_COLORS  = { J: '#34d399', R: '#06b6d4', D: '#a78bfa', T: '#fbbf24', '': '#6b7280' }
const TASKTYPE_LABEL   = { J: 'Job', R: 'RFC', D: 'Dialog', T: 'Transaction', '': 'Otro' }

export default function Performance({ connection }) {
  const [rows, setRows]               = useState([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState('')
  const [lastRefresh, setLastRefresh] = useState(null)
  const [selected, setSelected]       = useState(null)
  const [tzMode, setTzModeState]      = useState(() => getTzMode())
  const [sortKey, setSortKey]         = useState('StartMs')
  const [sortDir, setSortDir]         = useState('desc')
  const [logs, addLog] = useTechLogs()
  const addLogRef = useRef(addLog); addLogRef.current = addLog

  const [fromDate, setFromDate] = useState(() => toInputDate(new Date(Date.now() - DEFAULT_HOURS * 3600 * 1000), getTzMode()))
  const [toDate,   setToDate]   = useState(() => toInputDate(new Date(Date.now() + DEFAULT_HOURS * 3600 * 1000), getTzMode()))

  function handleTzToggle(newMode) {
    const fromD = inputDateToDate(fromDate, tzMode)
    const toD   = inputDateToDate(toDate, tzMode)
    saveTzMode(newMode)
    setTzModeState(newMode)
    setFromDate(toInputDate(fromD, newMode))
    setToDate(toInputDate(toD, newMode))
  }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const fromUTC = inputDateToDate(fromDate, tzMode)
      const toUTC   = inputDateToDate(toDate, tzMode)

      // Guardrail 90 días
      const spanDays = (toUTC - fromUTC) / 86400000
      if (spanDays > MAX_DAYS) {
        throw new Error(`Rango máximo permitido: ${MAX_DAYS} días`)
      }

      const fromISO = fromUTC.toISOString()
      const toISO   = toUTC.toISOString()
      const filter  = `StartTime ge datetimeoffset'${fromISO}' and StartTime le datetimeoffset'${toISO}'`
      const path = `/xIBPxC_TASKMON_EXT_MAIN?$format=json&$top=2000&$orderby=StartTime desc&$filter=${encodeURIComponent(filter)}`

      const start = performance.now()
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connection.id, path, com: '0068_taskmon' }),
      })
      const data = await res.json()
      addLogRef.current({ method: 'POST', path, status: res.status, duration: Math.round(performance.now() - start), detail: data.error || 'OK' })
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`)

      const raw = data?.d?.results ?? []
      const mapped = raw.map(r => ({
        ActivityId:    r.ActivityId,
        ComponentName: r.ComponentName || '—',
        ActivityName:  r.ActivityName  || '—',
        TaskType:      r.TaskType || '',
        JobName:       r.JobName || '',
        JobCount:      r.JobCount || '',
        JobStepNumber: Number(r.JobStepNumber) || 0,
        FullName:      r.FullName || '',
        StartMs:       parseOdataDate(r.StartTime),
        EndMs:         parseOdataDate(r.EndTime),
        DurationSec:   Number(r.DurationSeconds) || 0,
        DurationFmt:   r.DurationFormatted || '',
        HanaMaxMemory: Number(r.HanaMaxMemory) || 0,
        HanaCpuTime:   Number(r.HanaCpuTime)   || 0,
        ProcessingTime: Number(r.ProcessingTime) || 0,
        ResponseTime:  Number(r.ResponseTime)  || 0,
        PctHanaMaxMemory: Number(r.PctHanaMaxMemory) || 0,
      }))
      setRows(mapped)
      setLastRefresh(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [connection.id, fromDate, toDate, tzMode])

  useEffect(() => { load() }, [load])

  // ── Derived ────────────────────────────────────────────────
  const total = rows.length
  const avgDuration = total > 0 ? rows.reduce((s, r) => s + r.DurationSec, 0) / total : 0
  const avgMemMb    = total > 0 ? (rows.reduce((s, r) => s + r.HanaMaxMemory, 0) / total) / 1048576 : 0
  const totalCpuSec = rows.reduce((s, r) => s + r.HanaCpuTime, 0) / 1_000_000

  // BarChart por día × ComponentName
  const { barData, componentKeys } = useMemo(() => {
    const compCounts = {}
    rows.forEach(r => { compCounts[r.ComponentName] = (compCounts[r.ComponentName] || 0) + 1 })
    const topComps = Object.entries(compCounts).sort((a,b) => b[1]-a[1]).slice(0,6).map(([k]) => k)
    const byDay = {}
    rows.forEach(r => {
      if (!r.StartMs) return
      const d = new Date(r.StartMs)
      const day = tzMode === 'local'
        ? `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`
        : `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`
      if (!byDay[day]) byDay[day] = { day }
      const key = topComps.includes(r.ComponentName) ? r.ComponentName : 'Otros'
      byDay[day][key] = (byDay[day][key] || 0) + r.DurationSec
    })
    const keys = [...topComps]
    if (Object.values(byDay).some(v => v['Otros'])) keys.push('Otros')
    return {
      barData: Object.values(byDay).sort((a,b) => a.day.localeCompare(b.day)),
      componentKeys: keys,
    }
  }, [rows, tzMode])

  // Tabla ordenable
  const sortedRows = useMemo(() => {
    const mul = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'string') return mul * av.localeCompare(bv)
      return mul * (av - bv)
    })
  }, [rows, sortKey, sortDir])

  function handleSort(key) {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  // Top 10 por memoria
  const top10Mem = useMemo(() => (
    [...rows].sort((a,b) => b.HanaMaxMemory - a.HanaMaxMemory).slice(0, 10)
  ), [rows])

  // Donut por TaskType
  const donutData = useMemo(() => {
    const m = {}
    rows.forEach(r => { m[r.TaskType] = (m[r.TaskType] || 0) + 1 })
    return Object.entries(m).map(([code, value]) => ({
      name: TASKTYPE_LABEL[code] || code || 'Otro',
      value, code,
    }))
  }, [rows])

  const tzSuffix = tzMode === 'utc' ? 'UTC' : getTzLabel()

  return (
    <div style={{ padding: 28, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Job Performance</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
            Telemetría HANA · {total} actividades en el período
            {lastRefresh && !loading && (
              <span style={{ marginLeft: 8, opacity: .6 }}>· Actualizado {lastRefresh.toLocaleTimeString()}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <TzToggle mode={tzMode} onToggle={handleTzToggle} />
          <input type="datetime-local" value={fromDate} onChange={e => setFromDate(e.target.value)} style={inputStyle} />
          <span style={{ color: 'var(--text2)', fontSize: 11 }}>→</span>
          <input type="datetime-local" value={toDate} onChange={e => setToDate(e.target.value)} style={inputStyle} />
          <button onClick={load} disabled={loading} style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 6,
            color: 'var(--text2)', fontSize: 11, fontWeight: 600, padding: '6px 12px', cursor: 'pointer',
          }}>↺ Refresh</button>
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 8, padding: '12px 16px', color: 'var(--red)', fontSize: 12, marginBottom: 16 }}>
          ✕ {error}
        </div>
      )}

      {/* KPIs */}
      <div className="grid-kpi">
        <KpiCard label="Actividades" value={total} color="var(--text)" />
        <KpiCard label="Duración prom." value={`${avgDuration.toFixed(2)} s`} color="var(--cyan)" />
        <KpiCard label="Mem HANA pico prom." value={`${avgMemMb.toFixed(1)} MB`} color="var(--purple)" />
        <KpiCard label="CPU HANA total" value={`${totalCpuSec.toFixed(2)} s`} color="var(--accent)" />
      </div>

      {/* Charts */}
      <div className="grid-charts">
        <div style={cardStyle}>
          <div style={cardTitle}>Duración por día y componente (s)</div>
          {barData.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={barData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text2)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text2)' }} />
                <Tooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {componentKeys.map((k, i) => (
                  <Bar key={k} dataKey={k} stackId="a" fill={COMPONENT_COLORS[i % COMPONENT_COLORS.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div style={cardStyle}>
          <div style={cardTitle}>Distribución por tipo</div>
          {donutData.length === 0 ? <Empty /> : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={donutData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={2} dataKey="value">
                    {donutData.map((e, i) => (<Cell key={i} fill={TASKTYPE_COLORS[e.code] || '#6b7280'} />))}
                  </Pie>
                  <Tooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8 }}>
                {donutData.map((d, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text2)' }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: TASKTYPE_COLORS[d.code] || '#6b7280' }} />
                    {d.name} ({d.value})
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Top 10 memoria */}
      <div style={{ ...cardStyle, marginTop: 18 }}>
        <div style={cardTitle}>Top 10 actividades por memoria HANA pico</div>
        {top10Mem.length === 0 ? <Empty /> : top10Mem.map((r, i) => {
          const max = top10Mem[0].HanaMaxMemory || 1
          const pct = (r.HanaMaxMemory / max) * 100
          return (
            <div key={r.ActivityId} style={{ marginBottom: 8, cursor: 'pointer' }} onClick={() => setSelected(r)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <div style={{ fontSize: 11, color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                  <span style={{ color: 'var(--text3)', fontWeight: 700 }}>#{i+1}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.JobName || r.ActivityName}
                  </span>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--purple)' }}>{fmtBytes(r.HanaMaxMemory)}</span>
              </div>
              <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
                <div style={{ height: '100%', width: `${pct}%`, background: 'var(--purple)', borderRadius: 2 }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* Tabla */}
      <div style={{ ...cardStyle, marginTop: 18, padding: 0, overflow: 'hidden' }}>
        <div style={{ ...cardTitle, padding: '14px 18px 0' }}>Actividades ({rows.length})</div>
        <div style={{ overflow: 'auto', maxHeight: 480 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg3, var(--bg))', position: 'sticky', top: 0, zIndex: 1 }}>
                <SortTh sk="StartMs"         cur={sortKey} dir={sortDir} onSort={handleSort}>Inicio ({tzSuffix})</SortTh>
                <SortTh sk="EndMs"           cur={sortKey} dir={sortDir} onSort={handleSort}>Fin ({tzSuffix})</SortTh>
                <SortTh sk="ActivityName"    cur={sortKey} dir={sortDir} onSort={handleSort}>Actividad</SortTh>
                <SortTh sk="ComponentName"   cur={sortKey} dir={sortDir} onSort={handleSort}>Componente</SortTh>
                <SortTh sk="TaskType"        cur={sortKey} dir={sortDir} onSort={handleSort}>Tipo</SortTh>
                <SortTh sk="JobName"         cur={sortKey} dir={sortDir} onSort={handleSort}>Job</SortTh>
                <SortTh sk="JobCount"        cur={sortKey} dir={sortDir} onSort={handleSort}>Run</SortTh>
                <SortTh sk="JobStepNumber"   cur={sortKey} dir={sortDir} onSort={handleSort}>Step</SortTh>
                <SortTh sk="FullName"        cur={sortKey} dir={sortDir} onSort={handleSort}>Usuario</SortTh>
                <SortTh sk="DurationSec"     cur={sortKey} dir={sortDir} onSort={handleSort} align="right">Duración</SortTh>
                <SortTh sk="HanaMaxMemory"   cur={sortKey} dir={sortDir} onSort={handleSort} align="right">Mem HANA</SortTh>
                <SortTh sk="PctHanaMaxMemory" cur={sortKey} dir={sortDir} onSort={handleSort} align="right">% Mem</SortTh>
                <SortTh sk="HanaCpuTime"     cur={sortKey} dir={sortDir} onSort={handleSort} align="right">CPU HANA</SortTh>
                <SortTh sk="ProcessingTime"  cur={sortKey} dir={sortDir} onSort={handleSort} align="right">Processing</SortTh>
                <SortTh sk="ResponseTime"    cur={sortKey} dir={sortDir} onSort={handleSort} align="right">Response</SortTh>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={15} style={{ padding: 24, textAlign: 'center', color: 'var(--text2)' }}>Cargando…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={15} style={{ padding: 24, textAlign: 'center', color: 'var(--text2)' }}>Sin datos en el período</td></tr>
              ) : sortedRows.map((r, i) => (
                <tr key={r.ActivityId}
                  onClick={() => setSelected(r)}
                  style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--bg2)', cursor: 'pointer' }}>
                  <Td mono>{fmtDateCell(r.StartMs, tzMode)}</Td>
                  <Td mono>{fmtDateCell(r.EndMs, tzMode)}</Td>
                  <Td>{r.ActivityName}</Td>
                  <Td>{r.ComponentName}</Td>
                  <Td>{TASKTYPE_LABEL[r.TaskType] || r.TaskType || '—'}</Td>
                  <Td mono>{r.JobName || '—'}</Td>
                  <Td align="center">{r.JobCount || '—'}</Td>
                  <Td align="center">{r.JobStepNumber || '—'}</Td>
                  <Td>{r.FullName || '—'}</Td>
                  <Td align="right">{r.DurationFmt || `${r.DurationSec.toFixed(3)}s`}</Td>
                  <Td align="right">{fmtBytes(r.HanaMaxMemory)}</Td>
                  <Td align="right">{r.PctHanaMaxMemory > 0 ? `${r.PctHanaMaxMemory.toFixed(1)}%` : '—'}</Td>
                  <Td align="right">{fmtMicroSec(r.HanaCpuTime)}</Td>
                  <Td align="right">{fmtMicroSec(r.ProcessingTime * 1000)}</Td>
                  <Td align="right">{fmtMicroSec(r.ResponseTime * 1000)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <PerformanceDrawer
          connection={connection}
          activity={selected}
          tzMode={tzMode}
          onClose={() => setSelected(null)}
          addLog={addLogRef.current}
        />
      )}

      <TechLogs logs={logs} />
    </div>
  )
}

function SortTh({ children, sk, cur, dir, onSort, align = 'left' }) {
  const active = cur === sk
  return (
    <th onClick={() => onSort(sk)} style={{
      padding: '9px 12px', textAlign: align, color: active ? 'var(--text)' : 'var(--text2)',
      fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)',
      fontSize: 11, cursor: 'pointer', userSelect: 'none',
    }}>
      {children}
      <span style={{ marginLeft: 4, opacity: active ? 1 : 0.3, fontSize: 9 }}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '▼'}
      </span>
    </th>
  )
}
function Td({ children, align = 'left', mono }) {
  return (
    <td style={{
      padding: '7px 12px', textAlign: align,
      fontFamily: mono ? 'var(--mono)' : 'var(--font)',
      color: 'var(--text)', borderBottom: '1px solid var(--border)',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260,
    }}>{children}</td>
  )
}

function KpiCard({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  )
}

function Empty() {
  return <div style={{ fontSize: 12, color: 'var(--text3)', padding: '16px 0' }}>Sin datos en el período</div>
}

function TzToggle({ mode, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: 2 }}>
      <button onClick={() => onToggle('utc')} style={{
        padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer', border: 'none',
        background: mode === 'utc' ? 'var(--border2)' : 'transparent', color: mode === 'utc' ? '#fff' : 'var(--text3)',
      }}>UTC</button>
      <button onClick={() => onToggle('local')} style={{
        padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer', border: 'none',
        background: mode === 'local' ? 'var(--border2)' : 'transparent', color: mode === 'local' ? '#fff' : 'var(--text3)',
      }}>{getTzLabel()}</button>
    </div>
  )
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
