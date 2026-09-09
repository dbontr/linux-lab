import type {
  Architecture,
  CatalogLoadResult,
  CustomBootRequest,
  DirectLinuxBootDescriptor,
  DistroManifest,
  DistroMedia,
  FirmwareKind,
  MediaKind,
  RuntimeKind,
} from './types'

const CATALOG_PATH = 'distros/catalog.json'
const MIN_MEMORY_MIB = 64
const MAX_MEMORY_MIB = 2048

export async function loadCatalog(): Promise<CatalogLoadResult> {
  const source = assetUrl(CATALOG_PATH)
  const response = await fetch(source, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`Distro catalog request failed with HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!Array.isArray(value)) throw new Error('Distro catalog must be an array')
  const distros = value.map((entry, index) => validateManifest(entry, index))
  if (distros.length === 0) throw new Error('Distro catalog is empty')
  return { distros, source }
}

export function mediaUrl(manifest: DistroManifest): string {
  const media = requireMedia(manifest)
  if ('file' in media) throw new Error(`${manifest.name} uses a local file`)
  return media.path.startsWith('http')
    ? validateRemoteUrl(media.path)
    : assetUrl(media.path)
}

export function localMediaFile(manifest: DistroManifest): File | null {
  const media = manifest.media
  return media && 'file' in media ? media.file : null
}

export async function loadDirectLinuxBoot(manifest: DistroManifest): Promise<{
  descriptor: DirectLinuxBootDescriptor
  baseUrl: string
}> {
  if (!manifest.linux) throw new Error(`${manifest.name} does not use direct Linux boot`)
  const descriptorUrl = assetUrl(validateLocalAssetPath(manifest.linux.descriptorPath))
  const response = await fetch(descriptorUrl, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`Linux boot descriptor request failed with HTTP ${response.status}`)
  const descriptor = validateDirectLinuxBoot(await response.json())
  return { descriptor, baseUrl: new URL('./', descriptorUrl).href }
}

export function createCustomManifest(request: CustomBootRequest): DistroManifest {
  const name = request.name.trim() || sourceName(request.source)
  const memoryMiB = clampMemory(request.memoryMiB)
  const media: DistroMedia = typeof request.source === 'string'
    ? { kind: request.kind, path: validateRemoteUrl(request.source) }
    : { kind: request.kind, file: request.source }
  const identity = typeof request.source === 'string'
    ? request.source
    : `${request.source.name}:${request.source.size}:${request.source.lastModified}`

  return {
    id: `custom-${simpleHash(identity)}`,
    name,
    version: 'custom',
    architecture: 'auto',
    runtime: request.runtime ?? 'auto',
    firmware: request.firmware ?? 'auto',
    summary: 'User-supplied PC boot media. Linux Lab selects the compatible browser runtime.',
    media,
    memoryMiB,
    vgaMemoryMiB: 16,
  }
}

function validateManifest(value: unknown, index: number): DistroManifest {
  if (!value || typeof value !== 'object') throw new Error(`Distro ${index} is not an object`)
  const entry = value as Record<string, unknown>
  const architecture = validateArchitecture(entry.architecture, index)
  const media = validateMedia(entry.media, index)
  const linux = validateLinux(entry.linux, index)
  if (Boolean(media) === Boolean(linux)) {
    throw new Error(`Distro ${index} must define exactly one boot source`)
  }

  const result: DistroManifest = {
    id: requiredString(entry.id, `Distro ${index} id`),
    name: requiredString(entry.name, `Distro ${index} name`),
    version: requiredString(entry.version, `Distro ${index} version`),
    architecture,
    summary: requiredString(entry.summary, `Distro ${index} summary`),
    memoryMiB: clampMemory(requiredNumber(entry.memoryMiB, `Distro ${index} memory`)),
    vgaMemoryMiB: clampVgaMemory(requiredNumber(entry.vgaMemoryMiB, `Distro ${index} VGA memory`)),
  }
  if (media) result.media = media
  if (linux) result.linux = linux
  const runtime = validateRuntime(entry.runtime)
  if (runtime) result.runtime = runtime
  const firmware = validateFirmware(entry.firmware)
  if (firmware) result.firmware = firmware
  if (entry.networkDevice === 'ne2k' || entry.networkDevice === 'virtio') {
    result.networkDevice = entry.networkDevice
  }
  if (entry.homepage !== undefined) {
    result.homepage = validateRemoteUrl(requiredString(entry.homepage, `Distro ${index} homepage`))
  }
  return result
}

function validateMedia(value: unknown, index: number): DistroManifest['media'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error(`Distro ${index} has invalid media`)
  const media = value as Record<string, unknown>
  const kind = media.kind
  if (kind !== 'cdrom' && kind !== 'hda') throw new Error(`Distro ${index} has unsupported media kind`)
  return { kind: kind as MediaKind, path: requiredString(media.path, `Distro ${index} media path`) }
}

function validateLinux(value: unknown, index: number): DistroManifest['linux'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error(`Distro ${index} has invalid Linux boot descriptor`)
  const linux = value as Record<string, unknown>
  return {
    descriptorPath: validateLocalAssetPath(
      requiredString(linux.descriptorPath, `Distro ${index} descriptor path`),
    ),
  }
}

function validateDirectLinuxBoot(value: unknown): DirectLinuxBootDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Linux boot descriptor must be an object')
  const entry = value as Record<string, unknown>
  const fixedChunkSize = requiredInteger(entry.fixedChunkSize, 'Linux boot chunk size')
  const rootfsSize = requiredInteger(entry.rootfsSize, 'Linux root filesystem size')
  if (fixedChunkSize < 256 || fixedChunkSize % 256 !== 0) {
    throw new Error('Linux boot chunk size must be a multiple of 256 bytes')
  }
  if (rootfsSize < fixedChunkSize || rootfsSize % fixedChunkSize !== 0) {
    throw new Error('Linux root filesystem size must align to its chunk size')
  }
  return {
    kernel: validateRelativeAssetName(requiredString(entry.kernel, 'Linux kernel path')),
    initrd: validateRelativeAssetName(requiredString(entry.initrd, 'Linux initramfs path')),
    rootfs: validateRelativeAssetName(requiredString(entry.rootfs, 'Linux root filesystem path')),
    rootfsSize,
    fixedChunkSize,
    cmdline: requiredString(entry.cmdline, 'Linux kernel command line'),
  }
}

export function assetUrl(path: string): string {
  const relative = path.replace(/^\/+/, '')
  return new URL(`${import.meta.env.BASE_URL}${relative}`, location.origin).href
}

export function validateRemoteUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Image URL must use HTTP or HTTPS')
  if (typeof location !== 'undefined' && location.protocol === 'https:' && url.protocol !== 'https:') {
    throw new Error('Image URL must use HTTPS when Linux Lab is served over HTTPS')
  }
  if (url.username || url.password) throw new Error('Image URL must not contain credentials')
  return url.href
}

function validateArchitecture(value: unknown, index: number): Architecture {
  if (value === 'x86' || value === 'x86_64') return value
  throw new Error(`Distro ${index} has unsupported architecture`)
}

function validateRuntime(value: unknown): RuntimeKind | undefined {
  if (value === undefined) return undefined
  if (value === 'v86' || value === 'qemu' || value === 'auto') return value
  throw new Error('Distro runtime must be v86, qemu, or auto')
}

function validateFirmware(value: unknown): FirmwareKind | undefined {
  if (value === undefined) return undefined
  if (value === 'bios' || value === 'uefi' || value === 'auto') return value
  throw new Error('Distro firmware must be bios, uefi, or auto')
}

function validateLocalAssetPath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Local asset path must stay inside the Linux Lab deployment')
  }
  return normalized
}

function validateRelativeAssetName(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  if (normalized.includes('/') || normalized === '.' || normalized === '..') {
    throw new Error('Linux boot files must be descriptor-local names')
  }
  return normalized
}

function requireMedia(manifest: DistroManifest): DistroMedia {
  if (!manifest.media) throw new Error(`${manifest.name} does not use boot media`)
  return manifest.media
}

function sourceName(source: string | File): string {
  if (typeof source !== 'string') return source.name.replace(/\.(iso|img|raw)$/i, '') || 'Custom Linux'
  try {
    const name = new URL(source).pathname.split('/').pop() ?? ''
    return decodeURIComponent(name).replace(/\.(iso|img|raw)$/i, '') || 'Custom Linux'
  } catch {
    return 'Custom Linux'
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function requiredInteger(value: unknown, label: string): number {
  const result = requiredNumber(value, label)
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive safe integer`)
  return result
}

function clampMemory(value: number): number {
  const bounded = Math.min(MAX_MEMORY_MIB, Math.max(MIN_MEMORY_MIB, value))
  const exponent = Math.round(Math.log2(bounded))
  return Math.min(MAX_MEMORY_MIB, Math.max(MIN_MEMORY_MIB, 2 ** exponent))
}

function clampVgaMemory(value: number): number {
  return Math.min(64, Math.max(1, Math.round(value)))
}

function simpleHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
