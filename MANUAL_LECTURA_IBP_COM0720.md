# Manual de lectura de datos SAP IBP vía SAP_COM_0720
### Guía para consultor CPI — leer Dato Maestro (DM) y Dato Transaccional / Key Figures (DT)

> **Validado en vivo** contra el tenant de **Calidad `my301282`** (escenario `SAP_COM_0720`, usuario de lectura) el 2026-06-19. Todos los ejemplos de áreas, versiones, key figures, conteos y mensajes de error de este manual son respuestas reales de ese sistema, no inventadas.
>
> Las prácticas de eficiencia provienen de mediciones contra tenants reales (overhead por request, tamaños de página, concurrencia, comportamiento de filtros).

---

## 0. Cómo usar este manual

Estás llamando **directo a las APIs OData de IBP** (Postman, curl, Groovy/HTTP adapter en CPI, etc.). No necesitas la web; la web solo es la referencia de "cómo hacerlo bien".

Estructura:

| Sección | Qué resuelve |
|---|---|
| 1 | Conexión, los **dos** servicios, autenticación |
| 2 | Descubrir qué hay (áreas, versiones, tablas, key figures) sin adivinar |
| 3 | Leer **Dato Maestro** |
| 4 | Leer **Dato Transaccional / Key Figures** |
| 5 | **Horizonte de lectura** (ventana de tiempo y niveles) |
| 6 | **Eficiencia**: cómo leer rápido y sin romper nada |
| 7 | Tabla de errores frecuentes → causa → solución |
| 8 | Recetario copy-paste |

---

## 1. Conexión y servicios

Un **único** communication arrangement, `SAP_COM_0720`, con **un mismo usuario/contraseña**, habilita **dos servicios OData distintos**:

| Dato | Servicio (service root) |
|---|---|
| **Maestro (DM)** | `…/sap/opu/odata/IBP/MASTER_DATA_API_SRV` |
| **Transaccional / Key Figures (DT)** | `…/sap/opu/odata/IBP/PLANNING_DATA_API_SRV` |

Para `my301282`:

```
Maestro:        https://my301282-api.scmibp1.ondemand.com/sap/opu/odata/IBP/MASTER_DATA_API_SRV
Transaccional:  https://my301282-api.scmibp1.ondemand.com/sap/opu/odata/IBP/PLANNING_DATA_API_SRV
```

**Autenticación:** HTTP **Basic** (usuario de comunicación + contraseña). Header en cada llamada:

```
Authorization: Basic <base64(usuario:contraseña)>
Accept: application/json
```

> ⚠️ **Regla de oro:** un área de planificación debe estar **habilitada por separado en cada servicio**. Puede existir en MASTER_DATA pero **no** en PLANNING (síntoma: el `$metadata` de planning no la trae y `GET /<AREA>` da 404). Si te falta el dato transaccional de un área, pide al admin que la habilite en `PLANNING_DATA_API_SRV` dentro de SAP_COM_0720.

### Para lectura solo necesitas GET

La lectura **no requiere token CSRF ni cookies** — eso es solo para escritura. Un `GET` con Basic Auth es suficiente.

---

## 2. Descubrir qué hay (sin adivinar nombres)

Nunca asumas nombres de área/tabla. Descúbrelos.

### 2.1 Áreas de planificación (servicio transaccional)

El **service document** lista todos los entity sets. El área aparece como un set "base"; cada área genera además `<AREA>Trans` (escritura) y `<AREA>Message` (mensajes).

```
GET  /PLANNING_DATA_API_SRV/?$format=json
```

→ El área es el set que **no** termina en `Trans` ni `Message` (ignora también `KeyFigureDeltaDefinitionSet` y `ValueResultSet`).

**Real en `my301282`:** 3 áreas →

```
GCMARCIMEX, GCINDURAMA, GCMERCAND
(+ GCMARCIMEXTrans/Message, GCINDURAMATrans/Message, GCMERCANDTrans/Message)
```

### 2.2 Versiones de un área

```
GET  /PLANNING_DATA_API_SRV/GCMARCIMEX?$select=VERSIONID,VERSIONNAME&$top=1000&$format=json
```

**Real (las 3 áreas comparten estas versiones):**

| VERSIONID | Nombre |
|---|---|
| `__BASELINE` | Base Version *(versión base)* |
| `DOWNSIDE` | Downside Version |
| `UPSIDE` | Upside Version |
| `PVSMD` | Planning Version with Version-Specific Master Data |
| `ZDEMOSUP` | Demo Supply |

> La versión **base** es `__BASELINE` (también vale `''` vacío en algunos contextos).

### 2.3 Dimensiones vs Key Figures de un área

El `$metadata` (XML) clasifica cada propiedad con `sap:aggregation-role`:
- `dimension` → atributo (PRDID, CUSTID, BRAND…)
- `measure` → key figure (ACTUALSQTY…)

```
GET  /PLANNING_DATA_API_SRV/$metadata
```

**Real en `GCMARCIMEX`:** 188 dimensiones, 724 key figures.

- Dimensiones (muestra): `PRDID, CUSTID, LOCID, BRAND, CATEGORY, CURRID, CURRTOID, UOMTOID, CUSTGROUP, CUSTCHANNEL, …`
- Key figures (muestra): `ACTUALSQTY, ACTUALSREV, ACTUALSPRICE, ADJUSTEDDEMAND, ADJDEMANDPLANNINGQTY, …`
- Niveles de tiempo: `PERIODID0_TSTAMP … PERIODID5_TSTAMP` (ver sección 5).

### 2.4 Catálogo de Dato Maestro (área ↔ versión ↔ tabla)

Las tablas de DM se llaman **MDT** (Master Data Type). Para saber qué MDT pertenece a qué área/versión:

```
GET  /MASTER_DATA_API_SRV/VersionSpecificMasterDataTypes?$format=json
     &$select=PlanningAreaID,VersionID,MasterDataTypeID,PlanningAreaDescr,VersionName
```

**Real en `my301282`:** 598 entity sets en total; los MDT de cada área llevan prefijo propio (`GMX…` para GCMARCIMEX). Ejemplos de GCMARCIMEX:

```
GMXPRODUCT, GMXCUSTOMER, GMXLOCATION, GMXLOCATIONPRODUCT,
GMXUOMTO, GMXCURRENCYTO, GMXUOMCONVERSIONFACTOR, GMXEXCHANGERATE, …
```

> Los entity sets que **terminan en `Trans`** son los importables (escritura). Para **leer** usas el set base (`GMXPRODUCT`, no `GMXPRODUCTTrans`).
> El servicio **no** expone una "descripción de tabla"; el nombre del MDT es el identificador. Las **columnas** sí traen etiqueta legible (`sap:label` en `$metadata`).

---

## 3. Leer Dato Maestro (DM)

Tablas planas de atributos (productos, clientes, ubicaciones…). El patrón de query es OData v2 estándar.

### 3.1 Parámetros que usarás siempre

| Parámetro | Para qué | Ejemplo |
|---|---|---|
| `$select` | Traer **solo** las columnas que necesitas (payload chico) | `$select=PRDID,PRDDESCR,BRAND` |
| `$filter` | Acotar por área/versión y por atributos | `PlanningAreaID eq 'GCMARCIMEX'` |
| `$top` / `$skip` | Paginar | `$top=2000&$skip=4000` |
| `$orderby` | **Paginación estable** (sin solapes) | `$orderby=PRDID` |
| `$inlinecount=allpages` | Total de registros junto a la página | (ver 3.2) |
| `$format=json` | Respuesta JSON | siempre |

### 3.2 Contar antes de leer

```
GET  /MASTER_DATA_API_SRV/GMXPRODUCT?$format=json
     &$top=0&$inlinecount=allpages
     &$filter=PlanningAreaID eq 'GCMARCIMEX'
```
Respuesta → `d.__count`. **Real:** `16533` productos en GCMARCIMEX.

> En Dato Maestro `$top=0` para contar **es seguro** (a diferencia del transaccional — ver 4.4).

### 3.3 Leer una página

```
GET  /MASTER_DATA_API_SRV/GMXPRODUCT?$format=json
     &$select=PRDID,PRDDESCR,BRAND
     &$filter=PlanningAreaID eq 'GCMARCIMEX'
     &$orderby=PRDID
     &$top=2000&$skip=0
```
**Real (2 filas):**
```
10009641 | BOLSO TERMICO BRENTWOOD_CB-2401_     | BRAND=
10021250 | AUD INA I_XIAOMI REDMI BUDS 3 LITE_BL | BRAND= I_XIAOMI
```

### 3.4 Versión: base vs versión específica

- **Leer base** → filtra **solo** por `PlanningAreaID` (devuelve `__BASELINE`).
- **Leer una versión** → agrega `VersionID eq 'PVSMD'`. Puede ser un conjunto distinto y más grande.

```
&$filter=PlanningAreaID eq 'GCMARCIMEX' and VersionID eq 'PVSMD'
```

### 3.5 Truco: valores distintos casi gratis (dropdowns / catálogos)

`MASTER_DATA_API_SRV` **deduplica en el servidor** cuando `$select` proyecta **un solo campo no-clave**.

```
GET  /MASTER_DATA_API_SRV/GMXPRODUCT?$format=json
     &$top=5000&$select=BRAND
     &$filter=PlanningAreaID eq 'GCMARCIMEX'
```
**Real:** devolvió **663 marcas distintas** en una sola llamada (~½ s) sobre 16.533 productos. Ideal para poblar listas de valores de filtro.

> ⚠️ Esto **solo** funciona en MASTER_DATA. El servicio PLANNING **rechaza** un `$select` de solo atributos con `400 "This service cannot be used to extract master data"` (ver 4).

### 3.6 Filtrar Dato Maestro por atributo

Soporta `eq`, lista con `or`, y `startswith`:

```
&$filter=PlanningAreaID eq 'GCMARCIMEX' and BRAND eq '4711'
&$filter=PlanningAreaID eq 'GCMARCIMEX' and (BRAND eq '4711' or BRAND eq '593')
&$filter=PlanningAreaID eq 'GCMARCIMEX' and startswith(PRDID,'100')
```

> **Cuidado con el "vacío" y la exclusión.** Un atributo vacío es cadena de longitud 0 y es **no filtrable**: `eq ''`, `eq null`, `length()`, `trim()` **no** lo aíslan (SAP ignora `length`/`trim` y devuelve el total). Cualquier predicado sobre un campo (incluido `ne`) **descarta también las filas con ese campo vacío**. Por eso, para "excluir", **selecciona los demás valores** desde la lista distinta (3.5) en vez de usar `ne`.

---

## 4. Leer Dato Transaccional / Key Figures (DT)

Aquí lees **valores de key figures** a un **nivel** (combinación de dimensiones) y un **periodo de tiempo**. El servicio **agrega** los valores al nivel que pidas.

### 4.1 Regla #1 — `$select` es obligatorio y define el nivel

Debes listar en `$select`: las **dimensiones del nivel** + el **campo de tiempo** + las **key figures**.

```
$select=PRDID,CUSTID,LOCID,UOMTOID,ACTUALSQTY,PERIODID4_TSTAMP
```

> **SAP agrega al nivel del `$select`.** Si pides menos atributos, SAP **suma silenciosamente** al nivel más alto — el número es correcto pero menos granular. Pide exactamente el nivel que quieres.
> **No** se puede "desagregar": no puedes obtener un nivel más fino que el que el dato tiene almacenado.

### 4.2 Regla #2 — atributos de conversión (UOM / Moneda)

- Una key figure de **cantidad** exige un **UOMTOID** (unidad destino) en el `$filter`.
- Una key figure de **valor/monetaria** exige un **CURRTOID** (moneda destino).
- Algunas exigen **ambos** a la vez.

Si falta, SAP responde **400** y **te dice cuál falta**. Mensaje real de `my301282`:

```
HTTP 400  /IBP/CX_ALERT_MESSAGES
"Key figure '(ACTUALSQTY)Actuals Qty' requires conversion attribute
 '(UOMTOID)Target UoM' to be filled."
```

**Cómo detectarlo automáticamente:** lee la KF sin filtro de conversión; SAP nombra el atributo faltante. Agrégalo y reintenta. SAP nombra **uno por respuesta**, así que si una KF necesita los dos, harás dos rondas (UOM y luego CURR).

**De dónde salen los valores de UOM/Moneda:** del Dato Maestro del área, en el MDT que termina en `UOMTO` / `CURRENCYTO`.

```
GET  /MASTER_DATA_API_SRV/GMXUOMTO?$format=json&$select=UOMTOID,UOMTODESCR&$top=20
```
**Real (GCMARCIMEX):**
```
KG  - Kilogramo      UN  - Unidad        CJ  - Caja
M3  - Metro cúbico   PAL - Paleta        CCM - Centímetro cúbico
UMB - Unidad de medida base
```

### 4.3 Versión en lectura transaccional

La versión se filtra por la columna `VERSIONID` (no por `PlanningAreaID` — el área va en la URL):

```
&$filter=VERSIONID eq 'PVSMD' and UOMTOID eq 'KG'
```
Sin predicado de `VERSIONID` lees la versión base. **Si vas a comparar/escribir luego, sé explícito con la versión** para no leer una y operar sobre otra.

### 4.4 Regla #3 — contar SIN reventar el sistema

> 🚫 **NUNCA uses `$top=0` para contar en transaccional.** En niveles detallados materializa todo y revienta con `TSV_TNEW_PAGE_ALLOC_FAILED` (memoria ABAP).
>
> ✅ Cuenta con un **`$top` pequeño** (1–2) + `$inlinecount=allpages`:

```
GET  /PLANNING_DATA_API_SRV/GCMARCIMEX?$format=json
     &$top=2&$inlinecount=allpages
     &$select=PRDID,CUSTID,LOCID,UOMTOID,ACTUALSQTY,PERIODID4_TSTAMP
     &$filter=UOMTOID eq 'KG'
```
→ `d.__count`. **Real:** `30.724.393` filas (producto·cliente·ubicación·semana, ACTUALSQTY en KG). Esto te dice **cuán grande** es la lectura antes de lanzarla.

### 4.5 Leer una página de key figures

```
GET  /PLANNING_DATA_API_SRV/GCMARCIMEX?$format=json
     &$select=PRDID,CUSTID,LOCID,UOMTOID,ACTUALSQTY,PERIODID4_TSTAMP
     &$filter=UOMTOID eq 'KG'
     &$orderby=PRDID,CUSTID,LOCID,PERIODID4_TSTAMP
     &$top=5000&$skip=0
```

**Real (formato de fila):**
```
PRD=10000013  CUST=T005_TIENDA  LOC=T005  QTY=0.000000  T=/Date(1767…)/
```

> **`$orderby` por las columnas del nivel + tiempo es obligatorio** si vas a paginar con `$skip`: garantiza ventanas sin solapes ni saltos.

### 4.6 KF calculadas

Las key figures **calculadas** se pueden **leer** (devuelven valor agregado), pero **no** se escriben. (Solo relevante si pasaras a escritura; en lectura no molestan.)

---

## 5. Horizonte de lectura (ventana de tiempo y niveles)

### 5.1 Niveles de tiempo (`PERIODID*`)

El área expone varios niveles de tiempo. El que uses en `$select`/`$filter` define la granularidad temporal:

| Campo | Uso |
|---|---|
| `PERIODIDx_TSTAMP` | Timestamp de inicio del periodo (el que filtras y seleccionas) |
| `PERIODIDx_END_TSTAMP` | Fin del periodo |
| `PERIODIDx_REL` | Posición relativa |

`x` = 0..5 son los niveles del perfil de tiempo del área (típicamente día/semana/mes/trimestre/año según diseño). En estas áreas la **semana** suele ser `PERIODID4_TSTAMP`. **Verifica** leyendo qué timestamps devuelve cada nivel.

### 5.2 Acotar la ventana de tiempo (lo que pediste como "modificar el horizonte")

Usa `ge` / `le` con literal `datetime'…'` (ISO, sin zona):

```
&$filter=UOMTOID eq 'KG'
   and PERIODID4_TSTAMP ge datetime'2026-01-01T00:00:00'
   and PERIODID4_TSTAMP le datetime'2026-03-31T00:00:00'
```
✅ Validado en `my301282` (Q1-2026). Cambiar las dos fechas = cambiar el horizonte de lectura. Esta es la forma **correcta y eficiente** de no traer años completos.

### 5.3 Formato de fecha (importante)

- **Al LEER**, OData v2 devuelve el timestamp como `/Date(1767225600000)/` (milisegundos epoch). Conviértelo en tu cliente a ISO `YYYY-MM-DDTHH:mm:ss`. (Algunos clientes como PowerShell lo auto-convierten a fecha local — ojo con la zona horaria).
- **Al FILTRAR**, usas `datetime'YYYY-MM-DDTHH:mm:ss'` (no el formato `/Date()/`).

### 5.4 Acotar por atributo derivado sin meterlo al nivel

Puedes filtrar por un atributo (ej. `BRAND`) **aunque no esté en el `$select`** — útil para acotar volumen sin cambiar el nivel:

```
&$filter=UOMTOID eq 'KG' and BRAND eq '4711'
   and PERIODID4_TSTAMP ge datetime'2026-01-01T00:00:00'
```

---

## 6. Eficiencia — cómo leer rápido y sin romper nada

Todo esto está **medido** contra tenants IBP reales.

1. **El costo dominante es un overhead fijo por request (~6 s), no el volumen ni la profundidad de `$skip`.**
   → **Lee pocas páginas grandes, no muchas chicas.** Una página de ~5.000 filas rinde ~2,5× más filas/s que una de ~1.700.

2. **Límite de tamaño de respuesta.** Si vas a través de un relay/gateway con tope de cuerpo (~4,5 MB), mantén cada página **≤ ~5.000 filas (≈2,5 MB)**. Respuestas multi-MB pueden llegar **truncadas** bajo carga (JSON incompleto). Si detectas un cuerpo cortado, **reintenta la página** (la lectura es idempotente).

3. **`$skip` profundo NO es el cuello de botella** (se midió plano de `skip=0` a `skip≈850k`). Paginar con `$skip`/`$top` + `$orderby` estable es perfectamente viable.

4. **Concurrencia.** Leer páginas en paralelo escala bien hasta **~6 lecturas concurrentes** (K=6 ≈ 2.700 filas/s; más allá hay rendimientos decrecientes). No dispares 30 lecturas chicas a la vez: desperdicias el overhead fijo.

5. **Particiona por tiempo en volúmenes grandes.** Para millones de filas, lee **semana por semana** (o el bucket que aplique) en vez de un `$skip` gigante: cada partición es una lectura acotada y paralelizable. Para listar los periodos presentes, selecciona **solo el campo de tiempo + 1 KF** (SAP agrega a nivel tiempo → una fila por periodo).

6. **`$select` mínimo.** Cada columna de más es payload y agregación de más. Pide solo lo que usarás.

7. **Filtro de "no-cero" en KF (cuando solo te interesan valores reales):**
   - 🚫 `KF ne 0` → **SAP lo IGNORA** (devuelve todo, ceros incluidos).
   - ✅ `KF gt 0`, `KF lt 0`, y el OR `(KF gt 0 or KF lt 0)` **sí** se aplican.
   - ⚠️ Aun con el OR, ~30% de las filas devueltas pueden traer 0 (SAP agrega al nivel del `$select`; el filtro y el valor agregado pueden discrepar). **Descarta los ceros también en tu cliente** como red de seguridad.

8. **Cuenta primero (4.4)** para dimensionar y decidir si particionas.

---

## 7. Errores frecuentes → causa → solución

| Síntoma | Causa | Solución |
|---|---|---|
| `400 … requires conversion attribute '(UOMTOID)…'` | KF de cantidad sin unidad destino | Agrega `UOMTOID eq '<UOM>'` al `$filter` (4.2) |
| `400 … requires conversion attribute '(CURRTOID)…'` | KF de valor sin moneda destino | Agrega `CURRTOID eq '<MON>'` |
| `400` y al agregar UOM sigue `400` pidiendo otro | KF de **doble** conversión | Agrega **UOMTOID y CURRTOID** juntos |
| `400 "This service cannot be used to extract master data"` | `$select` de solo atributos en PLANNING | Para valores distintos usa MASTER_DATA (3.5); en planning incluye una KF |
| `TSV_TNEW_PAGE_ALLOC_FAILED` / timeout al contar | `$top=0` en transaccional | Cuenta con `$top` pequeño + `$inlinecount` (4.4) |
| `404` al leer `GET /<AREA>` en planning | Área no habilitada en PLANNING_DATA_API_SRV | Habilitar el área en ese servicio dentro de SAP_COM_0720 |
| JSON "Unterminated string" / cuerpo cortado | Respuesta multi-MB truncada en el relay | Página más chica (≤5.000 filas) y **reintenta** (lectura idempotente) |
| Filas vacías de un atributo no aparecen | El vacío es no filtrable; `ne`/`length`/`trim` engañan | Filtra por otro campo, o selecciona valores explícitos (3.6) |
| `401 / 403` | Credenciales o autorización | Revisa usuario/clave del COM_0720; 401/403 ≠ 400 (que es de datos) |

---

## 8. Recetario copy-paste

> Reemplaza `<HOST>` = `my301282-api.scmibp1.ondemand.com`, `<AREA>` = `GCMARCIMEX`. En la URL, las comillas simples de los literales OData se codifican como `%27`.

### 8.1 curl — descubrir áreas (transaccional)
```bash
curl -s -u 'USER:****' \
 "https://<HOST>/sap/opu/odata/IBP/PLANNING_DATA_API_SRV/?\$format=json"
```

### 8.2 curl — versiones de un área
```bash
curl -s -u 'USER:****' \
 "https://<HOST>/sap/opu/odata/IBP/PLANNING_DATA_API_SRV/<AREA>?\$select=VERSIONID,VERSIONNAME&\$top=1000&\$format=json"
```

### 8.3 curl — contar transaccional (seguro)
```bash
curl -s -u 'USER:****' \
 "https://<HOST>/sap/opu/odata/IBP/PLANNING_DATA_API_SRV/<AREA>?\$format=json&\$top=2&\$inlinecount=allpages&\$select=PRDID,CUSTID,LOCID,UOMTOID,ACTUALSQTY,PERIODID4_TSTAMP&\$filter=UOMTOID%20eq%20%27KG%27"
```

### 8.4 curl — leer KF con ventana de tiempo
```bash
curl -s -u 'USER:****' \
 "https://<HOST>/sap/opu/odata/IBP/PLANNING_DATA_API_SRV/<AREA>?\$format=json&\$select=PRDID,CUSTID,LOCID,UOMTOID,ACTUALSQTY,PERIODID4_TSTAMP&\$orderby=PRDID,CUSTID,LOCID,PERIODID4_TSTAMP&\$top=5000&\$skip=0&\$filter=UOMTOID%20eq%20%27KG%27%20and%20PERIODID4_TSTAMP%20ge%20datetime%272026-01-01T00:00:00%27%20and%20PERIODID4_TSTAMP%20le%20datetime%272026-03-31T00:00:00%27"
```

### 8.5 curl — leer Dato Maestro (producto)
```bash
curl -s -u 'USER:****' \
 "https://<HOST>/sap/opu/odata/IBP/MASTER_DATA_API_SRV/GMXPRODUCT?\$format=json&\$select=PRDID,PRDDESCR,BRAND&\$filter=PlanningAreaID%20eq%20%27GCMARCIMEX%27&\$orderby=PRDID&\$top=2000&\$skip=0"
```

### 8.6 curl — valores distintos de un atributo (dropdown)
```bash
curl -s -u 'USER:****' \
 "https://<HOST>/sap/opu/odata/IBP/MASTER_DATA_API_SRV/GMXPRODUCT?\$format=json&\$top=5000&\$select=BRAND&\$filter=PlanningAreaID%20eq%20%27GCMARCIMEX%27"
```

### 8.7 Plantilla de paginación (pseudocódigo)
```
top   = 5000
skip  = 0
orderby = <columnas del nivel> + <campo de tiempo>     # estable
repetir:
    page = GET <AREA>?$select=...&$filter=...&$orderby=orderby&$top=top&$skip=skip
    procesar(page)            # descartar KF en 0 si solo quieres valores reales
    si page.length < top: fin
    skip += top
# para millones de filas: envolver esto en un loop por ventana de tiempo (semana a semana)
```

---

## Resumen de "qué hace bien" la lectura

1. **Dos servicios, un COM_0720**; el área debe estar habilitada en cada uno.
2. **Descubre** áreas/versiones/tablas/KF; no asumas nombres.
3. En transaccional: **`$select` define el nivel**, KF de cantidad/valor exigen **UOMTOID/CURRTOID**, y **cuenta con `$top` pequeño, nunca 0**.
4. **Horizonte** = filtro `PERIODIDx_TSTAMP ge/le datetime'…'`.
5. **Eficiencia** = pocas páginas grandes (≤5.000 filas), `$orderby` estable, ~6 lecturas en paralelo, partición por tiempo en volúmenes grandes, `$select` mínimo, y para "no-cero" usa `gt/lt` (nunca `ne 0`).
