import React from 'react'
import { useDownloadStore } from '../store/useDownloadStore'
import { formatSpeed } from '../utils/format'

/** Bottom status bar: totals, live speed and queue state — all derived from real engine state. */
export function StatusBar() {
  const downloads = useDownloadStore((s) => s.downloads)
  const total = downloads.length
  const active = downloads.filter((d) => d.status === 'downloading' || d.status === 'assembling').length
  const queued = downloads.filter((d) => d.status === 'queued').length
  const completed = downloads.filter((d) => d.status === 'completed').length
  const speed = downloads.filter((d) => d.status === 'downloading').reduce((a, d) => a + (d.speed || 0), 0)
  return (
    <div className="h-7 shrink-0 flex items-center gap-5 px-4 text-[11px] text-ng-textSecondary bg-ng-surface border-t border-ng-border select-none">
      <span>Total: <b className="text-ng-text">{total}</b></span>
      <span>Active: <b className="text-ng-text">{active}</b></span>
      <span>Completed: <b className="text-ng-text">{completed}</b></span>
      <span className="ml-auto">Speed: <b className="text-ng-text tabular-nums">{formatSpeed(speed)}</b></span>
      <span>Queue: <b className="text-ng-text">{queued > 0 ? `${queued} waiting` : active > 0 ? 'running' : 'idle'}</b></span>
    </div>
  )
}
