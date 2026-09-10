import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../public/runtime/qemu-host.js', import.meta.url), 'utf8')

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
