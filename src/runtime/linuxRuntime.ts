import type { DistroManifest, RuntimeKind } from '../catalog/types'
import { QemuRuntime } from './qemuRuntime'
import type {
  RuntimeOptions,
  VirtualMachineRuntime,
} from './runtimeTypes'
import { V86Runtime } from './v86Runtime'

export type { RuntimeStatus } from './runtimeTypes'

export class LinuxRuntime implements VirtualMachineRuntime {
  private current: VirtualMachineRuntime | null = null
  private currentKind: Exclude<RuntimeKind, 'auto'> | null = null
  private readonly options: RuntimeOptions

  constructor(options: RuntimeOptions) {
    this.options = options
  }

  get running(): boolean { return this.current?.running ?? false }
  get active(): boolean { return this.current?.active ?? false }
  get runtime(): Exclude<RuntimeKind, 'auto'> | null { return this.currentKind }

  async boot(manifest: DistroManifest): Promise<void> {
    await this.destroy()
    const kind = runtimeForManifest(manifest)
    this.currentKind = kind
    this.current = kind === 'qemu'
      ? new QemuRuntime(this.options)
      : new V86Runtime(this.options)
    await this.current.boot(manifest)
  }

  async toggleRun(): Promise<void> {
    await this.requireCurrent().toggleRun()
  }

  async restart(): Promise<void> {
    await this.requireCurrent().restart()
  }

  fullscreen(): void {
    this.requireCurrent().fullscreen()
  }

  async sendText(text: string): Promise<void> {
    await this.requireCurrent().sendText(text)
  }

  async destroy(): Promise<void> {
    const current = this.current
    this.current = null
    this.currentKind = null
    if (current) await current.destroy()
  }

  private requireCurrent(): VirtualMachineRuntime {
    if (!this.current) throw new Error('No Linux session is running')
    return this.current
  }
}

export function runtimeForManifest(manifest: DistroManifest): Exclude<RuntimeKind, 'auto'> {
  if (manifest.runtime === 'v86' || manifest.runtime === 'qemu') return manifest.runtime
  if (manifest.linux) return 'v86'
  if (manifest.architecture === 'x86') return 'v86'
  return 'qemu'
}
