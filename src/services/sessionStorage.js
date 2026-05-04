const key = id => `ibp_session_${id}`

function isValidSession(s) {
  return s && (s.com0326 || s.com0068)
}

export function getSession(connId) {
  try {
    const s = JSON.parse(localStorage.getItem(key(connId))) || null
    return isValidSession(s) ? s : null
  } catch { return null }
}

export function setSession(connId, creds) {
  localStorage.setItem(key(connId), JSON.stringify(creds))
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
