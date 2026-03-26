const W = 220
const W_MIN = 52

export default function Sidebar({ connections, activeId, onSelect, expanded, onToggle, loading, isMobile = false, mobileOpen = false }) {
  const w = expanded ? W : W_MIN

  return (
    <aside
      className={isMobile ? `sidebar-drawer${mobileOpen ? ' open' : ''}` : ''}
      style={{
        width: w, minWidth: w, maxWidth: w,
        background: 'var(--bg2)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        transition: 'width .2s, min-width .2s, max-width .2s',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div style={{
        padding: '12px 10px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center',
        justifyContent: expanded ? 'space-between' : 'center',
        gap: 8, flexShrink: 0,
      }}>
        {expanded && (
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.1em' }}>
            Navegación
          </span>
        )}
        <button onClick={onToggle} style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 5,
          color: 'var(--text2)', padding: '3px 6px', fontSize: 11, flexShrink: 0,
        }} title={expanded ? 'Minimizar' : 'Expandir'}>
          {expanded ? '◀' : '▶'}
        </button>
      </div>

      {/* Conexiones link */}
      <SidebarItem
        id="connections"
        label="Conexiones"
        icon="🔗"
        active={activeId === 'connections'}
        expanded={expanded}
        onClick={() => onSelect('connections')}
        accent
      />

      {/* Resumen general link */}
      <SidebarItem
        id="resumen-general"
        label="Resumen"
        icon="📊"
        active={activeId === 'resumen-general'}
        expanded={expanded}
        onClick={() => onSelect('resumen-general')}
        accent
      />

      {/* Divider */}
      {connections.length > 0 && (
        <div style={{ margin: '4px 10px', borderTop: '1px solid var(--border)' }} />
      )}

      {/* Connection list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading
          ? expanded && <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--text3)' }}>Cargando...</div>
          : connections.map((c, idx) => (
            <SidebarItem
              key={c.id}
              id={c.id}
              label={c.name}
              icon={String(idx + 1)}
              numberIcon
              active={activeId === c.id}
              expanded={expanded}
              onClick={() => onSelect(c.id)}
            />
          ))
        }
      </div>

      {/* Add new */}
      <div style={{ padding: 8, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={() => onSelect('connections')} style={{
          width: '100%', padding: '7px 0',
          background: 'rgba(247,168,0,.08)', border: '1px dashed rgba(247,168,0,.3)',
          borderRadius: 6, color: 'var(--accent)', fontSize: 11, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <span>+</span>
          {expanded && <span>Nueva conexión</span>}
        </button>
      </div>
    </aside>
  )
}

function SidebarItem({ label, icon, numberIcon, active, expanded, onClick, accent }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', display: 'flex', alignItems: 'center',
      padding: '9px 14px',
      justifyContent: 'flex-start',
      gap: 10,
      background: active ? 'rgba(247,168,0,.1)' : 'none',
      border: 'none',
      borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
      color: active ? 'var(--accent)' : 'var(--text2)',
      fontSize: 12, fontWeight: active ? 600 : 400,
      transition: 'all .15s', textAlign: 'left',
    }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,.04)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'none' }}
      title={!expanded ? label : undefined}
    >
      {/* Icon */}
      {numberIcon ? (
        <span style={{
          width: 22, height: 22, borderRadius: '50%',
          background: active ? 'rgba(247,168,0,.2)' : 'rgba(255,255,255,.08)',
          border: `1px solid ${active ? 'rgba(247,168,0,.4)' : 'rgba(255,255,255,.12)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700, flexShrink: 0,
          color: active ? 'var(--accent)' : 'var(--text2)',
        }}>{icon}</span>
      ) : (
        <span style={{ fontSize: 14, flexShrink: 0, width: 22, textAlign: 'center' }}>{icon}</span>
      )}
      {expanded && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      )}
    </button>
  )
}
