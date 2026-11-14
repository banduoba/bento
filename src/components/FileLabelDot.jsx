import { labelColor } from '../fileLabels'

export default function FileLabelDot({ value }) {
  const color = labelColor(value)
  return color ? <span className="file-label-dot" style={{ background: color.color }} title={`${color.label}标签`} aria-label={`${color.label}标签`} /> : null
}
