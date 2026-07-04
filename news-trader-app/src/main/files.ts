import { promises as fs } from 'fs'
import { join } from 'path'
import { getWorkspaceDir } from './state'

/** Resolve a path inside the active workspace. */
export function wsPath(file: string): string {
  return join(getWorkspaceDir(), file)
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(wsPath(file), 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await fs.writeFile(wsPath(file), JSON.stringify(data, null, 2), 'utf8')
}

export async function appendJsonl(file: string, obj: unknown): Promise<void> {
  await fs.appendFile(wsPath(file), JSON.stringify(obj) + '\n', 'utf8')
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const txt = await fs.readFile(wsPath(file), 'utf8')
    return txt
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T)
  } catch {
    return []
  }
}
