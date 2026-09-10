import assert from 'node:assert/strict'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const distRoot = resolve(repoRoot, 'dist')
const pagePath = '/linux-lab/'
const runQemu = process.env.LINUX_LAB_SMOKE_QEMU !== '0'
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
  await page.locator('[data-status]').filter({ hasText: pattern }).waitFor({ timeout })
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

async function smokeV86(page) {
  await page.locator('.distro-card').nth(0).click()
  await page.locator('[data-boot]').click()
  await waitForStatus(page, 'is running', 30_000)
  const runtime = await page.locator('[data-facts] dd').nth(3).textContent()
  assert.equal(runtime, 'v86')
}

async function smokeQemu(page) {
  await seedOneDriveSession(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.distro-card').nth(1).click()
  await page.locator('[data-boot]').click()
  await waitForStatus(page, 'OneDrive bridge attached', 90_000)
  assert.equal(await page.locator('iframe.qemu-frame').count(), 1)
  await page.locator('[data-pause]').click()
  await waitForStatus(page, 'is stopped', 10_000)
  assert.equal(await page.locator('[data-pause]').textContent(), 'Resume')

  await page.locator('[data-pause]').click()
  await waitForStatus(page, 'is running', 10_000)
  assert.equal(await page.locator('[data-pause]').textContent(), 'Pause')

  await page.locator('[data-send-mount]').click()
  await page.locator('[data-notice]').filter({ hasText: 'Mount command sent' }).waitFor({ timeout: 10_000 })
}

const port = await listen()
const baseUrl = `http://127.0.0.1:${port}${pagePath}`
const browser = await chromium.launch({
  executablePath: browserExecutable(),
  headless: true,
  args: ['--disable-gpu'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error))
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('.distro-card').first().waitFor({ timeout: 10_000 })
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await smokeV86(page)
  if (runQemu) await smokeQemu(page)
  assert.deepEqual(pageErrors.map((error) => error.message), [])
  console.log(`Browser smoke passed: v86${runQemu ? ' + QEMU x86-64 controls/OneDrive' : ''}`)
} finally {
  await browser.close()
  await new Promise((resolveClose) => server.close(resolveClose))
}
