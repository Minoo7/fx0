'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils'

// Ported from the vercel.com dashboard sidebar (apps/vercel-site/app/nav/sidebar/size/gestures.tsx).
const EDGE_HIT_ZONE = 16
const HEADER_HEIGHT = 48
const FOOTER_HEIGHT = 48

export interface SidebarGestureControls {
  min: number
  isCollapsed: () => boolean
  dragStart: () => void
  setInterimWidth: (width: number) => void
  commitWidth: (width: number, wasCollapsed: boolean) => void
  toggle: () => void
  reset: () => void
}

// The prompt is a plain textarea that is focused almost all the time; Cmd+B has
// no meaning there, so it must not swallow the shortcut like other fields do.
function isFocusedOnInput(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  if (active instanceof HTMLTextAreaElement && active.name === 'prompt') return false
  return ['SELECT', 'TEXTAREA', 'INPUT'].includes(active.tagName) || active.isContentEditable
}

export default function SidebarGestures({
  sidebarRef,
  controls,
}: {
  sidebarRef: React.RefObject<HTMLDivElement | null>
  controls: SidebarGestureControls
}) {
  const ref = useRef<HTMLDivElement>(null)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    let isHeld = false
    let isPending = false
    let isPendingReset = false
    let pendingInSafeZone = false
    let wasCollapsed = false
    let previousUserSelect = ''
    let xStart = 0
    let yStart = 0
    let x = 0
    let nextFrame = 0
    let lastToggleTime = 0
    let lastToggleX = 0
    let lastToggleY = 0
    let cancelNextClick = false
    const desktop = () => window.matchMedia('(min-width: 768px)').matches

    const onFrame = () => {
      if (!isHeld) return
      nextFrame = requestAnimationFrame(onFrame)
      const { min, setInterimWidth } = controlsRef.current
      const left = sidebarRef.current?.parentElement?.getBoundingClientRect().left ?? 0
      const width = Math.max(0, Math.round(x - left))
      setInterimWidth(width)
      const hiddenRatio = Math.max(0, Math.min(width / min, 1))
      const sidebar = sidebarRef.current
      if (hiddenRatio < 1) {
        sidebar?.style.setProperty('opacity', Math.max(0, 1.5 * (hiddenRatio - 0.333)).toFixed(2))
        sidebar?.style.setProperty('filter', `blur(${2 * (1 - hiddenRatio)}px)`)
      } else {
        sidebar?.style.removeProperty('opacity')
        sidebar?.style.removeProperty('filter')
      }
    }

    const startResize = (clientX: number) => {
      isHeld = true
      x = clientX
      wasCollapsed = controlsRef.current.isCollapsed()
      controlsRef.current.dragStart()
      nextFrame = requestAnimationFrame(onFrame)
      // A drag from the header or footer edge may have started selecting text; clear
      // it, but not a focused field's: that holds the prompt's caret, and focusing
      // the already focused prompt afterwards would not bring it back.
      const active = document.activeElement
      if (!(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) {
        window.getSelection()?.removeAllRanges()
      }
      previousUserSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'
      document.documentElement.classList.add('sidebar-gesture-active')
      document.documentElement.style.cursor = 'col-resize'
      setIsDragging(true)
    }

    const claim = (event: PointerEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }

    const arm = (event: PointerEvent) => {
      pendingInSafeZone = event.clientY < HEADER_HEIGHT || event.clientY > window.innerHeight - FOOTER_HEIGHT
      if (!pendingInSafeZone) claim(event)
      isPending = true
      xStart = event.clientX
      yStart = event.clientY
      x = event.clientX
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !desktop()) return
      const target = event.target as HTMLElement
      const container = sidebarRef.current?.parentElement
      const collapsed = controlsRef.current.isCollapsed()

      if (ref.current?.contains(target)) {
        arm(event)
        return
      }

      // Collapsed, the handle has no width; catch the expand gesture at the
      // viewport edge instead, unless a button sits under the pointer.
      if (collapsed && event.clientX <= EDGE_HIT_ZONE) {
        if (document.elementFromPoint(event.clientX, event.clientY)?.closest('button')) return
        arm(event)
        return
      }

      if (!container?.contains(target)) return
      const distFromEdge = container.getBoundingClientRect().right - event.clientX
      if (distFromEdge >= 0 && distFromEdge <= EDGE_HIT_ZONE) {
        arm(event)
        return
      }

      // The first click moved the handle away; a quick second click at the
      // same spot resets to the default width.
      if (
        event.clientY >= HEADER_HEIGHT &&
        event.clientY <= window.innerHeight - FOOTER_HEIGHT &&
        lastToggleTime > 0 &&
        Date.now() - lastToggleTime < 500 &&
        Math.hypot(event.clientX - lastToggleX, event.clientY - lastToggleY) < 4
      ) {
        claim(event)
        isPending = true
        isPendingReset = true
        pendingInSafeZone = false
        xStart = event.clientX
        yStart = event.clientY
        x = event.clientX
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (isPending) {
        if (!pendingInSafeZone) claim(event)
        const dx = Math.abs(event.clientX - xStart)
        const dy = Math.abs(event.clientY - yStart)
        if (dx < 4 && dy < 4) return
        isPending = false
        isPendingReset = false
        if (dy > dx) return
        startResize(event.clientX)
        return
      }
      if (!isHeld) return
      claim(event)
      x = event.clientX
    }

    const onClick = (event: MouseEvent) => {
      if (!cancelNextClick) return
      cancelNextClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    const cleanup = (event?: PointerEvent) => {
      if (isPending) {
        isPending = false
        if (pendingInSafeZone) {
          isPendingReset = false
          return
        }
        event?.preventDefault()
        event?.stopPropagation()
        cancelNextClick = true
        if (isPendingReset) {
          isPendingReset = false
          controlsRef.current.reset()
          lastToggleTime = 0
        } else {
          controlsRef.current.toggle()
          lastToggleTime = Date.now()
          lastToggleX = xStart
          lastToggleY = yStart
        }
        return
      }
      if (!isHeld) return
      event?.preventDefault()
      event?.stopPropagation()
      cancelNextClick = true
      isHeld = false
      cancelAnimationFrame(nextFrame)
      document.body.style.userSelect = previousUserSelect
      document.documentElement.classList.remove('sidebar-gesture-active')
      document.documentElement.style.cursor = ''
      setIsDragging(false)
      const left = sidebarRef.current?.parentElement?.getBoundingClientRect().left ?? 0
      controlsRef.current.commitWidth(Math.round(x - left), wasCollapsed)
      sidebarRef.current?.style.removeProperty('opacity')
      sidebarRef.current?.style.removeProperty('filter')
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', cleanup, true)
    window.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', cleanup, true)
      window.removeEventListener('click', onClick, true)
      cleanup()
    }
  }, [sidebarRef])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'b' || !(event.metaKey || event.ctrlKey) || event.shiftKey || isFocusedOnInput()) return
      if (!window.matchMedia('(min-width: 768px)').matches) return
      event.preventDefault()
      event.stopPropagation()
      controlsRef.current.toggle()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <>
      {isDragging && <div aria-hidden="true" className="fixed inset-0 z-[100] cursor-col-resize select-none" />}
      <div ref={ref} className="group absolute -right-px top-0 z-50 hidden h-full cursor-col-resize md:block">
        <div className="absolute inset-y-0 left-0 -right-4 [html.sidebar-collapsed_&]:hidden" />
        <div
          className={cn(
            'pointer-events-none absolute right-0 top-0 h-full w-px bg-border-strong [html.sidebar-collapsed_&]:translate-x-1',
            !isDragging && 'opacity-0 group-hover:opacity-100',
          )}
          style={{ transition: 'opacity 100ms ease 75ms, transform 100ms ease 100ms' }}
        />
        <button
          type="button"
          aria-label="Toggle sidebar"
          aria-keyshortcuts="Meta+B Control+B"
          // Pointer presses toggle in the gesture and swallow the click, so only
          // keyboard activation reaches this.
          onClick={() => controls.toggle()}
          className={cn(
            "absolute left-1/2 top-1/2 grid size-6 -translate-x-1/2 -translate-y-1/2 place-content-center rounded-full border border-border-strong bg-background text-foreground opacity-0 outline-none before:absolute before:-inset-x-2 before:-inset-y-6 before:content-[''] hover:border-foreground-tertiary hover:bg-secondary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 [html.sidebar-collapsed_&]:hidden",
            isDragging && 'pointer-events-none !opacity-0',
            '[html.sidebar-gesture-active_&]:pointer-events-none [html.sidebar-gesture-active_&]:!opacity-0',
          )}
          style={{ transition: 'opacity 150ms ease 150ms' }}
        >
          <svg viewBox="0 0 16 16" className="size-4 scale-90 group-hover:scale-100" style={{ transition: 'transform 150ms ease' }} aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="m9.25 12.06-.53-.53L5.9 8.71a1 1 0 0 1 0-1.42l2.82-2.82.53-.53L10.31 5l-.53.53L7.31 8l2.47 2.47.53.53z" />
          </svg>
        </button>
      </div>
    </>
  )
}
