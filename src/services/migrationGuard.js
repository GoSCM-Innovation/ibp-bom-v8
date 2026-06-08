// Tiny module-level guard so the parent (SystemView / App) can ask, before
// navigating away (switching sub-tab, connection or logging out), whether a
// migration is running and confirm with the user. Kept outside React so the
// navigation handlers in different components can consult it without prop drilling.

let active = false
let message = ''

// Called by the Migration component when its running state changes.
export function setMigrationGuard(isActive, msg) {
  active = isActive
  message = msg || ''
}

export function isMigrationActive() {
  return active
}

// Returns true if it's safe to leave. When a migration is active, asks the user
// to confirm; leaving will cancel the migration (the Migration unmount aborts it).
export function confirmLeaveMigration() {
  if (!active) return true
  const ok = window.confirm(message || 'Hay una migración en curso. Si sales, se cancelará. ¿Continuar?')
  return ok
}
