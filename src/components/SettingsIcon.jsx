// A single stroke weight and optical size for the preferences categories.
export default function SettingsIcon({ kind, size = 19 }) {
 const paths = {
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  general: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2.5" fill="var(--settings-nav-surface, var(--modal-bg))" /><circle cx="15" cy="17" r="2.5" fill="var(--settings-nav-surface, var(--modal-bg))" /></>,
  shortcuts: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 9h.01M12 9h.01M17 9h.01M7 12.5h.01M12 12.5h.01M17 12.5h.01M8 16h8" /></>,
  backup: <><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" /><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M9 13h6" /></>,
  permission: <><path d="m12 3 8 3v5c0 5-4.5 8-8 10-3.5-2-8-5-8-10V6z" /><path d="m8.5 11.5 2.5 2.5 4.5-5" /></>,
  about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
 }
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[kind] || paths.general}</svg>
}
