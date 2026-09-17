import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  assertAbsoluteHostPath,
  compareEntries,
  isImagePath,
  isInsideRoot,
  joinRoot,
  toRelative,
} from "./tree.js";

const entrySchema = z.object({
  name: z.string(),
  kind: z.enum(["directory", "file"]),
  relativePath: z.string(),
});
export type Entry = z.infer<typeof entrySchema>;

const rootSchema = z.object({
  environmentId: z.string(),
  hostId: z.string(),
  rootPath: z.string(),
});
export type Root = z.infer<typeof rootSchema>;

const fileTargetSchema = z.object({
  path: z.string().min(1).max(4096),
  kind: z.enum(["workspace", "host", "thread-storage"]),
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  hostId: z.string().optional(),
});
export type FileTarget = z.infer<typeof fileTargetSchema>;

const fileSchema = z.object({
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  mimeType: z.string().nullable(),
  sha256: z.string(),
  sizeBytes: z.number(),
  image: z.boolean(),
  text: z.boolean(),
});

export const rpcContract = defineRpcContract({
  workspace_root: {
    input: z.object({ threadId: z.string() }),
    output: rootSchema,
  },
  list_dir: {
    input: z.object({
      threadId: z.string(),
      relativePath: z.string().max(4096).default(""),
    }),
    output: z.object({ entries: z.array(entrySchema) }),
  },
  search_files: {
    input: z.object({
      threadId: z.string(),
      query: z.string().trim().min(1).max(200),
    }),
    output: z.object({ entries: z.array(entrySchema) }),
  },
  read_file: {
    input: fileTargetSchema,
    output: fileSchema,
  },
  poll_file: {
    input: fileTargetSchema.extend({ sha256: z.string() }),
    output: fileSchema.nullable(),
  },
  write_file: {
    input: fileTargetSchema.extend({
      content: z.string(),
      expectedSha256: z.string(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("written"),
        sha256: z.string(),
      }),
      z.object({
        outcome: z.literal("conflict"),
      }),
    ]),
  },
  remove_file: {
    input: fileTargetSchema,
    output: z.object({ ok: z.literal(true) }),
  },
});

type Resolved = {
  hostId: string;
  absolute: string;
  rootPath: string;
};

async function resolveRoot(bb: BbPluginApi, threadId: string): Promise<Root> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.environmentId === null) {
    throw new Error("This thread has no environment, so it has no files.");
  }
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (environment.path === null) {
    throw new Error("This thread's environment has no workspace path yet.");
  }
  return {
    environmentId: environment.id,
    hostId: environment.hostId,
    rootPath: environment.path,
  };
}

async function resolveTarget(
  bb: BbPluginApi,
  target: FileTarget,
): Promise<Resolved> {
  if (target.kind === "workspace") {
    if (target.environmentId === null) {
      throw new Error("This file has no environment.");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: target.environmentId,
    });
    if (environment.path === null) {
      throw new Error("This environment has no workspace path yet.");
    }
    const absolute = joinRoot(environment.path, target.path);
    if (!isInsideRoot(environment.path, absolute)) {
      throw new Error("Path is outside the workspace root.");
    }
    return {
      hostId: target.hostId ?? environment.hostId,
      absolute,
      rootPath: environment.path,
    };
  }
  if (target.kind === "thread-storage") {
    if (target.threadId === null) {
      throw new Error("This file has no thread storage.");
    }
    const location = await bb.sdk.threads.storageLocation({
      threadId: target.threadId,
    });
    const absolute = joinRoot(location.storageRootPath, target.path);
    if (!isInsideRoot(location.storageRootPath, absolute)) {
      throw new Error("Path is outside the workspace root.");
    }
    return {
      hostId: target.hostId ?? location.hostId,
      absolute,
      rootPath: location.storageRootPath,
    };
  }
  const absolute = assertAbsoluteHostPath(target.path);
  if (target.hostId === undefined) {
    throw new Error("This file has no host.");
  }
  return { hostId: target.hostId, absolute, rootPath: absolute };
}

export default async function plugin(bb: BbPluginApi) {
  // Share overlapping reads, retaining no file contents after the request completes.
  const readKey = (target: FileTarget) =>
    JSON.stringify([
      target.kind,
      target.hostId,
      target.environmentId,
      target.threadId,
      target.path,
    ]);
  const reads = new Map<string, Promise<z.infer<typeof fileSchema>>>();
  const readFile = (target: FileTarget) => {
    const key = readKey(target);
    const pending = reads.get(key);
    if (pending) return pending;
    const request = (async () => {
      const resolved = await resolveTarget(bb, target);
      const file = await bb.sdk.files.read({
        hostId: resolved.hostId,
        path: resolved.absolute,
        rootPath: resolved.rootPath,
      });
      const image = isImagePath(target.path);
      return {
        content: file.content,
        encoding: file.contentEncoding,
        mimeType: file.mimeType ?? null,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        image,
        text: file.contentEncoding === "utf8" && !image,
      };
    })().finally(() => {
      if (reads.get(key) === request) reads.delete(key);
    });
    reads.set(key, request);
    return request;
  };
  bb.rpc.register(rpcContract, {
    workspace_root: ({ threadId }) => resolveRoot(bb, threadId),

    list_dir: async ({ threadId, relativePath }) => {
      const root = await resolveRoot(bb, threadId);
      const target = joinRoot(root.rootPath, relativePath);
      if (!isInsideRoot(root.rootPath, target)) {
        throw new Error("Path is outside the workspace root.");
      }
      const listing = await bb.sdk.hosts.directory({
        hostId: root.hostId,
        path: target,
      });
      const entries = listing.entries
        .filter((entry) => entry.name !== ".git")
        .map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          relativePath: toRelative(root.rootPath, entry.path),
        }))
        .sort(compareEntries);
      return { entries };
    },

    search_files: async ({ threadId, query }) => {
      const root = await resolveRoot(bb, threadId);
      const listing = await bb.sdk.files.list({
        hostId: root.hostId,
        path: root.rootPath,
        query,
        limit: 80,
      });
      const entries = listing.files.flatMap((file) => {
        if (!isInsideRoot(root.rootPath, file.path)) return [];
        return [
          {
            name: file.name,
            kind: "file" as const,
            relativePath: toRelative(root.rootPath, file.path),
          },
        ];
      });
      return { entries };
    },

    read_file: readFile,
    poll_file: async ({ sha256, ...target }) => {
      const file = await readFile(target);
      return file.sha256 === sha256 ? null : file;
    },

    write_file: async ({ content, expectedSha256, ...target }) => {
      const resolved = await resolveTarget(bb, target);
      if (isImagePath(target.path)) {
        throw new Error("This file type cannot be edited as text.");
      }
      reads.delete(readKey(target));
      const saved = await bb.sdk.files.write({
        hostId: resolved.hostId,
        path: resolved.absolute,
        rootPath: resolved.rootPath,
        content,
        expectedSha256,
      });
      reads.delete(readKey(target));
      if (saved.outcome === "conflict") {
        return { outcome: "conflict" as const };
      }
      return { outcome: "written" as const, sha256: saved.sha256 };
    },

    remove_file: async (target) => {
      const resolved = await resolveTarget(bb, target);
      reads.delete(readKey(target));
      await bb.sdk.files.remove({
        hostId: resolved.hostId,
        path: resolved.absolute,
        rootPath: resolved.rootPath,
      });
      reads.delete(readKey(target));
      return { ok: true as const };
    },
  });
}
