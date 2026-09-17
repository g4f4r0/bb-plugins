# Reserve

Leftover agent usage and resets, from the sidebar footer.

Reserve sits next to Beacon. Open it for unique login windows across enrolled machines, with the shared machine list shown once. The same account on server and pro is one leftover, not two added together.

Codex can offer banked resets from the Codex CLI on this BB server. Grok shows the weekly pool reset time. Extra Grok credits are bought in Grok settings; Reserve does not purchase them.

Needs BB 0.43 and Plugin SDK 0.4.87. Not published.

## Install

On this server:

```sh
bb plugin install path:/home/g4f4r0/projects/bb-plugins/bb-plugin-reserve --yes
bb plugin reload reserve
```

Reload after a source change:

```sh
bb plugin build bb-plugin-reserve
bb plugin reload reserve
```

## What the numbers mean

Leftover windows come from BB `usageLimits` on each host. Two connected machines signed into the same email share that row. The meter is used percent (green below 80, amber from 80, red from 95).

When the Codex CLI on this BB server is signed in, Reserve matches that account email to a BB Codex login and adds every pool the CLI reports (missing 5-hour, Luna Reserve, Spark, and banked resets). Overlapping labels keep the BB numbers. If the CLI is missing, slow, or the email does not match, the popover stays BB-only and Use reset is hidden. Claude and Cursor have no leftover-pool CLI, so those rows stay on BB.

The Machines section lists the enrolled fleet once. Disconnected hosts show no windows. More than 50 display rows use a measured virtual list, including large sets of windows within one login.

Codex reset consume talks to the Codex app-server on the BB server, not on pro or neo. Confirm before it spends a credit.

Polling runs only while the popover and page are visible and the browser is online. Plugin startup restores the last snapshot without fetching. Snapshots below 250 KB are kept across launches; larger fleets use one in-memory snapshot. Usage reads share one server fetch with an eight-host concurrency cap and a 15-second fleet deadline. Failed refreshes back off to 60 seconds. Reload cancels reads and CLI probes; a reset already sent is never automatically replayed.
