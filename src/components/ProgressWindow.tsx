/**
 * Standalone per-download progress window. Shows only values reported by the download engine
 * (`download:progress` events carry real byte counters, speed, ETA and segment states).
 */
import React, { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ShieldCheck, Pause, Play, X, FolderOpen, File as FileIcon } from 'lucide-react'
import { formatBytes, formatSpeed, formatEta } from '../utils/format'
import { useThemeSync } from '../utils/useTheme'
import type { DownloadItem, DownloadProgress } from '../types/download'

export function ProgressWindow({ id }: { id: string }) {
  useThemeSync()
  const [item, setItem] = useState<DownloadItem | null>(null)
  const [p, setP] = useState<DownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoke<DownloadItem[]>('download_get_all').then((all) => setItem(all.find((d) => d.id === id) ?? null)).catch(() => {})
    const refetch = () =>
      invoke<DownloadItem[]>('download_get_all').then((all) => { setItem(all.find((d) => d.id === id) ?? null); setP(null) }).catch(() => {})
    const subs = [
      listen<DownloadProgress>('download:progress', (e) => { if (e.payload.id === id) setP(e.payload) }),
      // Pause / cancel / resume do not always come with a progress event: re-read the real state.
      listen<DownloadItem>('download:paused', (e) => { if (e.payload.id === id) { setItem(e.payload); setP(null) } }),
      listen<{ id: string }>('download:cancelled', (e) => { if (e.payload.id === id) refetch() }),
      listen<{ id: string }>('download:started', (e) => { if (e.payload.id === id) { setError(null); refetch() } }),
      listen<{ id: string }>('download:auth_required', (e) => { if (e.payload.id === id) setError('This server requires a sign-in. Enter your credentials in the NetGuard main window.') }),
      listen<DownloadItem>('download:completed', (e) => { if (e.payload.id === id) { setItem(e.payload); setP(null) } }),
      listen<{ id: string; error?: string }>('download:failed', (e) => { if (e.payload.id === id) setError(e.payload.error ?? 'Download failed') }),
    ]
    return () => { subs.forEach((s) => s.then((un) => un())) }
  }, [id])

  if (!item) {
    return <div className="h-full flex items-center justify-center text-sm text-ng-textSecondary bg-ng-bg">Loading…</div>
  }

  const status = error ? 'failed' : (p?.status ?? item.status)
  // The engine can learn the total size after the window opened; progress events carry it.
  const total = p?.fileSize && p.fileSize > 0 ? p.fileSize : item.fileSize
  const downloaded = p?.downloaded ?? item.downloaded
  const pct = status === 'completed' ? 100 : Math.max(0, Math.min(100, p?.progress ?? item.progress ?? 0))
  const segs = p?.segments ?? item.segments ?? []
  const active = segs.filter((s) => s.state === 1).length
  const done = status === 'completed'
  const finished = done || status === 'failed' || status === 'stopped'

  const act = (cmd: string) => invoke(cmd, { id }).catch((e) => setError(String(e)))
  const close = () => invoke('progress_window_close', { id })

  return (
    <div className="h-full w-full flex flex-col bg-ng-bg text-ng-text select-none">
      <div className="flex items-center gap-3 px-5 py-3 bg-gradient-to-r from-ng-surface to-ng-surfaceHover border-b border-ng-border">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-ng-accent to-cyan-400 flex items-center justify-center">
          <ShieldCheck size={20} className="text-white" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate flex items-center gap-2"><FileIcon size={13} /> {item.fileName}</div>
          <div className="text-[11px] text-ng-textSecondary capitalize">{status}</div>
        </div>
      </div>

      <div className="flex-1 px-5 py-4 space-y-3">
        <div className="h-3 rounded-full bg-ng-border overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${status === 'failed' ? 'bg-ng-danger' : done ? 'bg-ng-success' : 'bg-ng-accent'}`}
            style={{ width: `${total > 0 ? pct : (finished ? 100 : 30)}%` }}
          />
        </div>
        <div className="text-center text-2xl font-semibold tabular-nums">{total > 0 ? `${pct.toFixed(1)}%` : formatBytes(downloaded)}</div>

        <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-xs">
          <dt className="text-ng-textSecondary">File size</dt><dd>{total > 0 ? formatBytes(total) : 'Unknown'}</dd>
          <dt className="text-ng-textSecondary">Downloaded</dt><dd>{formatBytes(downloaded)}{total > 0 && <span className="text-ng-textMuted"> of {formatBytes(total)}</span>}</dd>
          <dt className="text-ng-textSecondary">Speed</dt><dd>{status === 'downloading' ? formatSpeed(p?.speed ?? 0) : '—'}</dd>
          <dt className="text-ng-textSecondary">Time left</dt><dd>{status === 'downloading' ? formatEta(p?.eta ?? 0) : '—'}</dd>
          <dt className="text-ng-textSecondary">Connections</dt>
          <dd>{segs.length > 0 ? `${active} active / ${segs.length} segments` : '—'}</dd>
          {done && item.sha256 && (<><dt className="text-ng-textSecondary">SHA-256</dt><dd className="font-mono text-[10px] break-all select-text">{item.sha256}</dd></>)}
        </dl>
        {error && <p className="text-xs text-ng-danger break-words">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 px-5 py-3 border-t border-ng-border bg-ng-surface">
        {!finished && status !== 'paused' && (
          <button className="btn-secondary flex items-center gap-1.5" onClick={() => act('download_pause')}><Pause size={14} /> Pause</button>
        )}
        {status === 'paused' && (
          <button className="btn-primary flex items-center gap-1.5" onClick={() => act('download_resume')}><Play size={14} /> Resume</button>
        )}
        {done && (
          <>
            <button className="btn-primary" onClick={() => act('download_open_file')}>Open</button>
            <button className="btn-secondary flex items-center gap-1.5" onClick={() => act('download_open_folder')}><FolderOpen size={14} /> Open folder</button>
          </>
        )}
        {!finished && (
          <button className="btn-secondary flex items-center gap-1.5" onClick={() => act('download_cancel').then(close)}><X size={14} /> Cancel</button>
        )}
        <button className="btn-secondary" onClick={close}>{finished ? 'Close' : 'Hide'}</button>
      </div>
    </div>
  )
}
