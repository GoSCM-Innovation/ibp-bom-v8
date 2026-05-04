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
