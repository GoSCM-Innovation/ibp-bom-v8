# Reglas del proyecto ibp-bom-v8

## Regla fundamental
**No inventar información nunca.** Si se necesita un dato específico (endpoints SAP IBP, escenarios de comunicación, roles, configuraciones, etc.) y no está disponible en el código o en lo que el usuario ha proporcionado, preguntar antes de escribir cualquier cosa.

## Contexto del proyecto
Aplicación web para gestionar y orquestar jobs en sistemas SAP IBP (Integrated Business Planning) a través de la API OData REST.

## SAP IBP — información confirmada por el usuario
- El acuerdo de comunicación para Application Jobs es **SAP_COM_0326**
- La API usa **HTTP Basic Authentication** (Communication User + contraseña)
- URL base del endpoint: `https://<tenant>-api.scmibp.ondemand.com/sap/opu/odata/sap/BC_EXT_APPJOB_MANAGEMENT;v=0002`
- El servicio de Jobs expone los entity sets: `JobTemplateSet`, `JobHeaderSet`, `JobStatusInfoSet`
- `JobCancel` requiere `JobName` + `JobRunCount` (Function Import, POST con CSRF)
- `JobRestart` requiere `JobName` + `JobRunCount` + `JobRestartMode` (Function Import, POST con CSRF)
  - `JobRestartMode='E'`: reinicia desde el paso fallido (omite pasos anteriores)
  - `JobRestartMode='A'`: reinicia después del paso fallido (omite el paso fallido y anteriores)
- `JobSchedule` requiere `JobTemplateName` + `JobUser` (Function Import, POST con CSRF)
- Campos disponibles en `JobHeaderSet`: `JobName`, `JobText`, `JobStatus`, `JobTemplateText`, `JobTemplateName`, `JobCreatedByFormattedName`, `JobStepCount`, `JobPlannedStartDateTime`, `JobStartDateTime`, `JobEndDateTime`, `JobRunCount`, `Periodic`
- Códigos de estado SAP IBP confirmados (desde `JobStatusInfoSet`):
  - `A`=Failed/Erróneo, `C`=Canceled, `D`=Deleted, `F`=Finished, `K`=Skipped
  - `P`=Released, `R`=In Process, `S`=Scheduled, `U`=User Error
  - `W`=Finished with Warning, `X`=Unknown, `Y`=Ready, `c`=Canceling, `k`=Skip
- Estados cancelables: `P`, `R`, `S`, `Y`
- Estados reiniciables: `A`, `U`, `C`, `W`, `F`
- Filtro de fecha recomendado: `JobPlannedStartDateTime`, por defecto −24 h / +24 h
- Formato timestamp SAP: `YYYYMMDDHHMMSS.0000000` (string, comparación lexicográfica funciona)
- OData string encoding: `%27${encodeURIComponent(val)}%27`

## Stack técnico
- Frontend: React 19 + Vite 8 + recharts (gráficos)
- Backend: Vercel serverless functions (Node.js 20, ESM)
- Persistencia: **localStorage del navegador** (sin servidor, sin base de datos)
  - Configuración de conexiones en `localStorage['ibp:connections']` (array JSON, sin contraseñas)
  - Sesiones por conexión en `localStorage['ibp_session_${connId}']` como `{ user, password }`
- Las credenciales se piden por modal al iniciar sesión y se envían directamente al proxy (no se guardan en servidor)

## Estructura de pestañas por conexión
Cada conexión muestra tres sub-tabs en `SystemView.jsx`:
1. **Resumen** (default) — dashboard KPIs, gráficos, top jobs, top usuarios, jobs fallidos, top jobs más lentos
2. **Job Templates** — tabla de `JobTemplateSet` con botón Ejecutar por fila
3. **Job Monitor** — tabla de `JobHeaderSet` con filtros, auto-refresh 30s, cancelar y reiniciar jobs

## Servicios frontend (src/services/)
- `connectionStorage.js` — CRUD síncrono de conexiones en `localStorage['ibp:connections']`; usa `crypto.randomUUID()` para IDs
- `sessionStorage.js` — getSession / setSession / clearSession / loadAllSessions; clave `ibp_session_${connId}`
- `proxyCall.js` — helper central para todas las llamadas a `/api/proxy`; acepta `{ connection, session, com, path, method, body, injectJobUser }`; construye `{ url, serviceRoot, user, password }` y hace POST a `/api/proxy`; con `injectJobUser: true` agrega `&JobUser=` client-side

## Flujo de sesión
1. Configuración de conexiones guardada en localStorage (sin contraseñas)
2. Al seleccionar una conexión, `App.jsx` verifica `sessions[id]` en estado (cargado desde localStorage al montar)
3. Si no hay sesión activa y la conexión tiene URL configurada, aparece `LoginModal`
4. `LoginModal` pre-rellena el usuario desde `connection.com0326.user`; soporta autocompletar del browser
5. Al confirmar, `setSession(connId, user, password)` persiste en localStorage y navega al sistema
6. "Cerrar sesión" en `SystemView.jsx` llama `clearSession(connId)` y vuelve a la vista de conexiones

## Componentes clave
- `src/components/Connections/LoginModal.jsx` — modal de login por conexión con backdrop blur y autocompletar browser
- `src/components/Resumen/Resumen.jsx` — dashboard con recharts (PieChart donut + BarChart apilado por día), filtro por rango de fechas (datetime-local, mismo estilo que Job Monitor), auto-refresh cada 5 min
- `src/components/Resumen/GlobalResumen.jsx` — vista global; conexiones sin sesión muestran botón "🔒 Iniciar sesión" en lugar de datos
- `src/components/Jobs/JobMonitor.jsx` — filtro `fromDate`/`toDate` datetime-local, estado `filteredBase` para conteos de badges, action bar al seleccionar fila con Cancelar y Reiniciar
- `src/components/Jobs/Jobs.jsx` — tabla `JobTemplateSet`, botón Ejecutar por fila (`JobSchedule` + `injectJobUser`)
- `api/proxy.js` — acepta `{ url, serviceRoot, user, password, method, body }`; obtiene CSRF token con GET a `serviceRoot`, captura cookies y ejecuta el método real

## Convenciones
- Commits sin `Co-Authored-By` para evitar bloqueos en Vercel Hobby
- Usar siempre `proxyCall({ connection, session, ... })` — nunca llamar `/api/proxy` directamente desde componentes
- `injectJobUser: true` agrega `&JobUser=` usando `connection.jobUser || session.user || agreement.user` (client-side)
- El parámetro `com` en `proxyCall`: `'0326'` para Application Jobs (default), `'0068'` para Resource Stats
- Para estadísticas y descripciones de jobs usar siempre el campo `JobText` (no `JobTemplateText` ni `JobTemplateName`)
- Las pestañas Resumen y Job Monitor deben estar alineadas en el selector de fechas (mismo componente visual y mismos defaults)
- Sesiones cortas y enfocadas por feature para optimizar consumo de tokens
