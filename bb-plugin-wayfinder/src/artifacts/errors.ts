export type ArtifactErrorCode =
  | "not-found"
  | "invalid-content"
  | "quota-exceeded"
  | "too-large"
  | "range-not-satisfiable"
  | "integrity"
  | "share-disabled"
  | "share-expired"
  | "share-revoked"
  | "invalid-request";

export class ArtifactError extends Error {
  override readonly name = "ArtifactError";

  constructor(
    readonly code: ArtifactErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const isArtifactError = (value: unknown): value is ArtifactError => value instanceof ArtifactError;
