import { readFileSync, writeFileSync } from 'node:fs'

const [sourcePath] = process.argv.slice(2)
if (!sourcePath) throw new Error('usage: patch-wasm-coroutine-rewind.mjs <tcg/wasm32.c>')

const source = readFileSync(sourcePath, 'utf8')
const eol = source.includes('\r\n') ? '\r\n' : '\n'
const hook = /void set_unwinding_flag\(\)\r?\n\{\r?\n    ctx\.unwinding = 1;\r?\n\}/g
const matches = [...source.matchAll(hook)]
if (matches.length !== 1) {
  throw new Error(`expected one qemu-wasm coroutine unwind hook, found ${matches.length}`)
}

const replacement = [
  'EM_JS(bool, wasm32_asyncify_is_rewinding, (), {',
  '    return Asyncify.state === Asyncify.State.Rewinding;',
  '});',
  '',
  'void set_unwinding_flag()',
  '{',
  '    if (!wasm32_asyncify_is_rewinding()) {',
  '        ctx.unwinding = 1;',
  '    }',
  '}',
].join(eol)

writeFileSync(sourcePath, source.replace(hook, replacement))
