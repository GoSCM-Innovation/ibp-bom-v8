import { useState, useEffect } from 'react'
import Header from './components/Header'
import Sidebar from './components/Sidebar/Sidebar'
import Connections from './components/Connections/Connections'
import SystemView from './components/System/SystemView'
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
  const [connections, setConnections] = useState([])
  const [activeId, setActiveId] = useState('connections')
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false) // mobile drawer
  const [loading, setLoading] = useState(true)
  const isMobile = useIsMobile()

  useEffect(() => { fetchConnections() }, [])

  // Auto-collapse sidebar when switching to mobile
  useEffect(() => {
    if (isMobile) setSidebarExpanded(false)
  }, [isMobile])

  async function fetchConnections() {
    try {
      const res = await fetch('/api/connections')
      if (res.ok) setConnections(await res.json())
    } catch (e) {
      console.error('Error loading connections:', e)
    } finally {
      setLoading(false)
    }
  }

  function handleDeleted(id) {
    if (activeId === id) setActiveId('connections')
    fetchConnections()
  }

  function handleSelect(id) {
    setActiveId(id)
    if (isMobile) setSidebarOpen(false)
  }

  const activeConn = connections.find(c => c.id === activeId)

  return (
    <>
      <Header onMenuToggle={isMobile ? () => setSidebarOpen(p => !p) : null} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>

        {/* Backdrop for mobile drawer */}
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
          loading={loading}
          isMobile={isMobile}
          mobileOpen={sidebarOpen}
        />

        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
          {activeId === 'connections'
            ? <Connections connections={connections} onSaved={fetchConnections} onDeleted={handleDeleted} onSelect={handleSelect} />
            : activeConn ? <SystemView connection={activeConn} /> : null
          }
        </main>
      </div>
    </>
  )
}
