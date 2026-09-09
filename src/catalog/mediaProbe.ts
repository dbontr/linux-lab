import type { MediaKind } from './types'

const ISO_PVD_SIGNATURE_OFFSET = 0x8001
const ISO_PVD_SIGNATURE = 'CD001'

export async function detectMediaKind(file: File): Promise<MediaKind> {
  if (file.size >= ISO_PVD_SIGNATURE_OFFSET + ISO_PVD_SIGNATURE.length) {
    const bytes = new Uint8Array(
      await file.slice(
        ISO_PVD_SIGNATURE_OFFSET,
        ISO_PVD_SIGNATURE_OFFSET + ISO_PVD_SIGNATURE.length,
      ).arrayBuffer(),
    )
    if (new TextDecoder('ascii').decode(bytes) === ISO_PVD_SIGNATURE) return 'cdrom'
  }

  return file.name.toLocaleLowerCase().endsWith('.iso') ? 'cdrom' : 'hda'
}

export function mediaKindLabel(kind: MediaKind): string {
  return kind === 'cdrom' ? 'ISO / optical disc' : 'IMG / hard disk'
}
