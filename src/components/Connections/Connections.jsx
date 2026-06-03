import { useState, useRef } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useI18n } from '../../context/I18nContext'
import ConnectionForm from './ConnectionForm'
import ConnectionAvatar from './ConnectionAvatar'
import ImportConnectionsModal from './ImportConnectionsModal'
import { remove } from '../../services/connectionStorage'
import { getConnectionSapUrl } from '../../utils/sapUrl'
import { connDisplayName } from '../../utils/connDisplayName'

const EXPORT_VERSION = '1.0'

function parseImportText(text, t) {
  let raw
  try { raw = JSON.parse(text) }
  catch { throw new Error(t('conn.errInvalidJson')) }

  const arr = Array.isArray(raw) ? raw : raw?.connections
  if (!Array.isArray(arr)) throw new Error(t('conn.errNotArray'))

  const valid = []
  const invalid = []
  arr.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      invalid.push({ index: i, reason: t('conn.errInvalidEntry') }); return
    }
    const name     = typeof c.name     === 'string' ? c.name.trim()     : ''
    const ambiente = typeof c.ambiente === 'string' ? c.ambiente.trim() : ''
    if (!name || !ambiente) {
      invalid.push({ index: i, reason: t('conn.errMissingFields') }); return
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
  const { t } = useI18n()
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
    if (!confirm(t('conn.deleteConfirm', { name }))) return
    remove(id)
    onDeleted(id)
  }

  function handleExport() {
    if (connections.length === 0) return
    try {
      downloadConnectionsFile(connections)
      const n = connections.length
      setFeedback({ kind: 'ok', text: n === 1 ? t('conn.msgExported1') : t('conn.msgExportedN', { n }) })
      setTimeout(() => setFeedback(null), 3500)
    } catch (e) {
      setFeedback({ kind: 'error', text: t('conn.errExport', { msg: e.message }) })
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
      const parsed = parseImportText(text, t)
      if (parsed.connections.length === 0 && parsed.invalid.length === 0) {
        setFeedback({ kind: 'error', text: t('conn.errEmpty') })
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
    if (added)    parts.push(added    === 1 ? t('conn.msgAdded1')    : t('conn.msgAddedN',    { n: added }))
    if (replaced) parts.push(replaced === 1 ? t('conn.msgReplaced1') : t('conn.msgReplacedN', { n: replaced }))
    if (skipped)  parts.push(skipped  === 1 ? t('conn.msgSkipped1')  : t('conn.msgSkippedN',  { n: skipped }))
    setFeedback({ kind: 'ok', text: parts.length ? parts.join(', ') : t('conn.noChanges') })
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
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{t('conn.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3 }}>
            {t('conn.subtitle')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={handleImportClick}
            title={t('conn.importTitle')}
            style={secondaryBtnStyle}
          >
            {t('conn.import')}
          </button>
          <button
            onClick={handleExport}
            disabled={connections.length === 0}
            title={connections.length === 0 ? t('conn.exportDisabled') : t('conn.exportEnabled')}
            style={{
              ...secondaryBtnStyle,
              opacity: connections.length === 0 ? 0.5 : 1,
              cursor:  connections.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {t('conn.export')}
          </button>
          <button onClick={handleNew} style={{
            background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: 'var(--text-on-accent)', fontWeight: 700, fontSize: 12, padding: '8px 18px', cursor: 'pointer',
          }}>
            {t('conn.newBtn')}
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
            {t('conn.emptyLine1')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 20 }}>
            {t('conn.emptySubtitle')}
          </div>
          <button onClick={handleNew} style={{
            background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: 'var(--text-on-accent)', fontWeight: 700, fontSize: 12, padding: '8px 18px', cursor: 'pointer',
          }}>
            {t('conn.newBtn')}
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
              <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14 }}>{connDisplayName(conn, t)}</div>
              {conn.com0326?.user && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                  {conn.com0326.user}
                </div>
              )}
              {getConnectionSapUrl(conn) && (
                <a
                  href={getConnectionSapUrl(conn)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4, display: 'inline-block', textDecoration: 'none' }}
                  onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                  onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                >
                  {t('conn.openSap')}
                </a>
              )}
            </div>

            <div style={{
              display: 'flex', gap: 8, flexWrap: 'wrap',
              ...(isMobile && { width: '100%' }),
            }}>
              <button onClick={() => onSelect(conn.id)} style={{ ...btnStyle('var(--cyan)'), ...(isMobile && { flex: 1 }) }}>
                {t('conn.open')}
              </button>
              <button onClick={() => handleEdit(conn)} style={{ ...btnStyle('var(--text2)'), ...(isMobile && { flex: 1 }) }}>
                {t('conn.edit')}
              </button>
              <button onClick={() => handleDelete(conn.id, connDisplayName(conn, t))} style={{ ...btnStyle('var(--red)'), ...(isMobile && { flex: 1 }) }}>
                {t('conn.delete')}
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
