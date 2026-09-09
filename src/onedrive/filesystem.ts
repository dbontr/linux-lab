export type EntryKind = 'file' | 'directory'

export interface FsEntry {
  id: string
  name: string
  path: string
  kind: EntryKind
  size: number
  modifiedAt: number
}

export interface CloudFilesystem {
  stat(path: string): Promise<FsEntry>
  list(path: string): Promise<FsEntry[]>
  read(path: string): Promise<Uint8Array>
  write(path: string, data: Uint8Array): Promise<FsEntry>
  mkdir(path: string): Promise<FsEntry>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<FsEntry>
}

export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const raw of path.replace(/\\/g, '/').split('/')) {
    if (!raw || raw === '.') continue
    if (raw === '..') {
      parts.pop()
      continue
    }
    if (raw.includes('\0')) throw new Error('File name contains a null byte')
    parts.push(raw)
  }
  return `/${parts.join('/')}`
}

export function joinPath(parent: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Invalid file name')
  }
  const base = normalizePath(parent)
  return normalizePath(`${base}/${name}`)
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

export function basename(path: string): string {
  const normalized = normalizePath(path)
  return normalized === '/' ? '' : normalized.slice(normalized.lastIndexOf('/') + 1)
}
