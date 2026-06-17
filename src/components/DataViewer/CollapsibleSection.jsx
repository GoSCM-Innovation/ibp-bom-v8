// ─────────────────────────────────────────────────────────────────────────────
// CollapsibleSection.jsx — a section box (like the viewer's config panels) whose
// body can be collapsed to free vertical space for the data grid. The header
// shows a chevron + title; when collapsed it also shows an optional `summary`
// (e.g. the current selection) so context isn't lost. `actions` (e.g. the
// refresh / "show data" buttons) stay visible in the header in BOTH states, so
// the primary controls remain reachable even when the body is hidden.
//
// Reusable across the master-data and transactional viewers.
// ─────────────────────────────────────────────────────────────────────────────

const BOX = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 16px', marginBottom: 12 }
const TITLE = { fontSize: 10, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em' }

export default function CollapsibleSection({ title, collapsed, onToggle, summary, actions, children }) {
  return (
    <div style={BOX}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          onClick={onToggle}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', minWidth: 0, flex: 1 }}
        >
          <span style={{
            fontSize: 11, color: 'var(--text3)', display: 'inline-block', width: 10, textAlign: 'center',
            transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .15s',
          }}>▾</span>
          <span style={TITLE}>{title}</span>
          {collapsed && summary != null && (
            <span style={{
              fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{summary}</span>
          )}
        </div>
        {actions}
      </div>
      {!collapsed && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  )
}
