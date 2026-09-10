import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('./pre.js', import.meta.url), 'utf8')

function createBridge(handler) {
  const calls = []
  class FakeXHR {
    headers = {}
    response = null
    responseText = ''
    status = 0
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(name, value) { this.headers[name] = value }
    send(body) {
      const call = { method: this.method, url: this.url, headers: this.headers, body }
      calls.push(call)
      const reply = handler(call)
      this.status = reply.status ?? 200
      this.responseText = reply.text ?? ''
      this.response = reply.bytes ? Uint8Array.from(reply.bytes).buffer : null
    }
  }
  const heap = new Uint8Array(64)
  const context = vm.createContext({
    Module: { preRun: [] },
    FS: {
      readFile: (path) => {
        if (path === '/.linuxlab/onedrive-token') return 'test-token'
        throw new Error(`unexpected read: ${path}`)
      },
    },
    HEAPU8: heap,
    XMLHttpRequest: FakeXHR,
    console: { error() {}, log() {}, warn() {} },
  })
  vm.runInContext(source, context)
  return { bridge: context.Module.linuxLabOneDriveBridge, calls, heap }
}

function graphItem(name, overrides = {}) {
  return JSON.stringify({
    id: `${name}-id`,
    name,
    size: 0,
    lastModifiedDateTime: '2026-01-01T00:00:00Z',
    ...overrides,
  })
}
test('range reads stay lazy and use the host bearer token', () => {
  const { bridge, calls, heap } = createBridge((call) => {
    if (call.url.endsWith('/me/drive/root:/file')) {
      return { text: graphItem('file', { size: 5 }) }
    }
    if (call.url.endsWith('/me/drive/root:/file:/content')) {
      assert.equal(call.headers.Range, 'bytes=1-3')
      return { status: 206, bytes: [20, 30, 40] }
    }
    throw new Error(`unexpected request: ${call.method} ${call.url}`)
  })

  bridge.track(7, '/file')
  assert.equal(bridge.pread(7, 1, 3, 4), 3)
  assert.deepEqual(Array.from(heap.slice(4, 7)), [20, 30, 40])
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.headers.Authorization, 'Bearer test-token')
  }
})
test('writes are buffered by file and flushed back through Graph', () => {
  let uploaded = null
  const { bridge, calls, heap } = createBridge((call) => {
    if (call.method === 'GET' && call.url.endsWith('/me/drive/root:/file')) {
      return { text: graphItem('file', { size: 3 }) }
    }
    if (call.method === 'GET' && call.url.endsWith('/me/drive/root:/file:/content')) {
      return { bytes: [1, 2, 3] }
    }
    if (call.method === 'PUT' && call.url.endsWith('/me/drive/root:/file:/content')) {
      uploaded = Array.from(new Uint8Array(call.body.buffer, call.body.byteOffset, call.body.byteLength))
      return { text: graphItem('file', { size: 3 }) }
    }
    throw new Error(`unexpected request: ${call.method} ${call.url}`)
  })

  heap.set([9, 8], 10)
  bridge.track(11, '/file')
  assert.equal(bridge.pwrite(11, 1, 2, 10), 2)
  assert.equal(bridge.flushFd(11), 0)
  assert.deepEqual(uploaded, [1, 9, 8])
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer test-token')
})
test('non-empty OneDrive directories cannot be removed recursively', () => {
  const { bridge, calls } = createBridge((call) => {
    if (call.method === 'GET' && call.url.endsWith('/me/drive/root:/folder')) {
      return { text: graphItem('folder', { folder: {}, size: 0 }) }
    }
    if (call.method === 'GET' && call.url.includes('/me/drive/root:/folder:/children?')) {
      return { text: JSON.stringify({ value: [{ id: 'child-id' }] }) }
    }
    if (call.method === 'DELETE') throw new Error('DELETE must not be attempted')
    throw new Error(`unexpected request: ${call.method} ${call.url}`)
  })

  assert.equal(bridge.remove('/folder'), -39)
  assert.equal(calls.some((call) => call.method === 'DELETE'), false)
})
