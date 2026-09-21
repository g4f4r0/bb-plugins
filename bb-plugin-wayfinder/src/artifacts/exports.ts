import { artifactHttpRoutes } from "../contracts/artifact.js";
import { entityIdSchema } from "../contracts/primitives.js";
import { ArtifactError } from "./errors.js";
import { artifactErrorResponse, PRIVATE_RESPONSE_HEADERS, serveArtifact, type ArtifactChunkReader } from "./http.js";
import { isInlineRenderable } from "./mime.js";
import type { ShareService } from "./shares.js";

/**
 * Unauthenticated read-only export route (`auth: "none"`); the share token is
 * the only credential. Mount it only when `ShareService.availability()` is
 * ready. Without `artifactId` it returns the immutable manifest.
 */
export function createSharedExportHandler(shares: ShareService, read: ArtifactChunkReader) {
  return async (request: Request): Promise<Response> => {
    try {
      if (shares.availability().state !== "ready") throw new ArtifactError("share-disabled", "External sharing is disabled");
      const url = new URL(request.url);
      const shareId = entityIdSchema.safeParse(url.searchParams.get("share"));
      const token = url.searchParams.get("token");
      const rawArtifact = url.searchParams.get("artifactId");
      const artifactId = rawArtifact === null ? null : entityIdSchema.safeParse(rawArtifact);
      if (!shareId.success || token === null || (artifactId !== null && !artifactId.success)) {
        throw new ArtifactError("not-found", "Share not found");
      }
      const resolved = await shares.resolve(shareId.data, token, artifactId?.data ?? null);
      if (resolved.artifact === null) {
        const artifacts = await Promise.all(
          resolved.share.artifactIds.map(async (id) => (await shares.resolve(shareId.data, token, id)).artifact),
        );
        const manifest = {
          shareId: resolved.share.shareId,
          expiresAt: resolved.share.expiresAt,
          manifestSha256: resolved.share.manifestSha256,
          files: artifacts.map((artifact) => {
            const link = new URL(url.toString());
            link.searchParams.set("artifactId", artifact!.artifactId);
            return {
              artifactId: artifact!.artifactId,
              filename: artifact!.media.filename,
              mimeType: artifact!.media.mimeType,
              sizeBytes: artifact!.media.sizeBytes,
              sha256: artifact!.media.sha256,
              path: `${artifactHttpRoutes.sharedExport}${link.search}`,
            };
          }),
        };
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { ...PRIVATE_RESPONSE_HEADERS, "content-type": "application/json; charset=utf-8" },
        });
      }
      const artifact = resolved.artifact;
      return await serveArtifact({
        request,
        artifactId: artifact.artifactId,
        disposition: isInlineRenderable(artifact.media.mimeType) ? "inline" : "attachment",
        read,
        authorize: (candidate) => candidate.storage.immutableSha256 === artifact.storage.immutableSha256,
      });
    } catch (error) {
      return artifactErrorResponse(error);
    }
  };
}
