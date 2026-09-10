const SOURCE = 'linux-lab-qemu'
const NETWORK_ADDRESS = 'http://localhost:9999/'
const NETWORK_READY_TIMEOUT_MS = 20_000
const QEMU_READY_TIMEOUT_MS = 30_000
const screen = document.getElementById('screen')
const log = document.getElementById('log')
const qemuBase = new URL('../qemu/', location.href)
const networkBase = new URL('network/', qemuBase)
let bootStarted = false
let mediaObjectUrl = null
let qemuModule = null

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

function networkAsset(name) {
  return new URL(name, networkBase).href
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

function browserMediaSource(file) {
  releaseMediaUrl()
  mediaObjectUrl = URL.createObjectURL(file)
  return `linuxlab:${file.size}:${mediaObjectUrl}`
}

function releaseMediaUrl() {
  if (!mediaObjectUrl) return
  URL.revokeObjectURL(mediaObjectUrl)
  mediaObjectUrl = null
}

function bootArguments(mediaSource, kind, requestedMemory, firmware, networkEnabled, storageEnabled) {
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
  ]

  if (networkEnabled) {
    args.push(
      '-virtfs', 'local,path=/.wasmenv,mount_tag=wasm0,security_model=passthrough,id=wasm0',
      '-netdev', 'socket,id=vmnic,connect=localhost:8888',
      '-device', 'virtio-net-pci,netdev=vmnic',
    )
  } else {
    args.push('-nic', 'none')
  }

  if (storageEnabled) {
    args.push(
      '-virtfs', 'local,path=/linuxlab-onedrive,mount_tag=host9p,security_model=none,id=onedrive',
    )
  }
  if (firmware === 'uefi') {
    args.push(
      '-drive', 'if=pflash,format=raw,unit=0,readonly=on,file=/pack/edk2-x86_64-code.fd',
      '-drive', 'if=pflash,format=raw,unit=1,file=/pack/edk2-i386-vars.fd',
    )
  }

  if (kind === 'cdrom') {
    args.push(
      '-drive', `file=${mediaSource},media=cdrom,readonly=on,if=ide,format=raw`,
      '-boot', 'order=d',
    )
  } else {
    args.push(
      '-drive', `file=${mediaSource},format=raw,if=ide,snapshot=on`,
      '-boot', 'order=c',
    )
  }
  return args
}

async function startNetworkBridge() {
  await loadClassicScript(networkAsset('stack.js'))
  const stack = window.Stack
  if (!stack || typeof stack.Start !== 'function') throw new Error('QEMU network bridge is invalid')

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stack.Stop?.()
      reject(new Error('QEMU network bridge did not initialize'))
    }, NETWORK_READY_TIMEOUT_MS)
    try {
      stack.Start(
        NETWORK_ADDRESS,
        networkAsset('stack-worker.js'),
        networkAsset('c2w-net-proxy.wasm.gz'),
        (certificate) => {
          clearTimeout(timeout)
          resolve(new Uint8Array(certificate))
        },
      )
    } catch (error) {
      clearTimeout(timeout)
      stack.Stop?.()
      reject(error)
    }
  })
}

async function boot(request) {
  if (bootStarted) throw new Error('The VM has already started')
  bootStarted = true
  if (!crossOriginIsolated) {
    throw new Error('x86-64 runtime requires cross-origin isolation. Reload the page once and try again.')
  }
  if (!(request.file instanceof File)) throw new Error('Uploaded boot media is missing')
  const media = request.file
  const mediaSource = browserMediaSource(media)
  let networkCertificate = null
  try {
    appendLog('Starting browser network bridge...')
    networkCertificate = await startNetworkBridge()
    appendLog('Browser HTTP/HTTPS network bridge is ready.')
  } catch (error) {
    appendLog(`Network bridge unavailable; booting offline: ${error instanceof Error ? error.message : String(error)}`)
  }

  const networkEnabled = networkCertificate !== null
  const storageEnabled = typeof request.oneDriveToken === 'string' && request.oneDriveToken.length > 0
  const moduleConfig = {
    arguments: bootArguments(mediaSource, request.kind, request.memoryMiB, request.firmware, networkEnabled, storageEnabled),
    canvas: screen,
    linuxLabNetworkCert: networkCertificate,
    linuxLabOneDriveToken: storageEnabled ? request.oneDriveToken : null,
    mainScriptUrlOrBlob: asset('out.js'),
    locateFile: (name) => asset(name),
    print: appendLog,
    printErr: appendLog,
    onRuntimeInitialized: () => appendLog('QEMU WebAssembly runtime initialized.'),
    onAbort: (reason) => {
      releaseMediaUrl()
      post('error', { message: `QEMU aborted: ${String(reason)}` })
    },
  }
  if (networkEnabled) moduleConfig.websocket = { url: NETWORK_ADDRESS }

  window.Module = moduleConfig
  await loadClassicScript(asset('load.js'))
  const factoryModule = await import(asset('out.js'))
  const createQemu = factoryModule.default
  if (typeof createQemu !== 'function') throw new Error('QEMU runtime module is invalid')
  qemuModule = await createQemu(window.Module)
  await waitForQemuReady(qemuModule)
  log.hidden = true
  screen.focus()
  post('running', { network: networkEnabled, storage: storageEnabled })
}

async function waitForQemuReady(module) {
  const deadline = Date.now() + QEMU_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if (module.ccall('linuxlab_is_ready', 'number', [], []) === 1) return
    } catch {
      // The exported control boundary becomes available after module initialization.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('QEMU did not finish initializing the virtual machine')
}

function updateOneDriveToken(token) {
  if (!token || !qemuModule) return
  const update = qemuModule.linuxLabSetOneDriveToken
  if (typeof update === 'function') update(token)
}

function handleControl(request) {
  if (!qemuModule || typeof qemuModule.ccall !== 'function') {
    throw new Error('QEMU control interface is not ready')
  }
  switch (request.action) {
    case 'pause':
      qemuModule.ccall('linuxlab_pause', null, [], [])
      break
    case 'resume':
      qemuModule.ccall('linuxlab_resume', null, [], [])
      break
    case 'send-text':
      qemuModule.ccall('linuxlab_send_text', null, ['string'], [String(request.text ?? '')])
      break
    default:
      throw new Error(`Unknown QEMU control action: ${String(request.action)}`)
  }
}
addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== parent) return
  const request = event.data
  if (request?.type === 'boot') {
    void boot(request).catch((error) => {
      releaseMediaUrl()
      appendLog(error instanceof Error ? error.stack ?? error.message : String(error))
      post('error', { message: error instanceof Error ? error.message : String(error) })
    })
    return
  }
  if (request?.type === 'onedrive-token') {
    updateOneDriveToken(request.token)
    return
  }
  if (request?.type === 'control') {
    try {
      handleControl(request)
      if (typeof request.id === 'number') post('control-result', { id: request.id, action: request.action, ok: true })
    } catch (error) {
      if (typeof request.id === 'number') {
        post('control-result', { id: request.id, action: request.action, ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
})

addEventListener('pagehide', () => {
  releaseMediaUrl()
  if (window.Stack && typeof window.Stack.Stop === 'function') window.Stack.Stop()
})

post('ready', { isolated: crossOriginIsolated })
