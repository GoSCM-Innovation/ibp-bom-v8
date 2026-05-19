const STORAGE_KEY = 'ibp:connections'

export function getAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch { return [] }
}

export function upsert(conn) {
  const all = getAll()
  const data = conn.id ? conn : { ...conn, id: crypto.randomUUID() }
  const idx = all.findIndex(c => c.id === data.id)
  if (idx >= 0) all[idx] = data
  else all.push(data)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  return data
}

export function remove(id) {
  const all = getAll().filter(c => c.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function bulkImport(toImport, { replaceDuplicates = false } = {}) {
  const all = getAll()
  let added = 0, replaced = 0, skipped = 0

  for (const incoming of toImport) {
    const dupIdx = all.findIndex(e =>
      (e.name || '').trim().toLowerCase()     === (incoming.name || '').trim().toLowerCase() &&
      (e.ambiente || '').trim().toLowerCase() === (incoming.ambiente || '').trim().toLowerCase()
    )
    if (dupIdx >= 0) {
      if (replaceDuplicates) {
        all[dupIdx] = { ...incoming, id: all[dupIdx].id }
        replaced++
      } else {
        skipped++
      }
    } else {
      all.push({ ...incoming, id: crypto.randomUUID() })
      added++
    }
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  return { added, replaced, skipped }
}
