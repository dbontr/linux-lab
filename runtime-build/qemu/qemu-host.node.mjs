import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../public/runtime/qemu-host.js', import.meta.url), 'utf8')
const controlSource = readFileSync(new URL('./linuxlab-control.c', import.meta.url), 'utf8')
const controlPatchSource = readFileSync(new URL('./patch-control.mjs', import.meta.url), 'utf8')
const preSource = readFileSync(new URL('./pre.js', import.meta.url), 'utf8')
const rrWasmPatchSource = readFileSync(new URL('./patch-rr-wasm-init.mjs', import.meta.url), 'utf8')
const buildSource = readFileSync(new URL('./build.sh', import.meta.url), 'utf8')
const upstreamPatchSource = readFileSync(new URL('./patch-upstream.mjs', import.meta.url), 'utf8')

function loadHost() {
  const screen = { focus() {} }
  const log = { textContent: '', scrollTop: 0, scrollHeight: 0 }
  const context = vm.createContext({
    URL,
    console,
    crossOriginIsolated: true,
    document: {
      getElementById: (id) => id === 'screen' ? screen : log,
      head: { append() {} },
      createElement: () => ({}),
    },
    location: { href: 'https://example.test/linux-lab/runtime/qemu-host.html', origin: 'https://example.test' },
    parent: { postMessage() {} },
    addEventListener() {},
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(source, context)
  return context
}
test('QEMU boot arguments expose browser networking and OneDrive 9P', () => {
  const context = loadHost()
  const args = vm.runInContext(
    "bootArguments('linuxlab:10:blob:test', 'cdrom', 512, 'uefi', true, true)",
    context,
  )

  assert.equal(args[args.indexOf('-m') + 1], '512M')
  assert.equal(args[args.indexOf('-smp') + 1], '1')
  assert.equal(args[args.indexOf('-accel') + 1], 'tcg,thread=single,tb-size=500')
  assert.equal(args.includes('-d'), false)
  assert(args.includes('socket,id=vmnic,connect=localhost:8888'))
  assert(args.includes('local,path=/.wasmenv,mount_tag=wasm0,security_model=passthrough,id=wasm0'))
  assert(args.includes('local,path=/linuxlab-onedrive,mount_tag=host9p,security_model=none,id=onedrive'))
  assert(args.some((value) => value.includes('edk2-x86_64-code.fd')))
  assert(args.some((value) => value.includes('media=cdrom')))
  assert.deepEqual(Array.from(args.slice(-2)), ['-boot', 'order=d'])
})

test('QEMU boot arguments keep offline guests isolated from host shares', () => {
  const context = loadHost()
  const args = vm.runInContext(
    "bootArguments('linuxlab:10:blob:test', 'hda', 99999, 'bios', false, false)",
    context,
  )
  assert.equal(args[args.indexOf('-m') + 1], '1024M')
  assert.deepEqual(Array.from(args.slice(args.indexOf('-nic'), args.indexOf('-nic') + 2)), ['-nic', 'none'])
  assert.equal(args.some((value) => String(value).includes('mount_tag=host9p')), false)
  assert.equal(args.some((value) => String(value).includes('pflash')), false)
  assert(args.some((value) => String(value).includes('snapshot=on')))
  assert.deepEqual(Array.from(args.slice(-2)), ['-boot', 'order=c'])
})

test('browser controls use shared-memory pause state without pause/resume ccall', async () => {
  const context = loadHost()
  context.controlCalls = []
  vm.runInContext(`
    const controlWords = { 4: 0, 8: 0 };
    qemuModule = {
      ccall: (name, ...args) => {
        controlCalls.push([name, ...args]);
        if (name === 'linuxlab_send_text') return 0;
      },
    };
    qemuControl = {
      paused: 4, waiting: 8,
      load: (address) => controlWords[address],
      store: (address, value) => {
        controlWords[address] = value;
        if (address === 4) controlWords[8] = value ? 1 : 0;
        return value;
      },
      notify: () => 1,
    };
  `, context)

  await vm.runInContext("handleControl({ action: 'pause' })", context)
  await vm.runInContext("handleControl({ action: 'resume' })", context)
  await vm.runInContext("handleControl({ action: 'send-text', text: 'hello' })", context)

  assert.deepEqual(context.controlCalls.map((call) => call[0]), ['linuxlab_send_text'])
  assert.deepEqual(Array.from(context.controlCalls[0][3]), ['hello'])
})
test('browser text control surfaces a busy QEMU input channel', async () => {
  const context = loadHost()
  vm.runInContext("qemuModule = { ccall: () => -3 }", context)
  await assert.rejects(
    vm.runInContext("handleControl({ action: 'send-text', text: 'hello' })", context),
    /text input is busy/,
  )
})

test('QEMU readiness initializes shared pause-word control once', async () => {
  const context = loadHost()
  let polls = 0
  const words = new Map([[64, 0], [68, 0]])
  context.readyModule = {
    linuxLabAtomicLoad32: (address) => words.get(address) ?? 0,
    linuxLabAtomicStore32: (address, value) => { words.set(address, value); return value },
    linuxLabAtomicNotify32: () => 1,
    ccall(name) {
      if (name === 'linuxlab_is_ready') { polls += 1; return polls >= 3 ? 1 : 0 }
      if (name === 'linuxlab_pause_word_address') return 64
      if (name === 'linuxlab_pause_waiting_word_address') return 68
      throw new Error(`unexpected ccall: ${name}`)
    },
  }

  await vm.runInContext('waitForQemuReady(readyModule)', context)
  assert.equal(polls, 3)
  assert.equal(vm.runInContext('qemuControl.paused', context), 64)
  assert.equal(vm.runInContext('qemuControl.waiting', context), 68)
})

test('headless PTY satisfies the linked xterm-pty contract', () => {
  const context = loadHost()
  context.TextDecoder = TextDecoder
  const result = vm.runInContext(`(() => {
    const pty = createHeadlessPty();
    const signal = pty.onSignal(() => {});
    const readable = pty.onReadable(() => {});
    const termios = pty.ioctl('TCGETS');
    pty.ioctl('TCSETS', termios);
    return {
      readable: pty.readable,
      writable: pty.writable,
      read: pty.read(1),
      winsize: pty.ioctl('TIOCGWINSZ'),
      signalDisposable: typeof signal.dispose === 'function',
      readableDisposable: typeof readable.dispose === 'function',
      ccLength: termios.cc.length,
    };
  })()`, context)
  assert.equal(result.readable, false)
  assert.equal(result.writable, true)
  assert.deepEqual(Array.from(result.read), [])
  assert.deepEqual(Array.from(result.winsize), [80, 24])
  assert.equal(result.signalDisposable && result.readableDisposable, true)
  assert.equal(result.ccLength, 32)
})

test('QEMU SDL sessions disable the unused guest serial console', () => {
  const context = loadHost()
  const args = vm.runInContext(
    "bootArguments('linuxlab:10:blob:test', 'cdrom', 512, 'bios', false, false)",
    context,
  )
  const serial = args.indexOf('-serial')
  assert.notEqual(serial, -1)
  assert.deepEqual(Array.from(args.slice(serial, serial + 2)), ['-serial', 'none'])
})

test('OneDrive tokens cross the QEMU C control boundary', () => {
  const context = loadHost()
  context.tokenCalls = []
  context.tokenModule = { ccall: (...args) => { context.tokenCalls.push(args); return 0 } }
  vm.runInContext("setOneDriveToken(tokenModule, 'test-access-token')", context)
  assert.deepEqual(JSON.parse(JSON.stringify(context.tokenCalls[0])), ['linuxlab_set_onedrive_token', 'number', ['string'], ['test-access-token']])
})

test('OneDrive token channel rejects oversized-token failures', () => {
  const context = loadHost()
  context.tokenModule = { ccall: () => -1 }
  assert.throws(() => vm.runInContext("setOneDriveToken(tokenModule, 'bad')", context), /too large/)
})

test('QEMU build uses the integrity-first allocator consistently', () => {
  assert.match(buildSource, /-sMALLOC=dlmalloc/)
  assert.doesNotMatch(buildSource, /-sMALLOC=mimalloc/)
  assert.match(upstreamPatchSource, /replaceAll\(allocatorSetting, '-sMALLOC=dlmalloc'\)/)
  assert.match(upstreamPatchSource, /allocatorMatches !== 2/)
})

test('QEMU pause ownership stays in shared memory and the vCPU dispatcher', () => {
  assert.match(controlSource, /EMSCRIPTEN_KEEPALIVE uintptr_t linuxlab_pause_word_address\(void\)/)
  assert.match(controlSource, /EMSCRIPTEN_KEEPALIVE uintptr_t linuxlab_pause_waiting_word_address\(void\)/)
  assert.match(controlSource, /linuxlab_pause_waiting/)
  assert.match(controlSource, /cpu_get_clock\(\) - qatomic_read\(&linuxlab_virtual_clock_offset\)/)
  assert.match(controlSource, /cpu_get_ticks\(\) - qatomic_read\(&linuxlab_elapsed_ticks_offset\)/)
  assert.match(controlSource, /qatomic_store_release\(&linuxlab_pause_waiting, 1\)/)
  assert.match(controlSource, /emscripten_sleep\(1\)/)
  assert.doesNotMatch(controlSource, /emscripten_atomic_wait|ATOMICS_WAIT_DURATION_INFINITE/)
  assert.match(controlSource, /qatomic_store_release\(&linuxlab_pause_waiting, 0\)/)
  assert.doesNotMatch(controlSource, /EMSCRIPTEN_KEEPALIVE void linuxlab_pause\(void\)/)
  assert.doesNotMatch(controlSource, /EMSCRIPTEN_KEEPALIVE void linuxlab_resume\(void\)/)
  assert.doesNotMatch(controlSource, /cpu_disable_ticks\(\)|cpu_enable_ticks\(\)|cpu_exit\(|qemu_cpu_kick\(/)

  assert.match(preSource, /Module\['linuxLabAtomicLoad32'\]/)
  assert.match(preSource, /Module\['linuxLabAtomicStore32'\]/)
  assert.match(preSource, /Module\['linuxLabAtomicNotify32'\]/)
  assert.match(preSource, /Atomics\.load\(HEAP32/)
  assert.match(preSource, /Atomics\.store\(HEAP32/)
  assert.match(preSource, /Atomics\.notify\(HEAP32/)

  assert.match(source, /ccall\('linuxlab_pause_word_address'/)
  assert.match(source, /ccall\('linuxlab_pause_waiting_word_address'/)
  assert.match(source, /control\.store\(control\.paused, 1\)/)
  assert.match(source, /control\.store\(control\.paused, 0\)/)
  assert.match(source, /control\.notify\(control\.paused\)/)
  assert.doesNotMatch(source, /ccall\('linuxlab_pause'/)
  assert.doesNotMatch(source, /ccall\('linuxlab_resume'/)
  assert.doesNotMatch(source, /ccall\('linuxlab_is_running'/)

  assert.match(controlPatchSource, /linuxlab_vcpu_pause_wait\(\);/)
  assert.match(controlPatchSource, /Linux Lab dispatcher boundary/)
  assert.doesNotMatch(controlPatchSource, /i32\.atomic\.load|memory\.atomic\.wait32|linuxlab_pause_word_address/)
  assert.match(buildSource, /system\/cpus\.c/)
  assert.match(buildSource, /tcg\/wasm32\.c/)
  assert.match(buildSource, /tcg\/wasm32\/tcg-target\.c\.inc/)
  assert.match(rrWasmPatchSource, /init_wasm32\(\);/)
  assert.match(source, /tcg,thread=single,tb-size=500/)
  assert.doesNotMatch(source, /'-d', 'nochain'/)
})
