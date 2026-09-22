import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { STORAGE_MIGRATIONS, parseCliArgs, type Profile } from "../server.js";

const profileInput = {
  slug: "sidekick",
  name: "Release Sidekick",
  description: "Handles one release task.",
  instructions: "Inspect the release and report concrete blockers.",
  providerId: "codex",
  model: "gpt-5.3-codex",
  reasoningLevel: "high" as const,
  serviceTier: "fast" as const,
  permissionMode: "accept-edits" as const,
  skills: ["research", "reporting"],
};

describe("Sidekick backend", () => {
  it("registers the v1 surfaces with an empty profile store and no background work", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "sidekick", agentSkillIds: ["sidekick"] });
    await plugin(bb);
    expect(await harness.behavior.callRpc("profiles.list", null)).toEqual({ profiles: [] });
    expect(harness.inspection.registrations.cli).toMatchObject({ name: "sidekick" });
    expect(harness.inspection.registrations.settingsDescriptors.sharedInstructions).toMatchObject({
      type: "string",
      label: "Instructions for all agents",
      default: "",
      experimental_multiline: true,
    });
    expect(harness.inspection.registrations.rpcMethods).toEqual([
      "profiles.list",
      "profiles.create",
      "profiles.update",
      "profiles.delete",
      "profiles.spawn",
      "projects.list",
      "skills.list",
      "execution.default",
    ]);
    expect(harness.inspection.registrations.services).toEqual([]);
    expect(harness.inspection.registrations.schedules).toEqual([]);
    expect(harness.inspection.registrations.agentTools).toEqual([]);
    expect(harness.inspection.registrations.agentConfigurationProvider).not.toBeNull();
    await harness.lifecycle.dispose();
  });

  it("returns live execution defaults and a deduplicated skill catalog", async () => {
    const projects = [{ id: "proj_personal", name: "Personal", kind: "personal" }];
    const providers = [{
      id: "pi",
      displayName: "Pi",
      available: true,
      capabilities: {
        permissionModes: ["full"],
        supportsServiceTier: false,
      },
    }];
    const models = [{
      model: "openai-codex/gpt-5.5",
      isDefault: true,
      defaultReasoningEffort: "medium",
    }];
    const { bb, harness } = createFakePluginHost({
      pluginId: "sidekick",
      sdk: {
        projects: { list: async () => projects as never },
        skills: {
          list: async () => ({ skills: [
            { name: "research", description: "Research evidence." },
            { name: "research", description: "Duplicate provider copy." },
            { name: "reporting", description: "R".repeat(600) },
            { name: "data-analytics:build-report", description: "Build a report." },
          ] }) as never,
        },
        system: {
          executionOptions: async () => ({ providers, models, permissionCeiling: "full" }) as never,
        },
      },
    });
    await plugin(bb);
    expect(await harness.behavior.callRpc("execution.default", null)).toEqual({
      providerId: "pi",
      model: "openai-codex/gpt-5.5",
      reasoningLevel: "medium",
      serviceTier: null,
      permissionMode: "full",
    });
    expect(await harness.behavior.callRpc("skills.list", null)).toEqual({
      skills: [
        { name: "data-analytics:build-report", description: "Build a report." },
        { name: "reporting", description: "R".repeat(500) },
        { name: "research", description: "Research evidence." },
      ],
    });
    expect(harness.inspection.sdk.callsTo("system.executionOptions")).toHaveLength(2);
    await harness.lifecycle.dispose();
  });

  it("persists profile CRUD across reloads using append-only migrations", async () => {
    const first = createFakePluginHost({ pluginId: "sidekick" });
    await plugin(first.bb);
    const created = await first.harness.behavior.callRpc("profiles.create", profileInput) as Profile;
    expect(created).toMatchObject(profileInput);
    const updated = await first.harness.behavior.callRpc("profiles.update", {
      id: created.id,
      name: "Updated Sidekick",
      providerId: null,
      model: null,
      serviceTier: null,
      skills: [],
    }) as Profile;
    expect(updated).toMatchObject({ name: "Updated Sidekick", providerId: null, model: null, serviceTier: null, skills: [] });

    const reloaded = await first.harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.behavior.callRpc("profiles.list", null)).toMatchObject({
      profiles: [{ id: created.id, name: "Updated Sidekick" }],
    });
    await reloaded.harness.behavior.callRpc("profiles.delete", { id: created.id });
    expect(await reloaded.harness.behavior.callRpc("profiles.list", null)).toEqual({ profiles: [] });
    await reloaded.harness.lifecycle.dispose();

    expect(STORAGE_MIGRATIONS).toHaveLength(4);
    expect(STORAGE_MIGRATIONS[0]).toContain("CREATE TABLE IF NOT EXISTS sidekick_profiles");
    expect(STORAGE_MIGRATIONS[1]).toContain("sidekick_profiles_sort_idx");
    expect(STORAGE_MIGRATIONS[2]).toContain("instructions = instructions");
    expect(STORAGE_MIGRATIONS[2]).toContain("behavior = ''");
    expect(STORAGE_MIGRATIONS[3]).toContain("ADD COLUMN service_tier");
  });

  it("spawns exactly one thread with profile defaults and Sidekick-owned metadata", async () => {
    const spawned = makeThreadResponse({ id: "thr_sidekick", projectId: "proj_explicit", title: "Release" });
    const { bb, harness } = createFakePluginHost({
      pluginId: "sidekick",
      sdk: { threads: { spawn: async () => spawned } },
    });
    await plugin(bb);
    const profile = await harness.behavior.callRpc("profiles.create", profileInput) as Profile;
    expect(await harness.behavior.callRpc("profiles.spawn", {
      profile: profile.slug,
      prompt: "Review the release",
      projectId: "proj_explicit",
      title: "Release review",
    })).toEqual({ threadId: "thr_sidekick" });

    const calls = harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({
      projectId: "proj_explicit",
      environment: { type: "project-default" },
      prompt: "Review the release",
      title: "Release review",
      visibility: "visible",
      providerId: "codex",
      model: "gpt-5.3-codex",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
        permissionMode: "explicit",
      },
      pluginMetadata: {
        schemaVersion: 1,
        profileId: profile.id,
        profileSlug: "sidekick",
        profileName: "Release Sidekick",
        skills: ["research", "reporting"],
        source: "sidekick",
      },
      origin: "plugin",
      originPluginId: "sidekick",
    });
    expect(harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("layers shared settings before profile instructions and tracks settings changes", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "sidekick",
      agentSkillIds: ["sidekick"],
      settings: { sharedInstructions: "Follow the shared release policy." },
    });
    await plugin(bb);
    const profile = await harness.behavior.callRpc("profiles.create", profileInput) as Profile;
    const context = makePluginAgentConfigurationContext({
      pluginMetadata: {
        schemaVersion: 1,
        source: "sidekick",
        profileId: profile.id,
        profileSlug: profile.slug,
      },
    });
    const selected = await harness.behavior.resolveAgentConfiguration(context);
    expect(selected.tools).toEqual([]);
    expect(selected.skills).toEqual([]);
    expect(selected.instructions).toContain("# Instructions for all Sidekick agents\nFollow the shared release policy.");
    expect(selected.instructions).toContain("Inspect the release and report concrete blockers.");
    expect(selected.instructions).not.toContain("Behavior defaults");
    expect(selected.instructions).toContain('["research","reporting"]');
    expect(selected.instructions!.indexOf("Follow the shared release policy.")).toBeLessThan(
      selected.instructions!.indexOf("## Agent instructions"),
    );

    await harness.behavior.setSettings({ sharedInstructions: "Use the updated shared policy." });
    const updated = await harness.behavior.resolveAgentConfiguration(context);
    expect(updated.instructions).toContain("Use the updated shared policy.");
    expect(updated.instructions).not.toContain("Follow the shared release policy.");
    await harness.behavior.setSettings({ sharedInstructions: "x".repeat(4_096) });
    await expect(harness.behavior.setSettings({ sharedInstructions: "x".repeat(4_097) })).rejects.toThrow(
      "at most 4096 characters",
    );

    const unrelated = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      pluginMetadata: { profileId: profile.id, profileSlug: profile.slug },
    }));
    expect(unrelated).toMatchObject({ tools: [], skills: [], instructions: null });
    await harness.lifecycle.dispose();
  });

  it("accepts 4,096 profile instruction characters but rejects 4,097", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "sidekick" });
    await plugin(bb);
    const profile = await harness.behavior.callRpc("profiles.create", {
      ...profileInput,
      instructions: "a".repeat(4_096),
    }) as Profile;
    expect(profile.instructions).toHaveLength(4_096);
    await expect(harness.behavior.callRpc("profiles.create", {
      ...profileInput,
      slug: "too-long",
      instructions: "a".repeat(4_097),
    })).rejects.toThrow();
    await expect(harness.behavior.callRpc("profiles.update", {
      id: profile.id,
      instructions: "a".repeat(4_097),
    })).rejects.toThrow();
    await harness.lifecycle.dispose();
  });

  it("requires an explicit CLI project even when invocation context has one", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "sidekick",
      sdk: { threads: { spawn: async () => makeThreadResponse({ id: "thr_never" }) } },
    });
    await plugin(bb);
    await harness.behavior.callRpc("profiles.create", profileInput);
    const result = await harness.behavior.runCli(
      ["spawn", "sidekick", "--prompt", "Do it"],
      { projectId: "proj_context", threadId: "thr_parent", signal: new AbortController().signal },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--project is required");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("supports automation-friendly create/spawn parsing and optional wait", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "sidekick",
      sdk: {
        threads: {
          spawn: async () => makeThreadResponse({ id: "thr_wait", projectId: "proj_cli" }),
          wait: async () => ({
            matched: true as const,
            target: { kind: "status" as const, status: "idle" as const },
            threadId: "thr_wait",
            thread: makeThreadResponse({ id: "thr_wait", status: "idle" }),
          }),
          output: async () => ({ output: "done" }),
        },
      },
    });
    await plugin(bb);
    const created = await harness.behavior.runCli([
      "create",
      "--slug=sidekick",
      "--name", "Release Sidekick",
      "--instructions", "Do one thing well.",
      "--skills", "research, reporting",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).skills).toEqual(["research", "reporting"]);

    const run = await harness.behavior.runCli([
      "spawn", "sidekick",
      "--prompt", "Ship it",
      "--project", "proj_cli",
      "--title", "CLI title",
      "--wait",
      "--json",
    ]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ threadId: "thr_wait", output: "done" });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.output")).toHaveLength(1);

    const help = await harness.behavior.runCli(["help"]);
    expect(help.stdout).toContain("bb sidekick spawn <agent> --prompt <task> --project <projectId>");
    expect(help.stdout).toContain("creates exactly one visible BB thread");
    expect(help.stdout).not.toContain("team");
    expect(help.stdout).not.toContain("workflow");
    await harness.lifecycle.dispose();
  });

  it("parses flags deterministically and rejects duplicate options", () => {
    expect(parseCliArgs(["spawn", "sidekick", "--project=proj_1", "--wait"])).toEqual({
      positional: ["spawn", "sidekick"],
      flags: new Map<string, string | true>([["project", "proj_1"], ["wait", true]]),
    });
    expect(() => parseCliArgs(["list", "--json", "--json"])).toThrow("may only be passed once");
    expect(() => parseCliArgs(["spawn", "--prompt"])).toThrow("requires a value");
  });

  it("imports only public SDK surfaces", async () => {
    const result = await experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname, {
      allow: [/^react(?:-dom)?$/u, /^sonner$/u, /^@hugeicons\//u, /^@radix-ui\//u, /^@\//u, /^clsx$/u, /^tailwind-merge$/u, /^class-variance-authority$/u, /^better-sqlite3$/u, /^@testing-library\//u, /^vitest(?:\/config)?$/u],
    });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
