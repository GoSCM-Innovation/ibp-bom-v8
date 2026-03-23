# Reglas del proyecto ibp-bom-v8

## Regla fundamental
**No inventar información nunca.** Si se necesita un dato específico (endpoints SAP IBP, escenarios de comunicación, roles, configuraciones, etc.) y no está disponible en el código o en lo que el usuario ha proporcionado, preguntar antes de escribir cualquier cosa.

## Contexto del proyecto
Aplicación web para gestionar y orquestar jobs en sistemas SAP IBP (Integrated Business Planning) a través de la API OData REST.

## SAP IBP — información confirmada por el usuario
- El acuerdo de comunicación para Application Jobs es **SAP_COM_0326**
- La API usa **HTTP Basic Authentication** (Communication User + contraseña)
- URL base del endpoint: `https://<tenant>-api.scmibp.ondemand.com/sap/opu/odata/sap/BC_EXT_APPJOB_MANAGEMENT;v=0002`
- El servicio de Jobs expone el entity set **JobTemplateSet**

## Stack técnico
- Frontend: React 19 + Vite 8
- Backend: Vercel serverless functions (Node.js 20, ESM)
- Base de datos: Upstash Redis via REST API (pipeline)
- Passwords encriptadas con AES-256-CBC antes de guardar en Redis
- Las credenciales nunca se envían al frontend — el proxy las resuelve desde Redis

## Convenciones
- Commits sin `Co-Authored-By` para evitar bloqueos en Vercel Hobby
- El proxy (`api/proxy.js`) acepta `{ connectionId, path }` y resuelve credenciales internamente
