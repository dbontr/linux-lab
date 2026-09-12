# References

These sources define Linux Lab's external interfaces, compatibility assumptions, runtime build contracts, and deployment behavior.

## Browser virtualization

- [copy/v86](https://github.com/copy/v86) — fast 32-bit x86 emulator, browser embedding API, BIOS sources, networking, and `host9p` filesystem support.
- [v86 filesystem documentation](https://github.com/copy/v86/blob/master/docs/filesystem.md) — virtio 9P mount behavior and the `host9p` share.
- [v86 networking documentation](https://github.com/copy/v86/blob/master/docs/networking.md) — browser network backends and guest NIC behavior.
- [v86 npm package](https://www.npmjs.com/package/v86) — bundler-distributed JavaScript/Wasm runtime used by the 32-bit backend.
- [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm) — QEMU system emulation compiled to WebAssembly; Linux Lab pins commit `0ef7b4e2814b231705d8371dd7997f5b72e70baf` for the x86-64 backend.
- [qemu-wasm browser networking example](https://github.com/ktock/qemu-wasm/tree/0ef7b4e2814b231705d8371dd7997f5b72e70baf/examples/networking) — browser-side QEMU socket networking and guest proxy/certificate setup.
- [qemu-wasm CPU clock accessors](https://github.com/ktock/qemu-wasm/blob/0ef7b4e2814b231705d8371dd7997f5b72e70baf/system/cpus.c) — `cpus_get_virtual_clock()` and `cpus_get_elapsed_ticks()` are the canonical virtual-clock and elapsed-tick accessors wrapped by Linux Lab pause offsets.
- [qemu-wasm CPU timers](https://github.com/ktock/qemu-wasm/blob/0ef7b4e2814b231705d8371dd7997f5b72e70baf/system/cpu-timers.c) — `cpu_get_clock()` and `cpu_get_ticks()` provide the raw monotonic sources snapshotted when Pause and Resume update those offsets.
- [qemu-wasm Wasm/TCI dispatcher](https://github.com/ktock/qemu-wasm/blob/0ef7b4e2814b231705d8371dd7997f5b72e70baf/tcg/wasm32.c) — TCI direct and indirect chain edges provide the boundary where Linux Lab acknowledges Pause and waits on the shared pause word without forcing QEMU out of `cpu_exec()`.
- [qemu-wasm generated-TB backend](https://github.com/ktock/qemu-wasm/blob/0ef7b4e2814b231705d8371dd7997f5b72e70baf/tcg/wasm32/tcg-target.c.inc) — compiled direct and indirect chains normally return to the C dispatcher when the next TB differs; Linux Lab makes same-TB self-loops use that same dispatcher return instead of remaining indefinitely inside generated Wasm.
- [QEMU AIO bottom-half API](https://github.com/ktock/qemu-wasm/blob/0ef7b4e2814b231705d8371dd7997f5b72e70baf/include/block/aio.h) — preallocated `QEMUBH` callbacks and thread-safe scheduling used to transfer browser control requests onto QEMU's owning thread without cross-thread allocation.
- [QEMU](https://www.qemu.org/) — PC machine, x86-64 CPU, IDE/optical disk, VGA, and firmware semantics inherited by the compatibility backend.

## Browser runtime support

- [SDL 2.24.2 Emscripten framebuffer](https://github.com/libsdl-org/SDL/blob/55b03c7493a7abed33cf803d1380a40fa8af903f/src/video/emscripten/SDL_emscriptenframebuffer.c) — pinned software-renderer framebuffer source used by QEMU's `gl=off` display; Linux Lab treats zero-area frames as no-op presentation and Canvas 2D presents valid frames on the main thread.
- [MDN blob URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob) — blob URLs support ranged fetches from browser-owned `Blob` data, used by the QEMU local-media block protocol.
- [MDN synchronous XMLHttpRequest from a Worker](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest_API/Synchronous_and_Asynchronous_Requests) — synchronous worker requests provide the blocking read boundary required by QEMU block I/O without blocking the page UI.
- [Emscripten compiler settings](https://emscripten.org/docs/tools_reference/settings_reference.html) — pthread and WebAssembly runtime settings used by the QEMU browser build.
- [Emscripten Asyncify](https://emscripten.org/docs/porting/asyncify.html) — asynchronous call support retained by the pinned qemu-wasm build for its existing FFI integration.
- [Emscripten File System API](https://emscripten.org/docs/api_reference/Filesystem-API.html) — runtime filesystem used to expose the browser proxy certificate to QEMU through `virtfs`.
- [Emscripten interacting with code](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html) — `EM_JS`, exported C functions, and `ccall` used by the QEMU media, OneDrive, and control bridges.
- [Emscripten 3.1.50 atomic API](https://github.com/emscripten-core/emscripten/blob/3.1.50/system/include/emscripten/atomic.h) — shared-memory wait and notify primitives used to park and wake the QEMU vCPU without Asyncify suspension or worker termination.
- [Emscripten ports](https://emscripten.org/docs/compiling/Building-Projects.html#emscripten-ports) — SDL2 port used for QEMU display and browser input integration.
- [xterm-pty v0.10.1](https://github.com/mame/xterm-pty/tree/v0.10.1) — Emscripten PTY bridge ABI linked into the QEMU-Wasm runtime; Linux Lab provides the compatible headless slave contract while SDL owns guest input.
- [qemu-wasm x86-64 browser example](https://github.com/ktock/qemu-wasm/tree/0ef7b4e2814b231705d8371dd7997f5b72e70baf/examples/x86_64) — upstream browser initialization pattern for the linked PTY bridge and modularized QEMU runtime.
- [container2wasm](https://github.com/container2wasm/container2wasm/tree/v0.5.0) — pinned c2w-net-proxy v0.5.0 runtime used for browser HTTP/HTTPS forwarding.
- [esbuild](https://esbuild.github.io/) — pinned build-only bundler for the QEMU browser networking bridge.
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) — cross-origin isolation on static hosts such as GitHub Pages; Linux Lab pins commit `7b1d2a092d0d2dd2b7270b6f12f13605de26f214`.

## 9P2000.L

- [diod 9P2000.L protocol reference](https://github.com/chaos/diod/blob/master/protocol.md) — message layouts and Linux-oriented operations implemented by the OneDrive bridge.
- [Linux v9fs documentation](https://docs.kernel.org/filesystems/9p.html) — Linux 9P client and mount context.

## Microsoft identity and OneDrive

- [Microsoft identity platform OAuth 2.0 authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) — SPA authorization-code flow with PKCE.
- [Microsoft Graph OneDrive overview](https://learn.microsoft.com/en-us/graph/onedrive-concept-overview) — Drive and DriveItem data model.
- [List children of a DriveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children) — directory enumeration.
- [Download DriveItem content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content) — file reads.
- [Upload small files](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content) — direct file writes.
- [Create an upload session](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession) — resumable large-file writes.
- [Move a DriveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-move) — rename and move semantics.
- [Delete a DriveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-delete) — file and empty-directory removal behavior.

## Distribution and build artifacts

- [Alpine Linux downloads](https://dl-cdn.alpinelinux.org/alpine/) — official x86 minirootfs and x86-64 virtual ISO used by the verified catalog fixtures.
- [zlib 1.3.1 release commit](https://github.com/madler/zlib/commit/51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf) - pinned QEMU-Wasm build input; the codeload archive is SHA-256 verified before extraction.
- [v86 test images](https://i.copy.sh/) — upstream v86-compatible Tiny Core image used by the catalog.
- [Tiny Core Linux](https://tinycorelinux.net/) — Tiny Core project homepage and distribution information.

## GitHub Pages and build tooling

- [Vite static deployment guide](https://vite.dev/guide/static-deploy.html) — repository-relative base path and Pages deployment guidance.
- [GitHub Pages custom Actions workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) — official Pages artifact/deploy workflow.
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) — hosting constraints relevant to boot-image size and traffic.
- [Playwright browser automation](https://playwright.dev/docs/api/class-browsertype) — Chromium launch and browser-level release smoke verification.

## Project decisions derived from these references

- Linux Lab uses two runtime backends: v86 for the prepared 32-bit path and QEMU-Wasm for x86-64 or architecture-unknown PC ISO/IMG media.
- Local ISO/IMG uploads remain browser `File` objects. QEMU reads them through a read-only `linuxlab:` block protocol backed by ranged reads from a same-origin `blob:` URL, so large source media is not duplicated into Wasm memory before boot.
- The QEMU runtime runs in a same-origin iframe. Destroying the iframe is the VM lifecycle boundary for Emscripten pthread workers and global runtime state.
- QEMU's `gl=off` SDL display is forced to the software renderer so its Emscripten framebuffer presents through Canvas 2D on the browser main thread instead of requiring WebGL inside the QEMU pthread.
- QEMU browser builds use Emscripten `dlmalloc` so allocator integrity and predictable threaded I/O behavior take priority over allocator-level contention scaling.
- The QEMU browser profile is explicitly single-vCPU. Generated-Wasm self-loops return to qemu-wasm's C dispatcher instead of spinning indefinitely inside one generated function; TCI chain edges already reach the same C execution surface. Pause snapshots the adjusted virtual clock and elapsed ticks, sets a shared pause word, and the dispatcher parks on that word with Emscripten's atomic wait API. Resume advances per-clock offsets by the host pause duration, clears the pause word, and wakes the vCPU. The pause path does not call `cpu_disable_ticks()`, `cpu_exit()`, `qemu_cpu_kick()`, or QEMU's stopped-vCPU wait, while normal inter-TB chaining remains enabled.
- Browser-thread Pause and Resume operate only on preallocated shared pause/clock state and thread-safe raw clock reads; text input continues to use a persistent QEMU bottom half so guest input remains owned by QEMU. No control request allocates QEMU objects on the browser thread.
- QEMU-Wasm requires cross-origin isolation for WebAssembly threads, so Pages installs a pinned same-origin COOP/COEP service worker.
- QEMU browser networking uses a page-local WebSocket interceptor and c2w-net-proxy; it does not install a second service worker, which preserves the COOP/COEP ownership boundary.
- OneDrive remains a host-owned credential boundary; OAuth tokens are never exposed to the Linux guest.
- Both runtime backends expose OneDrive under the `host9p` mount tag. QEMU maps Graph-backed ordinary files and directories through a host-only Emscripten filesystem adapter with lazy reads and explicit write-back.
- OneDrive is mounted as user storage rather than used as a Linux block device because Microsoft Graph exposes object/file semantics rather than a POSIX block filesystem.
- Linux Lab implements the `9P2000.L` subset needed for ordinary file and directory workflows. Unsupported Unix object types fail explicitly instead of being silently misrepresented.
- External BIOS/media/build sources are pinned or SHA-256 verified; generated VM artifacts are produced by GitHub Actions rather than committed as large binaries.
