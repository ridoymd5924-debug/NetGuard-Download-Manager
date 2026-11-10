import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { applyTheme } from './theme'

/** Applies the persisted NetGuard theme (dark/light) to <html>. Used by every secondary window. */
export function useThemeSync() {
  useEffect(() => {
    invoke<{ theme?: string }>('config_get')
      .then((c) => applyTheme(c?.theme))
      .catch(() => {})
  }, [])
}
