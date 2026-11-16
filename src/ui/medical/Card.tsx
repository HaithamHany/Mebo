import type { ReactNode } from 'react'
import { motion } from 'framer-motion'

/**
 * The console's one container. Glass, a hairline frame, and a header that
 * carries the module's name and its state — every card says whether what it
 * shows is live, simulated or not built yet, because on a medical display
 * that distinction is the first thing anyone needs to know.
 */
export type CardState = 'live' | 'sim' | 'planned' | 'standby'

const STATE_LABEL: Record<CardState, string> = {
  live: 'LIVE',
  sim: 'SIMULATED',
  planned: 'PLANNED',
  standby: 'STANDBY',
}

export function Card({
  title,
  code,
  state,
  delay = 0,
  className = '',
  children,
}: {
  title: string
  /** Short module designator shown before the title, e.g. "MED-02". */
  code: string
  state: CardState
  delay?: number
  className?: string
  children: ReactNode
}) {
  return (
    <motion.section
      className={`mc ${className}`}
      initial={{ opacity: 0, y: 12, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.6, delay, ease: 'easeOut' }}
    >
      <header className="mc-head">
        <span className="mc-code">{code}</span>
        <span className="mc-title">{title}</span>
        <span className={`mc-state mc-state-${state}`}>{STATE_LABEL[state]}</span>
      </header>
      <div className="mc-body">{children}</div>
    </motion.section>
  )
}
