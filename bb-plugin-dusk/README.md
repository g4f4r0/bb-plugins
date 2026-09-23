# Dusk

Dusk is a local appearance plugin for BB. It changes the palette, homepage wallpaper, composer controls, and thread sidebar. BB still owns the composer, navigation, thread state, icons, and submission logic.

The plugin is intentionally small. If a change requires copying a whole BB component, stop and look for a narrower hook or CSS selector first.

## Using Dusk

Install dependencies and the plugin from this directory:

```sh
npm install
bb plugin install .
bb theme set plugin:dusk:default
```

Open BB's welcome launcher or **New thread** to see the Dusk wallpaper. Use the pencil beside the sidebar toggle on either screen to choose, change, or remove it. Changes save immediately and apply to both screens.

Dusk processes uploads in the browser, converts them to WebP, and stores them in BB plugin KV. The original image does not enter the repository or leave the BB server.

Photos use Aura's animated color dithering, with a consistent two-pixel texture on desktop and mobile. The effect pauses for reduced motion and hidden pages, and retains the source texture while panels resize. Browsers without WebGL show the original image. Attribution and licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Disable Dusk to restore BB's native layout. Switch back to the default palette with:

```sh
bb theme set default
```

## Status sidebar

Dusk can replace BB's thread list with status sections: **Pinned**, **Waiting**, **Ready**, **Working**, **Done**, and **Snoozed**. There are no project headings; each row shows its project (Personal for threads outside a project) and last update. BB's own list is now the built-in Thread list plugin, and BB picks that one automatically. To use Dusk's list, open **Settings → Appearance → Sidebar** and choose **Dusk (status)**. The choice syncs across devices.

- **Waiting**: the agent is waiting on you, with a question or approval, a run failed and you haven't read it, or a queued message failed to send.
- **Ready**: the agent finished and you haven't read the result.
- **Working**: the agent, a workflow, a background job, plan mode, or a goal is active.
- **Done**: finished threads you've read, newest first. A thread with a scheduled message stays here and shows BB's grey waiting-to-send ring.
- Opening an unread thread keeps it in Ready or Waiting for 5 seconds. Leave sooner and Dusk marks it unread again, so a mis-click doesn't lose it.
- Child threads stay under their parent. A group takes its most urgent state: Waiting, then Working, then Ready.

Hover a row for Pin, Snooze, Archive, and the `…` menu. Rest on a row for half a second to see a card with the project, the full title (the full first prompt for untitled threads), the model with its provider logo and reasoning level, and the branch or worktree. Snooze offers In 1 hour, In 3 hours, Tomorrow (9:00), Next week (Monday 9:00), or Custom, which asks for a date (calendar popover) and a time. **Dusk: snooze thread…** in the command palette opens the Custom picker. A snoozed thread returns when its time is up or when anything in it changes. Threads that are working or asking can't be snoozed. Archive is BB's normal archive.

The calendar, popover, and hover card come from BB's shadcn registry (`npx shadcn add @bb/<name>`). BB uses Tailwind v4, so write CSS variable classes as `h-(--cell-size)`, not `h-[--cell-size]`.

Snoozes are stored in Dusk's plugin storage, so removing Dusk removes them. The rules live in `lib/status.ts`; run `node --test tests/status.test.ts` after changing them.

## Keyboard shortcuts

To opt into Dusk's T3-inspired keyboard layout, apply it explicitly:

```sh
bb dusk shortcuts apply
bb dusk shortcuts list
bb dusk shortcuts reset
```

The preset is app-wide. Dusk snapshots the affected BB overrides before the
first apply so `reset` can restore them. Reset the preset before uninstalling
Dusk if you want those previous overrides back.

`Mod+J` opens a terminal through BB's `terminal.open` command. `Mod+Alt+B`
toggles the right panel.

## Working on the plugin

Use the development watcher while editing:

```sh
npm run dev
```

Before calling a change done, run:

```sh
npm run typecheck
node --test tests/status.test.ts
bb plugin build
bb plugin reload dusk
```

Install Dusk from a durable checkout or local plugin directory. Do not make a temporary thread workspace the only copy of the source.

## Where things live

| File | Purpose |
| --- | --- |
| `app.tsx` | Registers frontend overlays and content scripts. |
| `server.ts` | Stores wallpaper settings and fetches message timestamps for sidebar ages. |
| `app.css` | Handles component sizing, sidebar states, responsive layout, and small compatibility fixes. |
| `themes/dusk.css` | Defines the Dusk palette and semantic button colors. |
| `themes/dusk-dark.json` / `dusk-light.json` | VS Code tokens for BB code views and Sidetree. |
| `lib/homepage.ts` | Finds the native welcome and New thread pages, mounts the wallpaper, and positions the pencil control. |
| `lib/homepage-header.ts` | Keeps the right toggle pinned while forwarding native panel actions, and positions the pencil through sidebar transitions. |
| `lib/wallpaper.ts` | Prepares uploads and selects the photo or ambient renderer. |
| `lib/photo.ts` | Runs the photo shader, resizes without reloading the image, and handles motion and WebGL fallback. |
| `lib/photo-shaders.ts` | Attributed Aura/Paper image shaders and Aura's threshold-wave animation. |
| `lib/ambient.ts` | Draws the animated fallback when no image is set. |
| `lib/sidebar.tsx` | Adds branch or location, message age, and Pin or Unpin to BB's Thread list rows. |
| `lib/observe-roots.ts` | Watches only the DOM areas Dusk needs and cleans up on unload. |

## Adding a visual rule

Put palette values in `themes/dusk.css`. Put component layout in `app.css`.

Scope rules to a stable BB attribute such as `data-testid`, `data-sidebar`, `data-promptbox`, or an accessible label. Avoid broad rules such as `button`, `svg`, or `.rounded-md`. Those leak into menus and panels that have nothing to do with the change.

Add both light and dark values when color is involved. Prefer semantic variables such as `--primary`, `--background`, and `--sidebar-accent` over repeated hex values.

## Adding homepage behavior

Keep the native welcome actions and composer intact. `lib/homepage.ts` locates the welcome signature or `#root-compose-prompt`, then adds only Dusk-owned elements around it.

New homepage behavior should follow the same pattern:

1. Find a stable native root.
2. Add a clearly named `dusk-*` element or class.
3. Keep observers scoped to that root.
4. Remove every class, node, observer, timer, and listener when the content script unloads.

For motion, animate `transform` or `opacity`. Match BB's duration and easing when an element moves with native UI. Add a `prefers-reduced-motion` fallback.

The wallpaper pencil follows the page's existing motion without a second transition. Its position is clamped beside the left toggle as the sidebar collapses. The homepage right toggle stays fixed across BB's native header handoff and forwards clicks to the current native action; leaving the homepage removes that presentation and restores the native controls.

## Adding a setting or RPC

The wallpaper is currently the only user setting. To add another persisted value:

1. Add it to `Config` and `DEFAULTS` in `lib/config.ts`.
2. Validate it in `configSchema` inside `server.ts`.
3. Add it to the `get` and `save` flow.
4. Read it through `useBackground` or a new focused hook in `app.tsx`.
5. Keep payloads bounded. BB plugin KV has a size limit.

For a new server operation, add the input and output schema to `rpcContract`, register the handler in `server.ts`, and call it with `useRpc` on the frontend. Treat browser input and stored values as untrusted.

## Adding sidebar details or actions

Use `experimental_useSidebarThreads` for thread data and `experimental_useSidebarThreadActions` for native actions. Keep the existing row and link. Add content with a portal instead of replacing the row.

Status artwork belongs in the native trailing-indicator slot. Preserve BB's accessible labels because they describe the real state to screen readers and define state priority.

## QA checklist

Check a fresh page after reloading the plugin. Existing tabs can retain an older content-script bundle.

At minimum, test:

- Desktop at 1440 x 960 with the left sidebar open and closed.
- Mobile at 390 x 844 with the sidebar open and closed.
- Empty and typed composers.
- Voice recording, cancel, and confirm states.
- Right panel open and closed.
- Working, draft, success, failure, and scheduled-message thread states.
- Send, Send options (Save draft, Send later), and a handoff from the model picker.
- Quick palette in commands and Threads modes.
- Light, dark, and reduced-motion modes.
- Navigation between the welcome launcher and New thread, then away and back again.

Inspect positions frame by frame when Dusk moves with native UI. Matching final coordinates is not enough. The two elements must start, progress, and finish together.

After a BB upgrade, recheck every selector that depends on BB's DOM. The main ones are the welcome `role="img"`/`aria-label="bb"` signature, `#root-compose-prompt`, `data-promptbox-shell`, `data-promptbox-send-menu`, `data-promptbox-submit-label`, `data-sidebar`, `data-sidebar-rename-row` (a Thread list row, with the link inside its title span), `data-palette-thread-status`, and the sidebar trigger test IDs.

Keep BB's new controls and restyle them; don't hide a feature to preserve an older layout.
