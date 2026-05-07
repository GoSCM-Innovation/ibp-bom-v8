import { useState, useEffect, useRef } from 'react'
import { proxyCall } from '../../services/proxyCall'

function enc(val) {
  return `%27${encodeURIComponent(val)}%27`
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
}

function labelOf(name, labelMap) {
  return labelMap?.[name] ?? PARAM_LABEL[name] ?? name
}

const SECTION_ORDER = ['General', 'Control Parameters', 'Planning Start Settings', 'Planning Scope']

export default function ScheduleModal({ row, connection, session, onClose, onSuccess }) {
  const [loading, setLoading]             = useState(true)
  const [loadError, setLoadError]         = useState('')
  // steps: [{ seqPos, basicJceName, catalogText, params: [{stepNr, name, label, group, mandatory, readOnly, changeAble}] }]
  const [steps, setSteps]                 = useState([])
  const [formValues, setFormValues]       = useState({})
  const [dynHidden, setDynHidden]         = useState(new Set())
  const [dynReadOnly, setDynReadOnly]     = useState(new Set())
  const [expandedStep, setExpandedStep]   = useState(null)
  const [showOptByStep, setShowOptByStep] = useState({})
  const [jobText, setJobText]             = useState('')
  const [executing, setExecuting]         = useState(false)
  const [execError, setExecError]         = useState('')

  const formValuesRef = useRef({})
  const stepsRef      = useRef([])
  formValuesRef.current = formValues

  const templateLabel = row.JobTemplateText || row.JobTemplateName

  // ── Schedule check ──────────────────────────────────────────────────────────
  async function doScheduleCheck(currentValues, currentSteps) {
    const values   = currentValues  ?? formValuesRef.current
    const allSteps = currentSteps   ?? stepsRef.current
    const allParams = allSteps.flatMap(s => s.params)
    if (!allParams.length) return

    const checkVals = allParams
      .filter(p => {
        const fv = values[`${p.stepNr}|${p.name}`]
        return fv?.low?.trim() || fv?.high?.trim()
      })
      .map(p => {
        const fv = values[`${p.stepNr}|${p.name}`]
        return {
          NAME:    p.name,
          T_VALUE: [{ SIGN: fv.sign || 'I', OPTION: fv.option || 'EQ', LOW: fv.low || '', HIGH: fv.high || '' }],
        }
      })

    try {
      const r = await proxyCall({
        connection, session,
        path:   `/JobScheduleCheck?JobTemplateName=${enc(row.JobTemplateName)}&JobParameterValues=${enc(JSON.stringify({ VALUES: checkVals }))}`,
        method: 'POST',
      })
      const data = await r.json()
      const d = data?.d ?? {}

      const dp = JSON.parse(d.DynamicProperties || '[]')
      const newHidden   = new Set()
      const newReadOnly = new Set()
      dp.forEach(p => {
        if (p.hidden)   newHidden.add(p.jobParameterName)
        if (p.readOnly) newReadOnly.add(p.jobParameterName)
      })
      setDynHidden(newHidden)
      setDynReadOnly(newReadOnly)

      if (d.ChangedInd) {
        const returned = JSON.parse(d.JobParameterValues || '{"VALUES":[]}')
        setFormValues(prev => {
          const updated = { ...prev }
          ;(returned.VALUES ?? []).forEach(v => {
            const param = allParams.find(p => p.name === v.NAME)
            if (!param) return
            const key   = `${param.stepNr}|${param.name}`
            const first = v.T_VALUE?.[0]
            if (!updated[key]?.low?.trim() && first?.LOW) {
              updated[key] = { low: first.LOW ?? '', high: first.HIGH ?? '', option: first.OPTION ?? 'EQ', sign: first.SIGN ?? 'I' }
            }
          })
          return updated
        })
      }
    } catch { /* silencioso */ }
  }

  // ── Initial load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true); setLoadError(''); setSteps([]); setFormValues({})
    setDynHidden(new Set()); setDynReadOnly(new Set())
    setExpandedStep(null); setShowOptByStep({}); setExecError('')
    setJobText(row.JobTemplateText || row.JobTemplateName)

    const name = row.JobTemplateName

    Promise.all([
      proxyCall({ connection, session, path: `/JobTemplateRead?JobTemplateName=${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/JobTemplateParameterSet?$filter=JobTemplateName+eq+${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/JobTemplateParamGroupSet?$filter=JobTemplateName+eq+${enc(name)}` }).then(r => r.json()),
      proxyCall({ connection, session, path: `/TemplateValuesGet?JobTemplateName=${enc(name)}` }).then(r => r.json()),
    ]).then(async ([tplData, pData, gData, tvData]) => {
      const pParams = pData?.d?.results ?? pData?.value ?? []
      const groups  = gData?.d?.results ?? gData?.value ?? []

      // Grupo → texto legible
      const groupText = {}
      groups.forEach(g => { groupText[g.JobTemplateParamGroupName] = g.JobTemplateParamGroupText })

      // Flags por parámetro desde JobTemplateParameterSet
      const groupByParam = {}
      const mandatorySet = new Set()
      const readOnlySet  = new Set()
      const hiddenSetApi = new Set()
      pParams.forEach(p => {
        groupByParam[p.JobTemplateParameterName] = p.JobTemplateParamGroupName
        if (p.JobTempParamMandatoryInd === 'X') mandatorySet.add(p.JobTemplateParameterName)
        if (p.JobTempParamReadOnlyInd  === 'X') readOnlySet.add(p.JobTemplateParameterName)
        if (p.JobTempParamHiddenInd    === 'X') hiddenSetApi.add(p.JobTemplateParameterName)
      })

      // Valores pre-configurados desde TemplateValuesGet
      // Clave: "${STEP_NR}|${NAME}" — NAME es el nombre corto (sin step ID), STEP_NR identifica el paso
      const prefilledValues = {}
      try {
        const tvParsed = JSON.parse(tvData?.d?.ParameterValues ?? 'null')
        ;(tvParsed?.VALUES ?? []).forEach(v => {
          const first = v.T_VALUE?.[0]
          if (first != null) {
            const tvKey = `${v.STEP_NR ?? 1}|${v.NAME}`
            prefilledValues[tvKey] = { low: first.LOW ?? '', high: first.HIGH ?? '', option: first.OPTION ?? 'EQ', sign: first.SIGN ?? 'I' }
          }
        })
      } catch { /* ignorar */ }

      // Secuencias desde TemplateData
      let sequences = []
      try {
        const td = JSON.parse(tplData?.d?.TemplateData ?? 'null')
        sequences = td?.templates?.[0]?.sequences ?? []
      } catch { /* fall through */ }

      // Cargar texto legible de cada catálogo de paso en paralelo
      const distinctCatalogs = [...new Set(sequences.map(s => s.basic_jce_name).filter(Boolean))]
      const catalogTexts = {}
      await Promise.all(distinctCatalogs.map(async cat => {
        try {
          const catData = await proxyCall({ connection, session, path: `/JobTemplateRead?JobTemplateName=${enc(cat)}` }).then(r => r.json())
          const catTd   = JSON.parse(catData?.d?.TemplateData ?? 'null')
          const text    = catTd?.templates?.[0]?.text
          if (text) catalogTexts[cat] = text
        } catch { /* fallback al nombre técnico */ }
      }))

      // Construir steps desde sequences (TemplateData)
      let finalSteps = []
      if (sequences.length > 0) {
        finalSteps = sequences.map((seq, idx) => {
          const stepNr   = idx + 1
          const rawParams = seq.seq_param_val ?? []
          const labelMap  = {}
          rawParams.forEach(p => { if (p.label) labelMap[p.name] = p.label })

          const params = rawParams
            .filter(p => p.hidden !== true && !hiddenSetApi.has(p.name))
            .map(p => ({
              stepNr,
              name:        p.name,
              label:       labelOf(p.name, labelMap),
              group:       groupText[groupByParam[p.name]] ?? null,
              mandatory:   mandatorySet.has(p.name),
              readOnly:    readOnlySet.has(p.name) || p.change_able === false,
              rawDefault:  p.value ?? null,
            }))

          return {
            seqPos:       stepNr,
            basicJceName: seq.basic_jce_name ?? '',
            catalogText:  catalogTexts[seq.basic_jce_name] ?? seq.basic_jce_name ?? `Paso ${stepNr}`,
            params,
          }
        })
      } else if (pParams.length > 0) {
        // Fallback: sin TemplateData, construir desde JobTemplateParameterSet
        finalSteps = [{
          seqPos:       1,
          basicJceName: name,
          catalogText:  row.JobTemplateText || name,
          params: pParams
            .filter(p => p.JobTempParamHiddenInd !== 'X')
            .map(p => ({
              stepNr:     1,
              name:       p.JobTemplateParameterName,
              label:      labelOf(p.JobTemplateParameterName, null),
              group:      groupText[p.JobTemplateParamGroupName] ?? null,
              mandatory:  p.JobTempParamMandatoryInd === 'X',
              readOnly:   p.JobTempParamReadOnlyInd  === 'X',
              rawDefault: p.JobTempParamDefaultVal ? { low: p.JobTempParamDefaultVal, high: '', option: 'EQ', sign: 'I' } : null,
            })),
        }]
      }

      // Inicializar form: TemplateValuesGet > seq_param_val.value > vacío
      const init = {}
      finalSteps.forEach(step => {
        step.params.forEach(p => {
          const key = `${p.stepNr}|${p.name}`

          // TemplateValuesGet usa nombre corto (posiciones 1-8, recortado) + STEP_NR
          const baseName = p.name.slice(0, 8).trimEnd()
          const tvVal    = prefilledValues[`${p.stepNr}|${baseName}`]

          // seq_param_val.value llega como array [{sign,opt,low}] en la API real
          const rd      = p.rawDefault
          const rdFirst = Array.isArray(rd) ? rd[0] : rd
          const seqDefault = rdFirst != null
            ? { low: rdFirst.low ?? '', high: '', option: rdFirst.opt ?? 'EQ', sign: rdFirst.sign ?? 'I' }
            : null

          init[key] = tvVal ?? seqDefault ?? { low: '', high: '', option: 'EQ', sign: 'I' }
        })
      })

      stepsRef.current = finalSteps
      setFormValues(init)
      setSteps(finalSteps)
      setLoading(false)

      // Auto-expandir si hay un solo step
      if (finalSteps.length === 1) setExpandedStep(1)

      // Check inicial
      doScheduleCheck(init, finalSteps)
    }).catch(e => {
      setLoadError(e.message)
      setLoading(false)
    })
  }, [row.JobTemplateName]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helpers de form ──────────────────────────────────────────────────────────
  function setField(stepNr, name, field, value) {
    const key = `${stepNr}|${name}`
    setFormValues(prev => ({ ...prev, [key]: { ...(prev[key] ?? { low: '', high: '', option: 'EQ', sign: 'I' }), [field]: value } }))
  }

  function handleBlur() { doScheduleCheck() }

  // Calcula estado de validación de un step para los badges
  function stepValidation(step) {
    const visible  = step.params.filter(p => !dynHidden.has(p.name))
    const mandatory = visible.filter(p => p.mandatory)
    const missing   = mandatory.filter(p => !formValues[`${p.stepNr}|${p.name}`]?.low?.trim())
    const filled    = visible.filter(p => formValues[`${p.stepNr}|${p.name}`]?.low?.trim())
    return {
      total:     visible.length,
      mandatory: mandatory.length,
      missing:   missing.length,
      filled:    filled.length,
    }
  }

  // ── Ejecutar ─────────────────────────────────────────────────────────────────
  async function handleExecute() {
    // Abrir el primer step con obligatorios faltantes
    const badStep = steps.find(s => stepValidation(s).missing > 0)
    if (badStep) {
      setExpandedStep(badStep.seqPos)
      setExecError(`Paso ${badStep.seqPos}: hay campos obligatorios sin valor`)
      return
    }

    setExecuting(true)
    setExecError('')

    const paramValues = steps.flatMap(s => s.params)
      .filter(p => {
        const fv = formValues[`${p.stepNr}|${p.name}`]
        return fv?.low?.trim() || fv?.high?.trim()
      })
      .map(p => {
        const fv = formValues[`${p.stepNr}|${p.name}`] ?? { low: '', high: '', option: 'EQ', sign: 'I' }
        return { StepNr: p.stepNr, JobParameterName: p.name, Sign: fv.sign || 'I', Option: fv.option || 'EQ', Low: fv.low ?? '', High: fv.high ?? '' }
      })

    let path = `/JobSchedule?JobTemplateName=${enc(row.JobTemplateName)}&JobText=${enc(jobText || templateLabel)}`
    if (paramValues.length > 0) path += `&JobParameterValues=${enc(JSON.stringify(paramValues))}`

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

  // ── Render de un parámetro ───────────────────────────────────────────────────
  function renderParam(p) {
    const key    = `${p.stepNr}|${p.name}`
    const fv     = formValues[key] ?? { low: '', high: '', option: 'EQ', sign: 'I' }
    const isRange = fv.option === 'BT'
    const isRO   = p.readOnly || dynReadOnly.has(p.name)
    const isMissingMandatory = p.mandatory && !fv.low?.trim()

    return (
      <div key={key}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text)', fontWeight: 500 }}>
              {p.label}
              {p.mandatory && <span style={{ color: '#ff6b6b', marginLeft: 3 }}>*</span>}
            </span>
            {p.label !== p.name && (
              <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{p.name}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={fv.option} disabled={isRO}
              onChange={e => setField(p.stepNr, p.name, 'option', e.target.value)}
              onBlur={handleBlur}
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text2)', fontSize: 10, padding: '5px 6px', cursor: isRO ? 'default' : 'pointer', flexShrink: 0, width: 52 }}
            >
              <option value="EQ">=</option>
              <option value="NE">≠</option>
              <option value="LT">&lt;</option>
              <option value="LE">≤</option>
              <option value="GT">&gt;</option>
              <option value="GE">≥</option>
              <option value="BT">…</option>
              <option value="CP">~</option>
            </select>
            <input
              type="text" value={fv.low} disabled={isRO}
              placeholder={p.mandatory ? 'requerido' : ''}
              onChange={e => setField(p.stepNr, p.name, 'low', e.target.value)}
              onBlur={handleBlur}
              style={{
                flex: 1, background: 'var(--bg2)',
                border: `1px solid ${isMissingMandatory ? 'rgba(255,107,107,.5)' : 'var(--border)'}`,
                borderRadius: 5, color: 'var(--text)', fontSize: 11,
                padding: '6px 10px', outline: 'none', opacity: isRO ? 0.5 : 1,
              }}
            />
            {isRange && (
              <>
                <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>→</span>
                <input
                  type="text" value={fv.high} disabled={isRO} placeholder="hasta"
                  onChange={e => setField(p.stepNr, p.name, 'high', e.target.value)}
                  onBlur={handleBlur}
                  style={{ flex: 1, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', fontSize: 11, padding: '6px 10px', outline: 'none' }}
                />
              </>
            )}
          </div>
        </label>
      </div>
    )
  }

  // ── Contenido expandido de un step ───────────────────────────────────────────
  function renderStepContent(step) {
    const isShowOpt = !!showOptByStep[step.seqPos]
    const visible   = step.params.filter(p => !dynHidden.has(p.name))

    if (visible.length === 0) {
      return (
        <div style={{ padding: '14px', fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>
          Sin parámetros configurables para este paso.
        </div>
      )
    }

    const primary  = visible.filter(p => p.mandatory || formValues[`${p.stepNr}|${p.name}`]?.low?.trim())
    const optional = visible.filter(p => !p.mandatory && !formValues[`${p.stepNr}|${p.name}`]?.low?.trim())
    const forceAll = primary.length === 0
    const display  = forceAll ? visible : (isShowOpt ? visible : primary)

    // Agrupar por sección
    const grouped   = {}
    const ungrouped = []
    display.forEach(p => {
      if (p.group) { if (!grouped[p.group]) grouped[p.group] = []; grouped[p.group].push(p) }
      else ungrouped.push(p)
    })
    const ordered = [
      ...SECTION_ORDER.filter(s => grouped[s]),
      ...Object.keys(grouped).filter(s => !SECTION_ORDER.includes(s)),
    ]
    if (ungrouped.length) ordered.push(null)

    return (
      <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {ordered.map(sec => {
          const list = sec ? grouped[sec] : ungrouped
          if (!list?.length) return null
          return (
            <div key={sec ?? '__ungrouped'}>
              {sec && (
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10, paddingBottom: 5, borderBottom: '1px solid var(--border)' }}>
                  {sec}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {list.map(renderParam)}
              </div>
            </div>
          )
        })}

        {!forceAll && optional.length > 0 && (
          <button
            onClick={() => setShowOptByStep(prev => ({ ...prev, [step.seqPos]: !prev[step.seqPos] }))}
            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text3)', fontSize: 11, cursor: 'pointer', padding: '7px 14px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span style={{ fontSize: 10 }}>{isShowOpt ? '▲' : '▼'}</span>
            {isShowOpt ? `Ocultar opcionales (${optional.length})` : `Mostrar opcionales (${optional.length})`}
          </button>
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
        width: 'min(580px, 95vw)', maxHeight: '88vh',
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
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Configurar y ejecutar job</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{templateLabel}</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{row.JobTemplateName}</div>
            </div>
            <button
              onClick={executing ? undefined : onClose}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', fontSize: 13, cursor: 'pointer', padding: '4px 10px', lineHeight: 1, flexShrink: 0 }}
            >✕</button>
          </div>

          {/* JobText editable */}
          {!loading && !loadError && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
                Texto del job
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
              Este template no tiene parámetros configurables.
            </div>
          )}

          {!loading && !loadError && steps.map(step => {
            const isOpen = expandedStep === step.seqPos
            const val    = stepValidation(step)
            const hasErr = val.missing > 0
            const allOk  = val.mandatory > 0 && val.missing === 0

            // Título: CatalogText + P_OPNAME si está pre-rellenado
            const opNameParam = step.params.find(p => p.name.startsWith('P_OPNAME'))
            const opName      = opNameParam ? formValues[`${step.seqPos}|${opNameParam.name}`]?.low?.trim() : null
            const stepTitle   = opName ? `${step.catalogText}: ${opName}` : step.catalogText

            return (
              <div key={step.seqPos} style={{
                marginBottom: 8, borderRadius: 8, overflow: 'hidden',
                border: `1px solid ${isOpen ? 'var(--border2)' : 'var(--border)'}`,
                background: isOpen ? 'var(--bg2)' : 'transparent',
                transition: 'border-color .15s',
              }}>

                {/* Fila colapsada del step */}
                <div
                  onClick={() => setExpandedStep(prev => prev === step.seqPos ? null : step.seqPos)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', userSelect: 'none' }}
                >
                  {/* Círculo numerado con estado */}
                  <span style={{
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700,
                    background: hasErr ? 'rgba(255,107,107,.15)' : allOk ? 'rgba(34,197,94,.15)' : 'var(--bg3)',
                    border:     `1px solid ${hasErr ? 'rgba(255,107,107,.4)' : allOk ? 'rgba(34,197,94,.4)' : 'var(--border)'}`,
                    color:      hasErr ? '#ff6b6b' : allOk ? '#22c55e' : 'var(--text2)',
                  }}>{step.seqPos}</span>

                  {/* Título + nombre técnico */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {stepTitle}
                    </div>
                    {step.catalogText !== step.basicJceName && step.basicJceName && (
                      <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 1 }}>
                        {step.basicJceName}
                      </div>
                    )}
                  </div>

                  {/* Badges de validación */}
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
                    {hasErr && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: '#ff6b6b', background: 'rgba(255,107,107,.12)', border: '1px solid rgba(255,107,107,.3)', borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }}>
                        ⚠ {val.missing} obligatorio{val.missing !== 1 ? 's' : ''}
                      </span>
                    )}
                    {allOk && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)', borderRadius: 3, padding: '2px 6px' }}>
                        ✓
                      </span>
                    )}
                    {val.filled > 0 && (
                      <span style={{ fontSize: 9, color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }}>
                        {val.filled}/{val.total}
                      </span>
                    )}
                    {val.filled === 0 && val.total > 0 && (
                      <span style={{ fontSize: 9, color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }}>
                        {val.total} param{val.total !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>

                  <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0, marginLeft: 2 }}>
                    {isOpen ? '▲' : '▼'}
                  </span>
                </div>

                {/* Contenido expandido */}
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
            {!loading && steps.length > 1 && (
              <span style={{ fontSize: 10, color: 'var(--text3)', marginRight: 'auto' }}>
                {steps.length} pasos
                {steps.some(s => stepValidation(s).missing > 0)
                  ? <span style={{ color: '#ff6b6b', marginLeft: 6 }}>— obligatorios incompletos</span>
                  : steps.every(s => stepValidation(s).mandatory === 0 || stepValidation(s).missing === 0)
                    ? <span style={{ color: '#22c55e', marginLeft: 6 }}>— listos</span>
                    : null
                }
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
