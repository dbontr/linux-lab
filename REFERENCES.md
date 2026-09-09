# References

These sources define Linux Lab's external interfaces, compatibility assumptions, runtime build contracts, and deployment behavior.

## Browser virtualization

- [copy/v86](https://github.com/copy/v86) — fast 32-bit x86 emulator, browser embedding API, BIOS sources, networking, and `host9p` filesystem support.
- [v86 filesystem documentation](https://github.com/copy/v86/blob/master/docs/filesystem.md) — virtio 9P mount behavior and the `host9p` share.
- [v86 networking documentation](https://github.com/copy/v86/blob/master/docs/networking.md) — browser network backends and guest NIC behavior.
- [v86 npm package](https://www.npmjs.com/package/v86) — bundler-distributed JavaScript/Wasm runtime used by the 32-bit backend.
- [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm) — QEMU system emulation compiled to WebAssembly; Linux Lab pins commit `0ef7b4e2814b231705d8371dd7997f5b72e70baf` for the x86-64 backend.
- [qemu-wasm browser networking example](https://github.com/ktock/qemu-wasm/tree/0ef7b4e2814b231705d8371dd7997f5b72e70baf/examples/networking) — browser-side QEMU socket networking and guest proxy/certificate setup.
- [QEMU](https://www.qemu.org/) — PC machine, x86-64 CPU, IDE/optical disk, VGA, and firmware semantics inherited by the compatibility backend.

## Browser runtime support

- [Emscripten File System API](https://emscripten.org/docs/api_reference/Filesystem-API.html) — `WORKERFS` provides read-only worker access to browser `File`/`Blob` objects without copying entire large media into Wasm memory.
- [Emscripten ports](https://emscripten.org/docs/compiling/Building-Projects.html#emscripten-ports) — SDL2 port used for QEMU display and browser input integration.
- [container2wasm](https://github.com/container2wasm/container2wasm/tree/v0.5.0) — pinned c2w-net-proxy v0.5.0 runtime used for browser HTTP/HTTPS forwarding.
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

## Distribution and build artifacts

- [Alpine Linux downloads](https://dl-cdn.alpinelinux.org/alpine/) — official x86 minirootfs and x86-64 virtual ISO used by the verified catalog fixtures.
- [zlib fossil archive](https://zlib.net/fossils/) — immutable zlib 1.3.1 source used to repair the pinned QEMU-Wasm build dependency; SHA-256 is verified before extraction.
- [v86 test images](https://i.copy.sh/) — upstream v86-compatible Tiny Core image used by the catalog.
- [Tiny Core Linux](https://tinycorelinux.net/) — Tiny Core project homepage and distribution information.

## GitHub Pages and build tooling

- [Vite static deployment guide](https://vite.dev/guide/static-deploy.html) — repository-relative base path and Pages deployment guidance.
- [GitHub Pages custom Actions workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) — official Pages artifact/deploy workflow.
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) — hosting constraints relevant to boot-image size and traffic.

## Project decisions derived from these references

- Linux Lab uses two runtime backends: v86 for the prepared 32-bit path and QEMU-Wasm for x86-64 or architecture-unknown PC ISO/IMG media.
- Local ISO/IMG uploads remain browser `File` objects. QEMU mounts them through `WORKERFS` so large source media does not need to be duplicated into Wasm memory before boot.
- The QEMU runtime runs in a same-origin iframe. Destroying the iframe is the VM lifecycle boundary for Emscripten pthread workers and global runtime state.
- QEMU-Wasm requires cross-origin isolation for WebAssembly threads, so Pages installs a pinned same-origin COOP/COEP service worker.
- QEMU browser networking uses a page-local WebSocket interceptor and c2w-net-proxy; it does not install a second service worker, which preserves the COOP/COEP ownership boundary.
- OneDrive remains a host-owned credential boundary; OAuth tokens are never exposed to the Linux guest.
- OneDrive is mounted as user storage rather than used as a Linux block device because Microsoft Graph exposes object/file semantics rather than a POSIX block filesystem.
- Linux Lab implements the `9P2000.L` subset needed for ordinary file and directory workflows. Unsupported Unix object types fail explicitly instead of being silently misrepresented.
- External BIOS/media/build sources are pinned or SHA-256 verified; generated VM artifacts are produced by GitHub Actions rather than committed as large binaries.
