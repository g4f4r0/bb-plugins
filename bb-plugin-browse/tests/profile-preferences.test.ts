import { afterEach, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProfilePreferences } from "../src/profile-preferences";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "browse-prefs-"));
  roots.push(root);
  await fs.mkdir(join(root, "Default"));
  return { root, path: join(root, "Default", "Preferences") };
}
test("disables prompts and filling on new and reconnected profiles without losing preferences", async () => {
  const { root, path } = await fixture();
  await configureProfilePreferences(root);
  let prefs = JSON.parse(await fs.readFile(path, "utf8"));
  expect(prefs.password_manager.password_manager_blocklist).toEqual(["*"]);
  expect(prefs.autofill.profile_enabled).toBe(false);
  expect(prefs.autofill.credit_card_enabled).toBe(false);
  prefs.credentials_enable_service = true;
  prefs.autofill.profile_enabled = true;
  prefs.autofill.unrelated = "keep";
  prefs.content_settings = { untouched: true };
  await fs.writeFile(path, JSON.stringify(prefs));
  await configureProfilePreferences(root);
  prefs = JSON.parse(await fs.readFile(path, "utf8"));
  expect(prefs.credentials_enable_service).toBe(false);
  expect(prefs.credentials_enable_autosignin).toBe(false);
  expect(prefs.autofill.profile_enabled).toBe(false);
  expect(prefs.autofill.unrelated).toBe("keep");
  expect(prefs.content_settings).toEqual({ untouched: true });
  expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
});
test("refuses to overwrite malformed existing preferences", async () => {
  const { root, path } = await fixture();
  for (const value of [
    "{bad",
    "null",
    "[]",
    '{"autofill":true}',
  ]) {
    await fs.writeFile(path, value);
    await expect(configureProfilePreferences(root)).rejects.toThrow();
    expect(await fs.readFile(path, "utf8")).toBe(value);
  }
});
