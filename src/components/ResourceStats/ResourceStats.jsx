import { useState, useEffect, useCallback, useRef } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'

const RANGES = [
  { label: 'Última hora',    hours: 1   },
  { label: 'Últimas 4h',     hours: 4   },
  { label: 'Últimas 24h',    hours: 24  },
  { label: 'Últimos 7 días', hours: 168 },
  { label: 'Últimos 30 días', hours: 720 },
]

// Extrae ms del formato OData /Date(1234567890+0000)/
function parseMs(t) { return parseInt(t.slice(6)) }

// Promedia registros en buckets de intervalMs milisegundos
function downsample(rows, intervalMs) {
  if (!intervalMs || rows.length === 0) return rows
  const buckets = {}
  rows.forEach(r => {
    const bucket = Math.floor(r.ts / intervalMs) * intervalMs
    if (!buckets[bucket]) buckets[bucket] = { ts: bucket, cpuSum: 0, memSum: 0, count: 0 }
    buckets[bucket].cpuSum += r.cpu
    buckets[bucket].memSum += r.mem
    buckets[bucket].count++
  })
  return Object.values(buckets)
    .sort((a, b) => a.ts - b.ts)
    .map(b => ({
      ts:  b.ts,
      cpu: Math.round(b.cpuSum / b.count * 10) / 10,
      mem: Math.round(b.memSum / b.count * 10) / 10,
    }))
}

export default function ResourceStats({ connection }) {
  const [range,       setRange]       = useState(RANGES[2]) // 24h default
  const [data,        setData]        = useState([])
  const [current,     setCurrent]     = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [lastRefresh, setLastRefresh] = useState(null)
  const timerRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const from = new Date(Date.now() - range.hours * 3600 * 1000).toISOString()
      const filter = `Timestamp%20gt%20datetimeoffset'${encodeURIComponent(from)}'`
      const path = `/RES_CONS_STATS?$format=json&$filter=${filter}`

      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connection.id, path, com: '0068' }),
      })
      if (!res.ok) throw new Error((await res.json()).error || `Error ${res.status}`)
      const json = await res.json()

      // API devuelve descendente → invertir para el gráfico (ascendente)
      const rows = (json.d?.results || [])
        .map(r => ({
          ts:  parseMs(r.Timestamp),
          cpu: parseFloat(r.CpuUsage),
          mem: parseFloat(r.MemoryUsage),
        }))
        .reverse()

      // Downsample: 7d → cada 10min, 30d → cada hora
      const intervalMs = range.hours >= 720 ? 60 * 60000
                       : range.hours >= 168 ? 10 * 60000
                       : null
      const processed = downsample(rows, intervalMs)

      setData(processed)
      if (processed.length > 0) setCurrent(processed[processed.length - 1])
      setLastRefresh(new Date())
      setError('')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [connection.id, range])

  useEffect(() => {
    setLoading(true)
    setData([])
    load()
    timerRef.current = setInterval(load, 60_000)
    return () => clearInterval(timerRef.current)
  }, [load])

  function formatTick(ts) {
    const d = new Date(ts)
    if (range.hours <= 4)  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (range.hours <= 24) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  function handleRefresh() { setLoading(true); load() }

  return (
    <div style={{ padding: 28 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Resource Stats</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3 }}>
            {lastRefresh ? `Actualizado ${lastRefresh.toLocaleTimeString()}` : 'Cargando...'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {RANGES.map(r => (
            <button key={r.hours} onClick={() => setRange(r)} style={{
              padding: '5px 11px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
              background: range.hours === r.hours ? 'var(--accent)' : 'transparent',
              color:      range.hours === r.hours ? '#000' : 'var(--text2)',
              border:     `1px solid ${range.hours === r.hours ? 'var(--accent)' : 'var(--border)'}`,
              transition: 'all .15s',
            }}>{r.label}</button>
          ))}
          <button onClick={handleRefresh} disabled={loading} style={{
            padding: '5px 11px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
            background: 'transparent', border: '1px solid var(--border)', color: 'var(--text2)',
            marginLeft: 4, transition: 'all .15s',
          }}>↻</button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
        <KpiCard label="CPU actual" value={current?.cpu ?? null} color="#06b6d4" />
        <KpiCard label="Memoria actual" value={current?.mem ?? null} color="#a78bfa" />
      </div>

      {/* Error */}
      {error && (
        <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 16 }}>✕ {error}</div>
      )}

      {/* Chart */}
      {!error && (
        <div style={{
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '20px 8px 12px',
        }}>
          {loading ? (
            <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', fontSize: 12 }}>
              Cargando datos...
            </div>
          ) : data.length === 0 ? (
            <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', fontSize: 12 }}>
              Sin datos para el rango seleccionado.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={data} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={formatTick}
                  tick={{ fontSize: 10, fill: 'var(--text2)' }}
                  minTickGap={50}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 10, fill: 'var(--text2)' }}
                  tickFormatter={v => `${v}%`}
                  width={38}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
                  labelFormatter={v => new Date(v).toLocaleString()}
                  formatter={(v, name) => [`${v}%`, name === 'cpu' ? 'CPU' : 'Memoria']}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  formatter={v => v === 'cpu' ? 'CPU' : 'Memoria'}
                />
                <Line type="monotone" dataKey="cpu" stroke="#06b6d4" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                <Line type="monotone" dataKey="mem" stroke="#a78bfa" dot={false} strokeWidth={1.5} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  )
}

function KpiCard({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '16px 24px', minWidth: 150,
    }}>
      <div style={{ fontSize: 10, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color, fontFamily: 'var(--mono)' }}>
        {value !== null ? `${value}%` : '—'}
      </div>
    </div>
  )
}
