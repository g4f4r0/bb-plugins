import type { ProviderId } from "../contracts/settings.js";

export type ProviderModel = { id: string; name: string };
export async function providerModels(provider: ProviderId, fetcher: typeof fetch = fetch): Promise<ProviderModel[]> {
  if (provider === "jev") return [{ id: "jev-latest", name: "Jev" }];
  const response = await fetcher("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("OpenRouter's model list is unavailable. Try again.");
  const payload = await response.json() as { data?: unknown };
  if (!Array.isArray(payload.data)) throw new Error("OpenRouter returned an invalid model list.");
  return payload.data.filter((m): m is { id: string; name?: string; supported_parameters: string[] } =>
    !!m && typeof m === "object" && typeof m.id === "string" && m.id.length <= 200 &&
    Array.isArray(m.supported_parameters) && m.supported_parameters.includes("structured_outputs"),
  ).slice(0, 2000).map((m) => ({ id: m.id, name: (typeof m.name === "string" ? m.name : m.id).slice(0, 300) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
