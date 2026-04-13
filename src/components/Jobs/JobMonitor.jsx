import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import TechLogs, { useTechLogs } from '../TechLogs'
import PerformanceDrawer from '../Performance/PerformanceDrawer'
import {
  toSapTs, formatSapTs, toInputDate, inputDateToDate,
  getTzMode, setTzMode as saveTzMode, getTzLabel,
} from '../../utils/dateUtils'

function fmtBytesShort(b) {
  const n = Number(b)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}
function fmtMicroShort(us) {
  const n = Number(us)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)} ms`
  return `${(n / 1_000_000).toFixed(2)} s`
}

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

// P=Released, R=In Process, S=Scheduled, Y=Ready
const CANCELABLE_STATUSES = ['P', 'R', 'S', 'Y']

// A=Failed, U=User Error, C=Canceled, W=Finished w/Warning, F=Finished
const RESTARTABLE_STATUSES = ['A', 'U', 'C', 'W', 'F']

const RESTART_MODES = [
  {
    value: 'E',
    label: 'Desde el paso fallido',
    desc: 'Reinicia desde el paso que falló. Los pasos anteriores se omitirán.',
  },
  {
    value: 'A',
    label: 'Después del paso fallido',
    desc: 'Reinicia omitiendo el paso fallido y todos los anteriores.',
  },
]

function encodeODataString(val) {
  return `%27${encodeURIComponent(val)}%27`
}

export default function JobMonitor({ connection }) {
  const hasTaskmon = !!(connection.com0068?.taskmon?.enabled && connection.com0068?.taskmon?.url)
  const [taskmonMap, setTaskmonMap] = useState({}) // `${JobName}|${JobCount}` → { mem, cpu }
  const [telemetryFor, setTelemetryFor] = useState(null) // jobRef para drawer
  const [statuses, setStatuses]       = useState([])
  const [rows, setRows]               = useState([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState('')
  const [activeStatus, setActiveStatus] = useState('ALL')
  const [search, setSearch]           = useState('')
  const [lastRefresh, setLastRefresh] = useState(null)
  const [colWidths, setColWidths]     = useState({})
  const [selectedRow, setSelectedRow] = useState(null)
  const [cancelling, setCancelling]     = useState(false)
  const [cancelMsg, setCancelMsg]       = useState('')
  const [restarting, setRestarting]     = useState(false)
  const [restartMsg, setRestartMsg]     = useState('')
  const [restartModal, setRestartModal] = useState(false)
  const [tzMode, setTzModeState]        = useState(() => getTzMode())
  const resizing = useRef(null)
  const timerRef = useRef(null)
  const [logs, addLog] = useTechLogs()
  const addLogRef = useRef(addLog)
  addLogRef.current = addLog

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

  const proxyPost = useCallback(async (path, opts = {}) => {
    const start = performance.now()
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id, path, ...opts }),
    })
    const data = await res.json()
    const duration = Math.round(performance.now() - start)
    addLogRef.current({ method: opts.method || 'POST', path, status: res.status, duration, detail: data.error || 'OK' })
    return data
  }, [connection.id])

  // Load status codes once
  useEffect(() => {
    proxyPost('/JobStatusInfoSet').then(data => {
      const results = data?.d?.results ?? data?.value ?? []
      setStatuses(results.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] })))
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

  // Cargar telemetría TASKMON y mergear por JobName|JobCount
  useEffect(() => {
    if (!hasTaskmon || rows.length === 0) return
    let cancelled = false
    const fromUTC = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const filter = `StartTime ge datetimeoffset'${fromUTC}'`
    const path = `/xIBPxC_TASKMON_EXT_MAIN?$format=json&$top=2000&$orderby=StartTime desc&$filter=${encodeURIComponent(filter)}`
    ;(async () => {
      try {
        const start = performance.now()
        const res = await fetch('/api/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId: connection.id, path, com: '0068_taskmon' }),
        })
        const data = await res.json()
        addLogRef.current({ method: 'POST', path, status: res.status, duration: Math.round(performance.now() - start), detail: data.error || 'OK' })
        if (!res.ok || cancelled) return
        const map = {}
        for (const r of (data?.d?.results ?? [])) {
          if (!r.JobName) continue
          const key = `${r.JobName}|${r.JobCount}`
          // Quedarse con la primera (más reciente por orderby desc)
          if (!map[key]) {
            map[key] = {
              mem: Number(r.HanaMaxMemory) || 0,
              cpu: Number(r.HanaCpuTime) || 0,
            }
          }
        }
        setTaskmonMap(map)
      } catch { /* silencio: telemetría opcional */ }
    })()
    return () => { cancelled = true }
  }, [hasTaskmon, rows, connection.id])

  // Cancel job
  async function handleCancel() {
    if (!selectedRow) return
    const label = selectedRow.JobText || selectedRow.JobName
    if (!window.confirm(`¿Cancelar el job "${label}"?\n\nEsta acción detendrá el job en SAP IBP.`)) return
    setCancelling(true); setCancelMsg('')
    try {
      const path = `/JobCancel?JobName=${encodeODataString(selectedRow.JobName)}&JobRunCount=${encodeODataString(selectedRow.JobRunCount)}`
      const data = await proxyPost(path, { method: 'POST' })
      if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
      setCancelMsg('ok')
      await loadJobs()
      setTimeout(() => {
        setSelectedRow(null)
        setCancelMsg('')
      }, 2500)
    } catch (e) {
      setCancelMsg(e.message)
    } finally {
      setCancelling(false)
    }
  }

  // Restart job
  async function handleRestart(mode) {
    if (!selectedRow) return
    setRestartModal(false)
    setRestarting(true); setRestartMsg('')
    try {
      const path = `/JobRestart?JobName=${encodeODataString(selectedRow.JobName)}&JobRunCount=${encodeODataString(selectedRow.JobRunCount)}&JobRestartMode=${encodeODataString(mode)}`
      const data = await proxyPost(path, { method: 'POST' })
      if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
      setRestartMsg('ok')
      await loadJobs()
      setTimeout(() => {
        setSelectedRow(null)
        setRestartMsg('')
      }, 2500)
    } catch (e) {
      setRestartMsg(e.message)
    } finally {
      setRestarting(false)
    }
  }

  // Filters — siempre en UTC para coincidir con SAP
  const fromTs = toSapTs(inputDateToDate(fromDate, tzMode))
  const toTs   = toSapTs(inputDateToDate(toDate, tzMode))

  const sorted = [...rows].sort((a, b) => {
    const av = a.JobPlannedStartDateTime || '', bv = b.JobPlannedStartDateTime || ''
    return bv.localeCompare(av)
  })

  const filteredBase = sorted.filter(r => {
    const ts = r.JobPlannedStartDateTime || ''
    if (ts && (ts < fromTs || ts > toTs)) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q))
    }
    return true
  })

  const countByStatus = {}
  filteredBase.forEach(r => { countByStatus[r.JobStatus] = (countByStatus[r.JobStatus] || 0) + 1 })

  const filtered = filteredBase.filter(r =>
    activeStatus === 'ALL' || r.JobStatus === activeStatus
  )

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

  const tzSuffix = tzMode === 'utc' ? ' (UTC)' : ` (${getTzLabel()})`
  const BASE_COLS = useMemo(() => [
    { key: 'JobStatus',                label: 'Estado',                        w: 130, render: (v) => <StatusBadge code={v} /> },
    { key: 'JobTemplateText',          label: 'Template',                      w: 220 },
    { key: 'JobText',                  label: 'Descripción',                   w: 220 },
    { key: 'JobCreatedByFormattedName',label: 'Usuario',                       w: 180 },
    { key: 'JobStepCount',             label: 'Pasos',                         w: 70  },
    { key: 'JobPlannedStartDateTime',  label: `Inicio planificado${tzSuffix}`, w: 190, render: v => formatSapTs(v, tzMode) },
    { key: 'JobStartDateTime',         label: `Inicio real${tzSuffix}`,        w: 175, render: v => formatSapTs(v, tzMode) },
    { key: 'JobEndDateTime',           label: `Fin${tzSuffix}`,                w: 175, render: v => formatSapTs(v, tzMode) },
    { key: 'Periodic',                 label: 'Periódico',                     w: 90,  render: v => v ? '✓' : '—' },
    ...(hasTaskmon ? [
      { key: '_memHana', label: 'Mem HANA', w: 100, render: (_, row) => fmtBytesShort(taskmonMap[`${row.JobName}|${row.JobRunCount}`]?.mem) },
      { key: '_cpuHana', label: 'CPU HANA', w: 100, render: (_, row) => fmtMicroShort(taskmonMap[`${row.JobName}|${row.JobRunCount}`]?.cpu) },
    ] : []),
  ], [statuses, tzMode, tzSuffix, hasTaskmon, taskmonMap])

  const COLS = BASE_COLS.map(c => ({ ...c, w: colWidths[c.key] ?? c.w }))

  function onResizeStart(col, e) {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startW = colWidths[col] ?? BASE_COLS.find(c => c.key === col)?.w ?? 140
    resizing.current = { col, startX, startW }
    function onMove(e) {
      if (!resizing.current) return
      const { col, startX, startW } = resizing.current
      setColWidths(w => ({ ...w, [col]: Math.max(60, startW + e.clientX - startX) }))
    }
    function onUp() {
      resizing.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const isCancelable  = selectedRow && CANCELABLE_STATUSES.includes(selectedRow.JobStatus)
  const isRestartable = selectedRow && RESTARTABLE_STATUSES.includes(selectedRow.JobStatus)

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
          <TzToggle mode={tzMode} onToggle={handleTzToggle} />
          <input type="datetime-local" value={fromDate} onChange={e => setFromDate(e.target.value)} style={inputStyle} />
          <span style={{ color: 'var(--text2)', fontSize: 11 }}>→</span>
          <input type="datetime-local" value={toDate} onChange={e => setToDate(e.target.value)} style={inputStyle} />
          <input type="text" placeholder="Buscar…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, width: 180 }} />
          <button onClick={loadJobs} disabled={loading} style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 6,
            color: 'var(--text2)', fontSize: 11, fontWeight: 600, padding: '6px 12px', cursor: 'pointer',
          }}>↺ Refresh</button>
          <span style={{
            fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap',
            padding: '4px 8px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
          }}>🔄 Auto-refresh cada {REFRESH_MS / 1000}s</span>
        </div>
      </div>

      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexShrink: 0, flexWrap: 'wrap' }}>
        <FilterBtn active={activeStatus === 'ALL'} onClick={() => setActiveStatus('ALL')}
          label="Todos" count={filteredBase.length} color={PALETTE[3]} />
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
                    borderBottom: '1px solid var(--border)', position: 'relative', userSelect: 'none',
                  }}>
                    {col.label}
                    <span
                      style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 5, cursor: 'col-resize', background: 'transparent' }}
                      onClick={e => e.stopPropagation()}
                      onMouseDown={e => onResizeStart(col.key, e)}
                    />
                  </th>
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
              ) : filtered.map((row, i) => {
                const isSelected = selectedRow?.JobName === row.JobName && selectedRow?.JobRunCount === row.JobRunCount
                return (
                  <tr
                    key={i}
                    onClick={() => setSelectedRow(isSelected ? null : row)}
                    style={{
                      background: isSelected ? 'rgba(247,168,0,.08)' : i % 2 === 0 ? 'var(--bg)' : 'var(--bg2)',
                      outline: isSelected ? '1px solid rgba(247,168,0,.35)' : 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {COLS.map(col => (
                      <td key={col.key} style={{
                        padding: '7px 12px', color: isSelected ? '#fff' : 'var(--text)',
                        borderBottom: '1px solid var(--border)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        width: col.w, maxWidth: col.w,
                      }} title={String(row[col.key] ?? '')}>
                        {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Action bar — aparece al seleccionar una fila */}
      {selectedRow && (
        <div style={{
          marginTop: 12, padding: '12px 16px', flexShrink: 0,
          background: 'var(--bg2)', border: '1px solid var(--border2)',
          borderRadius: 8, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 2 }}>Job seleccionado</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {selectedRow.JobText || selectedRow.JobName}
              <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                {selectedRow.JobName} · {selectedRow.JobRunCount}
              </span>
            </div>
          </div>

          {cancelMsg === 'ok'  && <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>✓ Job cancelado</span>}
          {cancelMsg && cancelMsg !== 'ok' && <span style={{ fontSize: 11, color: 'var(--red)', maxWidth: 280 }}>✕ {cancelMsg}</span>}
          {restartMsg === 'ok' && <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>✓ Job reiniciado</span>}
          {restartMsg && restartMsg !== 'ok' && <span style={{ fontSize: 11, color: 'var(--red)', maxWidth: 280 }}>✕ {restartMsg}</span>}

          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={handleCancel}
              disabled={!isCancelable || cancelling}
              title={!isCancelable ? 'Solo se pueden cancelar jobs en ejecución' : 'Cancelar este job en SAP IBP'}
              style={{
                padding: '6px 16px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                border: '1px solid rgba(255,107,107,.4)',
                background: isCancelable ? 'rgba(255,107,107,.12)' : 'transparent',
                color: isCancelable ? 'var(--red)' : 'var(--text3)',
                cursor: isCancelable ? 'pointer' : 'not-allowed',
                opacity: cancelling ? .6 : 1,
              }}
            >
              {cancelling ? 'Cancelando…' : '✕ Cancelar job'}
            </button>
            <button
              onClick={() => setRestartModal(true)}
              disabled={!isRestartable || restarting}
              title={!isRestartable ? 'Solo se pueden reiniciar jobs finalizados o fallidos' : 'Reiniciar este job en SAP IBP'}
              style={{
                padding: '6px 16px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                border: '1px solid rgba(6,182,212,.4)',
                background: isRestartable ? 'rgba(6,182,212,.12)' : 'transparent',
                color: isRestartable ? 'var(--cyan)' : 'var(--text3)',
                cursor: isRestartable ? 'pointer' : 'not-allowed',
                opacity: restarting ? .6 : 1,
              }}
            >
              {restarting ? 'Reiniciando…' : '↺ Reiniciar job'}
            </button>
            {hasTaskmon && (
              <button
                onClick={() => setTelemetryFor({ JobName: selectedRow.JobName, JobCount: selectedRow.JobRunCount })}
                title="Ver telemetría HANA de esta ejecución"
                style={{
                  padding: '6px 16px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                  border: '1px solid rgba(167,139,250,.4)',
                  background: 'rgba(167,139,250,.12)', color: 'var(--purple)', cursor: 'pointer',
                }}
              >📊 Ver telemetría</button>
            )}
            <button
              onClick={() => { setSelectedRow(null); setCancelMsg(''); setRestartMsg('') }}
              style={{
                padding: '6px 14px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                border: '1px solid var(--border)', background: 'none', color: 'var(--text2)', cursor: 'pointer',
              }}
            >Deseleccionar</button>
          </div>
        </div>
      )}

      <TechLogs logs={logs} />

      {/* Performance drawer */}
      {telemetryFor && (
        <PerformanceDrawer
          connection={connection}
          jobRef={telemetryFor}
          tzMode={tzMode}
          onClose={() => setTelemetryFor(null)}
          addLog={addLogRef.current}
        />
      )}

      {/* Restart mode modal */}
      {restartModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500,
        }}>
          <div style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)',
            borderRadius: 12, padding: 28, width: 'min(440px, 92vw)', boxShadow: '0 16px 48px rgba(0,0,0,.6)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 6 }}>↺ Reiniciar job</div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 20 }}>
              Selecciona el modo de reinicio para <strong style={{ color: 'var(--text)' }}>{selectedRow.JobText || selectedRow.JobName}</strong>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
              {RESTART_MODES.map(m => (
                <button
                  key={m.value}
                  onClick={() => handleRestart(m.value)}
                  style={{
                    textAlign: 'left', padding: '12px 16px', borderRadius: 8,
                    border: '1px solid var(--border2)', background: 'var(--bg3)',
                    color: 'var(--text)', cursor: 'pointer', transition: 'all .15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--cyan)'; e.currentTarget.style.background = 'rgba(6,182,212,.08)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.background = 'var(--bg3)' }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--cyan)', marginBottom: 4 }}>
                    Modo {m.value} — {m.label}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5 }}>{m.desc}</div>
                </button>
              ))}
            </div>

            <button
              onClick={() => setRestartModal(false)}
              style={{
                width: '100%', padding: '8px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                border: '1px solid var(--border)', background: 'none', color: 'var(--text2)', cursor: 'pointer',
              }}
            >Cancelar</button>
          </div>
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

function TzToggle({ mode, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: 2 }}>
      <button
        onClick={() => onToggle('utc')}
        title="Mostrar horas en UTC (zona horaria de SAP IBP)"
        style={{
          padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer', border: 'none',
          background: mode === 'utc' ? 'var(--border2)' : 'transparent',
          color: mode === 'utc' ? '#fff' : 'var(--text3)',
        }}
      >UTC</button>
      <button
        onClick={() => onToggle('local')}
        title={`Convertir a hora local del navegador (${getTzLabel()})`}
        style={{
          padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer', border: 'none',
          background: mode === 'local' ? 'var(--border2)' : 'transparent',
          color: mode === 'local' ? '#fff' : 'var(--text3)',
        }}
      >{getTzLabel()}</button>
    </div>
  )
}

const inputStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text)', fontSize: 11,
  padding: '6px 10px', outline: 'none',
}
