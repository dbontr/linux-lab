import { createCustomManifest, loadCatalog } from '../catalog/catalog'
import type { DistroManifest, MediaKind } from '../catalog/types'
import { beginOneDriveConnect, disconnectOneDrive, finishOneDriveCallback, getOneDriveSession } from '../onedrive/auth'
import { OneDriveFilesystem } from '../onedrive/graph'
import { OneDrive9PServer } from '../onedrive/p9Server'
import { LinuxRuntime, type RuntimeStatus } from '../runtime/v86Runtime'

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
            <section class="storage-section"><span class="eyebrow">Persistent storage</span><div class="storage-status"><span class="status-dot" data-storage-dot></span><strong data-storage-label>OneDrive disconnected</strong></div><p class="muted">When connected before boot, OneDrive is exposed to Linux as the <code>host9p</code> virtio filesystem.</p><div class="mount-tools" data-mount-tools hidden><code>${escapeHtml(MOUNT_COMMAND)}</code><div class="mount-actions"><button class="button" type="button" data-copy-mount>Copy command</button><button class="button" type="button" data-send-mount disabled>Send to VM</button></div></div></section>
            <section><span class="eyebrow">Session model</span><p class="muted">The Linux machine is disposable. Refresh or power it off for a clean start. OneDrive data remains independent of the guest.</p></section>
          </aside>
        </div>
        <div class="notice" data-notice hidden role="status"></div>
      </div>
      <dialog class="custom-dialog" data-custom-dialog>
        <form method="dialog" data-custom-form>
          <div class="dialog-heading"><div><span class="eyebrow">Custom media</span><h2>Boot an x86 image</h2></div><button class="icon-button" value="cancel" formnovalidate aria-label="Close">×</button></div>
          <label>Display name<input name="name" value="Custom Linux" required /></label>
          <label>ISO or IMG URL<input name="url" type="url" placeholder="https://example.org/linux.iso" required /></label>
          <div class="form-row"><label>Media<select name="kind"><option value="cdrom">CD / ISO</option><option value="hda">Hard disk / IMG</option></select></label><label>Memory<select name="memory"><option>128</option><option>256</option><option selected>512</option><option>1024</option><option>2048</option></select></label></div>
          <p class="muted">The image must support 32-bit x86 and allow cross-origin browser downloads.</p>
          <div class="dialog-actions"><button class="button" value="cancel" formnovalidate>Cancel</button><button class="button primary" value="default" data-custom-submit>Use image</button></div>
        </form>
      </dialog>`
    this.bindShell()
  }

  private bindShell(): void {
    this.query<HTMLInputElement>('[data-search]').addEventListener('input', () => this.renderCatalog())
    this.query<HTMLButtonElement>('[data-custom]').addEventListener('click', () => this.query<HTMLDialogElement>('[data-custom-dialog]').showModal())
    this.query<HTMLFormElement>('[data-custom-form]').addEventListener('submit', (event) => this.submitCustom(event))
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
      arch.textContent = distro.architecture
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
    this.query<HTMLElement>('[data-session-arch]').textContent = distro?.architecture ?? 'x86'
    this.query<HTMLElement>('[data-detail-name]').textContent = distro?.name ?? 'None selected'
    this.query<HTMLElement>('[data-detail-summary]').textContent = distro?.summary ?? ''
    const facts = this.query<HTMLElement>('[data-facts]')
    facts.replaceChildren()
    if (distro) {
      this.addFact(facts, 'Architecture', distro.architecture)
      this.addFact(facts, 'Memory', `${distro.memoryMiB} MiB`)
      this.addFact(facts, 'Boot source', distro.linux ? 'Fast direct Linux image' : distro.media?.kind === 'cdrom' ? 'CD / ISO' : 'Hard disk image')
      this.addFact(facts, 'Network', `${distro.networkDevice ?? 'ne2k'} · browser fetch`)
    }
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
    this.query<HTMLButtonElement>('[data-pause]').disabled = !active
    this.query<HTMLButtonElement>('[data-restart]').disabled = !active
    this.query<HTMLButtonElement>('[data-fullscreen]').disabled = !active
    this.query<HTMLButtonElement>('[data-send-mount]').disabled = !this.oneDriveConnected || !active
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
    button.textContent = this.oneDriveConnected ? 'Disconnect OneDrive' : 'Connect OneDrive'
    label.textContent = this.oneDriveConnected ? 'OneDrive connected' : 'OneDrive disconnected'
    dot.classList.toggle('connected', this.oneDriveConnected)
    tools.hidden = !this.oneDriveConnected
    this.query<HTMLButtonElement>('[data-send-mount]').disabled = !this.oneDriveConnected || !this.runtime?.active
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

  private submitCustom(event: SubmitEvent): void {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    if (!form.reportValidity()) return
    const data = new FormData(form)
    try {
      const distro = createCustomManifest({
        name: String(data.get('name') ?? ''),
        url: String(data.get('url') ?? ''),
        kind: String(data.get('kind') ?? 'cdrom') as MediaKind,
        memoryMiB: Number(data.get('memory') ?? 512),
      })
      this.catalog = [distro, ...this.catalog.filter((item) => item.id !== distro.id)]
      this.selected = distro
      this.query<HTMLDialogElement>('[data-custom-dialog]').close()
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
