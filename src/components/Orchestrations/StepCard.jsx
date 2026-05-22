import { useState, useEffect } from 'react'
import { proxyCall } from '../../services/proxyCall'
import { useIsMobile } from '../../hooks/useIsMobile'
import TruncText from '../ui/TruncText'

const STRATEGIES = [
  { value: 'stop',     label: 'Detener si falla'    },
  { value: 'continue', label: 'Continuar si falla'  },
  { value: 'retry',    label: 'Reintentar si falla' },
]

const inputStyle = {
  background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 5,
  color: 'var(--text)', fontSize: 11, padding: '4px 8px', outline: 'none',
  width: '100%', boxSizing: 'border-box',
}

const selectStyle = {
  ...inputStyle, cursor: 'pointer', appearance: 'none', paddingRight: 20,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 7px center',
}

function StrategyRow({ step, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 8 }}>
      <div style={{ position: 'relative', flex: '1 1 160px', minWidth: 140 }}>
        <select
          value={step.errorStrategy || 'stop'}
          onChange={e => onChange({ errorStrategy: e.target.value })}
          style={selectStyle}
        >
          {STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      {(step.errorStrategy === 'retry') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }}>
            <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>Reintentos:</span>
            <input
              type="number" min={1} max={10}
              value={step.maxRetries || 3}
              onChange={e => onChange({ maxRetries: Math.max(1, parseInt(e.target.value) || 1) })}
              style={{ ...inputStyle, width: 48 }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }}>
            <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>Espera (s):</span>
            <input
              type="number" min={10} max={3600}
              value={step.retryDelaySec || 60}
              onChange={e => onChange({ retryDelaySec: Math.max(10, parseInt(e.target.value) || 60) })}
              style={{ ...inputStyle, width: 56 }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function TemplateSteps({ jobTemplateName, connection, session }) {
  const [expanded, setExpanded] = useState(false)
  const [steps, setSteps]       = useState(null)
  const [loading, setLoading]   = useState(false)

  useEffect(() => {
    if (!expanded || steps !== null || !connection) return
    setLoading(true)
    proxyCall({
      connection, session,
      path: `/JobTemplateSequenceSet?$filter=substringof(${encodeURIComponent("'" + jobTemplateName + "'")},JobTemplateName)&$orderby=JobSequencePosition`,
    })
      .then(r => r.json())
      .then(d => setSteps(d?.d?.results ?? d?.value ?? []))
      .catch(() => setSteps([]))
      .finally(() => setLoading(false))
  }, [expanded]) // eslint-disable-line react-hooks/exhaustive-deps

  const count = steps?.length ?? 0

  return (
    <div style={{ marginTop: 6 }}>
      <button
        onMouseDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text3)', fontSize: 10, padding: 0, display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        {expanded ? '▲' : '▼'} {steps !== null ? `${count} paso${count !== 1 ? 's' : ''} del template` : 'Ver pasos del template'}
      </button>

      {expanded && (
        <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
          {loading && <div style={{ fontSize: 10, color: 'var(--text3)', padding: '4px 0' }}>Cargando…</div>}
          {!loading && steps?.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text3)', fontStyle: 'italic', padding: '4px 0' }}>Sin pasos disponibles</div>
          )}
          {!loading && steps?.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 0' }}>
              <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', flexShrink: 0, minWidth: 18, textAlign: 'right' }}>
                {s.JobSequencePosition ?? i + 1}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text2)' }}>
                {s.JobSequenceText || s.JobCatalogEntryText || s.JobCatalogEntryName || `Paso ${i + 1}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function StepCard({
  step, index, total,
  onDelete, onMoveUp, onMoveDown, onChange,
  onAddChild, onDeleteChild, onChangeChild,
  onMoveChildUp, onMoveChildDown,
  disabled,
  isPendingGroup,
  connection, session,
  // DnD props from OrchBuilder
  isDragOver,
  dragOverPos,   // 'top' | 'bottom'
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}) {
  const [groupExpanded, setGroupExpanded] = useState(true)
  const [dragging, setDragging] = useState(false)
  const isMobile = useIsMobile()

  const isGroup = step.type === 'group'
  const children = step.children || []

  const btnBase = {
    background: 'none', border: '1px solid var(--border)', borderRadius: 5,
    color: 'var(--text3)', fontSize: 11, cursor: disabled ? 'default' : 'pointer',
    padding: '3px 7px', lineHeight: 1, flexShrink: 0, opacity: disabled ? 0.4 : 1,
    transition: 'color .12s, border-color .12s',
  }

  // Drop indicator line
  const dropLine = isDragOver ? (
    <div style={{
      position: 'absolute', left: 0, right: 0,
      top: dragOverPos === 'top' ? -2 : undefined,
      bottom: dragOverPos === 'bottom' ? -2 : undefined,
      height: 3, borderRadius: 2,
      background: 'rgba(34,197,94,.8)',
      pointerEvents: 'none',
    }} />
  ) : null

  return (
    <>
    {isPendingGroup && (
      <style>{`@keyframes stepcard-pulse { 0%,100% { box-shadow: 0 0 0 2px rgba(251,191,36,.55); } 50% { box-shadow: 0 0 0 4px rgba(251,191,36,.9); } }`}</style>
    )}
    <div
      draggable={!disabled && !isMobile}
      onDragStart={e => {
        if (disabled || isMobile) return
        setDragging(true)
        onDragStart(e, step.id)
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={e => { e.preventDefault(); onDragOver(e, step.id) }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); onDrop(e, step.id) }}
      style={{
        position: 'relative',
        border: isPendingGroup
          ? '1px solid rgba(251,191,36,.8)'
          : `1px solid ${isGroup ? 'rgba(99,102,241,.35)' : 'var(--border)'}`,
        borderRadius: 10,
        background: isGroup ? 'rgba(99,102,241,.04)' : 'var(--bg2)',
        marginBottom: 8,
        opacity: dragging ? 0.35 : 1,
        transition: 'opacity .15s, border-color .15s, box-shadow .15s',
        cursor: (disabled || isMobile) ? 'default' : 'grab',
        animation: isPendingGroup ? 'stepcard-pulse 1.4s ease-in-out infinite' : 'none',
      }}
    >
      {dropLine}

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px' }}>
        {/* Drag handle — desktop only */}
        {!isMobile && (
          <div
            title={disabled ? undefined : 'Arrastrar para reordenar'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 18, flexShrink: 0, alignSelf: 'stretch',
              color: 'var(--text3)', opacity: disabled ? 0.2 : 0.45,
              fontSize: 14, userSelect: 'none',
            }}
          >
            ⠿
          </div>
        )}

        {/* Index badge */}
        <div style={{
          width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700, color: 'var(--text2)',
          background: isGroup ? 'rgba(99,102,241,.15)' : 'var(--bg3)',
          border: `1px solid ${isGroup ? 'rgba(99,102,241,.3)' : 'var(--border)'}`,
          marginTop: 2,
        }}>
          {isGroup ? '⊞' : index + 1}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {isGroup ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(129,140,248,1)' }}>
                  Grupo paralelo
                </span>
                <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {children.length} tarea{children.length !== 1 ? 's' : ''}
                </span>
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); setGroupExpanded(v => !v) }}
                  style={{ ...btnBase, border: 'none', fontSize: 10, padding: '2px 4px' }}
                >
                  {groupExpanded ? '▲' : '▼'}
                </button>
              </div>
              <input
                value={step.label || ''}
                onChange={e => !disabled && onChange({ label: e.target.value })}
                placeholder="Descripción opcional…"
                disabled={disabled}
                onMouseDown={e => e.stopPropagation()}
                style={{ ...inputStyle, marginTop: 6, fontSize: 11 }}
              />
              <StrategyRow step={step} onChange={p => !disabled && onChange(p)} />
            </>
          ) : (
            <>
              <TruncText
                text={step.jobTemplateText || step.jobTemplateName}
                style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}
              />
              <TruncText
                text={step.jobTemplateName}
                style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 1 }}
              />
              <StrategyRow step={step} onChange={p => !disabled && onChange(p)} />
              {connection && (
                <TemplateSteps
                  jobTemplateName={step.jobTemplateName}
                  connection={connection}
                  session={session}
                />
              )}
            </>
          )}
        </div>

        {/* Action buttons */}
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}
        >
          <button
            disabled={disabled || index === 0}
            onClick={onMoveUp}
            title="Mover arriba"
            style={{ ...btnBase, opacity: (disabled || index === 0) ? 0.25 : 1 }}
          >↑</button>
          <button
            disabled={disabled || index === total - 1}
            onClick={onMoveDown}
            title="Mover abajo"
            style={{ ...btnBase, opacity: (disabled || index === total - 1) ? 0.25 : 1 }}
          >↓</button>
          <button
            disabled={disabled}
            onClick={onDelete}
            title="Eliminar paso"
            style={{ ...btnBase, color: 'var(--red)', borderColor: 'rgba(239,68,68,.3)' }}
          >✕</button>
        </div>
      </div>

      {/* ── Group children ── */}
      {isGroup && groupExpanded && (
        <div style={{ padding: '0 12px 12px 48px' }}>
          {children.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic', padding: '6px 0' }}>
              Sin tareas en el grupo. Agrega tareas desde el panel de templates.
            </div>
          ) : (
            children.map((child, ci) => (
              <div key={child.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6,
                padding: '8px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}>
                <div style={{
                  width: 20, height: 20, flexShrink: 0, borderRadius: 4, marginTop: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, fontWeight: 700, color: 'rgba(129,140,248,.8)',
                  background: 'rgba(99,102,241,.1)',
                }}>∥</div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <TruncText
                    text={child.jobTemplateText || child.jobTemplateName}
                    style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}
                  />
                  <TruncText
                    text={child.jobTemplateName}
                    style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 1 }}
                  />
                  <StrategyRow step={child} onChange={p => !disabled && onChangeChild(child.id, p)} />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <button disabled={disabled || ci === 0} onClick={() => onMoveChildUp(child.id)} style={{ ...btnBase, opacity: (disabled || ci === 0) ? 0.25 : 1 }}>↑</button>
                  <button disabled={disabled || ci === children.length - 1} onClick={() => onMoveChildDown(child.id)} style={{ ...btnBase, opacity: (disabled || ci === children.length - 1) ? 0.25 : 1 }}>↓</button>
                  <button disabled={disabled} onClick={() => onDeleteChild(child.id)} style={{ ...btnBase, color: 'var(--red)', borderColor: 'rgba(239,68,68,.3)' }}>✕</button>
                </div>
              </div>
            ))
          )}

          {!disabled && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={onAddChild}
              style={{
                marginTop: 4, width: '100%', padding: '6px 0', borderRadius: 6,
                border: '1px dashed rgba(99,102,241,.4)', background: 'transparent',
                color: 'rgba(129,140,248,.8)', fontSize: 11, cursor: 'pointer',
              }}
            >
              + Agregar tarea al grupo
            </button>
          )}
        </div>
      )}
    </div>
    </>
  )
}
