import { readFile, writeFile } from 'node:fs/promises'

const files = process.argv.slice(2)
if (files.length === 0) throw new Error('expected generated QEMU JavaScript paths')

let total = 0
for (const file of files) {
  const source = await readFile(file, 'utf8')
  let replacements = 0
  const patched = source.replace(/throw Infinity/g, () => {
    replacements += 1
    return 'console.error("LINUXLAB_LONGJMP_STACK",new Error().stack);throw Infinity'
  })
  total += replacements
  console.log(`${file}: instrumented ${replacements} longjmp sentinel(s)`)
  if (replacements > 0) await writeFile(file, patched, 'utf8')
}
if (total === 0) throw new Error('no longjmp sentinel found in generated QEMU JavaScript')
