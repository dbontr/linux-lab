export type MediaKind = 'cdrom' | 'hda'

export interface DistroMedia {
  kind: MediaKind
  path: string
}

export interface DirectLinuxBoot {
  descriptorPath: string
}

export interface DirectLinuxBootDescriptor {
  kernel: string
  initrd: string
  rootfs: string
  rootfsSize: number
  fixedChunkSize: number
  cmdline: string
}

export interface DistroManifest {
  id: string
  name: string
  version: string
  architecture: 'x86'
  summary: string
  media?: DistroMedia
  linux?: DirectLinuxBoot
  memoryMiB: number
  vgaMemoryMiB: number
  networkDevice?: 'ne2k' | 'virtio'
  homepage?: string
}

export interface CustomBootRequest {
  name: string
  url: string
  kind: MediaKind
  memoryMiB: number
}

export interface CatalogLoadResult {
  distros: DistroManifest[]
  source: string
}
