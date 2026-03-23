import { useState } from 'react'
import Jobs from '../Jobs/Jobs'

const APPS = [
  { id: 'jobs', label: 'Job Templates' },
]

export default function SystemView({ connection }) {
  const [activeApp, setActiveApp] = useState('jobs')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* System header */}
      <div style={{
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
      }}>
        <div>
          <div style={{ fontWeight: 700, color: '#fff', fontSize: 14 }}>{connection.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)', marginTop: 1 }}>{connection.url}</div>
        </div>
      </div>

      {/* App sub-tabs */}
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

      {/* App content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {activeApp === 'jobs' && <Jobs connection={connection} />}
      </div>
    </div>
  )
}
