const COLORS = [
  '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B',
  '#10B981', '#EF4444', '#06B6D4', '#F97316',
]

function colorFor(name = '') {
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  return COLORS[Math.abs(hash) % COLORS.length]
}

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('')
}

export default function ConnectionAvatar({ name, logoUrl, size = 36 }) {
  const bg = colorFor(name)
  const letters = initials(name)

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={name}
        onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex' }}
        style={{ width: size, height: size, borderRadius: 8, objectFit: 'contain', background: '#fff', flexShrink: 0 }}
      />
    )
  }

  return (
    <div style={{
      width: size, height: size, borderRadius: 8, background: bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, fontSize: size * 0.36, color: '#fff',
      flexShrink: 0, userSelect: 'none',
    }}>
      {letters}
    </div>
  )
}
