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

`setup` installs the pinned supported Cua Driver when missing, writes Wayfinder's bounded capability manifest when it starts capture, requests macOS permissions, and runs the same end-to-end checks as `doctor`. It does not install GUI applications or a Linux desktop environment.

Options:

- `--json` returns structured diagnostics.
- `--no-permissions` skips the macOS permission request.

A ready machine needs an interactive graphical session, whole-desktop capture, an accessibility tree, bounded keyboard and pointer input, and a functional H.264 encoder. Browser availability is reported separately.

Platform requirements:

- macOS: the logged-in user must grant Screen Recording and Accessibility to Cua Driver.
- Windows: BB and Cua Driver must run in the interactive user session, not Session 0.
- Linux: the session needs X11 or a Cua-supported Wayland compositor, a session D-Bus, and AT-SPI. A headless Xvfb/Openbox session can capture pixels but has no useful desktop or semantic accessibility tree until the machine owner provisions those outside Wayfinder.
