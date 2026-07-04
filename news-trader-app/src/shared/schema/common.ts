/** Base enums shared across schemas. Kept cycle-free (only depends on zod). */
import { z } from 'zod'

// 5-level conviction scale, most bearish -> most bullish.
export const Direction = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
export type Direction = z.infer<typeof Direction>

/** Signed magnitude for scoring/P&L: bull +2, up +1, neutral 0, down -1, bear -2. */
export const DIRECTION_SCORE: Record<Direction, number> = {
  bull: 2,
  up: 1,
  neutral: 0,
  down: -1,
  bear: -2
}
