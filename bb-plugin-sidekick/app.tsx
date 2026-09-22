import { useCallback, useEffect, useState, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Profile, rpcContract } from "./server.js";
import {
  PERMISSION_MODES,
  PROFILE_SLUG_RE,
  PROFILES_CHANGED,
  REASONING_LEVELS,
  parseSkillNames,
  slugifyProfileName,
} from "./shared.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

const PANEL_PATH = "sidekick";
const textareaClass = "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const selectClass = "h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground";

type ProfileDraft = Omit<Profile, "id" | "sortOrder" | "createdAt" | "updatedAt">;

const emptyProfile = (): ProfileDraft => ({
  slug: "",
  name: "",
  description: "",
  instructions: "",
  providerId: null,
  model: null,
  reasoningLevel: null,
  permissionMode: null,
  skills: [],
  behavior: "",
});

function errorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const issues = (cause as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
  return Array.isArray(issues) && issues.length > 0
    ? issues.map((issue) => `${(issue.path ?? []).join(".") || "input"}: ${issue.message ?? "invalid"}`).join("; ")
    : cause.message;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function ProfileEditor({ initial, busy, onCancel, onSave }: {
  initial: ProfileDraft;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: ProfileDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(initial.slug !== "");
  const [skillText, setSkillText] = useState(initial.skills.join(", "));
  const set = <Key extends keyof ProfileDraft>(key: Key, value: ProfileDraft[Key]) => setDraft((current) => ({ ...current, [key]: value }));
  const modelPairValid = (draft.providerId === null) === (draft.model === null);
  const valid = draft.name.trim() !== ""
    && PROFILE_SLUG_RE.test(draft.slug)
    && draft.instructions.trim() !== ""
    && modelPairValid;
  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (valid && !busy) onSave({ ...draft, skills: parseSkillNames(skillText) }); }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input autoFocus value={draft.name} onChange={(event) => {
            const name = event.target.value;
            set("name", name);
            if (!slugTouched) set("slug", slugifyProfileName(name));
          }} />
        </Field>
        <Field label="Slug" hint="Used by bb sidekick spawn <slug>">
          <Input className="font-mono" value={draft.slug} onChange={(event) => { setSlugTouched(true); set("slug", event.target.value); }} />
        </Field>
      </div>
      <Field label="Description"><Input value={draft.description} maxLength={300} onChange={(event) => set("description", event.target.value)} /></Field>
      <Field label="Profile instructions" hint="Injected as hidden instructions when the provider session starts.">
        <textarea className={textareaClass} rows={8} maxLength={2800} value={draft.instructions} onChange={(event) => set("instructions", event.target.value)} />
      </Field>
      <Field label="Behavior defaults" hint="Optional working style and response preferences, also injected as hidden instructions.">
        <textarea className={textareaClass} rows={3} maxLength={600} value={draft.behavior} onChange={(event) => set("behavior", event.target.value)} />
      </Field>
      <Field label="Preferred skills" hint="Comma-separated skill names. Sidekick requests their use when available; BB's SDK does not let one plugin activate another plugin's skills.">
        <Input value={skillText} onChange={(event) => setSkillText(event.target.value)} placeholder="research, reporting" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider ID" hint="Leave both provider and model empty to inherit project defaults.">
          <Input value={draft.providerId ?? ""} onChange={(event) => set("providerId", event.target.value.trim() || null)} placeholder="inherit" />
        </Field>
        <Field label="Model"><Input value={draft.model ?? ""} onChange={(event) => set("model", event.target.value.trim() || null)} placeholder="inherit" /></Field>
        <Field label="Reasoning">
          <select className={selectClass} value={draft.reasoningLevel ?? ""} onChange={(event) => set("reasoningLevel", (event.target.value || null) as ProfileDraft["reasoningLevel"])}>
            <option value="">inherit</option>
            {REASONING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </Field>
        <Field label="Permission">
          <select className={selectClass} value={draft.permissionMode ?? ""} onChange={(event) => set("permissionMode", (event.target.value || null) as ProfileDraft["permissionMode"])}>
            <option value="">inherit</option>
            {PERMISSION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </Field>
      </div>
      {!modelPairValid ? <p role="alert" className="text-xs text-destructive">Provider and model must both be set or both inherit.</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={!valid || busy}>Save profile</Button>
      </div>
    </form>
  );
}

function SpawnForm({ profile, projects, onCancel }: {
  profile: Profile;
  projects: Array<{ id: string; name: string }>;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const { threadId } = await rpc.call("profiles.spawn", {
        profile: profile.id,
        prompt: prompt.trim(),
        projectId,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      onCancel();
      navigate.toThread(threadId);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="mt-4 flex flex-col gap-3 rounded-lg border border-border p-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field label="Project" hint="Sidekick requires an explicit project for every thread.">
        <select aria-label="Project" className={selectClass} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Select a project…</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Field>
      <Field label="Task"><textarea autoFocus className={textareaClass} rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></Field>
      <Field label="Title" hint="Optional"><Input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || !projectId || prompt.trim() === ""}><Icon name="Play" className="size-4" /> Start one thread</Button>
      </div>
    </form>
  );
}

function SidekickPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [spawning, setSpawning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void rpc.call("profiles.list").then((result) => setProfiles(result.profiles)).catch((cause) => toast.error(errorMessage(cause)));
  }, [rpc]);
  useEffect(() => {
    refresh();
    void rpc.call("projects.list").then((result) => setProjects(result.projects)).catch(() => setProjects([]));
  }, [refresh, rpc]);
  useRealtime(PROFILES_CHANGED, refresh);

  const save = async (draft: ProfileDraft) => {
    setBusy(true);
    try {
      if (editing === "new") await rpc.call("profiles.create", draft);
      else if (editing) await rpc.call("profiles.update", { id: editing, ...draft });
      setEditing(null);
      refresh();
      toast.success("Sidekick profile saved");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: Profile) => {
    if (!window.confirm(`Delete Sidekick profile "${profile.name}"?`)) return;
    setBusy(true);
    try {
      await rpc.call("profiles.delete", { id: profile.id });
      refresh();
      toast.success("Sidekick profile deleted");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const editingProfile = editing && editing !== "new" ? profiles?.find((profile) => profile.id === editing) ?? null : null;
  return (
    <main className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto box-border flex w-full max-w-3xl flex-col gap-6 px-5 pb-16 pt-6 md:px-8 md:pt-8">
        <header className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-xl font-semibold">Sidekick</h1>
            <p className="mt-1 text-sm text-muted-foreground">Reusable profiles for starting exactly one focused BB thread at a time.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}><Icon name="Plus" className="size-4" /> New profile</Button>
        </header>
        {profiles === null ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">Loading profiles…</div>
        ) : profiles.length === 0 ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
            <p className="font-medium">No Sidekick profiles yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Create the first profile when you are ready. Sidekick does not seed examples.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {profiles.map((profile) => (
              <li key={profile.id} className="py-5 first:pt-0">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2"><span className="font-medium">{profile.name}</span><code className="text-xs text-muted-foreground">{profile.slug}</code></div>
                    {profile.description ? <p className="mt-1 text-sm text-muted-foreground">{profile.description}</p> : null}
                    <p className="mt-1 text-xs text-muted-foreground">{profile.providerId && profile.model ? `${profile.providerId}/${profile.model}` : "inherits provider/model"}{profile.skills.length ? ` · skills: ${profile.skills.join(", ")}` : ""}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setSpawning(spawning === profile.id ? null : profile.id)}><Icon name="Play" className="size-4" /> Start</Button>
                  <Button size="icon" variant="ghost" aria-label={`Edit ${profile.name}`} onClick={() => setEditing(profile.id)}><Icon name="Edit" className="size-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${profile.name}`} disabled={busy} onClick={() => void remove(profile)}><Icon name="Trash2" className="size-4" /></Button>
                </div>
                {spawning === profile.id ? <SpawnForm profile={profile} projects={projects} onCancel={() => setSpawning(null)} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}>
        <DialogContent className="max-h-[92dvh] w-[96vw] max-w-3xl overflow-y-auto" hideCloseButton={busy}>
          <DialogTitle>{editing === "new" ? "New Sidekick profile" : "Edit Sidekick profile"}</DialogTitle>
          <DialogDescription>Set hidden instructions and optional execution defaults.</DialogDescription>
          {editing === "new" || editingProfile ? <ProfileEditor key={editing} initial={editing === "new" ? emptyProfile() : editingProfile!} busy={busy} onCancel={() => setEditing(null)} onSave={(draft) => void save(draft)} /> : null}
        </DialogContent>
      </Dialog>
    </main>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sidekick",
    title: "Sidekick",
    icon: "UserRound",
    path: PANEL_PATH,
    component: SidekickPage,
  });
});
