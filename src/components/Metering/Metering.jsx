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
  { id: 'general', label: 'Visión General' },
  { id: 'excel',   label: 'Excel Add-In'  },
  { id: 'apps',    label: 'Herramientas'  },
]

const COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#8b5cf6',
]

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

// ─── Context selector ─────────────────────────────────────────────────────────

function ContextSelector({ mode, value, onModeChange, onValueChange, users, planningAreas, userMap }) {
  const [open,   setOpen]   = useState(null) // null | 'user' | 'pa'
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function handle(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(null) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const userList = useMemo(() => {
    const q = search.toLowerCase()
    return users
      .filter(u => !q || (u.UserID || '').toLowerCase().includes(q) || (userMap[u.UserID] || '').toLowerCase().includes(q))
      .slice(0, 60)
  }, [users, search, userMap])

  const paList = useMemo(() =>
    planningAreas.filter(pa => !search || pa.toLowerCase().includes(search.toLowerCase())).slice(0, 60),
    [planningAreas, search])

  function selectUser(uid) { onModeChange('user'); onValueChange(uid); setOpen(null); setSearch('') }
  function selectPA(pa)    { onModeChange('pa');   onValueChange(pa);  setOpen(null); setSearch('') }
  function openDropdown(type) { setSearch(''); setOpen(open === type ? null : type) }

  const btnBase = { padding: '4px 14px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all .15s' }

  return (
    <div ref={ref} style={{
      background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
      padding: '8px 24px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, position: 'relative',
    }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.07em', marginRight: 4 }}>
        Contexto
      </span>

      <button onClick={() => { onModeChange('all'); onValueChange(''); setOpen(null) }} style={{
        ...btnBase,
        border: `1.5px solid ${mode === 'all' ? 'var(--accent)' : 'var(--border)'}`,
        background: mode === 'all' ? 'rgba(247,168,0,.10)' : 'transparent',
        color: mode === 'all' ? 'var(--accent)' : 'var(--text2)',
      }}>Todos</button>

      <button onClick={() => openDropdown('user')} style={{
        ...btnBase,
        border: `1.5px solid ${mode === 'user' ? 'var(--cyan)' : open === 'user' ? 'var(--border2)' : 'var(--border)'}`,
        background: mode === 'user' ? 'rgba(41,171,226,.10)' : 'transparent',
        color: mode === 'user' ? 'var(--cyan)' : 'var(--text2)',
        maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {mode === 'user' && value ? `Usuario · ${userMap[value] || value}` : 'Usuario ▾'}
      </button>

      <button onClick={() => openDropdown('pa')} style={{
        ...btnBase,
        border: `1.5px solid ${mode === 'pa' ? 'var(--purple)' : open === 'pa' ? 'var(--border2)' : 'var(--border)'}`,
        background: mode === 'pa' ? 'rgba(167,139,250,.10)' : 'transparent',
        color: mode === 'pa' ? 'var(--purple)' : 'var(--text2)',
        maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {mode === 'pa' && value ? `Planning Area · ${value}` : 'Planning Area ▾'}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 24, zIndex: 200,
          background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,.5)', minWidth: 280, maxHeight: 360,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <input
              autoFocus value={search} onChange={e => setSearch(e.target.value)}
              placeholder={open === 'user' ? 'Buscar usuario…' : 'Buscar planning area…'}
              style={{
                width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '6px 10px', outline: 'none',
              }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e  => e.target.style.borderColor = 'var(--border)'}
            />
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {open === 'user' && userList.map(u => {
              const name = userMap[u.UserID] || u.UserID
              const active = value === u.UserID
              return (
                <button key={u.UserID} onClick={() => selectUser(u.UserID)} style={{
                  width: '100%', background: active ? 'rgba(41,171,226,.10)' : 'none',
                  border: 'none', borderBottom: '1px solid var(--border)', padding: '8px 12px',
                  textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 1,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: active ? 'var(--cyan)' : 'var(--text)' }}>{name}</span>
                  {name !== u.UserID && (
                    <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{u.UserID}</span>
                  )}
                </button>
              )
            })}
            {open === 'pa' && paList.map(pa => {
              const active = value === pa
              return (
                <button key={pa} onClick={() => selectPA(pa)} style={{
                  width: '100%', background: active ? 'rgba(167,139,250,.10)' : 'none',
                  border: 'none', borderBottom: '1px solid var(--border)', padding: '8px 12px',
                  textAlign: 'left', cursor: 'pointer', fontSize: 11,
                  fontFamily: 'var(--mono)', color: active ? 'var(--purple)' : 'var(--text)',
                }}>{pa}</button>
              )
            })}
            {open === 'user' && !userList.length && (
              <div style={{ padding: 12, fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>Sin usuarios</div>
            )}
            {open === 'pa' && !paList.length && (
              <div style={{ padding: 12, fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>Sin planning areas</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── User profile (sub-view of Tab General) ───────────────────────────────────

function UserProfile({ uid, overview, planningViews, logons, fiori, dashboards, stories, alerts, userMap }) {
  const name = userMap[uid] || uid

  const actByDay = useMemo(() => {
    const byDay = {}
    overview.forEach(r => {
      const d = dayKey(r.TimestampStart)
      byDay[d] = (byDay[d] || 0) + 1
    })
    return Object.entries(byDay).map(([day, n]) => ({ day, Ventanas: n })).sort((a, b) => a.day.localeCompare(b.day))
  }, [overview])

  const uniquePAs = useMemo(() =>
    [...new Set(overview.map(r => r.PlanningAreaID).filter(Boolean))].sort(),
    [overview])

  const toolsUsed = useMemo(() => {
    const fioriOtros = fiori.filter(r => !r.FioriProjectID?.startsWith('tl.ibp.excel.addin.'))
    const rows = []
    if (planningViews.length) rows.push({ name: 'Excel Add-In', count: planningViews.length })
    Object.entries(groupBy(fioriOtros, r => r.FioriProjectTitle || r.FioriProjectID))
      .forEach(([n, rs]) => rows.push({ name: n, count: rs.length }))
    if (dashboards.length)  rows.push({ name: 'Dashboards', count: dashboards.length })
    if (stories.length)     rows.push({ name: 'Analytics Stories', count: stories.length })
    if (alerts.length)      rows.push({ name: 'Alert Monitor', count: alerts.length })
    if (logons.length)      rows.push({ name: 'Logon Excel', count: logons.length })
    return rows.sort((a, b) => b.count - a.count)
  }, [planningViews, fiori, dashboards, stories, alerts, logons])

  const dates    = overview.map(r => r.TimestampStart).filter(Boolean).sort()
  const firstSeen = dates[0]?.slice(0, 10) || '—'
  const lastSeen  = dates.slice(-1)[0]?.slice(0, 10) || '—'
  const unit      = planningViews[0]?.DurationUnit || 's'
  const excelRate = planningViews.length
    ? Math.round(planningViews.filter(r => r.SuccessfullyCompleted).length / planningViews.length * 100)
    : null
  const avgDur = avgField(planningViews, 'TotalDuration')

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 12,
        padding: '20px 24px', marginBottom: 24, display: 'flex', alignItems: 'flex-start', gap: 20,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: 'rgba(41,171,226,.15)', border: '2px solid rgba(41,171,226,.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 700, color: 'var(--cyan)', flexShrink: 0,
        }}>
          {(name[0] || uid[0] || '?').toUpperCase()}
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>{name !== uid ? name : '—'}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{uid}</div>
          {firstSeen !== '—' && (
            <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6 }}>
              Primera actividad: {firstSeen} · Última: {lastSeen}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <KpiCard label="Ventanas abiertas" value={overview.length} color="var(--accent)" />
        <KpiCard label="Planning Areas"    value={uniquePAs.length} />
        {excelRate !== null && <>
          <KpiCard label="Ops Excel" value={planningViews.length} />
          <KpiCard label="Éxito Excel" value={`${excelRate}%`}
            color={excelRate >= 90 ? '#10b981' : excelRate >= 70 ? '#f59e0b' : '#ef4444'}
            warning={excelRate < 70}
          />
          <KpiCard label="Duración prom." value={formatDuration(avgDur, unit)} />
        </>}
      </div>

      {actByDay.length > 1 && (
        <ChartCard title="Actividad diaria (ventanas)" style={{ marginBottom: 24 }}>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={actByDay} margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 10 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="Ventanas" fill="var(--cyan)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {uniquePAs.length > 0 && (
          <div>
            <BlockTitle text={`Planning Areas (${uniquePAs.length})`} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {uniquePAs.map(pa => (
                <span key={pa} style={{
                  padding: '3px 10px', borderRadius: 20, fontSize: 11,
                  background: 'rgba(167,139,250,.10)', border: '1px solid rgba(167,139,250,.25)',
                  color: 'var(--purple)', fontFamily: 'var(--mono)',
                }}>{pa}</span>
              ))}
            </div>
          </div>
        )}
        {toolsUsed.length > 0 && (
          <div>
            <BlockTitle text="Herramientas utilizadas" />
            <DataTable
              columns={[
                { key: 'name',  label: 'Herramienta' },
                { key: 'count', label: 'Acciones', align: 'right', mono: true },
              ]}
              rows={toolsUsed}
            />
          </div>
        )}
      </div>

      {overview.length === 0 && <EmptyState msg="Este usuario no tuvo actividad en el período seleccionado" />}
    </div>
  )
}

// ─── PA profile (sub-view of Tab General) ─────────────────────────────────────

function PAProfile({ pa, overview, planningViews, fiori, dashboards, userMap }) {
  const activeUsers = useMemo(() => {
    const all = [...overview, ...planningViews, ...fiori, ...dashboards]
    return [...new Set(all.map(r => r.UserID).filter(Boolean))]
  }, [overview, planningViews, fiori, dashboards])

  const topUsers = useMemo(() => {
    const combined = [...overview, ...planningViews, ...fiori, ...dashboards]
    return Object.entries(groupBy(combined, 'UserID'))
      .filter(([uid]) => uid && uid !== '(sin valor)')
      .map(([uid, rows]) => ({ uid, name: userMap[uid] || uid, acts: rows.length }))
      .sort((a, b) => b.acts - a.acts)
      .slice(0, 15)
  }, [overview, planningViews, fiori, dashboards, userMap])

  const excelByDay = useMemo(() => {
    const byDay = groupBy(planningViews, r => dayKey(r.Timestamp || r.TimestampStart))
    return Object.entries(byDay)
      .map(([day, rows]) => {
        const ok = rows.filter(r => r.SuccessfullyCompleted).length
        return { day, Operaciones: rows.length, 'Éxito %': Math.round(ok / rows.length * 100) }
      })
      .sort((a, b) => a.day.localeCompare(b.day))
  }, [planningViews])

  const unit      = planningViews[0]?.DurationUnit || 's'
  const excelRate = planningViews.length
    ? Math.round(planningViews.filter(r => r.SuccessfullyCompleted).length / planningViews.length * 100)
    : null
  const avgDur = avgField(planningViews, 'TotalDuration')

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 12,
        padding: '20px 24px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 20,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 10,
          background: 'rgba(167,139,250,.15)', border: '2px solid rgba(167,139,250,.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700, color: 'var(--purple)', fontFamily: 'var(--mono)', flexShrink: 0,
        }}>PA</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', fontFamily: 'var(--mono)' }}>{pa}</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>Planning Area</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <KpiCard label="Usuarios activos" value={activeUsers.length} color="var(--accent)" />
        {excelRate !== null && <>
          <KpiCard label="Ops Excel" value={planningViews.length} />
          <KpiCard label="Éxito Excel" value={`${excelRate}%`}
            color={excelRate >= 90 ? '#10b981' : excelRate >= 70 ? '#f59e0b' : '#ef4444'}
            warning={excelRate < 70}
          />
          <KpiCard label="Duración prom." value={formatDuration(avgDur, unit)} />
        </>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {topUsers.length > 0 && (
          <div>
            <BlockTitle text="Usuarios activos en esta PA" />
            <DataTable
              columns={[
                { key: 'name', label: 'Usuario' },
                { key: 'uid',  label: 'ID', mono: true, color: () => 'var(--text3)' },
                { key: 'acts', label: 'Acciones', align: 'right', mono: true },
              ]}
              rows={topUsers} maxRows={10}
            />
          </div>
        )}
        {excelByDay.length > 1 && (
          <div>
            <BlockTitle text="Excel — tendencia diaria" />
            <ChartCard>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={excelByDay} margin={{ left: 0, right: 32, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="day" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis yAxisId="ops" tick={{ fill: 'var(--text2)', fontSize: 10 }} allowDecimals={false} />
                  <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <Tooltip formatter={(v, n) => n === 'Éxito %' ? `${v}%` : v} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
                  <Bar  yAxisId="ops" dataKey="Operaciones" fill={COLORS[0]} radius={[3, 3, 0, 0]} />
                  <Line yAxisId="pct" dataKey="Éxito %"     stroke={COLORS[1]} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        )}
      </div>

      {activeUsers.length === 0 && <EmptyState msg="Sin actividad en esta Planning Area para el período seleccionado" />}
    </div>
  )
}

// ─── Tab 1: Visión General ────────────────────────────────────────────────────

function TabGeneral({ overview, planningViews, logons, fiori, dashboards, stories, alerts, users, userMap, componentMap, contextMode, contextValue }) {
  // ALL hooks must be declared before any conditional return
  const [search, setSearch] = useState('')

  const activeUserIds = useMemo(() =>
    new Set(overview.map(r => r.UserID).filter(Boolean)),
    [overview])

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

  const componentChartData = useMemo(() => {
    const byDay = {}
    overview.forEach(row => {
      const d = dayKey(row.TimestampStart)
      if (!byDay[d]) byDay[d] = {}
      const comp = componentMap[row.MeteringComponent] || row.MeteringComponent
      if (!comp) return
      byDay[d][comp] = (byDay[d][comp] || 0) + (Number(row.NumberOfActions) || 1)
    })
    return Object.entries(byDay)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, comps]) => ({ day, ...comps }))
  }, [overview, componentMap])

  const componentNames = useMemo(() => {
    const names = new Set()
    componentChartData.forEach(d => Object.keys(d).forEach(k => { if (k !== 'day') names.add(k) }))
    return [...names]
  }, [componentChartData])

  const fioriOtros = useMemo(() =>
    fiori.filter(r => !r.FioriProjectID?.startsWith('tl.ibp.excel.addin.')),
    [fiori])

  const featureRows = useMemo(() => {
    const fioriByApp = groupBy(fioriOtros, r => r.FioriProjectTitle || r.FioriProjectID)
    const rows = []
    if (planningViews.length)
      rows.push({ name: 'Excel Add-In', users: uniqueUsers(planningViews), sessions: planningViews.length })
    Object.entries(fioriByApp).forEach(([name, rs]) =>
      rows.push({ name, users: uniqueUsers(rs), sessions: rs.length }))
    if (dashboards.length)
      rows.push({ name: 'Dashboards', users: uniqueUsers(dashboards), sessions: dashboards.length })
    if (stories.length)
      rows.push({ name: 'Analytics Stories', users: uniqueUsers(stories), sessions: stories.length })
    if (alerts.length)
      rows.push({ name: 'Alert Monitor', users: uniqueUsers(alerts), sessions: alerts.length })
    return rows.sort((a, b) => b.users - a.users)
  }, [planningViews, fioriOtros, dashboards, stories, alerts])

  const topActiveUsers = useMemo(() => {
    return Object.entries(groupBy(overview, 'UserID'))
      .filter(([uid]) => uid && uid !== '(sin valor)')
      .map(([uid, rows]) => {
        const last = rows.map(r => r.TimestampStart).filter(Boolean).sort().reverse()[0]
        const pas  = [...new Set(rows.map(r => r.PlanningAreaID).filter(Boolean))]
        return { uid, name: userMap[uid] || uid, acts: rows.length, last: last ? last.slice(0, 10) : '—', pas: pas.slice(0, 3).join(', ') || '—' }
      })
      .sort((a, b) => b.acts - a.acts)
      .slice(0, 15)
  }, [overview, userMap])

  const inactiveUsers = useMemo(() => {
    const q = search.toLowerCase()
    return users
      .filter(u => u.UserID && !activeUserIds.has(u.UserID))
      .map(u => ({ uid: u.UserID, name: userMap[u.UserID] || [u.FirstName, u.LastName].filter(Boolean).join(' ') || u.UserID }))
      .filter(u => !q || u.uid.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
      .sort((a, b) => a.uid.localeCompare(b.uid))
  }, [users, activeUserIds, userMap, search])

  const attention = useMemo(() => {
    const items = []
    const ic = users.filter(u => u.UserID && !activeUserIds.has(u.UserID)).length
    if (ic > 0)
      items.push({ type: 'warn', msg: `${ic} usuario${ic > 1 ? 's' : ''} licenciado${ic > 1 ? 's' : ''} sin actividad en el período` })
    const pvByPA = groupBy(planningViews.filter(r => r.PlanningAreaID), 'PlanningAreaID')
    Object.entries(pvByPA).forEach(([pa, rows]) => {
      const errRate = rows.filter(r => !r.SuccessfullyCompleted).length / rows.length * 100
      if (errRate > 30 && rows.length >= 5)
        items.push({ type: 'error', msg: `PA ${pa}: ${Math.round(errRate)}% de errores en Excel (${rows.length} ops)` })
    })
    return items
  }, [users, activeUserIds, planningViews])

  // Derived (no hooks)
  const totalLicensed = users.length
  const totalActive   = activeUserIds.size
  const adoptionRate  = totalLicensed > 0 ? Math.round(totalActive / totalLicensed * 100) : 0
  const uniquePAs     = new Set(overview.map(r => r.PlanningAreaID).filter(Boolean)).size
  const inactiveCount = totalLicensed - totalActive
  const rateColor     = adoptionRate >= 70 ? '#10b981' : adoptionRate >= 40 ? '#f59e0b' : '#ef4444'

  // Conditional renders — safe: all hooks already called
  if (contextMode === 'user' && contextValue) {
    return (
      <UserProfile
        uid={contextValue} overview={overview} planningViews={planningViews}
        logons={logons} fiori={fiori} dashboards={dashboards}
        stories={stories} alerts={alerts} userMap={userMap}
      />
    )
  }

  if (contextMode === 'pa' && contextValue) {
    return (
      <PAProfile
        pa={contextValue} overview={overview} planningViews={planningViews}
        fiori={fiori} dashboards={dashboards} userMap={userMap}
      />
    )
  }

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      {attention.length > 0 && (
        <div style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {attention.map((a, i) => (
            <div key={i} style={{
              padding: '8px 14px', borderRadius: 8, fontSize: 12,
              background: a.type === 'error' ? 'rgba(239,68,68,.08)' : 'rgba(247,168,0,.08)',
              border: `1px solid ${a.type === 'error' ? 'rgba(239,68,68,.25)' : 'rgba(247,168,0,.25)'}`,
              color: a.type === 'error' ? 'var(--red)' : 'var(--accent)',
            }}>
              {a.type === 'error' ? '⚠ ' : '○ '}{a.msg}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <KpiCard label="Tasa de adopción" value={`${adoptionRate}%`}
          sub={`${totalActive} activos de ${totalLicensed} licenciados`}
          color={rateColor} warning={adoptionRate < 40} />
        <KpiCard label="Usuarios activos"       value={totalActive}   color="var(--accent)" />
        <KpiCard label="Total licenciados"       value={totalLicensed} />
        <KpiCard label="Sin actividad"           value={inactiveCount}
          sub={inactiveCount > 0 ? 'Licencias sin uso en el período' : undefined}
          color={inactiveCount > 0 ? '#ef4444' : 'var(--text)'} warning={inactiveCount > 0} />
        <KpiCard label="Planning Areas activas" value={uniquePAs} />
      </div>

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

      {componentNames.length > 0 && componentChartData.length > 1 && (
        <ChartCard title="Actividad por componente (acciones por día)" style={{ marginBottom: 24 }}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={componentChartData} margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
              <YAxis tick={{ fill: 'var(--text2)', fontSize: 10 }} allowDecimals={false} />
              <Tooltip />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
              {componentNames.map((name, i) => (
                <Bar key={name} dataKey={name} stackId="a" fill={COLORS[i % COLORS.length]}
                  radius={i === componentNames.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {featureRows.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <BlockTitle text="Adopción por herramienta" />
          <DataTable
            columns={[
              { key: 'name',     label: 'Herramienta' },
              { key: 'users',    label: 'Usuarios únicos', align: 'right', mono: true,
                render: r => r.users.toLocaleString() },
              { key: 'pct',      label: '% usuarios activos', align: 'right',
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {topActiveUsers.length > 0 && (
          <div>
            <BlockTitle text="Usuarios más activos" />
            <DataTable
              columns={[
                { key: 'name', label: 'Usuario' },
                { key: 'acts', label: 'Ventanas',      align: 'right', mono: true },
                { key: 'last', label: 'Último',        mono: true, nowrap: true },
                { key: 'pas',  label: 'Planning Areas', color: () => 'var(--text2)' },
              ]}
              rows={topActiveUsers} maxRows={10}
            />
          </div>
        )}
        <div>
          <BlockTitle text="Sin actividad en el período" count={inactiveCount} />
          {inactiveCount === 0 ? (
            <div style={{ padding: '14px 0', fontSize: 12, color: '#10b981' }}>
              ✓ Todos los usuarios licenciados tuvieron actividad
            </div>
          ) : (
            <>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
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
                  { key: 'uid',  label: 'Usuario', mono: true },
                  { key: 'name', label: 'Nombre',  color: () => 'var(--text2)' },
                ]}
                rows={inactiveUsers} maxRows={20}
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
  const [subtab, setSubtab] = useState('slow')

  const total   = planningViews.length
  const success = planningViews.filter(r => r.SuccessfullyCompleted).length
  const failed  = total - success
  const rate    = total ? Math.round(success / total * 100) : 0
  const unit    = planningViews[0]?.DurationUnit || 's'
  const avgDur  = avgField(planningViews, 'TotalDuration')
  const cells   = sumField(planningViews, 'PlanningViewCells')
  const logonUnit   = logons[0]?.DurationUnit || 's'
  const avgLogonDur = avgField(logons, 'TotalDuration')
  const rateColor   = rate >= 90 ? '#10b981' : rate >= 70 ? '#f59e0b' : '#ef4444'
  const durColor    = toSecs(avgDur, unit) > 120 ? '#ef4444' : toSecs(avgDur, unit) > 60 ? '#f59e0b' : '#10b981'

  const actTypeData = useMemo(() => {
    if (!total) return []
    return Object.entries(groupBy(planningViews, 'ActivityType'))
      .map(([type, rows]) => ({
        tipo: type.replace(/^XLS_/, '').replace(/_/g, ' '),
        count: rows.length,
        pct: Math.round(rows.length / total * 100),
      }))
      .sort((a, b) => b.count - a.count)
  }, [planningViews, total])

  const trendData = useMemo(() => {
    return Object.entries(groupBy(planningViews, r => dayKey(r.Timestamp || r.TimestampStart)))
      .map(([day, rows]) => {
        const ok  = rows.filter(r => r.SuccessfullyCompleted).length
        const avg = toSecs(avgField(rows, 'TotalDuration'), unit)
        return { day, 'Éxito %': Math.round(ok / rows.length * 100), 'Duración (s)': parseFloat(avg.toFixed(1)) }
      })
      .sort((a, b) => a.day.localeCompare(b.day))
  }, [planningViews, unit])

  const paPerf = useMemo(() => {
    return Object.entries(groupBy(planningViews.filter(r => r.PlanningAreaID), 'PlanningAreaID'))
      .map(([pa, rows]) => {
        const ok = rows.filter(r => r.SuccessfullyCompleted).length
        return { pa, total: rows.length, rate: Math.round(ok / rows.length * 100), avgDur: parseFloat(toSecs(avgField(rows, 'TotalDuration'), unit).toFixed(1)) }
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
  }, [planningViews, unit])

  const topChgKF = useMemo(() => {
    return Object.entries(groupBy(chgKeyFig, 'KeyFigureID'))
      .map(([kf, rows]) => ({
        kf,
        cambios: sumField(rows, 'KeyFigureCount') || rows.length,
        usuarios: uniqueUsers(rows),
      }))
      .sort((a, b) => b.cambios - a.cambios)
      .slice(0, 15)
  }, [chgKeyFig])

  const slowRows = useMemo(() =>
    [...planningViews].sort((a, b) => Number(b.TotalDuration) - Number(a.TotalDuration)).slice(0, 20),
    [planningViews])

  const failRows = useMemo(() =>
    planningViews.filter(r => !r.SuccessfullyCompleted).slice(0, 20),
    [planningViews])

  const pvCols = [
    { key: 'user',      label: 'Usuario',        render: r => userMap[r.UserID] || r.UserID || '—' },
    { key: 'pa',        label: 'PA',             render: r => r.PlanningAreaID || '—', mono: true },
    { key: 'template',  label: 'Template',       render: r => r.TemplateName || r.FavoriteName || r.WorksheetName || '—', color: () => 'var(--text2)' },
    { key: 'dur',       label: 'Tiempo total',   nowrap: true, mono: true,
      render: r => formatDuration(r.TotalDuration, r.DurationUnit),
      color: r => { const s = toSecs(r.TotalDuration, r.DurationUnit); return s > 120 ? '#ef4444' : s > 60 ? '#f59e0b' : '#10b981' } },
    { key: 'sap',       label: 'Tiempo SAP',     nowrap: true, mono: true,
      render: r => formatDuration(r.DurationWithoutUserInteraction, r.DurationUnit),
      color: () => 'var(--text3)' },
    { key: 'usr',       label: 'Tiempo usuario', nowrap: true, mono: true,
      render: r => {
        const total = Number(r.TotalDuration) || 0
        const sap   = Number(r.DurationWithoutUserInteraction) || 0
        return formatDuration(Math.max(0, total - sap), r.DurationUnit)
      },
      color: () => 'var(--text2)' },
    { key: 'cells',     label: 'Celdas',         align: 'right', mono: true,
      render: r => Number(r.PlanningViewCells).toLocaleString() },
  ]

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      {total === 0 ? <EmptyState /> : (
        <>
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

          <Note text="Tiempo total = duración completa de la operación. Tiempo SAP = procesamiento puro del servidor. Tiempo usuario = interacción / espera del usuario." />

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

          {trendData.length > 1 && (
            <ChartCard title="Tendencia diaria — éxito y duración" style={{ marginBottom: 24 }}>
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

          {paPerf.length > 0 && (
            <ChartCard title="Rendimiento por Planning Area (top 10)" style={{ marginBottom: 24 }}>
              <ResponsiveContainer width="100%" height={Math.max(160, paPerf.length * 30)}>
                <BarChart data={paPerf} layout="vertical" margin={{ left: 4, right: 56, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <YAxis type="category" dataKey="pa" width={90} tick={{ fill: 'var(--text2)', fontSize: 10 }} />
                  <Tooltip formatter={(v, n) => n === 'Éxito %' ? `${v}%` : n === 'Dur. prom (s)' ? `${v}s` : v} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="total"  fill={COLORS[0]} name="Operaciones"   radius={[0, 3, 3, 0]} />
                  <Bar dataKey="avgDur" fill={COLORS[2]} name="Dur. prom (s)" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {topChgKF.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <BlockTitle text="Key figures más modificados" count={topChgKF.length} />
              <DataTable
                columns={[
                  { key: 'kf',       label: 'Key Figure',      mono: true },
                  { key: 'cambios',  label: 'Cambios totales', align: 'right', mono: true, render: r => r.cambios.toLocaleString() },
                  { key: 'usuarios', label: 'Usuarios',        align: 'right', mono: true },
                ]}
                rows={topChgKF}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 0, marginBottom: 12 }}>
            {[['slow', `Más lentas (${slowRows.length})`], ['errors', `Errores (${failRows.length})`]].map(([id, label]) => (
              <button key={id} onClick={() => setSubtab(id)} style={{
                padding: '6px 16px', fontSize: 11, background: 'none', border: 'none',
                borderBottom: subtab === id ? '2px solid var(--accent)' : '2px solid transparent',
                color: subtab === id ? 'var(--text)' : 'var(--text2)',
                fontWeight: subtab === id ? 600 : 400, cursor: 'pointer', transition: 'all .15s',
              }}>{label}</button>
            ))}
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

function TabApps({ fiori, dashboards, stories, alerts, userMap }) {
  const fioriOtros = useMemo(() =>
    fiori.filter(r => !r.FioriProjectID?.startsWith('tl.ibp.excel.addin.')),
    [fiori])

  const fioriApps = useMemo(() => {
    return Object.entries(groupBy(fioriOtros, r => r.FioriProjectTitle || r.FioriProjectID))
      .map(([name, rows]) => ({ name, usuarios: uniqueUsers(rows), usos: rows.length }))
      .sort((a, b) => b.usos - a.usos)
  }, [fioriOtros])

  const dashPorUsuario = useMemo(() => {
    return Object.entries(groupBy(dashboards, 'UserID'))
      .map(([uid, rows]) => {
        const pas = [...new Set(rows.map(r => r.PlanningAreaID).filter(Boolean))]
        return { usuario: userMap[uid] || uid, pa: pas.slice(0, 3).join(', ') || '—', sesiones: rows.length }
      })
      .sort((a, b) => b.sesiones - a.sesiones)
      .slice(0, 15)
  }, [dashboards, userMap])

  const alertPorUsuario = useMemo(() => {
    return Object.entries(groupBy(alerts, 'UserID'))
      .map(([uid, rows]) => {
        const last = rows.map(r => r.Timestamp).filter(Boolean).sort().reverse()[0]
        return { usuario: userMap[uid] || uid, aperturas: rows.length, ultima: last ? last.slice(0, 10) : '—' }
      })
      .sort((a, b) => b.aperturas - a.aperturas)
      .slice(0, 15)
  }, [alerts, userMap])

  const storyRows = useMemo(() => {
    return Object.entries(groupBy(stories, r => r.StoryName || r.StoryID || '?'))
      .map(([name, rows]) => ({ name, usuarios: uniqueUsers(rows), vistas: rows.length }))
      .sort((a, b) => b.vistas - a.vistas)
      .slice(0, 10)
  }, [stories])

  const noData = !fioriOtros.length && !dashboards.length && !alerts.length && !stories.length

  return (
    <div style={{ padding: '24px 24px 32px' }}>
      {noData ? <EmptyState /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

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
  const [preset,       setPreset]       = useState('7d')
  const [from,         setFrom]         = useState(() => { const [s] = presetDates('7d'); return toInputDate(s, getTzMode()) })
  const [to,           setTo]           = useState(() => { const [, e] = presetDates('7d'); return toInputDate(e, getTzMode()) })
  const [data,         setData]         = useState(null)
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState('')
  const [activeTab,    setActiveTab]    = useState('general')
  const [contextMode,  setContextMode]  = useState('all')
  const [contextValue, setContextValue] = useState('')

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
      const [overview, planningViews, logons, fiori, dashboards, stories, alerts, users, components, chgKeyFig] =
        await Promise.all([
          call(buildPath('MtrgActyGroupOverview',          { filter: groupFilter, top: 2000 })),
          call(buildPath('MtrgActyExcelAddInPlanningView', { filter: dateFilter,  top: 2000, orderby: 'TotalDuration desc' })),
          call(buildPath('MtrgActyExcelAddInLogon',        { filter: dateFilter,  top: 2000 })),
          call(buildPath('MtrgGenericUIActionUsage',       { filter: dateFilter,  top: 1000 })),
          call(buildPath('MtrgDashboard',                  { filter: dateFilter,  top: 500  })),
          call(buildPath('MtrgMngAnalyticStory',           { filter: dateFilter,  top: 500  })),
          call(buildPath('MtrgActyAlertMonitor',           { filter: dateFilter,  top: 500  })),
          call('/MtrgActyBusinessUser?$top=1000'),
          call('/MtrgComponent?$top=500'),
          call(buildPath('MtrgActyExcelAddInChgKeyFig',    { filter: dateFilter,  top: 2000 })),
        ])
      setData({ overview, planningViews, logons, fiori, dashboards, stories, alerts, users, components, chgKeyFig })
    } catch (e) {
      setError(e.message === '401'
        ? 'Credenciales incorrectas. Cierra sesión y vuelve a ingresar.'
        : `Error al cargar datos: ${e.message}`)
    }
    setLoading(false)
  }

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

  const componentMap = useMemo(() => {
    if (!data) return {}
    return Object.fromEntries(data.components.map(c => [c.MeteringComponent, c.MeteringComponentText]).filter(([k]) => k))
  }, [data])

  const planningAreas = useMemo(() => {
    if (!data) return []
    const all = [...data.overview, ...data.planningViews, ...data.fiori, ...data.dashboards]
    return [...new Set(all.map(r => r.PlanningAreaID).filter(Boolean))].sort()
  }, [data])

  const filteredData = useMemo(() => {
    if (!data || contextMode === 'all') return data
    const filterFn = contextMode === 'user'
      ? r => r.UserID === contextValue
      : r => r.PlanningAreaID === contextValue
    return {
      ...data,
      overview:      data.overview.filter(filterFn),
      planningViews: data.planningViews.filter(filterFn),
      logons:        data.logons.filter(filterFn),
      fiori:         data.fiori.filter(filterFn),
      dashboards:    data.dashboards.filter(filterFn),
      stories:       data.stories.filter(filterFn),
      alerts:        data.alerts.filter(filterFn),
      chgKeyFig:     data.chgKeyFig.filter(filterFn),
      users:         data.users,
      components:    data.components,
    }
  }, [data, contextMode, contextValue])

  const fd = filteredData || {}

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <FilterBar
        preset={preset} onPreset={handlePreset}
        from={from}     setFrom={setFrom}
        to={to}         setTo={setTo}
        loading={loading} hasData={!!data}
      />

      {data && (
        <ContextSelector
          mode={contextMode}       value={contextValue}
          onModeChange={setContextMode} onValueChange={setContextValue}
          users={data.users}       planningAreas={planningAreas}
          userMap={userMap}
        />
      )}

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
            {activeTab === 'general' && (
              <TabGeneral
                overview={fd.overview}         planningViews={fd.planningViews}
                logons={fd.logons}             fiori={fd.fiori}
                dashboards={fd.dashboards}     stories={fd.stories}
                alerts={fd.alerts}             users={data.users}
                userMap={userMap}              componentMap={componentMap}
                contextMode={contextMode}      contextValue={contextValue}
              />
            )}
            {activeTab === 'excel' && (
              <TabExcel
                planningViews={fd.planningViews} logons={fd.logons}
                chgKeyFig={fd.chgKeyFig}         userMap={userMap}
              />
            )}
            {activeTab === 'apps' && (
              <TabApps
                fiori={fd.fiori}       dashboards={fd.dashboards}
                stories={fd.stories}   alerts={fd.alerts}
                userMap={userMap}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
