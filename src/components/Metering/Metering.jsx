import { useState, useEffect, useMemo, useRef } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts'
import { proxyCall } from '../../services/proxyCall'
import { buildDateFilter, buildPath, parseV4 } from '../../services/metering'
import { toInputDate, inputDateToDate, getTzMode } from '../../utils/dateUtils'

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = id => `ibp_metering_session_${id}`

const PRESETS = [
  { id: 'today', label: 'Hoy' },
  { id: '7d',   label: '7 días' },
  { id: '30d',  label: '30 días' },
  { id: '90d',  label: '90 días' },
]

const CHART_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#8b5cf6',
]

const ALERT_ACTIONS = [
  { key: 'RefreshButton',   label: 'Refresh' },
  { key: 'AlertDetails',    label: 'Ver detalle' },
  { key: 'GotoExcel',       label: 'Ir a Excel' },
  { key: 'SnoozeMe',        label: 'Posponer (yo)' },
  { key: 'SnoozeAll',       label: 'Posponer (todos)' },
  { key: 'AddToCase',       label: 'Agregar a caso' },
  { key: 'GotoAna',         label: 'Ir a Analytics' },
  { key: 'NavToExtSys',     label: 'Nav. sistema ext.' },
  { key: 'PlanningNotes',   label: 'Notas de planificación' },
  { key: 'GotoClick',       label: 'Goto click' },
]

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function groupBy(arr, key) {
  return arr.reduce((acc, row) => {
    const k = row[key] ?? '(sin valor)'
    ;(acc[k] = acc[k] || []).push(row)
    return acc
  }, {})
}

function dayKey(iso) {
  if (!iso) return '?'
  // ISO DateTimeOffset: "2024-05-11T12:00:00Z" or "/Date(...)/"
  if (iso.startsWith('/Date(')) {
    const ms = parseInt(iso.replace(/\/Date\((\d+)[^)]*\)\//, '$1'))
    return new Date(ms).toISOString().slice(0, 10)
  }
  return iso.slice(0, 10)
}

function sumField(arr, key) {
  return arr.reduce((a, r) => a + (Number(r[key]) || 0), 0)
}

function avgField(arr, key) {
  if (!arr.length) return 0
  return sumField(arr, key) / arr.length
}

function formatDuration(val, unit = '') {
  const n = Number(val) || 0
  const u = (unit || '').toLowerCase()
  // Detect milliseconds
  const secs = u.includes('ms') || u.includes('milli') ? n / 1000 : n
  if (secs < 1)  return '<1s'
  if (secs < 60) return `${secs.toFixed(1)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return `${m}m ${s}s`
}

// ─── Session helpers ───────────────────────────────────────────────────────────

function loadCreds(connId) {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY(connId))) || null }
  catch { return null }
}
function saveCreds(connId, creds) {
  localStorage.setItem(STORAGE_KEY(connId), JSON.stringify(creds))
}
function clearCreds(connId) {
  localStorage.removeItem(STORAGE_KEY(connId))
}

// ─── Preset dates ──────────────────────────────────────────────────────────────

function presetDates(id) {
  const now   = new Date()
  const start = new Date(now)
  if (id === 'today') {
    start.setHours(0, 0, 0, 0)
    const end = new Date(now)
    end.setHours(23, 59, 59, 999)
    return [start, end]
  }
  const days = id === '7d' ? 7 : id === '30d' ? 30 : 90
  start.setDate(start.getDate() - days)
  start.setHours(0, 0, 0, 0)
  return [start, now]
}

// ─── Shared UI primitives ──────────────────────────────────────────────────────

function SectionHeader({ icon, title, count }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
      <span style={{ fontSize: 20 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{title}</div>
        {count !== undefined && (
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
            {count === 0 ? 'Sin datos en el período' : `${count.toLocaleString()} registros`}
          </div>
        )}
      </div>
    </div>
  )
}

function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '14px 18px', flex: '1 1 130px',
    }}>
      <div style={{
        fontSize: 20, fontWeight: 800, lineHeight: 1,
        color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function ChartCard({ title, children, style }) {
  return (
    <div style={{
      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '16px 12px 8px', ...style,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: 'var(--text3)',
        textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 12,
      }}>{title}</div>
      {children}
    </div>
  )
}

function SimpleList({ title, items, valueKey }) {
  return (
    <div style={{
      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 16,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: 'var(--text3)',
        textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 12,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {items.map((item, i) => (
          <div key={i} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 12, padding: '7px 0',
            borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none',
          }}>
            <span style={{
              color: 'var(--text)', flex: 1, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 12,
            }}>{item.name}</span>
            <span style={{ color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>
              {item[valueKey]}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Empty() {
  return (
    <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
      Sin datos para el período seleccionado
    </div>
  )
}

// ─── Login inline ──────────────────────────────────────────────────────────────

function MeteringLogin({ connection, onLogin }) {
  const [user,     setUser]     = useState(connection.com0924?.user || '')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!user || !password) { setError('Usuario y contraseña requeridos'); return }
    setLoading(true)
    setError('')
    try {
      const creds   = { user, password }
      const fakeSess = { com0924: creds }
      const res = await proxyCall({
        connection, session: fakeSess, com: '0924',
        path: '/MtrgComponent?$top=1',
      })
      if (res.ok) {
        onLogin(creds)
      } else if (res.status === 401) {
        setError('Usuario o contraseña incorrectos.')
      } else {
        setError(`Error al conectar (${res.status}). Verifica la URL configurada.`)
      }
    } catch {
      setError('No se pudo contactar el servidor.')
    }
    setLoading(false)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: 40,
    }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border2)',
        borderRadius: 14, padding: 36, width: 360,
        boxShadow: '0 12px 32px rgba(0,0,0,.35)',
      }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 6 }}>
          Telemetría de uso
        </div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 28, lineHeight: 1.5 }}>
          Ingresa las credenciales del acuerdo de comunicación de Metering Activity para acceder a los datos de uso del sistema.
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <LoginField label="Usuario" value={user} onChange={setUser} autoComplete="username" mono />
          <LoginField label="Contraseña" value={password} onChange={setPassword} type="password" autoComplete="current-password" />
          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', padding: '8px 12px', background: 'rgba(239,68,68,.08)', borderRadius: 6 }}>
              ✕ {error}
            </div>
          )}
          <button type="submit" disabled={loading} style={{
            marginTop: 4, background: loading ? 'var(--border2)' : 'var(--accent)',
            border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700,
            color: loading ? 'var(--text3)' : '#000', padding: '11px 0',
            cursor: loading ? 'not-allowed' : 'pointer', transition: 'background .15s',
          }}>
            {loading ? 'Verificando…' : 'Conectar →'}
          </button>
        </form>
      </div>
    </div>
  )
}

function LoginField({ label, value, onChange, type = 'text', mono, autoComplete }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{
        fontSize: 10, fontWeight: 700, color: 'var(--text2)',
        textTransform: 'uppercase', letterSpacing: '.07em',
      }}>{label}</label>
      <input
        type={type} value={value} autoComplete={autoComplete}
        onChange={e => onChange(e.target.value)}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--text)', fontFamily: mono ? 'var(--mono)' : 'var(--font)',
          fontSize: 12, padding: '9px 12px', outline: 'none',
        }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e  => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  )
}

// ─── Date filter bar ───────────────────────────────────────────────────────────

function DateFilterBar({ preset, onPreset, from, setFrom, to, setTo, userFilter, setUserFilter, paFilter, setPaFilter, onLoad, loading }) {
  return (
    <div style={{
      background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
      padding: '14px 24px', flexShrink: 0,
    }}>
      {/* Preset pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, fontWeight: 700, color: 'var(--text3)',
          textTransform: 'uppercase', letterSpacing: '.07em', marginRight: 6,
        }}>
          Período
        </span>
        {PRESETS.map(p => {
          const active = preset === p.id
          return (
            <button key={p.id} onClick={() => onPreset(p.id)} style={{
              padding: '5px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              background: active ? 'rgba(99,102,241,.12)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text2)',
              cursor: 'pointer', transition: 'all .15s',
            }}>
              {active && '✓ '}{p.label}
            </button>
          )
        })}
        {preset === 'custom' && (
          <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic', marginLeft: 4 }}>
            Personalizado
          </span>
        )}
      </div>

      {/* Inputs row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <DtField label="Desde" value={from} onChange={v => { setFrom(v); onPreset('custom') }} />
        <DtField label="Hasta"  value={to}   onChange={v => { setTo(v);   onPreset('custom') }} />

        <div style={{ width: 1, height: 32, background: 'var(--border)', alignSelf: 'flex-end', flexShrink: 0 }} />

        <TxtField label="Usuario" value={userFilter} onChange={setUserFilter} placeholder="Filtrar por usuario…" width={150} />
        <TxtField label="Planning Area" value={paFilter} onChange={setPaFilter} placeholder="Filtrar por PA…" width={150} />

        <button onClick={onLoad} disabled={loading} style={{
          alignSelf: 'flex-end', background: loading ? 'var(--border2)' : 'var(--accent)',
          border: 'none', borderRadius: 7, color: loading ? 'var(--text3)' : '#000',
          fontSize: 12, fontWeight: 700, padding: '8px 22px',
          cursor: loading ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
          transition: 'background .15s',
        }}>
          {loading ? 'Cargando…' : 'Cargar datos →'}
        </button>
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
        color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
        padding: '6px 10px', outline: 'none',
      }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e  => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  )
}

function TxtField({ label, value, onChange, placeholder, width }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
        {label}
      </label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--text)', fontSize: 12, padding: '6px 10px', outline: 'none', width,
        }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e  => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  )
}

// ─── Section: Resumen ──────────────────────────────────────────────────────────

function SectionResumen({ overview, userMap, componentMap }) {
  const total      = overview.length
  const uniqueUsers = new Set(overview.map(r => r.UserID)).size
  const uniquePAs   = new Set(overview.map(r => r.PlanningAreaID).filter(Boolean)).size

  const byComponent = groupBy(overview, 'MeteringComponent')
  const dominant    = Object.entries(byComponent).sort((a, b) => b[1].length - a[1].length)[0]

  const pieData = Object.entries(byComponent)
    .map(([k, rows]) => ({ name: componentMap[k] || k || '?', value: rows.length }))
    .sort((a, b) => b.value - a.value)

  // Time series: group by day × component
  const byDay = {}
  overview.forEach(row => {
    const d = dayKey(row.TimestampStart)
    if (!byDay[d]) byDay[d] = { day: d }
    const cn = componentMap[row.MeteringComponent] || row.MeteringComponent || '?'
    byDay[d][cn] = (byDay[d][cn] || 0) + 1
  })
  const timeData = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day))
  const compNames = [...new Set(Object.keys(byComponent).map(c => componentMap[c] || c || '?'))]

  const topUsers = Object.entries(groupBy(overview, 'UserID'))
    .map(([uid, rows]) => ({ name: userMap[uid] || uid, count: rows.length }))
    .sort((a, b) => b.count - a.count).slice(0, 10)

  const topPAs = Object.entries(groupBy(overview.filter(r => r.PlanningAreaID), 'PlanningAreaID'))
    .map(([pa, rows]) => ({ name: pa, count: rows.length }))
    .sort((a, b) => b.count - a.count).slice(0, 6)

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      <SectionHeader icon="📊" title="Resumen de uso" count={total} />
      {total === 0 ? <Empty /> : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <KpiCard label="Actividades registradas" value={total.toLocaleString()} />
            <KpiCard label="Usuarios activos"  value={uniqueUsers} color="var(--accent)" />
            <KpiCard label="Planning Areas"    value={uniquePAs} />
            <KpiCard
              label="Componente principal"
              value={componentMap[dominant?.[0]] || dominant?.[0] || '—'}
              sub={dominant ? `${dominant[1].length} actividades` : undefined}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <ChartCard title="Distribución por componente">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={52} outerRadius={82}
                    dataKey="value" nameKey="name">
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v.toLocaleString(), n]} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Top 10 usuarios">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={topUsers} layout="vertical" margin={{ left: 4, right: 16, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={110}
                    tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="count" fill={CHART_COLORS[0]} name="Actividades"
                    radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {timeData.length > 1 && (
            <ChartCard title="Actividad diaria por componente" style={{ marginBottom: 16 }}>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={timeData} margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="day" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <Tooltip />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
                  {compNames.map((cn, i) => (
                    <Bar key={cn} dataKey={cn} stackId="a"
                      fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {topPAs.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 10 }}>
                Top Planning Areas
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {topPAs.map(({ name, count }) => (
                  <div key={name} style={{
                    background: 'var(--bg)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '7px 14px', fontSize: 12,
                    display: 'flex', gap: 10, alignItems: 'center',
                  }}>
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{name}</span>
                    <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Section: Excel Add-In ─────────────────────────────────────────────────────

function SectionExcel({ planningViews, logons, userMap }) {
  const count   = planningViews.length
  const success = planningViews.filter(r => r.SuccessfullyCompleted).length
  const rate    = count ? Math.round(success / count * 100) : 0
  const unit    = planningViews[0]?.DurationUnit || 's'
  const avgDur  = avgField(planningViews, 'TotalDuration')
  const cells   = sumField(planningViews, 'PlanningViewCells')

  const slowest = [...planningViews]
    .sort((a, b) => Number(b.TotalDuration) - Number(a.TotalDuration))
    .slice(0, 15)

  const logonUnit   = logons[0]?.DurationUnit || 's'
  const avgLogonDur = avgField(logons, 'TotalDuration')

  const rateColor = rate >= 90 ? '#10b981' : rate >= 70 ? '#f59e0b' : '#ef4444'
  const durColor  = Number(avgDur) > 120 ? '#ef4444' : Number(avgDur) > 60 ? '#f59e0b' : '#10b981'

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      <SectionHeader icon="📗" title="Excel Add-In" count={count} />
      {count === 0 ? <Empty /> : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <KpiCard label="Planning views ejecutadas" value={count.toLocaleString()} />
            <KpiCard label="Duración promedio"  value={formatDuration(avgDur, unit)}  color={durColor} />
            <KpiCard label="Tasa de éxito"      value={`${rate}%`}                    color={rateColor} />
            <KpiCard label="Celdas procesadas"  value={cells.toLocaleString()} />
            {logons.length > 0 && (
              <KpiCard
                label="Logons Excel"
                value={logons.length}
                sub={`Prom: ${formatDuration(avgLogonDur, logonUnit)}`}
              />
            )}
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 10 }}>
            Planning views más lentas (top 15)
          </div>
          <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                  {['Usuario', 'Planning Area', 'Favorito / Template', 'Duración', 'Sin interacción', 'Celdas', 'Éxito'].map(h => (
                    <th key={h} style={{
                      padding: '8px 12px', textAlign: 'left', whiteSpace: 'nowrap',
                      color: 'var(--text3)', fontSize: 10, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '.06em',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slowest.map((row, i) => {
                  const dur = Number(row.TotalDuration)
                  const dc  = dur > 120 ? '#ef4444' : dur > 60 ? '#f59e0b' : '#10b981'
                  return (
                    <tr key={row.ActivityID || i} style={{
                      borderBottom: i < slowest.length - 1 ? '1px solid var(--border)' : 'none',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.015)',
                    }}>
                      <td style={{ padding: '8px 12px', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                        {userMap[row.UserID] || row.UserID || '—'}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                        {row.PlanningAreaID || '—'}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>
                        {row.FavoriteName || row.TemplateName || row.WorksheetName || '—'}
                      </td>
                      <td style={{ padding: '8px 12px', color: dc, fontFamily: 'var(--mono)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {formatDuration(row.TotalDuration, row.DurationUnit)}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {formatDuration(row.DurationWithoutUserInteraction, row.DurationUnit)}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                        {Number(row.PlanningViewCells).toLocaleString()}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{
                          fontSize: 11, fontWeight: 700,
                          color: row.SuccessfullyCompleted ? '#10b981' : '#ef4444',
                        }}>
                          {row.SuccessfullyCompleted ? '✓ Sí' : '✕ No'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Section: Adopción ─────────────────────────────────────────────────────────

function SectionAdopcion({ fiori, dashboards, stories, alerts }) {
  const noData = !fiori.length && !dashboards.length && !stories.length && !alerts.length

  const fioriData = Object.entries(groupBy(fiori, 'FioriProjectTitle'))
    .map(([name, rows]) => ({
      name: name || rows[0]?.FioriProjectID || '?',
      value: sumField(rows, 'ActivityCount') || rows.length,
    }))
    .sort((a, b) => b.value - a.value).slice(0, 10)

  const dashData = Object.entries(groupBy(dashboards, 'DashboardName'))
    .map(([name, rows]) => ({ name: name || '?', count: rows.length }))
    .sort((a, b) => b.count - a.count).slice(0, 8)

  const storyData = Object.entries(groupBy(stories, 'StoryName'))
    .map(([name, rows]) => ({ name: name || '?', count: rows.length }))
    .sort((a, b) => b.count - a.count).slice(0, 8)

  const alertData = ALERT_ACTIONS
    .map(({ key, label }) => ({ label, value: sumField(alerts, key) }))
    .filter(a => a.value > 0)
    .sort((a, b) => b.value - a.value)

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      <SectionHeader icon="🌐" title="Adopción Fiori & Dashboards" />
      {noData ? <Empty /> : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {fioriData.length > 0 && (
            <ChartCard title={`Apps Fiori — top ${fioriData.length}`}>
              <ResponsiveContainer width="100%" height={Math.max(160, fioriData.length * 28)}>
                <BarChart data={fioriData} layout="vertical" margin={{ left: 4, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={130}
                    tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="value" fill={CHART_COLORS[2]} name="Usos"
                    radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {alertData.length > 0 && (
            <ChartCard title="Alert Monitor — acciones">
              <ResponsiveContainer width="100%" height={Math.max(160, alertData.length * 28)}>
                <BarChart data={alertData} layout="vertical" margin={{ left: 4, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis type="category" dataKey="label" width={130}
                    tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="value" fill={CHART_COLORS[3]} name="Veces"
                    radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {dashData.length > 0 && (
            <SimpleList title="Dashboards más vistos" items={dashData} valueKey="count" />
          )}

          {storyData.length > 0 && (
            <SimpleList title="Analytic Stories más usadas" items={storyData} valueKey="count" />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main export ───────────────────────────────────────────────────────────────

export default function Metering({ connection }) {
  const [creds, setCreds] = useState(() => loadCreds(connection.id))

  // Date filter state — default 7 días
  const [preset, setPreset] = useState('7d')
  const [from, setFrom] = useState(() => {
    const [s] = presetDates('7d')
    return toInputDate(s, getTzMode())
  })
  const [to, setTo] = useState(() => {
    const [, e] = presetDates('7d')
    return toInputDate(e, getTzMode())
  })
  const [userFilter, setUserFilter] = useState('')
  const [paFilter,   setPaFilter]   = useState('')

  // Data state
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [loaded,  setLoaded]  = useState(false)

  // Keep mutable refs to current from/to so the load function always reads latest
  const fromRef = useRef(from)
  const toRef   = useRef(to)
  fromRef.current = from
  toRef.current   = to

  function handleLogin(newCreds) {
    saveCreds(connection.id, newCreds)
    setCreds(newCreds)
  }

  function handleLogout() {
    clearCreds(connection.id)
    setCreds(null)
    setData(null)
    setLoaded(false)
    setError('')
  }

  function handlePreset(id) {
    setPreset(id)
    if (id !== 'custom') {
      const [s, e] = presetDates(id)
      const tz = getTzMode()
      setFrom(toInputDate(s, tz))
      setTo(toInputDate(e, tz))
    }
  }

  async function loadData() {
    if (!creds) return
    setLoading(true)
    setError('')

    const tz       = getTzMode()
    const fromDate = inputDateToDate(fromRef.current, tz)
    const toDate   = inputDateToDate(toRef.current,   tz)
    const fakeSess = { com0924: creds }

    const call = async (path) => {
      const res = await proxyCall({ connection, session: fakeSess, com: '0924', path })
      if (!res.ok) {
        if (res.status === 401) throw new Error('401')
        throw new Error(`HTTP ${res.status}`)
      }
      return parseV4(await res.json())
    }

    const dateFilter  = buildDateFilter(fromDate, toDate)
    const groupFilter = buildDateFilter(fromDate, toDate, 'TimestampStart')

    try {
      const [overview, planningViews, logons, fiori, dashboards, stories, alerts, users, components] =
        await Promise.all([
          call(buildPath('MtrgActyGroupOverview',          { filter: groupFilter })),
          call(buildPath('MtrgActyExcelAddInPlanningView', { filter: dateFilter, orderby: 'TotalDuration desc' })),
          call(buildPath('MtrgActyExcelAddInLogon',        { filter: dateFilter })),
          call(buildPath('MtrgGenericUIActionUsage',       { filter: dateFilter })),
          call(buildPath('MtrgDashboard',                  { filter: dateFilter })),
          call(buildPath('MtrgMngAnalyticStory',           { filter: dateFilter })),
          call(buildPath('MtrgActyAlertMonitor',           { filter: dateFilter })),
          call('/MtrgActyBusinessUser?$top=1000'),
          call('/MtrgComponent'),
        ])
      setData({ overview, planningViews, logons, fiori, dashboards, stories, alerts, users, components })
      setLoaded(true)
    } catch (e) {
      if (e.message === '401') {
        setError('Sesión expirada o credenciales incorrectas.')
      } else {
        setError(`Error al cargar datos: ${e.message}`)
      }
    }
    setLoading(false)
  }

  // Auto-load on mount when creds are available
  useEffect(() => {
    if (creds) loadData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!creds) return <MeteringLogin connection={connection} onLogin={handleLogin} />

  // Build lookup maps
  const userMap = useMemo(() => {
    if (!data) return {}
    return Object.fromEntries(
      data.users.map(u => [
        u.UserID,
        u.FullName || [u.FirstName, u.LastName].filter(Boolean).join(' ') || u.UserID,
      ])
    )
  }, [data])

  const componentMap = useMemo(() => {
    if (!data) return {}
    return Object.fromEntries(
      data.components.map(c => [c.MeteringComponent, c.MeteringComponentText || c.MeteringComponent])
    )
  }, [data])

  // Apply client-side filters
  const filteredOverview = useMemo(() => {
    if (!data) return []
    return data.overview.filter(r =>
      (!userFilter || (r.UserID || '').toLowerCase().includes(userFilter.toLowerCase())) &&
      (!paFilter   || (r.PlanningAreaID || '').toLowerCase().includes(paFilter.toLowerCase()))
    )
  }, [data, userFilter, paFilter])

  const filteredPlanningViews = useMemo(() => {
    if (!data) return []
    return data.planningViews.filter(r =>
      (!userFilter || (r.UserID || '').toLowerCase().includes(userFilter.toLowerCase())) &&
      (!paFilter   || (r.PlanningAreaID || '').toLowerCase().includes(paFilter.toLowerCase()))
    )
  }, [data, userFilter, paFilter])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <DateFilterBar
        preset={preset}       onPreset={handlePreset}
        from={from}           setFrom={setFrom}
        to={to}               setTo={setTo}
        userFilter={userFilter} setUserFilter={setUserFilter}
        paFilter={paFilter}   setPaFilter={setPaFilter}
        onLoad={loadData}     loading={loading}
      />

      {error && (
        <div style={{
          padding: '10px 24px', background: 'rgba(239,68,68,.08)',
          borderBottom: '1px solid rgba(239,68,68,.25)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 12, color: 'var(--red)' }}>✕ {error}</span>
          {error.includes('Sesión') && (
            <button onClick={handleLogout} style={{
              fontSize: 11, color: 'var(--accent)', background: 'none',
              border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0,
            }}>
              Cerrar sesión →
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!loaded && !loading && !error && (
          <div style={{ padding: 56, textAlign: 'center', color: 'var(--text2)', fontSize: 13, lineHeight: 1.6 }}>
            Selecciona un período y haz clic en <strong style={{ color: 'var(--text)' }}>Cargar datos →</strong> para ver la telemetría de uso.
          </div>
        )}

        {loading && !loaded && (
          <div style={{ padding: 56, textAlign: 'center', color: 'var(--text2)', fontSize: 13 }}>
            Cargando datos de telemetría…
          </div>
        )}

        {loaded && data && (
          <>
            <SectionResumen
              overview={filteredOverview}
              userMap={userMap}
              componentMap={componentMap}
            />
            <div style={{ height: 1, background: 'var(--border)', margin: '0 24px' }} />
            <SectionExcel
              planningViews={filteredPlanningViews}
              logons={data.logons}
              userMap={userMap}
            />
            <div style={{ height: 1, background: 'var(--border)', margin: '0 24px' }} />
            <SectionAdopcion
              fiori={data.fiori}
              dashboards={data.dashboards}
              stories={data.stories}
              alerts={data.alerts}
            />
            <div style={{ padding: '16px 24px 32px', textAlign: 'right' }}>
              <button onClick={handleLogout} style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                color: 'var(--text3)', fontSize: 11, padding: '5px 14px', cursor: 'pointer',
              }}>
                Cerrar sesión de Telemetría
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
