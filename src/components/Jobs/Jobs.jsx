import { useState, useEffect, useRef } from 'react'
import TechLogs, { useTechLogs } from '../TechLogs'

const JOB_PATH = '/JobTemplateSet'
const VISIBLE_COLS = ['JobTemplateName', 'JobTemplateText']

function encodeODataString(val) {
  return `%27${encodeURIComponent(val)}%27`
}

function EjecutarBtn({ row, connectionId }) {
  const [status, setStatus] = useState(null) // null | 'loading' | 'ok' | 'error'
  const [msg, setMsg] = useState('')

  async function handleEjecutar(e) {
    e.stopPropagation()
    const label = row.JobTemplateText || row.JobTemplateName
    if (!window.confirm(`¿Ejecutar el job "${label}"?\n\nEsta acción lanzará el job en SAP IBP.`)) return
    setStatus('loading'); setMsg('')
    try {
      const r = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId,
          path: `/JobSchedule?JobTemplateName=${encodeODataString(row.JobTemplateName)}&JobText=${encodeODataString(label)}`,
          method: 'POST',
          injectJobUser: true,
        }),
      })
      const data = await r.json()
      if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
      setStatus('ok')
    } catch (e) {
      setStatus('error'); setMsg(e.message)
    }
  }

  if (status === 'loading') return (
    <td style={TD} onClick={e => e.stopPropagation()}>
      <span style={{ fontSize: 11, color: 'var(--text2)' }}>Ejecutando…</span>
    </td>
  )

  if (status === 'ok') return (
    <td style={TD} onClick={e => e.stopPropagation()}>
      <span style={{ fontSize: 11, color: '#22c55e', fontWeight: 600 }}>✓ Enviado</span>
    </td>
  )

  if (status === 'error') return (
    <td style={{ ...TD, maxWidth: 320 }} onClick={e => e.stopPropagation()}>
      <span style={{ fontSize: 11, color: 'var(--red)', whiteSpace: 'normal', wordBreak: 'break-word' }}>✕ {msg}</span>
    </td>
  )

  return (
    <td style={TD} onClick={e => e.stopPropagation()}>
      <button
        onClick={handleEjecutar}
        style={{
          padding: '4px 12px', borderRadius: 5, border: '1px solid rgba(34,197,94,.35)',
          background: 'rgba(34,197,94,.08)', color: '#22c55e',
          fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >▶ Ejecutar</button>
    </td>
  )
}

const TD = { padding: '6px 12px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }

export default function Jobs({ connection }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortCol, setSortCol] = useState(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [colWidths, setColWidths] = useState({})
  const [search, setSearch] = useState('')
  const resizing = useRef(null)
  const [logs, addLog] = useTechLogs()

  useEffect(() => {
    setLoading(true); setError(''); setRows([]); setSearch('')
    const start = performance.now()
    fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id, path: JOB_PATH }),
    })
      .then(r => {
        const status = r.status
        return r.json().then(data => ({ data, status }))
      })
      .then(({ data, status }) => {
        const duration = Math.round(performance.now() - start)
        addLog({ method: 'POST', path: JOB_PATH, status, duration, detail: data.error || `${(data?.d?.results ?? data?.value ?? []).length} templates` })
        if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
        setRows(data?.d?.results ?? data?.value ?? [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [connection.id])

  const filtered = search.trim()
    ? rows.filter(row => Object.values(row).some(v => String(v ?? '').toLowerCase().includes(search.toLowerCase())))
    : rows

  const sorted = [...filtered].sort((a, b) => {
    if (!sortCol) return 0
    const av = String(a[sortCol] ?? ''), bv = String(b[sortCol] ?? '')
    return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
  })

  function handleSort(col) {
    if (sortCol === col) setSortAsc(a => !a)
    else { setSortCol(col); setSortAsc(true) }
  }

  function onResizeStart(col, e) {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startW = colWidths[col] || 260
    resizing.current = { col, startX, startW }
    function onMove(e) {
      if (!resizing.current) return
      const { col, startX, startW } = resizing.current
      setColWidths(w => ({ ...w, [col]: Math.max(80, startW + e.clientX - startX) }))
    }
    function onUp() {
      resizing.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (loading) return (
    <div style={{ padding: 28, color: 'var(--text2)', fontSize: 13 }}>
      Cargando job templates de {connection.name}…
    </div>
  )

  if (error) return (
    <div style={{ padding: 28 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 12 }}>Job Templates</div>
      <div style={{
        background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)',
        borderRadius: 8, padding: '12px 16px', color: 'var(--red)', fontSize: 12,
      }}>✕ {error}</div>
    </div>
  )

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Job Templates</div>
          <div style={{ fontSize: 11, color: 'var(--text2)' }}>
            {sorted.length}{search ? ` de ${rows.length}` : ''} registros · {connection.name}
          </div>
        </div>
        <input
          type="text"
          placeholder="Buscar en todas las columnas…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text)', fontSize: 12,
            padding: '6px 12px', width: 240, outline: 'none',
          }}
        />
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>Sin resultados</div>
      ) : (
        <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, flex: 1 }}>
          <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)', position: 'sticky', top: 0, zIndex: 1 }}>
                {VISIBLE_COLS.map(col => {
                  const w = colWidths[col] || 260
                  return (
                    <th
                      key={col}
                      style={{
                        width: w, minWidth: w, padding: '9px 12px', textAlign: 'left',
                        color: sortCol === col ? 'var(--accent)' : 'var(--text2)',
                        fontWeight: 600, whiteSpace: 'nowrap', position: 'relative',
                        borderBottom: '1px solid var(--border)', cursor: 'pointer',
                        userSelect: 'none', overflow: 'hidden',
                      }}
                      onClick={() => handleSort(col)}
                    >
                      {col}
                      {sortCol === col && <span style={{ marginLeft: 4, fontSize: 10 }}>{sortAsc ? '↑' : '↓'}</span>}
                      <span
                        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 5, cursor: 'col-resize', background: 'transparent' }}
                        onClick={e => e.stopPropagation()}
                        onMouseDown={e => onResizeStart(col, e)}
                      />
                    </th>
                  )
                })}
                <th style={{
                  width: 110, minWidth: 110, padding: '9px 12px', textAlign: 'left',
                  color: 'var(--text2)', fontWeight: 600,
                  borderBottom: '1px solid var(--border)', userSelect: 'none',
                }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={VISIBLE_COLS.length + 1} style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text2)', fontSize: 12 }}>
                    Sin resultados para "{search}"
                  </td>
                </tr>
              ) : sorted.map((row, i) => (
                <tr
                  key={i}
                  style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--bg2)' }}
                >
                  {VISIBLE_COLS.map(col => (
                    <td
                      key={col}
                      style={{
                        padding: '7px 12px', color: 'var(--text)',
                        borderBottom: '1px solid var(--border)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        maxWidth: colWidths[col] || 260,
                      }}
                      title={String(row[col] ?? '')}
                    >
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                  <EjecutarBtn row={row} connectionId={connection.id} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TechLogs logs={logs} />
    </div>
  )
}
