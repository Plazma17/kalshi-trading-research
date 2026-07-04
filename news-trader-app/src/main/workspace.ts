import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import AdmZip from 'adm-zip'
import {
  SettingsSchema,
  defaultSettings,
  WorkspaceManifestSchema,
  type Settings,
  type WorkspaceManifest
} from '@shared/schema'
import { setSettings, setWorkspaceDir, getWorkspaceDir } from './state'

// Pointer to the active workspace, stored in the OS app-data dir (machine-local).
const appConfigPath = (): string => join(app.getPath('userData'), 'app-config.json')

interface AppConfig {
  currentWorkspace: string
}

const FILES = {
  manifest: 'workspace.json',
  settings: 'settings.json'
}

// Empty collection/log files seeded so later milestones can append without checks.
const SEED_JSON = ['topics.json', 'mappings.json', 'prompts.json', 'instruction-sets.json']
const SEED_JSONL = ['classifications.jsonl', 'feedback.jsonl']

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeJson(p: string, data: unknown): Promise<void> {
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8')
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function getAppConfig(): Promise<AppConfig> {
  return (await readJson<AppConfig>(appConfigPath())) ?? { currentWorkspace: '' }
}

async function setAppConfig(c: AppConfig): Promise<void> {
  await writeJson(appConfigPath(), c)
}

export interface WorkspaceState {
  dir: string
  manifest: WorkspaceManifest
  settings: Settings
}

/** Create any missing workspace files in `dir` and return its (existing or new) manifest. */
async function ensureWorkspaceFiles(dir: string, name?: string): Promise<WorkspaceManifest> {
  await fs.mkdir(dir, { recursive: true })

  let manifest = await readJson<WorkspaceManifest>(join(dir, FILES.manifest))
  if (!manifest) {
    const now = new Date().toISOString()
    manifest = WorkspaceManifestSchema.parse({
      workspaceId: randomUUID(),
      name: name || basename(dir) || 'news-trader workspace',
      createdAt: now,
      updatedAt: now,
      appVersion: app.getVersion()
    })
    await writeJson(join(dir, FILES.manifest), manifest)
  }

  if (!(await exists(join(dir, FILES.settings)))) {
    await writeJson(join(dir, FILES.settings), defaultSettings())
  }
  for (const f of SEED_JSON) {
    if (!(await exists(join(dir, f)))) await writeJson(join(dir, f), [])
  }
  for (const f of SEED_JSONL) {
    if (!(await exists(join(dir, f)))) await fs.writeFile(join(dir, f), '', 'utf8')
  }
  return manifest
}

/** Open (creating files as needed) the workspace at `dir` and make it active. */
export async function openWorkspace(dir: string): Promise<WorkspaceState> {
  const manifest = await ensureWorkspaceFiles(dir)
  const settings = SettingsSchema.parse((await readJson(join(dir, FILES.settings))) ?? {})
  setSettings(settings)
  setWorkspaceDir(dir)
  await setAppConfig({ currentWorkspace: dir })
  return { dir, manifest, settings }
}

/** Resolve the current workspace (from app-config), or create a default one. */
export async function getOrInitCurrentWorkspace(): Promise<WorkspaceState> {
  const cfg = await getAppConfig()
  const dir = cfg.currentWorkspace || join(app.getPath('userData'), 'default-workspace')
  return openWorkspace(dir)
}

export async function createWorkspace(dir: string, name: string): Promise<WorkspaceState> {
  await ensureWorkspaceFiles(dir, name)
  return openWorkspace(dir)
}

export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  const dir = getWorkspaceDir()
  const cur = SettingsSchema.parse((await readJson(join(dir, FILES.settings))) ?? {})
  const next = SettingsSchema.parse({ ...cur, ...partial })
  await writeJson(join(dir, FILES.settings), next)
  setSettings(next)
  return next
}

/** Zip the entire active workspace folder to `zipPath` (basic portable export). */
export async function exportWorkspace(zipPath: string): Promise<void> {
  const dir = getWorkspaceDir()
  const zip = new AdmZip()
  zip.addLocalFolder(dir)
  zip.writeZip(zipPath)
}

/** Extract a workspace zip into `destDir` and open it. */
export async function importWorkspace(zipPath: string, destDir: string): Promise<WorkspaceState> {
  await fs.mkdir(destDir, { recursive: true })
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(destDir, true)
  return openWorkspace(destDir)
}
