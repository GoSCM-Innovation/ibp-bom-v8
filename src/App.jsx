import { useState, useEffect } from 'react'
import Header from './components/Header'
import Sidebar from './components/Sidebar/Sidebar'
import Connections from './components/Connections/Connections'
import SystemView from './components/System/SystemView'
import GlobalResumen from './components/Resumen/GlobalResumen'
import { getAll } from './services/connectionStorage'
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
  const [activeId, setActiveId] = useState('connections')
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
    if (activeId === id) setActiveId('connections')
    refreshConnections()
  }

  function handleSelect(id) {
    setActiveId(id)
    if (isMobile) setSidebarOpen(false)
  }

  const activeConn = connections.find(c => c.id === activeId)

  function renderMain() {
    if (activeId === 'connections') {
      return <Connections connections={connections} onSaved={refreshConnections} onDeleted={handleDeleted} onSelect={handleSelect} />
    }
    if (activeId === 'resumen-general') {
      return <GlobalResumen connections={connections} />
    }
    if (activeConn) {
      return <SystemView connection={activeConn} />
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
          activeId={activeId}
          onSelect={handleSelect}
          expanded={sidebarExpanded}
          onToggle={() => setSidebarExpanded(p => !p)}
          loading={false}
          isMobile={isMobile}
          mobileOpen={sidebarOpen}
        />

        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
          {renderMain()}
        </main>
      </div>
    </>
  )
}
