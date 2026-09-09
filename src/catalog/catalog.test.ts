import { describe, expect, it } from 'vitest'
import { createCustomManifest, validateRemoteUrl } from './catalog'

describe('distro catalog', () => {
  it('normalizes custom VM memory to a v86-compatible power of two', () => {
    const manifest = createCustomManifest({ name: 'Test', url: 'https://example.com/linux.iso', kind: 'cdrom', memoryMiB: 300 })
    expect(manifest.memoryMiB).toBe(256)
    expect(manifest.architecture).toBe('x86')
    expect(manifest.media?.kind).toBe('cdrom')
  })

  it('rejects non-web and credential-bearing image URLs', () => {
    expect(() => validateRemoteUrl('file:///tmp/linux.iso')).toThrow(/HTTP or HTTPS/)
    expect(() => validateRemoteUrl('https://user:pass@example.com/linux.iso')).toThrow(/credentials/)
  })
})
