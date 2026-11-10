import React, { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { X, Clock } from 'lucide-react'
import { useDownloadStore } from '../store/useDownloadStore'

interface QueueSchedule {
  enabled: boolean
  startTime: string // HH:mm
  endTime: string   // HH:mm
  days: number[]    // 0 = Sunday … 6 = Saturday
}

interface DownloadQueue {
  id: string
  name: string
  downloadIds: string[]
  maxConcurrent: number
  enabled: boolean
  schedule: QueueSchedule | null
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DEFAULT_SCHEDULE: QueueSchedule = {
  enabled: true,
  startTime: '01:00',
  endTime: '07:00',
  days: [0, 1, 2, 3, 4, 5, 6],
}

/** Pure validation so the rules are easy to test and the UI never sends a nonsense schedule. */
export function validateSchedule(s: QueueSchedule): string | null {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
  if (!hhmm.test(s.startTime) || !hhmm.test(s.endTime)) return 'Enter the start and end time as HH:MM.'
  if (s.startTime === s.endTime) return 'Start and end time must be different.'
  if (s.days.length === 0) return 'Select at least one day.'
  return null
}

export function SchedulerDialog() {
  const { setShowScheduler } = useDownloadStore()
  const [queue, setQueue] = useState<DownloadQueue | null>(null)
  const [schedule, setSchedule] = useState<QueueSchedule>(DEFAULT_SCHEDULE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const close = () => setShowScheduler(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const queues = await invoke<DownloadQueue[]>('queue_get_all')
        if (cancelled) return
        const q = queues.find((x) => x.name === 'Default Queue') ?? queues[0] ?? null
        setQueue(q)
        if (q?.schedule) setSchedule(q.schedule)
        if (!q) setError('The download queue is still starting. Close this window and try again in a moment.')
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const toggleDay = (d: number) =>
    setSchedule((s) => ({
      ...s,
      days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d].sort(),
    }))

  const save = async (next: QueueSchedule | null) => {
    if (!queue) return
    if (next) {
      const problem = validateSchedule(next)
      if (problem) { setError(problem); return }
    }
    setSaving(true)
    setError(null)
    try {
      const ok = await invoke<boolean>('queue_set_schedule', { queueId: queue.id, schedule: next })
      if (!ok) throw new Error('The queue no longer exists.')
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
      onKeyDown={(e) => { if (e.key === 'Escape') close() }}
      role="dialog"
      aria-modal="true"
      aria-label="Scheduler"
    >
      <div className="bg-ng-surface border border-ng-border rounded-xl shadow-2xl w-[460px] max-w-[94vw] p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-ng-text">
            <Clock className="w-4 h-4 text-ng-accent" />
            <span className="font-semibold text-sm">Scheduler</span>
          </div>
          <button type="button" onClick={close} aria-label="Close" className="text-ng-textMuted hover:text-ng-text rounded p-0.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-ng-textMuted mb-4 leading-relaxed">
          While NetGuard is running (it can sit in the system tray), the queue starts automatically when the
          window opens and stops when it closes. The queue is every unfinished download.
          If NetGuard is not running at the start time, the queue starts when it is next launched inside the window.
        </p>

        {loading ? (
          <div className="text-xs text-ng-textMuted py-6 text-center">Loading…</div>
        ) : (
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-xs text-ng-text cursor-pointer select-none">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked })}
                className="accent-[rgb(var(--ng-accent))]"
              />
              Enable the schedule
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-[11px] text-ng-textSecondary">
                Start at
                <input
                  type="time"
                  value={schedule.startTime}
                  onChange={(e) => setSchedule({ ...schedule, startTime: e.target.value })}
                  className="input-ng mt-1"
                />
              </label>
              <label className="text-[11px] text-ng-textSecondary">
                Stop at
                <input
                  type="time"
                  value={schedule.endTime}
                  onChange={(e) => setSchedule({ ...schedule, endTime: e.target.value })}
                  className="input-ng mt-1"
                />
              </label>
            </div>

            <div>
              <div className="text-[11px] text-ng-textSecondary mb-1.5">Days</div>
              <div className="flex gap-1.5 flex-wrap">
                {DAY_LABELS.map((label, d) => {
                  const on = schedule.days.includes(d)
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleDay(d)}
                      className={`px-2.5 h-7 rounded-md text-[11px] border transition-colors ${
                        on
                          ? 'bg-ng-accent/15 border-ng-accent/40 text-ng-accent'
                          : 'border-ng-border text-ng-textMuted hover:text-ng-text'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              <p className="text-[10px] text-ng-textMuted mt-1.5">
                A window that crosses midnight (e.g. 23:00 – 06:00) is matched against the day it is currently on.
              </p>
            </div>
          </div>
        )}

        {error && <div role="alert" className="mt-4 text-xs text-ng-danger">{error}</div>}

        <div className="flex items-center justify-between gap-2 mt-6">
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={saving || !queue || !queue.schedule}
            onClick={() => save(null)}
            title="Remove the schedule completely"
          >
            Remove schedule
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={close}>Cancel</button>
            <button type="button" className="btn-primary" disabled={saving || !queue} onClick={() => save(schedule)}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
