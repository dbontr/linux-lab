import { describe, expect, it } from 'vitest'
import type { CloudFilesystem, FsEntry } from './filesystem'
import { basename, normalizePath, parentPath } from './filesystem'
import { P9Reader, P9Writer } from './p9Codec'
import { OneDrive9PServer } from './p9Server'

class MemoryFilesystem implements CloudFilesystem {
  private readonly nodes = new Map<string, { entry: FsEntry; data?: Uint8Array }>()

  constructor() {
    this.nodes.set('/', { entry: this.entry('/', 'directory', 0) })
  }

  async stat(path: string): Promise<FsEntry> {
    const node = this.nodes.get(normalizePath(path))
    if (!node) throw new Error('not found')
    return { ...node.entry }
  }

  async list(path: string): Promise<FsEntry[]> {
    const normalized = normalizePath(path)
    const parent = await this.stat(normalized)
    if (parent.kind !== 'directory') throw new Error('not a directory')
    return [...this.nodes.values()]
      .filter((node) => node.entry.path !== normalized && parentPath(node.entry.path) === normalized)
      .map((node) => ({ ...node.entry }))
  }

  async read(path: string): Promise<Uint8Array> {
    const node = this.nodes.get(normalizePath(path))
    if (!node || node.entry.kind !== 'file') throw new Error('not found')
    return node.data?.slice() ?? new Uint8Array()
  }

  async write(path: string, data: Uint8Array): Promise<FsEntry> {
    const normalized = normalizePath(path)
    await this.requireDirectory(parentPath(normalized))
    const entry = this.entry(normalized, 'file', data.byteLength)
    this.nodes.set(normalized, { entry, data: data.slice() })
    return { ...entry }
  }

  async mkdir(path: string): Promise<FsEntry> {
    const normalized = normalizePath(path)
    await this.requireDirectory(parentPath(normalized))
    if (this.nodes.has(normalized)) throw new Error('already exists')
    const entry = this.entry(normalized, 'directory', 0)
    this.nodes.set(normalized, { entry })
    return { ...entry }
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path)
    if (!this.nodes.has(normalized)) throw new Error('not found')
    this.nodes.delete(normalized)
  }

  async rename(from: string, to: string): Promise<FsEntry> {
    const source = normalizePath(from)
    const destination = normalizePath(to)
    const node = this.nodes.get(source)
    if (!node) throw new Error('not found')
    await this.requireDirectory(parentPath(destination))
    const descendants = [...this.nodes.entries()].filter(([path]) => path === source || path.startsWith(`${source}/`))
    for (const [path] of descendants) this.nodes.delete(path)
    for (const [path, value] of descendants) {
      const nextPath = `${destination}${path.slice(source.length)}`
      const nextEntry = { ...value.entry, path: nextPath, name: basename(nextPath), modifiedAt: Date.now() }
      this.nodes.set(nextPath, { entry: nextEntry, data: value.data?.slice() })
    }
    return this.stat(destination)
  }

  private async requireDirectory(path: string): Promise<void> {
    const entry = await this.stat(path)
    if (entry.kind !== 'directory') throw new Error('not a directory')
  }

  private entry(path: string, kind: 'file' | 'directory', size: number): FsEntry {
    const normalized = normalizePath(path)
    return { id: normalized, name: normalized === '/' ? 'root' : basename(normalized), path: normalized, kind, size, modifiedAt: Date.now() }
  }
}

function exchange(server: OneDrive9PServer, request: Uint8Array): Promise<P9Reader> {
  return new Promise((resolve) => server.handle9p(request, (response) => resolve(new P9Reader(response))))
}

describe('OneDrive 9P2000.L server', () => {
  it('negotiates, creates, writes, reads, renames, and removes files', async () => {
    const fs = new MemoryFilesystem()
    const server = new OneDrive9PServer(fs)

    let response = await exchange(server, new P9Writer(100, 0xffff).u32(262144).string('9P2000.L').finish())
    expect(response.type).toBe(101)
    expect(response.u32()).toBe(262144)
    expect(response.string()).toBe('9P2000.L')

    response = await exchange(server, new P9Writer(104, 1).u32(1).u32(0xffffffff).string('root').string('').u32(0xffffffff).finish())
    expect(response.type).toBe(105)

    response = await exchange(server, new P9Writer(72, 2).u32(1).string('Projects').u32(0o755).u32(0).finish())
    expect(response.type).toBe(73)
    expect((await fs.stat('/Projects')).kind).toBe('directory')

    response = await exchange(server, new P9Writer(110, 3).u32(1).u32(2).u16(1).string('Projects').finish())
    expect(response.type).toBe(111)
    expect(response.u16()).toBe(1)

    response = await exchange(server, new P9Writer(14, 4).u32(2).string('note.txt').u32(2).u32(0o644).u32(0).finish())
    expect(response.type).toBe(15)

    const hello = new TextEncoder().encode('hello from linux')
    response = await exchange(server, new P9Writer(118, 5).u32(2).u64(0).u32(hello.byteLength).bytes(hello).finish())
    expect(response.type).toBe(119)
    expect(response.u32()).toBe(hello.byteLength)

    response = await exchange(server, new P9Writer(50, 6).u32(2).u32(0).finish())
    expect(response.type).toBe(51)
    expect(new TextDecoder().decode(await fs.read('/Projects/note.txt'))).toBe('hello from linux')

    response = await exchange(server, new P9Writer(110, 7).u32(1).u32(3).u16(2).string('Projects').string('note.txt').finish())
    expect(response.type).toBe(111)
    expect(response.u16()).toBe(2)

    response = await exchange(server, new P9Writer(116, 8).u32(3).u64(0).u32(128).finish())
    expect(response.type).toBe(117)
    const count = response.u32()
    expect(new TextDecoder().decode(response.raw(count))).toBe('hello from linux')

    response = await exchange(server, new P9Writer(110, 9).u32(1).u32(4).u16(1).string('Projects').finish())
    expect(response.type).toBe(111)
    response = await exchange(server, new P9Writer(74, 10).u32(4).string('note.txt').u32(4).string('renamed.txt').finish())
    expect(response.type).toBe(75)
    expect(await fs.stat('/Projects/renamed.txt')).toMatchObject({ kind: 'file' })

    response = await exchange(server, new P9Writer(76, 11).u32(4).string('renamed.txt').u32(0).finish())
    expect(response.type).toBe(77)
    await expect(fs.stat('/Projects/renamed.txt')).rejects.toThrow('not found')
  })
})
