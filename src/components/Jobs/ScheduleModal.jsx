import { useState, useEffect } from 'react'
import { proxyCall } from '../../services/proxyCall'

function enc(val) {
  return `%27${encodeURIComponent(val)}%27`
}

function bn(fullName) {
  return fullName.slice(0, 8).trimEnd()
}

const PARAM_LABEL = {
  P_ALGO: 'Planning Algorithm', P_ATD: 'Available-to-Deploy Profile', P_CBP: 'CBP Profile',
  P_DATE: 'Date', P_FLTID: 'Planning Filter', P_OPER: 'Operator Mode',
  P_PLSCOP: 'Network/Subnetwork Selection', P_PRF: 'Planning Run Profile', P_PRM: 'Generate PRM Data',
  P_REFDAY: 'Planning Start', P_SCEN: 'Scenario', P_SIMVE: 'Version or Scenario',
  P_STR: 'Planning Direction', P_SUGF: 'Generate Supply Usage and Gating Factors',
  P_TAP: 'Time Aggregation Profile', P_TYPE: 'Planning Run Type', P_TZONE: 'Time Zone',
  P_VERS: 'Version', P_WDAY: 'Weekday', S_DISPO: 'MRP Controller', S_LOCNO: 'Location',
  S_MATNR: 'Product', S_SUBN: 'Subnetwork', P_ACT: 'Operation', P_AREA: 'Planning Area',
  P_COMM: 'Comment', P_CPDATE: 'Date', P_CPMETH: 'Define By', P_CPTIME: 'Time',
  P_CPTZ: 'Time Zone', P_FRPID: 'From Period', P_NOTES: 'Planning Notes',
  P_OPID: 'Operator Profile', P_OPNAME: 'Operator Name', P_OPTYP: 'Operator Type',
  P_PPROP: 'Time Horizon', P_PROFID: 'Copy Operator Profile ID', P_SHARE: 'Share With',
  P_TIMSEL: 'Use Time Selection from Profile', P_TOPID: 'To Period',
  P_VFROM: 'From Version', P_VTO: 'To Version', S_KEYFG: 'Key Figures',
  S_KF_GRP: 'Key Figure Groups', S_MD: 'Master Data', S_RCODE: 'Reason Code',
  P_ATTFCS: 'Target Attribute', P_FM: 'Forecast Model', P_PL: 'Planning Level',
  P_SCMTP: 'S&OP Time Profile Level', S_VERS: 'Version',
  P_CMD: 'Batch Command', P_PRES: 'Preview', P_SIMU: 'Simulation Mode',
  P_RULE: 'Rule ID', P_SCNID: 'Scenario', P_PLAREA: 'Planning Area',
  // CIDS / HCI integration parameters
  P_AGTGP: 'Agent Group', P_AGTNM: 'Agent Name', P_ORGNM: 'Organization Name',
  P_ISPRD: 'Production', P_TSKID: 'Task Name', P_TSKDSC: 'Task Description',
  P_PROF: 'System Configuration', P_CHDUR: 'Status Check (Hours)',
  P_TEMPT: 'Template Type', P_FLTNM: 'Filter', P_AREANM: 'Planning Area',
  P_GCONF: 'Configuration', P_URCTX: 'URL Context',
}

function labelOf(name, labelMap) {
  const base = bn(name)
  return labelMap?.[name] ?? PARAM_LABEL[base] ?? base
}

// Retorna el número de slot (1-15) para P_VARN01..15 y P_VARV01..15, o 0 si no aplica
function varSlotNum(base) {
  if (/^P_VARN\d\d$/.test(base) || /^P_VARV\d\d$/.test(base)) return parseInt(base.slice(6), 10)
  return 0
}

export default function ScheduleModal({ row, connection, session, onClose, onSuccess }) {
  const [loading, setLoading]           = useState(true)
  const [loadError, setLoadError]       = useState('')
  const [steps, setSteps]               = useState([])
  const [expandedStep, setExpandedStep] = useState(null)
  const [jobText, setJobText]           = useState('')
  const [executing, setExecuting]       = useState(false)
  const [execError, setExecError]       = useState('')

  const templateLabel = row.JobTemplateText || row.JobTemplateName

  // ── Carga ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true); setLoadError(''); setSteps([])
    setExpandedStep(null); setExecError('')
    setJobText(row.JobTemplateText || row.JobTemplateName)

    const name = row.JobTemplateName

    Promise.all([
      proxyCall({ connection, session, path: `/JobTemplateRead?JobTemplateName=${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/JobTemplateParamGroupSet?$filter=JobTemplateName+eq+${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/JobTemplateSet(JobTemplateName=${enc(name)},JobTemplateVersion=${enc('0')})/JobTemplateSequenceSet` }).then(r => r.json()).catch(() => ({ d: { results: [] } })),
    ]).then(async ([tplData, gData, seqData]) => {
      const seqResults = seqData?.d?.results ?? seqData?.value ?? []
      const seqTextByPos = {}
      seqResults.forEach(s => {
        if (s.JobSequenceText) seqTextByPos[s.JobSequencePosition] = s.JobSequenceText
      })

      const groupText = {}
      const groups = gData?.d?.results ?? gData?.value ?? []
      groups.forEach(g => { groupText[g.JobTemplateParamGroupName] = g.JobTemplateParamGroupText })

      let sequences = []
      try {
        const td = JSON.parse(tplData?.d?.TemplateData ?? 'null')
        sequences = td?.templates?.[0]?.sequences ?? []
      } catch { /* fall through */ }

      // Texto legible de cada catálogo de step (solo si hay secuencias del path principal)
      const distinctCatalogs = sequences.length > 0
        ? [...new Set(sequences.map(s => s.basic_jce_name).filter(Boolean))]
        : []
      const catalogTexts = {}
      await Promise.all(distinctCatalogs.map(async cat => {
        try {
          const catData = await proxyCall({ connection, session, path: `/JobTemplateRead?JobTemplateName=${enc(cat)}` }).then(r => r.json())
          const catTd   = JSON.parse(catData?.d?.TemplateData ?? 'null')
          const text    = catTd?.templates?.[0]?.text
          if (text) catalogTexts[cat] = text
        } catch { /* usa nombre técnico */ }
      }))

      let finalSteps
      if (sequences.length > 0) {
        finalSteps = sequences.map((seq, idx) => {
          const stepNr    = idx + 1
          const rawParams = seq.seq_param_val ?? []
          const labelMap  = {}
          rawParams.forEach(p => { if (p.label) labelMap[p.name] = p.label })

          // Valores desde seq_param_val[i].value[] — array para soportar multi-valor
          const values = {}
          rawParams.forEach(p => {
            values[bn(p.name)] = (p.value ?? []).map(v => v.low ?? '').filter(v => v !== '')
          })

          // Cuántas variables custom activas (P_VARNO)
          const varnoCount = parseInt(values['P_VARNO']?.[0] || '0', 10) || 0

          const params = rawParams
            .filter(p => p.hidden !== true)
            .filter(p => {
              // Slots P_VARN[N] / P_VARV[N]: mostrar solo N ≤ P_VARNO
              const slot = varSlotNum(bn(p.name))
              if (slot > 0) return slot <= varnoCount
              return true
            })
            .map(p => ({
              name:       p.name,
              label:      labelOf(p.name, labelMap),
              group:      groupText[bn(p.name)] ?? null,
              isCheckbox: p.check_box === true,
            }))

          return {
            seqPos:       stepNr,
            basicJceName: seq.basic_jce_name ?? '',
            catalogText:  catalogTexts[seq.basic_jce_name] ?? seq.basic_jce_name ?? `Paso ${stepNr}`,
            stepName:     seqTextByPos[seq.seq_position] ?? null,
            params,
            values,
          }
        })
      } else if (seqResults.length > 0) {
        // Fallback para templates RHCI_DI u otros donde JobTemplateRead falla.
        // JobTemplateParameterValueDataSet sí es accesible y contiene los valores configurados.
        const valData = await proxyCall({ connection, session,
          path: `/JobTemplateParameterValueDataSet?$filter=JobTemplateName+eq+${enc(name)}`
        }).then(r => r.json()).catch(() => ({ d: { results: [] } }))

        const valResults = valData?.d?.results ?? valData?.value ?? []

        // Agrupar valores por nombre base (bn() maneja nombres con o sin hash suffix)
        const valsByBase = {}
        valResults.forEach(v => {
          const base = bn(v.JobTemplateParameterName)
          if (!valsByBase[base]) valsByBase[base] = []
          if (v.Low !== undefined) valsByBase[base].push(v.Low)
        })

        const varnoCount = parseInt(valsByBase['P_VARNO']?.[0] || '0', 10) || 0

        const seenBases = new Set()
        const paramDefs = valResults
          .filter(v => {
            const base = bn(v.JobTemplateParameterName)
            if (seenBases.has(base)) return false
            seenBases.add(base)
            const slot = varSlotNum(base)
            return slot <= 0 || slot <= varnoCount
          })
          .map(v => ({
            name:       v.JobTemplateParameterName,
            label:      labelOf(v.JobTemplateParameterName, {}),
            group:      null,
            isCheckbox: bn(v.JobTemplateParameterName) === 'P_ISPRD',
          }))

        finalSteps = seqResults
          .slice()
          .sort((a, b) => (a.JobSequencePosition || 0) - (b.JobSequencePosition || 0))
          .map(seq => ({
            seqPos:       seq.JobSequencePosition || 1,
            basicJceName: seq.BasicJobCatalogEntryName ?? '',
            catalogText:  seq.JceText || seq.BasicJobCatalogEntryName || '',
            stepName:     seq.JobSequenceText || null,
            params:       paramDefs,
            values:       valsByBase,
          }))
      } else {
        finalSteps = []
      }

      setSteps(finalSteps)
      setLoading(false)
      if (finalSteps.length === 1) setExpandedStep(1)
    }).catch(e => {
      setLoadError(e.message)
      setLoading(false)
    })
  }, [row.JobTemplateName]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ejecutar con los valores configurados en el template ─────────────────────
  async function handleExecute() {
    setExecuting(true)
    setExecError('')
    const path = `/JobSchedule?JobTemplateName=${enc(row.JobTemplateName)}&JobText=${enc(jobText || templateLabel)}`
    try {
      const r = await proxyCall({ connection, session, path, method: 'POST', injectJobUser: true })
      const data = await r.json()
      if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))
      onSuccess?.()
      onClose()
    } catch (e) {
      setExecError(e.message)
      setExecuting(false)
    }
  }

  // ── ¿El parámetro tiene un valor configurado real? ───────────────────────────
  // Para checkboxes: marcado con 'X'. Para resto: al menos un valor no vacío y
  // que no sea un slot inactivo (0 / 00000000).
  function isConfigured(p, values) {
    const lows = values[bn(p.name)] ?? []
    if (p.isCheckbox) return lows.includes('X')
    return lows.some(v => v !== '' && v !== '0' && v !== '00000000')
  }

  // ── Render de un parámetro (solo lectura) ────────────────────────────────────
  function renderParam(p, values, dim = false) {
    const lows     = values[bn(p.name)] ?? []
    const hasValue = lows.length > 0
    const baseOpacity = dim ? 0.45 : 1

    if (p.isCheckbox) {
      const checked = lows.includes('X')
      return (
        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: baseOpacity }}>
          <span style={{ fontSize: 13, flexShrink: 0, color: checked ? '#22c55e' : 'var(--text3)' }}>
            {checked ? '☑' : '☐'}
          </span>
          <span style={{ fontSize: 11, color: checked ? 'var(--text)' : 'var(--text3)', fontWeight: 500 }}>
            {p.label}
          </span>
        </div>
      )
    }

    return (
      <div key={p.name} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0, opacity: baseOpacity }}>
        <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 500, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {p.label}
        </span>
        {hasValue ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
            {lows.map((low, i) => (
              <span key={i} style={{
                fontSize: 11, color: 'var(--text)', fontFamily: 'var(--mono)',
                background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '1px 7px', wordBreak: 'break-all',
              }}>
                {low}
              </span>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>—</span>
        )}
      </div>
    )
  }

  // ── Contenido expandido de un step ───────────────────────────────────────────
  function renderStepContent(step) {
    if (step.params.length === 0) {
      return (
        <div style={{ padding: '14px', fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>
          Sin parámetros configurados para este paso.
        </div>
      )
    }

    const checkboxes = step.params.filter(p => p.isCheckbox)
    const rest       = step.params.filter(p => !p.isCheckbox)

    // Particionar en configurados / vacíos manteniendo el orden original
    const restConfigured = rest.filter(p => isConfigured(p, step.values))
    const restEmpty      = rest.filter(p => !isConfigured(p, step.values))
    const cbConfigured   = checkboxes.filter(p => isConfigured(p, step.values))
    const cbEmpty        = checkboxes.filter(p => !isConfigured(p, step.values))

    return (
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {restConfigured.map(p => renderParam(p, step.values, false))}
        {restEmpty.map(p => renderParam(p, step.values, true))}
        {checkboxes.length > 0 && rest.length > 0 && (
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
        )}
        {checkboxes.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
            {cbConfigured.map(p => renderParam(p, step.values, false))}
            {cbEmpty.map(p => renderParam(p, step.values, true))}
          </div>
        )}
      </div>
    )
  }

  // ── Render principal ─────────────────────────────────────────────────────────
  return (
    <>
      <div
        onClick={executing ? undefined : onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 500, backdropFilter: 'blur(2px)' }}
      />

      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(560px, 95vw)', maxHeight: '88vh',
        background: 'var(--bg)', border: '1px solid var(--border2)',
        borderRadius: 12, zIndex: 501,
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 64px rgba(0,0,0,.5)',
        animation: 'scheduleModalIn .18s ease-out',
      }}>

        {/* ── Header ── */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Ejecutar job</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{templateLabel}</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{row.JobTemplateName}</div>
            </div>
            <button
              onClick={executing ? undefined : onClose}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', fontSize: 13, cursor: 'pointer', padding: '4px 10px', lineHeight: 1, flexShrink: 0 }}
            >✕</button>
          </div>

          {!loading && !loadError && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
                Nombre del run
              </div>
              <input
                type="text" value={jobText}
                onChange={e => setJobText(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'var(--bg2)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text)', fontSize: 11,
                  padding: '7px 10px', outline: 'none',
                }}
              />
            </div>
          )}

          {!loading && !loadError && (
            <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text3)', fontStyle: 'italic' }}>
              Los parámetros se ejecutan con los valores configurados en SAP IBP.
              Para modificarlos, edita el template directamente en el sistema.
            </div>
          )}
        </div>

        {/* ── Body: lista de steps ── */}
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}>

          {loading && (
            <div style={{ textAlign: 'center', padding: '36px 0', color: 'var(--text2)', fontSize: 12 }}>
              Cargando pasos…
            </div>
          )}

          {loadError && (
            <div style={{ background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 8, padding: '10px 14px', color: 'var(--red)', fontSize: 12 }}>
              ✕ {loadError}
            </div>
          )}

          {!loading && !loadError && steps.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text2)', fontSize: 12 }}>
              Este template no tiene pasos configurados.
            </div>
          )}

          {!loading && !loadError && steps.map(step => {
            const isOpen = expandedStep === step.seqPos

            // Params con valor real configurado (consistente con isConfigured del body)
            const configured = step.params.filter(p => isConfigured(p, step.values)).length
            const total = step.params.length

            // Título: stepName (IBP user-defined) > catalogText, con P_OPNAME si aplica
            const opName    = ((step.values['P_OPNAME'] ?? [])[0] ?? '').trim()
            const titleBase = step.stepName ?? step.catalogText
            const stepTitle = opName ? `${titleBase}: ${opName}` : titleBase
            const showCatalogSubtitle = !!step.stepName

            return (
              <div key={step.seqPos} style={{
                marginBottom: 8, borderRadius: 8, overflow: 'hidden',
                border: `1px solid ${isOpen ? 'var(--border2)' : 'var(--border)'}`,
                background: isOpen ? 'var(--bg2)' : 'transparent',
                transition: 'border-color .15s',
              }}>

                <div
                  onClick={() => setExpandedStep(prev => prev === step.seqPos ? null : step.seqPos)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', userSelect: 'none' }}
                >
                  <span style={{
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700,
                    background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)',
                  }}>{step.seqPos}</span>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {stepTitle}
                    </div>
                    {showCatalogSubtitle && (
                      <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {step.catalogText}
                      </div>
                    )}
                    {!showCatalogSubtitle && step.catalogText !== step.basicJceName && step.basicJceName && (
                      <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 1 }}>
                        {step.basicJceName}
                      </div>
                    )}
                  </div>

                  {total > 0 && (
                    <span style={{ fontSize: 9, color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {configured}/{total}
                    </span>
                  )}

                  <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0, marginLeft: 2 }}>
                    {isOpen ? '▲' : '▼'}
                  </span>
                </div>

                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg3)' }}>
                    {renderStepContent(step)}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* ── Footer ── */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          {execError && (
            <div style={{ background: 'rgba(255,107,107,.1)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 6, padding: '8px 12px', color: 'var(--red)', fontSize: 11, marginBottom: 12, wordBreak: 'break-word' }}>
              ✕ {execError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
            {!loading && steps.length > 0 && (
              <span style={{ fontSize: 10, color: 'var(--text3)', marginRight: 'auto' }}>
                {steps.length} paso{steps.length !== 1 ? 's' : ''}
              </span>
            )}
            <button
              onClick={executing ? undefined : onClose} disabled={executing}
              style={{ padding: '7px 18px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 12, cursor: executing ? 'default' : 'pointer' }}
            >
              Cancelar
            </button>
            <button
              onClick={handleExecute} disabled={executing || loading}
              style={{ padding: '7px 18px', borderRadius: 6, border: '1px solid rgba(34,197,94,.35)', background: 'rgba(34,197,94,.1)', color: '#22c55e', fontSize: 12, fontWeight: 600, cursor: (executing || loading) ? 'default' : 'pointer', opacity: (executing || loading) ? 0.6 : 1 }}
            >
              {executing ? 'Ejecutando…' : '▶ Ejecutar'}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes scheduleModalIn {
          from { opacity: 0; transform: translate(-50%, calc(-50% + 12px)); }
          to   { opacity: 1; transform: translate(-50%, -50%); }
        }
      `}</style>
    </>
  )
}
