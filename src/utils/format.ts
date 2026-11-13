/**
 * Utility functions for formatting values
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown'
  if (bytes < 1) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) return '—'
  return formatBytes(bytesPerSec) + '/s'
}

/**
 * Size column of the download table, built only from engine-reported numbers:
 *  - completed            -> total size (or the bytes received when the server never reported one)
 *  - total known, started -> "downloaded / total"
 *  - total known, idle    -> total
 *  - total unknown        -> "downloaded / Unknown" (or just "Unknown" before any byte arrived)
 */
export function formatSizeCell(fileSize: number, downloaded: number, status: string): string {
  const total = Number.isFinite(fileSize) && fileSize > 0 ? fileSize : -1
  const got = Number.isFinite(downloaded) && downloaded > 0 ? downloaded : 0
  if (status === 'completed') return formatBytes(total > 0 ? total : got)
  if (total > 0) return got > 0 ? `${formatBytes(got)} / ${formatBytes(total)}` : formatBytes(total)
  return got > 0 ? `${formatBytes(got)} / Unknown` : 'Unknown'
}

export function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '—'
  
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`
  }
  return `${secs}s`
}

export function formatDate(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}

/** Absolute local date + time (e.g. "2026-11-10 14:05") for table columns. */
export function formatDateTime(isoString: string | undefined): string {
  if (!isoString) return '—'
  const d = new Date(isoString)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const CATEGORY_LABELS: Record<string, string> = {
  compressed: 'Compressed',
  documents: 'Documents',
  music: 'Music',
  videos: 'Video',
  programs: 'Programs',
  other: 'General',
}

/** Human label for an engine category ("videos" -> "Video"). */
export function categoryLabel(category: string | undefined): string {
  if (!category) return 'General'
  return CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1)
}

export function truncateFileName(name: string, maxLength: number = 40): string {
  if (name.length <= maxLength) return name
  const ext = name.lastIndexOf('.')
  if (ext > 0) {
    const extension = name.substring(ext)
    const base = name.substring(0, maxLength - extension.length - 3)
    return base + '...' + extension
  }
  return name.substring(0, maxLength - 3) + '...'
}

export function getFileIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const icons: Record<string, string> = {
    // Archives
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    // Documents
    pdf: '📄', doc: '📄', docx: '📄', txt: '📝', csv: '📊',
    xls: '📊', xlsx: '📊', ppt: '📊', pptx: '📊',
    // Media
    mp3: '🎵', flac: '🎵', wav: '🎵', ogg: '🎵', m4a: '🎵',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
    // Images
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    // Programs
    exe: '⚙️', msi: '⚙️', dmg: '⚙️', deb: '⚙️', apk: '📱',
    // Code
    js: '💻', ts: '💻', py: '💻', java: '💻', cpp: '💻',
  }
  return icons[ext] || '📎'
}
