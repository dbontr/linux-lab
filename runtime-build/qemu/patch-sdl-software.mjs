import { readFile, writeFile } from 'node:fs/promises'

const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('missing QEMU SDL source path')

const source = await readFile(sourcePath, 'utf8')
const anchor = `    } else {\n        /* The SDL renderer is only used by sdl2-2D, when OpenGL is disabled */\n        scon->real_renderer = SDL_CreateRenderer(scon->real_window, -1, 0);\n    }`
const replacement = `    } else {\n        /* Keep the browser display on SDL's software framebuffer path. */\n        SDL_SetHint(SDL_HINT_RENDER_DRIVER, "software");\n        scon->real_renderer = SDL_CreateRenderer(scon->real_window, -1, 0);\n    }`

if (!source.includes(anchor)) throw new Error('QEMU SDL renderer anchor changed')
await writeFile(sourcePath, source.replace(anchor, replacement), 'utf8')
