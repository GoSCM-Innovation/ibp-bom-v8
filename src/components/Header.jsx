import { useState, useRef, useEffect } from 'react'

const REQUIREMENTS = [
  {
    title: '1. Usuario de Comunicación',
    detail: 'Crear un Communication User en SAP IBP → Settings → Communication Users. Este usuario y su contraseña se usan como credenciales de la conexión.',
  },
  {
    title: '2. Sistema de Comunicación',
    detail: 'Definir un Communication System en SAP IBP → Settings → Communication Systems, representando el sistema externo (GoSCM) que consumirá la API.',
  },
  {
    title: '3. Acuerdo de Comunicación',
    detail: 'Crear un Communication Arrangement en SAP IBP → Settings → Communication Arrangements usando el escenario SAP_COM_0326. Asociar el Communication System y el Communication User — esto activa el endpoint OData.',
  },
  {
    title: '4. URL del endpoint',
    detail: 'La URL del API se obtiene directamente del Communication Arrangement creado. Formato: https://<tenant>-api.scmibp.ondemand.com/sap/opu/odata/sap/BC_EXT_APPJOB_MANAGEMENT;v=0002',
  },
  {
    title: '5. Rol de autorización',
    detail: 'El Communication User debe tener asignado el business role correspondiente para leer y ejecutar Application Jobs en IBP.',
  },
  {
    title: '6. Autenticación Basic Auth',
    detail: 'La API usa HTTP Basic Authentication con el usuario y contraseña del Communication User. No se requiere configuración adicional de OAuth.',
  },
]

export default function Header({ onMenuToggle }) {
  const [showReqs, setShowReqs] = useState(false)
  const panelRef = useRef(null)

  useEffect(() => {
    if (!showReqs) return
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setShowReqs(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showReqs])

  return (
    <header style={{
      background: 'linear-gradient(135deg, #080f1e 0%, #0d1829 60%, #080f1e 100%)',
      borderBottom: '2px solid rgba(247,168,0,.25)',
      padding: '0 24px',
      height: 'var(--header-h)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      position: 'sticky',
      top: 0,
      zIndex: 200,
      boxShadow: '0 2px 20px rgba(0,0,0,.5)',
      flexShrink: 0,
    }}>
      {/* Hamburger — mobile only */}
      {onMenuToggle && (
        <button
          onClick={onMenuToggle}
          className="hamburger-btn"
          style={{
            display: 'none',
            background: 'none', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text2)', padding: '5px 9px',
            fontSize: 16, cursor: 'pointer', flexShrink: 0,
          }}
        >☰</button>
      )}
      {/* Logo + title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <img
          src="/logo-goscm.png"
          alt="GoSCM"
          style={{ height: 32, width: 'auto', objectFit: 'contain', flexShrink: 0 }}
        />
        <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,.12)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', letterSpacing: '.01em', lineHeight: 1.2 }}>
            Customer Success Control Tower
          </div>
        </div>
      </div>

      {/* Requisitos Técnicos button */}
      <div style={{ position: 'relative' }} ref={panelRef}>
        <button
          onClick={() => setShowReqs(p => !p)}
          style={{
            background: showReqs ? 'rgba(247,168,0,.15)' : 'rgba(255,255,255,.06)',
            border: `1px solid ${showReqs ? 'rgba(247,168,0,.4)' : 'rgba(255,255,255,.12)'}`,
            borderRadius: 7, color: showReqs ? 'var(--accent)' : 'var(--text2)',
            fontSize: 12, fontWeight: 600, padding: '6px 14px',
            cursor: 'pointer', transition: 'all .15s', display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <span style={{ fontSize: 14 }}>📋</span> Requisitos Técnicos
        </button>

        {showReqs && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 10px)', right: 0,
            width: 'min(420px, 92vw)', background: '#0d1829',
            border: '1px solid rgba(247,168,0,.25)', borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,.6)', padding: 20, zIndex: 300,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>📋</span> Requisitos Técnicos de la API
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {REQUIREMENTS.map((r, i) => (
                <div key={i} style={{
                  background: 'rgba(255,255,255,.04)', borderRadius: 7,
                  border: '1px solid rgba(255,255,255,.07)', padding: '10px 14px',
                  overflow: 'hidden',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', marginBottom: 4, wordBreak: 'break-word' }}>
                    {r.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5, wordBreak: 'break-word', overflowWrap: 'break-word' }}>{r.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
