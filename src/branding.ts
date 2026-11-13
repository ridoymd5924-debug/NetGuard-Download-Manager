/** Product branding. The product name stays "NetGuard Download Manager"; this is the author credit. */
export const PRODUCT_NAME = 'NetGuard Download Manager'
export const MADE_BY = 'Made by Torik'

/** "v1.0.3 · Made by Torik" — shown next to the version in About and Settings. */
export function versionLine(version: string): string {
  return `v${version} \u00b7 ${MADE_BY}`
}
