const KEY = connId => `ibp_orch_${connId}`

export function loadOrchs(connId) {
  try { return JSON.parse(localStorage.getItem(KEY(connId)) || '[]') } catch { return [] }
}

export function saveOrchs(connId, orchs) {
  localStorage.setItem(KEY(connId), JSON.stringify(orchs))
}

export function createOrch(connId, name) {
  const orchs = loadOrchs(connId)
  const orch = {
    id: crypto.randomUUID(),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    steps: [],
  }
  saveOrchs(connId, [...orchs, orch])
  return orch
}

export function updateOrch(connId, id, patch) {
  const orchs = loadOrchs(connId)
  const updated = orchs.map(o => o.id === id ? { ...o, ...patch } : o)
  saveOrchs(connId, updated)
  return updated.find(o => o.id === id)
}

export function deleteOrch(connId, id) {
  saveOrchs(connId, loadOrchs(connId).filter(o => o.id !== id))
}

export function duplicateOrch(connId, id) {
  const orchs = loadOrchs(connId)
  const original = orchs.find(o => o.id === id)
  if (!original) return null
  const copy = {
    ...original,
    id: crypto.randomUUID(),
    name: `${original.name} (copia)`,
    createdAt: new Date().toISOString(),
    steps: JSON.parse(JSON.stringify(original.steps || [])),
  }
  saveOrchs(connId, [...orchs, copy])
  return copy
}

export function exportOrchs(orchs, connectionName) {
  const payload = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    sourceConnection: connectionName || '',
    orchestrations: orchs.map(o => ({ name: o.name, steps: o.steps || [] })),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const date = new Date().toISOString().slice(0, 10)
  const safe = (connectionName || 'conn').replace(/[^\w-]+/g, '_').slice(0, 30)
  a.href = url
  a.download = `ibp-orquestaciones-${safe}-${date}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function importOrchs(connId, parsed, replaceDuplicates) {
  const orchs = loadOrchs(connId)
  let added = 0, replaced = 0, skipped = 0
  const result = [...orchs]

  for (const incoming of (parsed.orchestrations || [])) {
    const existingIdx = result.findIndex(
      o => (o.name || '').trim().toLowerCase() === (incoming.name || '').trim().toLowerCase()
    )
    if (existingIdx >= 0) {
      if (replaceDuplicates) {
        result[existingIdx] = { ...result[existingIdx], name: incoming.name, steps: incoming.steps || [] }
        replaced++
      } else {
        skipped++
      }
    } else {
      result.push({ id: crypto.randomUUID(), name: incoming.name, createdAt: new Date().toISOString(), steps: incoming.steps || [] })
      added++
    }
  }

  saveOrchs(connId, result)
  return { added, replaced, skipped, result }
}
