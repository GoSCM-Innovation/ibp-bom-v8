import { useState, useEffect } from 'react'
import Header from './components/Header'
import Sidebar from './components/Sidebar/Sidebar'
import Connections from './components/Connections/Connections'
import SystemView from './components/System/SystemView'
import './App.css'

export default function App() {
  const [connections, setConnections] = useState([])
  const [activeId, setActiveId] = useState('connections')
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchConnections() }, [])

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

  const activeConn = connections.find(c => c.id === activeId)

  return (
    <>
      <Header />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar
          connections={connections}
          activeId={activeId}
          onSelect={setActiveId}
          expanded={sidebarExpanded}
          onToggle={() => setSidebarExpanded(p => !p)}
          loading={loading}
        />
        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
          {activeId === 'connections'
            ? <Connections connections={connections} onSaved={fetchConnections} onDeleted={handleDeleted} onSelect={setActiveId} />
            : activeConn ? <SystemView connection={activeConn} /> : null
          }
        </main>
      </div>
    </>
  )
}
