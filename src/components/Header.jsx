export default function Header() {
  return (
    <header style={{
      background: 'linear-gradient(135deg, #080f1e 0%, #0d1829 60%, #080f1e 100%)',
      borderBottom: '2px solid rgba(247,168,0,.25)',
      padding: '0 24px',
      height: 'var(--header-h)',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      position: 'sticky',
      top: 0,
      zIndex: 200,
      boxShadow: '0 2px 20px rgba(0,0,0,.5)',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'linear-gradient(135deg, var(--accent), var(--accent2))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 14, color: '#fff', fontFamily: 'var(--mono)',
          flexShrink: 0,
        }}>G</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: '.01em' }}>
            GoSCM <span style={{ color: 'var(--accent)', fontSize: 11, fontFamily: 'var(--mono)' }}>v8</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1 }}>
            Job Orchestrator · SAP IBP
          </div>
        </div>
      </div>
    </header>
  )
}
