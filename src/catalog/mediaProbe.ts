import type { FirmwareKind, MediaKind } from './types'

const ISO_SECTOR_SIZE = 2048
const ISO_PVD_SIGNATURE_OFFSET = 0x8001
const ISO_PVD_SIGNATURE = 'CD001'
const EL_TORITO_ID = 'EL TORITO SPECIFICATION'
const EFI_PLATFORM_ID = 0xef
const GPT_SIGNATURE = 'EFI PART'
const ESP_GUID = new Uint8Array([
  0x28, 0x73, 0x2a, 0xc1, 0x1f, 0xf8, 0xd2, 0x11,
  0xba, 0x4b, 0x00, 0xa0, 0xc9, 0x3e, 0xc9, 0x3b,
])

export async function detectMediaKind(file: File): Promise<MediaKind> {
  if (file.size >= ISO_PVD_SIGNATURE_OFFSET + ISO_PVD_SIGNATURE.length) {
    const bytes = await readBytes(file, ISO_PVD_SIGNATURE_OFFSET, ISO_PVD_SIGNATURE.length)
    if (ascii(bytes) === ISO_PVD_SIGNATURE) return 'cdrom'
  }
  return file.name.toLocaleLowerCase().endsWith('.iso') ? 'cdrom' : 'hda'
}

export async function detectFirmwareKind(file: File, kind: MediaKind): Promise<Exclude<FirmwareKind, 'auto'>> {
  return kind === 'cdrom'
    ? await isoSupportsUefi(file) ? 'uefi' : 'bios'
    : await diskSupportsUefi(file) ? 'uefi' : 'bios'
}

async function isoSupportsUefi(file: File): Promise<boolean> {
  for (let sector = 16; sector < 32; sector += 1) {
    const descriptor = await readBytes(file, sector * ISO_SECTOR_SIZE, ISO_SECTOR_SIZE)
    if (descriptor.length < ISO_SECTOR_SIZE || ascii(descriptor.subarray(1, 6)) !== ISO_PVD_SIGNATURE) break
    if (descriptor[0] === 255) break
    if (descriptor[0] !== 0) continue
    const systemId = ascii(descriptor.subarray(7, 39)).replace(/[\0 ]+$/g, '')
    if (systemId !== EL_TORITO_ID) continue
    const catalogLba = new DataView(descriptor.buffer, descriptor.byteOffset).getUint32(71, true)
    return bootCatalogSupportsUefi(await readBytes(file, catalogLba * ISO_SECTOR_SIZE, 16 * ISO_SECTOR_SIZE))
  }
  return false
}
function bootCatalogSupportsUefi(catalog: Uint8Array): boolean {
  if (catalog.length < 64) return false
  if (catalog[1] === EFI_PLATFORM_ID && catalog[0x20] === 0x88) return true
  for (let offset = 0x40; offset + 0x20 <= catalog.length; offset += 0x20) {
    const indicator = catalog[offset]
    if ((indicator === 0x90 || indicator === 0x91) && catalog[offset + 1] === EFI_PLATFORM_ID) return true
  }
  return false
}

async function diskSupportsUefi(file: File): Promise<boolean> {
  const firstSector = await readBytes(file, 0, 512)
  if (firstSector.length >= 512) {
    for (let entry = 0; entry < 4; entry += 1) {
      if (firstSector[446 + entry * 16 + 4] === EFI_PLATFORM_ID) return true
    }
  }
  return await gptContainsEsp(file, 512) || await gptContainsEsp(file, 4096)
}

async function gptContainsEsp(file: File, sectorSize: number): Promise<boolean> {
  const header = await readBytes(file, sectorSize, sectorSize)
  if (header.length < 92 || ascii(header.subarray(0, 8)) !== GPT_SIGNATURE) return false
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const tableLba = Number(view.getBigUint64(72, true))
  const entryCount = Math.min(view.getUint32(80, true), 256)
  const entrySize = view.getUint32(84, true)
  if (!Number.isSafeInteger(tableLba) || entrySize < 128 || entrySize > 4096) return false
  const tableLength = entryCount * entrySize
  const table = await readBytes(file, tableLba * sectorSize, tableLength)
  for (let entry = 0; entry < entryCount; entry += 1) {
    const offset = entry * entrySize
    if (offset + ESP_GUID.length > table.length) break
    if (bytesEqual(table.subarray(offset, offset + ESP_GUID.length), ESP_GUID)) return true
  }
  return false
}
async function readBytes(file: File, offset: number, length: number): Promise<Uint8Array> {
  if (offset < 0 || length <= 0 || offset >= file.size) return new Uint8Array()
  return new Uint8Array(await file.slice(offset, Math.min(file.size, offset + length)).arrayBuffer())
}

function ascii(bytes: Uint8Array): string {
  return new TextDecoder('ascii').decode(bytes)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function mediaKindLabel(kind: MediaKind): string {
  return kind === 'cdrom' ? 'ISO / optical disc' : 'IMG / hard disk'
}

export function firmwareKindLabel(kind: FirmwareKind): string {
  if (kind === 'uefi') return 'UEFI'
  if (kind === 'bios') return 'Legacy BIOS'
  return 'Auto detect'
}
