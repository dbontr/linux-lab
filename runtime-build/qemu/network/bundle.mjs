import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [entry, outfile, globalName] = process.argv.slice(2)
if (!entry || !outfile) throw new Error('usage: bundle.mjs <entry> <outfile> [global-name]')

const toolDir = dirname(fileURLToPath(import.meta.url))
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: globalName || undefined,
  target: 'es2022',
  minify: true,
  outfile,
  nodePaths: [join(toolDir, 'node_modules')],
})
