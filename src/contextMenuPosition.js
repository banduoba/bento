const margin = 8

export function menuPosition(x, y, width, height, viewportWidth, viewportHeight) {
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  }
}

export function submenuPosition(parent, width, height, viewportWidth, viewportHeight) {
  const right = parent.right - 4
  const left = right + width > viewportWidth - margin ? parent.left - width + 4 : right
  return menuPosition(left, parent.top - 4, width, height, viewportWidth, viewportHeight)
}
