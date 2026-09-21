# Synthetic fixtures

These fixtures contain no account data and perform no external action.

- `browser/page.ts` (`FIXTURE_HTML`) is a deterministic local form used for browser/CDP
  adapter tests once a Fortress instance is available.
- `desktop/accessibility.json` is a synthetic accessibility observation used
  for native target-selection and stale-generation tests. It is not evidence
  that Cua can control a live Linux application on this host.
