export default function Jobs({ connection }) {
  return (
    <div style={{ padding: 28 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Jobs</div>
      <div style={{ fontSize: 12, color: 'var(--text2)' }}>
        Módulo de gestión de jobs para <strong style={{ color: 'var(--text)' }}>{connection.name}</strong>.
        La implementación se configurará una vez que se entreguen los endpoints de la API.
      </div>
    </div>
  )
}
