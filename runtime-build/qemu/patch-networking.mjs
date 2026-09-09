import { readFile, writeFile } from 'node:fs/promises'

const path = process.argv[2]
if (!path) throw new Error('usage: patch-networking.mjs <stack.js>')

const sourceRaw = await readFile(path, 'utf8')
const source = sourceRaw.replace(/\r\n/g, '\n')
const expectedStart = `import { ws } from 'msw'\nimport { setupWorker } from "msw/browser";`
if (!source.startsWith(expectedStart)) throw new Error('qemu-wasm networking imports changed')

const marker = '\nvar toNetCtrl;'
const offset = source.indexOf(marker)
if (offset < 0) throw new Error('qemu-wasm networking marker not found')

const prefix = `import { WebSocketInterceptor } from '@mswjs/interceptors/WebSocket'

var accepted = false;
let curSocket = null;
let eventQueue = [];
let interceptor = null;
let stackWorker = null;

export function Start(address, stackWorkerFile, stackImage, readyCallback) {
    if (interceptor != null) throw new Error('network bridge is already active');
    const endpoint = new URL(address);
    interceptor = new WebSocketInterceptor();
    interceptor.on('connection', ({ client, server }) => {
        if (!sameEndpoint(endpoint, client.url)) {
            server.connect();
            return;
        }
        if (curSocket != null) {
            client.close(1013, 'network bridge is already connected');
            return;
        }
        curSocket = client;
        sockAccept();
        client.addEventListener('message', (event) => {
            if (!accepted) return;
            eventQueue.push(new Uint8Array(event.data));
            sockSend();
        });
    });
    interceptor.apply();

    stackWorker = new Worker(stackWorkerFile);
    let conn = createStack(stackWorker, stackImage, readyCallback);
    registerConnBuffer(conn.toNet, conn.fromNet);
    registerMetaBuffer(conn.metaFromNet);
}

export function Stop() {
    if (curSocket != null) {
        try { curSocket.close(1000, 'network bridge stopped'); } catch {}
    }
    if (stackWorker != null) stackWorker.terminate();
    if (interceptor != null) interceptor.dispose();
    stackWorker = null;
    interceptor = null;
    curSocket = null;
    accepted = false;
    eventQueue = [];
}

function sameEndpoint(expected, actual) {
    const expectedPort = expected.port || ((expected.protocol === 'https:' || expected.protocol === 'wss:') ? '443' : '80');
    const actualPort = actual.port || ((actual.protocol === 'https:' || actual.protocol === 'wss:') ? '443' : '80');
    return expected.hostname === actual.hostname && expectedPort === actualPort;
}
`

await writeFile(path, prefix + source.slice(offset), 'utf8')
