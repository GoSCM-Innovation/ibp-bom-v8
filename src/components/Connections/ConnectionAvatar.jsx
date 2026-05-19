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
  const base = name.trim().replace(/\s*\([^)]*\)\s*$/, '').trim()
  const words = base.split(/\s+/).filter(Boolean)
  if (words.length === 0) return name.slice(0, 2).toUpperCase()
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return words.slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('')
}

function envDotColor(name = '') {
  const match = name.trim().match(/\(([^)]+)\)\s*$/)
  if (!match) return null
  const env = match[1].trim()
  if (/calidad/i.test(env)) return '#F59E0B'
  if (/producci[oó]n/i.test(env)) return '#3B82F6'
  if (/desarrollo/i.test(env)) return '#8B5CF6'
  return '#6B7280'
}

export default function ConnectionAvatar({ name, logoUrl, size = 36 }) {
  const bg = colorFor(name)
  const letters = initials(name)
  const dotColor = envDotColor(name)
  const dotSize = Math.max(8, Math.round(size * 0.28))

  const dot = dotColor && (
    <span style={{
      position: 'absolute', bottom: -2, right: -2,
      width: dotSize, height: dotSize, borderRadius: '50%',
      background: dotColor, border: '2px solid var(--bg2)',
      pointerEvents: 'none',
    }} />
  )

  if (logoUrl) {
    return (
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <img
          src={logoUrl}
          alt={name}
          onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex' }}
          style={{ width: size, height: size, borderRadius: 8, objectFit: 'contain', background: '#fff' }}
        />
        {dot}
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: 8, background: bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: size * 0.36, color: '#fff',
        userSelect: 'none',
      }}>
        {letters}
      </div>
      {dot}
    </div>
  )
}
