import { useState, useRef, useEffect } from 'react'
import { loadOrchs, saveOrchs, createOrch, updateOrch, deleteOrch, duplicateOrch, exportOrchs, importOrchs, loadRunState } from './useOrchStorage'
import { useOrchRun } from './useOrchRun'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useI18n } from '../../context/I18nContext'
import OrchBuilder from './OrchBuilder'
import RunView from './RunView'

export default function Orchestrations({ connection, session }) {
  const { t, lang } = useI18n()

  function formatDate(iso) {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleDateString(lang === 'en' ? 'en' : 'es', { day: '2-digit', month: 'short', year: '2-digit' })
  }
  const connId = connection.id

  const [orchs, setOrchs]               = useState(() => loadOrchs(connId))
  const [selectedId, setSelectedId]     = useState(() => loadRunState(connId)?.orchId ?? null)
  const [mode, setMode]                 = useState(() => loadRunState(connId) ? 'run' : 'build')
  const [importError, setImportError]   = useState('')
  const [importSuccess, setImportSuccess] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [importParsed, setImportParsed] = useState(null)
  const [replaceMode, setReplaceMode]   = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [fullscreen, setFullscreen]     = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newOrchName, setNewOrchName]         = useState('')
  const [deleteTargetId, setDeleteTargetId]   = useState(null)
  const [mobileView, setMobileView]           = useState('list')
  const fileRef = useRef(null)
  const isMobile = useIsMobile()

  const { run, isRunning, start, cancel, reset } = useOrchRun(connection, session)

  const selected = orchs.find(o => o.id === selectedId) || null

  useEffect(() => {
    setOrchs(loadOrchs(connId))
    setMobileView('list')
    setFullscreen(false)
    const savedRun = loadRunState(connId)
    if (savedRun) {
      setSelectedId(savedRun.orchId)
      setMode('run')
    } else {
      setSelectedId(null)
      setMode('build')
      reset()
    }
  }, [connId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedId) {
      setFullscreen(false)
      setMobileView('list')
    }
  }, [selectedId])

  function persistAndUpdate(newOrch) {
    updateOrch(connId, newOrch.id, newOrch)
    setOrchs(loadOrchs(connId))
  }

  function handleCreate() {
    setNewOrchName('')
    setShowCreateModal(true)
  }

  function confirmCreate() {
    const name = newOrchName.trim()
    if (!name) return
    const orch = createOrch(connId, name)
    setOrchs(loadOrchs(connId))
    setSelectedId(orch.id)
    setMode('build')
    setMobileView('builder')
    reset()
    setShowCreateModal(false)
    setNewOrchName('')
  }

  function handleDelete(id) {
    setDeleteTargetId(id)
  }

  function handleDuplicate(id) {
    const copy = duplicateOrch(connId, id)
    if (!copy) return
    setOrchs(loadOrchs(connId))
    setSelectedId(copy.id)
    setMode('build')
    setMobileView('builder')
    reset()
  }

  function confirmDelete() {
    const id = deleteTargetId
    setDeleteTargetId(null)
    deleteOrch(connId, id)
    setOrchs(loadOrchs(connId))
    if (selectedId === id) { setSelectedId(null); setMode('build'); setMobileView('list'); reset() }
  }

  function handleRun() {
    if (!selected) return
    setMode('run')
    reset()
    start(selected)
  }

  function handleCancelRun() { cancel() }
  function handleCloseRun()  { reset(); setMode('build') }

  function handleExport() {
    if (!orchs.length) return
    exportOrchs(orchs, connection.name)
  }

  function handleExportSingle() {
    if (!selected) return
    exportOrchs([selected], connection.name)
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result)
        if (!parsed.orchestrations || !Array.isArray(parsed.orchestrations)) {
          throw new Error(t('orch.invalidFormat'))
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
    setImportSuccess(t('orch.importResult', { new: added, replaced, skipped }))
    setTimeout(() => setImportSuccess(''), 4000)
  }

  const showEmpty   = orchs.length === 0
  const showBuilder = !showEmpty && selectedId && selected && mode === 'build'
  const showRun     = !showEmpty && selectedId && selected && mode === 'run'

  const builderEl = showBuilder ? (
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
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen(f => !f)}
    />
  ) : null

  return (
    <>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
        {/* ── Left sidebar ── */}
        <div
          style={{
            width: isMobile ? '100%' : (sidebarCollapsed ? 36 : 240),
            flexShrink: 0,
            borderRight: isMobile ? 'none' : '1px solid var(--border)',
            display: isMobile && mobileView === 'builder' ? 'none' : 'flex',
            flexDirection: 'column',
            background: 'var(--bg2)',
            transition: 'width .2s ease',
            overflow: 'hidden',
          }}
          className="orch-sidebar"
        >
          {/* Sidebar header */}
          <div style={{
            padding: sidebarCollapsed ? '14px 0' : '14px 12px 10px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'space-between',
            gap: 6,
          }}>
            {!sidebarCollapsed && (
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('orch.title')}
              </div>
            )}
            <button
              onClick={() => setSidebarCollapsed(c => !c)}
              title={sidebarCollapsed ? t('orch.expandPanel') : t('orch.collapsePanel')}
              style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 5,
                color: 'var(--text3)', fontSize: 11, cursor: 'pointer',
                padding: '3px 6px', lineHeight: 1, flexShrink: 0,
                transition: 'color .12s, border-color .12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.borderColor = 'var(--text2)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text3)'; e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              {sidebarCollapsed ? '▶' : '◀'}
            </button>
          </div>

          {/* Content only when expanded */}
          {!sidebarCollapsed && (
            <>
              <div style={{ padding: '10px 12px 6px', flexShrink: 0 }}>
                <button
                  disabled={isRunning}
                  onClick={handleCreate}
                  style={{
                    width: '100%', padding: '7px 0', borderRadius: 6,
                    border: '1px solid rgba(34,197,94,.35)', background: 'rgba(34,197,94,.07)',
                    color: isRunning ? 'var(--text3)' : '#22c55e',
                    fontSize: 11, fontWeight: 700,
                    cursor: isRunning ? 'default' : 'pointer',
                    opacity: isRunning ? 0.45 : 1,
                  }}
                >
                  {t('orch.newBtn')}
                </button>
              </div>

              {/* List */}
              <div style={{ flex: 1, overflow: 'auto' }}>
                {orchs.length === 0 && (
                  <div style={{ padding: '16px 12px', fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
                    {t('orch.empty')}
                  </div>
                )}
                {orchs.map(orch => {
                  const isActive = orch.id === selectedId
                  const stepCount = (orch.steps || []).length
                  return (
                    <div
                      key={orch.id}
                      onClick={() => {
                        if (isRunning) return
                        setSelectedId(orch.id)
                        setMode('build')
                        setMobileView('builder')
                        if (selectedId !== orch.id) reset()
                      }}
                      style={{
                        padding: '10px 12px',
                        borderBottom: '1px solid var(--border)',
                        background: isActive ? 'rgba(59,130,246,.08)' : 'transparent',
                        borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                        cursor: isRunning ? 'default' : 'pointer',
                        display: 'flex', alignItems: 'flex-start', gap: 6,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {isRunning && isActive && (
                            <span style={{ flexShrink: 0, fontSize: 8, color: '#22c55e', animation: 'orchRunPulse 1.2s ease-in-out infinite' }}>●</span>
                          )}
                          <span style={{
                            fontSize: 12, fontWeight: isActive ? 700 : 500,
                            color: isActive ? '#fff' : 'var(--text)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>
                            {orch.name}
                          </span>
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                          {stepCount === 1 ? t('orch.step1') : t('orch.stepN', { n: stepCount })}
                          {' · '}{formatDate(orch.createdAt)}
                        </div>
                      </div>
                      {!isRunning && (
                        <>
                          <button
                            onClick={e => { e.stopPropagation(); handleDuplicate(orch.id) }}
                            title={t('orch.duplicate')}
                            style={{
                              background: 'none', border: 'none', color: 'var(--text3)',
                              fontSize: 12, cursor: 'pointer', padding: '2px 4px', lineHeight: 1,
                              flexShrink: 0, opacity: 0.5,
                              transition: 'opacity .12s, color .12s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.opacity = 1; e.currentTarget.style.color = '#22c55e' }}
                            onMouseLeave={e => { e.currentTarget.style.opacity = 0.5; e.currentTarget.style.color = 'var(--text3)' }}
                          >⧉</button>
                          <button
                            onClick={e => { e.stopPropagation(); handleDelete(orch.id) }}
                            title={t('orch.deleteOrch')}
                            style={{
                              background: 'none', border: 'none', color: 'var(--text3)',
                              fontSize: 11, cursor: 'pointer', padding: '2px 4px', lineHeight: 1,
                              flexShrink: 0, opacity: 0.5,
                              transition: 'opacity .12s, color .12s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.opacity = 1; e.currentTarget.style.color = 'var(--red)' }}
                            onMouseLeave={e => { e.currentTarget.style.opacity = 0.5; e.currentTarget.style.color = 'var(--text3)' }}
                          >✕</button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Footer: export/import */}
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
                    title={t('orch.exportAll')}
                    style={{
                      flex: 1, padding: '5px 0', borderRadius: 5,
                      border: '1px solid var(--border)', background: 'transparent',
                      color: 'var(--text2)', fontSize: 10, cursor: orchs.length > 0 ? 'pointer' : 'default',
                      opacity: orchs.length > 0 ? 1 : 0.4,
                    }}
                  >{t('orch.exportAll')}</button>
                  <button
                    disabled={isRunning}
                    onClick={() => !isRunning && fileRef.current?.click()}
                    style={{
                      flex: 1, padding: '5px 0', borderRadius: 5,
                      border: '1px solid var(--border)', background: 'transparent',
                      color: isRunning ? 'var(--text3)' : 'var(--text2)',
                      fontSize: 10, cursor: isRunning ? 'default' : 'pointer',
                      opacity: isRunning ? 0.45 : 1,
                    }}
                  >{t('orch.importBtn')}</button>
                </div>
                {selected && (
                  <button
                    onClick={handleExportSingle}
                    title={t('orch.exportOne', { name: selected.name.slice(0, 20) + (selected.name.length > 20 ? '…' : '') })}
                    style={{
                      padding: '5px 0', borderRadius: 5,
                      border: '1px solid var(--border)', background: 'transparent',
                      color: 'var(--text3)', fontSize: 10, cursor: 'pointer',
                    }}
                  >{t('orch.exportOne', { name: selected.name.slice(0, 20) + (selected.name.length > 20 ? '…' : '') })}</button>
                )}
              </div>
            </>
          )}

          {/* Collapsed: icon-only actions */}
          {sidebarCollapsed && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '10px 0' }}>
              <button
                onClick={handleCreate}
                title={t('orch.newBtn')}
                style={{
                  background: 'rgba(34,197,94,.1)', border: '1px solid rgba(34,197,94,.3)',
                  borderRadius: 5, color: '#22c55e', fontSize: 14, cursor: 'pointer',
                  width: 26, height: 26, padding: 0, lineHeight: 1,
                }}
              >+</button>
              {orchs.map(orch => {
                const isActive = orch.id === selectedId
                return (
                  <div
                    key={orch.id}
                    onClick={() => {
                      if (isRunning) return
                      setSelectedId(orch.id)
                      setMode('build')
                      setMobileView('builder')
                      if (selectedId !== orch.id) reset()
                    }}
                    title={orch.name}
                    style={{
                      position: 'relative',
                      width: 26, height: 26, borderRadius: 5, cursor: isRunning ? 'default' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 700,
                      background: isActive ? 'var(--accent-bg-soft)' : 'var(--surface-glass)',
                      border: isActive ? '1px solid var(--accent)' : '1px solid var(--border)',
                      color: isActive ? 'var(--accent)' : 'var(--text3)',
                    }}
                  >
                    {orch.name.slice(0, 1).toUpperCase()}
                    {isRunning && isActive && (
                      <span style={{
                        position: 'absolute', top: -3, right: -3,
                        width: 7, height: 7, borderRadius: '50%',
                        background: 'var(--green)',
                        animation: 'orchRunPulse 1.2s ease-in-out infinite',
                      }} />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Right panel ── */}
        <div style={{
          flex: 1, overflow: 'hidden',
          display: isMobile && mobileView === 'list' ? 'none' : 'flex',
          flexDirection: 'column',
        }}>
          {/* Mobile back bar */}
          {isMobile && (
            <div style={{
              padding: '8px 12px', background: 'var(--bg2)',
              borderBottom: '1px solid var(--border)', flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <button
                onClick={() => setMobileView('list')}
                style={{
                  background: 'none', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text2)', fontSize: 12,
                  padding: '5px 12px', cursor: 'pointer',
                }}
              >{t('orch.back')}</button>
              {selected && (
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selected.name}
                </span>
              )}
            </div>
          )}

          {!selectedId && (
            <div style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 14,
            }}>
              <div style={{ fontSize: 40, opacity: 0.15 }}>⊞</div>
              <div style={{ fontSize: 14, color: 'var(--text2)', fontWeight: 600 }}>{t('orch.builderTitle')}</div>
              <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', maxWidth: 320 }}>
                {t('orch.builderEmpty')}
              </div>
              <button
                onClick={handleCreate}
                style={{
                  marginTop: 4, padding: '8px 22px', borderRadius: 7,
                  border: '1px solid rgba(34,197,94,.35)',
                  background: 'rgba(34,197,94,.08)',
                  color: '#22c55e', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}
              >{t('orch.newBtn')}</button>
            </div>
          )}

          {builderEl}

          {showRun && (
            <RunView
              run={run}
              orch={selected}
              onCancel={handleCancelRun}
              onClose={isRunning ? undefined : handleCloseRun}
              connection={connection}
              session={session}
            />
          )}
        </div>
      </div>

      {/* ── Fullscreen overlay ── */}
      {fullscreen && builderEl && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'var(--bg)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {builderEl}
        </div>
      )}

      {/* ── Import modal ── */}
      {showImportModal && importParsed && (
        <>
          <div
            onClick={() => setShowImportModal(false)}
            style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 500, backdropFilter: 'blur(2px)' }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(440px, 95vw)',
            background: 'var(--bg)', border: '1px solid var(--border2)',
            borderRadius: 12, zIndex: 501, padding: '24px',
            boxShadow: 'var(--shadow-lg)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
              {t('orch.importModal.title')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 16 }}>
              {t('orch.importModal.found', { n: importParsed.orchestrations.length })}
              {importParsed.sourceConnection && (
                <span style={{ color: 'var(--text3)' }}> ({importParsed.sourceConnection})</span>
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
                {t('orch.importModal.replaceCheck')}
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
              >{t('orch.importModal.cancel')}</button>
              <button
                onClick={confirmImport}
                style={{
                  padding: '7px 16px', borderRadius: 6,
                  border: '1px solid rgba(34,197,94,.35)',
                  background: 'rgba(34,197,94,.1)',
                  color: '#22c55e', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}
              >{t('orch.importModal.importBtn')}</button>
            </div>
          </div>
        </>
      )}

      <input ref={fileRef} type="file" accept=".json" onChange={handleFileChange} style={{ display: 'none' }} />

      {/* ── Create modal ── */}
      {showCreateModal && (
        <>
          <div
            onClick={() => setShowCreateModal(false)}
            style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 500, backdropFilter: 'blur(2px)' }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(400px, 92vw)',
            background: 'var(--bg2)', border: '1px solid var(--border2)',
            borderRadius: 12, zIndex: 501, padding: 24,
            boxShadow: 'var(--shadow-lg)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 16 }}>
              {t('orch.createModal.title')}
            </div>
            <input
              autoFocus
              value={newOrchName}
              onChange={e => setNewOrchName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmCreate(); if (e.key === 'Escape') setShowCreateModal(false) }}
              placeholder={t('orch.createModal.placeholder')}
              style={{
                width: '100%', background: 'var(--bg)', border: '1px solid var(--border2)',
                borderRadius: 7, color: 'var(--text)', fontSize: 13, fontWeight: 500,
                padding: '9px 12px', outline: 'none', marginBottom: 18,
              }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border2)'}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowCreateModal(false)}
                style={{
                  padding: '7px 16px', borderRadius: 6,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text2)', fontSize: 12, cursor: 'pointer',
                }}
              >{t('orch.createModal.cancel')}</button>
              <button
                onClick={confirmCreate}
                disabled={!newOrchName.trim()}
                style={{
                  padding: '7px 18px', borderRadius: 6,
                  border: '1px solid rgba(34,197,94,.4)',
                  background: newOrchName.trim() ? 'rgba(34,197,94,.12)' : 'transparent',
                  color: newOrchName.trim() ? '#22c55e' : 'var(--text3)',
                  fontSize: 12, fontWeight: 700,
                  cursor: newOrchName.trim() ? 'pointer' : 'default',
                }}
              >{t('orch.createModal.createBtn')}</button>
            </div>
          </div>
        </>
      )}

      {/* ── Delete confirm modal ── */}
      {deleteTargetId && (
        <>
          <div
            onClick={() => setDeleteTargetId(null)}
            style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 500, backdropFilter: 'blur(2px)' }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(380px, 92vw)',
            background: 'var(--bg2)', border: '1px solid var(--border2)',
            borderRadius: 12, zIndex: 501, padding: 24,
            boxShadow: 'var(--shadow-lg)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>{t('orch.deleteModal.title')}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 20 }}>
              {t('orch.deleteModal.confirm')}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setDeleteTargetId(null)}
                style={{
                  padding: '7px 16px', borderRadius: 6,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text2)', fontSize: 12, cursor: 'pointer',
                }}
              >{t('orch.deleteModal.cancel')}</button>
              <button
                onClick={confirmDelete}
                style={{
                  padding: '7px 18px', borderRadius: 6,
                  border: '1px solid rgba(255,107,107,.4)',
                  background: 'rgba(255,107,107,.12)',
                  color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}
              >{t('orch.deleteModal.deleteBtn')}</button>
            </div>
          </div>
        </>
      )}

      <style>{`
        @keyframes orchRunPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.45; transform: scale(0.75); }
        }
      `}</style>
    </>
  )
}
