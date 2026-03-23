import { useState, useEffect, useRef, useCallback } from 'react'

const REFRESH_MS = 30000
const DEFAULT_HOURS = 24

const PALETTE = [
  { bg: 'rgba(34,197,94,.15)',   color: '#22c55e', border: 'rgba(34,197,94,.3)' },
  { bg: 'rgba(251,191,36,.15)',  color: '#fbbf24', border: 'rgba(251,191,36,.3)' },
  { bg: 'rgba(255,107,107,.15)', color: '#ff6b6b', border: 'rgba(255,107,107,.3)' },
  { bg: 'rgba(59,130,246,.15)',  color: '#3b82f6', border: 'rgba(59,130,246,.3)' },
  { bg: 'rgba(139,92,246,.15)',  color: '#8b5cf6', border: 'rgba(139,92,246,.3)' },
  { bg: 'rgba(249,115,22,.15)',  color: '#f97316', border: 'rgba(249,115,22,.3)' },
  { bg: 'rgba(6,182,212,.15)',   color: '#06b6d4', border: 'rgba(6,182,212,.3)' },
  { bg: 'rgba(156,163,175,.15)', color: '#9ca3af', border: 'rgba(156,163,175,.3)' },
]

function toSapTs(date) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.0000000`
}

function formatSapTs(ts) {
  if (!ts || ts.length < 14) return ts || '—'
  return `${ts.slice(6, 8)}/${ts.slice(4, 6)}/${ts.slice(0, 4)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`
}

function toInputDate(date) {
  return date.toISOString().slice(0, 16)
}

export default function JobMonitor({ connection }) {
  const [statuses, setStatuses] = useState([])   // [{ JobStatus, JobStatusText, color }]
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [activeStatus, setActiveStatus] = useState('ALL')
  const [search, setSearch]     = useState('')
  const [lastRefresh, setLastRefresh] = useState(null)

  const defaultFrom = new Date(Date.now() - DEFAULT_HOURS * 3600 * 1000)
  const defaultTo   = new Date()
  const [fromDate, setFromDate] = useState(toInputDate(defaultFrom))
  const [toDate,   setToDate]   = useState(toInputDate(defaultTo))

  const timerRef = useRef(null)

  const proxyPost = useCallback((path) =>
    fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id, path }),
    }).then(r => r.json())
  , [connection.id])

  // Load status codes once
  useEffect(() => {
    proxyPost('/JobStatusInfoSet').then(data => {
      const results = data?.d?.results ?? data?.value ?? []
      const mapped = results.map((s, i) => ({
        ...s,
        color: PALETTE[i % PALETTE.length],
      }))
      setStatuses(mapped)
    }).catch(() => {})
  }, [proxyPost])

  // Load job headers
  const loadJobs = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await proxyPost('/JobHeaderSet')
      if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
      setRows(data?.d?.results ?? data?.value ?? [])
      setLastRefresh(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [proxyPost])

  useEffect(() => {
    loadJobs()
    timerRef.current = setInterval(loadJobs, REFRESH_MS)
    return () => clearInterval(timerRef.current)
  }, [loadJobs])

  // Filters
  const fromTs = toSapTs(new Date(fromDate))
  const toTs   = toSapTs(new Date(toDate))

  const filtered = rows.filter(r => {
    const ts = r.JobStartDateTime || ''
    if (ts && (ts < fromTs || ts > toTs)) return false
    if (activeStatus !== 'ALL' && r.JobStatus !== activeStatus) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q))
    }
    return true
  })

  // Count per status for badges
  const countByStatus = {}
  rows.forEach(r => { countByStatus[r.JobStatus] = (countByStatus[r.JobStatus] || 0) + 1 })

  function statusColor(code) {
    return statuses.find(s => s.JobStatus === code)?.color || PALETTE[7]
  }

  function StatusBadge({ code }) {
    const s = statuses.find(x => x.JobStatus === code)
    const c = s?.color || PALETTE[7]
    return (
      <span style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: 20, fontSize: 10,
        fontWeight: 700, background: c.bg, color: c.color, border: `1px solid ${c.border}`,
        whiteSpace: 'nowrap',
      }}>
        {s?.JobStatusText || code || '—'}
      </span>
    )
  }

  const COLS = [
    { key: 'JobStatus',                label: 'Estado',       w: 130, render: (v) => <StatusBadge code={v} /> },
    { key: 'JobName',                  label: 'Job',          w: 200 },
    { key: 'JobText',                  label: 'Descripción',  w: 220 },
    { key: 'JobTemplateText',          label: 'Template',     w: 220 },
    { key: 'JobCreatedByFormattedName',label: 'Usuario',      w: 180 },
    { key: 'JobStepCount',             label: 'Pasos',        w: 70  },
    { key: 'JobStartDateTime',         label: 'Inicio',       w: 160, render: formatSapTs },
    { key: 'JobEndDateTime',           label: 'Fin',          w: 160, render: formatSapTs },
    { key: 'Periodic',                 label: 'Periódico',    w: 90,  render: v => v ? '✓' : '—' },
  ]

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexShrink: 0, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Job Monitor</div>
          <div style={{ fontSize: 11, color: 'var(--text2)' }}>
            {loading ? 'Cargando…' : `${filtered.length} de ${rows.length} registros`}
            {lastRefresh && !loading && (
              <span style={{ marginLeft: 8, opacity: .6 }}>· Actualizado {lastRefresh.toLocaleTimeString()}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="datetime-local" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={inputStyle} />
          <span style={{ color: 'var(--text2)', fontSize: 11 }}>→</span>
          <input type="datetime-local" value={toDate} onChange={e => setToDate(e.target.value)}
            style={inputStyle} />
          <input type="text" placeholder="Buscar…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...inputStyle, width: 180 }} />
          <button onClick={loadJobs} disabled={loading} style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 6,
            color: 'var(--text2)', fontSize: 11, fontWeight: 600, padding: '6px 12px', cursor: 'pointer',
          }}>↺ Refresh</button>
        </div>
      </div>

      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexShrink: 0, flexWrap: 'wrap' }}>
        <FilterBtn active={activeStatus === 'ALL'} onClick={() => setActiveStatus('ALL')}
          label="Todos" count={rows.length} color={PALETTE[3]} />
        {statuses.map(s => (
          <FilterBtn key={s.JobStatus} active={activeStatus === s.JobStatus}
            onClick={() => setActiveStatus(s.JobStatus)}
            label={s.JobStatusText || s.JobStatus}
            count={countByStatus[s.JobStatus] || 0}
            color={s.color} />
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)',
          borderRadius: 8, padding: '12px 16px', color: 'var(--red)', fontSize: 12, marginBottom: 14,
        }}>✕ {error}</div>
      )}

      {/* Table */}
      {!error && (
        <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, flex: 1 }}>
          <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)', position: 'sticky', top: 0, zIndex: 1 }}>
                {COLS.map(col => (
                  <th key={col.key} style={{
                    width: col.w, minWidth: col.w, padding: '9px 12px', textAlign: 'left',
                    color: 'var(--text2)', fontWeight: 600, whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--border)',
                  }}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={COLS.length} style={{ padding: '32px 12px', textAlign: 'center', color: 'var(--text2)' }}>
                  Cargando jobs…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={COLS.length} style={{ padding: '32px 12px', textAlign: 'center', color: 'var(--text2)' }}>
                  Sin resultados para el período y filtros seleccionados
                </td></tr>
              ) : filtered.map((row, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--bg2)' }}>
                  {COLS.map(col => (
                    <td key={col.key} style={{
                      padding: '7px 12px', color: 'var(--text)',
                      borderBottom: '1px solid var(--border)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      maxWidth: col.w,
                    }} title={String(row[col.key] ?? '')}>
                      {col.render ? col.render(row[col.key]) : String(row[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FilterBtn({ active, onClick, label, count, color }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 12px', borderRadius: 20, border: `1px solid ${active ? color.border : 'var(--border)'}`,
      background: active ? color.bg : 'transparent',
      color: active ? color.color : 'var(--text2)',
      fontSize: 11, fontWeight: active ? 700 : 400, cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 6, transition: 'all .15s',
    }}>
      {label}
      <span style={{
        background: active ? color.border : 'var(--border)', color: active ? color.color : 'var(--text2)',
        borderRadius: 10, padding: '0 5px', fontSize: 10, fontWeight: 700,
      }}>{count}</span>
    </button>
  )
}

const inputStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text)', fontSize: 11,
  padding: '6px 10px', outline: 'none',
}
