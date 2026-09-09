import { describe, expect, it } from 'vitest'
import { P9Reader, P9Writer, hashPath } from './p9Codec'

describe('9P codec', () => {
  it('round-trips primitive values in little-endian messages', () => {
    const message = new P9Writer(100, 0xffff)
      .u8(0xab).u16(0xcdef).u32(0x12345678).u64(0x1122334455667788n).string('9P2000.L').finish()
    const reader = new P9Reader(message)
    expect(reader.type).toBe(100)
    expect(reader.tag).toBe(0xffff)
    expect(reader.u8()).toBe(0xab)
    expect(reader.u16()).toBe(0xcdef)
    expect(reader.u32()).toBe(0x12345678)
    expect(reader.u64()).toBe(0x1122334455667788n)
    expect(reader.string()).toBe('9P2000.L')
  })

  it('uses stable nonzero qid path hashes', () => {
    expect(hashPath('/Documents/test.txt')).toBe(hashPath('/Documents/test.txt'))
    expect(hashPath('/Documents/test.txt')).not.toBe(hashPath('/Documents/other.txt'))
    expect(hashPath('/')).not.toBe(0n)
  })
})
