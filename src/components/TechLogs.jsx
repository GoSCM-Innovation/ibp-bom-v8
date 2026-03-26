import { useState } from 'react'

/**
 * Collapsible panel that displays technical API logs.
 * Usage: const [logs, addLog] = useTechLogs()
 *        <TechLogs logs={logs} />
 *
 * Each log entry: { ts, method, path, status, duration, detail? }
 */
export function useTechLogs() {
  const [logs, setLogs] = useState([])

  function addLog(entry) {
    setLogs(prev => [{ ...entry, ts: new Date().toISOString() }, ...prev].slice(0, 100))
  }

  return [logs, addLog]
}

export default function TechLogs({ logs = [] }) {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ marginTop: 16 }}>
      <button
        onClick={() => setOpen(p => !p)}
        style={{
          background: open ? 'rgba(139,92,246,.1)' : 'rgba(255,255,255,.04)',
          border: `1px solid ${open ? 'rgba(139,92,246,.3)' : 'var(--border)'}`,
          borderRadius: 6, color: open ? 'var(--purple)' : 'var(--text2)',
          fontSize: 11, fontWeight: 600, padding: '6px 14px',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
          transition: 'all .15s',
        }}
      >
        <span style={{ fontSize: 12 }}>{open ? '▾' : '▸'}</span>
        Ver logs técnicos
        {logs.length > 0 && (
          <span style={{
            background: open ? 'rgba(139,92,246,.2)' : 'var(--border)',
            borderRadius: 10, padding: '0 6px', fontSize: 10, fontWeight: 700,
          }}>{logs.length}</span>
        )}
      </button>

      {open && (
        <div style={{
          marginTop: 8, background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 8, overflow: 'hidden', maxHeight: 320, overflowY: 'auto',
        }}>
          {logs.length === 0 ? (
            <div style={{ padding: 16, fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>
              Sin llamadas API registradas aún
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: 'var(--bg3)', position: 'sticky', top: 0 }}>
                  <th style={thStyle}>Hora</th>
                  <th style={thStyle}>Método</th>
                  <th style={thStyle}>Endpoint</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Duración</th>
                  <th style={thStyle}>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, i) => {
                  const isError = log.status && log.status >= 400
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--bg2)' }}>
                      <td style={tdStyle}>{new Date(log.ts).toLocaleTimeString()}</td>
                      <td style={tdStyle}>
                        <span style={{
                          padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                          background: log.method === 'POST' ? 'rgba(59,130,246,.15)' : 'rgba(52,211,153,.15)',
                          color: log.method === 'POST' ? '#3b82f6' : '#34d399',
                        }}>{log.method || 'GET'}</span>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={log.path}>
                        {log.path}
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: isError ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                          {log.status || '—'}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>
                        {log.duration ? `${log.duration}ms` : '—'}
                      </td>
                      <td style={{ ...tdStyle, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', color: isError ? 'var(--red)' : 'var(--text2)' }} title={log.detail}>
                        {log.detail || '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

const thStyle = {
  padding: '6px 10px', textAlign: 'left', color: 'var(--text2)',
  fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
}

const tdStyle = {
  padding: '5px 10px', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap', color: 'var(--text)',
}
