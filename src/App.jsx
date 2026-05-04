import { useState, useEffect } from 'react'
import Header from './components/Header'
import Sidebar from './components/Sidebar/Sidebar'
import Connections from './components/Connections/Connections'
import SystemView from './components/System/SystemView'
import GlobalResumen from './components/Resumen/GlobalResumen'
import LoginModal from './components/Connections/LoginModal'
import { getAll } from './services/connectionStorage'
import { loadAllSessions, setSession, clearSession } from './services/sessionStorage'
import './App.css'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 640)
  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth <= 640)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return isMobile
}

export default function App() {
  const [connections, setConnections] = useState(() => getAll())
  const [sessions, setSessions] = useState(() => loadAllSessions(getAll().map(c => c.id)))
  const [activeId, setActiveId] = useState('connections')
  const [loginTarget, setLoginTarget] = useState(null)
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    if (isMobile) setSidebarExpanded(false)
  }, [isMobile])

  function refreshConnections() {
    setConnections(getAll())
  }

  function handleDeleted(id) {
    clearSession(id)
    setSessions(p => { const n = { ...p }; delete n[id]; return n })
    if (activeId === id) setActiveId('connections')
    refreshConnections()
  }

  function handleSelect(id) {
    if (id !== 'connections' && id !== 'resumen-general') {
      const conn = connections.find(c => c.id === id)
      const needsCredentials = conn?.com0326?.url || conn?.com0068?.url
      if (needsCredentials && !sessions[id]) {
        setLoginTarget(id)
        return
      }
    }
    setActiveId(id)
    if (isMobile) setSidebarOpen(false)
  }

  function handleLogin(connId, creds) {
    setSession(connId, creds)
    setSessions(p => ({ ...p, [connId]: creds }))
    setLoginTarget(null)
    setActiveId(connId)
    if (isMobile) setSidebarOpen(false)
  }

  function handleLogout(connId) {
    clearSession(connId)
    setSessions(p => { const n = { ...p }; delete n[connId]; return n })
    if (activeId === connId) setActiveId('connections')
  }

  const activeConn = connections.find(c => c.id === activeId)
  const loginConn = loginTarget ? connections.find(c => c.id === loginTarget) : null

  function renderMain() {
    if (activeId === 'connections') {
      return <Connections connections={connections} onSaved={refreshConnections} onDeleted={handleDeleted} onSelect={handleSelect} />
    }
    if (activeId === 'resumen-general') {
      return <GlobalResumen connections={connections} sessions={sessions} onLogin={(id) => setLoginTarget(id)} />
    }
    if (activeConn) {
      return <SystemView connection={activeConn} session={sessions[activeConn.id]} onLogout={() => handleLogout(activeConn.id)} />
    }
    return null
  }

  return (
    <>
      <Header onMenuToggle={isMobile ? () => setSidebarOpen(p => !p) : null} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>

        <div
          className={`sidebar-backdrop${sidebarOpen ? ' open' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />

        <Sidebar
          connections={connections}
          sessions={sessions}
          activeId={activeId}
          onSelect={handleSelect}
          expanded={sidebarExpanded}
          onToggle={() => setSidebarExpanded(p => !p)}
          isMobile={isMobile}
          mobileOpen={sidebarOpen}
        />

        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
          {renderMain()}
        </main>
      </div>

      {loginConn && (
        <LoginModal
          conn={loginConn}
          onLogin={(creds) => handleLogin(loginTarget, creds)}
          onCancel={() => setLoginTarget(null)}
        />
      )}
    </>
  )
}
