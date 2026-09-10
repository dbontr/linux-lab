import { describe, expect, it } from 'vitest'
import type { DistroManifest } from '../catalog/types'
import { runtimeForManifest } from './linuxRuntime'

function manifest(overrides: Partial<DistroManifest> = {}): DistroManifest {
  return {
    id: 'test',
    name: 'Test Linux',
    version: '1',
    architecture: 'x86',
    summary: 'test',
    media: { kind: 'cdrom', path: 'distros/test.iso' },
    memoryMiB: 256,
    vgaMemoryMiB: 8,
    ...overrides,
  }
}

describe('runtime selection', () => {
  it('uses v86 for prepared direct-Linux guests', () => {
    expect(runtimeForManifest(manifest({
      media: undefined,
      linux: { descriptorPath: 'distros/test/boot.json' },
    }))).toBe('v86')
  })

  it('uses v86 for cataloged 32-bit x86 media', () => {
    expect(runtimeForManifest(manifest())).toBe('v86')
  })

  it('uses QEMU for x86-64 and architecture-unknown custom media', () => {
    expect(runtimeForManifest(manifest({ architecture: 'x86_64' }))).toBe('qemu')
    expect(runtimeForManifest(manifest({ architecture: 'auto' }))).toBe('qemu')
  })

  it('honors explicit runtime overrides', () => {
    expect(runtimeForManifest(manifest({ runtime: 'qemu' }))).toBe('qemu')
    expect(runtimeForManifest(manifest({
      architecture: 'x86_64',
      runtime: 'v86',
    }))).toBe('v86')
  })
})
