const key = id => `ibp_session_${id}`

export function getSession(connId) {
  try { return JSON.parse(localStorage.getItem(key(connId))) || null }
  catch { return null }
}

export function setSession(connId, user, password) {
  localStorage.setItem(key(connId), JSON.stringify({ user, password }))
}

export function clearSession(connId) {
  localStorage.removeItem(key(connId))
}

export function loadAllSessions(connectionIds) {
  const out = {}
  for (const id of connectionIds) {
    const s = getSession(id)
    if (s) out[id] = s
  }
  return out
}
