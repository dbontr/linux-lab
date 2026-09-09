import { readFile, writeFile } from 'node:fs/promises'

const path = process.argv[2]
if (!path) throw new Error('usage: patch-browser-media.mjs <block/meson.build>')

const source = await readFile(path, 'utf8')
const anchor = /^  'null\.c',(\r?\n)/gm
const matches = [...source.matchAll(anchor)]
if (matches.length !== 1) {
  throw new Error(`expected one null.c block source anchor, found ${matches.length}`)
}
if (source.includes("'linuxlab-media.c'")) {
  throw new Error('Linux Lab media source is already registered')
}

const eol = matches[0][1]
const patched = source.replace(anchor, `  'null.c',${eol}  'linuxlab-media.c',${eol}`)
await writeFile(path, patched, 'utf8')
