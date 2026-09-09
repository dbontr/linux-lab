import { basename, joinPath, normalizePath, parentPath, type CloudFilesystem, type FsEntry } from './filesystem'
import { hashPath, P9Reader, P9Writer, type Qid } from './p9Codec'

const T = {
  statfs: 8, lopen: 12, lcreate: 14, rename: 20, getattr: 24, setattr: 26,
  readdir: 40, fsync: 50, lock: 52, getlock: 54, mkdir: 72, renameat: 74, unlinkat: 76,
  version: 100, auth: 102, attach: 104, flush: 108, walk: 110,
  read: 116, write: 118, clunk: 120, remove: 122,
} as const
const R = {
  lerror: 7, statfs: 9, lopen: 13, lcreate: 15, rename: 21, getattr: 25, setattr: 27,
  readdir: 41, fsync: 51, lock: 53, getlock: 55, mkdir: 73, renameat: 75, unlinkat: 77,
  version: 101, attach: 105, flush: 109, walk: 111,
  read: 117, write: 119, clunk: 121, remove: 123,
} as const
const ERRNO = { ENOENT: 2, EIO: 5, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOSYS: 38, ENOTEMPTY: 39, EOPNOTSUPP: 95 } as const
const QID_DIR = 0x80
const MODE_DIR = 0o040755
const MODE_FILE = 0o100644
const ATTR_ALL = 0x3fffn
const SETATTR_SIZE = 0x08
const IO_UNIT = 256 * 1024

interface FidState { path: string; entry: FsEntry }
interface DirtyFile { data: Uint8Array; dirty: boolean }

export class OneDrive9PServer {
  private readonly fids = new Map<number, FidState>()
  private readonly files = new Map<string, DirtyFile>()
  private readonly fs: CloudFilesystem
  private msize = 1024 * 1024

  constructor(fs: CloudFilesystem) {
    this.fs = fs
  }

  handle9p = (request: Uint8Array, reply: (response: Uint8Array) => void): void => {
    let reader: P9Reader
    try { reader = new P9Reader(request) } catch { reply(errorReply(0xffff, ERRNO.EINVAL)); return }
    void this.dispatch(reader).then(reply).catch((error) => reply(errorReply(reader.tag, errnoFor(error))))
  }

  private async dispatch(reader: P9Reader): Promise<Uint8Array> {
    switch (reader.type) {
      case T.version: return this.version(reader)
      case T.auth: return errorReply(reader.tag, ERRNO.EOPNOTSUPP)
      case T.attach: return this.attach(reader)
      case T.flush: return new P9Writer(R.flush, reader.tag).finish()
      case T.walk: return this.walk(reader)
      case T.statfs: return this.statfs(reader)
      case T.lopen: return this.lopen(reader)
      case T.lcreate: return this.lcreate(reader)
      case T.getattr: return this.getattr(reader)
      case T.setattr: return this.setattr(reader)
      case T.readdir: return this.readdir(reader)
      case T.read: return this.read(reader)
      case T.write: return this.write(reader)
      case T.fsync: return this.fsync(reader)
      case T.clunk: return this.clunk(reader)
      case T.remove: return this.remove(reader)
      case T.mkdir: return this.mkdir(reader)
      case T.rename: return this.rename(reader)
      case T.renameat: return this.renameat(reader)
      case T.unlinkat: return this.unlinkat(reader)
      case T.lock: return this.lock(reader)
      case T.getlock: return this.getlock(reader)
      default: return errorReply(reader.tag, ERRNO.EOPNOTSUPP)
    }
  }

  private version(reader: P9Reader): Uint8Array {
    const requested = reader.u32()
    const version = reader.string()
    this.msize = Math.min(Math.max(4096, requested), 1024 * 1024)
    this.fids.clear()
    this.files.clear()
    return new P9Writer(R.version, reader.tag).u32(this.msize).string(version === '9P2000.L' ? '9P2000.L' : 'unknown').finish()
  }

  private async attach(reader: P9Reader): Promise<Uint8Array> {
    const fid = reader.u32()
    reader.u32()
    reader.string()
    reader.string()
    reader.u32()
    const entry = await this.fs.stat('/')
    this.fids.set(fid, { path: '/', entry })
    return new P9Writer(R.attach, reader.tag).qid(qid(entry)).finish()
  }

  private async walk(reader: P9Reader): Promise<Uint8Array> {
    const fid = reader.u32()
    const newfid = reader.u32()
    const count = reader.u16()
    const source = this.requireFid(fid)
    let current = { ...source }
    const qids: Qid[] = []
    for (let index = 0; index < count; index += 1) {
      const name = reader.string()
      const nextPath = name === '..' ? parentPath(current.path) : name === '.' ? current.path : joinPath(current.path, name)
      try {
        const entry = await this.statPath(nextPath)
        current = { path: nextPath, entry }
        qids.push(qid(entry))
      } catch (error) {
        if (qids.length === 0) throw error
        break
      }
    }
    this.fids.set(newfid, current)
    const writer = new P9Writer(R.walk, reader.tag).u16(qids.length)
    for (const item of qids) writer.qid(item)
    return writer.finish()
  }

  private statfs(reader: P9Reader): Uint8Array {
    this.requireFid(reader.u32())
    const blocks = 256n * 1024n * 1024n
    return new P9Writer(R.statfs, reader.tag)
      .u32(0x01021997).u32(4096).u64(blocks).u64(blocks).u64(blocks)
      .u64(1_000_000n).u64(1_000_000n).u64(hashPath('/')).u32(255).finish()
  }

  private lopen(reader: P9Reader): Uint8Array {
    const state = this.requireFid(reader.u32())
    reader.u32()
    return new P9Writer(R.lopen, reader.tag).qid(qid(state.entry)).u32(IO_UNIT).finish()
  }

  private async lcreate(reader: P9Reader): Promise<Uint8Array> {
    const fid = reader.u32()
    const name = reader.string()
    reader.u32()
    reader.u32()
    reader.u32()
    const parent = this.requireFid(fid)
    if (parent.entry.kind !== 'directory') throw errnoError(ERRNO.ENOTDIR)
    const path = joinPath(parent.path, name)
    const entry = await this.fs.write(path, new Uint8Array())
    this.files.set(path, { data: new Uint8Array(), dirty: false })
    this.fids.set(fid, { path, entry })
    return new P9Writer(R.lcreate, reader.tag).qid(qid(entry)).u32(IO_UNIT).finish()
  }

  private async getattr(reader: P9Reader): Promise<Uint8Array> {
    const state = this.requireFid(reader.u32())
    reader.u64()
    const entry = await this.statPath(state.path)
    state.entry = entry
    const seconds = BigInt(Math.floor(entry.modifiedAt / 1000))
    const blocks = BigInt(Math.ceil(entry.size / 512))
    return new P9Writer(R.getattr, reader.tag)
      .u64(ATTR_ALL).qid(qid(entry)).u32(entry.kind === 'directory' ? MODE_DIR : MODE_FILE)
      .u32(0).u32(0).u64(1).u64(0).u64(entry.size).u64(4096).u64(blocks)
      .u64(seconds).u64(0).u64(seconds).u64(0).u64(seconds).u64(0)
      .u64(0).u64(0).u64(0).u64(0).finish()
  }

  private async setattr(reader: P9Reader): Promise<Uint8Array> {
    const state = this.requireFid(reader.u32())
    const valid = reader.u32()
    reader.u32(); reader.u32(); reader.u32()
    const size = reader.u64()
    reader.u64(); reader.u64(); reader.u64(); reader.u64()
    if (valid & SETATTR_SIZE) {
      if (state.entry.kind !== 'file') throw errnoError(ERRNO.EISDIR)
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw errnoError(ERRNO.EINVAL)
      const file = await this.fileBuffer(state.path)
      const next = new Uint8Array(Number(size))
      next.set(file.data.slice(0, next.byteLength))
      this.files.set(state.path, { data: next, dirty: true })
      state.entry = { ...state.entry, size: next.byteLength, modifiedAt: Date.now() }
    }
    return new P9Writer(R.setattr, reader.tag).finish()
  }

  private async read(reader: P9Reader): Promise<Uint8Array> {
    const state = this.requireFid(reader.u32())
    const offset = reader.u64()
    const count = reader.u32()
    if (state.entry.kind !== 'file') throw errnoError(ERRNO.EISDIR)
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw errnoError(ERRNO.EINVAL)
    const file = await this.fileBuffer(state.path)
    const start = Number(offset)
    const data = file.data.slice(start, Math.min(file.data.byteLength, start + count))
    return new P9Writer(R.read, reader.tag).u32(data.byteLength).bytes(data).finish()
  }

  private async write(reader: P9Reader): Promise<Uint8Array> {
    const state = this.requireFid(reader.u32())
    const offset = reader.u64()
    const count = reader.u32()
    const incoming = reader.raw(count)
    if (state.entry.kind !== 'file') throw errnoError(ERRNO.EISDIR)
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw errnoError(ERRNO.EINVAL)
    const start = Number(offset)
    const file = await this.fileBuffer(state.path)
    const required = start + incoming.byteLength
    let data = file.data
    if (required > data.byteLength) {
      data = new Uint8Array(required)
      data.set(file.data)
    } else {
      data = data.slice()
    }
    data.set(incoming, start)
    this.files.set(state.path, { data, dirty: true })
    state.entry = { ...state.entry, size: data.byteLength, modifiedAt: Date.now() }
    return new P9Writer(R.write, reader.tag).u32(incoming.byteLength).finish()
  }

  private async readdir(reader: P9Reader): Promise<Uint8Array> {
    const state = this.requireFid(reader.u32())
    const offset = reader.u64()
    const count = reader.u32()
    if (state.entry.kind !== 'directory') throw errnoError(ERRNO.ENOTDIR)
    const actual = await this.fs.list(state.path)
    const parent = await this.statPath(parentPath(state.path))
    const entries = [
      { ...state.entry, name: '.' },
      { ...parent, name: '..' },
      ...actual,
    ]
    const start = Number(offset)
    if (!Number.isSafeInteger(start) || start < 0) throw errnoError(ERRNO.EINVAL)
    const payload = new P9Writer(0, 0)
    let used = 0
    for (let index = start; index < entries.length; index += 1) {
      const entry = entries[index]
      const record = new P9Writer(0, 0).qid(qid(entry)).u64(index + 1).u8(entry.kind === 'directory' ? 4 : 8).string(entry.name)
      const bytes = record.finish().slice(7)
      if (used + bytes.byteLength > count) break
      payload.bytes(bytes)
      used += bytes.byteLength
    }
    const data = payload.finish().slice(7)
    return new P9Writer(R.readdir, reader.tag).u32(data.byteLength).bytes(data).finish()
  }

  private async fsync(reader: P9Reader): Promise<Uint8Array> {
    const state = this.requireFid(reader.u32())
    reader.u32()
    await this.flushPath(state.path)
    return new P9Writer(R.fsync, reader.tag).finish()
  }

  private async clunk(reader: P9Reader): Promise<Uint8Array> {
    const fid = reader.u32()
    const state = this.requireFid(fid)
    await this.flushPath(state.path)
    this.fids.delete(fid)
    return new P9Writer(R.clunk, reader.tag).finish()
  }

  private async remove(reader: P9Reader): Promise<Uint8Array> {
    const fid = reader.u32()
    const state = this.requireFid(fid)
    if (state.entry.kind === 'directory' && (await this.fs.list(state.path)).length > 0) {
      throw errnoError(ERRNO.ENOTEMPTY)
    }
    this.files.delete(state.path)
    await this.fs.remove(state.path)
    this.fids.delete(fid)
    return new P9Writer(R.remove, reader.tag).finish()
  }

  private async mkdir(reader: P9Reader): Promise<Uint8Array> {
    const parent = this.requireFid(reader.u32())
    const name = reader.string()
    reader.u32(); reader.u32()
    if (parent.entry.kind !== 'directory') throw errnoError(ERRNO.ENOTDIR)
    const entry = await this.fs.mkdir(joinPath(parent.path, name))
    return new P9Writer(R.mkdir, reader.tag).qid(qid(entry)).finish()
  }

  private async rename(reader: P9Reader): Promise<Uint8Array> {
    const state = this.requireFid(reader.u32())
    const parent = this.requireFid(reader.u32())
    const name = reader.string()
    const destination = joinPath(parent.path, name)
    await this.flushPath(state.path)
    await this.fs.rename(state.path, destination)
    this.repath(state.path, destination)
    return new P9Writer(R.rename, reader.tag).finish()
  }

  private async renameat(reader: P9Reader): Promise<Uint8Array> {
    const oldParent = this.requireFid(reader.u32())
    const oldName = reader.string()
    const newParent = this.requireFid(reader.u32())
    const newName = reader.string()
    const source = joinPath(oldParent.path, oldName)
    const destination = joinPath(newParent.path, newName)
    await this.flushPath(source)
    await this.fs.rename(source, destination)
    this.repath(source, destination)
    return new P9Writer(R.renameat, reader.tag).finish()
  }

  private async unlinkat(reader: P9Reader): Promise<Uint8Array> {
    const parent = this.requireFid(reader.u32())
    const name = reader.string()
    const flags = reader.u32()
    const path = joinPath(parent.path, name)
    const entry = await this.statPath(path)
    const removeDirectory = (flags & 0x200) !== 0
    if (entry.kind === 'directory') {
      if (!removeDirectory) throw errnoError(ERRNO.EISDIR)
      if ((await this.fs.list(path)).length > 0) throw errnoError(ERRNO.ENOTEMPTY)
    } else if (removeDirectory) {
      throw errnoError(ERRNO.ENOTDIR)
    }
    this.files.delete(path)
    await this.fs.remove(path)
    return new P9Writer(R.unlinkat, reader.tag).finish()
  }

  private lock(reader: P9Reader): Uint8Array {
    this.requireFid(reader.u32())
    reader.u8(); reader.u32(); reader.u64(); reader.u64(); reader.u32(); reader.string()
    return new P9Writer(R.lock, reader.tag).u8(0).finish()
  }

  private getlock(reader: P9Reader): Uint8Array {
    this.requireFid(reader.u32())
    reader.u8()
    const start = reader.u64()
    const length = reader.u64()
    const process = reader.u32()
    const client = reader.string()
    return new P9Writer(R.getlock, reader.tag).u8(2).u64(start).u64(length).u32(process).string(client).finish()
  }

  private requireFid(fid: number): FidState {
    const state = this.fids.get(fid)
    if (!state) throw errnoError(ERRNO.ENOENT)
    return state
  }

  private async statPath(path: string): Promise<FsEntry> {
    const normalized = normalizePath(path)
    const cached = this.files.get(normalized)
    const entry = await this.fs.stat(normalized)
    return cached ? { ...entry, size: cached.data.byteLength } : entry
  }

  private async fileBuffer(path: string): Promise<DirtyFile> {
    const normalized = normalizePath(path)
    const cached = this.files.get(normalized)
    if (cached) return cached
    const value = { data: await this.fs.read(normalized), dirty: false }
    this.files.set(normalized, value)
    return value
  }

  private async flushPath(path: string): Promise<void> {
    const normalized = normalizePath(path)
    const cached = this.files.get(normalized)
    if (!cached?.dirty) return
    const entry = await this.fs.write(normalized, cached.data)
    this.files.set(normalized, { data: cached.data, dirty: false })
    for (const state of this.fids.values()) {
      if (state.path === normalized) state.entry = entry
    }
  }

  private repath(source: string, destination: string): void {
    const from = normalizePath(source)
    const to = normalizePath(destination)
    const cached = this.files.get(from)
    if (cached) { this.files.delete(from); this.files.set(to, cached) }
    for (const state of this.fids.values()) {
      if (state.path === from || state.path.startsWith(`${from}/`)) {
        state.path = `${to}${state.path.slice(from.length)}`
        state.entry = { ...state.entry, path: state.path, name: basename(state.path) }
      }
    }
  }
}

function qid(entry: FsEntry): Qid {
  return {
    type: entry.kind === 'directory' ? QID_DIR : 0,
    version: Math.floor(entry.modifiedAt / 1000) >>> 0,
    path: hashPath(entry.path),
  }
}

function errorReply(tag: number, errno: number): Uint8Array {
  return new P9Writer(R.lerror, tag).u32(errno).finish()
}

function errnoError(errno: number): Error {
  const error = new Error(`9P errno ${errno}`)
  Object.assign(error, { errno })
  return error
}

function errnoFor(error: unknown): number {
  if (error && typeof error === 'object' && 'errno' in error && typeof error.errno === 'number') return error.errno
  const message = error instanceof Error ? error.message : String(error)
  if (/HTTP 404|not found|does not exist/i.test(message)) return ERRNO.ENOENT
  if (/HTTP 403|forbidden|access denied/i.test(message)) return ERRNO.EACCES
  if (/HTTP 409|already exists|conflict/i.test(message)) return ERRNO.EEXIST
  if (/not a directory/i.test(message)) return ERRNO.ENOTDIR
  if (/is a directory/i.test(message)) return ERRNO.EISDIR
  if (/invalid/i.test(message)) return ERRNO.EINVAL
  return ERRNO.EIO
}
