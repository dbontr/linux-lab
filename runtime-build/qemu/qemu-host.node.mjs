import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../public/runtime/qemu-host.js', import.meta.url), 'utf8')
const controlSource = readFileSync(new URL('./linuxlab-control.c', import.meta.url), 'utf8')
const controlPatchSource = readFileSync(new URL('./patch-control.mjs', import.meta.url), 'utf8')
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

test('browser pause and resume use shared control words without Wasm calls', async () => {
  const context = loadHost()
  context.controlCalls = []
  vm.runInContext(`
    controlBuffer = new SharedArrayBuffer(16);
    qemuModule = {
      HEAPU8: new Uint8Array(controlBuffer),
      ccall: (name, ...args) => {
        controlCalls.push([name, ...args]);
        if (name === 'linuxlab_pause_word_address') return 4;
        if (name === 'linuxlab_pause_waiting_word_address') return 8;
        if (name === 'linuxlab_send_text') return 0;
        return 0;
      },
    };
    qemuControlWords = bindControlWords(qemuModule);
  `, context)

  const pause = vm.runInContext("handleControl({ action: 'pause' })", context)
  vm.runInContext('Atomics.store(qemuControlWords.waiting, 0, 1)', context)
  await pause
  assert.equal(vm.runInContext('Atomics.load(qemuControlWords.pause, 0)', context), 1)

  const resume = vm.runInContext("handleControl({ action: 'resume' })", context)
  vm.runInContext('Atomics.store(qemuControlWords.waiting, 0, 0)', context)
  await resume
  assert.equal(vm.runInContext('Atomics.load(qemuControlWords.pause, 0)', context), 0)

  await vm.runInContext("handleControl({ action: 'send-text', text: 'hello' })", context)
  const names = context.controlCalls.map((call) => call[0])
  assert.deepEqual(names, [
    'linuxlab_pause_word_address',
    'linuxlab_pause_waiting_word_address',
    'linuxlab_send_text',
  ])
  assert.equal(names.includes('linuxlab_pause'), false)
  assert.equal(names.includes('linuxlab_resume'), false)
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

test('QEMU browser pause exits native chains and parks at the CPU execution boundary', () => {
  assert.match(controlSource, /linuxlab_pause_waiting/)
  assert.match(controlSource, /linuxlab_virtual_clock_offset/)
  assert.match(controlSource, /linuxlab_elapsed_ticks_offset/)
  assert.match(controlSource, /linuxlab_frozen_virtual_clock/)
  assert.match(controlSource, /linuxlab_frozen_elapsed_ticks/)
  assert.match(controlSource, /linuxlab_adjust_virtual_clock/)
  assert.match(controlSource, /linuxlab_adjust_elapsed_ticks/)
  assert.match(controlSource, /linuxlab_pause_word_address/)
  assert.match(controlSource, /linuxlab_pause_waiting_word_address/)
  assert.match(controlSource, /qatomic_load_acquire\(&linuxlab_pause_waiting\)/)
  assert.match(controlSource, /emscripten_atomic_wait_u32\(/)
  assert.match(controlSource, /#define LINUXLAB_PAUSE_WAIT_NS 10000000ll/)
  assert.match(controlSource, /LINUXLAB_PAUSE_WAIT_NS/)
  assert.doesNotMatch(controlSource, /ATOMICS_WAIT_DURATION_INFINITE/)
  assert.match(controlSource, /cpu_get_clock\(\) - qatomic_read\(&linuxlab_virtual_clock_offset\)/)
  assert.match(controlSource, /cpu_get_ticks\(\) - qatomic_read\(&linuxlab_elapsed_ticks_offset\)/)
  assert.doesNotMatch(controlSource, /EMSCRIPTEN_KEEPALIVE void linuxlab_pause\(|EMSCRIPTEN_KEEPALIVE void linuxlab_resume\(/)
  assert.doesNotMatch(controlSource, /cpu_disable_ticks\(\)|cpu_enable_ticks\(\)/)
  assert.match(controlPatchSource, /const cpusPath = process\.argv\[4\]/)
  assert.match(controlPatchSource, /const cpuExecPath = process\.argv\[5\]/)
  assert.match(controlPatchSource, /const wasm32Path = process\.argv\[6\]/)
  assert.match(controlPatchSource, /const wasmTargetPath = process\.argv\[7\]/)
  assert.match(controlPatchSource, /linuxlab_adjust_virtual_clock\(cpus_accel->get_virtual_clock\(\)\)/)
  assert.match(controlPatchSource, /linuxlab_adjust_elapsed_ticks\(cpus_accel->get_elapsed_ticks\(\)\)/)
  assert.match(controlPatchSource, /execLoopAnchor/)
  assert.match(controlPatchSource, /linuxlab_vcpu_pause_wait\(\);/)
  assert.match(controlPatchSource, /tciGotoTbAnchor/)
  assert.match(controlPatchSource, /tciGotoPtrAnchor/)
  assert.match(controlPatchSource, /if \(linuxlab_pause_requested\(\)\)/)
  assert.match(controlPatchSource, /ctx\.tb_ptr = 0/)
  assert.match(controlPatchSource, /tcg_wasm_out_pause_requested/)
  assert.match(controlPatchSource, /i32\.atomic\.load/)
  assert.match(controlPatchSource, /tcg_wasm_out_ctx_i32_store_const\(s, TB_PTR_OFF, 0\)/)
  assert.match(controlPatchSource, /guardedGotoTbBody/)
  assert.match(controlPatchSource, /tcg_wasm_out_op_br\(s, 4\); \/\/ br to the top of loop/)
  assert.doesNotMatch(controlPatchSource, /dispatcherAnchor|gotoPtrSelfLoop|gotoTbSelfLoop|dispatcherReturn/)
  assert.match(buildSource, /system\/cpus\.c/)
  assert.match(buildSource, /accel\/tcg\/cpu-exec\.c/)
  assert.match(buildSource, /tcg\/wasm32\.c/)
  assert.match(buildSource, /tcg\/wasm32\/tcg-target\.c\.inc/)
  assert.match(buildSource, /patch-rr-wasm-init\.mjs/)
  assert.match(rrWasmPatchSource, /init_wasm32\(\);/)
  assert.match(source, /tcg,thread=single,tb-size=500/)
  assert.match(source, /SharedArrayBuffer/)
  assert.match(source, /Atomics\.store\(words\.pause, 0, 1\)/)
  assert.match(source, /Atomics\.store\(words\.pause, 0, 0\)/)
  assert.match(source, /Atomics\.notify\(words\.pause, 0\)/)
  assert.match(source, /Atomics\.load\(words\.waiting, 0\)/)
  assert.doesNotMatch(source, /ccall\('linuxlab_pause'|ccall\('linuxlab_resume'|ccall\('linuxlab_is_running'/)
  assert.doesNotMatch(source, /'-d', 'nochain'/)
  assert.doesNotMatch(controlPatchSource, /tcg_tb_lookup|return EXCP_INTERRUPT/)
  assert.doesNotMatch(controlSource, /cpu->stop|cpu->stopped|cpu_resume\(cpu\)|cpu_exit\(cpu\)|qemu_cpu_kick\(cpu\)|CPU_FOREACH/)
  assert.doesNotMatch(controlSource, /vm_stop|vm_start|pause_all_vcpus|resume_all_vcpus/)
})
