import { useState, useEffect, useRef } from 'react'

const JOB_PATH = '/JobTemplateSet'
const VISIBLE_COLS = ['JobTemplateName', 'JobTemplateText']

function encodeODataString(val) {
  return `%27${encodeURIComponent(val)}%27`
}


const BTN_BASE = {
  padding: '9px 14px', borderRadius: 6, border: '1px solid var(--border)',
  color: 'var(--text)', cursor: 'pointer', fontSize: 12, fontWeight: 500,
  textAlign: 'left', width: '100%', transition: 'opacity .15s',
}

function JobPanel({ row, connectionId, onClose }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [resultLabel, setResultLabel] = useState('')

  async function callProxy(label, path, method = 'GET') {
    setLoading(true); setError(''); setResult(null); setResultLabel(label)
    try {
      const r = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, path, method }),
      })
      const data = await r.json()
      if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
      setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleValidar() {
    callProxy('Validación', `/JobScheduleCheck?JobTemplateName=${encodeODataString(row.JobTemplateName)}`, 'POST')
  }

  function handleEjecutar() {
    const label = row.JobTemplateText || row.JobTemplateName
    if (!window.confirm(`¿Ejecutar el job "${label}"?\n\nEsta acción lanzará el job en SAP IBP.`)) return
    const jobText = encodeODataString(label)
    const jobName = encodeODataString(row.JobTemplateName)
    callProxy('Ejecución', `/JobSchedule?JobTemplateName=${jobName}&JobText=${jobText}`, 'POST')
  }

  return (
    <div style={{
      width: 320, flexShrink: 0, borderLeft: '1px solid var(--border)',
      background: 'var(--bg2)', display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: '#fff', fontSize: 13, marginBottom: 4, wordBreak: 'break-word' }}>
            {row.JobTemplateText || row.JobTemplateName}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
            {row.JobTemplateName}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1, flexShrink: 0 }}
        >✕</button>
      </div>

      {/* Actions */}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={handleValidar}
          disabled={loading}
          style={{ ...BTN_BASE, background: 'rgba(247,168,0,.08)', borderColor: 'rgba(247,168,0,.3)', color: 'var(--accent)' }}
        >
          ✓ Validar
        </button>
        <button
          onClick={handleEjecutar}
          disabled={loading}
          style={{ ...BTN_BASE, background: 'rgba(34,197,94,.08)', borderColor: 'rgba(34,197,94,.3)', color: '#22c55e' }}
        >
          ▶ Ejecutar
        </button>
      </div>

      {/* Result */}
      <div style={{ padding: '0 16px 16px', flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ color: 'var(--text2)', fontSize: 12 }}>Procesando…</div>}
        {error && (
          <div style={{
            background: 'rgba(255,107,107,.08)', border: '1px solid rgba(255,107,107,.25)',
            borderRadius: 6, padding: '10px 12px', color: 'var(--red)', fontSize: 11,
          }}>✕ {error}</div>
        )}
        {result && !error && (
          <div style={{
            background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)',
            borderRadius: 6, padding: '10px 12px', color: '#22c55e', fontSize: 11,
          }}>✓ {resultLabel} completado</div>
        )}
      </div>
    </div>
  )
}

export default function Jobs({ connection }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortCol, setSortCol] = useState(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [selected, setSelected] = useState(null)
  const [colWidths, setColWidths] = useState({})
  const [search, setSearch] = useState('')
  const resizing = useRef(null)

  useEffect(() => {
    setLoading(true); setError(''); setRows([]); setSelected(null); setSearch('')
    fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id, path: JOB_PATH }),
    })
      .then(r => r.json())
      .then(data => {
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

  const selectedRow = selected !== null ? sorted[selected] : null

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Table area */}
      <div style={{ flex: 1, padding: 28, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
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
            onChange={e => { setSearch(e.target.value); setSelected(null) }}
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
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={VISIBLE_COLS.length} style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text2)', fontSize: 12 }}>
                      Sin resultados para "{search}"
                    </td>
                  </tr>
                ) : sorted.map((row, i) => (
                  <tr
                    key={i}
                    onClick={() => setSelected(i === selected ? null : i)}
                    style={{
                      background: selected === i ? 'rgba(247,168,0,.08)' : i % 2 === 0 ? 'var(--bg)' : 'var(--bg2)',
                      cursor: 'pointer',
                      outline: selected === i ? '1px solid rgba(247,168,0,.25)' : 'none',
                      outlineOffset: -1,
                    }}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Side panel */}
      {selectedRow && (
        <JobPanel
          row={selectedRow}
          connectionId={connection.id}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
