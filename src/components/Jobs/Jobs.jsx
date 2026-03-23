import { useState, useEffect, useRef } from 'react'

const JOB_PATH = '/sap/opu/odata/SAP/BC_EXT_APPJOB_MANAGEMENT;v=0002/JobTemplateSet'

export default function Jobs({ connection }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortCol, setSortCol] = useState(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [selected, setSelected] = useState(null)
  const [colWidths, setColWidths] = useState({})
  const resizing = useRef(null)

  useEffect(() => {
    setLoading(true)
    setError('')
    setRows([])
    setSelected(null)

    fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connection.id, path: JOB_PATH }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
        const items = data?.d?.results ?? data?.value ?? []
        setRows(items)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [connection.id])

  const cols = rows.length > 0
    ? Object.keys(rows[0]).filter(k => k !== '__metadata')
    : []

  const sorted = [...rows].sort((a, b) => {
    if (!sortCol) return 0
    const av = String(a[sortCol] ?? ''), bv = String(b[sortCol] ?? '')
    return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
  })

  function handleSort(col) {
    if (sortCol === col) setSortAsc(a => !a)
    else { setSortCol(col); setSortAsc(true) }
  }

  function onResizeStart(col, e) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = colWidths[col] || 160
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

  if (loading) return (
    <div style={{ padding: 28, color: 'var(--text2)', fontSize: 13 }}>
      Cargando jobs de {connection.name}…
    </div>
  )

  if (error) return (
    <div style={{ padding: 28 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 12 }}>Jobs</div>
      <div style={{
        background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)',
        borderRadius: 8, padding: '12px 16px', color: 'var(--red)', fontSize: 12,
      }}>
        ✕ {error}
      </div>
    </div>
  )

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16, flexShrink: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Jobs</div>
        <div style={{ fontSize: 11, color: 'var(--text2)' }}>
          {rows.length} registros · {connection.name}
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>Sin resultados</div>
      ) : (
        <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, flex: 1 }}>
          <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)', position: 'sticky', top: 0, zIndex: 1 }}>
                {cols.map(col => {
                  const w = colWidths[col] || 160
                  return (
                    <th
                      key={col}
                      style={{
                        width: w, minWidth: w, padding: '9px 12px',
                        textAlign: 'left', color: sortCol === col ? 'var(--accent)' : 'var(--text2)',
                        fontWeight: 600, whiteSpace: 'nowrap', position: 'relative',
                        borderBottom: '1px solid var(--border)', cursor: 'pointer',
                        userSelect: 'none', overflow: 'hidden',
                      }}
                      onClick={() => handleSort(col)}
                    >
                      {col}
                      {sortCol === col && (
                        <span style={{ marginLeft: 4, fontSize: 10 }}>{sortAsc ? '↑' : '↓'}</span>
                      )}
                      {/* Resize handle */}
                      <span
                        style={{
                          position: 'absolute', right: 0, top: 0, bottom: 0, width: 5,
                          cursor: 'col-resize', background: 'transparent',
                        }}
                        onClick={e => e.stopPropagation()}
                        onMouseDown={e => onResizeStart(col, e)}
                      />
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr
                  key={i}
                  onClick={() => setSelected(i === selected ? null : i)}
                  style={{
                    background: selected === i
                      ? 'rgba(247,168,0,.08)'
                      : i % 2 === 0 ? 'var(--bg)' : 'var(--bg2)',
                    cursor: 'pointer',
                    outline: selected === i ? '1px solid rgba(247,168,0,.25)' : 'none',
                    outlineOffset: -1,
                  }}
                >
                  {cols.map(col => (
                    <td
                      key={col}
                      style={{
                        padding: '7px 12px', color: 'var(--text)',
                        borderBottom: '1px solid var(--border)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        maxWidth: colWidths[col] || 160,
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
  )
}
