import type { DistroManifest, RuntimeKind } from '../catalog/types'

export type RuntimePhase = 'idle' | 'loading' | 'running' | 'stopped' | 'error'

export interface RuntimeStatus {
  phase: RuntimePhase
  message: string
  progress?: number
  file?: string
  runtime?: Exclude<RuntimeKind, 'auto'>
}

export interface HostFilesystem9P {
  handle9p: (request: Uint8Array, reply: (response: Uint8Array) => void) => void
}

export interface RuntimeOptions {
  screen: HTMLElement
  filesystem?: HostFilesystem9P
  filesystemAccessToken?: () => Promise<string>
  onStatus?: (status: RuntimeStatus) => void
}

export interface VirtualMachineRuntime {
  readonly running: boolean
  readonly active: boolean
  boot(manifest: DistroManifest): Promise<void>
  toggleRun(): Promise<void>
  restart(): Promise<void>
  fullscreen(): void
  sendText(text: string): Promise<void>
  destroy(): Promise<void>
}
