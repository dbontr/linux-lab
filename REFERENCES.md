# References

These sources define Linux Lab's external interfaces, compatibility assumptions, and deployment behavior.

## Browser virtualization

- [copy/v86](https://github.com/copy/v86) — upstream emulator, API, compatibility limits, BIOS sources, and browser embedding model.
- [v86 filesystem documentation](https://github.com/copy/v86/blob/master/docs/filesystem.md) — virtio 9P mount behavior and the `host9p` share.
- [v86 networking documentation](https://github.com/copy/v86/blob/master/docs/networking.md) — browser network backends and guest NIC behavior.
- [v86 npm package](https://www.npmjs.com/package/v86) — bundler-distributed JavaScript/WASM runtime used by the frontend.

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

## Distribution artifacts

- [Alpine Linux downloads](https://dl-cdn.alpinelinux.org/alpine/) — official Alpine x86 minirootfs and signed package repositories used by the prepared browser image builder.
- [v86 test images](https://i.copy.sh/) — upstream v86-compatible Tiny Core image used by the initial catalog.
- [Tiny Core Linux](https://tinycorelinux.net/) — Tiny Core project homepage and distribution information.

## GitHub Pages and build tooling

- [Vite static deployment guide](https://vite.dev/guide/static-deploy.html) — repository-relative base path and Pages deployment guidance.
- [GitHub Pages custom Actions workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) — official Pages artifact/deploy workflow.
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) — hosting constraints relevant to boot-image size and traffic.

## Project decisions derived from these references

- The initial runtime supports 32-bit x86 guests only because current v86 does not implement x86-64.
- OneDrive is mounted as user storage instead of used as a Linux block device because Microsoft Graph exposes object/file semantics rather than a POSIX block filesystem.
- Linux Lab implements the `9P2000.L` subset needed for ordinary file and directory workflows. Unsupported Unix object types fail explicitly instead of being silently misrepresented.
- External BIOS/media sources and the Alpine minirootfs are SHA-256 pinned; prepared Alpine boot artifacts are reproduced during the Pages build instead of committed as large binaries.
