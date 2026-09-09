export type MediaKind = 'cdrom' | 'hda'
export type Architecture = 'x86' | 'x86_64' | 'auto'
export type RuntimeKind = 'v86' | 'qemu' | 'auto'
export type FirmwareKind = 'bios' | 'uefi' | 'auto'

export interface RemoteDistroMedia {
  kind: MediaKind
  path: string
}

export interface LocalDistroMedia {
  kind: MediaKind
  file: File
}

export type DistroMedia = RemoteDistroMedia | LocalDistroMedia

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
  architecture: Architecture
  runtime?: RuntimeKind
  firmware?: FirmwareKind
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
  source: string | File
  kind: MediaKind
  memoryMiB: number
  runtime?: RuntimeKind
  firmware?: FirmwareKind
}

export interface CatalogLoadResult {
  distros: DistroManifest[]
  source: string
}
