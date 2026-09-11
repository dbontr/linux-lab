import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../public/runtime/qemu-host.js', import.meta.url), 'utf8')
const controlSource = readFileSync(new URL('./linuxlab-control.c', import.meta.url), 'utf8')
const controlPatchSource = readFileSync(new URL('./patch-control.mjs', import.meta.url), 'utf8')
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

test('browser controls map to the exported QEMU control boundary', async () => {
  const context = loadHost()
  context.controlCalls = []
  context.runState = 1
  vm.runInContext(`
    qemuModule = {
      ccall: (name, ...args) => {
        controlCalls.push([name, ...args]);
        if (name === 'linuxlab_pause') runState = 0;
        if (name === 'linuxlab_resume') runState = 1;
        if (name === 'linuxlab_is_running') return runState;
        if (name === 'linuxlab_send_text') return 0;
      },
    };
  `, context)

  await vm.runInContext("handleControl({ action: 'pause' })", context)
  await vm.runInContext("handleControl({ action: 'resume' })", context)
  await vm.runInContext("handleControl({ action: 'send-text', text: 'hello' })", context)

  const actions = context.controlCalls.filter((call) => call[0] !== 'linuxlab_is_running')
  assert.deepEqual(actions.map((call) => call[0]), [
    'linuxlab_pause',
    'linuxlab_resume',
    'linuxlab_send_text',
  ])
  assert.deepEqual(Array.from(actions[2][3]), ['hello'])
})

test('browser text control surfaces a busy QEMU input channel', async () => {
  const context = loadHost()
  vm.runInContext("qemuModule = { ccall: () => -3 }", context)
  await assert.rejects(
    vm.runInContext("handleControl({ action: 'send-text', text: 'hello' })", context),
    /text input is busy/,
  )
})

test('QEMU readiness waits for the post-init control marker', async () => {
  const context = loadHost()
  let polls = 0
  context.readyModule = {
    ccall(name) {
      assert.equal(name, 'linuxlab_is_ready')
      polls += 1
      return polls >= 3 ? 1 : 0
    },
  }

  await vm.runInContext('waitForQemuReady(readyModule)', context)
  assert.equal(polls, 3)
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

test('QEMU browser pause breaks TCI and generated TB chains cooperatively and preserves guest clocks', () => {
  assert.match(controlSource, /qemu_bh_new\(linuxlab_pause_bh, NULL\)/)
  assert.match(controlSource, /qemu_bh_new\(linuxlab_resume_bh, NULL\)/)
  assert.match(controlSource, /qemu_bh_new\(linuxlab_text_bh, NULL\)/)
  assert.match(controlSource, /qemu_bh_schedule\(linuxlab_pause_bh_handle\)/)
  assert.match(controlSource, /qemu_bh_schedule\(linuxlab_resume_bh_handle\)/)
  assert.match(controlSource, /qemu_bh_schedule\(linuxlab_text_bh_handle\)/)
  assert.match(controlSource, /uintptr_t linuxlab_pause_word_address\(void\)/)
  assert.match(controlSource, /emscripten_atomic_wait_u32\(/)
  assert.match(controlSource, /ATOMICS_WAIT_DURATION_INFINITE/)
  assert.match(controlSource, /emscripten_atomic_notify\(&linuxlab_paused, EMSCRIPTEN_NOTIFY_ALL_WAITERS\)/)
  assert.match(controlSource, /cpu_disable_ticks\(\)/)
  assert.match(controlSource, /cpu_enable_ticks\(\)/)
  assert.match(controlSource, /cpu = first_cpu/)
  assert.match(controlSource, /qatomic_read\(&cpu->running\)/)
  assert.match(controlSource, /linuxlab_virtual_clock_ns/)
  assert.match(controlSource, /linuxlab_elapsed_ticks/)
  assert.match(controlSource, /cpus_get_virtual_clock\(\)/)
  assert.match(controlSource, /cpus_get_elapsed_ticks\(\)/)
  assert.match(controlPatchSource, /const cpuExecPath = process\.argv\[4\]/)
  assert.match(controlPatchSource, /const wasm32Path = process\.argv\[5\]/)
  assert.match(controlPatchSource, /const wasmTargetPath = process\.argv\[6\]/)
  assert.match(controlPatchSource, /linuxlab_vcpu_pause_wait\(\);\$\{cpuExecEol\}            TranslationBlock \*tb;/)
  assert.match(controlPatchSource, /tciGotoTbAnchor/)
  assert.match(controlPatchSource, /tciGotoPtrAnchor/)
  assert.match(controlPatchSource, /if \(linuxlab_pause_requested\(\)\)/)
  assert.match(controlPatchSource, /tcg_wasm_out_pause_requested/)
  assert.match(controlPatchSource, /i32\.atomic\.load/)
  assert.match(controlPatchSource, /gotoPtrAnchor/)
  assert.match(controlPatchSource, /gotoTbAnchor/)
  assert.match(buildSource, /tcg\/wasm32\.c/)
  assert.match(buildSource, /tcg\/wasm32\/tcg-target\.c\.inc/)
  assert.doesNotMatch(source, /'-d', 'nochain'/)
  assert.doesNotMatch(controlPatchSource, /CF_NO_GOTO_TB|CF_NO_GOTO_PTR|mttcgPath|TB_EXIT_REQUESTED|cpu->exception_index/)
  assert.doesNotMatch(controlSource, /emscripten_sleep\(|emscripten_thread_sleep/)
  assert.doesNotMatch(controlSource, /cpu_exit\(cpu\)|qemu_cpu_kick\(cpu\)|CPU_FOREACH/)
  assert.doesNotMatch(controlSource, /vm_stop|vm_start|pause_all_vcpus|resume_all_vcpus/)
  assert.doesNotMatch(controlSource, /aio_bh_schedule_oneshot|g_new|g_strdup|g_free/)
})
