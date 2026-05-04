import { useState } from 'react'
import Jobs from '../Jobs/Jobs'
import JobMonitor from '../Jobs/JobMonitor'
import Resumen from '../Resumen/Resumen'
import ResourceStats from '../ResourceStats/ResourceStats'
import ConnectionAvatar from '../Connections/ConnectionAvatar'

export default function SystemView({ connection, session, onLogout }) {
  const has0326 = !!(connection.com0326?.url && connection.com0326?.user)
  const has0068 = !!(connection.com0068?.url && connection.com0068?.user)

  const APPS = [
    ...(has0326 ? [
      { id: 'resumen',  label: 'Resumen'        },
      { id: 'jobs',     label: 'Job Templates'  },
      { id: 'monitor',  label: 'Job Monitor'    },
    ] : []),
    ...(has0068 ? [
      { id: 'stats', label: 'Resource Stats' },
    ] : []),
  ]

  const [activeApp, setActiveApp] = useState(APPS[0]?.id || null)

  const displayUrl = connection.com0326?.url || connection.com0068?.url || ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* System header */}
      <div style={{
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
      }}>
        <ConnectionAvatar name={connection.name} logoUrl={connection.logoUrl} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: '#fff', fontSize: 14 }}>{connection.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)', marginTop: 1 }}>
            {session ? session.user : displayUrl}
          </div>
        </div>
        {session && onLogout && (
          <button onClick={onLogout} title="Cerrar sesión" style={{
            background: 'none', border: '1px solid rgba(255,255,255,.12)', borderRadius: 6,
            color: 'var(--text3)', fontSize: 11, fontWeight: 600, padding: '4px 10px',
            cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--red)'; e.currentTarget.style.color = 'var(--red)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,.12)'; e.currentTarget.style.color = 'var(--text3)' }}
          >
            Cerrar sesión
          </button>
        )}
      </div>

      {/* App sub-tabs */}
      {APPS.length > 0 && (
        <div style={{
          display: 'flex', gap: 0, borderBottom: '1px solid var(--border)',
          background: 'var(--bg2)', padding: '0 24px', flexShrink: 0,
        }}>
          {APPS.map(app => (
            <button key={app.id} onClick={() => setActiveApp(app.id)} style={{
              padding: '10px 20px', fontSize: 12, background: 'none', border: 'none',
              borderBottom: activeApp === app.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeApp === app.id ? 'var(--text)' : 'var(--text2)',
              fontWeight: activeApp === app.id ? 600 : 400,
              cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap',
            }}>{app.label}</button>
          ))}
        </div>
      )}

      {/* App content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {APPS.length === 0 && (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text2)', fontSize: 13 }}>
            Esta conexión no tiene acuerdos de comunicación configurados.<br />
            Ve a Conexiones para agregar SAP_COM_0326 o SAP_COM_0068.
          </div>
        )}
        {activeApp === 'resumen'  && <Resumen       connection={connection} session={session} />}
        {activeApp === 'jobs'     && <Jobs          connection={connection} session={session} />}
        {activeApp === 'monitor'  && <JobMonitor    connection={connection} session={session} />}
        {activeApp === 'stats'    && <ResourceStats connection={connection} session={session} />}
      </div>
    </div>
  )
}
