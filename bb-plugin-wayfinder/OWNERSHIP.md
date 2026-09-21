# Step 2/3 edit boundaries

These boundaries apply while the execution-engine and UI/media tasks run in
parallel. The integration owner resolves dependency or contract changes after
both return.

## Execution engine owner

- `worker/`
- `src/core/`
- `src/adapters/`
- `src/policy/`
- `src/fs/`
- `tests/engine/`
- `tests/adapters/`
- `tests/policy/`
- `tests/fs/`

## UI and media owner

- `app.tsx`
- `app.css`
- `components/`
- `src/media/`
- `src/artifacts/`
- `tests/ui/`
- `tests/media/`
- `tests/artifacts/`

## Integration owner only until fan-in

- `src/contracts/`
- `package.json` and `package-lock.json`
- `server.ts` and `host.ts`
- `IMPLEMENTATION.md`
- `.bb/plugins.json`

The engine and UI/media owners must not edit the integration-owned files.
They report required contract or dependency changes for the integration phase.
The foundation `server.ts` and `host.ts` are labeled stubs and must not be
installed, reloaded, or presented as working execution.
