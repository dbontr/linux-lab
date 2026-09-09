import { open, readFile, stat } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

const ISO_SECTOR_SIZE = 2048
const root = fileURLToPath(new URL('..', import.meta.url))
const catalog = JSON.parse(await readFile(join(root, 'public/distros/catalog.json'), 'utf8'))

for (const distro of catalog) {
  if (distro.media?.path && !/^https?:/i.test(distro.media.path)) {
    await verifyMedia(distro)
  }
  if (distro.linux?.descriptorPath) {
    await verifyDirectLinux(distro)
  }
}

async function verifyMedia(distro) {
  const path = join(root, 'public', distro.media.path)
  const info = await stat(path)
  if (!info.isFile() || info.size === 0) throw new Error(`${distro.id}: boot media is empty`)
  if (distro.media.kind === 'cdrom') {
    await verifyIso(path, distro.id, distro.firmware === 'uefi')
  }
  console.log(`verified media ${distro.id} (${info.size} bytes)`)
}

async function verifyIso(path, id, requiresUefi) {
  const handle = await open(path, 'r')
  try {
    let iso9660 = false
    let bootCatalogLba = null
    for (let sector = 16; sector < 32; sector += 1) {
      const descriptor = Buffer.alloc(ISO_SECTOR_SIZE)
      const { bytesRead } = await handle.read(descriptor, 0, descriptor.length, sector * ISO_SECTOR_SIZE)
      if (bytesRead < descriptor.length || descriptor.toString('ascii', 1, 6) !== 'CD001') break
      iso9660 = true
      if (descriptor[0] === 255) break
      const systemId = descriptor.toString('ascii', 7, 39).replace(/[\0 ]+$/g, '')
      if (descriptor[0] === 0 && systemId === 'EL TORITO SPECIFICATION') {
        bootCatalogLba = descriptor.readUInt32LE(71)
      }
    }
    if (!iso9660) throw new Error(`${id}: optical media is not ISO-9660`)
    if (requiresUefi) {
      if (bootCatalogLba === null) throw new Error(`${id}: UEFI ISO has no El Torito catalog`)
      const catalogBytes = Buffer.alloc(16 * ISO_SECTOR_SIZE)
      await handle.read(catalogBytes, 0, catalogBytes.length, bootCatalogLba * ISO_SECTOR_SIZE)
      if (!bootCatalogSupportsUefi(catalogBytes)) {
        throw new Error(`${id}: UEFI ISO has no EFI boot entry`)
      }
    }
  } finally {
    await handle.close()
  }
}
function bootCatalogSupportsUefi(catalogBytes) {
  if (catalogBytes.length < 64) return false
  if (catalogBytes[1] === 0xef && catalogBytes[0x20] === 0x88) return true
  for (let offset = 0x40; offset + 0x20 <= catalogBytes.length; offset += 0x20) {
    const indicator = catalogBytes[offset]
    if ((indicator === 0x90 || indicator === 0x91) && catalogBytes[offset + 1] === 0xef) {
      return true
    }
  }
  return false
}

async function verifyDirectLinux(distro) {
  const descriptorPath = join(root, 'public', distro.linux.descriptorPath)
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
  const base = dirname(descriptorPath)
  await requireNonEmpty(join(base, descriptor.kernel), `${distro.id}: kernel`)
  await requireNonEmpty(join(base, descriptor.initrd), `${distro.id}: initramfs`)
  if (descriptor.rootfsSize % descriptor.fixedChunkSize !== 0) {
    throw new Error(`${distro.id}: rootfs size is not aligned to fixedChunkSize`)
  }

  const rootfs = parse(descriptor.rootfs)
  for (let start = 0; start < descriptor.rootfsSize; start += descriptor.fixedChunkSize) {
    const end = Math.min(start + descriptor.fixedChunkSize, descriptor.rootfsSize)
    const chunk = join(base, `${rootfs.name}-${start}-${end}${rootfs.ext}`)
    const info = await stat(chunk)
    if (!info.isFile() || info.size !== end - start) {
      throw new Error(`${distro.id}: invalid rootfs chunk ${start}-${end}`)
    }
  }
  console.log(`verified direct Linux ${distro.id}`)
}

async function requireNonEmpty(path, label) {
  const info = await stat(path)
  if (!info.isFile() || info.size === 0) throw new Error(`${label} artifact is empty`)
}
