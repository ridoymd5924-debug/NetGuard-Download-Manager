/**
 * NetGuard "File Download" information dialog — a standalone window opened by the desktop app when
 * a browser extension captures a download (IDM-style). All data comes from the backend: the size,
 * resumability and file name are the result of a real probe of the URL, never placeholders.
 */
import React, { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ShieldCheck, FolderOpen, Download, Clock, AlertTriangle, Loader2, Lock } from 'lucide-react'
import { formatBytes } from '../utils/format'
import { useThemeSync } from '../utils/useTheme'

interface PendingInfo {
  url: string
  fileName: string
  fileSize: number            // -1 when the server did not report a size
  resumable: boolean
  defaultDir: string
  error?: string | null
  category: string
  categoryLabel: string
  saveDir: string
  remembered: boolean
}

interface CategoryInfo { category: string; categoryLabel: string; saveDir: string; remembered: boolean }

/** True when the probe failure means the server wants credentials. */
export function looksLikeAuthError(err?: string | null): boolean {
  return !!err && /\b(401|403)\b|auth/i.test(err)
}

export function DownloadInfoWindow({ id }: { id: string }) {
  useThemeSync()
  const [info, setInfo] = useState<PendingInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [category, setCategory] = useState<CategoryInfo | null>(null)
  const [saveDir, setSaveDir] = useState('')
  const [dirTouched, setDirTouched] = useState(false)
  const [remember, setRemember] = useState(false)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    invoke<PendingInfo>('dialog_pending_get', { id })
      .then((i) => {
        setInfo(i)
        setFileName(i.fileName)
        setSaveDir(i.saveDir)
        setCategory({ category: i.category, categoryLabel: i.categoryLabel, saveDir: i.saveDir, remembered: i.remembered })
      })
      .catch((e) => setLoadError(String(e)))
  }, [id])

  // The category (and the folder remembered for it) follows the file name the user types.
  useEffect(() => {
    if (!info) return
    const mine = ++seq.current
    const t = setTimeout(() => {
      invoke<CategoryInfo>('dialog_category_info', { fileName })
        .then((c) => {
          if (mine !== seq.current) return
          setCategory(c)
          if (!dirTouched) setSaveDir(c.saveDir)
        })
        .catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [fileName, info, dirTouched])

  const cancel = () => invoke('dialog_pending_cancel', { id }).catch(() => {})

  const confirm = async (startNow: boolean) => {
    setBusy(true)
    setActionError(null)
    try {
      await invoke('dialog_pending_confirm', {
        id,
        fileName: fileName.trim() || null,
        saveDir: saveDir.trim() || null,
        startNow,
        description: description.trim() || null,
        rememberPath: remember,
      })
      // The backend closes this window on success.
    } catch (e) {
      setActionError(String(e))
      setBusy(false)
    }
  }

  const browse = async () => {
    const dir = await invoke<string | null>('dialog_select_folder').catch(() => null)
    if (dir) { setSaveDir(dir); setDirTouched(true) }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter' && info && !busy && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') confirm(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const needsAuth = looksLikeAuthError(info?.error)

  return (
    <div className="h-full w-full flex flex-col bg-ng-bg text-ng-text select-none">
      <div className="flex items-center gap-3 px-5 py-3 bg-gradient-to-r from-ng-surface to-ng-surfaceHover border-b border-ng-border">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-ng-accent to-cyan-400 flex items-center justify-center">
          <ShieldCheck size={20} className="text-white" />
        </div>
        <div>
          <div className="text-sm font-semibold">NetGuard Download Manager</div>
          <div className="text-[11px] text-ng-textSecondary">Download File Info</div>
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
          <Row label="URL">
            <div className="text-xs text-ng-textSecondary break-all max-h-14 overflow-y-auto select-text" title={info.url} data-testid="dl-url">
              {info.url}
            </div>
          </Row>
          <Row label="File name">
            <input className="input-ng w-full select-text" value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </Row>
          <Row label="File size">
            <span className="text-sm" data-testid="dl-size">
              {info.fileSize >= 0 ? formatBytes(info.fileSize) : 'Unknown'}
              <span className="ml-2 text-[11px] text-ng-textMuted">
                {info.resumable ? '· resumable, multi-connection' : '· single connection'}
              </span>
            </span>
          </Row>
          <Row label="Category">
            <span className="text-sm" data-testid="dl-category">{category?.categoryLabel ?? info.categoryLabel}</span>
          </Row>
          <Row label="Save As">
            <div className="flex gap-2">
              <input
                className="input-ng flex-1 select-text"
                value={saveDir}
                onChange={(e) => { setSaveDir(e.target.value); setDirTouched(true) }}
              />
              <button className="btn-secondary shrink-0 flex items-center gap-1.5" onClick={browse}>
                <FolderOpen size={14} /> Browse
              </button>
            </div>
          </Row>
          <Row label="">
            <label className="flex items-center gap-2 text-xs text-ng-textSecondary cursor-pointer">
              <input
                type="checkbox"
                className="accent-[rgb(var(--ng-accent))]"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember this path for “{category?.categoryLabel ?? info.categoryLabel}” downloads
              {category?.remembered && <span className="text-ng-textMuted">(a path is already remembered)</span>}
            </label>
          </Row>
          <Row label="Description">
            <textarea
              className="input-ng w-full select-text resize-none"
              rows={2}
              placeholder="Optional"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Row>

          {needsAuth && (
            <p className="text-[11px] text-ng-warning flex items-start gap-1.5">
              <Lock size={12} className="mt-0.5 shrink-0" />
              This server asks for a sign-in. Start the download and NetGuard will prompt for your credentials.
            </p>
          )}
          {info.error && !needsAuth && (
            <p className="text-[11px] text-ng-warning flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              Could not read file details ({info.error}). You can still try downloading.
            </p>
          )}
          {actionError && <p className="text-[11px] text-ng-danger">{actionError}</p>}
        </div>
      )}

      <div className="flex justify-end gap-2 px-5 py-3 border-t border-ng-border bg-ng-surface">
        <button className="btn-secondary flex items-center gap-1.5" disabled={!info || busy} onClick={() => confirm(false)}>
          <Clock size={14} /> Download Later
        </button>
        <button className="btn-primary flex items-center gap-1.5" disabled={!info || busy} onClick={() => confirm(true)}>
          <Download size={14} /> Start Download
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
