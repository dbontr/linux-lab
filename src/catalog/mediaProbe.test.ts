import { describe, expect, it } from 'vitest'
import { detectFirmwareKind, detectMediaKind } from './mediaProbe'

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

  it('detects a UEFI El Torito section in an ISO', async () => {
    const bytes = new Uint8Array(40 * 2048)
    bytes[16 * 2048] = 1
    bytes.set(new TextEncoder().encode('CD001'), 16 * 2048 + 1)
    const descriptor = 17 * 2048
    bytes[descriptor] = 0
    bytes.set(new TextEncoder().encode('CD001'), descriptor + 1)
    bytes.set(new TextEncoder().encode('EL TORITO SPECIFICATION'), descriptor + 7)
    new DataView(bytes.buffer).setUint32(descriptor + 71, 24, true)
    bytes[24 * 2048 + 0x40] = 0x90
    bytes[24 * 2048 + 0x41] = 0xef
    await expect(detectFirmwareKind(new File([bytes], 'uefi.iso'), 'cdrom')).resolves.toBe('uefi')
  })

  it('detects an EFI System Partition in a GPT disk image', async () => {
    const bytes = new Uint8Array(4096)
    bytes.set(new TextEncoder().encode('EFI PART'), 512)
    const header = new DataView(bytes.buffer, 512)
    header.setBigUint64(72, 2n, true)
    header.setUint32(80, 1, true)
    header.setUint32(84, 128, true)
    bytes.set([
      0x28, 0x73, 0x2a, 0xc1, 0x1f, 0xf8, 0xd2, 0x11,
      0xba, 0x4b, 0x00, 0xa0, 0xc9, 0x3e, 0xc9, 0x3b,
    ], 1024)
    await expect(detectFirmwareKind(new File([bytes], 'uefi.img'), 'hda')).resolves.toBe('uefi')
  })

  it('uses legacy BIOS when no EFI structures are present', async () => {
    const file = new File([new Uint8Array(4096)], 'legacy.img')
    await expect(detectFirmwareKind(file, 'hda')).resolves.toBe('bios')
  })
})
