import { createCustomManifest, loadCatalog } from '../catalog/catalog'
import { detectMediaKind, firmwareKindLabel, mediaKindLabel } from '../catalog/mediaProbe'
import type { DistroManifest, FirmwareKind, MediaKind, RuntimeKind } from '../catalog/types'
import { beginOneDriveConnect, disconnectOneDrive, finishOneDriveCallback, getOneDriveSession } from '../onedrive/auth'
import { OneDriveFilesystem } from '../onedrive/graph'
import { OneDrive9PServer } from '../onedrive/p9Server'
import { LinuxRuntime, runtimeForManifest, type RuntimeStatus } from '../runtime/linuxRuntime'

const MOUNT_COMMAND = 'mkdir -p /mnt/onedrive && mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144,access=any host9p /mnt/onedrive'

export class LinuxLabApp {
  private catalog: DistroManifest[] = []
  private selected: DistroManifest | null = null
  private runtime: LinuxRuntime | null = null
  private oneDriveConnected = false
  private readonly root: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
  }

  async start(): Promise<void> {
    this.mountShell()
    try {
      await finishOneDriveCallback()
    } catch (error) {
      this.setNotice(errorMessage(error), 'error')
    }
    this.oneDriveConnected = Boolean(await getOneDriveSession())
    this.configureRuntime()
    this.updateOneDriveUI()
    try {
      const result = await loadCatalog()
      this.catalog = result.distros
      this.selected = this.catalog[0] ?? null
      this.renderCatalog()
      this.renderSelection()
    } catch (error) {
      this.setNotice(errorMessage(error), 'error')
    }
  }

  private mountShell(): void {
    this.root.innerHTML = `
      <div class="lab-shell">
        <header class="topbar">
          <a class="brand" href="${import.meta.env.BASE_URL}" aria-label="Linux Lab home"><span class="brand-mark">&gt;_</span><span>Linux Lab</span></a>
          <div class="topbar-actions">
            <button class="button ghost" type="button" data-onedrive>Connect OneDrive</button>
            <a class="button ghost" href="https://github.com/dbontr/linux-lab" target="_blank" rel="noreferrer">GitHub</a>
          </div>
        </header>
        <div class="lab-grid">
          <aside class="catalog-panel" aria-label="Linux distributions">
            <div class="panel-heading"><div><span class="eyebrow">Catalog</span><h1>Distributions</h1></div><button class="icon-button" type="button" data-custom aria-label="Boot custom image">+</button></div>
            <label class="search"><span class="sr-only">Filter distributions</span><input type="search" placeholder="Filter distros" data-search /></label>
            <div class="distro-list" data-distro-list aria-live="polite"></div>
          </aside>
          <main class="workspace">
            <section class="session-bar" aria-label="Session controls">
              <div class="session-title"><span class="eyebrow" data-session-arch>x86</span><strong data-session-name>Select a distro</strong><span data-session-version></span></div>
              <div class="session-actions">
                <button class="button primary" type="button" data-boot>Boot</button>
                <button class="button" type="button" data-pause disabled>Pause</button>
                <button class="button" type="button" data-restart disabled>Restart</button>
                <button class="button" type="button" data-fullscreen disabled>Fullscreen</button>
              </div>
            </section>
            <section class="vm-frame" aria-label="Virtual machine display">
              <div class="vm-screen" data-screen tabindex="0"></div>
              <div class="vm-placeholder" data-placeholder><span class="prompt-glyph">$</span><p>Choose a distribution, then boot it locally in your browser.</p></div>
              <div class="load-strip" data-progress hidden><div data-progress-fill></div></div>
            </section>
            <output class="status-line" data-status aria-live="polite">No distro is running</output>
          </main>
          <aside class="details-panel" aria-label="Session details">
            <section><span class="eyebrow">Distribution</span><h2 data-detail-name>None selected</h2><p class="muted" data-detail-summary></p><dl class="facts" data-facts></dl></section>
            <section class="storage-section"><span class="eyebrow">Persistent storage</span><div class="storage-status"><span class="status-dot" data-storage-dot></span><strong data-storage-label>OneDrive disconnected</strong></div><p class="muted" data-storage-help>When connected before boot, OneDrive is exposed to compatible guests as the <code>host9p</code> virtio filesystem.</p><div class="mount-tools" data-mount-tools hidden><code>${escapeHtml(MOUNT_COMMAND)}</code><div class="mount-actions"><button class="button" type="button" data-copy-mount>Copy command</button><button class="button" type="button" data-send-mount disabled>Send to VM</button></div></div></section>
            <section><span class="eyebrow">Session model</span><p class="muted">The Linux machine is disposable. Refresh or power it off for a clean start. OneDrive data remains independent of the guest.</p></section>
          </aside>
        </div>
        <div class="notice" data-notice hidden role="status"></div>
      </div>
      <dialog class="custom-dialog" data-custom-dialog>
        <form method="dialog" data-custom-form>
          <div class="dialog-heading"><div><span class="eyebrow">Custom media</span><h2>Boot an ISO or IMG</h2></div><button class="icon-button" value="cancel" formnovalidate aria-label="Close">&times;</button></div>
          <label>Display name<input name="name" placeholder="Use image name" /></label>
          <label class="file-source">Upload ISO or IMG<input name="file" type="file" accept=".iso,.img,.raw,application/x-iso9660-image,application/octet-stream" /></label>
          <div class="source-separator"><span>or use a URL</span></div>
          <label>Remote ISO or IMG URL<input name="url" type="url" placeholder="https://example.org/linux.iso" /></label>
          <div class="form-row"><label>Media<select name="kind"><option value="auto" selected>Auto detect</option><option value="cdrom">ISO / optical disc</option><option value="hda">IMG / hard disk</option></select></label><label>Memory<select name="memory"><option>256</option><option selected>512</option><option>768</option><option>1024</option></select></label></div>
          <div class="form-row"><label>Runtime<select name="runtime"><option value="auto" selected>Auto - 32/64-bit</option><option value="qemu">QEMU - x86-64 compatible</option><option value="v86">v86 - legacy 32-bit</option></select></label><label>Firmware<select name="firmware"><option value="auto" selected>Auto detect</option><option value="uefi">UEFI</option><option value="bios">Legacy BIOS</option></select></label></div>
          <p class="muted">Local uploads stay on this device. Auto selects the browser runtime and detects ISO versus disk media.</p>
          <div class="dialog-actions"><button class="button" value="cancel" formnovalidate>Cancel</button><button class="button primary" value="default" data-custom-submit>Boot image</button></div>
        </form>
      </dialog>`
    this.bindShell()
  }

  private bindShell(): void {
    this.query<HTMLInputElement>('[data-search]').addEventListener('input', () => this.renderCatalog())
    this.query<HTMLButtonElement>('[data-custom]').addEventListener('click', () => this.query<HTMLDialogElement>('[data-custom-dialog]').showModal())
    this.query<HTMLFormElement>('[data-custom-form]').addEventListener('submit', (event) => void this.submitCustom(event))
    this.query<HTMLButtonElement>('[data-boot]').addEventListener('click', () => void this.bootSelected())
    this.query<HTMLButtonElement>('[data-pause]').addEventListener('click', () => void this.togglePause())
    this.query<HTMLButtonElement>('[data-restart]').addEventListener('click', () => this.runtime?.restart())
    this.query<HTMLButtonElement>('[data-fullscreen]').addEventListener('click', () => this.runtime?.fullscreen())
    this.query<HTMLButtonElement>('[data-copy-mount]').addEventListener('click', () => void this.copyMountCommand())
    this.query<HTMLButtonElement>('[data-send-mount]').addEventListener('click', () => this.sendMountCommand())
    this.query<HTMLButtonElement>('[data-onedrive]').addEventListener('click', () => void this.toggleOneDrive())
  }

  private configureRuntime(): void {
    const screen = this.query<HTMLElement>('[data-screen]')
    const filesystem = this.oneDriveConnected
      ? { handle9p: new OneDrive9PServer(new OneDriveFilesystem()).handle9p }
      : undefined
    this.runtime = new LinuxRuntime({
      screen,
      filesystem,
      onStatus: (status) => this.updateRuntimeStatus(status),
    })
  }

  private renderCatalog(): void {
    const list = this.query<HTMLElement>('[data-distro-list]')
    const filter = this.query<HTMLInputElement>('[data-search]').value.trim().toLocaleLowerCase()
    const visible = this.catalog.filter((distro) => `${distro.name} ${distro.version}`.toLocaleLowerCase().includes(filter))
    list.replaceChildren()
    for (const distro of visible) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `distro-card${distro.id === this.selected?.id ? ' selected' : ''}`
      button.setAttribute('aria-pressed', String(distro.id === this.selected?.id))
      const identity = document.createElement('span')
      identity.className = 'distro-identity'
      const name = document.createElement('strong')
      name.textContent = distro.name
      const version = document.createElement('span')
      version.textContent = distro.version
      identity.append(name, version)
      const arch = document.createElement('span')
      arch.className = 'arch-pill'
      arch.textContent = architectureLabel(distro)
      button.append(identity, arch)
      button.addEventListener('click', () => this.selectDistro(distro))
      list.append(button)
    }
    if (visible.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty-state'
      empty.textContent = 'No matching distributions.'
      list.append(empty)
    }
  }

  private selectDistro(distro: DistroManifest): void {
    this.selected = distro
    this.renderCatalog()
    this.renderSelection()
  }

  private renderSelection(): void {
    const distro = this.selected
    this.query<HTMLElement>('[data-session-name]').textContent = distro?.name ?? 'Select a distro'
    this.query<HTMLElement>('[data-session-version]').textContent = distro ? distro.version : ''
    this.query<HTMLElement>('[data-session-arch]').textContent = distro ? architectureLabel(distro) : 'PC'
    this.query<HTMLElement>('[data-detail-name]').textContent = distro?.name ?? 'None selected'
    this.query<HTMLElement>('[data-detail-summary]').textContent = distro?.summary ?? ''
    const facts = this.query<HTMLElement>('[data-facts]')
    facts.replaceChildren()
    if (distro) {
      this.addFact(facts, 'Architecture', architectureLabel(distro))
      this.addFact(facts, 'Memory', `${distro.memoryMiB} MiB`)
      this.addFact(facts, 'Boot source', distro.linux ? 'Prepared Linux image' : distro.media ? mediaKindLabel(distro.media.kind) : 'Unknown')
      this.addFact(facts, 'Runtime', runtimeLabel(distro))
      if (runtimeForManifest(distro) === 'qemu') this.addFact(facts, 'Firmware', firmwareKindLabel(distro.firmware ?? 'auto'))
      this.addFact(facts, 'Network', runtimeForManifest(distro) === 'qemu' ? 'Offline' : (distro.networkDevice ?? 'ne2k') + ' / browser fetch')
    }
    const qemuSelected = distro ? runtimeForManifest(distro) === 'qemu' : false
    this.query<HTMLElement>('[data-storage-help]').textContent = qemuSelected
      ? 'OneDrive host mounting is available in v86 guests. The QEMU filesystem bridge is not active yet.'
      : 'When connected before boot, OneDrive is exposed to Linux as the host9p virtio filesystem.'
    this.updateOneDriveUI()
    this.query<HTMLButtonElement>('[data-boot]').disabled = !distro
  }

  private async bootSelected(): Promise<void> {
    if (!this.selected || !this.runtime) return
    this.query<HTMLElement>('[data-placeholder]').hidden = true
    this.query<HTMLButtonElement>('[data-boot]').disabled = true
    try {
      await this.runtime.boot(this.selected)
    } catch (error) {
      this.updateRuntimeStatus({ phase: 'error', message: errorMessage(error) })
    } finally {
      this.query<HTMLButtonElement>('[data-boot]').disabled = false
    }
  }

  private async togglePause(): Promise<void> {
    if (!this.runtime?.active) return
    await this.runtime.toggleRun()
    this.query<HTMLButtonElement>('[data-pause]').textContent = this.runtime.running ? 'Pause' : 'Resume'
  }

  private updateRuntimeStatus(status: RuntimeStatus): void {
    const output = this.query<HTMLOutputElement>('[data-status]')
    output.textContent = status.message
    output.dataset.phase = status.phase
    const progress = this.query<HTMLElement>('[data-progress]')
    const fill = this.query<HTMLElement>('[data-progress-fill]')
    const loading = status.phase === 'loading'
    progress.hidden = !loading
    fill.style.width = status.progress === undefined ? '18%' : `${Math.max(0, Math.min(1, status.progress)) * 100}%`
    fill.classList.toggle('indeterminate', loading && status.progress === undefined)
    const active = status.phase === 'running' || status.phase === 'stopped'
    const qemu = status.runtime === 'qemu'
    this.query<HTMLButtonElement>('[data-pause]').disabled = !active || qemu
    this.query<HTMLButtonElement>('[data-restart]').disabled = !active
    this.query<HTMLButtonElement>('[data-fullscreen]').disabled = !active
    this.query<HTMLButtonElement>('[data-send-mount]').disabled = !this.oneDriveConnected || !active || qemu
    this.query<HTMLButtonElement>('[data-pause]').textContent = status.phase === 'stopped' ? 'Resume' : 'Pause'
    if (status.phase === 'error') this.setNotice(status.message, 'error')
  }
  private async toggleOneDrive(): Promise<void> {
    try {
      if (this.oneDriveConnected) {
        if (this.runtime?.active) await this.runtime.destroy()
        await disconnectOneDrive()
        this.oneDriveConnected = false
        this.configureRuntime()
        this.updateOneDriveUI()
        this.setNotice('OneDrive disconnected.', 'info')
        return
      }
      await beginOneDriveConnect()
    } catch (error) {
      this.setNotice(errorMessage(error), 'error')
    }
  }

  private updateOneDriveUI(): void {
    const button = this.query<HTMLButtonElement>('[data-onedrive]')
    const label = this.query<HTMLElement>('[data-storage-label]')
    const dot = this.query<HTMLElement>('[data-storage-dot]')
    const tools = this.query<HTMLElement>('[data-mount-tools]')
    const qemu = this.selected ? runtimeForManifest(this.selected) === 'qemu' : false
    button.textContent = this.oneDriveConnected ? 'Disconnect OneDrive' : 'Connect OneDrive'
    label.textContent = this.oneDriveConnected ? 'OneDrive connected' : 'OneDrive disconnected'
    dot.classList.toggle('connected', this.oneDriveConnected)
    tools.hidden = !this.oneDriveConnected || qemu
    this.query<HTMLButtonElement>('[data-send-mount]').disabled = !this.oneDriveConnected || !this.runtime?.active || qemu
  }
  private async copyMountCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(MOUNT_COMMAND)
      this.setNotice('Mount command copied.', 'info')
    } catch {
      this.setNotice('Clipboard access is unavailable. Select the command and copy it manually.', 'error')
    }
  }

  private sendMountCommand(): void {
    try {
      this.runtime?.sendText(`${MOUNT_COMMAND}\n`)
      this.setNotice('Mount command sent to the virtual keyboard.', 'info')
    } catch (error) {
      this.setNotice(errorMessage(error), 'error')
    }
  }

  private async submitCustom(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    if (!form.reportValidity()) return
    const data = new FormData(form)
    const fileInput = form.elements.namedItem('file') as HTMLInputElement
    const urlInput = form.elements.namedItem('url') as HTMLInputElement
    const file = fileInput.files?.[0] ?? null
    const url = urlInput.value.trim()
    if (!file && !url) {
      urlInput.setCustomValidity('Choose an ISO or IMG file, or enter a URL.')
      urlInput.reportValidity()
      urlInput.setCustomValidity('')
      return
    }

    try {
      const requestedKind = String(data.get('kind') ?? 'auto')
      const kind = requestedKind === 'cdrom' || requestedKind === 'hda'
        ? requestedKind
        : file
          ? await detectMediaKind(file)
          : remoteMediaKind(url)
      const source = file ?? url
      const distro = createCustomManifest({
        name: String(data.get('name') ?? ''),
        source,
        kind,
        memoryMiB: Number(data.get('memory') ?? 512),
        runtime: customRuntime(String(data.get('runtime') ?? 'auto')),
        firmware: customFirmware(String(data.get('firmware') ?? 'auto')),
      })
      this.catalog = [distro, ...this.catalog.filter((item) => item.id !== distro.id)]
      this.selected = distro
      this.query<HTMLDialogElement>('[data-custom-dialog]').close()
      form.reset()
      this.renderCatalog()
      this.renderSelection()
    } catch (error) {
      this.setNotice(errorMessage(error), 'error')
    }
  }
  private addFact(list: HTMLElement, label: string, value: string): void {
    const term = document.createElement('dt')
    const detail = document.createElement('dd')
    term.textContent = label
    detail.textContent = value
    list.append(term, detail)
  }

  private setNotice(message: string, kind: 'info' | 'error'): void {
    const notice = this.query<HTMLElement>('[data-notice]')
    notice.textContent = message
    notice.dataset.kind = kind
    notice.hidden = false
    window.setTimeout(() => { if (notice.textContent === message) notice.hidden = true }, 6_000)
  }

  private query<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing UI element: ${selector}`)
    return element
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}

function architectureLabel(distro: DistroManifest): string {
  if (distro.architecture === 'x86_64') return 'x86-64'
  if (distro.architecture === 'auto') return 'x86 / x86-64'
  return 'x86'
}

function runtimeLabel(distro: DistroManifest): string {
  return runtimeForManifest(distro) === 'qemu' ? 'QEMU-Wasm' : 'v86'
}

function remoteMediaKind(url: string): MediaKind {
  try {
    return new URL(url).pathname.toLocaleLowerCase().endsWith('.iso') ? 'cdrom' : 'hda'
  } catch {
    return 'hda'
  }
}

function customFirmware(value: string): FirmwareKind {
  if (value === 'bios' || value === 'uefi' || value === 'auto') return value
  return 'auto'
}

function customRuntime(value: string): RuntimeKind {
  if (value === 'qemu' || value === 'v86' || value === 'auto') return value
  return 'auto'
}
