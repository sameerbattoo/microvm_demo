import { useState, useEffect, useRef, useCallback } from 'react'
import { PROXY_URL } from '../config'
import { logError } from '../services/logger'

/**
 * useInstances — owns MicroVM instance state and lifecycle. This is THE single
 * source of truth for VM state: it polls /instances, reconciles tab connection
 * status (auto-connect / rotation / termination), tracks per-VM metrics, and
 * exposes the lifecycle actions (attach/resume/suspend/terminate/terminate+save).
 *
 * Tab mutations are threaded in via setTabs/setActiveTabId/setModal/createTab so
 * this hook can keep tabs in sync without owning them.
 */
export function useInstances({ tabs, setTabs, setActiveTabId, setModal, createTab, pollIntervalMs }) {
  const [instances, setInstances] = useState({})
  const [vmMetrics, setVmMetrics] = useState({})  // microvm_id -> latest metrics
  const prevInstancesRef = useRef({})

  // Fetch metrics for a specific VM (called after cell execution, not on a timer)
  const refreshMetrics = useCallback(async (microvmId) => {
    if (!microvmId) return
    try {
      const resp = await fetch(`${PROXY_URL}/instances/metrics?microvm_id=${microvmId}`)
      if (resp.ok) {
        const data = await resp.json()
        if (data.metrics) setVmMetrics(prev => ({ ...prev, ...data.metrics }))
      }
    } catch (e) { logError('fetchInstances', e) }
  }, [])

  // Fetch instances periodically — this is THE SINGLE SOURCE OF TRUTH for VM state.
  // No copies (_vmState) are stored on tabs. Components derive state from `instances[tab.microvmId]`.
  const fetchInstances = useCallback(async () => {
    try {
      const resp = await fetch(`${PROXY_URL}/instances`)
      if (resp.ok) {
        const data = await resp.json()
        const inst = data.instances || {}
        setInstances(inst)

        // Only sync connection-related info on tabs (endpoint, status)
        // NOT vm state — that comes from `instances` directly
        setTabs(prev => {
          const prevInst = prevInstancesRef.current
          let changed = false
          const updated = prev.map(tab => {
            if (tab.microvmId && inst[tab.microvmId]) {
              const vmState = inst[tab.microvmId].state || 'UNKNOWN'
              const endpoint = inst[tab.microvmId].endpoint

              // Auto-connect: tab has a VM that is RUNNING/SUSPENDED but tab is not connected
              if ((tab.status === 'connecting' || tab.status === 'disconnected') && (vmState === 'RUNNING' || vmState === 'SUSPENDED') && endpoint) {
                changed = true
                return {
                  ...tab,
                  microvmEndpoint: `${PROXY_URL}/proxy`,
                  microvmMemory: inst[tab.microvmId].memory_mib || tab.microvmMemory,
                  status: 'connected',
                  mode: 'microvm',
                }
              }
            } else if (tab.microvmId && !inst[tab.microvmId]) {
              // VM not in instances → might be terminated OR rotated to a new VM
              // Don't interfere with a tab that's currently launching a new VM
              if (tab.status === 'launching') return tab

              // Check if rotation happened — look for a new VM with our session_id
              if (tab.sessionId) {
                const rotatedVm = Object.entries(inst).find(([, info]) => info.session_id === tab.sessionId)
                if (rotatedVm) {
                  // Rotation completed — update tab to point to new VM
                  const [newVmId, newInfo] = rotatedVm
                  changed = true
                  return {
                    ...tab,
                    microvmId: newVmId,
                    microvmEndpoint: `${PROXY_URL}/proxy`,
                    status: 'connected',
                  }
                }
              }

              // Not rotation — actual termination
              const updates = {
                status: 'disconnected',
                microvmEndpoint: null,
                sessionSaved: true,
              }
              if (tab.status !== 'disconnected' || !tab.sessionSaved) {
                changed = true
                return { ...tab, ...updates }
              }
            }
            return tab
          })
          prevInstancesRef.current = inst
          return changed ? updated : prev
        })
      }
    } catch {
      // Proxy not available
    }
  }, [])

  // Helper: immediately update a single VM's state in the instances map
  // Used after successful cell execution on a suspended VM (don't wait for poll)
  const markVmRunning = useCallback((microvmId) => {
    setInstances(prev => {
      if (!prev[microvmId]) return prev
      if (prev[microvmId].state === 'RUNNING') return prev
      return { ...prev, [microvmId]: { ...prev[microvmId], state: 'RUNNING' } }
    })
  }, [])

  useEffect(() => {
    fetchInstances()
    const interval = setInterval(fetchInstances, pollIntervalMs)

    // Metrics are NOT polled continuously — that would keep VMs awake.
    // Instead, metrics are fetched on-demand after cell execution via refreshMetrics().

    return () => { clearInterval(interval) }
  }, [fetchInstances, pollIntervalMs])

  const attachInstance = useCallback((microvmId, endpoint, memoryMib) => {
    const tab = createTab(`VM-${microvmId.replace('microvm-', '').slice(0, 8)}`)
    tab.microvmId = microvmId
    tab.microvmEndpoint = `${PROXY_URL}/proxy`
    tab.microvmMemory = memoryMib || 4096
    tab.status = 'connected'
    tab.mode = 'microvm'
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [])

  const resumeInstance = useCallback(async (microvmId) => {
    const sessionId = instances[microvmId]?.session_id
    if (!sessionId) return
    try {
      await fetch(`${PROXY_URL}/resume`, { method: 'POST', headers: { 'X-Session-Id': sessionId } })
      fetchInstances()
    } catch (e) { logError('resumeVM', e) }
  }, [fetchInstances, instances])

  const terminateInstance = useCallback(async (microvmId) => {
    // Check if attached to a notebook
    const attachedTab = tabs.find(t => t.microvmId === microvmId)
    if (attachedTab) {
      setModal({
        type: 'cannotTerminate',
        microvmId,
        notebookName: attachedTab.name,
      })
      return
    }
    setModal({ type: 'terminateInstance', microvmId })
  }, [tabs])

  const confirmTerminateInstance = useCallback(async (microvmId) => {
    setModal(null)
    try {
      const sid = instances[microvmId]?.session_id
      if (sid) await fetch(`${PROXY_URL}/terminate`, { method: 'POST', headers: { 'X-Session-Id': sid } })
      fetchInstances()
    } catch (e) { logError('terminateVM', e) }
  }, [fetchInstances, instances])

  // Terminate & Save: terminates attached VM, detaches from notebook but preserves sessionId for restore
  const terminateAndSave = useCallback(async (microvmId) => {
    try {
      const tab = tabs.find(t => t.microvmId === microvmId)
      const sid = tab?.sessionId || instances[microvmId]?.session_id
      if (sid) await fetch(`${PROXY_URL}/terminate`, { method: 'POST', headers: { 'X-Session-Id': sid } })
      // Detach from notebook tab but keep sessionId for restore
      setTabs(prev => prev.map(t => {
        if (t.microvmId !== microvmId) return t
        return {
          ...t,
          microvmId: null,
          microvmEndpoint: null,
          status: 'disconnected',
          mode: null,
          sessionSaved: true, // Signal that checkpoint was saved — enables "Restore Session"
        }
      }))
      fetchInstances()
    } catch {}
  }, [fetchInstances, tabs, instances])

  // Suspend: suspends an attached VM via the AWS API
  const suspendInstance = useCallback(async (microvmId) => {
    try {
      const sid = instances[microvmId]?.session_id || tabs.find(t => t.microvmId === microvmId)?.sessionId
      if (sid) await fetch(`${PROXY_URL}/suspend`, { method: 'POST', headers: { 'X-Session-Id': sid } })
      // Immediately update instances state so UI reflects suspension without waiting for poll
      setInstances(prev => {
        if (!prev[microvmId]) return prev
        return { ...prev, [microvmId]: { ...prev[microvmId], state: 'SUSPENDED' } }
      })
    } catch {}
  }, [instances, tabs])

  return {
    instances,
    vmMetrics,
    refreshMetrics,
    markVmRunning,
    fetchInstances,
    attachInstance,
    resumeInstance,
    terminateInstance,
    confirmTerminateInstance,
    terminateAndSave,
    suspendInstance,
  }
}
