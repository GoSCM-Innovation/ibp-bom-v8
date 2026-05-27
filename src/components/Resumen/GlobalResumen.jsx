import { useState, useEffect, useCallback, useRef } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import ProgressBar from '../ui/ProgressBar'
import TruncText from '../ui/TruncText'
import { proxyCall } from '../../services/proxyCall'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts'
import TechLogs, { useTechLogs } from '../TechLogs'
import {
  toSapTs, formatSapTsShort, toInputDate, inputDateToDate,
  getTzMode, setTzMode as saveTzMode, getTzLabel,
} from '../../utils/dateUtils'
import { useI18n } from '../../context/I18nContext'
import { connDisplayName } from '../../utils/connDisplayName'

const REFRESH_MS = 5 * 60 * 1000
const DEFAULT_HOURS = 24

const STATUS_COLORS = {
  F: '#34d399', W: '#fbbf24', A: '#ff6b6b', U: '#f97316',
  R: '#3b82f6', S: '#8b5cf6', P: '#06b6d4', Y: '#a78bfa',
  C: '#9ca3af', c: '#9ca3af', D: '#4b5563', K: '#6b7280',
  X: '#374151', k: '#6b7280',
}

const CONN_COLORS = ['#3b82f6', '#34d399', '#f97316', '#8b5cf6', '#06b6d4', '#ff6b6b', '#fbbf24', '#a78bfa']

export default function GlobalResumen({ connections, sessions = {}, onLogin }) {
  const { t } = useI18n()

  const STATUS_LABELS = {
    F: t('global.jobStatusF'), W: t('global.jobStatusW'), A: t('global.jobStatusA'),
    U: t('global.jobStatusU'), R: t('global.jobStatusR'), S: t('global.jobStatusS'),
    P: t('global.jobStatusP'), Y: t('global.jobStatusY'), C: t('global.jobStatusC'),
    D: t('global.jobStatusD'), K: t('global.jobStatusK'), X: t('global.jobStatusX'),
  }
  const isMobile = useIsMobile()
  const [connData, setConnData] = useState({})
  const [lastRefresh, setLastRefresh] = useState(null)
  const [tzMode, setTzModeState]      = useState(() => getTzMode())
  const timerRef = useRef(null)
  const [logs, addLog] = useTechLogs()
  const addLogRef = useRef(addLog)
  addLogRef.current = addLog

  const [fromDate, setFromDate] = useState(() => toInputDate(new Date(Date.now() - DEFAULT_HOURS * 3600 * 1000), getTzMode()))
  const [toDate,   setToDate]   = useState(() => toInputDate(new Date(Date.now() + DEFAULT_HOURS * 3600 * 1000), getTzMode()))

  function handleTzToggle(newMode) {
    const fromD = inputDateToDate(fromDate, tzMode)
    const toD   = inputDateToDate(toDate, tzMode)
    saveTzMode(newMode)
    setTzModeState(newMode)
    setFromDate(toInputDate(fromD, newMode))
    setToDate(toInputDate(toD, newMode))
  }

  const loadAll = useCallback(async () => {
    const results = {}
    await Promise.all(connections.map(async (conn) => {
      const session = sessions[conn.id]
      if (!session) {
        results[conn.id] = { rows: [], error: '', loading: false, noSession: true }
        return
      }
      results[conn.id] = { rows: [], error: '', loading: true }
      const start = performance.now()
      try {
        const res = await proxyCall({ connection: conn, session, path: '/JobHeaderSet' })
        const data = await res.json()
        const duration = Math.round(performance.now() - start)
        addLogRef.current({ method: 'GET', path: `/JobHeaderSet (${conn.name})`, status: res.status, duration, detail: data.error || `${(data?.d?.results ?? data?.value ?? []).length} rows` })
        if (data.error) {
          results[conn.id] = { rows: [], error: data.error, loading: false }
        } else {
          results[conn.id] = { rows: data?.d?.results ?? data?.value ?? [], error: '', loading: false }
        }
      } catch (e) {
        const duration = Math.round(performance.now() - start)
        addLogRef.current({ method: 'GET', path: `/JobHeaderSet (${conn.name})`, status: 0, duration, detail: e.message })
        results[conn.id] = { rows: [], error: e.message, loading: false }
      }
    }))
    setConnData(results)
    setLastRefresh(new Date())
  }, [connections, sessions])

  useEffect(() => {
    if (connections.length === 0) return
    loadAll()
    timerRef.current = setInterval(loadAll, REFRESH_MS)
    return () => clearInterval(timerRef.current)
  }, [loadAll, connections.length])

  const fromTs = toSapTs(inputDateToDate(fromDate, tzMode))
  const toTs   = toSapTs(inputDateToDate(toDate, tzMode))

  function filterRows(rows) {
    return rows.filter(r => {
      const ts = r.JobPlannedStartDateTime || ''
      if (ts && (ts < fromTs || ts > toTs)) return false
      return true
    })
  }

  const globalLoading = connections.some(c => connData[c.id]?.loading)
  const anyLoading = connections.length > 0 && Object.keys(connData).length === 0

  const connSummaries = connections.map((conn, idx) => {
    const d = connData[conn.id]
    const hasSession = !!sessions[conn.id]
    if (!hasSession) return { conn, idx, loading: false, total: 0, finished: 0, failed: 0, running: 0, scheduled: 0, successRate: 0, error: '', noSession: true }
    if (!d || d.loading) return { conn, idx, loading: true, total: 0, finished: 0, failed: 0, running: 0, scheduled: 0, successRate: 0, error: '' }
    if (d.error) return { conn, idx, loading: false, total: 0, finished: 0, failed: 0, running: 0, scheduled: 0, successRate: 0, error: d.error }
    const rows = filterRows(d.rows)
    const total = rows.length
    const finished = rows.filter(r => r.JobStatus === 'F').length
    const warned = rows.filter(r => r.JobStatus === 'W').length
    const failed = rows.filter(r => ['A','U'].includes(r.JobStatus)).length
    const running = rows.filter(r => r.JobStatus === 'R').length
    const scheduled = rows.filter(r => ['S','P','Y'].includes(r.JobStatus)).length
    const successRate = total > 0 ? Math.round(((finished + warned) / total) * 100) : 0
    return { conn, idx, loading: false, total, finished, failed, running, scheduled, successRate, warned, error: '' }
  })

  const gTotal = connSummaries.reduce((s, c) => s + c.total, 0)
  const gFinished = connSummaries.reduce((s, c) => s + c.finished, 0)
  const gFailed = connSummaries.reduce((s, c) => s + c.failed, 0)
  const gRunning = connSummaries.reduce((s, c) => s + c.running, 0)
  const gScheduled = connSummaries.reduce((s, c) => s + c.scheduled, 0)
  const gWarned = connSummaries.reduce((s, c) => s + (c.warned || 0), 0)
  const gSuccessRate = gTotal > 0 ? Math.round(((gFinished + gWarned) / gTotal) * 100) : 0

  const globalStatusCount = {}
  connections.forEach(conn => {
    const d = connData[conn.id]
    if (!d || d.error) return
    filterRows(d.rows).forEach(r => {
      globalStatusCount[r.JobStatus] = (globalStatusCount[r.JobStatus] || 0) + 1
    })
  })
  const donutData = Object.entries(globalStatusCount)
    .map(([code, count]) => ({ name: STATUS_LABELS[code] || code, value: count, code }))
    .sort((a, b) => b.value - a.value)

  const connBarData = connSummaries
    .filter(c => !c.error)
    .map(c => ({
      name: (() => { const n = connDisplayName(c.conn, t); return n.length > 20 ? n.slice(0, 18) + '…' : n })(),
      finished: c.finished + (c.warned || 0),
      failed: c.failed,
      others: c.total - c.finished - (c.warned || 0) - c.failed,
    }))

  const allFailures = []
  connections.forEach(conn => {
    const d = connData[conn.id]
    if (!d || d.error) return
    filterRows(d.rows)
      .filter(r => ['A','U'].includes(r.JobStatus))
      .forEach(r => allFailures.push({ ...r, _connName: connDisplayName(conn, t) }))
  })
  allFailures.sort((a, b) => (b.JobPlannedStartDateTime || '').localeCompare(a.JobPlannedStartDateTime || ''))
  const recentFailures = allFailures.slice(0, 8)

  if (connections.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>{t('global.empty')}</div>
        <div style={{ fontSize: 12, color: 'var(--text2)' }}>{t('global.emptyHint')}</div>
      </div>
    )
  }

  const connCountKey = connections.length === 1 ? 'global.conn1Job' : 'global.connNJob'

  return (
    <div style={{ padding: isMobile ? 14 : 28, overflowY: 'auto', height: '100%', boxSizing: 'border-box', position: 'relative' }}>
      <ProgressBar loading={anyLoading || globalLoading} />

      {/* Header */}
      <div style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'center',
        justifyContent: 'space-between',
        marginBottom: 24, flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{t('global.title')}</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
            {t(connCountKey, { conns: connections.length, jobs: gTotal })}
            {lastRefresh && (
              <span style={{ marginLeft: 8, opacity: .6 }}>· {lastRefresh.toLocaleTimeString()}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <TzToggle mode={tzMode} onToggle={handleTzToggle} />
          <input type="datetime-local" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={{ ...inputStyle, ...(isMobile && { flexBasis: '100%', width: '100%' }) }} />
          {!isMobile && <span style={{ color: 'var(--text2)', fontSize: 11 }}>→</span>}
          <input type="datetime-local" value={toDate} onChange={e => setToDate(e.target.value)}
            style={{ ...inputStyle, ...(isMobile && { flexBasis: '100%', width: '100%' }) }} />
          <button onClick={loadAll} disabled={anyLoading} style={{
            background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 6,
            color: 'var(--text2)', fontSize: 11, fontWeight: 600, padding: '6px 12px', cursor: 'pointer',
          }}>{t('resumen.refresh')}</button>
          {!isMobile && (
            <span style={{
              fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap',
              padding: '4px 8px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
            }}>{t('resumen.autoRefresh')}</span>
          )}
        </div>
      </div>

      {/* Global KPIs */}
      <div className="grid-kpi">
        <KpiCard label={t('global.kpiTotal')}     value={gTotal}     color="var(--text)" />
        <KpiCard label={t('global.kpiRunning')}   value={gRunning}   color="var(--cyan)" />
        <KpiCard label={t('global.kpiScheduled')} value={gScheduled} color="var(--purple)" />
        <KpiCard label={t('global.kpiFinished')}  value={gFinished}  color="var(--green)" />
        <KpiCard label={t('global.kpiFailed')}    value={gFailed}    color="var(--red)" />
        <KpiCard label={t('global.kpiRate')}      value={`${gSuccessRate}%`} color={gSuccessRate >= 90 ? 'var(--green)' : gSuccessRate >= 70 ? 'var(--accent)' : 'var(--red)'} />
      </div>

      {/* Charts row */}
      <div className="grid-charts">
        <div style={cardStyle}>
          <div style={cardTitle}>{t('global.chartGlobalStatus')}</div>
          {donutData.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={donutData} cx="50%" cy="50%" innerRadius={55} outerRadius={85}
                  paddingAngle={2} dataKey="value">
                  {donutData.map((entry, i) => (
                    <Cell key={i} fill={STATUS_COLORS[entry.code] || '#6b7280'} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
                  formatter={(v, n) => [v, n]}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8 }}>
            {donutData.map((d, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text2)' }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLORS[d.code] || '#6b7280', flexShrink: 0 }} />
                {d.name} ({d.value})
              </div>
            ))}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={cardTitle}>{t('global.chartByConn')}</div>
          {connBarData.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={connBarData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--text2)' }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text2)' }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text2)' }} />
                <Bar dataKey="finished" name={t('resumen.chartFinished')} stackId="a" fill="var(--green)" />
                <Bar dataKey="failed"   name={t('resumen.chartFailed')}   stackId="a" fill="var(--red)" />
                <Bar dataKey="others"   name={t('resumen.chartOthers')}   stackId="a" fill="var(--text3)" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Connection status table */}
      <div style={{ ...cardStyle, marginTop: 16 }}>
        <div style={cardTitle}>{t('global.connHealth')}</div>
        <div style={{ overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg3)' }}>
                <th style={thStyle}>{t('global.colNum')}</th>
                <th style={{ ...thStyle, textAlign: 'left', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('global.colConn')}</th>
                <th style={thStyle}>{t('global.colStatus')}</th>
                <th style={thStyle}>{t('global.colTotal')}</th>
                <th style={thStyle}>{t('global.colRunning')}</th>
                <th style={thStyle}>{t('global.colScheduled')}</th>
                <th style={thStyle}>{t('global.colFinished')}</th>
                <th style={thStyle}>{t('global.colFailed')}</th>
                <th style={thStyle}>{t('global.colRate')}</th>
              </tr>
            </thead>
            <tbody>
              {connSummaries.map((cs, i) => (
                <tr key={cs.conn.id} style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--bg2)' }}>
                  <td style={tdStyle}>
                    <span style={{
                      width: 22, height: 22, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: 'var(--surface-glass)', border: '1px solid var(--border)',
                      fontSize: 10, fontWeight: 700, color: 'var(--text2)',
                    }}>{cs.idx + 1}</span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'left', fontWeight: 600, color: 'var(--text)', maxWidth: 160 }}>
                    <TruncText text={connDisplayName(cs.conn, t)} style={{ fontWeight: 600, color: 'var(--text)' }} />
                  </td>
                  <td style={tdStyle}>
                    {cs.noSession ? (
                      <button onClick={() => onLogin?.(cs.conn.id)} style={{
                        fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20, cursor: 'pointer',
                        background: 'var(--surface-glass)', color: 'var(--text3)',
                        border: '1px solid var(--border)',
                      }}>{t('global.login')}</button>
                    ) : cs.loading ? (
                      <span style={{ color: 'var(--text3)' }}>{t('global.loading')}</span>
                    ) : cs.error ? (
                      <span style={{ ...statusBadge, background: 'color-mix(in srgb, var(--red) 15%, transparent)', color: 'var(--red)', border: '1px solid color-mix(in srgb, var(--red) 35%, transparent)' }}>{t('global.statusError')}</span>
                    ) : cs.failed > 0 ? (
                      <span style={{ ...statusBadge, background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}>{t('global.statusWarning')}</span>
                    ) : (
                      <span style={{ ...statusBadge, background: 'color-mix(in srgb, var(--green) 15%, transparent)', color: 'var(--green)', border: '1px solid color-mix(in srgb, var(--green) 35%, transparent)' }}>{t('global.statusHealthy')}</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontWeight: 700 }}>{cs.total}</td>
                  <td style={{ ...tdStyle, color: cs.running > 0 ? 'var(--cyan)' : 'var(--text3)' }}>{cs.running}</td>
                  <td style={{ ...tdStyle, color: cs.scheduled > 0 ? 'var(--purple)' : 'var(--text3)' }}>{cs.scheduled}</td>
                  <td style={{ ...tdStyle, color: cs.finished > 0 ? 'var(--green)' : 'var(--text3)' }}>{cs.finished}</td>
                  <td style={{ ...tdStyle, color: cs.failed > 0 ? 'var(--red)' : 'var(--text3)', fontWeight: cs.failed > 0 ? 700 : 400 }}>{cs.failed}</td>
                  <td style={tdStyle}>
                    <span style={{
                      fontWeight: 700,
                      color: cs.successRate >= 90 ? 'var(--green)' : cs.successRate >= 70 ? 'var(--accent)' : cs.total === 0 ? 'var(--text3)' : 'var(--red)',
                    }}>{cs.total > 0 ? `${cs.successRate}%` : '—'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent failures across all connections */}
      <div className="grid-stats" style={{ marginTop: 16 }}>
        <div style={cardStyle}>
          <div style={cardTitle}>{t('global.recentFailed')}</div>
          {recentFailures.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 8 }}>{t('global.noFailed')}</div>
            : recentFailures.map((r, i) => (
              <div key={i} style={{ padding: '7px 0', borderBottom: i < recentFailures.length-1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--red)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                    {r.JobText || '—'}
                  </div>
                  <span style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 3, flexShrink: 0,
                    background: 'rgba(59,130,246,.1)', color: '#3b82f6', fontWeight: 600,
                  }}>{r._connName}</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{r.JobCreatedByFormattedName || r.JobCreatedBy}</span>
                  <span>{formatSapTsShort(r.JobPlannedStartDateTime, tzMode)}</span>
                </div>
              </div>
            ))
          }
        </div>

        {/* Connection health summary */}
        <div style={cardStyle}>
          <div style={cardTitle}>{t('global.connHealthCard')}</div>
          {connSummaries.map((cs, i) => {
            const color = cs.error ? 'var(--red)' : cs.failed > 0 ? '#fbbf24' : 'var(--green)'
            const pct = gTotal > 0 ? (cs.total / gTotal) * 100 : 0
            return (
              <div key={cs.conn.id} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <div style={{ fontSize: 11, color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
                    }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{connDisplayName(cs.conn, t)}</span>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color, flexShrink: 0, marginLeft: 8 }}>
                    {cs.error ? t('global.statusError') : `${cs.successRate}%`}
                  </span>
                </div>
                <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: CONN_COLORS[i % CONN_COLORS.length], borderRadius: 2, transition: 'width .4s' }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <TechLogs logs={logs} />
    </div>
  )
}

function KpiCard({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
    </div>
  )
}

function Empty() {
  const { t } = useI18n()
  return <div style={{ fontSize: 12, color: 'var(--text3)', padding: '16px 0' }}>{t('global.noData')}</div>
}

const cardStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: 10, padding: '16px 18px',
}

const cardTitle = {
  fontSize: 11, fontWeight: 700, color: 'var(--text2)',
  textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 12,
}

const inputStyle = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text)', fontSize: 11,
  padding: '6px 10px', outline: 'none',
}

const thStyle = {
  padding: '8px 12px', textAlign: 'center', color: 'var(--text2)',
  fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontSize: 11,
}

const tdStyle = {
  padding: '8px 12px', borderBottom: '1px solid var(--border)',
  textAlign: 'center', whiteSpace: 'nowrap', color: 'var(--text)',
}

const statusBadge = {
  display: 'inline-block', padding: '2px 8px', borderRadius: 20,
  fontSize: 10, fontWeight: 700,
}

function TzToggle({ mode, onToggle }) {
  const { t } = useI18n()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: 2 }}>
      <button
        onClick={() => onToggle('utc')}
        title={t('resumen.tzUtcTitle')}
        style={{
          padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer', border: 'none',
          background: mode === 'utc' ? 'var(--border2)' : 'transparent',
          color: mode === 'utc' ? '#fff' : 'var(--text3)',
        }}
      >UTC</button>
      <button
        onClick={() => onToggle('local')}
        title={t('resumen.tzLocalTitle', { tz: getTzLabel() })}
        style={{
          padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer', border: 'none',
          background: mode === 'local' ? 'var(--border2)' : 'transparent',
          color: mode === 'local' ? '#fff' : 'var(--text3)',
        }}
      >{getTzLabel()}</button>
    </div>
  )
}
