import React, { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Plus, Play, Square, Trash2, Search, X, CheckCircle2,
  ChevronsRight, StopCircle, Clock, Terminal,
} from 'lucide-react'
import { useDownloadStore } from '../store/useDownloadStore'

type Tone = 'accent' | 'warning' | 'danger' | 'success' | 'muted'

const TONE_CLASS: Record<Tone, string> = {
  accent: 'hover:text-ng-accent hover:bg-ng-accent/10',
  warning: 'hover:text-ng-warning hover:bg-ng-warning/10',
  danger: 'hover:text-ng-danger hover:bg-ng-danger/10',
  success: 'hover:text-ng-success hover:bg-ng-success/10',
  muted: 'hover:text-ng-text hover:bg-ng-surfaceHover',
}

/** Icon-over-label toolbar button in the classic download-manager style. */
function ToolButton({
  icon, label, title, onClick, disabled, tone = 'muted', badge,
}: {
  icon: React.ReactNode
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
  tone?: Tone
  badge?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`relative flex flex-col items-center justify-center gap-0.5 min-w-[44px] px-2 h-11 rounded-lg
        text-ng-textSecondary transition-colors disabled:opacity-35 disabled:cursor-not-allowed
        disabled:hover:bg-transparent disabled:hover:text-ng-textSecondary ${TONE_CLASS[tone]}`}
    >
      {icon}
      <span className="text-[10px] leading-none whitespace-nowrap hidden lg:inline">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-ng-accent/25 text-ng-accent text-[9px] font-mono leading-[14px] text-center">
          {badge}
        </span>
      )}
    </button>
  )
}

function Divider() {
  return <div className="w-px h-7 bg-ng-border mx-1 shrink-0" />
}

export function Toolbar() {
  const {
    selectedIds, downloads, searchQuery, setSearchQuery,
    setShowNewDownload, setShowScheduler, clearSelection, removeDownloadFromList,
    ytdlpLogs, setShowYtdlpLogs,
  } = useDownloadStore()

  const [showSearch, setShowSearch] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = downloads.filter((d) => selectedIds.has(d.id))
  const canResumeSel = selected.some((d) => d.status === 'paused' || d.status === 'failed')
  const canStopSel = selected.some((d) => d.status === 'downloading' || d.status === 'queued')

  const running = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued')
  const resumable = downloads.filter((d) => d.status === 'paused' || d.status === 'failed')
  const completed = downloads.filter((d) => d.status === 'completed')

  /** Run a backend action and surface failures instead of silently swallowing them. */
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null)
      await fn()
    } catch (e) {
      setError(typeof e === 'string' ? e : (e as Error)?.message ?? 'Action failed')
    }
  }

  const resumeSelected = () => run(async () => {
    for (const d of selected) {
      if (d.status === 'paused' || d.status === 'failed') await invoke('download_resume', { id: d.id })
    }
  })

  // "Stop" keeps the partial data: the download can be resumed later from where it stopped.
  const stopSelected = () => run(async () => {
    for (const d of selected) {
      if (d.status === 'downloading' || d.status === 'queued') await invoke('download_pause', { id: d.id })
    }
  })

  const removeSelected = () => run(async () => {
    for (const d of selected) {
      await invoke('download_remove', { id: d.id, deleteFile: false })
      removeDownloadFromList(d.id)
    }
    clearSelection()
  })

  // Removes finished items from the list only; the downloaded files are never deleted.
  const deleteCompleted = () => run(async () => {
    for (const d of completed) {
      await invoke('download_remove', { id: d.id, deleteFile: false })
      removeDownloadFromList(d.id)
    }
  })

  // The queue is every unfinished download (see the Scheduler dialog).
  const startQueue = () => run(() => invoke('download_resume_all'))
  const stopQueue = () => run(() => invoke('download_pause_all'))

  const clearSearch = () => {
    setSearchQuery('')
    setShowSearch(false)
  }

  return (
    <div className="shrink-0 border-b border-ng-border bg-ng-surface/30">
      <div className="h-14 flex items-center px-3 gap-0.5 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowNewDownload(true)}
          className="btn-primary flex items-center gap-1.5 h-9 px-3 text-xs shadow-lg shadow-ng-accent/20 shrink-0"
          title="Add a new download (Ctrl+N)"
        >
          <Plus size={14} />
          <span>Add URL</span>
        </button>

        <Divider />

        <ToolButton icon={<Play size={16} />} label="Resume" tone="accent"
          title="Resume the selected downloads" onClick={resumeSelected} disabled={!canResumeSel} />
        <ToolButton icon={<Square size={15} />} label="Stop" tone="warning"
          title="Stop the selected downloads (keeps the data so they can be resumed)"
          onClick={stopSelected} disabled={!canStopSel} />
        <ToolButton icon={<Trash2 size={16} />} label="Remove" tone="danger"
          title="Remove the selected downloads from the list (files are kept)"
          onClick={removeSelected} disabled={selected.length === 0} />
        <ToolButton icon={<CheckCircle2 size={16} />} label="Delete Completed" tone="success"
          title="Remove all completed downloads from the list (files are kept)"
          onClick={deleteCompleted} disabled={completed.length === 0} badge={completed.length} />

        <Divider />

        <ToolButton icon={<ChevronsRight size={16} />} label="Start Queue" tone="accent"
          title="Start the queue: resume every paused or failed download"
          onClick={startQueue} disabled={resumable.length === 0} badge={resumable.length} />
        <ToolButton icon={<StopCircle size={16} />} label="Stop Queue" tone="warning"
          title="Stop the queue: stop every running and waiting download"
          onClick={stopQueue} disabled={running.length === 0} badge={running.length} />
        <ToolButton icon={<Clock size={16} />} label="Scheduler" tone="accent"
          title="Schedule when the queue starts and stops" onClick={() => setShowScheduler(true)} />

        <div className="flex-1" />

        <ToolButton icon={<Terminal size={16} />} label="Logs" title="Application logs"
          onClick={() => setShowYtdlpLogs(true)} badge={ytdlpLogs.length} />

        {showSearch || searchQuery ? (
          <div className="relative animate-fade-in ml-1">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ng-textMuted" />
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search downloads..."
              className="input-ng pl-7 pr-7 w-44 text-xs h-8"
              onKeyDown={(e) => e.key === 'Escape' && clearSearch()}
            />
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ng-textMuted hover:text-ng-text"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowSearch(true)}
            className="p-2 rounded-lg text-ng-textMuted hover:text-ng-text hover:bg-ng-surfaceHover transition-colors"
            title="Search downloads"
            aria-label="Search downloads"
          >
            <Search size={15} />
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 px-4 py-1 text-[11px] bg-ng-danger/10 text-ng-danger border-t border-ng-danger/20">
          <span className="truncate">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="hover:text-ng-text">
            <X size={11} />
          </button>
        </div>
      )}
    </div>
  )
}
