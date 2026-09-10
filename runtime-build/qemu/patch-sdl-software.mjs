import { readFile, writeFile } from 'node:fs/promises'

const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('missing QEMU SDL source path')

const source = await readFile(sourcePath, 'utf8')
const anchor = `    } else {
        /* The SDL renderer is only used by sdl2-2D, when OpenGL is disabled */
        scon->real_renderer = SDL_CreateRenderer(scon->real_window, -1, 0);
    }`
const replacement = `    } else {
        /* Keep the browser display on SDL's software framebuffer path. */
        SDL_SetHint(SDL_HINT_RENDER_DRIVER, "software");
        scon->real_renderer = SDL_CreateRenderer(scon->real_window, -1, 0);
    }`

if (!source.includes(anchor)) throw new Error('QEMU SDL renderer anchor changed')
await writeFile(sourcePath, source.replace(anchor, replacement), 'utf8')
