import { getOneDriveAccessToken } from './auth'
import { basename, joinPath, normalizePath, parentPath, type CloudFilesystem, type FsEntry } from './filesystem'

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'
const ITEM_SELECT = 'id,name,size,folder,file,eTag,lastModifiedDateTime,parentReference'
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024
const UPLOAD_CHUNK = 10 * 320 * 1024

interface GraphItem {
  id: string
  name: string
  size?: number
  folder?: { childCount?: number }
  file?: Record<string, unknown>
  eTag?: string
  lastModifiedDateTime?: string
  parentReference?: { id?: string; path?: string }
}

interface GraphList {
  value: GraphItem[]
  '@odata.nextLink'?: string
}

interface UploadSession {
  uploadUrl: string
}

export class OneDriveFilesystem implements CloudFilesystem {
  private readonly metadata = new Map<string, { value: FsEntry; expiresAt: number }>()

  async stat(path: string): Promise<FsEntry> {
    const normalized = normalizePath(path)
    const cached = this.metadata.get(normalized)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const item = await this.requestJson<GraphItem>(this.itemUrl(normalized, `?$select=${ITEM_SELECT}`))
    const entry = this.toEntry(item, normalized)
    this.metadata.set(normalized, { value: entry, expiresAt: Date.now() + 2_000 })
    return entry
  }

  async list(path: string): Promise<FsEntry[]> {
    const normalized = normalizePath(path)
    const entries: FsEntry[] = []
    let next: string | undefined = this.itemUrl(normalized, `/children?$select=${ITEM_SELECT}`)
    while (next) {
      const page: GraphList = await this.requestJson<GraphList>(next)
      for (const item of page.value) {
        const entry = this.toEntry(item, joinPath(normalized, item.name))
        entries.push(entry)
        this.metadata.set(entry.path, { value: entry, expiresAt: Date.now() + 2_000 })
      }
      next = page['@odata.nextLink']
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  async read(path: string): Promise<Uint8Array> {
    const response = await this.request(this.itemUrl(normalizePath(path), '/content'))
    return new Uint8Array(await response.arrayBuffer())
  }

  async write(path: string, data: Uint8Array): Promise<FsEntry> {
    const normalized = normalizePath(path)
    if (data.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      const item = await this.requestJson<GraphItem>(this.itemUrl(normalized, '/content'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: toArrayBuffer(data),
      })
      this.invalidate(normalized)
      return this.toEntry(item, normalized)
    }
    const session = await this.requestJson<UploadSession>(this.itemUrl(normalized, '/createUploadSession'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: basename(normalized) } }),
    })
    let completed: GraphItem | null = null
    for (let start = 0; start < data.byteLength; start += UPLOAD_CHUNK) {
      const end = Math.min(data.byteLength, start + UPLOAD_CHUNK)
      const response = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(end - start),
          'Content-Range': `bytes ${start}-${end - 1}/${data.byteLength}`,
        },
        body: toArrayBuffer(data.slice(start, end)),
      })
      if (!response.ok) throw await graphError(response, 'OneDrive upload failed')
      if (response.status !== 202) completed = await response.json() as GraphItem
    }
    if (!completed) completed = await this.requestJson<GraphItem>(this.itemUrl(normalized, `?$select=${ITEM_SELECT}`))
    this.invalidate(normalized)
    return this.toEntry(completed, normalized)
  }

  async mkdir(path: string): Promise<FsEntry> {
    const normalized = normalizePath(path)
    if (normalized === '/') return this.stat('/')
    const parent = parentPath(normalized)
    const item = await this.requestJson<GraphItem>(this.itemUrl(parent, '/children'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(normalized), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    })
    this.invalidate(normalized)
    return this.toEntry(item, normalized)
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path)
    if (normalized === '/') throw new Error('Cannot remove the OneDrive root')
    const item = await this.stat(normalized)
    await this.request(`${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' }, true)
    this.invalidate(normalized)
  }

  async rename(from: string, to: string): Promise<FsEntry> {
    const source = normalizePath(from)
    const destination = normalizePath(to)
    if (source === '/' || destination === '/') throw new Error('Cannot rename the OneDrive root')
    const [item, parent] = await Promise.all([this.stat(source), this.stat(parentPath(destination))])
    if (parent.kind !== 'directory') throw new Error('Destination parent is not a directory')
    const moved = await this.requestJson<GraphItem>(`${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: basename(destination), parentReference: { id: parent.id } }),
    })
    this.invalidate(source)
    this.invalidate(destination)
    return this.toEntry(moved, destination)
  }

  private itemUrl(path: string, suffix = ''): string {
    const normalized = normalizePath(path)
    if (normalized === '/') return `${GRAPH_ROOT}/me/drive/root${suffix}`
    const encoded = normalized.slice(1).split('/').map(encodeURIComponent).join('/')
    const separator = suffix.startsWith('/') ? ':' : ''
    return `${GRAPH_ROOT}/me/drive/root:/${encoded}${separator}${suffix}`
  }

  private async requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.request(url, init)
    return response.json() as Promise<T>
  }

  private async request(url: string, init: RequestInit = {}, allowNoContent = false): Promise<Response> {
    const token = await getOneDriveAccessToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(url, { ...init, headers, redirect: 'follow' })
    if (!response.ok) throw await graphError(response, 'OneDrive request failed')
    if (!allowNoContent && response.status === 204) throw new Error('OneDrive returned an empty response')
    return response
  }

  private toEntry(item: GraphItem, path: string): FsEntry {
    return {
      id: item.id,
      name: path === '/' ? 'OneDrive' : item.name,
      path: normalizePath(path),
      kind: item.folder ? 'directory' : 'file',
      size: Number(item.size ?? 0),
      modifiedAt: Date.parse(item.lastModifiedDateTime ?? '') || Date.now(),
    }
  }

  private invalidate(path: string): void {
    const normalized = normalizePath(path)
    this.metadata.delete(normalized)
    this.metadata.delete(parentPath(normalized))
  }
}

async function graphError(response: Response, prefix: string): Promise<Error> {
  let detail = ''
  try {
    const body = await response.json() as { error?: { message?: string } }
    detail = body.error?.message ?? ''
  } catch {
    detail = await response.text().catch(() => '')
  }
  return new Error(`${prefix} (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
