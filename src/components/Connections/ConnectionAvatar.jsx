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
  const match = name.trim().match(/^(.*?)\s*\(([^)]+)\)\s*$/)
  if (match) {
    const words = match[1].trim().split(/\s+/).filter(Boolean)
    const abbr = words.length === 1 ? words[0].slice(0, 2).toUpperCase() : words.map(w => w[0]?.toUpperCase() || '').join('')
    const env = match[2].trim()
    let envLetter
    if (/calidad/i.test(env)) envLetter = 'Q'
    else if (/producci[oó]n/i.test(env)) envLetter = 'P'
    else if (/desarrollo/i.test(env)) envLetter = 'D'
    else envLetter = env[0]?.toUpperCase() || ''
    return envLetter ? `${abbr}-${envLetter}` : abbr
  }
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return words.slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('')
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
      fontWeight: 700, fontSize: size * (letters.length > 3 ? 0.28 : 0.36), color: '#fff',
      flexShrink: 0, userSelect: 'none',
    }}>
      {letters}
    </div>
  )
}
