// Beacon registers Status in both the sidebar footer and the navigation rail.
// The placement setting decides which one is shown; the other moves into its
// area's More menu through bb's own sidebar preferences, so it stays reachable.

export const PLACEMENTS = ["footer", "rail"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export const DEFAULT_PLACEMENT: Placement = "footer";
export const STATUS_ITEM_ID = "status";
export const STATUS_PANEL_PATH = "status";
const APPLIED_KEY = "placement-applied";
// bb hides this rail destination until the user shows it.
const DEFAULT_HIDDEN_RAIL_KEYS = ["__bb__/search-threads"];

export function isPlacement(value: unknown): value is Placement {
  return typeof value === "string" && (PLACEMENTS as readonly string[]).includes(value);
}

export function footerKey(pluginId: string): string {
  return `plugin:${encodeURIComponent(pluginId)}/${encodeURIComponent(STATUS_ITEM_ID)}`;
}

export function railKey(pluginId: string): string {
  return `${pluginId}/${STATUS_ITEM_ID}`;
}

export interface SidebarPreferences {
  hiddenFooterItems: string[];
  pluginPanelOrder: string[];
  visiblePluginPanels: string[] | null;
}

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The sidebar preferences that show Status only in `placement`, changing
 * Beacon's own entries and nothing else. Returns only the preferences that
 * change.
 *
 * Rail visibility follows bb's model: `visiblePluginPanels: null` shows every
 * destination; a list shows the listed ones plus any destination missing from
 * `pluginPanelOrder`, which bb treats as new. Hiding Status therefore keeps
 * it in the order and out of the list, and turns `null` into the ordered
 * destinations other than Status so nothing else disappears.
 */
export function planPlacement(current: SidebarPreferences, placement: Placement, pluginId: string): Partial<SidebarPreferences> {
  const footer = footerKey(pluginId);
  const rail = railKey(pluginId);
  const next: Partial<SidebarPreferences> = {};

  const hiddenFooterItems = placement === "footer"
    ? current.hiddenFooterItems.filter((key) => key !== footer)
    : current.hiddenFooterItems.includes(footer) ? current.hiddenFooterItems : [...current.hiddenFooterItems, footer];
  if (!sameList(hiddenFooterItems, current.hiddenFooterItems)) next.hiddenFooterItems = hiddenFooterItems;

  if (placement === "rail") {
    if (current.visiblePluginPanels !== null && !current.visiblePluginPanels.includes(rail)) {
      next.visiblePluginPanels = [...current.visiblePluginPanels, rail];
    }
    return next;
  }

  const pluginPanelOrder = current.pluginPanelOrder.includes(rail) ? current.pluginPanelOrder : [...current.pluginPanelOrder, rail];
  if (!sameList(pluginPanelOrder, current.pluginPanelOrder)) next.pluginPanelOrder = pluginPanelOrder;
  const visible = current.visiblePluginPanels ?? current.pluginPanelOrder.filter((key) => !DEFAULT_HIDDEN_RAIL_KEYS.includes(key));
  const visiblePluginPanels = visible.filter((key) => key !== rail);
  if (!sameList(visiblePluginPanels, current.visiblePluginPanels)) next.visiblePluginPanels = visiblePluginPanels;
  return next;
}

type PreferenceKey = "sidebar.hiddenFooterItems" | "sidebar.pluginPanelOrder" | "sidebar.visiblePluginPanels";
interface PreferenceEntry { revision: number; value: unknown }
/** The slice of `bb.sdk.system.uiPreferences` Beacon uses. */
export interface UiPreferencesClient {
  list(): Promise<{ preferences: Record<string, PreferenceEntry> }>;
  set(args: { key: PreferenceKey; value: string[] | null; expectedRevision: number }): Promise<unknown>;
}
export interface PlacementStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

const PREFERENCE_KEYS: Record<keyof SidebarPreferences, PreferenceKey> = {
  hiddenFooterItems: "sidebar.hiddenFooterItems",
  pluginPanelOrder: "sidebar.pluginPanelOrder",
  visiblePluginPanels: "sidebar.visiblePluginPanels",
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function applyOnce(ui: UiPreferencesClient, placement: Placement, pluginId: string): Promise<void> {
  const { preferences } = await ui.list();
  const entry = (key: PreferenceKey): PreferenceEntry => preferences[key] ?? { revision: 0, value: null };
  const visible = entry("sidebar.visiblePluginPanels").value;
  const plan = planPlacement({
    hiddenFooterItems: stringList(entry("sidebar.hiddenFooterItems").value),
    pluginPanelOrder: stringList(entry("sidebar.pluginPanelOrder").value),
    visiblePluginPanels: visible === null || visible === undefined ? null : stringList(visible),
  }, placement, pluginId);
  // Order before visibility: a hidden rail key must already be in the order,
  // or bb would show it as a new destination in between the two writes.
  for (const field of ["hiddenFooterItems", "pluginPanelOrder", "visiblePluginPanels"] as const) {
    const value = plan[field];
    if (value === undefined) continue;
    const key = PREFERENCE_KEYS[field];
    await ui.set({ key, value, expectedRevision: entry(key).revision });
  }
}

/**
 * Show Status only in `placement`, once per change of the setting. A user who
 * later rearranges the sidebar by hand keeps that arrangement until the
 * setting changes again. Retries once if another client wrote the same
 * preferences in between.
 */
export async function applyPlacement(ui: UiPreferencesClient, store: PlacementStore, placement: Placement, pluginId: string): Promise<boolean> {
  if ((await store.get<string>(APPLIED_KEY)) === placement) return false;
  try {
    await applyOnce(ui, placement, pluginId);
  } catch {
    await applyOnce(ui, placement, pluginId);
  }
  await store.set(APPLIED_KEY, placement);
  return true;
}
