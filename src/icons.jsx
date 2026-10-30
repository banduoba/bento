const S = (props) => ({
  width: props.size || 16,
  height: props.size || 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: props.className,
})

export const IconChevronLeft = (p) => (
  <svg {...S(p)}><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>
)
export const IconChevronRight = (p) => (
  <svg {...S(p)}><path d="M9.5 5.5 16 12l-6.5 6.5" /></svg>
)
export const IconArrowUp = (p) => (
  <svg {...S(p)}><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" /></svg>
)
export const IconRefresh = (p) => (
  <svg {...S(p)}><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>
)
export const IconSearch = (p) => (
  <svg {...S(p)}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.3-4.3" /></svg>
)
export const IconPlusFolder = (p) => (
  <svg {...S(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10.5v5M9.5 13h5" /></svg>
)
export const IconEye = (p) => (
  <svg {...S(p)}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></svg>
)
export const IconEyeOff = (p) => (
  <svg {...S(p)}><path d="M4 4l16 16" /><path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-2.4 3.2M6.1 7.6A16.9 16.9 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 3.4-.7" /></svg>
)
export const IconLayout1 = (p) => (
  <svg {...S(p)}><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
)
export const IconLayout2 = (p) => (
  <svg {...S(p)}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M12 4v16" /></svg>
)
export const IconLayout4 = (p) => (
  <svg {...S(p)}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M12 4v16M4 12h16" /></svg>
)
export const IconDrive = (p) => (
  <svg {...S(p)}><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M17 12h.01" /></svg>
)
export const IconHouse = (p) => (
  <svg {...S(p)}><path d="m4 11 8-7 8 7v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" /></svg>
)
export const IconChevronDown = (p) => (
  <svg {...S(p)}><path d="m6 9.5 6 6 6-6" /></svg>
)
export const IconPencil = (p) => (
  <svg {...S(p)}><path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17z" /><path d="m13.5 6.5 3 3" /></svg>
)
export const IconSettings = (p) => (
  <svg {...S(p)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </svg>
)
export const IconCopy = (p) => (
  <svg {...S(p)}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 4h8A1.5 1.5 0 0 1 14.5 5.5V6" /></svg>
)
export const IconCheck = (p) => (
  <svg {...S(p)}><path d="m5 12.5 4.5 4.5L19 7" /></svg>
)
export const IconFolder = (p) => (
  <svg width={p.size || 26} height={p.size || 26} viewBox="0 0 24 24">
    <path
      d="M2.5 6.5A2 2 0 0 1 4.5 4.5h4.6l1.8 1.8h8.6a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z"
      fill="#5aacff"
      stroke="#3d86d8"
      strokeWidth="1"
    />
    <path d="M2.5 8.5h19" stroke="#8ec4ff" strokeWidth="1" />
  </svg>
)
