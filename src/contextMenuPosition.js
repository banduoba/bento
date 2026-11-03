const margin = 8

export function menuPosition(x, y, width, height, viewportWidth, viewportHeight) {
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  }
}

export function submenuPosition(parent, anchor, width, height, viewportWidth, viewportHeight) {
  const gap = 4
  const right = parent.right + gap
  const left = parent.left - width - gap
  const rightSpace = viewportWidth - margin - right
  const leftSpace = parent.left - gap - margin
  const fitsRight = rightSpace >= width
  const fitsLeft = leftSpace >= width
  const x = fitsRight || (!fitsLeft && rightSpace >= leftSpace) ? right : left

  return menuPosition(x, anchor.top - gap, width, height, viewportWidth, viewportHeight)
}
