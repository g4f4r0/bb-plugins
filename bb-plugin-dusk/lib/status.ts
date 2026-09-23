// Status sections for Dusk's thread list. Pure functions so the rules stay testable.
// Snooze wake rules follow GTD Sidebar by Scott Sunarto (MIT).
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export type SectionId = "pinned" | "waiting" | "ready" | "working" | "done" | "snoozed";
export const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "waiting", label: "Waiting" },
  { id: "ready", label: "Ready" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
  { id: "snoozed", label: "Snoozed" },
];

export interface SnoozeRow { threadId: string; until: number; at: number }
export interface Family { root: PluginSidebarThread; children: PluginSidebarThread[]; section: SectionId; snooze: SnoozeRow | null; at: number }

type Thread = Pick<PluginSidebarThread, "id" | "parentThreadId" | "isPinned" | "hasPendingInteraction" | "indicator" | "activity" | "updatedAt" | "latestAttentionAt" | "createdAt" | "isUnread">;

export function isWorking(thread: Thread): boolean {
  const { activity } = thread;
  return activity.workflows > 0 || activity.backgroundAgents > 0 || activity.backgroundCommands > 0 ||
    activity.planMode > 0 || activity.goals > 0 || thread.indicator === "runtime" || thread.indicator === "working-draft";
}

/** The agent is waiting on the user: a question, an approval, an unread failure, or a queued message that failed to send. */
export function needsYou(thread: Thread): boolean {
  return thread.hasPendingInteraction || thread.indicator === "waiting-for-input" || thread.indicator === "unread-error" || thread.indicator === "queued-failed";
}

/** Finished with a result the user hasn't read yet. */
export function isReady(thread: Thread): boolean {
  return thread.indicator === "unread-success" || (thread.isUnread && !needsYou(thread) && !isWorking(thread));
}

/** Live work and questions block snoozing: hiding them is the one thing snooze must never do. */
export function canSnooze(threads: readonly Thread[]): boolean {
  return !threads.some((thread) => isWorking(thread) || thread.hasPendingInteraction);
}

export const lastActivity = (thread: Thread) => Math.max(thread.updatedAt, thread.latestAttentionAt);

/** A snooze holds until its time passes or anything in the family gets new attention. */
export function isSnoozed(row: SnoozeRow | undefined, family: readonly Thread[], now: number): boolean {
  if (!row || row.until <= now || !canSnooze(family)) return false;
  return !family.some((thread) => thread.latestAttentionAt > row.at);
}

export function buildFamilies<T extends PluginSidebarThread>(threads: readonly T[], snoozes: ReadonlyMap<string, SnoozeRow>, pinKeys: ReadonlyMap<string, string | null>, now: number): Map<SectionId, Family[]> {
  const ids = new Set(threads.map((thread) => thread.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    if (thread.parentThreadId && ids.has(thread.parentThreadId)) {
      const list = children.get(thread.parentThreadId) ?? [];
      list.push(thread);
      children.set(thread.parentThreadId, list);
    } else roots.push(thread);
  }
  // Grandchildren flatten under the top-level thread, oldest first like BB.
  const descendants = (id: string): T[] => (children.get(id) ?? []).flatMap((child) => [child, ...descendants(child.id)]);
  const sections = new Map<SectionId, Family[]>(SECTIONS.map(({ id }) => [id, []]));
  for (const root of roots) {
    const kids = descendants(root.id).sort((a, b) => a.createdAt - b.createdAt);
    const family = [root, ...kids];
    const snooze = snoozes.get(root.id);
    const snoozed = isSnoozed(snooze, family, now);
    // isSnoozed is already false while anything works or asks, so a snooze
    // only hides quiet threads, including an unread failure the user parked.
    const section: SectionId = root.isPinned ? "pinned"
      : snoozed ? "snoozed"
      : family.some(needsYou) ? "waiting"
      : family.some(isWorking) ? "working"
      : family.some(isReady) ? "ready"
      : "done";
    sections.get(section)!.push({ root, children: kids, section, snooze: snoozed ? snooze! : null, at: Math.max(...family.map(lastActivity)) });
  }
  sections.get("pinned")!.sort((a, b) => {
    const left = pinKeys.get(a.root.id) ?? null, right = pinKeys.get(b.root.id) ?? null;
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return left < right ? -1 : 1;
    }
    return b.at - a.at;
  });
  for (const id of ["waiting", "ready", "working", "done"] as const) sections.get(id)!.sort((a, b) => b.at - a.at);
  sections.get("snoozed")!.sort((a, b) => a.snooze!.until - b.snooze!.until);
  return sections;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** "5m", "2h", "3d" until wake. Rounds up so a hidden thread never reads "0m". */
export function wakeLabel(until: number, now: number): string {
  const left = until - now;
  if (left <= 0) return "now";
  const minutes = Math.max(1, Math.ceil(left / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(left / HOUR);
  if (hours < 24) return `${hours}h`;
  return `${Math.ceil(left / DAY)}d`;
}

/** 09:00 local on a later calendar day; calendar math keeps DST days right. */
export function morningIn(days: number, from: Date): number {
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  next.setHours(9, 0, 0, 0);
  return next.getTime();
}

export function snoozePresets(from: Date): { id: string; label: string; until: number; showDay: boolean }[] {
  const now = from.getTime();
  const daysToMonday = ((8 - from.getDay()) % 7) || 7;
  return [
    { id: "1h", label: "In 1 hour", until: now + HOUR, showDay: false },
    { id: "3h", label: "In 3 hours", until: now + 3 * HOUR, showDay: false },
    { id: "tomorrow", label: "Tomorrow", until: morningIn(1, from), showDay: false },
    { id: "week", label: "Next week", until: morningIn(daysToMonday, from), showDay: true },
  ];
}
