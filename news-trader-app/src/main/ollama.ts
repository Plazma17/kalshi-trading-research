import { Ollama, type ChatResponse } from 'ollama'
import {
  ClassificationSchema,
  LLMArticleSchema,
  LLMArticleLeanSchema,
  LLM_JSON_SCHEMA,
  LLM_JSON_SCHEMA_LEAN,
  normalizeLLMArticle,
  normalizeLLMArticleLean,
  type Classification
} from '@shared/schema'
import { getSettings } from './state'
import { getActivePromptParts } from './tuning'

/** A fresh client bound to the current settings' Ollama host (cheap to construct). */
function client(): Ollama {
  return new Ollama({ host: getSettings().ollamaHost })
}

// The model never announces how long its answer will be, so a true percentage is
// impossible. Instead we LEARN the typical output length per mode from recent runs
// (exponential moving average) and fill the bar against that — close after a couple
// of runs. The live token count remains the ground-truth progress signal.
const estTokens = { lean: 90, full: 280 }

export interface OllamaStatus {
  ok: boolean
  models: string[]
  host: string
  error?: string
}

export async function ollamaStatus(): Promise<OllamaStatus> {
  const host = getSettings().ollamaHost
  try {
    const list = await client().list()
    return { ok: true, host, models: list.models.map((m) => m.name) }
  } catch (e) {
    return { ok: false, host, models: [], error: String(e) }
  }
}

export interface ClassifyMetrics {
  tokensPerSec: number
  evalCount: number
  promptEvalCount: number
  totalDurationMs: number
  loadDurationMs: number
}

export interface ClassifyResult {
  classification: Classification
  latencyMs: number
  model: string
  metrics: ClassifyMetrics
}

const ZERO_METRICS: ClassifyMetrics = {
  tokensPerSec: 0,
  evalCount: 0,
  promptEvalCount: 0,
  totalDurationMs: 0,
  loadDurationMs: 0
}

export type ClassifyPhase = 'connecting' | 'loading' | 'generating' | 'parsing' | 'done' | 'error'

/** Live progress for one classification, streamed to the UI. `fraction` is 0..1. */
export interface ClassifyProgress {
  phase: ClassifyPhase
  message: string
  tokens: number
  fraction: number
}

/**
 * Classify one article via the local Ollama model, STREAMING so the caller can
 * report exactly what's happening (loading model -> generating N tokens ->
 * validating). Fail-soft: any backend/parse error yields an empty-signals
 * Classification (error in `summary`) so a single bad article never halts a batch.
 */
export async function classify(
  text: string,
  onProgress?: (p: ClassifyProgress) => void,
  opts?: { explain?: boolean }
): Promise<ClassifyResult> {
  const explain = opts?.explain ?? false
  const denom = explain ? estTokens.full : estTokens.lean
  const { model, keepAlive } = getSettings()
  const t0 = Date.now()
  const trimmed = text.trim()
  const report = (phase: ClassifyPhase, message: string, tokens = 0, fraction = 0): void =>
    onProgress?.({ phase, message, tokens, fraction })

  try {
    report('connecting', `Sending request to ${model}…`)
    const { system, fewShot } = await getActivePromptParts(explain)
    const stream = await client().chat({
      model,
      messages: [
        { role: 'system', content: system },
        ...fewShot,
        { role: 'user', content: trimmed }
      ],
      // Lean schema by default (topic/direction/confidence only) for speed; the
      // full schema (adds summary/rationale/notes) only when the user hits EXPLAIN.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      format: (explain ? LLM_JSON_SCHEMA : LLM_JSON_SCHEMA_LEAN) as any,
      options: { temperature: 0 },
      keep_alive: keepAlive,
      stream: true
    })

    report('loading', 'Loading model into VRAM & reading the prompt…')
    let content = ''
    let tokens = 0
    let firstSeen = false
    let final: ChatResponse | null = null

    for await (const part of stream) {
      const delta = part.message?.content ?? ''
      if (delta) {
        content += delta
        tokens++
        const frac = Math.min(0.97, tokens / denom)
        if (!firstSeen) {
          firstSeen = true
          report('generating', `Generating analysis… ${tokens} tokens`, tokens, frac)
        } else if (tokens % 4 === 0) {
          report('generating', `Generating analysis… ${tokens} tokens`, tokens, frac)
        }
      }
      if (part.done) final = part
    }

    report('parsing', 'Validating the structured output…', tokens, 0.97)
    const parsed = JSON.parse(content)
    const classification = explain
      ? normalizeLLMArticle(LLMArticleSchema.parse(parsed))
      : normalizeLLMArticleLean(LLMArticleLeanSchema.parse(parsed))

    const evalCount = final?.eval_count ?? tokens
    const evalDurNs = final?.eval_duration ?? 0
    const metrics: ClassifyMetrics = {
      evalCount,
      promptEvalCount: final?.prompt_eval_count ?? 0,
      tokensPerSec: evalDurNs > 0 ? evalCount / (evalDurNs / 1e9) : 0,
      totalDurationMs: (final?.total_duration ?? 0) / 1e6,
      loadDurationMs: (final?.load_duration ?? 0) / 1e6
    }
    // Learn this mode's typical length so the next bar tracks closer (EMA).
    const k: 'lean' | 'full' = explain ? 'full' : 'lean'
    if (evalCount > 0) estTokens[k] = estTokens[k] * 0.7 + evalCount * 0.3

    report('done', `Done · ${evalCount} tokens`, tokens, 1)
    return {
      classification,
      latencyMs: Date.now() - t0,
      model,
      metrics
    }
  } catch (e) {
    report('error', `Error: ${String(e)}`, 0, 1)
    return {
      classification: ClassificationSchema.parse({
        summary: `[classify error: ${String(e)}] ${trimmed.slice(0, 120)}`,
        signals: [],
        notes: ''
      }),
      latencyMs: Date.now() - t0,
      model,
      metrics: ZERO_METRICS
    }
  }
}
