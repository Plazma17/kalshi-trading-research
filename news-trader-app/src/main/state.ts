import { defaultSettings, type Settings } from '@shared/schema'

/**
 * In-memory mirror of the active workspace's settings, so hot paths (Ollama
 * calls) read synchronously without touching disk. Loaded on workspace open and
 * updated on settings:update.
 */
let current: Settings = defaultSettings()
let workspaceDir = ''

export function getSettings(): Settings {
  return current
}

export function setSettings(s: Settings): void {
  current = s
}

export function getWorkspaceDir(): string {
  return workspaceDir
}

export function setWorkspaceDir(dir: string): void {
  workspaceDir = dir
}
