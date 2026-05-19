import { useState, useCallback, useEffect } from 'react'
import { proxyCall } from '../../services/proxyCall'
import { saveRunState, loadRunState, clearRunState } from './useOrchStorage'

const POLL_MS = 5000

const SAP_SUCCESS  = new Set(['F'])
const SAP_WARNING  = new Set(['W'])
const SAP_ERROR    = new Set(['A', 'U'])
const SAP_CANCEL   = new Set(['C', 'D'])
const SAP_TERMINAL = new Set(['F', 'W', 'A', 'U', 'C', 'D', 'K'])

function enc(val) { return `%27${encodeURIComponent(val)}%27` }

function mapSapStatus(code) {
  if (SAP_SUCCESS.has(code)) return 'success'
  if (SAP_WARNING.has(code)) return 'warning'
  if (SAP_ERROR.has(code))   return 'error'
  if (SAP_CANCEL.has(code))  return 'cancelled'
  return 'error'
}

function makeNode(type = 'task', children = null) {
  return {
    status: 'pending', jobName: null, jobRunCount: null, sapStatus: null,
    startedAt: null, finishedAt: null,
    error: null, retryCount: 0,
    ...(type === 'group' ? { children: children || {} } : {}),
  }
}

function initNodes(steps) {
  const nodes = {}
  for (const step of steps) {
    if (step.type === 'group') {
      const children = {}
      for (const child of (step.children || [])) children[child.id] = makeNode('task')
      nodes[step.id] = makeNode('group', children)
    } else {
      nodes[step.id] = makeNode('task')
    }
  }
  return nodes
}

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)) }

// ── Module-level store keyed by connId ────────────────────────────────────────
// Allows cancelRef and runRef to survive component unmount/remount, so:
// - background polling continues when the user navigates away
// - cancel() works correctly after returning to the tab
const _stores = new Map()

function getStore(connId) {
  if (!_stores.has(connId)) {
    _stores.set(connId, { cancelRef: { current: false }, runRef: { current: null }, notify: null })
  }
  return _stores.get(connId)
}

export function useOrchRun(connection, session) {
  const connId = connection.id
  const store = getStore(connId)

  const [run, setRun] = useState(() => {
    if (store.runRef.current) return deepCopy(store.runRef.current)
    return loadRunState(connId)
  })

  // Register this component instance as the active listener.
  // When the component unmounts we unregister, but do NOT cancel the run.
  useEffect(() => {
    store.notify = setRun
    // Sync in case the background loop updated the store while we were away
    if (store.runRef.current) setRun(deepCopy(store.runRef.current))
    return () => { if (store.notify === setRun) store.notify = null }
  }, [connId]) // eslint-disable-line react-hooks/exhaustive-deps

  function flush() {
    const copy = deepCopy(store.runRef.current)
    saveRunState(connId, copy)
    if (store.notify) store.notify(copy)
  }

  function patch(stepId, changes, childId = null) {
    if (!store.runRef.current) return
    if (childId) {
      Object.assign(store.runRef.current.nodes[stepId].children[childId], changes)
    } else {
      Object.assign(store.runRef.current.nodes[stepId], changes)
    }
    flush()
  }

  // ── Schedule a job and return its JobName ──────────────────────────────────
  async function scheduleJob(step) {
    const templateName = step.jobTemplateName
    const jobText = step.jobTemplateText || templateName
    const path = `/JobSchedule?JobTemplateName=${enc(templateName)}&JobText=${enc(jobText)}`

    const r = await proxyCall({ connection, session, path, method: 'POST', injectJobUser: true })
    const data = await r.json()
    if (data?.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''))

    const direct = data?.d?.JobName || data?.d?.JobSchedule?.JobName
    if (direct) return direct

    await new Promise(res => setTimeout(res, 2000))
    const r2 = await proxyCall({ connection, session, path: `/JobHeaderSet?$filter=JobTemplateName+eq+${enc(templateName)}&$orderby=JobPlannedStartDateTime+desc&$top=1` })
    const d2 = await r2.json()
    const jobs = d2?.d?.results ?? d2?.value ?? []
    if (jobs.length === 0) throw new Error(`No se encontró el job programado para ${templateName}`)
    return jobs[0].JobName
  }

  // ── Poll until SAP returns a terminal status ───────────────────────────────
  async function pollUntilDone(step, jobName, stepId, childId = null) {
    const maxRetries    = Number(step.maxRetries || 0)
    const retryDelaySec = Number(step.retryDelaySec || 60)
    const strategy      = step.errorStrategy || 'stop'
    let currentJob      = jobName
    let retryCount      = 0

    while (!store.cancelRef.current) {
      await new Promise(res => setTimeout(res, POLL_MS))
      if (store.cancelRef.current) break

      let sapStatus
      try {
        const r = await proxyCall({ connection, session, path: `/JobHeaderSet?$filter=JobName+eq+${enc(currentJob)}&$top=1` })
        const d = await r.json()
        const jobHeader = (d?.d?.results ?? d?.value ?? [])[0]
        sapStatus = jobHeader?.JobStatus ?? null
        if (jobHeader?.JobRunCount != null) patch(stepId, { jobRunCount: jobHeader.JobRunCount }, childId)
      } catch { continue }

      if (!sapStatus) continue

      patch(stepId, { sapStatus }, childId)

      if (!SAP_TERMINAL.has(sapStatus)) continue

      const orchStatus = mapSapStatus(sapStatus)
      const now = new Date().toISOString()

      if (orchStatus === 'error' && strategy === 'retry' && retryCount < maxRetries) {
        retryCount++
        patch(stepId, { retryCount, error: `Reintentando ${retryCount}/${maxRetries}…` }, childId)
        await new Promise(res => setTimeout(res, retryDelaySec * 1000))
        if (store.cancelRef.current) break
        try {
          currentJob = await scheduleJob(step)
          patch(stepId, { jobName: currentJob, sapStatus: null, status: 'running', error: `Intento ${retryCount}/${maxRetries}` }, childId)
        } catch (e) {
          patch(stepId, { status: 'error', error: e.message, finishedAt: now }, childId)
          return 'error'
        }
        continue
      }

      patch(stepId, {
        status: orchStatus,
        finishedAt: now,
        error: (orchStatus === 'error' || orchStatus === 'cancelled') ? `SAP: ${sapStatus}` : null,
        retryCount,
      }, childId)
      return orchStatus
    }

    const now = new Date().toISOString()
    patch(stepId, { status: 'cancelled', finishedAt: now }, childId)
    return 'cancelled'
  }

  // ── Execute a single task step ─────────────────────────────────────────────
  async function executeTask(step) {
    patch(step.id, { status: 'running', startedAt: new Date().toISOString() })
    let jobName
    try {
      jobName = await scheduleJob(step)
    } catch (e) {
      patch(step.id, { status: 'error', error: e.message, finishedAt: new Date().toISOString() })
      return 'error'
    }
    patch(step.id, { jobName })
    return pollUntilDone(step, jobName, step.id)
  }

  // ── Execute a parallel group ───────────────────────────────────────────────
  async function executeGroup(step) {
    const children = step.children || []
    if (children.length === 0) {
      patch(step.id, { status: 'success', finishedAt: new Date().toISOString() })
      return 'success'
    }

    patch(step.id, { status: 'running', startedAt: new Date().toISOString() })

    const results = await Promise.allSettled(children.map(async child => {
      patch(step.id, { status: 'running', startedAt: store.runRef.current.nodes[step.id].startedAt }, child.id)
      if (store.runRef.current?.nodes[step.id]?.children[child.id]) {
        store.runRef.current.nodes[step.id].children[child.id].status = 'running'
        store.runRef.current.nodes[step.id].children[child.id].startedAt = new Date().toISOString()
        flush()
      }

      let jobName
      try {
        jobName = await scheduleJob(child)
      } catch (e) {
        patch(step.id, { status: 'error', error: e.message, finishedAt: new Date().toISOString() }, child.id)
        return 'error'
      }
      patch(step.id, { jobName }, child.id)
      return pollUntilDone(child, jobName, step.id, child.id)
    }))

    const statuses = results.map(r => r.status === 'fulfilled' ? r.value : 'error')
    const hasCancelled = statuses.some(s => s === 'cancelled')
    const hasError     = statuses.some(s => s === 'error')

    const groupStatus = (store.cancelRef.current || hasCancelled)
      ? 'cancelled'
      : hasError ? 'error' : 'success'

    patch(step.id, { status: groupStatus, finishedAt: new Date().toISOString() })
    return groupStatus
  }

  // ── Main start function ────────────────────────────────────────────────────
  const start = useCallback(async (orch) => {
    if (!orch?.steps?.length) return
    store.cancelRef.current = false

    store.runRef.current = {
      orchId: orch.id,
      orchName: orch.name,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      nodes: initNodes(orch.steps),
    }
    flush()

    let finalStatus = 'success'

    for (let i = 0; i < orch.steps.length; i++) {
      if (store.cancelRef.current) { finalStatus = 'cancelled'; break }

      const step = orch.steps[i]
      const result = step.type === 'group'
        ? await executeGroup(step)
        : await executeTask(step)

      if (store.cancelRef.current) { finalStatus = 'cancelled'; break }

      if (result === 'error') {
        const strategy = step.errorStrategy || 'stop'
        if (strategy === 'stop' || strategy === 'retry') {
          for (let j = i + 1; j < orch.steps.length; j++) {
            store.runRef.current.nodes[orch.steps[j].id].status = 'skipped'
            if (orch.steps[j].type === 'group') {
              for (const child of (orch.steps[j].children || [])) {
                store.runRef.current.nodes[orch.steps[j].id].children[child.id].status = 'skipped'
              }
            }
          }
          flush()
          finalStatus = 'error'
          break
        }
      }
    }

    if (!store.runRef.current) return
    store.runRef.current.status = finalStatus
    store.runRef.current.finishedAt = new Date().toISOString()
    flush()

    if ('Notification' in window && Notification.permission === 'granted') {
      const body = { success: 'Completada correctamente', error: 'Finalizó con errores', cancelled: 'Cancelada' }
      new Notification(orch.name || 'Orquestación', { body: body[finalStatus] || finalStatus })
    }
  }, [connection, session, connId]) // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback(() => {
    store.cancelRef.current = true
    if (store.runRef.current) {
      store.runRef.current.status = 'cancelled'
      store.runRef.current.finishedAt = new Date().toISOString()
      flush()
    }
  }, [connId]) // eslint-disable-line react-hooks/exhaustive-deps

  const reset = useCallback(() => {
    store.cancelRef.current = false
    store.runRef.current = null
    clearRunState(connId)
    if (store.notify) store.notify(null)
    else setRun(null)
  }, [connId]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    run,
    isRunning: run?.status === 'running',
    start,
    cancel,
    reset,
  }
}
