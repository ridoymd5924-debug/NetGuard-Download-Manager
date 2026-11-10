/** Single place that applies the theme, so every window behaves identically. */
export type ThemeName = 'dark' | 'light'

const KEY = 'ng-theme'

export function applyTheme(theme: string | undefined): void {
  const light = theme === 'light'
  document.documentElement.classList.toggle('light', light)
  document.documentElement.classList.toggle('dark', !light)
  try {
    // Mirrored into localStorage so index.html can apply it before React renders (no flash of the
    // wrong theme at startup). The authoritative value is still the saved app config.
    localStorage.setItem(KEY, light ? 'light' : 'dark')
  } catch {
    /* storage unavailable: the config value is applied once it loads */
  }
}
