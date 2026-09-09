export interface Qid {
  type: number
  version: number
  path: bigint
}

export class P9Reader {
  readonly type: number
  readonly tag: number
  private readonly view: DataView
  private readonly bytes: Uint8Array
  private offset = 7

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength < 7) throw new Error('9P message is too short')
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const declared = this.view.getUint32(0, true)
    if (declared !== bytes.byteLength) throw new Error('9P message size is invalid')
    this.type = this.view.getUint8(4)
    this.tag = this.view.getUint16(5, true)
  }

  u8(): number { return this.take(1, () => this.view.getUint8(this.offset)) }
  u16(): number { return this.take(2, () => this.view.getUint16(this.offset, true)) }
  u32(): number { return this.take(4, () => this.view.getUint32(this.offset, true)) }
  u64(): bigint { return this.take(8, () => this.view.getBigUint64(this.offset, true)) }

  string(): string {
    const length = this.u16()
    return new TextDecoder().decode(this.raw(length))
  }

  raw(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new Error('9P message is truncated')
    }
    const result = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }

  private take<T>(size: number, read: () => T): T {
    if (this.offset + size > this.bytes.byteLength) throw new Error('9P message is truncated')
    const value = read()
    this.offset += size
    return value
  }
}

export class P9Writer {
  private readonly payload: number[] = []
  private readonly type: number
  private readonly tag: number

  constructor(type: number, tag: number) {
    this.type = type
    this.tag = tag
  }

  u8(value: number): this { this.payload.push(value & 0xff); return this }
  u16(value: number): this { this.integer(BigInt(value >>> 0), 2); return this }
  u32(value: number): this { this.integer(BigInt(value >>> 0), 4); return this }
  u64(value: bigint | number): this { this.integer(BigInt(value), 8); return this }
  string(value: string): this {
    const bytes = new TextEncoder().encode(value)
    if (bytes.byteLength > 0xffff) throw new Error('9P string is too long')
    return this.u16(bytes.byteLength).bytes(bytes)
  }
  bytes(value: Uint8Array): this {
    for (const byte of value) this.payload.push(byte)
    return this
  }
  qid(value: Qid): this { return this.u8(value.type).u32(value.version).u64(value.path) }

  finish(): Uint8Array {
    const result = new Uint8Array(7 + this.payload.length)
    const view = new DataView(result.buffer)
    view.setUint32(0, result.byteLength, true)
    view.setUint8(4, this.type)
    view.setUint16(5, this.tag, true)
    result.set(this.payload, 7)
    return result
  }

  private integer(value: bigint, bytes: number): void {
    let remaining = BigInt.asUintN(bytes * 8, value)
    for (let index = 0; index < bytes; index += 1) {
      this.payload.push(Number(remaining & 0xffn))
      remaining >>= 8n
    }
  }
}

export function hashPath(path: string): bigint {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(path)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash || 1n
}
