import { localMediaFile, mediaUrl } from '../catalog/catalog'
import { detectFirmwareKind } from '../catalog/mediaProbe'
import type { DistroManifest, MediaKind } from '../catalog/types'
import type {
  RuntimeOptions,
  RuntimeStatus,
  VirtualMachineRuntime,
} from './runtimeTypes'

const MESSAGE_SOURCE = 'linux-lab-qemu'
const HOST_PATH = 'runtime/qemu-host.html'
const READY_TIMEOUT_MS = 20_000
const CONTROL_TIMEOUT_MS = 5_000
const TOKEN_REFRESH_MS = 5 * 60_000

interface QemuMessage {
  source?: string
  type?: string
  isolated?: boolean
  message?: string
  network?: boolean
  storage?: boolean
  id?: number
  ok?: boolean
  action?: string
}

export class QemuRuntime implements VirtualMachineRuntime {
  private iframe: HTMLIFrameElement | null = null
  private lastManifest: DistroManifest | null = null
  private isRunning = false
  private nextControlId = 1
  private tokenTimer: number | null = null
  private readonly pendingControls = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  private readonly options: RuntimeOptions
  private readonly status: (status: RuntimeStatus) => void

  constructor(options: RuntimeOptions) {
    this.options = options
    this.status = options.onStatus ?? (() => undefined)
  }

  get running(): boolean { return this.isRunning }
  get active(): boolean { return this.iframe !== null }

  async boot(manifest: DistroManifest): Promise<void> {
    await this.destroy()
    if (!manifest.media) throw new Error(`${manifest.name} does not provide ISO or disk media`)
    this.lastManifest = manifest
    this.status({ phase: 'loading', message: `Preparing ${manifest.name} for x86-64 QEMU...`, runtime: 'qemu' })

    const file = await resolveMediaFile(manifest, (progress) => {
      this.status({
        phase: 'loading',
        message: `Downloading ${manifest.name}...`,
        progress,
        runtime: 'qemu',
      })
    })
    const iframe = document.createElement('iframe')
    iframe.className = 'qemu-frame'
    iframe.title = `${manifest.name} virtual machine`
    iframe.allow = 'fullscreen'
    iframe.src = assetUrl(HOST_PATH)
    this.options.screen.replaceChildren(iframe)
    this.iframe = iframe

    const ready = await this.waitForReady(iframe)
    if (!ready.isolated) {
      await this.destroy()
      throw new Error('The x86-64 runtime requires cross-origin isolation. Reload Linux Lab and try again.')
    }
    const firmware = manifest.firmware && manifest.firmware !== 'auto'
      ? manifest.firmware
      : await detectFirmwareKind(file, manifest.media.kind)
    let oneDriveToken: string | undefined
    if (this.options.filesystemAccessToken) {
      try {
        oneDriveToken = await this.options.filesystemAccessToken()
      } catch {
        oneDriveToken = undefined
      }
    }
    iframe.contentWindow?.postMessage({
      type: 'boot',
      file,
      kind: manifest.media.kind,
      firmware,
      memoryMiB: manifest.memoryMiB,
      oneDriveToken,
    }, location.origin)
    this.startTokenRefresh()
  }

  async toggleRun(): Promise<void> {
    if (!this.iframe) throw new Error('No Linux session is running')
    const nextRunning = !this.isRunning
    await this.sendControl(nextRunning ? 'resume' : 'pause')
    this.isRunning = nextRunning
    this.status({
      phase: nextRunning ? 'running' : 'stopped',
      message: `${this.lastManifest?.name ?? 'Linux'} is ${nextRunning ? 'running' : 'stopped'}`,
      runtime: 'qemu',
    })
  }

  async restart(): Promise<void> {
    if (!this.lastManifest) throw new Error('No Linux session is running')
    await this.boot(this.lastManifest)
  }

  fullscreen(): void {
    if (!this.iframe) return
    void this.iframe.requestFullscreen()
  }

  async sendText(text: string): Promise<void> {
    if (!this.iframe) throw new Error('No Linux session is running')
    await this.sendControl('send-text', text)
  }

  async destroy(): Promise<void> {
    window.removeEventListener('message', this.onRuntimeMessage)
    if (this.tokenTimer !== null) {
      window.clearInterval(this.tokenTimer)
      this.tokenTimer = null
    }
    for (const pending of this.pendingControls.values()) pending.reject(new Error('QEMU session ended'))
    this.pendingControls.clear()
    if (!this.iframe) return
    this.iframe.remove()
    this.iframe = null
    this.isRunning = false
    this.options.screen.replaceChildren()
    this.status({ phase: 'idle', message: 'No distro is running', runtime: 'qemu' })
  }

  private sendControl(action: 'pause' | 'resume' | 'send-text', text?: string): Promise<void> {
    const iframe = this.iframe
    if (!iframe) return Promise.reject(new Error('No Linux session is running'))
    const id = this.nextControlId++
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingControls.delete(id)
        reject(new Error(`QEMU ${action} command timed out`))
      }, CONTROL_TIMEOUT_MS)
      this.pendingControls.set(id, {
        resolve: () => { window.clearTimeout(timeout); resolve() },
        reject: (error) => { window.clearTimeout(timeout); reject(error) },
      })
      iframe.contentWindow?.postMessage({ type: 'control', id, action, text }, location.origin)
    })
  }

  private startTokenRefresh(): void {
    if (!this.options.filesystemAccessToken || this.tokenTimer !== null) return
    this.tokenTimer = window.setInterval(() => void this.refreshToken(), TOKEN_REFRESH_MS)
  }

  private async refreshToken(): Promise<void> {
    if (!this.options.filesystemAccessToken || !this.iframe) return
    try {
      const token = await this.options.filesystemAccessToken()
      this.iframe.contentWindow?.postMessage({ type: 'onedrive-token', token }, location.origin)
    } catch {
      // The active token may still be valid. Actual storage errors surface from QEMU.
    }
  }
  private waitForReady(iframe: HTMLIFrameElement): Promise<{ isolated: boolean }> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup()
        reject(new Error('The x86-64 runtime did not initialize'))
      }, READY_TIMEOUT_MS)
      const onMessage = (event: MessageEvent<QemuMessage>) => {
        if (event.origin !== location.origin || event.source !== iframe.contentWindow) return
        if (event.data?.source !== MESSAGE_SOURCE) return
        if (event.data.type === 'ready') {
          cleanup()
          window.addEventListener('message', this.onRuntimeMessage)
          resolve({ isolated: Boolean(event.data.isolated) })
        }
      }
      const cleanup = () => {
        window.clearTimeout(timeout)
        window.removeEventListener('message', onMessage)
      }
      window.addEventListener('message', onMessage)
    })
  }

  private readonly onRuntimeMessage = (event: MessageEvent<QemuMessage>): void => {
    if (event.origin !== location.origin || event.source !== this.iframe?.contentWindow) return
    if (event.data?.source !== MESSAGE_SOURCE) return
    if (event.data.type === 'running') {
      this.isRunning = true
      this.status({
        phase: 'running',
        message: `${this.lastManifest?.name ?? 'Linux'} is running${event.data.network ? '; browser network bridge ready' : '; offline'}${event.data.storage ? '; OneDrive bridge attached' : this.options.filesystemAccessToken ? '; OneDrive unavailable' : ''}`,
        runtime: 'qemu',
      })
    } else if (event.data.type === 'control-result' && typeof event.data.id === 'number') {
      const pending = this.pendingControls.get(event.data.id)
      if (!pending) return
      this.pendingControls.delete(event.data.id)
      if (event.data.ok) pending.resolve()
      else pending.reject(new Error(event.data.message ?? `QEMU ${event.data.action ?? 'control'} failed`))
    } else if (event.data.type === 'error') {
      this.isRunning = false
      this.status({
        phase: 'error',
        message: event.data.message ?? 'The x86-64 runtime failed',
        runtime: 'qemu',
      })
    }
  }
}

async function resolveMediaFile(
  manifest: DistroManifest,
  onProgress: (progress: number | undefined) => void,
): Promise<File> {
  const local = localMediaFile(manifest)
  if (local) return local
  const response = await fetch(mediaUrl(manifest))
  if (!response.ok) throw new Error(`Boot media request failed with HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  if (!response.body) {
    const blob = await response.blob()
    return fileFromBlob(blob, manifest.media?.kind ?? 'hda')
  }

  const reader = response.body.getReader()
  const chunks: BlobPart[] = []
  let loaded = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    chunks.push(copy.buffer)
    loaded += value.byteLength
    onProgress(total > 0 ? loaded / total : undefined)
  }
  return fileFromBlob(new Blob(chunks), manifest.media?.kind ?? 'hda')
}

function fileFromBlob(blob: Blob, kind: MediaKind): File {
  return new File([blob], kind === 'cdrom' ? 'boot.iso' : 'boot.img')
}

function assetUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`, location.origin).href
}

