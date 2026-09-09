import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sources = JSON.parse(await readFile(join(root, 'distros', 'sources.json'), 'utf8'))

for (const source of sources) {
  await syncSource(source)
}

async function syncSource(source) {
  const output = join(root, source.output)
  await mkdir(dirname(output), { recursive: true })
  if (await matchesHash(output, source.sha256)) {
    console.log(`verified ${source.id}`)
    return
  }

  const response = await fetch(source.url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${source.id}: HTTP ${response.status}`)
  }

  const temporary = `${output}.part`
  const hash = createHash('sha256')
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary))
    const actual = hash.digest('hex')
    if (actual !== source.sha256) {
      throw new Error(`hash mismatch for ${source.id}: expected ${source.sha256}, got ${actual}`)
    }
    await rename(temporary, output)
    console.log(`downloaded ${source.id}`)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function matchesHash(file, expected) {
  try {
    await stat(file)
  } catch {
    return false
  }

  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex') === expected
}
