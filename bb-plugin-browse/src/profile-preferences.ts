import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Called under the managed profile lock, before Chrome opens the profile. */
export async function configureProfilePreferences(profile: string) {
  const directory = join(profile, "Default");
  const path = join(directory, "Preferences");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(await fs.readFile(path, "utf8"));
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs))
      throw new Error("Invalid Chrome preferences object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const group = (name: string) => {
    const value = prefs[name];
    if (
      value !== undefined &&
      (!value || typeof value !== "object" || Array.isArray(value))
    )
      throw new Error(`Invalid Chrome ${name} preferences`);
    return (prefs[name] ??= {}) as Record<string, unknown>;
  };
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  prefs.credentials_enable_passkeys = false;
  prefs.credentials_enable_automatic_passkey_upgrades = false;
  // Saving=false alone still permits filling. Chromium's URL blocklist disables
  // password management (including filling) for every site, without deleting data.
  group("password_manager").password_manager_blocklist = ["*"];
  Object.assign(group("autofill"), {
    profile_enabled: false,
    credit_card_enabled: false,
    other_datatypes_enabled: false,
    payment_cvc_storage: false,
  });
  const temporary = join(directory, `.browse-preferences-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, JSON.stringify(prefs), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
