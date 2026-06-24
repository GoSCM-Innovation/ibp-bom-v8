// Topes de volumen por corrida de migración, para no rozar los límites de Vercel
// en la WEB desplegada. En LOCAL (localhost) NO aplican: ahí se migra sin tope, que
// es donde se hacen las ejecuciones masivas.
//
// La detección por entorno (no por rama) mantiene ambas ramas IDÉNTICAS y evita que
// un merge le quite los topes a la web por error.

// true cuando la app corre en el PC del usuario (servidor local / vite / vercel dev).
export function isLocalRun() {
  if (typeof window === 'undefined' || !window.location) return false
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
}

// Dato maestro: filas por corrida (suma de todas las tablas seleccionadas).
export const MASTER_MAX_WARN = 120_000   // aviso suave en el modal
export const MASTER_MAX_HARD = 200_000   // bloquea la corrida (≈0,5 GB de tráfico)

// Key figures: filas por corrida (acumulado de las KF de la corrida).
export const KF_MAX_WARN = 250_000
export const KF_MAX_HARD = 400_000       // ≈0,3 GB de tráfico

// Helpers: devuelven el tope efectivo según entorno (Infinity en local = sin tope).
export function masterHardLimit() { return isLocalRun() ? Infinity : MASTER_MAX_HARD }
export function masterWarnLimit() { return isLocalRun() ? Infinity : MASTER_MAX_WARN }
export function kfHardLimit()     { return isLocalRun() ? Infinity : KF_MAX_HARD }
export function kfWarnLimit()     { return isLocalRun() ? Infinity : KF_MAX_WARN }
