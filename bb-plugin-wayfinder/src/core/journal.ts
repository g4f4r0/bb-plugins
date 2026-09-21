import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { actionIntentSchema, adapterOutcomeSchema, type ActionIntent, type AdapterOutcome } from "../contracts/adapter.js";

const journalEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intent"), intent: actionIntentSchema }).strict(),
  z.object({ kind: z.literal("outcome"), outcome: adapterOutcomeSchema }).strict(),
]);

export type JournalEntry = z.infer<typeof journalEntrySchema>;

export class ActionJournal {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const handle = await open(this.#path, "a", 0o600);
    await handle.close();
  }

  async recordIntent(intent: ActionIntent): Promise<void> {
    await this.#append({ kind: "intent", intent: actionIntentSchema.parse(intent) });
  }

  async recordOutcome(outcome: AdapterOutcome): Promise<void> {
    await this.#append({ kind: "outcome", outcome: adapterOutcomeSchema.parse(outcome) });
  }

  async read(): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      entries.push(journalEntrySchema.parse(JSON.parse(line)));
    }
    return entries;
  }

  async uncertainIntents(runId?: string): Promise<ActionIntent[]> {
    const entries = await this.read();
    const intents = new Map<string, ActionIntent>();
    for (const entry of entries) {
      if (entry.kind === "intent") {
        if (runId === undefined || entry.intent.runId === runId) intents.set(entry.intent.actionId, entry.intent);
      } else {
        intents.delete(entry.outcome.actionId);
      }
    }
    return [...intents.values()];
  }

  async #append(entry: JournalEntry): Promise<void> {
    await this.initialize();
    const handle = await open(this.#path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
