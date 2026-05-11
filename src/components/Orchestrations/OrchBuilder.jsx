import { useState } from 'react'
import StepCard from './StepCard'
import TemplatePalette from './TemplatePalette'

// Pending group: when user clicks "+ al grupo" on a specific group step
// targetGroupId = id of the group to add the next template to

export default function OrchBuilder({
  orch, connection, session,
  onUpdate, onRun, disabled,
}) {
  const [name, setName]               = useState(orch.name)
  const [pendingGroup, setPendingGroup] = useState(null) // group stepId awaiting a template pick
  const [paletteOpen, setPaletteOpen]  = useState(false) // mobile drawer

  const steps = orch.steps || []

  // ── helpers ─────────────────────────────────────────────────────────────────
  function save(newSteps, newName) {
    onUpdate({ ...orch, name: newName ?? name, steps: newSteps ?? steps })
  }

  function saveName(v) {
    setName(v)
    onUpdate({ ...orch, name: v })
  }

  // ── step mutations ───────────────────────────────────────────────────────────
  function addTask(step) {
    if (pendingGroup) {
      // add to group
      const newSteps = steps.map(s =>
        s.id === pendingGroup
          ? { ...s, children: [...(s.children || []), step] }
          : s
      )
      save(newSteps)
      setPendingGroup(null)
    } else {
      save([...steps, step])
    }
    setPaletteOpen(false)
  }

  function addGroup() {
    const group = {
      id: crypto.randomUUID(),
      type: 'group',
      label: '',
      errorStrategy: 'stop',
      maxRetries: 3,
      retryDelaySec: 60,
      children: [],
    }
    save([...steps, group])
  }

  function deleteStep(id) {
    save(steps.filter(s => s.id !== id))
    if (pendingGroup === id) setPendingGroup(null)
  }

  function changeStep(id, patch) {
    save(steps.map(s => s.id === id ? { ...s, ...patch } : s))
  }

  function moveStep(id, dir) {
    const idx = steps.findIndex(s => s.id === id)
    if (idx < 0) return
    const newSteps = [...steps]
    const target = idx + dir
    if (target < 0 || target >= newSteps.length) return
    ;[newSteps[idx], newSteps[target]] = [newSteps[target], newSteps[idx]]
    save(newSteps)
  }

  function deleteChild(groupId, childId) {
    save(steps.map(s =>
      s.id === groupId
        ? { ...s, children: (s.children || []).filter(c => c.id !== childId) }
        : s
    ))
  }

  function changeChild(groupId, childId, patch) {
    save(steps.map(s =>
      s.id === groupId
        ? { ...s, children: (s.children || []).map(c => c.id === childId ? { ...c, ...patch } : c) }
        : s
    ))
  }

  function moveChild(groupId, childId, dir) {
    save(steps.map(s => {
      if (s.id !== groupId) return s
      const children = [...(s.children || [])]
      const idx = children.findIndex(c => c.id === childId)
      if (idx < 0) return s
      const target = idx + dir
      if (target < 0 || target >= children.length) return s
      ;[children[idx], children[target]] = [children[target], children[idx]]
      return { ...s, children }
    }))
  }

  const isEmpty = steps.length === 0

  return (
    <>
      {/* ── Mobile palette drawer backdrop ── */}
      {paletteOpen && (
        <div
          onClick={() => { setPaletteOpen(false); setPendingGroup(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 200 }}
        />
      )}

      <div style={{ display: 'flex', height: '100%', position: 'relative' }}>
        {/* ── Palette: desktop left panel / mobile bottom drawer ── */}
        <div style={{
          width: 220, flexShrink: 0,
        }}
          className="orch-palette-desktop"
        >
          <TemplatePalette
            connection={connection}
            session={session}
            onAddTask={addTask}
            onAddGroup={addGroup}
            targetGroupId={pendingGroup}
            disabled={disabled}
          />
        </div>

        {/* ── Mobile bottom drawer ── */}
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 201,
          height: '60vh', background: 'var(--bg)',
          borderTop: '1px solid var(--border2)',
          borderRadius: '12px 12px 0 0',
          transform: paletteOpen ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform .25s ease',
          display: 'none',
        }}
          className="orch-palette-mobile"
        >
          <TemplatePalette
            connection={connection}
            session={session}
            onAddTask={step => { addTask(step); setPaletteOpen(false) }}
            onAddGroup={() => { addGroup(); setPaletteOpen(false) }}
            targetGroupId={pendingGroup}
            disabled={disabled}
          />
        </div>

        {/* ── Builder main area ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          {/* Header */}
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg2)', flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <input
              value={name}
              onChange={e => !disabled && saveName(e.target.value)}
              disabled={disabled}
              placeholder="Nombre de la orquestación…"
              style={{
                flex: 1, background: 'var(--bg3)', border: '1px solid var(--border)',
                borderRadius: 6, color: '#fff', fontSize: 13, fontWeight: 600,
                padding: '6px 10px', outline: 'none',
              }}
            />
            <button
              onClick={() => {
                if ('Notification' in window && Notification.permission === 'default') {
                  Notification.requestPermission()
                }
                onRun()
              }}
              disabled={disabled || isEmpty}
              title={isEmpty ? 'Agrega al menos un paso para ejecutar' : 'Ejecutar orquestación'}
              style={{
                padding: '7px 18px', borderRadius: 6, flexShrink: 0,
                border: '1px solid rgba(34,197,94,.4)',
                background: (disabled || isEmpty) ? 'transparent' : 'rgba(34,197,94,.1)',
                color: (disabled || isEmpty) ? 'var(--text3)' : '#22c55e',
                fontSize: 12, fontWeight: 700,
                cursor: (disabled || isEmpty) ? 'default' : 'pointer',
                opacity: (disabled || isEmpty) ? 0.5 : 1,
              }}
            >
              ▶ Ejecutar
            </button>
          </div>

          {/* Step list */}
          <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px' }}>
            {isEmpty && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                height: '60%', gap: 12,
              }}>
                <div style={{ fontSize: 32, opacity: 0.2 }}>⊞</div>
                <div style={{ fontSize: 13, color: 'var(--text2)', textAlign: 'center' }}>
                  Sin pasos configurados.
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>
                  Selecciona un template desde el panel izquierdo<br />para agregarlo a la secuencia.
                </div>
              </div>
            )}

            {steps.map((step, i) => (
              <StepCard
                key={step.id}
                step={step}
                index={i}
                total={steps.length}
                disabled={disabled}
                onDelete={() => deleteStep(step.id)}
                onMoveUp={() => moveStep(step.id, -1)}
                onMoveDown={() => moveStep(step.id, 1)}
                onChange={patch => changeStep(step.id, patch)}
                onAddChild={() => {
                  setPendingGroup(step.id)
                  setPaletteOpen(true)
                }}
                onDeleteChild={childId => deleteChild(step.id, childId)}
                onChangeChild={(childId, patch) => changeChild(step.id, childId, patch)}
                onMoveChildUp={childId => moveChild(step.id, childId, -1)}
                onMoveChildDown={childId => moveChild(step.id, childId, 1)}
              />
            ))}
          </div>

          {/* Mobile FAB */}
          <div className="orch-fab" style={{ display: 'none' }}>
            <button
              disabled={disabled}
              onClick={() => { setPendingGroup(null); setPaletteOpen(true) }}
              style={{
                position: 'fixed', bottom: 24, right: 24, zIndex: 100,
                width: 52, height: 52, borderRadius: '50%',
                background: '#22c55e', border: 'none',
                color: '#000', fontSize: 24, fontWeight: 700,
                cursor: 'pointer', boxShadow: '0 4px 16px rgba(34,197,94,.4)',
              }}
            >+</button>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 640px) {
          .orch-palette-desktop { display: none !important; }
          .orch-palette-mobile  { display: flex !important; flex-direction: column; }
          .orch-fab             { display: block !important; }
        }
      `}</style>
    </>
  )
}
