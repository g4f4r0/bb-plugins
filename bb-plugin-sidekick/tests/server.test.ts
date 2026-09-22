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
  permissionMode: "accept-edits" as const,
  skills: ["research", "reporting"],
  behavior: "Be concise and cite file paths.",
};

describe("Sidekick backend", () => {
  it("registers the v1 surfaces with an empty profile store and no background work", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "sidekick", agentSkillIds: ["sidekick"] });
    await plugin(bb);
    expect(await harness.behavior.callRpc("profiles.list", null)).toEqual({ profiles: [] });
    expect(harness.inspection.registrations.cli).toMatchObject({ name: "sidekick" });
    expect(harness.inspection.registrations.rpcMethods).toEqual([
      "profiles.list",
      "profiles.create",
      "profiles.update",
      "profiles.delete",
      "profiles.spawn",
      "projects.list",
    ]);
    expect(harness.inspection.registrations.services).toEqual([]);
    expect(harness.inspection.registrations.schedules).toEqual([]);
    expect(harness.inspection.registrations.agentTools).toEqual([]);
    expect(harness.inspection.registrations.agentConfigurationProvider).not.toBeNull();
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
      skills: [],
      behavior: "",
    }) as Profile;
    expect(updated).toMatchObject({ name: "Updated Sidekick", providerId: null, model: null, skills: [], behavior: "" });

    const reloaded = await first.harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.behavior.callRpc("profiles.list", null)).toMatchObject({
      profiles: [{ id: created.id, name: "Updated Sidekick" }],
    });
    await reloaded.harness.behavior.callRpc("profiles.delete", { id: created.id });
    expect(await reloaded.harness.behavior.callRpc("profiles.list", null)).toEqual({ profiles: [] });
    await reloaded.harness.lifecycle.dispose();

    expect(STORAGE_MIGRATIONS).toHaveLength(2);
    expect(STORAGE_MIGRATIONS[0]).toContain("CREATE TABLE IF NOT EXISTS sidekick_profiles");
    expect(STORAGE_MIGRATIONS[1]).toContain("sidekick_profiles_sort_idx");
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
      permissionMode: "accept-edits",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
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

  it("selects hidden instructions only for valid profile metadata", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "sidekick", agentSkillIds: ["sidekick"] });
    await plugin(bb);
    const profile = await harness.behavior.callRpc("profiles.create", profileInput) as Profile;
    const selected = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      pluginMetadata: {
        schemaVersion: 1,
        source: "sidekick",
        profileId: profile.id,
        profileSlug: profile.slug,
      },
    }));
    expect(selected.tools).toEqual([]);
    expect(selected.skills).toEqual([]);
    expect(selected.instructions).toContain("Inspect the release and report concrete blockers.");
    expect(selected.instructions).toContain("Behavior defaults");
    expect(selected.instructions).toContain('["research","reporting"]');

    const unrelated = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      pluginMetadata: { profileId: profile.id, profileSlug: profile.slug },
    }));
    expect(unrelated).toMatchObject({ tools: [], skills: [], instructions: null });
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
    expect(help.stdout).toContain("bb sidekick spawn <profile> --prompt <task> --project <projectId>");
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
