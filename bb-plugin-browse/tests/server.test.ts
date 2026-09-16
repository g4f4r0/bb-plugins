import {controlRelay} from "../src/control-relay";
import {videoRelay} from "../src/video-relay";
import type {SelkiesStream} from "../src/selkies";
import { describe, it, expect, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
const base = {
  mode: "native",
  hostId: "host_pro",
  instanceId: "desktop",
  generation: "generation",
  threadId: "thread_one",
};
async function fixture(
  options: {
    relay?: {port:number;token:string};
    controlEndpoint?: {port:number;token:string};
    progressiveFrames?: boolean;
    frameData?: string;
    threadActive?: boolean;
    panelTabs?: any[];
    tabReadFails?: boolean;
    held?: boolean;
    personal?: boolean;
    connectFails?: boolean;
    connectJobFails?: boolean;
    executionHost?: string;
    busyOnce?: boolean;
    connectingOnce?: boolean;
    credentialFailure?: boolean;
    acquireFails?: boolean;
    closeFails?: boolean;
    generation?: string;
  } = {},
) {
  const paneAction = vi.fn(async () => ({ delivered: 1 })),
    release = vi.fn(async () => ({ ok: true })),
    close = vi.fn(async () => {
      if (options.closeFails) throw Error("Desktop disconnected");
      return { ok: true };
    }),
    create = vi.fn(async () => ({ tab: { tabId: "tab_new" } }));
  const calls: any[] = [];
  let inspected = 0, frameSequence=0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "browse",
    sdk: {
      threads: {
        tabs: { update: async (input: any) => { options.panelTabs = input.tabs; return { revision: 2, tabs: input.tabs }; }, get: async () => { if (options.tabReadFails) throw Error("offline"); return { revision: 1, tabs: options.panelTabs ?? [] }; } },
        get: async () => ({ environmentId: "env_thread", status: options.threadActive ? "active" : "idle" }) as any,
        paneAction,
      },
      environments: {
        get: async () =>
          ({ hostId: options.executionHost ?? "host_thread" }) as any,
      },
      hosts: {
        list: async () => [makeHostResponse({ id: "host_pro", name: "pro" })],
      },
      experimental_desktopBrowsers: {
        listInstances: async () => ({
          instances: [
            {
              ...base,
              generation: options.generation ?? base.generation,
              label: "Desktop",
            },
          ],
        }),
        listTabs: async () => ({
          tabs: [
            {
              tabId: "tab_existing",
              title: "Example",
              url: "https://example.com",
              profile: options.personal
                ? { kind: "personal" }
                : { kind: "automation", id: "profile" },
              control: options.held
                ? {
                    controllerLabel: "Another controller",
                    leaseId: "other",
                    expiresAt: Date.now() + 1000,
                  }
                : null,
              presentation: "reveal",
              threadId: base.threadId,
            },
          ],
        }),
        createTab: create,
        acquireControl: async (input) => {
          expect(input.ttlMs).toBeLessThanOrEqual(1800000);
          expect(input.generation).toBe(options.generation ?? base.generation);
          if (options.acquireFails) throw Error("Acquisition rejected");
          return {
            ...base,
            leaseId: "private-lease",
            tabIds: ["tab_new"],
            controllerLabel: "Browse",
            expiresAt: Date.now() + 1800000,
          };
        },
        openConnection: async () => ({
          hostId: base.hostId,
          wsEndpoint: "ws://127.0.0.1:1234/private-secret",
          expiresAt: Date.now() + 1800000,
        }),
        releaseControl: release,
        closeTab: close,
        revealTab: async () => ({ ok: true }),
      },
    },
    experimental_callHostRpc: async (call) => {
      calls.push(call);
      const input = call.input as any;
      if (call.method === "connect") {
        if (options.connectFails) throw new Error("Connection failed");
        return {
          id: "job_connect",
          sessionId: input.id,
          kind: "connect",
          status: "running",
          startedAt: Date.now(),
          durationMs: 0,
          artifacts: [],
        };
      }
      if (call.method === "job") return {
        id: input.id, kind:"connect", status:options.connectJobFails?"failed":"succeeded",
        startedAt:Date.now(),durationMs:1,artifacts:[],
        ...(options.connectJobFails?{error:"Browser connection was rejected by the scoped bridge"}:{})
      };
      if (call.method === "inspect" || call.method === "keepalive")
        return {
          ...(options.busyOnce && inspected++ === 0
            ? { busy: "finished-connect" }
            : {}),
          id: input.id,
          status: options.connectingOnce && calls.filter(c => c.method === "inspect").length === 1 ? "connecting" : "ready",
          ...(options.connectingOnce && calls.filter(c => c.method === "inspect").length === 1
            ? { url: "about:blank" }
            : {}),
          recording: false,
          artifactRoot: "/private/artifacts/session",
        };
      if (call.method === "frame")
        return {
          data: options.frameData ?? "qq",
          url: "https://example.com/",
          width: 1280,
          height: 800,
          seq: options.progressiveFrames ? ++frameSequence : input.after ? input.after : 1,
        };
      if (call.method === "submit" || call.method === "input")
        return {
          id: "job_run",
          sessionId: input.id,
          kind: "command",
          status: "succeeded",
          startedAt: Date.now(),
          durationMs: 1,
          artifacts: [],
        };
      if(call.method === "videoStart")return {ok:true,...(options.relay?{relay:options.relay}:{})};
      if(call.method === "videoStop")return {ok:true};
      if(call.method === "videoRead")return {packets:[Buffer.from([4,1,0,0,0,0,5,0,3,32,1]).toString('base64')],url:'https://example.com/',loading:false};
      if(call.method === "controlStart"){if(!options.controlEndpoint)throw Error("Unavailable on this host");return options.controlEndpoint;}
      if (call.method === "direct") return {selection:"selected"};
      if (call.method === "release") return { released: true };
      if (call.method === "credentialPrepare")
        return {
          token: "private-request",
          origin: "https://accounts.shopify.com",
        };
      if (call.method === "credentialCancel") return { cancelled: true };
      if (call.method === "credentialFill") {
        if (options.credentialFailure)
          throw Error("Downstream error containing dummy-secret");
        return { filled: true, count: input.values.length };
      }
      throw new Error(`Unexpected host method ${call.method}`);
    },
  });
  await plugin(bb);
  return { harness, release, close, create, calls, paneAction };
}
describe("BB browser lifecycle", () => {
  it("routes attachment to the selected browser host without exposing CDP credentials", async () => {
    const f = await fixture();
    const r: any = await f.harness.behavior.callRpc("start", {
      ...base,
      url: "https://example.com",
    });
    expect(f.calls.find((c) => c.method === "connect").hostId).toBe("host_pro");
    expect(JSON.stringify(r)).not.toContain("private-secret");
    expect(r.session.tabId).toBe("tab_new");
    await f.harness.lifecycle.dispose();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.close).not.toHaveBeenCalled();
  });
  it("releases control and removes the new tab after a failed host connection", async () => {
    const f = await fixture({ connectFails: true });
    await expect(
      f.harness.behavior.callRpc("start", {
        ...base,
        url: "https://example.com",
      }),
    ).rejects.toThrow("Connection failed");
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    await f.harness.lifecycle.dispose();
  });
  it("does not steal another controller’s tab", async () => {
    const f = await fixture({ held: true });
    await expect(
      f.harness.behavior.callRpc("start", { ...base, tabId: "tab_existing" }),
    ).rejects.toThrow("Another controller");
    expect(f.calls).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
  it("requires explicit personal tab handoff", async () => {
    const f = await fixture({ personal: true });
    await expect(
      f.harness.behavior.callRpc("start", { ...base, tabId: "tab_existing" }),
    ).rejects.toThrow("allowPersonal");
    await f.harness.lifecycle.dispose();
  });
  it("prevents an agent from acting on another thread’s session", async () => {
    const f = await fixture();
    const r: any = await f.harness.behavior.callRpc("start", { ...base });
    const result: any = await f.harness.behavior
      .callAgentTool(
        "browse_action",
        {
          id: r.session.id,
          operation: { kind: "command", args: ["snapshot", "-i"] },
        },
        { threadId: "other_thread" },
      )
      .catch((e) => e);
    expect(JSON.stringify(result) + String(result)).toMatch(/another thread/);
    await f.harness.lifecycle.dispose();
  });
  it("keeps released session history out of agent discovery", async () => {
    const f = await fixture();
    const released: any = await f.harness.behavior.callRpc("start", { ...base });
    await f.harness.behavior.callRpc("release", { id: released.session.id });
    const active: any = await f.harness.behavior.callRpc("start", { ...base });
    const discovered = JSON.parse(
      (await f.harness.behavior.callAgentTool(
        "browse_discover",
        {},
        { threadId: base.threadId },
      )) as string,
    );
    expect(discovered.sessions.map((session: any) => session.id)).toEqual([
      active.session.id,
    ]);
    expect(discovered.releasedSessionCount).toBe(1);
    await f.harness.lifecycle.dispose();
  });
  it("rejects invalid URLs before creating tabs", async () => {
    const f = await fixture();
    await expect(
      f.harness.behavior.callRpc("start", {
        ...base,
        url: "file:///etc/passwd",
      }),
    ).rejects.toThrow("https");
    expect(f.create).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
  it("returns actionable CLI validation errors", async () => {
    const f = await fixture();
    const r = await f.harness.behavior.runCli(["run", "{not json}"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBeTruthy();
    await f.harness.lifecycle.dispose();
  });
});

describe("Thread-host routing", () => {
  it("starts on the thread host without creating a client tab or leaking an endpoint", async () => {
    const f = await fixture();
    const r: any = await f.harness.behavior.callRpc("start", {
      threadId: "thread_one",
      url: "https://example.com",
    });
    expect(f.calls.find((c) => c.method === "connect").hostId).toBe(
      "host_thread",
    );
    expect(r.session.mode).toBe("managed");
    expect(r.session.expiresAt).toBeGreaterThan(
      Date.now() + 14 * 60 * 1000,
    );
    expect(r.session.viewerUrl).toContain("/http/viewer?id=");
    expect(f.create).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain("ws://");
    f.paneAction.mockClear();
    await f.harness.behavior.callRpc("run", {
      id: r.session.id,
      operation: { kind: "command", args: ["true"] },
    });
    expect(f.paneAction).toHaveBeenCalledWith({
      threadId: "thread_one",
      action: "spotlight",
    });
    const ws = await f.harness.behavior.experimental_openWebSocket(
      `/cast?id=${r.session.id}`,
    );
    const deadline = Date.now() + 2000;
    while (!ws.sent.length && Date.now() < deadline)
      await new Promise((res) => setTimeout(res, 20));
    expect(JSON.parse(String(ws.sent[0]))).toMatchObject({
      data: "qq",
      seq: 1,
      width: 1280,
    });
    await ws.close();
    await f.harness.lifecycle.dispose();
    expect(f.release).not.toHaveBeenCalled();
  });
  it("honors an explicit managed host and reconnects on that same host", async () => {
    const f = await fixture();
    const r: any = await f.harness.behavior.callRpc("start", {
      threadId: "thread_one",
      hostId: "host_pro",
    });
    expect(r.session.hostId).toBe("host_pro");
    const next: any = await f.harness.behavior.callRpc("reconnect", {
      id: r.session.id,
    });
    expect(next.session.hostId).toBe("host_pro");
    expect(next.session.profileId).toBe(r.session.profileId);
    expect(
      f.calls
        .filter((c) => c.method === "connect")
        .every((c) => c.hostId === "host_pro"),
    ).toBe(true);
    await f.harness.lifecycle.dispose();
  });
  it("cleans up a failed managed connection without falling back to desktop", async () => {
    const f = await fixture({ connectFails: true });
    await expect(
      f.harness.behavior.callRpc("start", { threadId: "thread_one" }),
    ).rejects.toThrow("Connection failed");
    expect(f.calls.some((c) => c.method === "release")).toBe(true);
    expect(f.create).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
  it("reconnects managed profiles on the thread host and stops on close", async () => {
    const f = await fixture();
    const r: any = await f.harness.behavior.callRpc("start", {
      threadId: "thread_one",
    });
    const next: any = await f.harness.behavior.callRpc("reconnect", {
      id: r.session.id,
    });
    expect(next.session.profileId).toBe(r.session.id);
    expect(next.session.id).not.toBe(r.session.id);
    await f.harness.behavior.callRpc("close", { id: next.session.id });
    expect(f.close).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
  it("reuses an already reconnected profile instead of launching it twice", async () => {
    const f = await fixture();
    try {
      const original: any = await f.harness.behavior.callRpc("start", {
        threadId: "thread_one",
        url: "https://example.com",
      });
      const first: any = await f.harness.behavior.callRpc("reconnect", {
        id: original.session.id,
      });
      const connects = f.calls.filter((c) => c.method === "connect").length;
      const retry: any = await f.harness.behavior.callRpc("reconnect", {
        id: original.session.id,
      });
      expect(retry.session.id).toBe(first.session.id);
      expect(f.calls.filter((c) => c.method === "connect")).toHaveLength(connects);
    } finally {
      await f.harness.lifecycle.dispose();
    }
  });
});

it("keeps existing sessions on their host after a thread move and defaults new sessions to the new host", async () => {
  const options = { executionHost: "host_thread" };
  const f = await fixture(options);
  const r: any = await f.harness.behavior.callRpc("start", {
    threadId: "thread_one",
  });
  options.executionHost = "host_new";
  await f.harness.behavior.callRpc("run", {
    id: r.session.id,
    operation: { kind: "command", args: ["get", "title"] },
  });
  expect(f.calls.find((c) => c.method === "submit").hostId).toBe("host_thread");
  expect(f.calls.some((c) => c.method === "release")).toBe(false);
  const next: any = await f.harness.behavior.callRpc("start", {
    threadId: "thread_one",
  });
  expect(next.session.hostId).toBe("host_new");
  await f.harness.lifecycle.dispose();
});

it("reuses concurrent starts at the same URL, while explicit new tabs and other threads stay isolated", async () => {
  const f = await fixture();
  const input = { threadId: "thread_one", url: "https://example.com" };
  const results: any[] = await Promise.all(
    Array.from({ length: 8 }, () => f.harness.behavior.callRpc("start", input)),
  );
  expect(new Set(results.map((r) => r.session.id)).size).toBe(1);
  expect(f.calls.filter((c) => c.method === "connect")).toHaveLength(1);
  const fresh: any = await f.harness.behavior.callRpc("start", {
    ...input,
    newTab: true,
  });
  expect(fresh.session.id).not.toBe(results[0].session.id);
  const other: any = await f.harness.behavior.callRpc("start", {
    ...input,
    threadId: "thread_other",
  });
  expect(other.session.id).not.toBe(fresh.session.id);
  expect(f.calls.filter((c) => c.method === "connect")).toHaveLength(3);
  await f.harness.lifecycle.dispose();
});
it("does not replace an existing page when another URL is requested", async () => {
  const f = await fixture();
  const first: any = await f.harness.behavior.callRpc("start", {
    threadId: "thread_one",
    url: "https://example.com/a",
  });
  const next: any = await f.harness.behavior.callRpc("start", {
    threadId: "thread_one",
    url: "https://example.com/b",
  });
  expect(next.session.id).not.toBe(first.session.id);
  expect(
    f.calls.some((c) => c.method === "release" || c.method === "submit"),
  ).toBe(false);
  await f.harness.lifecycle.dispose();
});

it("clears a finished job’s busy indicator when the host omits optional fields", async () => {
  const f = await fixture({ busyOnce: true });
  const input = { threadId: "thread_one", url: "https://example.com" };
  const first: any = await f.harness.behavior.callRpc("start", input);
  expect(first.session.busy).toBe("finished-connect");
  const reused: any = await f.harness.behavior.callRpc("start", input);
  expect(reused.session.id).toBe(first.session.id);
  expect(reused.session.busy).toBeUndefined();
  expect(reused.job.output).not.toContain("Wait for active job");
  await f.harness.lifecycle.dispose();
});

describe("private browser credential requests", () => {
  const request = (id: string) => ({
    id,
    purpose: "Sign in for the requested task",
    fields: [{ selector: "#password", label: "Password", kind: "password" }],
    submitSelector: "button",
  });
  it.each(
    ["managed", "native"].flatMap((mode) =>
      ["submit", "cancel", "error"].map((outcome) => ({ mode, outcome })),
    ),
  )(
    "handles $mode $outcome without putting values in the result",
    async ({ mode, outcome }) => {
      const f = await fixture({ credentialFailure: outcome === "error" });
      try {
        const started: any = await f.harness.behavior.callRpc("start", {
          ...(mode === "native" ? base : { threadId: base.threadId }),
          mode,
          url: "https://accounts.shopify.com",
        });
        const result = f.harness.behavior.runCli(
          ["credentials", JSON.stringify(request(started.session.id))],
          { threadId: base.threadId },
        );
        await vi.waitFor(() =>
          expect(f.harness.inspection.pendingInteractions).toHaveLength(1),
        );
        const interaction = f.harness.inspection.pendingInteractions[0];
        expect(interaction.payload).toEqual({
          origin: "https://accounts.shopify.com",
          purpose: "Sign in for the requested task",
          fields: [{ label: "Password", kind: "password" }],
        });
        if (outcome === "cancel")
          f.harness.behavior.cancelInteraction(interaction.id);
        else
          f.harness.behavior.submitInteraction(interaction.id, [
            "dummy-secret",
          ]);
        const completed = await result;
        expect(JSON.stringify(completed)).not.toContain("dummy-secret");
        expect(completed.exitCode).toBe(outcome === "error" ? 1 : 0);
        expect(
          f.calls.filter((c) => c.method === "credentialFill"),
        ).toHaveLength(outcome === "cancel" ? 0 : 1);
        expect(
          f.calls.filter((c) => c.method === "credentialCancel"),
        ).toHaveLength(1);
      } finally {
        await f.harness.lifecycle.dispose();
      }
    },
  );
  it("refuses another thread before preparing credentials", async () => {
    const f = await fixture();
    try {
      const started: any = await f.harness.behavior.callRpc("start", {
        threadId: base.threadId,
        mode: "managed",
      });
      const result = await f.harness.behavior.runCli(
        ["credentials", JSON.stringify(request(started.session.id))],
        { threadId: "another-thread" },
      );
      expect(result.exitCode).toBe(1);
      expect(f.calls.some((c) => c.method === "credentialPrepare")).toBe(false);
    } finally {
      await f.harness.lifecycle.dispose();
    }
  });
  it("returns a running credentials job that the agent can poll", async () => {
    const f = await fixture();
    try {
      const started: any = await f.harness.behavior.callRpc("start", {
        threadId: base.threadId,
        mode: "managed",
        url: "https://accounts.shopify.com",
      });
      const job: any = await f.harness.behavior.callRpc(
        "credentials",
        request(started.session.id),
      );
      expect(job.status).toBe("running");
      expect(job.kind).toBe("credentials");
      expect(JSON.stringify(job)).not.toContain("dummy-secret");
      await vi.waitFor(() =>
        expect(f.harness.inspection.pendingInteractions).toHaveLength(1),
      );
      f.harness.behavior.submitInteraction(
        f.harness.inspection.pendingInteractions[0].id,
        ["dummy-secret"],
      );
      await vi.waitFor(async () => {
        const polled: any = await f.harness.behavior.callRpc("job", {
          hostId: started.session.hostId,
          id: job.id,
        });
        expect(polled.status).toBe("succeeded");
        expect(polled.output).toContain('"filled":true');
        expect(polled.output).toContain("not a successful login");
        expect(JSON.stringify(polled)).not.toContain("dummy-secret");
      });
    } finally {
      await f.harness.lifecycle.dispose();
    }
  });
});

it.each([false, true])(
  "reports created tab and cleanup when acquisition fails (cleanup fails: %s)",
  async (closeFails) => {
    const f = await fixture({ acquireFails: true, closeFails });
    try {
      await expect(
        f.harness.behavior.callRpc("start", { ...base }),
      ).rejects.toThrow(
        closeFails ? '"cleanup":"preserved"' : '"cleanup":"closed"',
      );
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: "tab_new" }),
      );
      expect(f.release).not.toHaveBeenCalled();
    } finally {
      await f.harness.lifecycle.dispose();
    }
  },
);
it("does not close a pre-existing tab after failed acquisition", async () => {
  const f = await fixture({ acquireFails: true });
  try {
    await expect(
      f.harness.behavior.callRpc("start", { ...base, tabId: "tab_existing" }),
    ).rejects.toThrow('"tabId":"tab_existing"');
    expect(f.close).not.toHaveBeenCalled();
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
it("refreshes stale discovery before native creation and refuses to replay actions after reconnection", async () => {
  const options = { generation: "fresh-one" };
  const f = await fixture(options);
  try {
    const r: any = await f.harness.behavior.callRpc("start", {
      ...base,
      tabId: "tab_existing",
    });
    expect(r.session.generation).toBe("fresh-one");
    options.generation = "fresh-two";
    await expect(
      f.harness.behavior.callRpc("run", {
        id: r.session.id,
        operation: { kind: "command", args: ["click", "button"] },
      }),
    ).rejects.toThrow("fresh-two");
    expect(f.calls.some((c) => c.method === "submit")).toBe(false);
    const next: any = await f.harness.behavior.callRpc("reconnect", {
      id: r.session.id,
    });
    expect(next.session.tabId).toBe("tab_existing");
    expect(next.session.generation).toBe("fresh-two");
    expect(f.create).not.toHaveBeenCalled();
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
it("reports unavailable handoff and accepts visible-frame evidence without claiming current-client visibility", async () => {
  const f = await fixture();
  try {
    const r: any = await f.harness.behavior.callRpc("start", {
      threadId: base.threadId,
    });
    f.paneAction.mockRejectedValue(new Error("Client unavailable"));
    expect(
      await f.harness.behavior.callRpc("reveal", { id: r.session.id }),
    ).toMatchObject({
      ok: false,
      handoff: "unavailable",
      visibleClients: 0,
      currentClientVisibility: "unverified",
    });
    await f.harness.behavior.fetchHttp("POST", "/presence", {
      body: JSON.stringify({
        id: r.session.id,
        clientId: "remote-client",
        visible: true,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(
      await f.harness.behavior.callRpc("reveal", { id: r.session.id }),
    ).toMatchObject({
      ok: true,
      visibleClients: 1,
      currentClientVisibility: "unverified",
    });
    await f.harness.behavior.fetchHttp("POST", "/presence", {
      body: JSON.stringify({
        id: r.session.id,
        clientId: "remote-client",
        visible: false,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(
      await f.harness.behavior.callRpc("reveal", { id: r.session.id }),
    ).toMatchObject({ visibleClients: 0 });
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
it("provides native viewer frames and identity through the selected host", async () => {
  const f = await fixture();
  try {
    const r: any = await f.harness.behavior.callRpc("start", { ...base });
    expect(r.session.viewerUrl).toContain(r.session.id);
    await f.harness.behavior.callRpc("frame", { id: r.session.id });
    expect(f.calls.find((c) => c.method === "frame").hostId).toBe("host_pro");
    expect(r.session.expiresAt).toBeLessThanOrEqual(Date.now() + 1800000);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});


it("cleans up every asynchronously failed native connection without caching an extension limitation", async () => {
 const f=await fixture({connectJobFails:true});
 try {
  await expect(f.harness.behavior.callRpc("start",{...base})).rejects.toThrow('"cleanup":"closed"');
  expect(f.close).toHaveBeenCalledOnce();expect(f.release).toHaveBeenCalledOnce();
  await expect(f.harness.behavior.callRpc("start",{...base})).rejects.toThrow('"cleanup":"closed"');
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.close).toHaveBeenCalledTimes(2);
  expect(f.release).toHaveBeenCalledTimes(2);
 } finally {await f.harness.lifecycle.dispose();}
});

it("limits managed sessions per thread and tells the user how to recover", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 3; index++)
      await f.harness.behavior.callRpc("start", {
        mode: "managed",
        threadId: "thread_one",
        url: `https://example.com/${index}`,
        newTab: true,
      });
    await expect(
      f.harness.behavior.callRpc("start", {
        mode: "managed",
        threadId: "thread_one",
        url: "https://example.com/limit",
        newTab: true,
      }),
    ).rejects.toThrow("Reuse an existing browser tab or close one");
    const connects = f.calls.filter((call) => call.method === "connect");
    expect(connects).toHaveLength(3);
    expect(connects.every((call) => call.input.idleTimeoutMs === 15 * 60_000)).toBe(true);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

it("limits total managed sessions across threads", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 8; index++)
      await f.harness.behavior.callRpc("start", {
        mode: "managed",
        threadId: `thread_${Math.floor(index / 3)}`,
        url: `https://example.com/${index}`,
        newTab: true,
      });
    await expect(
      f.harness.behavior.callRpc("start", {
        mode: "managed",
        threadId: "thread_final",
        url: "https://example.com/limit",
        newTab: true,
      }),
    ).rejects.toThrow("Reuse or close an idle browser tab");
    expect(f.calls.filter((call) => call.method === "connect")).toHaveLength(8);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

it("keeps browsers alive only while their owning agent thread is active", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const options = { threadActive: true };
  const f = await fixture(options);
  try {
    await f.harness.behavior.callRpc("start", { threadId: "thread_one", url: "https://example.com" });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.calls.filter(c => c.method === "keepalive")).toHaveLength(1);
    options.threadActive = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.calls.filter(c => c.method === "keepalive")).toHaveLength(1);
  } finally { await f.harness.lifecycle.dispose(); vi.useRealTimers(); }
});

it("closes Chrome only after a previously observed session tab is removed", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const options: { panelTabs: any[]; tabReadFails: boolean } = { panelTabs: [], tabReadFails: false };
  const f = await fixture(options);
  try {
    const result = await f.harness.behavior.callRpc("start", { threadId: "thread_one", url: "https://example.com" }) as any;
    options.panelTabs = [{ kind: "plugin-panel", pluginId: "browse", actionId: "live", paramsJson: JSON.stringify({ id: result.session.id, url: result.session.url }) }];
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.calls.filter(c => c.method === "release")).toHaveLength(0);
    options.tabReadFails = true;
    options.panelTabs = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.calls.filter(c => c.method === "release")).toHaveLength(0);
    options.tabReadFails = false;
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.calls.filter(c => c.method === "release")).toHaveLength(1);
    expect(
      await f.harness.behavior.callRpc("list", { threadId: "thread_one" }),
    ).toEqual([]);
  } finally { await f.harness.lifecycle.dispose(); vi.useRealTimers(); }
});

it('sends binary frames with bounded credit and rejects arbitrary direct protocol messages', async()=>{
  const f=await fixture({progressiveFrames:true});
  const r:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});
  const stream=await f.harness.behavior.experimental_openWebSocket(`/cast?id=${r.session.id}&binary=1`);
  await vi.waitFor(()=>expect(stream.sent.length).toBeGreaterThanOrEqual(2));
  expect(JSON.parse(String(stream.sent[0]))).toMatchObject({kind:'frame',seq:1});
  expect(stream.sent[1]).toBeInstanceOf(Uint8Array);
  await vi.waitFor(()=>expect(stream.sent).toHaveLength(16));
  await new Promise(resolve=>setTimeout(resolve,40));expect(stream.sent).toHaveLength(16);
  await stream.receive(JSON.stringify({ack:1}));
  await vi.waitFor(()=>expect(stream.sent).toHaveLength(18));await stream.close();
  const control=await f.harness.behavior.experimental_openWebSocket(`/control?id=${r.session.id}`);
  await control.receive(JSON.stringify({type:'take'}));
  await control.receive(JSON.stringify({seq:1,events:[{kind:'cdp',method:'Browser.close'}]}));
  expect(control.closeCalls[0]).toMatchObject({code:1008});
  expect(f.calls.filter(c=>c.method==='direct'&&c.input.events.some((e:any)=>e.kind==='cdp'))).toHaveLength(0);
  await control.close();await f.harness.lifecycle.dispose();
});

it('orders direct input and releases controller state when its socket disconnects',async()=>{
 const f=await fixture();
 try{
  const r:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});
  const control=await f.harness.behavior.experimental_openWebSocket(`/control?id=${r.session.id}`);
  await control.receive(JSON.stringify({type:'take'}));
  await vi.waitFor(()=>expect(control.sent.map(value=>JSON.parse(String(value)))).toContainEqual({type:'control',state:'human'}));
  await control.receive(JSON.stringify({seq:1,events:[{kind:'text',text:'one'}]}));
  await control.receive(JSON.stringify({seq:2,events:[{kind:'text',text:'two'}]}));
  await vi.waitFor(()=>expect(control.sent).toHaveLength(3));
  expect(control.sent.map(v=>JSON.parse(String(v)).seq).filter(Boolean)).toEqual([1,2]);
  await control.close();
  await vi.waitFor(()=>expect(f.calls.filter(c=>c.method==='direct')).toHaveLength(3));
  const calls=f.calls.filter(c=>c.method==='direct');
  expect(calls.map(c=>c.input.events)).toEqual([[{kind:'text',text:'one'}],[{kind:'text',text:'two'}],[{kind:'reset'}]]);
  expect(new Set(calls.map(c=>c.input.clientId)).size).toBe(1);
 }finally{await f.harness.lifecycle.dispose();}
});

it('shares the viewer control identity with toolbar maintenance actions',async()=>{
 const f=await fixture();
 try{
  const r:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});
  const clientId='viewer-client';
  const control=await f.harness.behavior.experimental_openWebSocket(`/control?id=${r.session.id}&clientId=${clientId}`);
  await control.receive(JSON.stringify({type:'take'}));
  await vi.waitFor(()=>expect(control.sent.map(value=>JSON.parse(String(value)))).toContainEqual({type:'control',state:'human'}));
  const response=await f.harness.behavior.fetchHttp('POST','/input',{
   headers:{'content-type':'application/json'},
   body:JSON.stringify({id:r.session.id,clientId,input:{kind:'maintenance',action:'hard-reload'}}),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({status:'succeeded'});
  expect(f.calls.find(c=>c.method==='input')?.input).toMatchObject({id:r.session.id,clientId,input:{kind:'maintenance',action:'hard-reload'}});
  await control.close();
 }finally{await f.harness.lifecycle.dispose();}
});

it('gives one viewer exclusive control and returns control to the agent on disconnect',async()=>{
 const f=await fixture();
 try{
  const r:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});
  const first=await f.harness.behavior.experimental_openWebSocket(`/control?id=${r.session.id}`);
  await first.receive(JSON.stringify({type:'take'}));
  await vi.waitFor(()=>expect(first.sent.map(value=>JSON.parse(String(value)))).toContainEqual({type:'control',state:'human'}));
  await expect(f.harness.behavior.callRpc('run',{id:r.session.id,operation:{kind:'command',args:['snapshot','-i']}})).rejects.toThrow('You have control');
  const second=await f.harness.behavior.experimental_openWebSocket(`/control?id=${r.session.id}`);
  await second.receive(JSON.stringify({type:'take'}));
  await vi.waitFor(()=>expect(second.sent.map(value=>JSON.parse(String(value)))).toContainEqual({type:'control',state:'busy'}));
  await second.close();await first.close();
  await expect(f.harness.behavior.callRpc('run',{id:r.session.id,operation:{kind:'command',args:['snapshot','-i']}})).resolves.toMatchObject({status:'succeeded'});
 }finally{await f.harness.lifecycle.dispose();}
});

it('bounds unacknowledged bytes as well as the number of frames',async()=>{
 const f=await fixture({progressiveFrames:true,frameData:Buffer.alloc(3*1024*1024).toString('base64')});
 try{
  const r:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});
  const stream=await f.harness.behavior.experimental_openWebSocket(`/cast?id=${r.session.id}&binary=1`);
  await vi.waitFor(()=>expect(stream.sent,JSON.stringify(stream.sent)).toHaveLength(2));
  await new Promise(r=>setTimeout(r,40));expect(stream.sent).toHaveLength(2);
  await stream.receive(JSON.stringify({ack:1}));
  await vi.waitFor(()=>expect(stream.sent).toHaveLength(4));
  await stream.close();
 }finally{await f.harness.lifecycle.dispose();}
});


it("opens an address in the existing blank panel and preserves other tabs", async () => {
  const options = { panelTabs: [
    { id: "blank", kind: "plugin-panel", pluginId: "browse", actionId: "live", paramsJson: "{}", title: "Browser" },
    { id: "other", kind: "thread-info" },
  ] as any[] };
  const f = await fixture(options);
  try {
    const result: any = await f.harness.behavior.callRpc("open-address", { threadId: "thread_one", url: "https://example.com", paramsJson: "{}" });
    expect(options.panelTabs).toHaveLength(2);
    expect(options.panelTabs[0]).toMatchObject({ id: "blank", title: "example.com", paramsJson: JSON.stringify({ id: result.session.id, url: result.session.url }) });
    expect(options.panelTabs[1]).toEqual({ id: "other", kind: "thread-info" });
    expect(await f.harness.behavior.callRpc("list", { threadId: "thread_one", onlyUnshown: true })).toEqual([]);
    expect(await f.harness.behavior.callRpc("list", { threadId: "thread_one" })).toHaveLength(1);
  } finally { await f.harness.lifecycle.dispose(); }
});

it("opens an existing session in the current panel without starting another browser", async () => {
  const options = { panelTabs: [{ id: "blank", kind: "plugin-panel", pluginId: "browse", actionId: "live", paramsJson: "{}", title: "Browser" }] as any[] };
  const f = await fixture(options);
  try {
    const existing: any = await f.harness.behavior.callRpc("start", { threadId: "thread_one", url: "https://example.com" });
    const connects = f.calls.filter(c => c.method === "connect").length;
    const result: any = await f.harness.behavior.callRpc("open-address", { threadId: "thread_one", url: existing.session.url, sessionId: existing.session.id, paramsJson: "{}" });
    expect(result.session.id).toBe(existing.session.id);
    expect(f.calls.filter(c => c.method === "connect")).toHaveLength(connects);
    expect(options.panelTabs).toHaveLength(1);
    expect(options.panelTabs[0]).toMatchObject({ id: "blank", paramsJson: JSON.stringify({ id: existing.session.id, url: existing.session.url }) });
  } finally { await f.harness.lifecycle.dispose(); }
});


it("streams the first frame after host startup without a session-list refresh", async () => {
  const f = await fixture({ connectingOnce: true });
  try {
    const started: any = await f.harness.behavior.callRpc("start", { threadId: "thread_one", url: "https://example.com" });
    expect(started.session.status).toBe("connecting");
    expect(started.session.url).toBe("https://example.com/");
    const frame: any = await f.harness.behavior.callRpc("frame", { id: started.session.id });
    expect(frame.seq).toBe(1);
    expect(f.calls.filter(c => c.method === "inspect")).toHaveLength(2);
  } finally { await f.harness.lifecycle.dispose(); }
});

it('keeps video opt-in and binds its display and stream to the selected host',async()=>{
 const f=await fixture();try{
  const result:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com',hostId:'host_pro',video:true,newTab:true});
  expect(result.session.video).toBe(true);
  expect(f.calls.find(c=>c.method==='connect')).toMatchObject({hostId:'host_pro',input:{video:true}});
  const response=await f.harness.behavior.fetchHttp('GET',`/viewer?id=${result.session.id}`);
  expect(await response.text()).toContain('data-video="1"');
  const stream=await f.harness.behavior.experimental_openWebSocket(`/video?id=${result.session.id}`);
  await vi.waitFor(()=>expect(stream.sent,JSON.stringify(stream.sent)).toHaveLength(2));
  await new Promise(r=>setTimeout(r,30));expect(stream.sent).toHaveLength(2);
  await stream.receive('ack');await vi.waitFor(()=>expect(stream.sent).toHaveLength(4));
  await stream.close();
  await vi.waitFor(()=>expect(f.calls.some(c=>c.method==='videoStop')).toBe(true));
  expect(f.calls.filter(c=>c.method.startsWith('video')).every(c=>c.hostId==='host_pro')).toBe(true);
 }finally{await f.harness.lifecycle.dispose();}
});
it('rejects video streaming from an ordinary shared-display session',async()=>{
 const f=await fixture();try{
  const result:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com',video:false});
  await expect(f.harness.behavior.experimental_openWebSocket(`/video?id=${result.session.id}`)).rejects.toThrow('video prototype');
  expect(f.calls.some(c=>c.method==='videoStart')).toBe(false);
 }finally{await f.harness.lifecycle.dispose();}
});

 it('defaults ordinary starts and reconnects to video',async()=>{
 const f=await fixture();try{
 const opened:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});
 expect(opened.session.video).toBe(true);
 const legacy:any=await f.harness.behavior.callRpc('start',{threadId:'thread_two',url:'https://example.com',video:false});
 const resumed:any=await f.harness.behavior.callRpc('reconnect',{id:legacy.session.id});
 expect(resumed.session.video).toBe(true);
 }finally{await f.harness.lifecycle.dispose();}
 });

it('forwards binary frames without polling videoRead or exposing its private token',async()=>{
 const encoder={isClosed:false,onStop:undefined as (()=>void)|undefined,readPackets:async(n:number)=>Array.from({length:n},()=>Buffer.from([4,1,0,0,0,0,5,0,3,32,1])),stop:async()=>{encoder.isClosed=true;encoder.onStop?.();}};
 const relay=await videoRelay(encoder as unknown as SelkiesStream,async()=>({url:'https://example.com',loading:false}));
 const f=await fixture({relay});
 try {
 const result:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});
 const ws=await f.harness.behavior.experimental_openWebSocket('/video?id='+result.session.id);
 await vi.waitFor(()=>expect(ws.sent.length).toBe(7));
 expect(f.calls.some(c=>c.method==='videoRead')).toBe(false);
 expect(JSON.stringify(ws.sent)).not.toContain(relay.token);
 await ws.receive('ack');await vi.waitFor(()=>expect(ws.sent.length).toBe(8));
 await ws.close();await vi.waitFor(()=>expect(encoder.isClosed).toBe(true));
 }finally{await encoder.stop();await f.harness.lifecycle.dispose();}
});

it('uses one private controller handshake without per-batch host RPCs',async()=>{
 const input=vi.fn(async()=>({cursor:'pointer'}));const reset=vi.fn(async()=>{});
 const relay=await controlRelay(input,reset,()=>{});
 const f=await fixture({controlEndpoint:{port:relay.port,token:relay.token}});
 try{
  const r:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});
  const control=await f.harness.behavior.experimental_openWebSocket(`/control?id=${r.session.id}`);
  await control.receive(JSON.stringify({type:'take'}));
  await vi.waitFor(()=>expect(control.sent.map(value=>JSON.parse(String(value)))).toContainEqual({type:'control',state:'human'}));
  await control.receive(JSON.stringify({seq:1,events:[{kind:'heartbeat'}]}));
  await control.receive(JSON.stringify({seq:2,events:[{kind:'heartbeat'}]}));
  await vi.waitFor(()=>expect(control.sent).toHaveLength(3));
  expect(input).toHaveBeenCalledTimes(2);
  expect(f.calls.filter(c=>c.method==='controlStart')).toHaveLength(1);
  expect(f.calls.filter(c=>c.method==='direct')).toHaveLength(0);
  expect(control.sent.join('')).not.toContain(relay.token);
  await control.close();await vi.waitFor(()=>expect(reset).toHaveBeenCalledTimes(1));
 }finally{relay.stop();await f.harness.lifecycle.dispose();}
});
it('collects bounded numeric trace reports only during an explicitly started trace',async()=>{
 const f=await fixture();try{
  const r:any=await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com'});const sid=r.session.id;
  const send=()=>f.harness.behavior.fetchHttp('POST','/presence',{headers:{'content-type':'application/json'},body:JSON.stringify({id:sid,clientId:'test',visible:true,trace:{inputRtt:{count:2,p50:4,p95:5,max:5},pageContent:'not stored'}})});
  await send();expect(await(await f.harness.behavior.fetchHttp('GET',`/trace?id=${sid}`)).json()).toMatchObject({records:[]});
  await f.harness.behavior.fetchHttp('POST','/trace',{headers:{'content-type':'application/json'},body:JSON.stringify({id:sid,durationMs:60000})});
  for(let i=0;i<48;i++)await send();
  const data:any=await(await f.harness.behavior.fetchHttp('GET',`/trace?id=${sid}`)).json();expect(data.records).toHaveLength(45);expect(JSON.stringify(data)).not.toContain('pageContent');expect(data.records[0].trace.inputRtt.p95).toBe(5);
 }finally{await f.harness.lifecycle.dispose();}
});
it('reuses the current managed session for chat URLs and resolves viewer links without nesting', async () => {
 const options = {panelTabs: [] as any[]}; const f = await fixture(options);
 try {
  const existing: any = await f.harness.behavior.callRpc('start',{threadId:'thread_one',url:'https://example.com',mode:'managed'});
  options.panelTabs=[{id:'current',kind:'plugin-panel',pluginId:'browse',actionId:'live',paramsJson:JSON.stringify({id:existing.session.id}),title:'Browser'}];
  const connects=f.calls.filter(c=>c.method==='connect').length;
  const result:any=await f.harness.behavior.callRpc('open-link',{threadId:'thread_one',url:'https://jackfir.com/',currentId:existing.session.id});
  expect(result.session.id).toBe(existing.session.id);
  expect(f.calls.filter(c=>c.method==='connect')).toHaveLength(connects);
  expect(f.calls.some(c=>c.method==='input' && c.input.input.kind==='navigate' && c.input.input.url==='https://jackfir.com/')).toBe(true);
  const viewer:any=await f.harness.behavior.callRpc('open-link',{threadId:'thread_one',url:'https://bb.test/api/v1/plugins/browse/http/viewer?id='+existing.session.id,viewerId:existing.session.id});
  expect(viewer.session.id).toBe(existing.session.id);
  await expect(f.harness.behavior.callRpc('open-link',{threadId:'another_thread',url:'https://bb.test',viewerId:existing.session.id})).rejects.toThrow('another thread');
 } finally {await f.harness.lifecycle.dispose();}
});
