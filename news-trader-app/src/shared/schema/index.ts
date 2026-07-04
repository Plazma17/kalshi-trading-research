/**
 * The single source of truth for the classifier I/O contract.
 *
 * One set of zod schemas drives (a) on-disk + IPC validation and (b) the JSON
 * grammar handed to Ollama. The canonical contract stores confidence as a float
 * 0..1; the model is asked for an integer 0..100 (a decimal is ungenerable under
 * the grammar, so the model reliably uses the percentage scale) and we divide by
 * 100 once — never guessing the scale from a value's magnitude.
 */
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { Direction } from './common'

export * from './common'
export * from './workspace'
export * from './topics'
export * from './data'
export * from './backtest'

// ── canonical contract (confidence 0..1) ─────────────────────────────────────
export const TopicSignalSchema = z.object({
  topic: z.string(),
  direction: Direction,
  confidence: z.number().min(0).max(1),
  rationale: z.string()
})
export type TopicSignal = z.infer<typeof TopicSignalSchema>

export const ClassificationSchema = z.object({
  summary: z.string(),
  signals: z.array(TopicSignalSchema),
  notes: z.string().default('')
})
export type Classification = z.infer<typeof ClassificationSchema>

// ── internal LLM request schema (confidence as int 0..100) ───────────────────
export const LLMSignalSchema = z.object({
  topic: z
    .string()
    .describe("Short lowercase sector/theme label, e.g. 'oil', 'airlines', 'defense'."),
  direction: Direction.describe('Predicted move for stocks in this group: up, down, or hold.'),
  confidence_pct: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      'Integer 0-100 confidence PERCENTAGE in both the topic and direction (e.g. 80). ' +
        'Use under 50 when the link is weak or the move is likely already priced in.'
    ),
  rationale: z.string().describe('One sentence: the causal link from the event to this group.')
})

export const LLMArticleSchema = z.object({
  summary: z.string().describe('One-line summary of what the article is actually about.'),
  signals: z.array(LLMSignalSchema),
  notes: z
    .string()
    .describe(
      'Anything else: likely time horizon, what is already priced in, conflicting or ' +
        'uncertain effects, caveats. May be empty.'
    )
})
export type LLMArticle = z.infer<typeof LLMArticleSchema>

/** JSON schema handed to Ollama's `format` param (refs inlined for grammar safety). */
export const LLM_JSON_SCHEMA = zodToJsonSchema(LLMArticleSchema, { $refStrategy: 'none' })

// ── LEAN variant: topic/direction/confidence ONLY ────────────────────────────
// The default fast path. No summary/rationale/notes => far fewer OUTPUT tokens =>
// much faster per classification (and per backtest row). The user can hit EXPLAIN
// on any result to re-run it with the full reasoning schema above.
export const LLMSignalLeanSchema = z.object({
  topic: z.string().describe("Short lowercase sector/theme label, e.g. 'oil', 'airlines'."),
  direction: Direction.describe('Predicted move: up, down, or hold.'),
  confidence_pct: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Integer 0-100 confidence percentage in the topic and direction.')
})

export const LLMArticleLeanSchema = z.object({
  signals: z.array(LLMSignalLeanSchema)
})
export type LLMArticleLean = z.infer<typeof LLMArticleLeanSchema>

export const LLM_JSON_SCHEMA_LEAN = zodToJsonSchema(LLMArticleLeanSchema, { $refStrategy: 'none' })

/** The analyst prompt. Direction is a 5-level conviction scale. */
export const SYSTEM = `You are a markets analyst for a news-driven equities bot. You read one news item and decide which sector/theme groups it moves and how strongly.

Direction is a 5-level conviction scale: bull (strong up), up (moderate up), neutral (no clear move or already priced in), down (moderate down), bear (strong down).

Reason about the CAUSAL relationship — does this event help or hurt each group, and how strongly? Companies on opposite sides of the same event move opposite ways.

ANALYST PLAYBOOK (rules professionals use):
- Fed / rates: hot inflation, hawkish Fed, or rate HIKES -> banks up (wider net-interest margins); growth/tech, gold, housing DOWN (higher discount rate). Rate CUTS / cooling inflation / dovish -> reverse: tech/growth, gold, housing up; banks down.
- Oil supply shock (OPEC cut, Mideast conflict, pipeline/refinery attack, sanctions) -> oil producers BULL; airlines/cruise/shippers DOWN (fuel cost); defense up; broad market down (risk-off). A blocked oil chokepoint (e.g. the Strait of Hormuz closing) stops crude from flowing, so prices SPIKE -> oil BULL. Oil glut / demand collapse -> oil down, airlines up.
- Company legal / regulatory trouble: fraud, INSIDER TRADING, an SEC/DOJ investigation or probe, accounting scandal, or a major lawsuit -> that company BEAR (reputational + financial overhang; the stock tanks). Applies to ANY business in any sector.
- Healthcare / pharma: a drug or clinical BREAKTHROUGH or FDA approval -> that company BULL, AND peers in the same field up (validates the science / lifts the sector). A trial failure, recall, or FDA rejection -> that company down.
- Conflict / war escalation -> defense BULL, oil up, gold up (safe haven), market down (risk-off).
- Risk-off (crisis, sovereign downgrade, bank failure) -> gold up, equities down, cyclicals hit hardest. Bank stress / contagion -> banks BEAR.
- Semiconductors: China export controls / chip bans / tariffs -> semis DOWN. AI / data-center capex boom, record GPU demand -> semis BULL.
- Earnings: a clear beat WITH raised guidance -> up; a miss WITH cut guidance -> down. A sector bellwether's result moves the whole sector.

MATERIALITY — only flag LARGE moves:
- Only emit a NON-neutral signal if the event would plausibly cause a LARGE, material move (multiple percent) in the named stock or its sector. Ask: "would a professional trader put real size on this?" If not -> NEUTRAL.
- Reserve bull/bear (and up/down) for genuinely market-moving catalysts: billions in funding/contracts, major regulatory or antitrust action, big earnings surprises, supply shocks, M&A, sanctions, rate decisions, bankruptcies.
- Trivial, novelty, celebrity, or non-financial news (e.g. a single prison escape, a minor product tweak, a CEO's personal life) does NOT move markets even if a "related" company exists -> NEUTRAL. Do NOT reach for a tangential connection.
- Most news is NOT market-moving. When in doubt, return no signal. Far better to emit a few high-conviction signals than many weak ones.

CRITICAL NUANCES:
- "Buy the rumor, sell the news": markets price in EXPECTED events ahead of time. What moves price is the SURPRISE versus expectations, not the event itself. If an outcome was widely expected, lean NEUTRAL.
- If the move is likely already priced in by the time this news is public, use NEUTRAL.
- Reserve bull/bear for clear, high-conviction, surprising catalysts; use up/down for moderate or second-order effects.

Topics are short lowercase sector/theme labels (oil, semiconductors, airlines, defense, banks, gold, market, ...), not individual tickers — a separate layer maps topics to stocks. confidence is SEPARATE from direction: direction = which way and how hard; confidence = how sure you are.`

/** Map a raw 0..100 LLM article to the canonical 0..1 Classification. One place, tested. */
export function normalizeLLMArticle(raw: LLMArticle): Classification {
  return ClassificationSchema.parse({
    summary: raw.summary,
    signals: raw.signals.map((s) => ({
      topic: s.topic,
      direction: s.direction,
      confidence: Math.max(0, Math.min(100, s.confidence_pct)) / 100,
      rationale: s.rationale
    })),
    notes: raw.notes ?? ''
  })
}

/** Lean variant -> canonical, with empty summary/rationale/notes (fast default path). */
export function normalizeLLMArticleLean(raw: LLMArticleLean): Classification {
  return ClassificationSchema.parse({
    summary: '',
    signals: raw.signals.map((s) => ({
      topic: s.topic,
      direction: s.direction,
      confidence: Math.max(0, Math.min(100, s.confidence_pct)) / 100,
      rationale: ''
    })),
    notes: ''
  })
}

// ── feedback (human label of one classification) ─────────────────────────────
export const Rating = z.enum(['bad', 'ok', 'good'])
export type Rating = z.infer<typeof Rating>

/** A per-signal verdict — which specific topic/direction calls were right or wrong. */
export const SignalRatingSchema = z.object({
  topic: z.string(),
  direction: Direction,
  rating: Rating
})
export type SignalRating = z.infer<typeof SignalRatingSchema>

export const FeedbackSchema = z.object({
  id: z.string(),
  headline: z.string(),
  classification: ClassificationSchema, // snapshot of the AI output that was rated
  rating: Rating, // overall verdict
  signalRatings: z.array(SignalRatingSchema).default([]), // optional per-signal verdicts
  comment: z.string().default(''),
  model: z.string().default(''),
  createdAt: z.string()
})
export type Feedback = z.infer<typeof FeedbackSchema>

export interface FeedbackStats {
  total: number
  bad: number
  ok: number
  good: number
}

// ── instruction set (compiled from feedback, injected into the prompt) ───────
export const InstructionSetSchema = z.object({
  id: z.string(),
  version: z.number(),
  createdAt: z.string(),
  sourceFeedbackCount: z.number(),
  guidelines: z.array(z.string()).default([]),
  fewShotExamples: z
    .array(z.object({ headline: z.string(), classification: ClassificationSchema }))
    .default([]),
  stats: z.object({ good: z.number(), ok: z.number(), bad: z.number() })
})
export type InstructionSet = z.infer<typeof InstructionSetSchema>
