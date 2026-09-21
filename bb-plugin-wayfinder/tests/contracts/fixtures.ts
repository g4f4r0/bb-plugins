import type { WayfinderRoute } from "../../src/contracts/route.js";

export function makeRoute(): WayfinderRoute {
  return {
    schemaVersion: 1,
    goal: "Verify the synthetic fixture writes its report.",
    identity: {
      hostId: "host_test",
      threadId: "thread_test",
      projectId: "project_test",
      environmentId: "environment_test",
    },
    browser: {
      navigationOrigins: [{ origin: "http://127.0.0.1:4173", purpose: "fixture" }],
      resourceOrigins: [{ origin: "http://127.0.0.1:4173", purpose: "fixture" }],
      allowPopups: false,
      allowDownloads: false,
    },
    desktop: {
      applications: [
        {
          appId: "fixture_app",
          executable: "wayfinder-fixture",
          windowTitle: "Wayfinder fixture",
          titleMatch: "exact",
        },
      ],
    },
    filesystem: {
      roots: [
        {
          rootId: "fixture_root",
          kind: "fixture",
          absolutePath: "/tmp/wayfinder-fixture",
          access: "read-verify",
        },
      ],
    },
    allowedActions: ["browser.navigate", "browser.click", "filesystem.verify"],
    checkpoints: [
      {
        checkpointId: "final_url",
        kind: "url",
        timing: "final",
        origin: "http://127.0.0.1:4173",
        pathname: "/done",
        match: "exact",
      },
    ],
    capture: {
      livePreview: {
        enabled: true,
        maxWidth: 1_280,
        maxHeight: 720,
        maxFps: 4,
        maxFrameBytes: 262_144,
      },
      evidenceImages: {
        enabled: true,
        maxWidth: 1_280,
        maxHeight: 720,
        maxImages: 20,
      },
      recording: {
        enabled: false,
        maxDurationMs: 60_000,
        maxBytes: 16_777_216,
        codec: "h264",
        pixelFormat: "yuv420p",
      },
      protectedIntervals: "suspend-all-model-visible-capture",
    },
    limits: {
      maxRuntimeMs: 120_000,
      maxActions: 30,
      maxDecisions: 60,
      maxProviderCalls: 60,
      maxProviderTokens: 100_000,
      maxProviderSpendMicrousd: 1_000_000,
      maxNoProgressRounds: 3,
      maxRequestRetries: 2,
      maxArtifacts: 30,
      maxArtifactBytes: 67_108_864,
      maxCaptureBufferBytes: 16_777_216,
    },
  };
}
