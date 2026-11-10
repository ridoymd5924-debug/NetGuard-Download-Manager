/**
 * NetGuard "File Download" information dialog — a standalone window opened by the desktop app when
 * a browser extension captures a download. All data comes from the backend (real probe result).
 */
import React, { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ShieldCheck, FolderOpen, Download, Clock, AlertTriangle, Loader2 } from 'lucide-react'
import { formatBytes } from '../utils/format'
import { useThemeSync } from '../utils/useTheme'

interface PendingInfo {
  url: string
  fileName: string
  fileSize: number
  resumable: boolean
  defaultDir: string
  error?: string | null
}

export function DownloadInfoWindow({ id }: { id: string }) {
  useThemeSync()
  const [info, setInfo] = useState<PendingInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [customDir, setCustomDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    invoke<PendingInfo>('dialog_pending_get', { id })
      .then((i) => { setInfo(i); setFileName(i.fileName) })
      .catch((e) => setLoadError(String(e)))
  }, [id])

  const cancel = () => invoke('dialog_pending_cancel', { id }).catch(() => {})

  const confirm = async (startNow: boolean) => {
    setBusy(true)
    setActionError(null)
    try {
      await invoke('dialog_pending_confirm', {
        id,
        fileName: fileName.trim() || null,
        saveDir: customDir,          // null => engine's default category folder
        startNow,
      })
      // The backend closes this window on success.
    } catch (e) {
      setActionError(String(e))
      setBusy(false)
    }
  }

  const browse = async () => {
    const dir = await invoke<string | null>('dialog_select_folder').catch(() => null)
    if (dir) setCustomDir(dir)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter' && info && !busy) confirm(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const saveDisplay = customDir ?? (info ? `${info.defaultDir}\\NetGuard  (sorted by category)` : '')

  return (
    <div className="h-full w-full flex flex-col bg-ng-bg text-ng-text select-none">
      {/* Branded header */}
      <div className="flex items-center gap-3 px-5 py-3 bg-gradient-to-r from-ng-surface to-ng-surfaceHover border-b border-ng-border">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-ng-accent to-cyan-400 flex items-center justify-center">
          <ShieldCheck size={20} className="text-white" />
        </div>
        <div>
          <div className="text-sm font-semibold">NetGuard Download Manager</div>
          <div className="text-[11px] text-ng-textSecondary">File Download</div>
        </div>
      </div>

      {loadError ? (
        <div className="flex-1 p-5 text-sm text-ng-danger flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {loadError}
        </div>
      ) : !info ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-sm text-ng-textSecondary">
          <Loader2 size={16} className="animate-spin" /> Checking file…
        </div>
      ) : (
        <div className="flex-1 px-5 py-4 space-y-3 overflow-auto">
          <Row label="File name">
            <input className="input-ng w-full select-text" value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </Row>
          <Row label="File size">
            <span className="text-sm">
              {info.fileSize >= 0 ? formatBytes(info.fileSize) : 'Unknown'}
              <span className="ml-2 text-[11px] text-ng-textMuted">
                {info.resumable ? '· resumable, multi-connection' : '· single connection'}
              </span>
            </span>
          </Row>
          <Row label="Source">
            <div className="text-xs text-ng-textSecondary break-all max-h-12 overflow-hidden select-text" title={info.url}>
              {info.url}
            </div>
          </Row>
          <Row label="Save to">
            <div className="flex gap-2">
              <input
                className="input-ng flex-1 select-text"
                value={saveDisplay}
                onChange={(e) => setCustomDir(e.target.value)}
                onFocus={() => { if (customDir === null) setCustomDir(`${info.defaultDir}\\NetGuard`) }}
              />
              <button className="btn-secondary shrink-0 flex items-center gap-1.5" onClick={browse}>
                <FolderOpen size={14} /> Browse
              </button>
            </div>
          </Row>
          {info.error && (
            <p className="text-[11px] text-ng-warning flex items-center gap-1.5">
              <AlertTriangle size={12} /> Could not read file details ({info.error}). You can still try downloading.
            </p>
          )}
          {actionError && <p className="text-[11px] text-ng-danger">{actionError}</p>}
        </div>
      )}

      <div className="flex justify-end gap-2 px-5 py-3 border-t border-ng-border bg-ng-surface">
        <button className="btn-primary flex items-center gap-1.5" disabled={!info || busy} onClick={() => confirm(true)}>
          <Download size={14} /> Download Now
        </button>
        <button className="btn-secondary flex items-center gap-1.5" disabled={!info || busy} onClick={() => confirm(false)}>
          <Clock size={14} /> Download Later
        </button>
        <button className="btn-secondary" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center gap-3">
      <label className="text-xs text-ng-textSecondary">{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
