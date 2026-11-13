import React, { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { X, Settings, FolderOpen, Gauge, Monitor, Wrench, RefreshCw, Download, CheckCircle2, AlertCircle, Youtube } from 'lucide-react'
import { getVersion } from '@tauri-apps/api/app'
import { useDownloadStore } from '../store/useDownloadStore'
import { PRODUCT_NAME, versionLine } from '../branding'

interface ToolInfo { installed: boolean; version?: string; path: string }
interface ToolsStatus { ytdlp: ToolInfo; ffmpeg: ToolInfo; toolsDir: string }
interface ToolProgress { tool: string; step: string; pct: number; msg: string }

function ToolRow({
  label, icon, info, onInstall, busy,
}: {
  label: string
  icon: React.ReactNode
  info: ToolInfo | null
  onInstall: () => void
  busy: boolean
}) {
  const installed = info?.installed ?? false
  return (
    <div className="flex items-center gap-3 p-3 bg-ng-bg/60 rounded-lg border border-ng-border/50">
      <div className={`w-6 h-6 rounded flex items-center justify-center shrink-0 ${installed ? 'bg-ng-success/15' : 'bg-ng-danger/15'}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-ng-text">{label}</div>
        {installed ? (
          <div className="text-[10px] text-ng-success font-mono mt-0.5">
            v{info?.version ?? '?'} — ready
          </div>
        ) : (
          <div className="text-[10px] text-ng-danger mt-0.5">Not installed</div>
        )}
      </div>
      <button
        onClick={onInstall}
        disabled={busy}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all disabled:opacity-50 ${
          installed
            ? 'bg-ng-accent/10 border border-ng-accent/30 text-ng-accent hover:bg-ng-accent/20'
            : 'bg-ng-accent text-white hover:bg-ng-accent/80'
        }`}
      >
        {busy ? (
          <RefreshCw size={10} className="animate-spin" />
        ) : installed ? (
          <RefreshCw size={10} />
        ) : (
          <Download size={10} />
        )}
        {installed ? 'Update' : 'Install'}
      </button>
    </div>
  )
}

export function SettingsDialog() {
  const { setShowSettings, config, setConfig } = useDownloadStore()
  const [downloadDir, setDownloadDir] = useState(config?.downloadDir || '')
  const [maxConcurrent, setMaxConcurrent] = useState(config?.maxConcurrentDownloads || 3)
  const [maxSegments, setMaxSegments] = useState(config?.maxSegmentsPerDownload || 8)
  const [speedLimit, setSpeedLimit] = useState(config?.speedLimit || 0)
  const [notifications, setNotifications] = useState(config?.showNotifications ?? true)
  const [minimizeToTray, setMinimizeToTray] = useState(config?.minimizeToTray ?? true)
  const [startWithWindows, setStartWithWindows] = useState(config?.startWithWindows ?? false)
  const [startMinimized, setStartMinimized] = useState(config?.startMinimized ?? true)
  const [showDownloadDialog, setShowDownloadDialog] = useState(config?.showDownloadDialog ?? true)
  const [theme, setTheme] = useState<'dark' | 'light'>(config?.theme === 'light' ? 'light' : 'dark')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [ytdlpBrowser, setYtdlpBrowser] = useState(config?.ytdlpBrowser || 'chrome')

  const [toolsStatus, setToolsStatus] = useState<ToolsStatus | null>(null)
  const [toolProgress, setToolProgress] = useState<ToolProgress | null>(null)
  const [busyTool, setBusyTool] = useState<'ytdlp' | 'ffmpeg' | null>(null)
  const [toolError, setToolError] = useState<string | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const init = async () => {
      if (!config) {
        const c = await invoke<any>('config_get')
        setConfig(c)
        setDownloadDir(c.downloadDir)
        setMaxConcurrent(c.maxConcurrentDownloads)
        setMaxSegments(c.maxSegmentsPerDownload)
        setSpeedLimit(c.speedLimit)
        setNotifications(c.showNotifications)
        setMinimizeToTray(c.minimizeToTray)
        setStartWithWindows(c.startWithWindows ?? false)
        setStartMinimized(c.startMinimized ?? true)
        setTheme(c.theme === 'light' ? 'light' : 'dark')
        setShowDownloadDialog(c.showDownloadDialog ?? true)
        setYtdlpBrowser(c.ytdlpBrowser || 'chrome')
      }
      getVersion().then(setAppVersion).catch(() => {})
      refreshToolsStatus()

      // Listen for download progress events
      const unlisten = await listen<ToolProgress>('tools:progress', (e) => {
        setToolProgress(e.payload)
        if (e.payload.step === 'done') {
          refreshToolsStatus()
          setBusyTool(null)
          setToolProgress(null)
        } else if (e.payload.step === 'error') {
          setToolError(e.payload.msg)
          setBusyTool(null)
          setToolProgress(null)
        }
      })
      unlistenRef.current = unlisten
    }
    init()
    return () => { unlistenRef.current?.() }
  }, [])

  const refreshToolsStatus = async () => {
    try {
      const s = await invoke<ToolsStatus>('tools_get_status')
      setToolsStatus(s)
    } catch {}
  }

  const handleInstallTool = async (tool: 'ytdlp' | 'ffmpeg') => {
    setBusyTool(tool)
    setToolError(null)
    setToolProgress({ tool, step: 'starting', pct: 0, msg: 'Starting…' })
    try {
      if (tool === 'ytdlp') {
        await invoke('tools_install_ytdlp')
      } else {
        await invoke('tools_install_ffmpeg')
      }
      await refreshToolsStatus()
    } catch (err: any) {
      setToolError(String(err))
    } finally {
      setBusyTool(null)
      setToolProgress(null)
    }
  }

  const handleSelectFolder = async () => {
    const folder = await invoke<string | null>('dialog_select_folder')
    if (folder) setDownloadDir(folder)
  }

  const handleSave = async () => {
    const newConfig = {
      downloadDir,
      maxConcurrentDownloads: maxConcurrent,
      maxSegmentsPerDownload: maxSegments,
      speedLimit,
      showNotifications: notifications,
      minimizeToTray,
      startWithWindows,
      startMinimized,
      theme,
      showDownloadDialog,
      ytdlpPath: config?.ytdlpPath ?? '',
      ytdlpBrowser,
    }
    try {
      setSaveError(null)
      const updated = await invoke<any>('config_set', { config: newConfig })
      setConfig(updated)
      setShowSettings(false)
    } catch (e) {
      setSaveError(String(e))
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={() => setShowSettings(false)}
    >
      <div
        className="bg-ng-surface border border-ng-border rounded-xl w-[500px] shadow-2xl animate-slide-up max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ng-border sticky top-0 bg-ng-surface z-10">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-ng-accent/20 flex items-center justify-center">
              <Settings size={14} className="text-ng-accent" />
            </div>
            <h2 className="text-sm font-semibold text-ng-text">Settings</h2>
          </div>
          <button
            onClick={() => setShowSettings(false)}
            className="p-1 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={16} className="text-ng-textSecondary" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* Download Directory */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <FolderOpen size={14} className="text-ng-accent" />
              <span className="text-xs font-semibold text-ng-text uppercase tracking-wider">Storage</span>
            </div>
            <label className="block text-xs text-ng-textSecondary mb-1.5">Default Download Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={downloadDir}
                onChange={(e) => setDownloadDir(e.target.value)}
                className="input-ng flex-1"
              />
              <button
                onClick={handleSelectFolder}
                className="btn-secondary shrink-0"
              >
                Browse
              </button>
            </div>
          </div>

          {/* Performance */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Gauge size={14} className="text-ng-accent" />
              <span className="text-xs font-semibold text-ng-text uppercase tracking-wider">Performance</span>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-ng-textSecondary mb-1.5">
                  Max Concurrent Downloads
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={maxConcurrent}
                    onChange={(e) => setMaxConcurrent(parseInt(e.target.value))}
                    className="flex-1 accent-ng-accent"
                  />
                  <span className="text-sm font-mono text-ng-accent w-6 text-center">{maxConcurrent}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs text-ng-textSecondary mb-1.5">
                  Max Segments Per Download
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="1"
                    max="32"
                    value={maxSegments}
                    onChange={(e) => setMaxSegments(parseInt(e.target.value))}
                    className="flex-1 accent-ng-accent"
                  />
                  <span className="text-sm font-mono text-ng-accent w-6 text-center">{maxSegments}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs text-ng-textSecondary mb-1.5">
                  Speed Limit (KB/s) — 0 = Unlimited
                </label>
                <input
                  type="number"
                  min="0"
                  value={speedLimit}
                  onChange={(e) => setSpeedLimit(parseInt(e.target.value) || 0)}
                  className="input-ng w-32"
                  placeholder="0"
                />
              </div>
            </div>
          </div>

          {/* Tools — yt-dlp + ffmpeg integrated management */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Wrench size={14} className="text-ng-accent" />
                <span className="text-xs font-semibold text-ng-text uppercase tracking-wider">Tools</span>
              </div>
              <button
                onClick={refreshToolsStatus}
                className="p-1 rounded hover:bg-white/5 transition-colors"
                title="Refresh status"
              >
                <RefreshCw size={11} className="text-ng-textMuted" />
              </button>
            </div>

            <div className="space-y-2">
              <ToolRow
                label="yt-dlp"
                icon={<Youtube size={12} className={toolsStatus?.ytdlp.installed ? 'text-ng-success' : 'text-ng-danger'} />}
                info={toolsStatus?.ytdlp ?? null}
                onInstall={() => handleInstallTool('ytdlp')}
                busy={busyTool === 'ytdlp'}
              />
              <ToolRow
                label="ffmpeg"
                icon={<span className={`text-[10px] font-bold ${toolsStatus?.ffmpeg.installed ? 'text-ng-success' : 'text-ng-danger'}`}>ff</span>}
                info={toolsStatus?.ffmpeg ?? null}
                onInstall={() => handleInstallTool('ffmpeg')}
                busy={busyTool === 'ffmpeg'}
              />
            </div>

            {/* Progress bar */}
            {toolProgress && toolProgress.step !== 'done' && (
              <div className="mt-3 animate-fade-in">
                <div className="flex justify-between text-[10px] text-ng-textMuted mb-1">
                  <span>{toolProgress.msg}</span>
                  <span className="font-mono">{toolProgress.pct}%</span>
                </div>
                <div className="h-1.5 bg-ng-bg rounded-full overflow-hidden">
                  <div
                    className="h-full bg-ng-accent rounded-full transition-all duration-300"
                    style={{ width: `${toolProgress.pct}%` }}
                  />
                </div>
              </div>
            )}

            {toolError && (
              <div className="mt-2 flex items-start gap-1.5 text-[10px] text-ng-danger">
                <AlertCircle size={10} className="mt-0.5 shrink-0" />
                {toolError}
              </div>
            )}

            {toolsStatus && (
              <p className="text-[9px] text-ng-textMuted mt-2 font-mono truncate" title={toolsStatus.toolsDir}>
                {toolsStatus.toolsDir}
              </p>
            )}

            {/* Cookie browser for yt-dlp fallback */}
            <div className="mt-3">
              <label className="block text-xs text-ng-textSecondary mb-1.5">
                Browser for cookies
                <span className="text-ng-textMuted font-normal ml-1">(fallback for age-restricted content)</span>
              </label>
              <select
                value={ytdlpBrowser}
                onChange={(e) => setYtdlpBrowser(e.target.value)}
                className="input-ng w-40"
              >
                <option value="">None</option>
                <option value="chrome">Chrome</option>
                <option value="firefox">Firefox</option>
                <option value="edge">Edge</option>
                <option value="brave">Brave</option>
                <option value="opera">Opera</option>
                <option value="chromium">Chromium</option>
              </select>
            </div>
          </div>

          {/* Browser integration */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-ng-text uppercase tracking-wider">Browser Integration</span>
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={showDownloadDialog}
                onChange={(e) => setShowDownloadDialog(e.target.checked)}
                className="accent-ng-accent w-4 h-4 rounded"
              />
              <div>
                <span className="text-sm text-ng-text">Show download dialog for browser downloads</span>
                <p className="text-[10px] text-ng-textMuted">Ask for file name and location before a captured download starts</p>
              </div>
            </label>
          </div>

          {/* Appearance */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-ng-text uppercase tracking-wider">Appearance</span>
            </div>
            <div className="flex gap-2">
              {(['dark', 'light'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={theme === t ? 'btn-primary' : 'btn-secondary'}
                >
                  {t === 'dark' ? 'Dark theme' : 'Light theme'}
                </button>
              ))}
            </div>
          </div>

          {/* General */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Monitor size={14} className="text-ng-accent" />
              <span className="text-xs font-semibold text-ng-text uppercase tracking-wider">General</span>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifications}
                  onChange={(e) => setNotifications(e.target.checked)}
                  className="accent-ng-accent w-4 h-4 rounded"
                />
                <div>
                  <span className="text-sm text-ng-text">Show notifications</span>
                  <p className="text-[10px] text-ng-textMuted">Notify when downloads complete</p>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={minimizeToTray}
                  onChange={(e) => setMinimizeToTray(e.target.checked)}
                  className="accent-ng-accent w-4 h-4 rounded"
                />
                <div>
                  <span className="text-sm text-ng-text">Minimize to system tray</span>
                  <p className="text-[10px] text-ng-textMuted">Keep running in background when closed</p>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={startWithWindows}
                  onChange={(e) => setStartWithWindows(e.target.checked)}
                  className="accent-ng-accent w-4 h-4 rounded"
                />
                <div>
                  <span className="text-sm text-ng-text">Start NetGuard with Windows</span>
                  <p className="text-[10px] text-ng-textMuted">Launch automatically when you sign in to Windows</p>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={startMinimized}
                  disabled={!startWithWindows} onChange={(e) => setStartMinimized(e.target.checked)}
                  className="accent-ng-accent w-4 h-4 rounded"
                />
                <div>
                  <span className="text-sm text-ng-text">Start minimized to system tray</span>
                  <p className="text-[10px] text-ng-textMuted">When started by Windows, stay in the tray instead of opening the window</p>
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* Footer */}
        {saveError && <p className="px-5 py-2 text-xs text-red-400">{saveError}</p>}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-ng-border">
          <span className="mr-auto text-[11px] text-ng-textMuted select-text" data-testid="settings-version">
            {PRODUCT_NAME}{appVersion ? ` ${versionLine(appVersion)}` : ''}
          </span>
          <button onClick={() => setShowSettings(false)} className="btn-secondary">
            Cancel
          </button>
          <button onClick={handleSave} className="btn-primary">
            Save Settings
          </button>
        </div>
      </div>
    </div>
  )
}
