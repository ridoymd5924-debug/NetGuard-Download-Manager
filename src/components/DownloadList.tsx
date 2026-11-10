import React, { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Play, Pause, Trash2, FolderOpen, RotateCcw, FileDown,
  CheckCircle2, AlertCircle, Clock, Loader2, ExternalLink,
  Copy, Plus, Link2
} from 'lucide-react'
import { useDownloadStore } from '../store/useDownloadStore'
import { formatBytes, formatSpeed, formatEta, formatDateTime, categoryLabel, getFileIcon } from '../utils/format'
import type { DownloadItem, DownloadSegment } from '../types/download'

// ── Status Badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const configs: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    downloading: {
      icon: <Loader2 size={11} className="animate-spin" />,
      label: 'Downloading',
      className: 'bg-ng-accent/15 text-ng-accent border-ng-accent/30'
    },
    completed: {
      icon: <CheckCircle2 size={11} />,
      label: 'Completed',
      className: 'bg-ng-success/15 text-ng-success border-ng-success/30'
    },
    paused: {
      icon: <Pause size={11} />,
      label: 'Paused',
      className: 'bg-ng-warning/15 text-ng-warning border-ng-warning/30'
    },
    failed: {
      icon: <AlertCircle size={11} />,
      label: 'Failed',
      className: 'bg-ng-danger/15 text-ng-danger border-ng-danger/30'
    },
    queued: {
      icon: <Clock size={11} />,
      label: 'Queued',
      className: 'bg-ng-textMuted/15 text-ng-textSecondary border-ng-textMuted/30'
    },
    assembling: {
      icon: <Loader2 size={11} className="animate-spin" />,
      label: 'Assembling',
      className: 'bg-ng-accent/15 text-ng-accent border-ng-accent/30'
    },
    stopped: {
      icon: <AlertCircle size={11} />,
      label: 'Stopped',
      className: 'bg-ng-textMuted/15 text-ng-textSecondary border-ng-textMuted/30'
    },
  }

  const config = configs[status] || configs.stopped

  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${config.className}`}>
      {config.icon}
      {config.label}
    </span>
  )
}

// ── Segment Visualization Bar (XDM/IDM style) ────────────────────────────────
function SegmentBar({ segments, fileSize }: { segments: DownloadSegment[]; fileSize: number }) {
  if (!segments.length || fileSize <= 0) return null

  return (
    <div className="segment-bar mt-1">
      {segments.map((seg) => {
        const left = (seg.offset / fileSize) * 100
        const width = (seg.length / fileSize) * 100
        const progress = seg.length > 0 ? Math.min(1, seg.downloaded / seg.length) : 0

        const colors: Record<number, string> = {
          0: '',
          1: 'bg-ng-accent',
          2: 'bg-ng-success',
          3: 'bg-ng-danger',
        }

        if (seg.state === 0) return null

        return (
          <div
            key={seg.id}
            className={`segment-fill ${colors[seg.state] || ''}`}
            style={{
              left: `${left}%`,
              width: `${width * progress}%`,
              opacity: seg.state === 2 ? 0.7 : 1,
            }}
          />
        )
      })}
    </div>
  )
}

// ── Progress Bar ──────────────────────────────────────────────────────────────
function ProgressBar({ progress, status }: { progress: number; status: string }) {
  const colorMap: Record<string, string> = {
    downloading: 'bg-ng-accent',
    completed: 'bg-ng-success',
    paused: 'bg-ng-warning',
    failed: 'bg-ng-danger',
    assembling: 'bg-purple-400',
  }
  const color = colorMap[status] || 'bg-ng-textMuted'
  const pct = Math.min(100, Math.max(0, progress))

  return (
    <div className="relative w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color} ${status === 'downloading' ? 'progress-bar-animated' : ''}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ── Context Menu ──────────────────────────────────────────────────────────────
interface ContextMenuProps {
  x: number
  y: number
  item: DownloadItem
  onClose: () => void
}

function ContextMenu({ x, y, item, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const isCompleted = item.status === 'completed'
  const isDownloading = item.status === 'downloading'
  const isPaused = item.status === 'paused' || item.status === 'stopped'
  const isFailed = item.status === 'failed'
  const isQueued = item.status === 'queued'
  const { removeDownloadFromList } = useDownloadStore()

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [onClose])

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 200)
  const adjustedY = Math.min(y, window.innerHeight - 320)

  const handleAction = async (action: string) => {
    onClose()

    switch (action) {
      case 'open':
        await invoke('download_open_file', { id: item.id })
        break
      case 'folder':
        await invoke('download_open_folder', { id: item.id })
        break
      case 'pause':
        await invoke('download_pause', { id: item.id })
        break
      case 'resume':
        await invoke('download_resume', { id: item.id })
        break
      case 'retry':
        await invoke('download_retry', { id: item.id })
        break
      case 'copy-url':
        await navigator.clipboard.writeText(item.url)
        break
      case 'delete':
        await invoke('download_remove', { id: item.id, deleteFile: false })
        removeDownloadFromList(item.id)
        break
      case 'delete-file':
        await invoke('download_remove', { id: item.id, deleteFile: true })
        removeDownloadFromList(item.id)
        break
    }
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] bg-ng-surface border border-ng-border rounded-lg shadow-2xl py-1 min-w-[180px] text-sm"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {isCompleted && (
        <>
          <MenuItem icon={<ExternalLink size={13} />} label="Open File" onClick={() => handleAction('open')} />
          <MenuItem icon={<FolderOpen size={13} />} label="Open Folder" onClick={() => handleAction('folder')} />
          <Divider />
        </>
      )}
      {!isCompleted && (
        <MenuItem icon={<FolderOpen size={13} />} label="Open Folder" onClick={() => handleAction('folder')} />
      )}
      {(isDownloading || isQueued) && (
        <MenuItem icon={<Pause size={13} />} label="Stop" onClick={() => handleAction('pause')} />
      )}
      {isPaused && (
        <MenuItem icon={<Play size={13} />} label="Resume" onClick={() => handleAction('resume')} accent />
      )}
      {isFailed && (
        <MenuItem icon={<RotateCcw size={13} />} label="Retry Download" onClick={() => handleAction('retry')} accent />
      )}
      <Divider />
      <MenuItem icon={<Copy size={13} />} label="Copy URL" onClick={() => handleAction('copy-url')} />
      <Divider />
      <MenuItem icon={<Trash2 size={13} />} label="Remove from List" onClick={() => handleAction('delete')} danger />
      {isCompleted && (
        <MenuItem icon={<Trash2 size={13} />} label="Delete File" onClick={() => handleAction('delete-file')} danger />
      )}
    </div>
  )
}

function MenuItem({ icon, label, onClick, accent, danger }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  accent?: boolean
  danger?: boolean
}) {
  const color = danger
    ? 'text-ng-danger hover:bg-ng-danger/10'
    : accent
    ? 'text-ng-accent hover:bg-ng-accent/10'
    : 'text-ng-text hover:bg-ng-surfaceHover'

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${color}`}
    >
      <span className="opacity-70">{icon}</span>
      {label}
    </button>
  )
}

function Divider() {
  return <div className="my-1 border-t border-ng-border/50" />
}

// ── Table layout ──────────────────────────────────────────────────────────────
// One grid template shared by the header and every row so the columns always line up.
// Narrow windows drop the lowest-priority columns (Category, then Date) instead of overflowing.
const GRID = 'grid items-center gap-3 grid-cols-[28px_minmax(180px,1fr)_96px_minmax(120px,170px)_84px_72px] ' +
  'lg:grid-cols-[28px_minmax(180px,1fr)_96px_minmax(120px,170px)_84px_72px_92px] ' +
  'xl:grid-cols-[28px_minmax(180px,1fr)_96px_minmax(120px,170px)_84px_72px_92px_128px]'

function ColumnHeader() {
  const { filteredDownloads, selectedIds, selectAll, clearSelection } = useDownloadStore()
  const visible = filteredDownloads()
  const allSelected = visible.length > 0 && visible.every((d) => selectedIds.has(d.id))
  return (
    <div className={`${GRID} px-4 h-8 border-b border-ng-border bg-ng-surface/40 text-[10px] uppercase tracking-wider text-ng-textMuted font-semibold shrink-0 select-none`}>
      <input
        type="checkbox"
        aria-label="Select all downloads"
        checked={allSelected}
        onChange={() => (allSelected ? clearSelection() : selectAll())}
        className="accent-[rgb(var(--ng-accent))]"
      />
      <span>File name</span>
      <span>Size</span>
      <span>Status</span>
      <span>Speed</span>
      <span>Time left</span>
      <span className="hidden lg:block">Category</span>
      <span className="hidden xl:block">Date added</span>
    </div>
  )
}

// ── Download Row ──────────────────────────────────────────────────────────────
function DownloadRow({ item }: { item: DownloadItem }) {
  const { selectedIds, toggleSelect, removeDownloadFromList } = useDownloadStore()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const isSelected = selectedIds.has(item.id)
  const isActive = item.status === 'downloading'
  const isCompleted = item.status === 'completed'
  const isPaused = item.status === 'paused' || item.status === 'stopped'
  const isQueued = item.status === 'queued'
  const isFailed = item.status === 'failed'
  const pct = Math.min(100, Math.max(0, Math.floor(item.progress)))

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleAction = async (e: React.MouseEvent, action: string) => {
    e.stopPropagation()
    try {
      switch (action) {
        case 'pause':
          await invoke('download_pause', { id: item.id })
          break
        case 'resume':
          await invoke('download_resume', { id: item.id })
          break
        case 'retry':
          await invoke('download_retry', { id: item.id })
          break
        case 'openFile':
          await invoke('download_open_file', { id: item.id })
          break
        case 'openFolder':
          await invoke('download_open_folder', { id: item.id })
          break
        case 'delete':
          await invoke('download_remove', { id: item.id, deleteFile: false })
          removeDownloadFromList(item.id)
          break
      }
    } catch (err) {
      console.error(`download action "${action}" failed`, err)
    }
  }

  return (
    <>
      <div
        onClick={() => toggleSelect(item.id)}
        onDoubleClick={() => { if (isCompleted) void invoke('download_open_file', { id: item.id }) }}
        onContextMenu={handleContextMenu}
        className={`group ${GRID} px-4 py-2 border-b border-ng-border/40 cursor-pointer transition-colors duration-100 select-none
          ${isSelected ? 'bg-ng-accent/10' : 'hover:bg-ng-surfaceHover/40'}
          ${isActive && !isSelected ? 'bg-ng-accent/[0.04]' : ''}`}
      >
        <input
          type="checkbox"
          aria-label={`Select ${item.fileName}`}
          checked={isSelected}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleSelect(item.id)}
          className="accent-[rgb(var(--ng-accent))]"
        />

        {/* File name + hover actions */}
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-lg shrink-0 w-6 text-center">{getFileIcon(item.fileName)}</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ng-text truncate" title={item.fileName}>{item.fileName}</div>
            {isFailed && item.error && (
              <div className="text-[11px] text-ng-danger truncate" title={item.error}>{item.error}</div>
            )}
            {isActive && item.segments.length > 1 && (
              <SegmentBar segments={item.segments} fileSize={item.fileSize} />
            )}
          </div>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
            {(isActive || isQueued) && (
              <ActionBtn onClick={(e) => handleAction(e, 'pause')} title="Stop (resume later)" className="hover:bg-ng-warning/20 text-ng-warning">
                <Pause size={13} />
              </ActionBtn>
            )}
            {isPaused && (
              <ActionBtn onClick={(e) => handleAction(e, 'resume')} title="Resume" className="hover:bg-ng-accent/20 text-ng-accent">
                <Play size={13} />
              </ActionBtn>
            )}
            {isFailed && (
              <ActionBtn onClick={(e) => handleAction(e, 'retry')} title="Retry" className="hover:bg-ng-accent/20 text-ng-accent">
                <RotateCcw size={13} />
              </ActionBtn>
            )}
            {isCompleted && (
              <ActionBtn onClick={(e) => handleAction(e, 'openFile')} title="Open file" className="hover:bg-ng-accent/20 text-ng-accent">
                <ExternalLink size={13} />
              </ActionBtn>
            )}
            <ActionBtn onClick={(e) => handleAction(e, 'openFolder')} title="Open folder" className="hover:bg-ng-surfaceHover text-ng-textSecondary">
              <FolderOpen size={13} />
            </ActionBtn>
            <ActionBtn onClick={(e) => handleAction(e, 'delete')} title="Remove from list" className="hover:bg-ng-danger/20 text-ng-danger/70 hover:text-ng-danger">
              <Trash2 size={13} />
            </ActionBtn>
          </div>
        </div>

        {/* Size */}
        <span className="text-[11px] font-mono text-ng-textSecondary truncate">
          {item.fileSize > 0 ? formatBytes(item.fileSize) : formatBytes(item.downloaded)}
        </span>

        {/* Status + progress */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <StatusBadge status={item.status} />
            {!isCompleted && item.progress > 0 && (
              <span className="text-[10px] font-mono text-ng-textSecondary">{pct}%</span>
            )}
          </div>
          {!isCompleted && <ProgressBar progress={item.progress} status={item.status} />}
        </div>

        {/* Speed */}
        <span className="text-[11px] font-mono text-ng-accent truncate">
          {isActive && item.speed > 0 ? formatSpeed(item.speed) : '—'}
        </span>

        {/* Time left */}
        <span className="text-[11px] text-ng-textSecondary truncate">
          {isActive && item.eta > 0 ? formatEta(item.eta) : '—'}
        </span>

        {/* Category */}
        <span className="hidden lg:block text-[11px] text-ng-textSecondary truncate">{categoryLabel(item.category)}</span>

        {/* Date added */}
        <span className="hidden xl:block text-[11px] text-ng-textMuted truncate" title={item.dateCompleted ? `Completed ${formatDateTime(item.dateCompleted)}` : undefined}>
          {formatDateTime(item.dateAdded)}
        </span>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          item={item}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}

function ActionBtn({ children, onClick, title, className }: {
  children: React.ReactNode
  onClick: (e: React.MouseEvent) => void
  title: string
  className: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-md transition-colors ${className}`}
    >
      {children}
    </button>
  )
}

// ── Empty State ───────────────────────────────────────────────────────────────
function EmptyState() {
  const { setShowNewDownload, activeCategory } = useDownloadStore()

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8 animate-fade-in">
      <div className="w-20 h-20 rounded-2xl bg-ng-surface flex items-center justify-center mb-4 border border-ng-border">
        <FileDown size={32} className="text-ng-textMuted" />
      </div>
      <h3 className="text-base font-semibold text-ng-text mb-1">
        {activeCategory === 'all' ? 'No downloads yet' : `No ${activeCategory} downloads`}
      </h3>
      <p className="text-xs text-ng-textMuted mb-5 max-w-xs leading-relaxed">
        Add a URL to start downloading. NetGuard uses up to 32 parallel connections for maximum speed.
      </p>
      <button
        onClick={() => setShowNewDownload(true)}
        className="btn-primary flex items-center gap-2"
      >
        <Plus size={15} />
        New Download
      </button>
    </div>
  )
}

// ── Main List ─────────────────────────────────────────────────────────────────
export function DownloadList() {
  const { filteredDownloads } = useDownloadStore()
  const downloads = filteredDownloads()

  if (downloads.length === 0) {
    return <EmptyState />
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <ColumnHeader />
      <div className="flex-1 overflow-y-auto">
        {downloads.map((item) => (
          <DownloadRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}
