import { useEffect, useState } from 'react'
import StepsPanel from '../Jobs/StepsPanel'

const STATUS_COLOR = {
  pending:   'var(--text3)',
  running:   '#22c55e',
  success:   '#34d399',
  warning:   '#fbbf24',
  error:     '#ff6b6b',
  cancelled: '#94a3b8',
  skipped:   '#475569',
}

const STATUS_ICON = {
  pending:   '○',
  running:   '◉',
  success:   '✓',
  warning:   '⚠',
  error:     '✕',
  cancelled: '⊘',
  skipped:   '–',
}

const STATUS_LABEL = {
  pending:   'Pendiente',
  running:   'En ejecución',
  success:   'Completado',
  warning:   'Con advertencias',
  error:     'Error',
  cancelled: 'Cancelado',
  skipped:   'Omitido',
}

function Elapsed({ startedAt }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (!startedAt) return null
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
  const m = Math.floor(secs / 60), s = secs % 60
  return <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{m}m {s}s</span>
}

const TERMINAL_STATUSES = new Set(['success', 'warning', 'error', 'cancelled'])

function NodeRow({ ns, label, techName, indent = 0, isChild = false, connection, session }) {
  const [sapExpanded, setSapExpanded] = useState(false)
  if (!ns) return null
  const color = STATUS_COLOR[ns.status] || 'var(--text3)'
  const canShowSap = TERMINAL_STATUSES.has(ns.status) && ns.jobName && ns.jobRunCount != null

  const sapJob = canShowSap ? {
    JobName: ns.jobName,
    JobRunCount: ns.jobRunCount,
    JobTemplateName: techName,
    JobStatus: ns.sapStatus,
    JobStepCount: 0,
    JobText: label,
  } : null

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: `8px ${12 + indent * 20}px`,
        background: ns.status === 'running' ? 'rgba(34,197,94,.03)' : 'transparent',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: isChild ? 10 : 11, fontWeight: 700,
          color, border: `1.5px solid ${color}33`,
          animation: ns.status === 'running' ? 'runPulse 1.5s ease-in-out infinite' : 'none',
        }}>
          {STATUS_ICON[ns.status] || '○'}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: isChild ? 11 : 12, fontWeight: isChild ? 500 : 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label}
            </span>
            <span style={{ fontSize: 10, color, fontWeight: 600 }}>
              {STATUS_LABEL[ns.status] || ns.status}
            </span>
            {ns.status === 'running' && ns.startedAt && <Elapsed startedAt={ns.startedAt} />}
            {ns.retryCount > 0 && (
              <span style={{ fontSize: 9, color: '#fbbf24', background: 'rgba(251,191,36,.1)', borderRadius: 3, padding: '1px 5px' }}>
                intento {ns.retryCount}
              </span>
            )}
          </div>

          {techName && (
            <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 1 }}>
              {techName}
            </div>
          )}

          {ns.jobName && (
            <div style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)', marginTop: 2 }}>
              Job: {ns.jobName}
              {ns.sapStatus && <span style={{ marginLeft: 8, color: color }}>[{ns.sapStatus}]</span>}
            </div>
          )}

          {ns.error && (
            <div style={{ fontSize: 10, color: '#ff6b6b', marginTop: 3, wordBreak: 'break-word' }}>
              {ns.error}
            </div>
          )}

          {canShowSap && (
            <button
              onClick={() => setSapExpanded(v => !v)}
              style={{
                marginTop: 5, background: 'none', border: '1px solid var(--border)',
                borderRadius: 4, color: 'var(--text3)', fontSize: 9, cursor: 'pointer',
                padding: '2px 7px', display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            >
              {sapExpanded ? '▲' : '▼'} Steps SAP
            </button>
          )}
        </div>

        {ns.startedAt && ns.finishedAt && (
          <div style={{ fontSize: 9, color: 'var(--text3)', flexShrink: 0, textAlign: 'right' }}>
            {Math.round((new Date(ns.finishedAt) - new Date(ns.startedAt)) / 1000)}s
          </div>
        )}
      </div>

      {sapExpanded && sapJob && (
        <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
          <StepsPanel
            job={sapJob}
            connection={connection}
            session={session}
            statuses={null}
            tzMode="local"
            onClose={null}
            inline
          />
        </div>
      )}
    </div>
  )
}

export default function RunView({ run, orch, onCancel, onClose, connection, session }) {
  if (!run || !orch) return null

  const overallColor = STATUS_COLOR[run.status] || 'var(--text3)'
  const isRunning    = run.status === 'running'

  function getDuration() {
    if (!run.startedAt || !run.finishedAt) return null
    const secs = Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000)
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ── Header ── */}
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg2)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700,
          color: overallColor, border: `2px solid ${overallColor}44`,
          animation: isRunning ? 'runPulse 1.5s ease-in-out infinite' : 'none',
        }}>
          {STATUS_ICON[run.status] || '○'}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{orch.name}</div>
          <div style={{ fontSize: 11, color: overallColor, marginTop: 2 }}>
            {STATUS_LABEL[run.status] || run.status}
            {!isRunning && getDuration() && <span style={{ color: 'var(--text3)', marginLeft: 8 }}>· {getDuration()}</span>}
          </div>
        </div>

        {isRunning && (
          <button
            onClick={onCancel}
            style={{
              padding: '6px 14px', borderRadius: 6,
              border: '1px solid rgba(239,68,68,.4)',
              background: 'rgba(239,68,68,.08)',
              color: '#ff6b6b', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}
          >
            ⊘ Cancelar
          </button>
        )}

        {!isRunning && onClose && (
          <button
            onClick={onClose}
            style={{
              padding: '6px 14px', borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text2)', fontSize: 11, cursor: 'pointer',
            }}
          >
            ← Volver al editor
          </button>
        )}
      </div>

      {/* ── Step list ── */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {orch.steps.map((step, i) => {
          const ns = run.nodes[step.id]
          if (!ns) return null

          if (step.type === 'group') {
            return (
              <div key={step.id}>
                {/* Group header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px 4px',
                  borderBottom: '1px solid var(--border)',
                  background: ns.status === 'running' ? 'rgba(99,102,241,.04)' : 'transparent',
                }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: 5, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700,
                    color: STATUS_COLOR[ns.status], border: `1.5px solid ${STATUS_COLOR[ns.status]}33`,
                    animation: ns.status === 'running' ? 'runPulse 1.5s ease-in-out infinite' : 'none',
                  }}>
                    {STATUS_ICON[ns.status] || '○'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(129,140,248,1)' }}>
                      {step.label || `Grupo paralelo · paso ${i + 1}`}
                    </span>
                    <span style={{ fontSize: 10, color: STATUS_COLOR[ns.status], marginLeft: 8 }}>
                      {STATUS_LABEL[ns.status] || ns.status}
                    </span>
                    {ns.status === 'running' && ns.startedAt && (
                      <span style={{ marginLeft: 8 }}><Elapsed startedAt={ns.startedAt} /></span>
                    )}
                  </div>
                </div>

                {/* Group children */}
                {(step.children || []).map(child => (
                  <NodeRow
                    key={child.id}
                    ns={ns.children?.[child.id]}
                    label={child.jobTemplateText || child.jobTemplateName}
                    techName={child.jobTemplateName}
                    indent={1}
                    isChild
                    connection={connection}
                    session={session}
                  />
                ))}
              </div>
            )
          }

          return (
            <NodeRow
              key={step.id}
              ns={ns}
              label={`${i + 1}. ${step.jobTemplateText || step.jobTemplateName}`}
              techName={step.jobTemplateName}
              connection={connection}
              session={session}
            />
          )
        })}
      </div>

      <style>{`
        @keyframes runPulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.5; }
        }
      `}</style>
    </div>
  )
}
