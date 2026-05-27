import { useI18n } from '../../context/I18nContext'
import { connDisplayName } from '../../utils/connDisplayName'

const W = 220
const W_MIN = 52

const AVATAR_COLORS = [
  '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B',
  '#10B981', '#EF4444', '#06B6D4', '#F97316',
]
function colorFor(name = '') {
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}
function initials(name = '') {
  const base = name.trim().replace(/\s*\([^)]*\)\s*$/, '').trim()
  const words = base.split(/\s+/).filter(Boolean)
  if (words.length === 0) return name.slice(0, 2).toUpperCase()
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return words.slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('')
}

function envDotColor(name = '') {
  const match = name.trim().match(/\(([^)]+)\)\s*$/)
  if (!match) return null
  const env = match[1].trim()
  if (/calidad/i.test(env)) return '#F59E0B'
  if (/producci[oó]n/i.test(env)) return '#3B82F6'
  if (/desarrollo/i.test(env)) return '#8B5CF6'
  return '#6B7280'
}

export default function Sidebar({ connections, sessions = {}, activeId, onSelect, expanded, onToggle, isMobile = false, mobileOpen = false }) {
  const { t, lang, setLang } = useI18n()
  const isExpanded = isMobile ? true : expanded
  const w = isExpanded ? W : W_MIN

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
      <div style={{ borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {/* Language toggle row */}
        {isExpanded ? (
          <div style={{ padding: '8px 10px 0', display: 'flex', gap: 4 }}>
            <button
              onClick={() => setLang('es')}
              style={{
                flex: 1, padding: '3px 0', borderRadius: 5, fontSize: 11, fontWeight: 700,
                border: `1px solid ${lang === 'es' ? 'var(--accent)' : 'var(--border)'}`,
                background: lang === 'es' ? 'rgba(247,168,0,.12)' : 'transparent',
                color: lang === 'es' ? 'var(--accent)' : 'var(--text3)',
                cursor: 'pointer', transition: 'all .15s',
              }}
            >ES</button>
            <button
              onClick={() => setLang('en')}
              style={{
                flex: 1, padding: '3px 0', borderRadius: 5, fontSize: 11, fontWeight: 700,
                border: `1px solid ${lang === 'en' ? 'var(--accent)' : 'var(--border)'}`,
                background: lang === 'en' ? 'rgba(247,168,0,.12)' : 'transparent',
                color: lang === 'en' ? 'var(--accent)' : 'var(--text3)',
                cursor: 'pointer', transition: 'all .15s',
              }}
            >EN</button>
          </div>
        ) : (
          <div style={{ padding: '8px 4px 0' }}>
            <button
              onClick={() => setLang(lang === 'es' ? 'en' : 'es')}
              title={lang === 'es' ? 'Switch to English' : 'Cambiar a Español'}
              style={{
                width: '100%', padding: '3px 0', borderRadius: 5, fontSize: 9, fontWeight: 700,
                border: '1px solid var(--accent)',
                background: 'rgba(247,168,0,.12)',
                color: 'var(--accent)',
                cursor: 'pointer',
              }}
            >{lang.toUpperCase()}</button>
          </div>
        )}
        {/* Nav label + collapse button */}
        <div style={{
          padding: '8px 10px',
          display: 'flex', alignItems: 'center',
          justifyContent: isExpanded ? 'space-between' : 'center',
          gap: 8,
        }}>
          {isExpanded && (
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.1em' }}>
              {t('sidebar.nav')}
            </span>
          )}
          {!isMobile && (
            <button onClick={onToggle} style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 5,
              color: 'var(--text2)', padding: '3px 6px', fontSize: 11, flexShrink: 0,
            }} title={isExpanded ? t('sidebar.minimize') : t('sidebar.expand')}>
              {isExpanded ? '◀' : '▶'}
            </button>
          )}
        </div>
      </div>

      {/* Conexiones link */}
      <SidebarItem
        id="connections"
        label={t('sidebar.connections')}
        icon="🔗"
        active={activeId === 'connections'}
        expanded={isExpanded}
        onClick={() => onSelect('connections')}
      />

      {/* Resumen general link */}
      <SidebarItem
        id="resumen-general"
        label={t('resumen.title')}
        icon="📊"
        active={activeId === 'resumen-general'}
        expanded={isExpanded}
        onClick={() => onSelect('resumen-general')}
      />

      {/* Divider */}
      {connections.length > 0 && (
        <div style={{ margin: '4px 10px', borderTop: '1px solid var(--border)' }} />
      )}

      {/* Connection list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {connections.map((c) => {
          const hasCredentials = c.com0326?.url || c.com0068?.url
          const loggedIn = !!sessions[c.id]
          return (
            <SidebarItem
              key={c.id}
              id={c.id}
              label={connDisplayName(c, t)}
              icon={initials(c.name)}
              iconColor={colorFor(c.name)}
              envColor={envDotColor(c.name)}
              numberIcon
              active={activeId === c.id}
              expanded={isExpanded}
              onClick={() => onSelect(c.id)}
              sessionStatus={hasCredentials ? (loggedIn ? 'online' : 'offline') : null}
            />
          )
        })}
      </div>

      {/* Add new */}
      <div style={{ padding: 8, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={() => onSelect('connections')} style={{
          width: '100%', padding: '7px 0',
          background: 'var(--accent-bg-soft)', border: '1px dashed var(--accent-border-soft)',
          borderRadius: 6, color: 'var(--accent)', fontSize: 11, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <span>+</span>
          {isExpanded && <span>{t('sidebar.newConn')}</span>}
        </button>
      </div>
    </aside>
  )
}

function SidebarItem({ label, icon, iconColor, envColor, numberIcon, active, expanded, onClick, sessionStatus }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', display: 'flex', alignItems: 'center',
      padding: '9px 14px',
      justifyContent: 'flex-start',
      gap: 10,
      background: active ? 'var(--accent-bg-soft)' : 'none',
      border: 'none',
      borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
      color: active ? 'var(--accent)' : 'var(--text2)',
      fontSize: 12, fontWeight: active ? 600 : 400,
      transition: 'all .15s', textAlign: 'left',
    }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--surface-glass-soft)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'none' }}
      title={!expanded ? label : undefined}
    >
      {/* Icon */}
      {numberIcon ? (
        <span style={{
          width: 26, height: 26, borderRadius: 6, flexShrink: 0,
          background: active ? iconColor : `${iconColor}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700,
          color: active ? 'var(--text-on-accent)' : (iconColor || 'var(--text2)'),
          position: 'relative',
          transition: 'background .15s',
        }}>
          {icon}
          {/* Environment indicator dot */}
          {envColor && (
            <span style={{
              position: 'absolute', top: -2, right: -2,
              width: 7, height: 7, borderRadius: '50%',
              background: envColor,
              border: '1.5px solid var(--bg2)',
            }} />
          )}
          {/* Session indicator dot */}
          {sessionStatus && (
            <span style={{
              position: 'absolute', bottom: -2, right: -2,
              width: 7, height: 7, borderRadius: '50%',
              background: sessionStatus === 'online' ? 'var(--green)' : 'var(--text3)',
              border: '1.5px solid var(--bg2)',
            }} />
          )}
        </span>
      ) : (
        <span style={{ fontSize: 14, flexShrink: 0, width: 22, textAlign: 'center' }}>{icon}</span>
      )}
      {expanded && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{label}</span>
      )}
      {/* Lock icon when expanded and offline */}
      {expanded && sessionStatus === 'offline' && (
        <span style={{ fontSize: 9, color: 'var(--text3)', flexShrink: 0 }}>🔒</span>
      )}
    </button>
  )
}
