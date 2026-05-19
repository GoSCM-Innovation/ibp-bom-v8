import { useState, useRef } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import ConnectionForm from './ConnectionForm'
import ConnectionAvatar from './ConnectionAvatar'
import ImportConnectionsModal from './ImportConnectionsModal'
import { remove } from '../../services/connectionStorage'
import { getSapSystemUrl } from '../../utils/sapUrl'

const EXPORT_VERSION = '1.0'

function parseImportText(text) {
  let raw
  try { raw = JSON.parse(text) }
  catch { throw new Error('El archivo no es un JSON válido') }

  const arr = Array.isArray(raw) ? raw : raw?.connections
  if (!Array.isArray(arr)) throw new Error('El archivo no contiene un array de conexiones')

  const valid = []
  const invalid = []
  arr.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      invalid.push({ index: i, reason: 'no es un objeto' }); return
    }
    const name     = typeof c.name     === 'string' ? c.name.trim()     : ''
    const ambiente = typeof c.ambiente === 'string' ? c.ambiente.trim() : ''
    if (!name || !ambiente) {
      invalid.push({ index: i, reason: 'faltan name o ambiente' }); return
    }
    valid.push({
      name,
      ambiente,
      jobUser:  typeof c.jobUser  === 'string' ? c.jobUser  : '',
      logoUrl:  typeof c.logoUrl  === 'string' ? c.logoUrl  : '',
      com0326:  c.com0326  && typeof c.com0326  === 'object' ? { url: c.com0326.url  || '', user: c.com0326.user  || '' } : undefined,
      com0068:  c.com0068  && typeof c.com0068  === 'object' ? { url: c.com0068.url  || '', user: c.com0068.user  || '' } : undefined,
      com0924:  c.com0924  && typeof c.com0924  === 'object' ? { url: c.com0924.url  || '', user: c.com0924.user  || '' } : undefined,
    })
  })

  return { connections: valid, invalid, version: raw?.version, exportedAt: raw?.exportedAt }
}

function downloadConnectionsFile(connections) {
  const payload = {
    version:    EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    connections: connections.map(c => ({
      name:     c.name,
      ambiente: c.ambiente,
      jobUser:  c.jobUser  || '',
      logoUrl:  c.logoUrl  || '',
      com0326:  c.com0326  ? { url: c.com0326.url  || '', user: c.com0326.user  || '' } : undefined,
      com0068:  c.com0068  ? { url: c.com0068.url  || '', user: c.com0068.user  || '' } : undefined,
      com0924:  c.com0924  ? { url: c.com0924.url  || '', user: c.com0924.user  || '' } : undefined,
    })),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  const date = new Date().toISOString().slice(0, 10)
  a.href     = url
  a.download = `ibp-conexiones-${date}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function Connections({ connections, onSaved, onDeleted, onSelect, onBulkImport }) {
  const isMobile = useIsMobile()
  const [showForm, setShowForm]           = useState(false)
  const [editing, setEditing]             = useState(null)
  const [importParsed, setImportParsed]   = useState(null)
  const [importFileName, setImportFileName] = useState('')
  const [feedback, setFeedback]           = useState(null)
  const fileInputRef = useRef(null)

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

  function handleDelete(id, name) {
    if (!confirm(`¿Eliminar la conexión "${name}"?`)) return
    remove(id)
    onDeleted(id)
  }

  function handleExport() {
    if (connections.length === 0) return
    try {
      downloadConnectionsFile(connections)
      setFeedback({ kind: 'ok', text: `${connections.length} conexion${connections.length === 1 ? '' : 'es'} exportada${connections.length === 1 ? '' : 's'}` })
      setTimeout(() => setFeedback(null), 3500)
    } catch (e) {
      setFeedback({ kind: 'error', text: `No se pudo exportar: ${e.message}` })
    }
  }

  function handleImportClick() {
    setFeedback(null)
    fileInputRef.current?.click()
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const parsed = parseImportText(text)
      if (parsed.connections.length === 0 && parsed.invalid.length === 0) {
        setFeedback({ kind: 'error', text: 'El archivo no contiene conexiones' })
        return
      }
      setImportFileName(file.name)
      setImportParsed(parsed)
    } catch (err) {
      setFeedback({ kind: 'error', text: err.message })
    }
  }

  function handleImportConfirm({ replaceDuplicates }) {
    const { added, replaced, skipped } = onBulkImport(importParsed.connections, { replaceDuplicates })
    setImportParsed(null)
    setImportFileName('')
    const parts = []
    if (added)    parts.push(`${added} agregada${added === 1 ? '' : 's'}`)
    if (replaced) parts.push(`${replaced} reemplazada${replaced === 1 ? '' : 's'}`)
    if (skipped)  parts.push(`${skipped} omitida${skipped === 1 ? '' : 's'}`)
    setFeedback({ kind: 'ok', text: parts.length ? parts.join(', ') : 'Sin cambios' })
    setTimeout(() => setFeedback(null), 4000)
  }

  function handleImportCancel() {
    setImportParsed(null)
    setImportFileName('')
  }

  return (
    <div style={{ padding: isMobile ? 14 : 28, maxWidth: 900 }}>
      {/* Title */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Conexiones</div>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3 }}>
            Tus conexiones SAP IBP, guardadas en este navegador
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={handleImportClick}
            title="Importar conexiones desde un archivo JSON"
            style={secondaryBtnStyle}
          >
            Importar
          </button>
          <button
            onClick={handleExport}
            disabled={connections.length === 0}
            title={connections.length === 0 ? 'No hay conexiones para exportar' : 'Descargar todas las conexiones como JSON'}
            style={{
              ...secondaryBtnStyle,
              opacity: connections.length === 0 ? 0.5 : 1,
              cursor:  connections.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Exportar
          </button>
          <button onClick={handleNew} style={{
            background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: 'var(--text-on-accent)', fontWeight: 700, fontSize: 12, padding: '8px 18px', cursor: 'pointer',
          }}>
            + Nueva conexión
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
        </div>
      </div>

      {/* Feedback toast */}
      {feedback && (
        <div style={{
          marginBottom: 14, padding: '8px 14px', borderRadius: 8, fontSize: 12,
          background: feedback.kind === 'ok' ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'color-mix(in srgb, var(--red) 12%, transparent)',
          border:     `1px solid ${feedback.kind === 'ok' ? 'color-mix(in srgb, var(--green) 35%, transparent)' : 'color-mix(in srgb, var(--red) 35%, transparent)'}`,
          color:      feedback.kind === 'ok' ? 'var(--green)' : 'var(--red)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>{feedback.kind === 'ok' ? '✓' : '✕'} {feedback.text}</span>
          <button
            onClick={() => setFeedback(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14, lineHeight: 1, opacity: .7 }}
          >×</button>
        </div>
      )}

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
            color: 'var(--text-on-accent)', fontWeight: 700, fontSize: 12, padding: '8px 18px', cursor: 'pointer',
          }}>
            + Nueva conexión
          </button>
        </div>
      )}

      {/* Connection cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {connections.map((conn) => (
          <div key={conn.id} style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 10, padding: isMobile ? '12px 14px' : '16px 20px',
            display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          }}>
            <ConnectionAvatar name={conn.name} logoUrl={conn.logoUrl} size={40} />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14 }}>{conn.name}</div>
              {conn.com0326?.user && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                  {conn.com0326.user}
                </div>
              )}
              {getSapSystemUrl(conn.com0326?.url) && (
                <a
                  href={getSapSystemUrl(conn.com0326?.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4, display: 'inline-block', textDecoration: 'none' }}
                  onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                  onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                >
                  Abrir en SAP IBP ↗
                </a>
              )}
            </div>

            <div style={{
              display: 'flex', gap: 8, flexWrap: 'wrap',
              ...(isMobile && { width: '100%' }),
            }}>
              <button onClick={() => onSelect(conn.id)} style={{ ...btnStyle('var(--cyan)'), ...(isMobile && { flex: 1 }) }}>
                Abrir
              </button>
              <button onClick={() => handleEdit(conn)} style={{ ...btnStyle('var(--text2)'), ...(isMobile && { flex: 1 }) }}>
                Editar
              </button>
              <button onClick={() => handleDelete(conn.id, conn.name)} style={{ ...btnStyle('var(--red)'), ...(isMobile && { flex: 1 }) }}>
                Eliminar
              </button>
            </div>
          </div>
        ))}
      </div>

      {importParsed && (
        <ImportConnectionsModal
          parsed={importParsed}
          existing={connections}
          fileName={importFileName}
          onConfirm={handleImportConfirm}
          onCancel={handleImportCancel}
        />
      )}
    </div>
  )
}

const secondaryBtnStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 7,
  color: 'var(--text2)', fontWeight: 600, fontSize: 12, padding: '8px 14px', cursor: 'pointer',
}

function btnStyle(color) {
  return {
    background: 'none', border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
    borderRadius: 6, color, fontSize: 11, fontWeight: 600,
    padding: '5px 12px', transition: 'all .15s',
  }
}
