import { cn } from '../../lib/utils'

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('block animate-pulse bg-accent motion-reduce:animate-none', className)} />
}
