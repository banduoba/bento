export const DEFAULT_SIDEBAR_WIDTH = 220
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 520

export function normalizeSidebarWidth(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)))
    : DEFAULT_SIDEBAR_WIDTH
}

export function sidebarWidthLimit(viewportWidth) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.floor(viewportWidth - 420)))
}

export function displayedSidebarWidth(preferred, viewportWidth) {
  return Math.min(normalizeSidebarWidth(preferred), sidebarWidthLimit(viewportWidth))
}
