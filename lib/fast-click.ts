import type { MouseEvent, PointerEvent } from 'react'

// Fires on pointer-down; keyboard clicks report detail 0 and still go through onClick.
export function fastClick(action: () => void) {
  return {
    onPointerDown: (event: PointerEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return
      action()
    },
    onClick: (event: MouseEvent) => {
      if (event.detail === 0) action()
    },
  }
}
