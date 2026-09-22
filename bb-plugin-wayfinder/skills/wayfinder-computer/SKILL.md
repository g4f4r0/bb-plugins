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

Agents can use `wayfinder_windows`, `wayfinder_window_center`, `wayfinder_screenshot`, `wayfinder_record_start`, and `wayfinder_record_stop`, `wayfinder_desktop_click`, and `wayfinder_desktop_scroll`. Desktop clicks use only Cua's native pointer; coordinates must come from a fresh whole-screen observation, and the active human or run controller must release control before agent input. The agent tools default to the thread's enrolled machine and accept an explicit connected `machine` for cross-machine capture. CLI capture commands require a thread environment. Window IDs must come from a fresh `windows` listing; frame changes are limited to that exact visible window through a temporary Cua capability manifest. Cua records the actual whole desktop at 30 fps; files are private BB artifacts, not public shares. One recording per machine, at most two minutes. Stop it to finalize the MP4, and verify the checkout or other claimed endpoint independently. Never capture protected input or secrets.

Options:

- `--json` returns structured diagnostics.
- `--no-permissions` skips the macOS permission request.

A ready machine needs an interactive graphical session, whole-desktop capture, an accessibility tree, bounded keyboard and pointer input, and a functional H.264 encoder. Browser availability is reported separately.

Platform requirements:

- macOS: the logged-in user must grant Screen Recording and Accessibility to Cua Driver.
- Windows: BB and Cua Driver must run in the interactive user session, not Session 0.
- Linux: the session needs X11 or a Cua-supported Wayland compositor, a session D-Bus, and AT-SPI. A headless Xvfb/Openbox session can capture pixels but has no useful desktop or semantic accessibility tree until the machine owner provisions those outside Wayfinder.
