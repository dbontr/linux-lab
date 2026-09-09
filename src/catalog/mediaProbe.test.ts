import { describe, expect, it } from 'vitest'
import { detectMediaKind } from './mediaProbe'

describe('boot-media detection', () => {
  it('recognizes ISO-9660 media from its volume signature', async () => {
    const bytes = new Uint8Array(0x8006)
    bytes.set(new TextEncoder().encode('CD001'), 0x8001)
    const file = new File([bytes], 'mystery.bin')
    await expect(detectMediaKind(file)).resolves.toBe('cdrom')
  })

  it('falls back to disk media for an IMG without an ISO signature', async () => {
    const file = new File([new Uint8Array(4096)], 'linux.img')
    await expect(detectMediaKind(file)).resolves.toBe('hda')
  })
})
