import { readFile, writeFile } from 'node:fs/promises'

const [sdlPath, sdl2dPath] = process.argv.slice(2)
if (!sdlPath || !sdl2dPath) throw new Error('missing QEMU SDL source paths')

async function replaceOnce(path, anchor, replacement, label) {
  const source = await readFile(path, 'utf8')
  if (!source.includes(anchor)) throw new Error(`${label} anchor changed`)
  await writeFile(path, source.replace(anchor, replacement), 'utf8')
}

await replaceOnce(
  sdlPath,
  `    } else {\n        /* The SDL renderer is only used by sdl2-2D, when OpenGL is disabled */\n        scon->real_renderer = SDL_CreateRenderer(scon->real_window, -1, 0);\n    }`,
  `    } else {\n        /* Keep the browser display on SDL's software framebuffer path. */\n        SDL_SetHint(SDL_HINT_RENDER_DRIVER, "software");\n        scon->real_renderer = SDL_CreateRenderer(scon->real_window, -1, 0);\n    }`,
  'QEMU SDL renderer',
)

await replaceOnce(
  sdl2dPath,
  `        scon->texture = NULL;\n    }\n\n    if (is_placeholder(new_surface)`,
  `        scon->texture = NULL;\n    }\n\n    if (surface_width(new_surface) < 1 || surface_height(new_surface) < 1) {\n        return;\n    }\n\n    if (is_placeholder(new_surface)`,
  'QEMU SDL zero-size surface',
)
