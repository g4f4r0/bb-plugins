import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import type { ArtifactRecord, ArtifactShareRecord } from "../src/contracts/artifact.js";
import { copyArtifact, type ClipboardEnvironment } from "./clipboard.js";
import { errorMessage } from "./format.js";
import type { UiRpcContract } from "./rpc.js";

const EXPIRY_OPTIONS = [
  { seconds: 3_600, label: "1 hour" },
  { seconds: 86_400, label: "1 day" },
  { seconds: 604_800, label: "7 days" },
] as const;

/**
 * Explicit, per-artifact export approval. The link is shown once (the server
 * keeps only a hash of its token) and can be revoked here.
 */
export function ShareControls({
  artifact,
  threadId,
  clipboard,
}: {
  artifact: ArtifactRecord;
  threadId: string;
  clipboard: ClipboardEnvironment;
}) {
  const rpc = useRpc<UiRpcContract>();
  const [expiresInSeconds, setExpiresInSeconds] = useState<number>(604_800);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ share: ArtifactShareRecord; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("artifacts.createShareScoped", {
        threadId,
        runId: artifact.runId,
        artifactIds: [artifact.artifactId],
        expiresInSeconds,
        audience: "anyone-with-link",
      });
      setCreated(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (created === null) return;
    setBusy(true);
    setError(null);
    try {
      const share = await rpc.call("artifacts.revokeShareScoped", { threadId, shareId: created.share.shareId });
      setCreated({ ...created, share });
      toast.success("Share link revoked");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    const outcome = await copyArtifact({ isImage: false, fetchImage: async () => new Blob(), link: created!.url, env: clipboard });
    if (outcome.kind === "manual") setError(outcome.note);
    else toast.success("Share link copied");
  };

  return (
    <section aria-label="Share online" className="space-y-2 border-t border-border px-3 py-3 text-sm">
      {created === null ? (
        <>
          <p className="text-muted-foreground">
            Anyone with the link can view <span className="font-medium text-foreground">{artifact.media.filename}</span> until it
            expires. Revoking stops future access but cannot recall copies already downloaded.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-muted-foreground">
              Expires after
              <select
                value={expiresInSeconds}
                onChange={(event) => setExpiresInSeconds(Number(event.currentTarget.value))}
                className="rounded border border-border bg-background px-2 py-1 text-foreground"
              >
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.seconds} value={option.seconds}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
            >
              Create share link
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {created.share.state === "active"
              ? `Link active until ${new Date(created.share.expiresAt).toLocaleString()}. It is shown only once.`
              : "Link revoked. It no longer serves this file."}
          </p>
          <input
            readOnly
            value={created.url}
            aria-label="Share link"
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void copyLink()}
              disabled={created.share.state !== "active"}
              className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
            >
              Copy share link
            </button>
            <button
              type="button"
              onClick={() => void revoke()}
              disabled={busy || created.share.state !== "active"}
              className="rounded-md border border-border px-3 py-1 text-destructive disabled:opacity-50"
            >
              Revoke
            </button>
          </div>
        </div>
      )}
      {error !== null ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
