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
- Base de datos: Upstash Redis via REST API (pipeline)
- Passwords encriptadas con AES-256-CBC antes de guardar en Redis
- Las credenciales nunca se envían al frontend — el proxy las resuelve desde Redis

## Estructura de pestañas por conexión
Cada conexión muestra tres sub-tabs en `SystemView.jsx`:
1. **Resumen** (default) — dashboard KPIs, gráficos, top jobs, top usuarios, jobs fallidos, top jobs más lentos
2. **Job Templates** — tabla de `JobTemplateSet` con botón Ejecutar por fila
3. **Job Monitor** — tabla de `JobHeaderSet` con filtros, auto-refresh 30s, cancelar y reiniciar jobs

## Componentes clave
- `src/components/Resumen/Resumen.jsx` — dashboard con recharts (PieChart donut + BarChart apilado por día), filtro por rango de fechas (datetime-local, mismo estilo que Job Monitor), auto-refresh cada 5 min
- `src/components/Jobs/JobMonitor.jsx` — filtro `fromDate`/`toDate` datetime-local, estado `filteredBase` para conteos de badges, action bar al seleccionar fila con Cancelar y Reiniciar
- `src/components/Jobs/Jobs.jsx` — tabla `JobTemplateSet`, botón Ejecutar por fila (`JobSchedule` + `injectJobUser`)
- `api/proxy.js` — acepta `{ connectionId, path }`, resuelve credenciales desde Redis, maneja CSRF token (GET fetch + captura cookies + POST)
- `api/connections.js` — CRUD conexiones en Redis; ID se pasa en el body (no en URL) para evitar que Vercel strips el parámetro

## Convenciones
- Commits sin `Co-Authored-By` para evitar bloqueos en Vercel Hobby
- El proxy acepta `{ connectionId, path, method?, injectJobUser? }`; con `injectJobUser: true` agrega `&JobUser=` desde `conn.jobUser`
- Para estadísticas y descripciones de jobs usar siempre el campo `JobText` (no `JobTemplateText` ni `JobTemplateName`)
- Las pestañas Resumen y Job Monitor deben estar alineadas en el selector de fechas (mismo componente visual y mismos defaults)
- Sesiones cortas y enfocadas por feature para optimizar consumo de tokens
