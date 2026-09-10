import { V86, type V86Options } from 'v86'
import wasmUrl from 'v86/build/v86.wasm?url'
import { assetUrl, loadDirectLinuxBoot, localMediaFile, mediaUrl } from '../catalog/catalog'
import type { DistroManifest } from '../catalog/types'
import type {
  RuntimeOptions,
  RuntimeStatus,
  VirtualMachineRuntime,
} from './runtimeTypes'

const MIB = 1024 * 1024
const ASYNC_FILE_THRESHOLD = 256 * MIB

type BrowserFileImage = { buffer: File; async: boolean }

export class V86Runtime implements VirtualMachineRuntime {
  private emulator: V86 | null = null
  private readonly options: RuntimeOptions
  private readonly status: (status: RuntimeStatus) => void

  constructor(options: RuntimeOptions) {
    this.options = options
    this.status = options.onStatus ?? (() => undefined)
  }

  get running(): boolean { return this.emulator?.is_running() ?? false }
  get active(): boolean { return this.emulator !== null }

  async boot(manifest: DistroManifest): Promise<void> {
    await this.destroy()
    this.prepareScreen()
    this.status({ phase: 'loading', message: `Loading ${manifest.name}...`, progress: 0, runtime: 'v86' })
    const boot = await resolveBoot(manifest)
    const emulator = new V86({
      wasm_path: wasmUrl,
      memory_size: manifest.memoryMiB * MIB,
      vga_memory_size: manifest.vgaMemoryMiB * MIB,
      screen: { container: this.options.screen, use_graphical_text: false },
      bios: { url: assetUrl('v86/seabios.bin') },
      vga_bios: { url: assetUrl('v86/vgabios.bin') },
      ...boot,
      filesystem: this.options.filesystem,
      net_device: {
        type: manifest.networkDevice ?? 'ne2k',
        relay_url: 'fetch',
        dns_method: 'doh',
      },
      autostart: true,
      disable_speaker: false,
      fastboot: true,
    })
    this.emulator = emulator
    emulator.add_listener('download-progress', (event) => {
      const progress = event.lengthComputable && event.total > 0 ? event.loaded / event.total : undefined
      this.status({
        phase: 'loading',
        message: `Loading ${manifest.name}...`,
        progress,
        file: event.file_name,
        runtime: 'v86',
      })
    })
    emulator.add_listener('download-error', (event) => {
      this.status({
        phase: 'error',
        message: `Could not load ${event.file_name}`,
        runtime: 'v86',
      })
    })
    emulator.add_listener('emulator-started', () => {
      this.status({ phase: 'running', message: `${manifest.name} is running`, runtime: 'v86' })
    })
    emulator.add_listener('emulator-stopped', () => {
      this.status({ phase: 'stopped', message: `${manifest.name} is stopped`, runtime: 'v86' })
    })
  }

  async toggleRun(): Promise<void> {
    if (!this.emulator) return
    if (this.emulator.is_running()) await this.emulator.stop()
    else await this.emulator.run()
  }

  async restart(): Promise<void> { this.emulator?.restart() }
  fullscreen(): void { this.emulator?.screen_go_fullscreen() }
  lockMouse(): void { this.emulator?.lock_mouse() }

  async sendText(text: string): Promise<void> {
    if (!this.emulator) throw new Error('No Linux session is running')
    this.emulator.keyboard_send_text(text)
  }

  async saveState(): Promise<ArrayBuffer> {
    if (!this.emulator) throw new Error('No Linux session is running')
    return this.emulator.save_state()
  }

  async restoreState(state: ArrayBuffer): Promise<void> {
    if (!this.emulator) throw new Error('Start the matching distro before restoring its state')
    await this.emulator.restore_state(state)
  }

  async destroy(): Promise<void> {
    if (!this.emulator) return
    const current = this.emulator
    this.emulator = null
    try { await current.stop() } catch { /* already stopped */ }
    await current.destroy()
    this.options.screen.replaceChildren()
    this.status({ phase: 'idle', message: 'No distro is running', runtime: 'v86' })
  }

  private prepareScreen(): void {
    const text = document.createElement('div')
    const canvas = document.createElement('canvas')
    canvas.hidden = true
    this.options.screen.replaceChildren(text, canvas)
  }
}

async function resolveBoot(
  manifest: DistroManifest,
): Promise<Pick<V86Options, 'cdrom' | 'hda' | 'bzimage' | 'initrd' | 'cmdline'>> {
  if (manifest.linux) {
    const { descriptor, baseUrl } = await loadDirectLinuxBoot(manifest)
    return {
      bzimage: { url: new URL(descriptor.kernel, baseUrl).href },
      initrd: { url: new URL(descriptor.initrd, baseUrl).href },
      cmdline: descriptor.cmdline,
      hda: {
        url: new URL(descriptor.rootfs, baseUrl).href,
        async: true,
        size: descriptor.rootfsSize,
        use_parts: true,
        fixed_chunk_size: descriptor.fixedChunkSize,
      },
    }
  }

  if (!manifest.media) throw new Error(`${manifest.name} has no boot source`)
  const file = localMediaFile(manifest)
  const image = file
    ? ({ buffer: file, async: file.size >= ASYNC_FILE_THRESHOLD } as BrowserFileImage)
    : { url: mediaUrl(manifest) }
  return manifest.media.kind === 'cdrom'
    ? { cdrom: image as V86Options['cdrom'] }
    : { hda: image as V86Options['hda'] }
}
