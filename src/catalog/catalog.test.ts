import { describe, expect, it } from 'vitest'
import { createCustomManifest, validateRemoteUrl } from './catalog'

describe('distro catalog', () => {
  it('normalizes custom VM memory and selects runtime and firmware automatically', () => {
    const manifest = createCustomManifest({
      name: 'Test',
      source: 'https://example.com/linux.iso',
      kind: 'cdrom',
      memoryMiB: 300,
    })
    expect(manifest.memoryMiB).toBe(256)
    expect(manifest.architecture).toBe('auto')
    expect(manifest.runtime).toBe('auto')
    expect(manifest.firmware).toBe('auto')
    expect(manifest.media?.kind).toBe('cdrom')
  })

  it('keeps a local browser File as custom boot media', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'linux.img')
    const manifest = createCustomManifest({ name: '', source: file, kind: 'hda', memoryMiB: 512 })
    expect(manifest.name).toBe('linux')
    expect(manifest.media).toMatchObject({ kind: 'hda', file })
  })

  it('rejects non-web and credential-bearing image URLs', () => {
    expect(() => validateRemoteUrl('file:///tmp/linux.iso')).toThrow(/HTTP or HTTPS/)
    expect(() => validateRemoteUrl('https://user:pass@example.com/linux.iso')).toThrow(/credentials/)
  })
})
