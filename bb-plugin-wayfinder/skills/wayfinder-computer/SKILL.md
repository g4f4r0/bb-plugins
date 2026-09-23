---
name: wayfinder-computer
description: Diagnose or set up Wayfinder computer control, Cua Driver, desktop capture, accessibility, input, and video on an enrolled BB machine.
---

# Wayfinder computer setup

Wayfinder controls the logged-in desktop already present on an enrolled machine. It does not install a desktop environment, create shortcuts, or replace the user's session.

Use the thread's computer:

```sh
bb wayfinder doctor
bb wayfinder setup
```

Target another enrolled computer explicitly:

```sh
bb wayfinder doctor --machine <hostId>
bb wayfinder setup --machine <hostId>
```

`setup` installs the pinned supported Cua Driver when missing, writes Wayfinder's bounded capability manifest when it starts capture, requests macOS permissions for Cua Driver's stable identity, and runs the same end-to-end checks as `doctor`. It does not install GUI applications or a Linux desktop environment.

Capture and presentation on the thread's existing computer:

```sh
bb wayfinder windows
bb wayfinder window center <pid> <windowId> [width height]
bb wayfinder click <x> <y>
bb wayfinder scroll <x> <y> <deltaY>
bb wayfinder screenshot [filename.png]
bb wayfinder record start [filename.mp4]
bb wayfinder record stop <recordingId>
```

Agents can use `wayfinder_windows`, `wayfinder_window_center`, `wayfinder_screenshot`, `wayfinder_record_start`, and `wayfinder_record_stop`, `wayfinder_desktop_click`, and `wayfinder_desktop_scroll`. Desktop clicks use only Cua's native pointer; coordinates must come from a fresh whole-screen observation, and the active human or run controller must release control before agent input. The agent tools default to the thread's enrolled machine and accept an explicit connected `machine` for cross-machine capture. CLI capture commands require a thread environment. Window IDs must come from a fresh `windows` listing; frame changes are limited to that exact visible window through a temporary Cua capability manifest. Cua records the actual whole desktop at 30 fps; files are private BB artifacts, not public shares. On the enrolled Linux/X11 server, agent actions select the installed native solid-blue Cua theme, hide the physical pointer through XFixes only during input, and hide the agent overlay again afterward. Human control uses a separate no-overlay Cua session. For an explicit recording on the enrolled Linux XFCE desktop, Wayfinder temporarily suspends the visible panel, leaves Cua's cursor on between agent actions, and restores the panel and normal cursor on stop, timeout, or worker disposal. Before recording it binds the Cua manifest to the exact visible application windows; live Computer viewers must disconnect before this rebinding. Cua 0.28.2's native session badge is not theme-controlled, and its Linux ffmpeg recorder can still draw the physical pointer even while XFixes hides it from the live desktop. Do not describe a recording as badge-free or single-cursor without frame-by-frame evidence. The theme source and compiled artifact are under `assets/cursor/`; on other hosts Cua's default theme is used until the custom theme is installed through Cua's trusted local `cursor-theme install` workflow. One recording per machine, at most two minutes. Stop it to finalize the MP4, and verify the checkout or other claimed endpoint independently. Never capture protected input or secrets.

Options:

- `--json` returns structured diagnostics.
- `--no-permissions` skips the macOS permission request.

A ready machine needs an interactive graphical session, whole-desktop capture, an accessibility tree, bounded keyboard and pointer input, and a functional H.264 encoder. Browser availability is reported separately.

Native Jev desktop runs can use `wayfinder_start` with one verified `desktop.applications` entry, `allowedActions: ["desktop.click", "desktop.scroll"]`, a desktop visible-text checkpoint, and optional exact `desktop.allowedTargetNames`. The app must already be open on the selected Linux host. The agent sees Cua AT-SPI labels and chooses among only on-screen route-approved controls; Cua dispatches native element tokens, and a window-bound desktop scroll is available. Desktop-only runs do not launch or use the CDP browser action adapter. A browser popup missing from AT-SPI is **not** proof of progress: the run may block or become uncertain. OpenRouter's Jev model can be used when the direct TypeSafe key is unavailable; never call a manual CLI sequence a Jev run. Recording is a separate bounded lifecycle and should be stopped promptly when a run terminates. Never fill checkout fields or submit orders in a non-purchasing run.

Platform requirements:

- macOS: the logged-in user must grant Screen Recording and Accessibility to Cua Driver.
- Windows: BB and Cua Driver must run in the interactive user session, not Session 0.
- Linux: the session needs X11 or a Cua-supported Wayland compositor, a session D-Bus, and AT-SPI. A headless Xvfb/Openbox session can capture pixels but has no useful desktop or semantic accessibility tree until the machine owner provisions those outside Wayfinder.
