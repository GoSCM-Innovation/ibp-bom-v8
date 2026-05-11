import { useState, useEffect, useMemo, useRef } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ComposedChart, Line,
} from 'recharts'
import { proxyCall } from '../../services/proxyCall'
import { buildDateFilter, buildPath, parseV4 } from '../../services/metering'
import { toInputDate, inputDateToDate, getTzMode } from '../../utils/dateUtils'

// ─── Constants ────────────────────────────────────────────────────────────────

const PRESETS = [
  { id: 'today', label: 'Hoy'     },
  { id: '7d',    label: '7 días'  },
  { id: '30d',   label: '30 días' },
  { id: '90d',   label: '90 días' },
]

const TABS = [
  { id: 'adopcion', label: 'Adopción'     },
  { id: 'excel',    label: 'Excel Add-In' },
  { id: 'apps',     label: 'Herramientas' },
]

const COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#8b5cf6',
]

// FioriProjectID del Excel Add-In — filtrado de MtrgGenericUIActionUsage
// porque esas filas son duplicados de MtrgActyExcelAddInPlanningView (mismo ActivityID)
const EXCEL_ADDIN_PROJECT_ID = 'tl.ibp.excel.addin.planningview'

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function groupBy(arr, keyFn) {
  const fn = typeof keyFn === 'string' ? (r => r[keyFn] ?? '(sin valor)') : keyFn
  return arr.reduce((acc, row) => {
    const k = fn(row)
    ;(acc[k] = acc[k] || []).push(row)
    return acc
  }, {})
}

function dayKey(iso) {
  if (!iso) return '?'
  if (String(iso).startsWith('/Date(')) {
    const ms = parseInt(String(iso).replace(/\/Date\((\d+)[^)]*\)\//, '$1'))
    return new Date(ms).toISOString().slice(0, 10)
  }
  return String(iso).slice(0, 10)
}

function sumField(arr, key) {
  return arr.reduce((a, r) => a + (Number(r[key]) || 0), 0)
}

function avgField(arr, key) {
  return arr.length ? sumField(arr, key) / arr.length : 0
}

function toSecs(val, unit = '') {
  const n = Number(val) || 0
  const u = (unit || '').toLowerCase()
  return u.includes('ms') ? n / 1000 : n
}

function formatDuration(val, unit = '') {
  const s = toSecs(val, unit)
  if (s < 1)  return '<1s'
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60), r = Math.round(s % 60)
  return `${m}m ${r}s`
}

function uniqueUsers(arr) {
  return new Set(arr.map(r => r.UserID).filter(Boolean)).size
}

function presetDates(id) {
  const now = new Date(), start = new Date(now)
  if (id === 'today') {
    start.setHours(0, 0, 0, 0)
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    return [start, end]
  }
  const days = id === '7d' ? 7 : id === '30d' ? 30 : 90
  start.setDate(start.getDate() - days); start.setHours(0, 0, 0, 0)
  return [start, now]
}

// ─── UI primitives ─────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color, warning }) {
  return (
    <div style={{
      background: 'var(--bg)', borderRadius: 10, padding: '14px 18px', flex: '1 1 130px',
      border: `1px solid ${warning ? 'rgba(239,68,68,.4)' : 'var(--border)'}`,
    }}>
      <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: color || 'var(--text)' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: warning ? 'var(--red)' : 'var(--text3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function ChartCard({ title, children, style }) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 12px 8px', ...style }}>
      {title && (
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 12 }}>
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

function BlockTitle({ text, count }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 10 }}>
      {text}{count !== undefined ? ` (${Number(count).toLocaleString()})` : ''}
    </div>
  )
}

function Note({ text }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10, fontStyle: 'italic' }}>
      {text}
    </div>
  )
}

function EmptyState({ msg = 'Sin datos para el período seleccionado' }) {
  return (
    <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
      {msg}
    </div>
  )
}

function DataTable({ columns, rows, maxRows }) {
  const shown = maxRows ? rows.slice(0, maxRows) : rows
  if (!shown.length) return null
  return (
    <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
            {columns.map(c => (
              <th key={c.key} style={{
                padding: '8px 12px', textAlign: c.align || 'left', whiteSpace: 'nowrap',
                color: 'var(--text3)', fontSize: 10, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '.06em',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} style={{
              borderBottom: i < shown.length - 1 ? '1px solid var(--border)' : 'none',
              background: i % 2 ? 'rgba(255,255,255,.015)' : 'transparent',
            }}>
              {columns.map(c => (
                <td key={c.key} style={{
                  padding: '8px 12px',
                  color: c.color?.(row) || 'var(--text)',
                  fontFamily: c.mono ? 'var(--mono)' : undefined,
                  fontSize: c.mono ? 11 : 12,
                  whiteSpace: c.nowrap ? 'nowrap' : undefined,
                  textAlign: c.align || 'left',
                }}>
                  {c.render ? c.render(row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TxtField({ label, value, onChange, placeholder }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
        {label}
      </label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--text)', fontSize: 12, padding: '6px 10px', outline: 'none', minWidth: 140,
        }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e  => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  )
}

// ─── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({ preset, onPreset, from, setFrom, to, setTo, loading, hasData }) {
  return (
    <div style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)', padding: '14px 24px', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.07em', marginRight: 6 }}>
          Período
        </span>
        {PRESETS.map(p => {
          const active = preset === p.id
          return (
            <button key={p.id} onClick={() => onPreset(p.id)} style={{
              padding: '5px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              background: active ? 'rgba(247,168,0,.10)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text2)',
              cursor: 'pointer', transition: 'all .15s',
            }}>
              {active && '✓ '}{p.label}
            </button>
          )
        })}
        {preset === 'custom' && (
          <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic', marginLeft: 4 }}>Personalizado</span>
        )}
        {loading && hasData && (
          <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid var(--border2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
            Actualizando…
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <DtField label="Desde" value={from} onChange={v => { setFrom(v); onPreset('custom') }} />
        <DtField label="Hasta"  value={to}   onChange={v => { setTo(v);   onPreset('custom') }} />
      </div>
    </div>
  )
}

function DtField({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
        {label}
      </label>
      <input type="datetime-local" value={value} onChange={e => onChange(e.target.value)} style={{
        background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
        color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 10px', outline: 'none',
      }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e  => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  )
}

// ─── Tab 1: Adopción ───────────────────────────────────────────────────────────

function TabAdopcion({ overview, planningViews, fiori, dashboards, stories, alerts, plannerWS, users, userMap }) {
  const [search, setSearch] = useState('')

  const activeUserIds = useMemo(() => new Set(overview.map(r => r.UserID).filter(Boolean)), [overview])
  const totalLicensed = users.length
  const totalActive   = activeUserIds.size
  const adoptionRate  = totalLicensed > 0 ? Math.round(totalActive / totalLicensed * 100) : 0
  const uniquePAs     = new Set(overview.map(r => r.PlanningAreaID).filter(Boolean)).size
  const inactiveCount = totalLicensed - totalActive

  // DAU chart
  const dauData = useMemo(() => {
    const byDay = {}
    overview.forEach(row => {
      const d = dayKey(row.TimestampStart)
      if (!byDay[d]) byDay[d] = new Set()
      if (row.UserID) byDay[d].add(row.UserID)
    })
    return Object.entries(byDay)
      .map(([day, s]) => ({ day, Usuarios: s.size }))
      .sort((a, b) => a.day.localeCompare(b.day))
  }, [overview])

  // Feature adoption table — fuente: cada entidad provee UserID y total de registros
  // MtrgGenericUIActionUsage con FioriProjectID = EXCEL_ADDIN_PROJECT_ID se excluye
  // porque son duplicados de MtrgActyExcelAddInPlanningView (mismo ActivityID)
  const featureRows = useMemo(() => {
    const fioriOtros = fiori.filter(r => r.FioriProjectID !== EXCEL_ADDIN_PROJECT_ID)
    const fioriByApp = groupBy(fioriOtros, r => r.FioriProjectTitle || r.FioriProjectID)

    const rows = []

    if (planningViews.length > 0)
      rows.push({ name: 'Excel Add-In', users: uniqueUsers(planningViews), sessions: planningViews.length })

    if (plannerWS.length > 0)
      rows.push({ name: 'Planner Workspace', users: uniqueUsers(plannerWS), sessions: plannerWS.length })

    Object.entries(fioriByApp).forEach(([name, appRows]) => {
      rows.push({ name, users: uniqueUsers(appRows), sessions: appRows.length })
    })

    if (dashboards.length > 0)
      rows.push({ name: 'Dashboards', users: uniqueUsers(dashboards), sessions: dashboards.length })

    if (stories.length > 0)
      rows.push({ name: 'Analytics Stories', users: uniqueUsers(stories), sessions: stories.length })

    if (alerts.length > 0)
      rows.push({ name: 'Alert Monitor', users: uniqueUsers(alerts), sessions: alerts.length })

    return rows.sort((a, b) => b.users - a.users)
  }, [planningViews, fiori, plannerWS, dashboards, stories, alerts])

  // Top usuarios activos
  const topActiveUsers = useMemo(() => {
    const byUser = groupBy(overview, 'UserID')
    return Object.entries(byUser)
      .filter(([uid]) => uid && uid !== '(sin valor)')
      .map(([uid, rows]) => {
        const last = rows.map(r => r.TimestampStart).filter(Boolean).sort().reverse()[0]
        const pas  = [...new Set(rows.map(r => r.PlanningAreaID).filter(Boolean))]
        return { uid, name: userMap[uid] || uid, acts: rows.length, last: last ? last.slice(0, 10) : '—', pas: pas.slice(0, 3).join(', ') || '—' }
      })
      .sort((a, b) => b.acts - a.acts)
      .slice(0, 15)
  }, [overview, userMap])

  // Usuarios sin actividad en el período
  const inactiveUsers = useMemo(() => {
    const q = search.toLowerCase()
    return users
      .filter(u => u.UserID && !activeUserIds.has(u.UserID))
      .map(u => ({ uid: u.UserID, name: userMap[u.UserID] || [u.FirstName, u.LastName].filter(Boolean).join(' ') || u.UserID }))
      .filter(u => !q || u.uid.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
      .sort((a, b) => a.uid.localeCompare(b.uid))
  }, [users, activeUserIds, userMap, search])

  const rateColor = adoptionRate >= 70 ? '#10b981' : adoptionRate >= 40 ? '#f59e0b' : '#ef4444'

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      {/* KPIs */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <KpiCard
          label="Tasa de adopción"
          value={`${adoptionRate}%`}
          sub={`${totalActive} activos de ${totalLicensed} licenciados`}
          color={rateColor} warning={adoptionRate < 40}
        />
        <KpiCard label="Usuarios activos"     value={totalActive}   color="var(--accent)" />
        <KpiCard label="Total licenciados"    value={totalLicensed} />
        <KpiCard
          label="Sin actividad"
          value={inactiveCount}
          sub={inactiveCount > 0 ? 'Licencias sin uso en el período' : undefined}
          color={inactiveCount > 0 ? '#ef4444' : 'var(--text)'}
          warning={inactiveCount > 0}
        />
        <KpiCard label="Planning Areas activas" value={uniquePAs} />
      </div>

      {/* DAU */}
      {dauData.length > 1 && (
        <ChartCard title="Usuarios únicos por día" style={{ marginBottom: 24 }}>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={dauData} margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 10 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="Usuarios" fill={COLORS[0]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Feature adoption table */}
      {featureRows.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <BlockTitle text="Adopción por herramienta" />
          <DataTable
            columns={[
              { key: 'name',     label: 'Herramienta' },
              { key: 'users',    label: 'Usuarios únicos', align: 'right', mono: true,
                render: r => r.users.toLocaleString() },
              { key: 'pct',      label: '% de usuarios activos', align: 'right',
                render: r => totalActive > 0 ? `${Math.round(r.users / totalActive * 100)}%` : '—',
                color: r => {
                  if (!totalActive) return 'var(--text2)'
                  const p = Math.round(r.users / totalActive * 100)
                  return p >= 50 ? '#10b981' : p >= 20 ? '#f59e0b' : 'var(--text2)'
                },
              },
              { key: 'sessions', label: 'Sesiones / Acciones', align: 'right', mono: true,
                render: r => r.sessions.toLocaleString() },
            ]}
            rows={featureRows}
          />
        </div>
      )}

      {/* Activos / Inactivos */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {topActiveUsers.length > 0 && (
          <div>
            <BlockTitle text="Usuarios más activos" />
            <DataTable
              columns={[
                { key: 'name', label: 'Usuario' },
                { key: 'acts', label: 'Ventanas',    align: 'right', mono: true },
                { key: 'last', label: 'Último',      mono: true, nowrap: true },
                { key: 'pas',  label: 'Planning Areas', color: () => 'var(--text2)' },
              ]}
              rows={topActiveUsers}
              maxRows={10}
            />
          </div>
        )}
        <div>
          <BlockTitle text="Sin actividad en el período" count={inactiveUsers.length} />
          {inactiveUsers.length === 0 ? (
            <div style={{ padding: '14px 0', fontSize: 12, color: '#10b981' }}>
              ✓ Todos los usuarios licenciados tuvieron actividad
            </div>
          ) : (
            <>
              <input
                type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Buscar usuario…"
                style={{
                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                  color: 'var(--text)', fontSize: 12, padding: '6px 10px', outline: 'none',
                  width: '100%', marginBottom: 8, boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e  => e.target.style.borderColor = 'var(--border)'}
              />
              <DataTable
                columns={[
                  { key: 'uid',  label: 'Usuario',   mono: true },
                  { key: 'name', label: 'Nombre', color: () => 'var(--text2)' },
                ]}
                rows={inactiveUsers}
                maxRows={20}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Tab 2: Excel Add-In ───────────────────────────────────────────────────────

function TabExcel({ planningViews, logons, chgKeyFig, userMap }) {
  const [subtab,     setSubtab]     = useState('slow')
  const [userFilter, setUserFilter] = useState('')
  const [paFilter,   setPaFilter]   = useState('')

  const filtered = useMemo(() => planningViews.filter(r =>
    (!userFilter || (r.UserID || '').toLowerCase().includes(userFilter.toLowerCase())) &&
    (!paFilter   || (r.PlanningAreaID || '').toLowerCase().includes(paFilter.toLowerCase()))
  ), [planningViews, userFilter, paFilter])

  const total   = filtered.length
  const success = filtered.filter(r => r.SuccessfullyCompleted).length
  const failed  = total - success
  const rate    = total ? Math.round(success / total * 100) : 0
  const unit    = planningViews[0]?.DurationUnit || 's'
  const avgDur  = avgField(filtered, 'TotalDuration')
  const cells   = sumField(filtered, 'PlanningViewCells')
  const logonUnit   = logons[0]?.DurationUnit || 's'
  const avgLogonDur = avgField(logons, 'TotalDuration')
  const rateColor   = rate >= 90 ? '#10b981' : rate >= 70 ? '#f59e0b' : '#ef4444'
  const durColor    = toSecs(avgDur, unit) > 120 ? '#ef4444' : toSecs(avgDur, unit) > 60 ? '#f59e0b' : '#10b981'

  // Tipo de operación: remover prefijo XLS_ y reemplazar _ con espacio
  const actTypeData = useMemo(() => {
    if (!total) return []
    const byType = groupBy(filtered, 'ActivityType')
    return Object.entries(byType)
      .map(([type, rows]) => ({
        tipo: type.replace(/^XLS_/, '').replace(/_/g, ' '),
        count: rows.length,
        pct: Math.round(rows.length / total * 100),
      }))
      .sort((a, b) => b.count - a.count)
  }, [filtered, total])

  // Tendencia diaria
  const trendData = useMemo(() => {
    const byDay = groupBy(filtered, r => dayKey(r.Timestamp || r.TimestampStart))
    return Object.entries(byDay)
      .map(([day, rows]) => {
        const ok  = rows.filter(r => r.SuccessfullyCompleted).length
        const avg = toSecs(avgField(rows, 'TotalDuration'), unit)
        return { day, 'Éxito %': Math.round(ok / rows.length * 100), 'Duración (s)': parseFloat(avg.toFixed(1)) }
      })
      .sort((a, b) => a.day.localeCompare(b.day))
  }, [filtered, unit])

  // Rendimiento por PA
  const paPerf = useMemo(() => {
    const byPA = groupBy(filtered.filter(r => r.PlanningAreaID), 'PlanningAreaID')
    return Object.entries(byPA)
      .map(([pa, rows]) => {
        const ok = rows.filter(r => r.SuccessfullyCompleted).length
        return { pa, total: rows.length, rate: Math.round(ok / rows.length * 100), avgDur: parseFloat(toSecs(avgField(rows, 'TotalDuration'), unit).toFixed(1)) }
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
  }, [filtered, unit])

  // Top key figures modificados
  const topChgKF = useMemo(() => {
    if (!chgKeyFig.length) return []
    const byKF = groupBy(chgKeyFig, 'KeyFigureID')
    return Object.entries(byKF)
      .map(([kf, rows]) => ({
        kf,
        cambios: sumField(rows, 'KeyFigureCount') || rows.length,
        usuarios: uniqueUsers(rows),
      }))
      .sort((a, b) => b.cambios - a.cambios)
      .slice(0, 15)
  }, [chgKeyFig])

  const slowRows = useMemo(() =>
    [...filtered].sort((a, b) => Number(b.TotalDuration) - Number(a.TotalDuration)).slice(0, 20),
    [filtered])

  const failRows = useMemo(() =>
    filtered.filter(r => !r.SuccessfullyCompleted).slice(0, 20),
    [filtered])

  const pvCols = [
    { key: 'user',     label: 'Usuario',      render: r => userMap[r.UserID] || r.UserID || '—' },
    { key: 'pa',       label: 'PA',            render: r => r.PlanningAreaID || '—', mono: true },
    { key: 'template', label: 'Template',      render: r => r.TemplateName || r.FavoriteName || r.WorksheetName || '—', color: () => 'var(--text2)' },
    { key: 'hoja',     label: 'Hoja',          render: r => r.WorksheetName || '—', color: () => 'var(--text3)' },
    { key: 'dur',      label: 'Duración',      nowrap: true, mono: true,
      render: r => formatDuration(r.TotalDuration, r.DurationUnit),
      color: r => { const s = toSecs(r.TotalDuration, r.DurationUnit); return s > 120 ? '#ef4444' : s > 60 ? '#f59e0b' : '#10b981' } },
    { key: 'noui',     label: 'Sin interacc.', nowrap: true, mono: true,
      render: r => formatDuration(r.DurationWithoutUserInteraction, r.DurationUnit), color: () => 'var(--text3)' },
    { key: 'cells',    label: 'Celdas',        align: 'right', mono: true,
      render: r => Number(r.PlanningViewCells).toLocaleString() },
  ]

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      {total === 0 ? <EmptyState /> : (
        <>
          {/* KPIs */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <KpiCard label="Operaciones"       value={total.toLocaleString()} />
            <KpiCard label="Tasa de éxito"     value={`${rate}%`}            color={rateColor} warning={rate < 70} />
            <KpiCard label="Errores"           value={failed}                color={failed > 0 ? '#ef4444' : 'var(--text)'} warning={failed > 0} />
            <KpiCard label="Duración promedio" value={formatDuration(avgDur, unit)} color={durColor} />
            <KpiCard label="Celdas procesadas" value={cells.toLocaleString()} />
            {logons.length > 0 && (
              <KpiCard label="Logons Excel" value={logons.length} sub={`Prom: ${formatDuration(avgLogonDur, logonUnit)}`} />
            )}
          </div>

          {/* Tipos de operación */}
          {actTypeData.length > 1 && (
            <div style={{ marginBottom: 24 }}>
              <BlockTitle text="Distribución por tipo de operación" />
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {actTypeData.map((t, i) => (
                  <div key={t.tipo} style={{
                    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
                    padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140,
                  }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: COLORS[i % COLORS.length], fontVariantNumeric: 'tabular-nums' }}>
                      {t.pct}%
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text2)' }}>{t.tipo}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                      {t.count.toLocaleString()} ops
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tendencia diaria */}
          {trendData.length > 1 && (
            <ChartCard title="Tendencia diaria — éxito y duración" style={{ marginBottom: 16 }}>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={trendData} margin={{ left: 0, right: 32, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="day" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis yAxisId="pct" domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis yAxisId="dur" orientation="right" tickFormatter={v => `${v}s`} tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <Tooltip formatter={(v, n) => n === 'Éxito %' ? `${v}%` : `${v}s`} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
                  <Bar  yAxisId="dur" dataKey="Duración (s)" fill={COLORS[2]} opacity={0.65} radius={[3, 3, 0, 0]} />
                  <Line yAxisId="pct" dataKey="Éxito %"      stroke={COLORS[1]} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Rendimiento por PA */}
          {paPerf.length > 0 && (
            <ChartCard title="Rendimiento por Planning Area (top 10)" style={{ marginBottom: 24 }}>
              <ResponsiveContainer width="100%" height={Math.max(160, paPerf.length * 30)}>
                <BarChart data={paPerf} layout="vertical" margin={{ left: 4, right: 56, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis type="category" dataKey="pa" width={90} tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <Tooltip formatter={(v, n) => n === 'Éxito %' ? `${v}%` : n === 'Dur. prom (s)' ? `${v}s` : v} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="total"  fill={COLORS[0]} name="Operaciones"    radius={[0, 3, 3, 0]} />
                  <Bar dataKey="avgDur" fill={COLORS[2]} name="Dur. prom (s)"  radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Key figures modificados */}
          {topChgKF.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <BlockTitle text="Key figures más modificados" count={topChgKF.length} />
              <DataTable
                columns={[
                  { key: 'kf',       label: 'Key Figure',       mono: true },
                  { key: 'cambios',  label: 'Cambios totales',  align: 'right', mono: true, render: r => r.cambios.toLocaleString() },
                  { key: 'usuarios', label: 'Usuarios',         align: 'right', mono: true },
                ]}
                rows={topChgKF}
              />
            </div>
          )}

          {/* Filtros + subtabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <TxtField label="Filtrar usuario" value={userFilter} onChange={setUserFilter} placeholder="Usuario…" />
            <TxtField label="Filtrar PA"      value={paFilter}   onChange={setPaFilter}   placeholder="Planning Area…" />
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 0 }}>
              {[['slow', `Más lentas (${slowRows.length})`], ['errors', `Errores (${failRows.length})`]].map(([id, label]) => (
                <button key={id} onClick={() => setSubtab(id)} style={{
                  padding: '6px 16px', fontSize: 11, background: 'none', border: 'none',
                  borderBottom: subtab === id ? '2px solid var(--accent)' : '2px solid transparent',
                  color: subtab === id ? 'var(--text)' : 'var(--text2)',
                  fontWeight: subtab === id ? 600 : 400, cursor: 'pointer', transition: 'all .15s',
                }}>{label}</button>
              ))}
            </div>
          </div>

          {subtab === 'slow' && <DataTable columns={pvCols} rows={slowRows} />}
          {subtab === 'errors' && (
            failRows.length === 0
              ? <div style={{ padding: '14px 0', fontSize: 12, color: '#10b981' }}>✓ Sin errores en el período</div>
              : <DataTable columns={pvCols} rows={failRows} />
          )}
        </>
      )}
    </div>
  )
}

// ─── Tab 3: Herramientas ───────────────────────────────────────────────────────

function TabApps({ fiori, dashboards, stories, alerts, plannerWS, userMap }) {
  // Excluir entradas de Excel Add-In: son duplicados de MtrgActyExcelAddInPlanningView
  const fioriOtros = useMemo(() =>
    fiori.filter(r => r.FioriProjectID !== EXCEL_ADDIN_PROJECT_ID),
    [fiori])

  // Apps Fiori agrupadas por título (provisto por la API)
  const fioriApps = useMemo(() => {
    const byApp = groupBy(fioriOtros, r => r.FioriProjectTitle || r.FioriProjectID)
    return Object.entries(byApp)
      .map(([name, rows]) => ({ name, usuarios: uniqueUsers(rows), usos: rows.length }))
      .sort((a, b) => b.usos - a.usos)
  }, [fioriOtros])

  // Planner Workspace: top libros de trabajo
  const wsLibros = useMemo(() => {
    const byLibro = groupBy(plannerWS.filter(r => r.WorkbookName), r => r.WorkbookName)
    return Object.entries(byLibro)
      .map(([name, rows]) => ({ name, usuarios: uniqueUsers(rows), aperturas: rows.length }))
      .sort((a, b) => b.aperturas - a.aperturas)
      .slice(0, 10)
  }, [plannerWS])

  // Dashboards: sesiones por usuario (DashboardName no disponible en la API)
  const dashPorUsuario = useMemo(() => {
    const byUser = groupBy(dashboards, 'UserID')
    return Object.entries(byUser)
      .map(([uid, rows]) => {
        const pas = [...new Set(rows.map(r => r.PlanningAreaID).filter(Boolean))]
        return { usuario: userMap[uid] || uid, pa: pas.slice(0, 3).join(', ') || '—', sesiones: rows.length }
      })
      .sort((a, b) => b.sesiones - a.sesiones)
      .slice(0, 15)
  }, [dashboards, userMap])

  // Alert Monitor: aperturas por usuario (la API registra ALTMON_APP_LOAD;
  // los contadores de acciones —snooze, goto, etc.— no tienen datos en este tenant)
  const alertPorUsuario = useMemo(() => {
    const byUser = groupBy(alerts, 'UserID')
    return Object.entries(byUser)
      .map(([uid, rows]) => {
        const last = rows.map(r => r.Timestamp).filter(Boolean).sort().reverse()[0]
        return { usuario: userMap[uid] || uid, aperturas: rows.length, ultima: last ? last.slice(0, 10) : '—' }
      })
      .sort((a, b) => b.aperturas - a.aperturas)
      .slice(0, 15)
  }, [alerts, userMap])

  // Analytics Stories
  const storyRows = useMemo(() => {
    const byStory = groupBy(stories, r => r.StoryName || r.StoryID || '?')
    return Object.entries(byStory)
      .map(([name, rows]) => ({ name, usuarios: uniqueUsers(rows), vistas: rows.length }))
      .sort((a, b) => b.vistas - a.vistas)
      .slice(0, 10)
  }, [stories])

  const noData = !fioriOtros.length && !dashboards.length && !alerts.length && !plannerWS.length && !stories.length

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      {noData ? <EmptyState /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

          {/* Apps Fiori */}
          {fioriApps.length > 0 && (
            <div>
              <BlockTitle text="Apps Fiori" />
              <DataTable
                columns={[
                  { key: 'name',     label: 'Aplicación' },
                  { key: 'usuarios', label: 'Usuarios únicos', align: 'right', mono: true },
                  { key: 'usos',     label: 'Usos',            align: 'right', mono: true, render: r => r.usos.toLocaleString() },
                ]}
                rows={fioriApps}
              />
            </div>
          )}

          {/* Planner Workspace */}
          {plannerWS.length > 0 && (
            <div>
              <BlockTitle text="Planner Workspace" count={plannerWS.length} />
              {wsLibros.length > 0 ? (
                <DataTable
                  columns={[
                    { key: 'name',      label: 'Libro de trabajo' },
                    { key: 'usuarios',  label: 'Usuarios únicos', align: 'right', mono: true },
                    { key: 'aperturas', label: 'Aperturas',       align: 'right', mono: true },
                  ]}
                  rows={wsLibros}
                />
              ) : (
                <Note text="Sin nombre de libro disponible en los registros del período." />
              )}
            </div>
          )}

          {/* Dashboards */}
          {dashPorUsuario.length > 0 && (
            <div>
              <BlockTitle text={`Sesiones de Dashboard (${dashboards.length} total)`} />
              <Note text="La API no incluye el nombre del dashboard en los registros de actividad." />
              <DataTable
                columns={[
                  { key: 'usuario',  label: 'Usuario' },
                  { key: 'pa',       label: 'Planning Area(s)', color: () => 'var(--text2)' },
                  { key: 'sesiones', label: 'Sesiones', align: 'right', mono: true },
                ]}
                rows={dashPorUsuario}
              />
            </div>
          )}

          {/* Alert Monitor */}
          {alertPorUsuario.length > 0 && (
            <div>
              <BlockTitle text="Alert Monitor — aperturas de la app" />
              <Note text="La API registra apertura de la app (ALTMON_APP_LOAD). Las acciones dentro de alertas no tienen datos en este tenant." />
              <DataTable
                columns={[
                  { key: 'usuario',   label: 'Usuario' },
                  { key: 'aperturas', label: 'Aperturas', align: 'right', mono: true },
                  { key: 'ultima',    label: 'Última',    mono: true, nowrap: true },
                ]}
                rows={alertPorUsuario}
              />
            </div>
          )}

          {/* Analytics Stories */}
          {storyRows.length > 0 && (
            <div>
              <BlockTitle text="Analytics Stories" />
              <DataTable
                columns={[
                  { key: 'name',     label: 'Story' },
                  { key: 'usuarios', label: 'Usuarios únicos', align: 'right', mono: true },
                  { key: 'vistas',   label: 'Vistas',          align: 'right', mono: true },
                ]}
                rows={storyRows}
              />
            </div>
          )}

        </div>
      )}
    </div>
  )
}

// ─── Main export ───────────────────────────────────────────────────────────────

export default function Metering({ connection, session }) {
  const [preset,    setPreset]    = useState('7d')
  const [from,      setFrom]      = useState(() => { const [s] = presetDates('7d'); return toInputDate(s, getTzMode()) })
  const [to,        setTo]        = useState(() => { const [, e] = presetDates('7d'); return toInputDate(e, getTzMode()) })
  const [data,      setData]      = useState(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [activeTab, setActiveTab] = useState('adopcion')

  const fromRef         = useRef(from)
  const toRef           = useRef(to)
  const debounceRef     = useRef(null)
  const skipDebounceRef = useRef(false)
  const mountedRef      = useRef(false)

  fromRef.current = from
  toRef.current   = to

  async function loadData() {
    setLoading(true)
    setError('')
    const tz       = getTzMode()
    const fromDate = inputDateToDate(fromRef.current, tz)
    const toDate   = inputDateToDate(toRef.current,   tz)

    const call = async (path) => {
      const res = await proxyCall({ connection, session, com: '0924', path })
      if (!res.ok) {
        if (res.status === 401) throw new Error('401')
        throw new Error(`HTTP ${res.status}`)
      }
      return parseV4(await res.json())
    }

    const dateFilter  = buildDateFilter(fromDate, toDate)
    const groupFilter = buildDateFilter(fromDate, toDate, 'TimestampStart')

    try {
      const [overview, planningViews, logons, fiori, dashboards, stories, alerts, users, plannerWS, chgKeyFig] =
        await Promise.all([
          call(buildPath('MtrgActyGroupOverview',          { filter: groupFilter, top: 2000 })),
          call(buildPath('MtrgActyExcelAddInPlanningView', { filter: dateFilter,  top: 2000, orderby: 'TotalDuration desc' })),
          call(buildPath('MtrgActyExcelAddInLogon',        { filter: dateFilter,  top: 2000 })),
          call(buildPath('MtrgGenericUIActionUsage',       { filter: dateFilter,  top: 1000 })),
          call(buildPath('MtrgDashboard',                  { filter: dateFilter,  top: 500  })),
          call(buildPath('MtrgMngAnalyticStory',           { filter: dateFilter,  top: 500  })),
          call(buildPath('MtrgActyAlertMonitor',           { filter: dateFilter,  top: 500  })),
          call('/MtrgActyBusinessUser?$top=1000'),
          call(buildPath('MtrgPlannerWorkspaceUI',         { filter: dateFilter,  top: 1000 })),
          call(buildPath('MtrgActyExcelAddInChgKeyFig',    { filter: dateFilter,  top: 2000 })),
        ])
      setData({ overview, planningViews, logons, fiori, dashboards, stories, alerts, users, plannerWS, chgKeyFig })
    } catch (e) {
      setError(e.message === '401'
        ? 'Credenciales incorrectas. Cierra sesión y vuelve a ingresar.'
        : `Error al cargar datos: ${e.message}`)
    }
    setLoading(false)
  }

  // Mount: carga inmediata; preset: carga inmediata via handlePreset; datetime: debounce 900ms
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      loadData()
      return
    }
    if (skipDebounceRef.current) {
      skipDebounceRef.current = false
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => loadData(), 900)
    return () => clearTimeout(debounceRef.current)
  }, [from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  function handlePreset(id) {
    setPreset(id)
    if (id !== 'custom') {
      const [s, e] = presetDates(id)
      const tz     = getTzMode()
      const nf     = toInputDate(s, tz)
      const nt     = toInputDate(e, tz)
      fromRef.current         = nf
      toRef.current           = nt
      skipDebounceRef.current = true
      setFrom(nf)
      setTo(nt)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      loadData()
    }
  }

  const userMap = useMemo(() => {
    if (!data) return {}
    return Object.fromEntries(
      data.users.map(u => [u.UserID, u.FullName || [u.FirstName, u.LastName].filter(Boolean).join(' ') || u.UserID])
    )
  }, [data])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <FilterBar
        preset={preset} onPreset={handlePreset}
        from={from}     setFrom={setFrom}
        to={to}         setTo={setTo}
        loading={loading} hasData={!!data}
      />

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', background: 'var(--bg2)', padding: '0 24px', flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: '8px 18px', fontSize: 11, background: 'none', border: 'none',
            borderBottom: activeTab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === t.id ? 'var(--text)' : 'var(--text2)',
            fontWeight: activeTab === t.id ? 600 : 400, cursor: 'pointer', transition: 'all .15s',
          }}>{t.label}</button>
        ))}
      </div>

      {error && (
        <div style={{ padding: '10px 24px', background: 'rgba(239,68,68,.08)', borderBottom: '1px solid rgba(239,68,68,.25)', fontSize: 12, color: 'var(--red)', flexShrink: 0 }}>
          ✕ {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', opacity: loading && data ? 0.55 : 1, transition: 'opacity .2s' }}>
        {!data && loading && (
          <div style={{ padding: 56, textAlign: 'center', color: 'var(--text2)', fontSize: 13 }}>
            Cargando datos de telemetría…
          </div>
        )}
        {!data && !loading && !error && (
          <div style={{ padding: 56, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
            Selecciona un período para comenzar
          </div>
        )}
        {data && (
          <>
            {activeTab === 'adopcion' && (
              <TabAdopcion
                overview={data.overview}     planningViews={data.planningViews}
                fiori={data.fiori}           dashboards={data.dashboards}
                stories={data.stories}       alerts={data.alerts}
                plannerWS={data.plannerWS}   users={data.users}
                userMap={userMap}
              />
            )}
            {activeTab === 'excel' && (
              <TabExcel
                planningViews={data.planningViews} logons={data.logons}
                chgKeyFig={data.chgKeyFig}         userMap={userMap}
              />
            )}
            {activeTab === 'apps' && (
              <TabApps
                fiori={data.fiori}         dashboards={data.dashboards}
                stories={data.stories}     alerts={data.alerts}
                plannerWS={data.plannerWS} userMap={userMap}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
