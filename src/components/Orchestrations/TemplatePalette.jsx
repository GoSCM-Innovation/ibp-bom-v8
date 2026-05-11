import { useState, useEffect } from 'react'
import { proxyCall } from '../../services/proxyCall'
import ProgressBar from '../ui/ProgressBar'

export default function TemplatePalette({ connection, session, onAddTask, onAddGroup, targetGroupId, disabled }) {
  const [templates, setTemplates]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')
  const [search, setSearch]         = useState('')

  useEffect(() => {
    setLoading(true); setError('')
    proxyCall({ connection, session, path: '/JobTemplateSet' })
      .then(r => r.json())
      .then(data => {
        if (data?.error) throw new Error(data.error)
        setTemplates(data?.d?.results ?? data?.value ?? [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [connection, session])

  const filtered = search.trim()
    ? templates.filter(t =>
        (t.JobTemplateName + ' ' + t.JobTemplateText).toLowerCase().includes(search.toLowerCase())
      )
    : templates

  function buildStep(t) {
    return {
      id: crypto.randomUUID(),
      type: 'task',
      jobTemplateName: t.JobTemplateName,
      jobTemplateText: t.JobTemplateText || t.JobTemplateName,
      errorStrategy: 'stop',
      maxRetries: 3,
      retryDelaySec: 60,
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      borderRight: '1px solid var(--border)', background: 'var(--bg2)',
    }}>
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          Job Templates
        </div>
        <input
          type="text"
          placeholder="Buscar template…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'var(--bg3)', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text)', fontSize: 11,
            padding: '6px 10px', outline: 'none',
          }}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {loading && (
          <div style={{ padding: '16px 12px', color: 'var(--text2)', fontSize: 11 }}>
            <ProgressBar loading />
            Cargando templates…
          </div>
        )}

        {error && (
          <div style={{ padding: '12px', color: 'var(--red)', fontSize: 11 }}>✕ {error}</div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div style={{ padding: '12px', color: 'var(--text3)', fontSize: 11, fontStyle: 'italic' }}>
            {search ? 'Sin coincidencias' : 'Sin templates disponibles'}
          </div>
        )}

        {!loading && !error && filtered.map(t => (
          <div
            key={t.JobTemplateName}
            style={{
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t.JobTemplateText || t.JobTemplateName}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t.JobTemplateName}
              </div>
            </div>
            <button
              disabled={disabled}
              onClick={() => !disabled && onAddTask(buildStep(t))}
              title={targetGroupId ? 'Agregar al grupo seleccionado' : 'Agregar a la secuencia'}
              style={{
                padding: '4px 8px', borderRadius: 5, flexShrink: 0,
                border: '1px solid rgba(34,197,94,.3)',
                background: 'rgba(34,197,94,.07)',
                color: disabled ? 'var(--text3)' : '#22c55e',
                fontSize: 11, fontWeight: 700, cursor: disabled ? 'default' : 'pointer',
                lineHeight: 1,
              }}
            >+</button>
          </div>
        ))}
      </div>

      {/* Add group button */}
      {!disabled && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button
            onClick={() => onAddGroup()}
            style={{
              width: '100%', padding: '7px 0', borderRadius: 6,
              border: '1px dashed rgba(99,102,241,.4)', background: 'transparent',
              color: 'rgba(129,140,248,.8)', fontSize: 11, cursor: 'pointer',
            }}
          >⊞ Nuevo grupo paralelo</button>
        </div>
      )}
    </div>
  )
}
