import { readFile, writeFile } from 'node:fs/promises'

const dockerfile = process.argv[2]
if (!dockerfile) throw new Error('Dockerfile path is required')

const expected = 'RUN curl -Ls https://zlib.net/zlib-$ZLIB_VERSION.tar.xz | tar xJC /zlib --strip-components=1'
const replacement = [
  'RUN curl -fLs https://zlib.net/fossils/zlib-1.3.1.tar.gz -o /tmp/zlib.tar.gz \\',
  '    && echo "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23  /tmp/zlib.tar.gz" | sha256sum -c - \\',
  '    && tar xzC /zlib --strip-components=1 -f /tmp/zlib.tar.gz \\',
  '    && rm /tmp/zlib.tar.gz',
].join('\n')

const source = await readFile(dockerfile, 'utf8')
const matches = source.split(expected).length - 1
if (matches !== 1) throw new Error(`Expected one upstream zlib download line, found ${matches}`)
await writeFile(dockerfile, source.replace(expected, replacement))
