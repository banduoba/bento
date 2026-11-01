import { IconChevronLeft, IconChevronRight } from '../icons'

export default function TitlebarNavigation({ tab, onBack, onForward }) {
  const onKeyDown = e => {
    // Keep the browser's native button click while isolating file-list actions.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'Enter' || e.key === ' ')) {
      e.stopPropagation()
    }
  }
  return (
    <div className="tb-nav" role="group" aria-label="目录导航" onKeyDown={onKeyDown}>
      <button
        className="iconbtn" type="button" aria-label="后退" title="后退 (⌘[)"
        disabled={!tab || tab.hi <= 0} onClick={() => onBack(tab.id)}
      >
        <IconChevronLeft size={20} />
      </button>
      <button
        className="iconbtn" type="button" aria-label="前进" title="前进 (⌘])"
        disabled={!tab || tab.hi >= tab.history.length - 1} onClick={() => onForward(tab.id)}
      >
        <IconChevronRight size={20} />
      </button>
    </div>
  )
}
