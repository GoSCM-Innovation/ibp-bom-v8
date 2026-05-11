import { useState, useRef, useEffect } from 'react'
import { loadOrchs, saveOrchs, createOrch, updateOrch, deleteOrch, exportOrchs, importOrchs } from './useOrchStorage'
import { useOrchRun } from './useOrchRun'
import OrchBuilder from './OrchBuilder'
import RunView from './RunView'

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function Orchestrations({ connection, session }) {
  const connId = connection.id

  const [orchs, setOrchs]               = useState(() => loadOrchs(connId))
  const [selectedId, setSelectedId]     = useState(null)
  const [mode, setMode]                 = useState('build') // 'build' | 'run'
  const [importError, setImportError]   = useState('')
  const [importSuccess, setImportSuccess] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [importParsed, setImportParsed] = useState(null)
  const [replaceMode, setReplaceMode]   = useState(false)
  const fileRef = useRef(null)

  const { run, isRunning, start, cancel, reset } = useOrchRun(connection, session)

  const selected = orchs.find(o => o.id === selectedId) || null

  // Sync orchs from storage whenever connection changes
  useEffect(() => {
    setOrchs(loadOrchs(connId))
    setSelectedId(null)
    setMode('build')
    reset()
  }, [connId]) // eslint-disable-line react-hooks/exhaustive-deps

  function persistAndUpdate(newOrch) {
    updateOrch(connId, newOrch.id, newOrch)
    setOrchs(loadOrchs(connId))
  }

  function handleCreate() {
    const name = prompt('Nombre de la nueva orquestación:')?.trim()
    if (!name) return
    const orch = createOrch(connId, name)
    setOrchs(loadOrchs(connId))
    setSelectedId(orch.id)
    setMode('build')
    reset()
  }

  function handleDelete(id) {
    if (!confirm('¿Eliminar esta orquestación? Esta acción no se puede deshacer.')) return
    deleteOrch(connId, id)
    setOrchs(loadOrchs(connId))
    if (selectedId === id) { setSelectedId(null); setMode('build'); reset() }
  }

  function handleRun() {
    if (!selected) return
    setMode('run')
    reset()
    start(selected)
  }

  function handleCancelRun() {
    cancel()
  }

  function handleCloseRun() {
    reset()
    setMode('build')
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  function handleExport() {
    if (!orchs.length) return
    exportOrchs(orchs, connection.name)
  }

  function handleExportSingle() {
    if (!selected) return
    exportOrchs([selected], connection.name)
  }

  // ── Import ──────────────────────────────────────────────────────────────────
  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result)
        if (!parsed.orchestrations || !Array.isArray(parsed.orchestrations)) {
          throw new Error('Formato de archivo inválido (falta "orchestrations")')
        }
        setImportParsed(parsed)
        setShowImportModal(true)
        setImportError('')
      } catch (err) {
        setImportError(err.message)
      }
    }
    reader.readAsText(file)
  }

  function confirmImport() {
    if (!importParsed) return
    const { added, replaced, skipped, result } = importOrchs(connId, importParsed, replaceMode)
    setOrchs(result)
    setShowImportModal(false)
    setImportParsed(null)
    setImportSuccess(`Importadas: ${added} nuevas, ${replaced} reemplazadas, ${skipped} omitidas.`)
    setTimeout(() => setImportSuccess(''), 4000)
  }

  // ── Render: empty state ──────────────────────────────────────────────────────
  const showEmpty = orchs.length === 0
  const showBuilder = !showEmpty && selectedId && selected && mode === 'build'
  const showRun     = !showEmpty && selectedId && selected && mode === 'run'

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* ── Left sidebar: list ── */}
      <div style={{
        width: 240, flexShrink: 0,
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg2)',
      }}
        className="orch-sidebar"
      >
        {/* Sidebar header */}
        <div style={{ padding: '14px 12px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Orquestaciones
          </div>

          <button
            onClick={handleCreate}
            style={{
              width: '100%', padding: '7px 0', borderRadius: 6,
              border: '1px solid rgba(34,197,94,.35)', background: 'rgba(34,197,94,.07)',
              color: '#22c55e', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              marginBottom: 6,
            }}
          >
            + Nueva orquestación
          </button>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {orchs.length === 0 && (
            <div style={{ padding: '16px 12px', fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
              Sin orquestaciones. Crea la primera.
            </div>
          )}

          {orchs.map(orch => {
            const isActive = orch.id === selectedId
            return (
              <div
                key={orch.id}
                onClick={() => {
                  if (isRunning && selectedId !== orch.id) return
                  setSelectedId(orch.id)
                  setMode('build')
                  if (selectedId !== orch.id) reset()
                }}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border)',
                  background: isActive ? 'rgba(59,130,246,.08)' : 'transparent',
                  borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'flex-start', gap: 6,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12, fontWeight: isActive ? 700 : 500,
                    color: isActive ? '#fff' : 'var(--text)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {orch.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                    {(orch.steps || []).length} paso{(orch.steps || []).length !== 1 ? 's' : ''}
                    {' · '}{formatDate(orch.createdAt)}
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(orch.id) }}
                  title="Eliminar"
                  style={{
                    background: 'none', border: 'none', color: 'var(--text3)',
                    fontSize: 11, cursor: 'pointer', padding: '2px 4px', lineHeight: 1,
                    flexShrink: 0, opacity: 0.5,
                    transition: 'opacity .12s, color .12s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = 1; e.currentTarget.style.color = 'var(--red)' }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = 0.5; e.currentTarget.style.color = 'var(--text3)' }}
                >✕</button>
              </div>
            )
          })}
        </div>

        {/* Sidebar footer: export/import */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {importSuccess && (
            <div style={{ fontSize: 10, color: '#22c55e', marginBottom: 2 }}>{importSuccess}</div>
          )}
          {importError && (
            <div style={{ fontSize: 10, color: 'var(--red)', marginBottom: 2 }}>✕ {importError}</div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              disabled={orchs.length === 0}
              onClick={handleExport}
              title="Exportar todas como JSON"
              style={{
                flex: 1, padding: '5px 0', borderRadius: 5,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text2)', fontSize: 10, cursor: orchs.length > 0 ? 'pointer' : 'default',
                opacity: orchs.length > 0 ? 1 : 0.4,
              }}
            >↓ Exportar</button>
            <button
              onClick={() => fileRef.current?.click()}
              title="Importar desde JSON"
              style={{
                flex: 1, padding: '5px 0', borderRadius: 5,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text2)', fontSize: 10, cursor: 'pointer',
              }}
            >↑ Importar</button>
          </div>
          {selected && (
            <button
              onClick={handleExportSingle}
              title="Exportar solo esta orquestación"
              style={{
                padding: '5px 0', borderRadius: 5,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text3)', fontSize: 10, cursor: 'pointer',
              }}
            >↓ Exportar "{selected.name.slice(0, 20)}{selected.name.length > 20 ? '…' : ''}"</button>
          )}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {!selectedId && (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 14,
          }}>
            <div style={{ fontSize: 40, opacity: 0.15 }}>⊞</div>
            <div style={{ fontSize: 14, color: 'var(--text2)', fontWeight: 600 }}>Orquestador de Jobs</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', maxWidth: 320 }}>
              Crea una orquestación para encadenar jobs en secuencia, definir condiciones de error y agrupar jobs en paralelo.
            </div>
            <button
              onClick={handleCreate}
              style={{
                marginTop: 4, padding: '8px 22px', borderRadius: 7,
                border: '1px solid rgba(34,197,94,.35)',
                background: 'rgba(34,197,94,.08)',
                color: '#22c55e', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}
            >+ Nueva orquestación</button>
          </div>
        )}

        {showBuilder && (
          <OrchBuilder
            key={selected.id}
            orch={selected}
            connection={connection}
            session={session}
            onUpdate={updatedOrch => {
              persistAndUpdate(updatedOrch)
              setOrchs(loadOrchs(connId))
            }}
            onRun={handleRun}
            disabled={isRunning}
          />
        )}

        {showRun && (
          <RunView
            run={run}
            orch={selected}
            onCancel={handleCancelRun}
            onClose={isRunning ? undefined : handleCloseRun}
          />
        )}
      </div>

      {/* ── Import modal ── */}
      {showImportModal && importParsed && (
        <>
          <div
            onClick={() => setShowImportModal(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 500, backdropFilter: 'blur(2px)' }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(440px, 95vw)',
            background: 'var(--bg)', border: '1px solid var(--border2)',
            borderRadius: 12, zIndex: 501, padding: '24px',
            boxShadow: '0 24px 64px rgba(0,0,0,.5)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 8 }}>
              Importar orquestaciones
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 16 }}>
              Se encontraron <strong style={{ color: '#fff' }}>{importParsed.orchestrations.length}</strong> orquestación(es) en el archivo.
              {importParsed.sourceConnection && (
                <span style={{ color: 'var(--text3)' }}> (origen: {importParsed.sourceConnection})</span>
              )}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 20 }}>
              <input
                type="checkbox"
                checked={replaceMode}
                onChange={e => setReplaceMode(e.target.checked)}
                style={{ width: 15, height: 15 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text)' }}>
                Reemplazar orquestaciones existentes con el mismo nombre
              </span>
            </label>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowImportModal(false); setImportParsed(null) }}
                style={{
                  padding: '7px 16px', borderRadius: 6,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text2)', fontSize: 12, cursor: 'pointer',
                }}
              >Cancelar</button>
              <button
                onClick={confirmImport}
                style={{
                  padding: '7px 16px', borderRadius: 6,
                  border: '1px solid rgba(34,197,94,.35)',
                  background: 'rgba(34,197,94,.1)',
                  color: '#22c55e', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}
              >↑ Importar</button>
            </div>
          </div>
        </>
      )}

      {/* Hidden file input */}
      <input ref={fileRef} type="file" accept=".json" onChange={handleFileChange} style={{ display: 'none' }} />

      <style>{`
        @media (max-width: 640px) {
          .orch-sidebar { width: 100% !important; max-width: 100%; border-right: none !important; }
        }
      `}</style>
    </div>
  )
}
