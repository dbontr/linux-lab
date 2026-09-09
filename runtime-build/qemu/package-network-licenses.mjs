import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sourceRoot = process.argv[2]
const output = process.argv[3]
if (!sourceRoot || !output) throw new Error('usage: package-network-licenses.mjs <network-source> <output>')

const packages = [
  '@bjorn3/browser_wasi_shim',
  '@mswjs/interceptors',
  '@open-draft/deferred-promise',
  '@open-draft/logger',
  '@open-draft/until',
  'is-node-process',
  'outvariant',
  'strict-event-emitter',
]

const sections = []
for (const name of packages) {
  const directory = join(sourceRoot, 'node_modules', ...name.split('/'))
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const files = await readdir(directory)
  const licenseName = files.find((file) => /^licen[sc]e(?:[-.]|$)/i.test(file))
  let body
  if (licenseName) {
    body = (await readFile(join(directory, licenseName), 'utf8')).trim()
  } else {
    const repository = typeof manifest.repository === 'string'
      ? manifest.repository
      : manifest.repository?.url ?? manifest.homepage ?? 'not declared'
    body = `The npm package does not include a license text. package.json declares ${manifest.license ?? 'no SPDX license'}; source: ${repository}`
  }
  sections.push(`===== ${name} ${manifest.version} (${manifest.license ?? 'see package metadata'}) =====\n${body}\n`)
}

await writeFile(output, sections.join('\n'), 'utf8')
console.log(`packaged ${sections.length} network dependency notices to ${output}`)
