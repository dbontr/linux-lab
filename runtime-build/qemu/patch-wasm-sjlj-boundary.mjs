import { readFileSync, writeFileSync } from 'node:fs'

const [sourcePath] = process.argv.slice(2)
if (!sourcePath) throw new Error('usage: patch-wasm-sjlj-boundary.mjs <tcg/wasm32.c>')

const source = readFileSync(sourcePath, 'utf8')
const eol = source.includes('\r\n') ? '\r\n' : '\n'
const hook = /^(\s*)const fidx = addFunction\(inst\.exports\.start, 'ii'\);$/gm
const matches = [...source.matchAll(hook)]
if (matches.length !== 1) {
  throw new Error(`expected one qemu-wasm TB entry hook, found ${matches.length}`)
}
const indent = matches[0][1]

const body = [
  'const start = inst.exports.start;',
  'const sjljSafeStart = (ctxPtr) => {',
  '    const stackPointer = stackSave();',
  '    try {',
  '        return start(ctxPtr);',
  '    } catch (error) {',
  '        stackRestore(stackPointer);',
  '        if (error !== error + 0) throw error;',
  '        _setThrew(1, 0);',
  '        return 0;',
  '    }',
  '};',
  "const fidx = addFunction(sjljSafeStart, 'ii');",
]
const replacement = body.map((line) => `${indent}${line}`).join(eol)

writeFileSync(sourcePath, source.replace(hook, replacement))
