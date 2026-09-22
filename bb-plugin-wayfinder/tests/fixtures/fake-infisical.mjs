#!/usr/bin/env node
// Test-only stand-in for the Infisical CLI. Controlled entirely by env vars
// so tests never touch a real Infisical project.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args[0];
const fail = process.env.FAKE_INFISICAL_FAIL === "1";
const secrets = JSON.parse(process.env.FAKE_INFISICAL_SECRETS ?? "{}");

if (mode === "run") {
  if (fail) process.exit(1);
  const sep = args.indexOf("--");
  const cmd = args.slice(sep + 1);
  const child = spawnSync(cmd[0], cmd.slice(1), { stdio: ["ignore", "inherit", "ignore"], env: { ...process.env, ...secrets } });
  process.exit(child.status ?? 1);
}

if (mode === "secrets" && args[1] === "set") {
  if (fail) process.exit(1);
  const assignment = args[2] ?? "";
  const eq = assignment.indexOf("=@");
  if (eq === -1) process.exit(1);
  // Reads the temp file the same way the real CLI would; proves the caller
  // wrote a private file rather than passing the value as a CLI argument.
  readFileSync(assignment.slice(eq + 2), "utf8");
  if (process.env.FAKE_INFISICAL_CAPTURE) {
    writeFileSync(process.env.FAKE_INFISICAL_CAPTURE, JSON.stringify({ args, filePath: assignment.slice(eq + 2) }));
  }
  process.exit(0);
}

process.exit(1);
