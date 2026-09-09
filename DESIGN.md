# Linux Lab Design System

## Product posture

Linux Lab is a technical virtualization instrument, not a themed desktop simulation. The interface should feel compact, fast, legible, and explicit about what is local, disposable, persistent, or limited by a runtime backend.

## Layout

Desktop uses three working zones:

1. **Catalog** — distro selection and custom ISO/IMG media.
2. **Workspace** — guest display and runtime controls.
3. **Details** — selected architecture, runtime, boot source, network capability, and OneDrive state.

Below 1150 px the details panel moves below the workspace. Below 760 px the interface becomes a single-column flow and the distro list becomes horizontally scrollable.

## Visual language

- Dark neutral surfaces with thin borders; avoid decorative gradients.
- One green accent identifies connected/running state.
- Sans-serif UI type with monospace only for protocol, architecture, commands, and status output.
- Small radii and compact controls; this is a tool, not a card gallery.
- No stock imagery, redundant app identity banners, or decorative calls to action.

## Core tokens

The CSS variables in `src/style.css` are the source of truth:

- `--bg`: page/workspace background.
- `--panel`: side-panel surface.
- `--panel-raised`: interactive raised surface.
- `--line`, `--line-strong`: structural borders.
- `--text`, `--muted`: primary and secondary text.
- `--accent`: connected/running/primary action state.
- `--danger`: errors.
- `--radius`: standard corner radius.

## Runtime presentation

- Runtime selection is automatic by default. Known prepared x86 guests use v86; x86-64 and architecture-unknown PC media use QEMU-Wasm.
- Architecture and selected runtime are visible in Details, but emulator choice is not a required decision for normal users.
- Local ISO/IMG upload is the preferred custom-media path. Remote URLs remain an alternate input for CORS-compatible sources.
- QEMU networking is available through a browser HTTP/HTTPS proxy. Keep its one-time guest setup visible only for QEMU selections and state the CORS/protocol limit.
- Media type is auto-detected from ISO-9660 structure where possible, with an explicit ISO/IMG override for unusual images.
- A capability unavailable in the active backend stays disabled rather than silently pretending to work.
- The guest display has no Linux Lab overlays. Runtime controls and progress stay outside guest pixels.

## Interaction rules

- Boot is the only primary action in the runtime toolbar.
- Disabled actions remain visible so session capabilities do not shift spatially.
- OneDrive connection state is shown in both the top bar and persistent-storage panel.
- Loading uses a thin progress strip rather than blocking the workspace.
- Errors appear in an `aria-live` status region and a temporary notice.
- Custom media uses a native modal dialog for predictable keyboard and focus behavior.
- Local uploads are never sent to an application server; the selected file stays in the browser runtime.
- All interactive elements expose a visible `:focus-visible` state.
- Motion collapses under `prefers-reduced-motion`.

## VM lifecycle

v86 owns a directly embedded VM instance. QEMU-Wasm runs in a same-origin iframe because its Emscripten pthread runtime has process-global state; removing the iframe is the QEMU power-off boundary and terminates its workers with the document.

## Accessibility target

Target WCAG 2.2 AA for the host shell. Native controls are preferred. Text remains readable at browser zoom, controls remain keyboard reachable, and responsive layouts avoid horizontal page overflow at 320 px. Guest operating systems retain responsibility for accessibility inside their own framebuffer.
