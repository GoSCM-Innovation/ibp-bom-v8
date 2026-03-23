import { useState } from 'react'
import ConnectionForm from './ConnectionForm'

export default function Connections({ connections, onSaved, onDeleted, onSelect }) {
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [testing, setTesting] = useState(null)
  const [testResult, setTestResult] = useState({})

  function handleEdit(conn) {
    setEditing(conn)
    setShowForm(true)
  }

  function handleNew() {
    setEditing(null)
    setShowForm(true)
  }

  function handleSaved() {
    setShowForm(false)
    setEditing(null)
    onSaved()
  }

  async function handleDelete(id, name) {
    if (!confirm(`¿Eliminar la conexión "${name}"?`)) return
    await fetch(`/api/connections/${id}`, { method: 'DELETE' })
    onDeleted(id)
  }

  async function handleTest(conn) {
    setTesting(conn.id)
    setTestResult(p => ({ ...p, [conn.id]: null }))
    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: conn.id, path: '/$metadata' }),
      })
      setTestResult(p => ({ ...p, [conn.id]: res.ok ? 'ok' : 'error' }))
    } catch {
      setTestResult(p => ({ ...p, [conn.id]: 'error' }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <div style={{ padding: 28, maxWidth: 900 }}>
      {/* Title */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>Conexiones</div>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3 }}>
            Gestiona los sistemas SAP IBP disponibles para el equipo de soporte
          </div>
        </div>
        <button onClick={handleNew} style={{
          background: 'var(--accent)', border: 'none', borderRadius: 7,
          color: '#000', fontWeight: 700, fontSize: 12, padding: '8px 18px',
        }}>
          + Nueva conexión
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div style={{ marginBottom: 24 }}>
          <ConnectionForm
            initial={editing}
            onSaved={handleSaved}
            onCancel={() => { setShowForm(false); setEditing(null) }}
          />
        </div>
      )}

      {/* Empty state */}
      {connections.length === 0 && !showForm && (
        <div style={{
          background: 'var(--bg2)', border: '1px dashed var(--border2)', borderRadius: 10,
          padding: '48px 24px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            No hay conexiones configuradas
          </div>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 20 }}>
            Agrega un sistema SAP IBP para empezar a gestionar jobs
          </div>
          <button onClick={handleNew} style={{
            background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: '#000', fontWeight: 700, fontSize: 12, padding: '8px 18px',
          }}>
            + Nueva conexión
          </button>
        </div>
      )}

      {/* Connection cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {connections.map(conn => (
          <div key={conn.id} style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '16px 20px',
            display: 'flex', alignItems: 'center', gap: 16,
          }}>
            {/* Icon */}
            <div style={{
              width: 40, height: 40, borderRadius: 8, flexShrink: 0,
              background: 'linear-gradient(135deg, rgba(247,168,0,.2), rgba(232,98,42,.2))',
              border: '1px solid rgba(247,168,0,.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18,
            }}>◉</div>

            {/* Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: '#fff', fontSize: 14 }}>{conn.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'var(--mono)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {conn.url}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                Usuario: {conn.user}
              </div>
            </div>

            {/* Test result */}
            {testResult[conn.id] && (
              <div style={{
                fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
                background: testResult[conn.id] === 'ok' ? 'rgba(52,211,153,.15)' : 'rgba(255,107,107,.15)',
                color: testResult[conn.id] === 'ok' ? 'var(--green)' : 'var(--red)',
                border: `1px solid ${testResult[conn.id] === 'ok' ? 'rgba(52,211,153,.3)' : 'rgba(255,107,107,.3)'}`,
              }}>
                {testResult[conn.id] === 'ok' ? '✓ Conectado' : '✕ Error'}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button onClick={() => onSelect(conn.id)} style={btnStyle('var(--cyan)')}>
                Abrir
              </button>
              <button onClick={() => handleTest(conn)} disabled={testing === conn.id} style={btnStyle('var(--text2)')}>
                {testing === conn.id ? '...' : 'Probar'}
              </button>
              <button onClick={() => handleEdit(conn)} style={btnStyle('var(--text2)')}>
                Editar
              </button>
              <button onClick={() => handleDelete(conn.id, conn.name)} style={btnStyle('var(--red)')}>
                Eliminar
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function btnStyle(color) {
  return {
    background: 'none', border: `1px solid ${color}33`,
    borderRadius: 6, color, fontSize: 11, fontWeight: 600,
    padding: '5px 12px', transition: 'all .15s',
  }
}
