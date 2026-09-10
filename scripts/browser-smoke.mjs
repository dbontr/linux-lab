import assert from 'node:assert/strict'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const distRoot = resolve(repoRoot, 'dist')
const pagePath = '/linux-lab/'
const qemuAssets = [
  'qemu/load.js',
  'qemu/out.js',
  'qemu/qemu-system-x86_64.wasm',
  'qemu/qemu-system-x86_64.worker.js',
  'qemu/network/stack.js',
]
const qemuAvailable = qemuAssets.every((path) => existsSync(resolve(distRoot, path)))
const qemuMode = process.env.LINUX_LAB_SMOKE_QEMU
if (qemuMode === '1' && !qemuAvailable) throw new Error('QEMU browser smoke was required, but generated runtime assets are missing')
const runQemu = qemuMode === '1' || (qemuMode !== '0' && qemuAvailable)
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.iso', 'application/octet-stream'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
])

if (!existsSync(distRoot)) throw new Error('Build Linux Lab before browser smoke tests')

const server = createServer((request, response) => {
  try {
    serve(request, response)
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(error instanceof Error ? error.message : String(error))
  }
})

function serve(request, response) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/linux-lab') {
    response.writeHead(302, { Location: pagePath })
    response.end()
    return
  }
  if (!url.pathname.startsWith(pagePath)) {
    response.writeHead(404)
    response.end()
    return
  }
  const relative = decodeURIComponent(url.pathname.slice(pagePath.length)) || 'index.html'
  let filePath = resolve(distRoot, relative)
  if (filePath !== distRoot && !filePath.startsWith(`${distRoot}\\`) && !filePath.startsWith(`${distRoot}/`)) {
    response.writeHead(403)
    response.end()
    return
  }
  if (!existsSync(filePath)) {
    response.writeHead(404)
    response.end()
    return
  }
  if (statSync(filePath).isDirectory()) filePath = resolve(filePath, 'index.html')
  const size = statSync(filePath).size
  const headers = {
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Type': mime.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
  }

  const range = request.headers.range
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!match) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
      response.end()
      return
    }
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
      response.end()
      return
    }
    response.writeHead(206, {
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
    })
    createReadStream(filePath, { start, end }).pipe(response)
    return
  }

  response.writeHead(200, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) })
  createReadStream(filePath).pipe(response)
}

function listen() {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
  })
}

function browserExecutable() {
  const candidates = [
    process.env.LINUX_LAB_BROWSER,
    chromium.executablePath(),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) {
    throw new Error('No Chromium browser found. Run `npx playwright-core install chromium`.')
  }
  return executable
}

async function waitForStatus(page, pattern, timeout = 60_000) {
  try {
    await page.locator('[data-status]').filter({ hasText: pattern }).waitFor({ timeout })
  } catch (error) {
    const status = await page.locator('[data-status]').textContent().catch(() => null)
    const notice = await page.locator('[data-notice]').textContent().catch(() => null)
    const frame = page.frames().find((candidate) => candidate.url().includes('/runtime/qemu-host.html'))
    const qemuLog = frame ? await frame.locator('#log').textContent().catch(() => null) : null
    console.error('Linux Lab browser smoke diagnostics:', { status, notice, qemuLog })
    throw error
  }
}

async function seedOneDriveSession(page) {
  await page.evaluate(async () => {
    const request = indexedDB.open('linux-lab-auth', 1)
    await new Promise((resolveRequest, reject) => {
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('session')) request.result.createObjectStore('session')
      }
      request.onsuccess = resolveRequest
      request.onerror = () => reject(request.error)
    })
    const db = request.result
    await new Promise((resolveTx, reject) => {
      const tx = db.transaction('session', 'readwrite')
      tx.objectStore('session').put({
        accessToken: 'linux-lab-browser-smoke-token',
        refreshToken: 'unused-smoke-refresh-token',
        expiresAt: Date.now() + 60 * 60_000,
        clientId: 'smoke-client',
        tenant: 'common',
        scopes: ['Files.ReadWrite'],
      }, 'onedrive')
      tx.oncomplete = resolveTx
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
}

async function smokeV86(page, pageErrors) {
  await page.locator('.distro-card').nth(0).click()
  await page.locator('[data-boot]').click()
  await waitForStatus(page, 'is running', 30_000)
  const runtime = await page.locator('[data-facts] dd').nth(3).textContent()
  assert.equal(runtime, 'v86')
  assert.deepEqual(pageErrors.map((error) => error.message), [], 'prepared Alpine emitted a page error')

  await page.locator('.distro-card').nth(2).click()
  await page.locator('[data-boot]').click()
  await waitForStatus(page, 'Tiny Core Linux is running', 30_000)
  assert.equal(await page.locator('[data-facts] dd').nth(3).textContent(), 'v86')
}

async function smokeQemu(page) {
  const graphRequests = []
  await page.route('https://graph.microsoft.com/**', async (route) => {
    const request = route.request()
    const headers = await request.allHeaders()
    graphRequests.push({ method: request.method(), url: request.url(), authorization: headers.authorization ?? '' })
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, range', 'access-control-allow-methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS' }
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return }
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/v1.0/me/drive/root') {
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'smoke-root', name: 'root', size: 0, folder: { childCount: 0 }, lastModifiedDateTime: '2026-01-01T00:00:00Z' }) })
      return
    }
    if (request.method() === 'GET' && url.pathname === '/v1.0/me/drive/root/children') { await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ value: [] }) }); return }
    await route.fulfill({ status: 404, headers: { ...cors, 'content-type': 'application/json' }, body: '{}' })
  })
  await seedOneDriveSession(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.distro-card').nth(1).click()
  await page.locator('[data-boot]').click()
  await waitForStatus(page, 'OneDrive bridge attached', 90_000)
  assert(graphRequests.some((request) => request.method === 'GET' && request.url.endsWith('/v1.0/me/drive/root') && request.authorization === 'Bearer linux-lab-browser-smoke-token'), 'QEMU OneDrive bridge did not authenticate its Graph root probe')
  assert.equal(await page.locator('iframe.qemu-frame').count(), 1)
  await page.locator('[data-pause]').click()
  await waitForStatus(page, 'is stopped', 10_000)
  assert.equal(await page.locator('[data-pause]').textContent(), 'Resume')

  await page.locator('[data-pause]').click()
  await waitForStatus(page, 'is running', 10_000)
  assert.equal(await page.locator('[data-pause]').textContent(), 'Pause')

  await page.locator('[data-send-mount]').click()
  await page.locator('[data-notice]').filter({ hasText: 'Mount command sent' }).waitFor({ timeout: 10_000 })

  await page.locator('[data-custom]').click()
  await page.locator('[data-custom-dialog] input[name=file]').setInputFiles(resolve(repoRoot, 'public', 'distros', 'TinyCore-11.0.iso'))
  await page.locator('[data-custom-submit]').click()
  await page.locator('[data-boot]').click()
  await waitForStatus(page, 'is running', 90_000)
  await page.locator('[data-session-name]').filter({ hasText: 'TinyCore-11.0.iso' }).waitFor()
  const frame = page.frames().find((candidate) => candidate.url().includes('/runtime/qemu-host.html'))
  assert(frame, 'QEMU custom-media frame is missing')
  const args = await frame.evaluate(() => window.Module.arguments)
  assert(args.some((value) => String(value).includes('media=cdrom')))
  assert.equal(args.some((value) => String(value).includes('pflash')), false)
}

const port = await listen()
const baseUrl = `http://127.0.0.1:${port}${pagePath}`
const browser = await chromium.launch({
  executablePath: browserExecutable(),
  headless: true,
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (error) => { pageErrors.push(error); console.error('Browser page error:', error.stack ?? error.message) })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('.distro-card').first().waitFor({ timeout: 10_000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await smokeV86(page, pageErrors)
  if (runQemu) await smokeQemu(page)
  assert.deepEqual(pageErrors.map((error) => error.message), [])
  console.log(`Browser smoke passed: v86${runQemu ? ' + QEMU x86-64 controls/OneDrive' : ''}`)
} finally {
  await browser.close()
  await new Promise((resolveClose) => server.close(resolveClose))
}
