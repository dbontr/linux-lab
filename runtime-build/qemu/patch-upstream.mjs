import { readFile, writeFile } from 'node:fs/promises'

const dockerfile = process.argv[2]
if (!dockerfile) throw new Error('Dockerfile path is required')

const zlibCommit = '51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf'
const zlibSha256 = 'd9e270d46252734aa49770fbc544125391617956266f220bd63216c834f3a522'
const expected = 'RUN curl -Ls https://zlib.net/zlib-$ZLIB_VERSION.tar.xz | tar xJC /zlib --strip-components=1'
const replacement = [
  `RUN curl -fLs https://codeload.github.com/madler/zlib/tar.gz/${zlibCommit} -o /tmp/zlib.tar.gz \\`,
  `    && echo "${zlibSha256}  /tmp/zlib.tar.gz" | sha256sum -c - \\`,
  '    && tar xzC /zlib --strip-components=1 -f /tmp/zlib.tar.gz \\',
  '    && rm /tmp/zlib.tar.gz',
].join('\n')

const source = await readFile(dockerfile, 'utf8')
const matches = source.split(expected).length - 1
if (matches !== 1) throw new Error(`Expected one upstream zlib download line, found ${matches}`)
await writeFile(dockerfile, source.replace(expected, replacement), 'utf8')
