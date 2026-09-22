export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
] as const;

export const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

export const PROFILE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const PROFILES_CHANGED = "profiles-changed";

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", є: "e", і: "i", ї: "i", ґ: "g",
};

export function slugifyProfileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[а-яёєіїґ]/gu, (character) => CYRILLIC[character] ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
}

export function parseSkillNames(value: string): string[] {
  const names = value
    .split(/[\s,]+/u)
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}
