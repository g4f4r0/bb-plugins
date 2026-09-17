/** Validates the viewer's "annotation added" message before it touches the composer. */
export function browseAnnotationMessage(data: unknown): { id: string; label: string } | null {
  if (!data || typeof data !== "object") return null;
  const { type, annotation } = data as { type?: unknown; annotation?: unknown };
  if (type !== "browse-annotation" || !annotation || typeof annotation !== "object") return null;
  const { id, label } = annotation as { id?: unknown; label?: unknown };
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return null;
  if (typeof label !== "string" || !label.trim()) return null;
  return { id, label: label.trim().slice(0, 80) };
}
