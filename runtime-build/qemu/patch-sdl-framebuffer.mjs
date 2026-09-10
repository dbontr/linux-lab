import { readFile, writeFile } from 'node:fs/promises'

const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('missing SDL Emscripten framebuffer source path')

const source = await readFile(sourcePath, 'utf8')
const anchor = /    surface = data->surface;\r?\n    if \(!surface\) \{\r?\n        return SDL_SetError\("Couldn't find framebuffer surface for window"\);\r?\n    \}\r?\n/g
const matches = [...source.matchAll(anchor)]
if (matches.length !== 1) throw new Error(`expected one SDL Emscripten framebuffer anchor, found ${matches.length}`)
const eol = source.includes('\r\n') ? '\r\n' : '\n'
const replacement = [
  '    surface = data->surface;',
  '    if (!surface) {',
  '        return SDL_SetError("Couldn\'t find framebuffer surface for window");',
  '    }',
  '    if (surface->w < 1 || surface->h < 1) {',
  '        return 0;',
  '    }',
  '',
].join(eol)
await writeFile(sourcePath, source.replace(anchor, replacement), 'utf8')
