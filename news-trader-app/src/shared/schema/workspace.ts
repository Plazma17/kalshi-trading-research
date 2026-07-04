/**
 * Workspace-level entities: Settings and the WorkspaceManifest.
 *
 * A workspace is a portable directory of JSON/JSONL files. settings.json holds
 * tunables (Ollama target, defaults); workspace.json is the manifest/root. Both
 * are validated through these schemas on read so a hand-edited or migrated file
 * never crashes the app.
 */
import { z } from 'zod'

export const SettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  // Ollama target (machine-local — re-resolved on import).
  ollamaHost: z.string().default('http://localhost:11434'),
  model: z.string().default('qwen2.5:14b'),
  keepAlive: z.string().default('30m'),
  numParallel: z.number().int().min(1).max(16).default(1),
  // UI zoom factor (whole-window magnification).
  zoom: z.number().min(0.5).max(3).default(1.4),
  // Prompt tuning: '' systemPrompt => use the built-in SYSTEM; active instruction set injected.
  systemPrompt: z.string().default(''),
  activeInstructionSetId: z.string().default(''),
  // Backtest defaults (used in M6).
  defaultHorizonDays: z.number().int().min(1).max(30).default(3),
  defaultTransactionCostBps: z.number().min(0).max(100).default(5),
  // Where big datasets live (machine-local, kept OUT of the workspace).
  datasetRoot: z.string().default(''),
  theme: z.string().default('dark')
})
export type Settings = z.infer<typeof SettingsSchema>

export function defaultSettings(): Settings {
  return SettingsSchema.parse({})
}

export const WorkspaceManifestSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  workspaceId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  appVersion: z.string().default('0.1.0')
})
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>
