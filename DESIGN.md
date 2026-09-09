# Linux Lab Design System

## Product posture

Linux Lab is a technical instrument, not a themed desktop simulation. The interface should feel like a compact virtualization console: restrained, fast, legible, and explicit about what is local, disposable, or persistent.

## Layout

Desktop uses three working zones:

1. **Catalog** — distro selection and custom media.
2. **Workspace** — VM display and runtime controls.
3. **Details** — selected distro facts and OneDrive mount state.

Below 1150 px the details panel moves below the workspace. Below 760 px the interface becomes a single-column flow and the distro list becomes horizontally scrollable.

## Visual language

- Dark neutral surfaces with thin borders; avoid decorative gradients.
- One green accent identifies active/runtime-connected state.
- Sans-serif UI type with monospace only for protocol, architecture, commands, and status output.
- Small radii and compact controls; this is a tool, not a card gallery.
- No stock imagery or redundant hero content.

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

## Interaction rules

- Boot is the only primary action in the runtime toolbar.
- Disabled actions remain visible so session capabilities do not shift spatially.
- OneDrive connection state is shown in both the top bar and persistent-storage panel.
- Loading state uses a thin progress strip rather than blocking the VM workspace.
- Errors appear in an `aria-live` status region and a temporary notice.
- Custom media uses a native modal dialog for predictable keyboard/focus behavior.
- All interactive elements must expose a visible `:focus-visible` state.
- Motion must collapse under `prefers-reduced-motion`.

## VM screen

The VM screen is treated as raw guest output. Linux Lab does not overlay controls inside the guest framebuffer. Runtime controls and progress remain outside the display so they cannot be mistaken for guest UI.

## Accessibility target

Target WCAG 2.2 AA for the host shell. Native controls are preferred. Text should remain readable at browser zoom, controls should remain keyboard reachable, and responsive layouts must avoid horizontal page overflow at 320 px.
