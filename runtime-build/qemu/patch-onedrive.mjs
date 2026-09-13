import { readFile, writeFile } from 'node:fs/promises'

const path = process.argv[2]
if (!path) throw new Error('usage: patch-onedrive.mjs <hw/9pfs/meson.build>')

const source = await readFile(path, 'utf8')
const anchor = /^  '9p-local\.c',(\r?\n)/m
const matches = [...source.matchAll(new RegExp(anchor.source, 'gm'))]
if (matches.length !== 1) throw new Error(`expected one 9p-local.c source anchor, found ${matches.length}`)
if (source.includes("'linuxlab-onedrive.c'")) throw new Error('Linux Lab OneDrive source is already registered')
const eol = matches[0][1]
await writeFile(path, source.replace(anchor, `  '9p-local.c',${eol}  'linuxlab-onedrive.c',${eol}`), 'utf8')
