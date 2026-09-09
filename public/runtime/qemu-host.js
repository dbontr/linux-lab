const SOURCE = 'linux-lab-qemu'
const screen = document.getElementById('screen')
const log = document.getElementById('log')
const qemuBase = new URL('../qemu/', location.href)
let bootStarted = false

function post(type, detail = {}) {
  parent.postMessage({ source: SOURCE, type, ...detail }, location.origin)
}

function appendLog(value) {
  const text = String(value ?? '')
  log.textContent = `${log.textContent}\n${text}`.slice(-20000)
  log.scrollTop = log.scrollHeight
}

function asset(name) {
  return new URL(name, qemuBase).href
}

function loadClassicScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Could not load ${url}`))
    document.head.append(script)
  })
}

function safeMediaFile(file, kind) {
  const name = kind === 'cdrom' ? 'boot.iso' : 'boot.img'
  return new File([file], name, { type: file.type, lastModified: file.lastModified })
}

function bootArguments(file, kind, requestedMemory, firmware) {
  const memory = Math.max(256, Math.min(1024, Number(requestedMemory) || 512))
  const args = [
    '-m', `${memory}M`,
    '-accel', 'tcg,tb-size=500',
    '-cpu', 'max',
    '-machine', 'pc',
    '-L', '/pack',
    '-display', 'sdl,gl=off',
    '-vga', 'std',
    '-serial', 'stdio',
    '-monitor', 'none',
    '-nic', 'none',
  ]

  if (firmware === 'uefi') {
    args.push(
      '-drive', 'if=pflash,format=raw,unit=0,readonly=on,file=/pack/edk2-x86_64-code.fd',
      '-drive', 'if=pflash,format=raw,unit=1,file=/pack/edk2-i386-vars.fd',
    )
  }

  if (kind === 'cdrom') {
    args.push(
      '-drive', `file=/media/${file.name},media=cdrom,readonly=on,if=ide`,
      '-boot', 'order=d',
    )
  } else {
    args.push(
      '-drive', `file=/media/${file.name},format=raw,if=ide,snapshot=on`,
      '-boot', 'order=c',
    )
  }
  return args
}

async function boot(request) {
  if (bootStarted) throw new Error('The VM has already started')
  bootStarted = true
  if (!crossOriginIsolated) {
    throw new Error('x86-64 runtime requires cross-origin isolation. Reload the page once and try again.')
  }
  if (!(request.file instanceof File)) throw new Error('Uploaded boot media is missing')
  const media = safeMediaFile(request.file, request.kind)
  const moduleConfig = {
    arguments: bootArguments(media, request.kind, request.memoryMiB, request.firmware),
    canvas: screen,
    linuxLabMedia: media,
    mainScriptUrlOrBlob: asset('out.js'),
    locateFile: (name) => asset(name),
    print: appendLog,
    printErr: appendLog,
    onRuntimeInitialized: () => {
      log.hidden = true
      screen.focus()
      post('running')
    },
    onAbort: (reason) => {
      post('error', { message: `QEMU aborted: ${String(reason)}` })
    },
  }

  window.Module = moduleConfig
  await loadClassicScript(asset('load.js'))
  const factoryModule = await import(asset('out.js'))
  const createQemu = factoryModule.default
  if (typeof createQemu !== 'function') throw new Error('QEMU runtime module is invalid')
  await createQemu(window.Module)
}

addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== parent) return
  if (event.data?.type !== 'boot') return
  void boot(event.data).catch((error) => {
    appendLog(error instanceof Error ? error.stack ?? error.message : String(error))
    post('error', { message: error instanceof Error ? error.message : String(error) })
  })
})

post('ready', { isolated: crossOriginIsolated })
