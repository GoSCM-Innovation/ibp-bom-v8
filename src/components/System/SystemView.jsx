import { useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useI18n } from '../../context/I18nContext'
import Jobs from '../Jobs/Jobs'
import JobMonitor from '../Jobs/JobMonitor'
import Resumen from '../Resumen/Resumen'
import ResourceStats from '../ResourceStats/ResourceStats'
import Metering from '../Metering/Metering'
import Orchestrations from '../Orchestrations/Orchestrations'
import ConnectionAvatar from '../Connections/ConnectionAvatar'
import { getSapSystemUrl } from '../../utils/sapUrl'

export default function SystemView({ connection, session, onLogout }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const has0326    = !!(connection.com0326?.url    && connection.com0326?.user)
  const has0068    = !!(connection.com0068?.url    && connection.com0068?.user)
  const hasMetering = !!(connection.com0924?.url && connection.com0924?.user)

  const APPS = [
    ...(has0326 ? [
      { id: 'resumen',      label: t('system.tabSummary') },
      { id: 'jobs',         label: t('system.tabJobs')    },
      { id: 'monitor',      label: t('system.tabMonitor') },
      { id: 'orquestador',  label: t('system.tabOrch')    },
    ] : []),
    ...(has0068 ? [
      { id: 'stats', label: t('system.tabStats') },
    ] : []),
    ...(hasMetering ? [
      { id: 'metering', label: t('system.tabMetering') },
    ] : []),
  ]

  const [activeApp, setActiveApp] = useState(APPS[0]?.id || null)

  const emptyStateLines = t('system.emptyState').split('\n')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* System header */}
      <div style={{
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        padding: isMobile ? '10px 12px' : '12px 24px',
        display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
      }}>
        <ConnectionAvatar name={connection.name} logoUrl={connection.logoUrl} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14 }}>{connection.name}</div>
          {getSapSystemUrl(connection.com0326?.url) && (
            <a
              href={getSapSystemUrl(connection.com0326?.url)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 10, color: 'var(--accent)', marginTop: 2, display: 'inline-block', textDecoration: 'none' }}
              onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
              onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
            >
              {t('system.openSap')}
            </a>
          )}
        </div>
        {session && onLogout && (
          <button onClick={onLogout} title={t('system.logout')} style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text3)', fontSize: 11, fontWeight: 600, padding: '4px 10px',
            cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--red)'; e.currentTarget.style.color = 'var(--red)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text3)' }}
          >
            {t('system.logout')}
          </button>
        )}
      </div>

      {/* App sub-tabs */}
      {APPS.length > 0 && (
        <div className="tab-bar" style={{
          display: 'flex', gap: 0, borderBottom: '1px solid var(--border)',
          background: 'var(--bg2)', padding: isMobile ? '0 12px' : '0 24px', flexShrink: 0,
        }}>
          {APPS.map(app => (
            <button key={app.id} onClick={() => setActiveApp(app.id)} style={{
              padding: isMobile ? '10px 14px' : '10px 20px',
              fontSize: 12, background: 'none', border: 'none',
              borderBottom: activeApp === app.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeApp === app.id ? 'var(--text)' : 'var(--text2)',
              fontWeight: activeApp === app.id ? 600 : 400,
              cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap', flexShrink: 0,
            }}>{app.label}</button>
          ))}
        </div>
      )}

      {/* App content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {APPS.length === 0 && (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text2)', fontSize: 13 }}>
            {emptyStateLines.map((line, i) => (
              <span key={i}>{line}{i < emptyStateLines.length - 1 && <br />}</span>
            ))}
          </div>
        )}
        {activeApp === 'resumen'      && <Resumen        connection={connection} session={session} />}
        {activeApp === 'jobs'         && <Jobs           connection={connection} session={session} />}
        {activeApp === 'monitor'      && <JobMonitor     connection={connection} session={session} />}
        {activeApp === 'orquestador'  && <Orchestrations connection={connection} session={session} />}
        {activeApp === 'stats'        && <ResourceStats  connection={connection} session={session} />}
        {activeApp === 'metering'     && <Metering       connection={connection} session={session} />}
      </div>
    </div>
  )
}
