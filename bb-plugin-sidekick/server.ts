import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  PERMISSION_MODES,
  PROFILE_SLUG_RE,
  PROFILES_CHANGED,
  REASONING_LEVELS,
  SKILL_NAME_RE,
  parseSkillNames,
} from "./shared.js";

const slugSchema = z.string().regex(PROFILE_SLUG_RE, "use lowercase letters, digits, and dashes; maximum 40 characters");
const skillNameSchema = z.string().regex(SKILL_NAME_RE, "use lowercase letters, digits, and dashes; maximum 64 characters");

const profileInputShape = {
  slug: slugSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  instructions: z.string().trim().min(1).max(2_800),
  providerId: z.string().trim().min(1).max(100).nullable().default(null),
  model: z.string().trim().min(1).max(200).nullable().default(null),
  reasoningLevel: z.enum(REASONING_LEVELS).nullable().default(null),
  permissionMode: z.enum(PERMISSION_MODES).nullable().default(null),
  skills: z.array(skillNameSchema).max(12).default([]),
  behavior: z.string().trim().max(600).default(""),
};

export const profileInputSchema = z
  .object(profileInputShape)
  .strict()
  .superRefine((profile, context) => {
    if ((profile.providerId === null) !== (profile.model === null)) {
      context.addIssue({
        code: "custom",
        path: [profile.providerId === null ? "providerId" : "model"],
        message: "providerId and model must both be set or both inherit",
      });
    }
    if (new Set(profile.skills).size !== profile.skills.length) {
      context.addIssue({ code: "custom", path: ["skills"], message: "skill names must be unique" });
    }
  });

export const profileSchema = z.object({
  id: z.string(),
  ...profileInputShape,
  sortOrder: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Profile = z.infer<typeof profileSchema>;

const profilePatchSchema = z
  .object({
    id: z.string().min(1),
    slug: slugSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    instructions: z.string().trim().min(1).max(2_800).optional(),
    providerId: z.string().trim().min(1).max(100).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    reasoningLevel: z.enum(REASONING_LEVELS).nullable().optional(),
    permissionMode: z.enum(PERMISSION_MODES).nullable().optional(),
    skills: z.array(skillNameSchema).max(12).optional(),
    behavior: z.string().trim().max(600).optional(),
  })
  .strict();

const spawnInputSchema = z
  .object({
    profile: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(50_000),
    projectId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const projectSchema = z.object({ id: z.string(), name: z.string() }).strict();
const okSchema = z.object({ ok: z.literal(true) }).strict();

export const rpcContract = defineRpcContract({
  "profiles.list": { input: z.null(), output: z.object({ profiles: z.array(profileSchema) }).strict() },
  "profiles.create": { input: profileInputSchema, output: profileSchema },
  "profiles.update": { input: profilePatchSchema, output: profileSchema },
  "profiles.delete": { input: z.object({ id: z.string().min(1) }).strict(), output: okSchema },
  "profiles.spawn": { input: spawnInputSchema, output: z.object({ threadId: z.string() }).strict() },
  "projects.list": { input: z.null(), output: z.object({ projects: z.array(projectSchema) }).strict() },
});

/** Migration indexes are durable IDs. Never edit or reorder shipped entries; append only. */
export const STORAGE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS sidekick_profiles (
     id TEXT PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     instructions TEXT NOT NULL,
     provider_id TEXT,
     model TEXT,
     reasoning_level TEXT,
     permission_mode TEXT,
     skills_json TEXT NOT NULL DEFAULT '[]',
     behavior TEXT NOT NULL DEFAULT '',
     sort_order INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sidekick_profiles_sort_idx
     ON sidekick_profiles(sort_order, created_at)`,
] as const;

interface ProfileRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  provider_id: string | null;
  model: string | null;
  reasoning_level: string | null;
  permission_mode: string | null;
  skills_json: string;
  behavior: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

function renderProfileInstructions(profile: Profile): string {
  const sections = [
    "# Sidekick profile",
    `Profile name (data): ${JSON.stringify(profile.name)}`,
    profile.description ? `Profile description (data): ${JSON.stringify(profile.description)}` : "",
    profile.skills.length > 0
      ? `Preferred skills (data): ${JSON.stringify(profile.skills)}. Apply these named skills when they are available in this session; do not claim unavailable skills were loaded.`
      : "",
    "",
    "## Profile instructions",
    profile.instructions,
    profile.behavior ? "\n## Behavior defaults\n" + profile.behavior : "",
  ].filter((line) => line !== "");
  const rendered = sections.join("\n");
  return rendered.length <= 4_000 ? rendered : rendered.slice(0, 3_980) + "\n[…truncated]";
}

export interface ParsedCliArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["json", "wait"]);

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const raw = argument.slice(2);
    const separator = raw.indexOf("=");
    const key = separator === -1 ? raw : raw.slice(0, separator);
    if (!key) throw new Error("empty flag name");
    if (flags.has(key)) throw new Error(`--${key} may only be passed once`);
    if (BOOLEAN_FLAGS.has(key)) {
      if (separator !== -1) throw new Error(`--${key} does not take a value`);
      flags.set(key, true);
      continue;
    }
    const value = separator === -1 ? argv[index + 1] : raw.slice(separator + 1);
    if (value === undefined || (separator === -1 && value.startsWith("--"))) {
      throw new Error(`--${key} requires a value`);
    }
    flags.set(key, value);
    if (separator === -1) index += 1;
  }
  return { positional, flags };
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...STORAGE_MIGRATIONS]);

  const statements = {
    list: db.prepare("SELECT * FROM sidekick_profiles ORDER BY sort_order, created_at"),
    get: db.prepare("SELECT * FROM sidekick_profiles WHERE id = ?"),
    bySlug: db.prepare("SELECT * FROM sidekick_profiles WHERE slug = ?"),
    maxSort: db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM sidekick_profiles"),
    insert: db.prepare(`INSERT INTO sidekick_profiles
      (id, slug, name, description, instructions, provider_id, model, reasoning_level, permission_mode, skills_json, behavior, sort_order, created_at, updated_at)
      VALUES (@id, @slug, @name, @description, @instructions, @providerId, @model, @reasoningLevel, @permissionMode, @skillsJson, @behavior, @sortOrder, @now, @now)`),
    update: db.prepare(`UPDATE sidekick_profiles SET
      slug=@slug, name=@name, description=@description, instructions=@instructions,
      provider_id=@providerId, model=@model, reasoning_level=@reasoningLevel,
      permission_mode=@permissionMode, skills_json=@skillsJson, behavior=@behavior,
      updated_at=@now WHERE id=@id`),
    remove: db.prepare("DELETE FROM sidekick_profiles WHERE id = ?"),
  };

  const toProfile = (row: ProfileRow): Profile => profileSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    providerId: row.provider_id,
    model: row.model,
    reasoningLevel: row.reasoning_level,
    permissionMode: row.permission_mode,
    skills: JSON.parse(row.skills_json) as unknown,
    behavior: row.behavior,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const listProfiles = (): Profile[] => (statements.list.all() as ProfileRow[]).map(toProfile);
  const getProfile = (id: string): Profile | null => {
    const row = statements.get.get(id) as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  };
  const profileBySlug = (slug: string): Profile | null => {
    const row = statements.bySlug.get(slug) as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  };
  const findProfile = (reference: string): Profile | null => {
    const normalized = reference.trim();
    return profileBySlug(normalized)
      ?? getProfile(normalized)
      ?? listProfiles().find((profile) => profile.name.toLowerCase() === normalized.toLowerCase())
      ?? null;
  };
  const publishProfiles = () => bb.realtime.publish(PROFILES_CHANGED, { at: Date.now() });

  const createProfile = (raw: z.input<typeof profileInputSchema>): Profile => {
    const input = profileInputSchema.parse(raw);
    if (profileBySlug(input.slug)) throw new Error(`Profile slug "${input.slug}" already exists`);
    const id = `profile_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const { value } = statements.maxSort.get() as { value: number };
    statements.insert.run({ ...input, id, skillsJson: JSON.stringify(input.skills), sortOrder: value + 1, now: Date.now() });
    publishProfiles();
    return getProfile(id)!;
  };

  const updateProfile = (id: string, patch: Omit<z.infer<typeof profilePatchSchema>, "id">): Profile => {
    const current = getProfile(id);
    if (!current) throw new Error(`No profile with id ${id}`);
    const { id: _id, sortOrder: _sortOrder, createdAt: _createdAt, updatedAt: _updatedAt, ...currentInput } = current;
    const input = profileInputSchema.parse({ ...currentInput, ...patch });
    const conflict = profileBySlug(input.slug);
    if (conflict && conflict.id !== id) throw new Error(`Profile slug "${input.slug}" already exists`);
    statements.update.run({ ...input, id, skillsJson: JSON.stringify(input.skills), now: Date.now() });
    publishProfiles();
    return getProfile(id)!;
  };

  const deleteProfile = (id: string): void => {
    if (statements.remove.run(id).changes === 0) throw new Error(`No profile with id ${id}`);
    publishProfiles();
  };

  const spawnProfile = async (raw: z.input<typeof spawnInputSchema>): Promise<string> => {
    const input = spawnInputSchema.parse(raw);
    const profile = findProfile(input.profile);
    if (!profile) throw new Error(`No profile "${input.profile}". Run "bb sidekick list".`);
    const executionInputSources: Record<string, "explicit"> = {};
    const executionDefaults: {
      providerId?: string;
      model?: string;
      reasoningLevel?: (typeof REASONING_LEVELS)[number];
      permissionMode?: (typeof PERMISSION_MODES)[number];
      executionInputSources?: Record<string, "explicit">;
    } = {};
    if (profile.providerId && profile.model) {
      executionDefaults.providerId = profile.providerId;
      executionDefaults.model = profile.model;
      executionInputSources.providerId = "explicit";
      executionInputSources.model = "explicit";
    }
    if (profile.reasoningLevel) {
      executionDefaults.reasoningLevel = profile.reasoningLevel;
      executionInputSources.reasoningLevel = "explicit";
    }
    if (profile.permissionMode) {
      executionDefaults.permissionMode = profile.permissionMode;
      executionInputSources.permissionMode = "explicit";
    }
    if (Object.keys(executionInputSources).length > 0) executionDefaults.executionInputSources = executionInputSources;
    const firstLine = input.prompt.split("\n").find((line) => line.trim())?.trim() ?? "Task";
    const thread = await bb.sdk.threads.spawn({
      projectId: input.projectId,
      environment: { type: "project-default" },
      prompt: input.prompt,
      title: input.title ?? `[${profile.name}] ${firstLine.slice(0, 80)}`,
      visibility: "visible",
      ...executionDefaults,
      pluginMetadata: {
        schemaVersion: 1,
        profileId: profile.id,
        profileSlug: profile.slug,
        profileName: profile.name,
        skills: profile.skills,
        source: "sidekick",
      },
    });
    return thread.id;
  };

  bb.agents.configure((context) => {
    const metadata = context.pluginMetadata;
    if (metadata.schemaVersion !== 1 || metadata.source !== "sidekick") return { tools: [], skills: [] };
    if (typeof metadata.profileId !== "string" || typeof metadata.profileSlug !== "string") return { tools: [], skills: [] };
    const profile = getProfile(metadata.profileId);
    if (!profile || profile.slug !== metadata.profileSlug) return { tools: [], skills: [] };
    return { tools: [], skills: [], instructions: renderProfileInstructions(profile) };
  });

  bb.rpc.register(rpcContract, {
    "profiles.list": () => ({ profiles: listProfiles() }),
    "profiles.create": (input) => createProfile(input),
    "profiles.update": ({ id, ...patch }) => updateProfile(id, patch),
    "profiles.delete": ({ id }) => { deleteProfile(id); return { ok: true as const }; },
    "profiles.spawn": async (input) => ({ threadId: await spawnProfile(input) }),
    "projects.list": async () => {
      const projects = await bb.sdk.projects.list();
      return { projects: projects.map(({ id, name }) => ({ id, name })) };
    },
  });

  const usage = [
    "Usage:",
    "  bb sidekick list [--json]",
    "  bb sidekick show <profile> [--json]",
    "  bb sidekick create --slug <slug> --name <name> --instructions <text> [profile defaults] [--json]",
    "  bb sidekick update <profile> [profile fields] [--json]",
    "  bb sidekick delete <profile> [--json]",
    "  bb sidekick spawn <profile> --prompt <task> --project <projectId> [--title <title>] [--wait] [--json]",
    "",
    "Profile defaults:",
    "  --description <text> --provider <id|inherit> --model <id|inherit>",
    "  --reasoning <level|inherit> --permission <mode|inherit>",
    "  --skills <comma-separated names> --behavior <text>",
    "",
    "Spawn always requires --project and creates exactly one visible BB thread.",
  ].join("\n");

  const allowedByCommand: Record<string, Set<string>> = {
    list: new Set(["json"]),
    show: new Set(["json"]),
    create: new Set(["slug", "name", "description", "instructions", "provider", "model", "reasoning", "permission", "skills", "behavior", "json"]),
    update: new Set(["slug", "name", "description", "instructions", "provider", "model", "reasoning", "permission", "skills", "behavior", "json"]),
    delete: new Set(["json"]),
    spawn: new Set(["prompt", "project", "title", "wait", "json"]),
  };
  const asString = (value: string | true | undefined): string | undefined => typeof value === "string" ? value : undefined;
  const nullableDefault = (value: string | undefined): string | null | undefined => value === undefined ? undefined : value === "inherit" ? null : value;
  const print = (json: boolean, value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : text });
  const fail = (message: string) => ({ exitCode: 1, stderr: message });
  const assertFlags = (command: string, flags: Map<string, string | true>) => {
    const allowed = allowedByCommand[command];
    for (const key of flags.keys()) if (!allowed?.has(key)) throw new Error(`Unknown option for ${command}: --${key}`);
  };
  const profileFields = (flags: Map<string, string | true>, requireAll: boolean): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    const direct = ["slug", "name", "description", "instructions", "behavior"] as const;
    for (const key of direct) {
      const value = asString(flags.get(key));
      if (value !== undefined) result[key] = value;
    }
    const provider = nullableDefault(asString(flags.get("provider")));
    const model = nullableDefault(asString(flags.get("model")));
    const reasoningLevel = nullableDefault(asString(flags.get("reasoning")));
    const permissionMode = nullableDefault(asString(flags.get("permission")));
    if (provider !== undefined) result.providerId = provider;
    if (model !== undefined) result.model = model;
    if (reasoningLevel !== undefined) result.reasoningLevel = reasoningLevel;
    if (permissionMode !== undefined) result.permissionMode = permissionMode;
    const skills = asString(flags.get("skills"));
    if (skills !== undefined) result.skills = parseSkillNames(skills);
    if (requireAll) {
      for (const key of ["slug", "name", "instructions"]) if (!(key in result)) throw new Error(`--${key} is required`);
      result.description ??= "";
      result.providerId ??= null;
      result.model ??= null;
      result.reasoningLevel ??= null;
      result.permissionMode ??= null;
      result.skills ??= [];
      result.behavior ??= "";
    }
    return result;
  };

  bb.cli.register({
    name: "sidekick",
    summary: "Manage reusable Sidekick profiles and start one profile-bound thread",
    commands: [
      { name: "list", summary: "List Sidekick profiles", usage: "bb sidekick list [--json]" },
      { name: "show", summary: "Show one Sidekick profile", usage: "bb sidekick show <profile> [--json]" },
      { name: "create", summary: "Create a Sidekick profile", usage: "bb sidekick create --slug <slug> --name <name> --instructions <text> [profile defaults] [--json]" },
      { name: "update", summary: "Update a Sidekick profile", usage: "bb sidekick update <profile> [profile fields] [--json]" },
      { name: "delete", summary: "Delete a Sidekick profile", usage: "bb sidekick delete <profile> [--json]" },
      { name: "spawn", summary: "Start exactly one profile-bound thread in an explicit project", usage: "bb sidekick spawn <profile> --prompt <task> --project <projectId> [--title <title>] [--wait] [--json]" },
    ],
    async run(argv, context) {
      try {
        const { positional, flags } = parseCliArgs(argv);
        const [command, reference, ...extra] = positional;
        if (command === undefined || command === "help") return { exitCode: 0, stdout: usage };
        if (!(command in allowedByCommand)) return fail(`Unknown command "${command}".\n\n${usage}`);
        assertFlags(command, flags);
        if (extra.length > 0) return fail(`Unexpected arguments: ${extra.join(" ")}`);
        const json = flags.has("json");
        if (command === "list") {
          if (reference) return fail(`Unexpected argument: ${reference}`);
          const profiles = listProfiles();
          const text = profiles.length === 0
            ? "No Sidekick profiles."
            : profiles.map((profile) => `${profile.slug.padEnd(16)} ${profile.name}`).join("\n");
          return print(json, profiles, text);
        }
        if (command === "show") {
          if (!reference) return fail("Profile is required");
          const profile = findProfile(reference);
          if (!profile) return fail(`No profile "${reference}".`);
          const text = `${profile.name} (${profile.slug})\n${profile.description}\nprovider/model: ${profile.providerId ?? "inherit"}/${profile.model ?? "inherit"}\nreasoning: ${profile.reasoningLevel ?? "inherit"}\npermission: ${profile.permissionMode ?? "inherit"}\nskills: ${profile.skills.join(", ") || "none"}\nbehavior: ${profile.behavior || "none"}\n\n${profile.instructions}`;
          return print(json, profile, text);
        }
        if (command === "create") {
          if (reference) return fail(`Unexpected argument: ${reference}`);
          const profile = createProfile(profileFields(flags, true) as z.input<typeof profileInputSchema>);
          return print(json, profile, `Created Sidekick profile ${profile.slug}.`);
        }
        if (command === "update") {
          if (!reference) return fail("Profile is required");
          const profile = findProfile(reference);
          if (!profile) return fail(`No profile "${reference}".`);
          const fields = profileFields(flags, false);
          if (Object.keys(fields).length === 0) return fail("Pass at least one profile field to update");
          const updated = updateProfile(profile.id, fields);
          return print(json, updated, `Updated Sidekick profile ${updated.slug}.`);
        }
        if (command === "delete") {
          if (!reference) return fail("Profile is required");
          const profile = findProfile(reference);
          if (!profile) return fail(`No profile "${reference}".`);
          deleteProfile(profile.id);
          return print(json, { deleted: profile.id }, `Deleted Sidekick profile ${profile.slug}.`);
        }
        if (command === "spawn") {
          if (!reference) return fail("Profile is required");
          const prompt = asString(flags.get("prompt"));
          const projectId = asString(flags.get("project"));
          if (!prompt) return fail("--prompt is required");
          if (!projectId) return fail("--project is required; Sidekick never infers a project from the current thread");
          const threadId = await spawnProfile({ profile: reference, prompt, projectId, title: asString(flags.get("title")) });
          if (flags.has("wait")) {
            await bb.sdk.threads.wait({ threadId, status: "idle", signal: context.signal });
            const { output } = await bb.sdk.threads.output({ threadId, signal: context.signal });
            return print(json, { threadId, output }, output ?? "");
          }
          return print(json, { threadId }, `Started Sidekick thread ${threadId}.`);
        }
        return fail(usage);
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  bb.log.info("Sidekick loaded with an empty-by-default profile store");
}
