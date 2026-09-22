import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_PermissionModePicker as PermissionModePicker,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Profile, rpcContract } from "./server.js";
import {
  PROFILE_SLUG_RE,
  PROFILES_CHANGED,
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
type SkillOption = { name: string; description: string | null };
type ExecutionSelection = {
  providerId: string;
  model: string;
  reasoningLevel: NonNullable<Profile["reasoningLevel"]>;
  serviceTier: Profile["serviceTier"];
  permissionMode: NonNullable<Profile["permissionMode"]>;
};

const emptyProfile = (): ProfileDraft => ({
  slug: "",
  name: "",
  description: "",
  instructions: "",
  providerId: null,
  model: null,
  reasoningLevel: null,
  serviceTier: null,
  permissionMode: null,
  skills: [],
});

function errorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const issues = (cause as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
  return Array.isArray(issues) && issues.length > 0
    ? issues.map((issue) => `${(issue.path ?? []).join(".") || "input"}: ${issue.message ?? "invalid"}`).join("; ")
    : cause.message;
}

function Field({ label, hint, complex = false, children }: { label: string; hint?: string; complex?: boolean; children: ReactNode }) {
  const content = (
    <>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span> : null}
    </>
  );
  return complex ? <div className="block">{content}</div> : <label className="block">{content}</label>;
}

function ProfileEditor({ initial, skillOptions, defaultExecution, busy, onCancel, onSave }: {
  initial: ProfileDraft;
  skillOptions: SkillOption[];
  defaultExecution: ExecutionSelection | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: ProfileDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(initial.slug !== "");
  const [skillQuery, setSkillQuery] = useState("");
  const set = <Key extends keyof ProfileDraft>(key: Key, value: ProfileDraft[Key]) => setDraft((current) => ({ ...current, [key]: value }));
  const hasAnyExplicitExecution = draft.providerId !== null || draft.model !== null;
  const hasExplicitExecution = draft.providerId !== null && draft.model !== null;
  const executionValid = !hasAnyExplicitExecution
    || (hasExplicitExecution && draft.reasoningLevel !== null && draft.permissionMode !== null);
  const valid = draft.name.trim() !== ""
    && PROFILE_SLUG_RE.test(draft.slug)
    && draft.instructions.trim() !== ""
    && executionValid;
  const query = skillQuery.trim().toLowerCase();
  const visibleSkills = skillOptions
    .filter((skill) => !query || skill.name.toLowerCase().includes(query) || skill.description?.toLowerCase().includes(query))
    .slice(0, 50);
  const toggleSkill = (name: string) => {
    setDraft((current) => {
      const selected = current.skills.includes(name);
      if (!selected && current.skills.length >= 12) return current;
      return { ...current, skills: selected ? current.skills.filter((skill) => skill !== name) : [...current.skills, name] };
    });
  };
  const chooseExecution = () => {
    if (!defaultExecution) return;
    setDraft((current) => ({ ...current, ...defaultExecution }));
  };
  const inheritExecution = () => setDraft((current) => ({
    ...current,
    providerId: null,
    model: null,
    reasoningLevel: null,
    serviceTier: null,
    permissionMode: null,
  }));
  const pickerValue = hasExplicitExecution ? {
    providerId: draft.providerId!,
    model: draft.model!,
    reasoningLevel: draft.reasoningLevel ?? "medium" as const,
    ...(draft.serviceTier ? { serviceTier: draft.serviceTier } : {}),
  } : null;
  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (valid && !busy) onSave(draft); }}>
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
      <Field label="Agent instructions" hint="Identity, responsibilities, boundaries, and working style injected when the provider session starts.">
        <textarea className={textareaClass} rows={11} maxLength={3500} value={draft.instructions} onChange={(event) => set("instructions", event.target.value)} />
      </Field>
      <Field complex label="Provider and model" hint="Uses BB's live provider catalog and the same model and reasoning picker as the composer.">
        {pickerValue ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
            <ProviderModelPicker
              value={pickerValue}
              onChange={(value) => setDraft((current) => ({
                ...current,
                providerId: value.providerId,
                model: value.model,
                reasoningLevel: value.reasoningLevel,
                serviceTier: value.serviceTier ?? null,
              }))}
            />
            <PermissionModePicker
              providerId={pickerValue.providerId}
              value={draft.permissionMode ?? "full"}
              onChange={(permissionMode) => set("permissionMode", permissionMode)}
            />
            <Button type="button" variant="ghost" size="sm" onClick={inheritExecution}>Use project defaults</Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <span className="text-sm text-muted-foreground">Inherits the target project's provider, model, reasoning, and permission.</span>
            <Button type="button" variant="outline" size="sm" onClick={chooseExecution} disabled={!defaultExecution}>Choose provider and model</Button>
          </div>
        )}
      </Field>
      <Field complex label="Skills" hint="Choose up to 12 skills discovered by BB. The agent is asked to use selected skills when they are available in its session.">
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Selected {draft.skills.length}/12</span>
            {draft.skills.map((skill) => (
              <Button key={skill} type="button" variant="outline" size="sm" onClick={() => toggleSkill(skill)} aria-label={`Remove ${skill}`}>
                {skill} <span aria-hidden="true">×</span>
              </Button>
            ))}
          </div>
          <Input aria-label="Search skills" placeholder="Search available skills…" value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} />
          <div className="max-h-56 overflow-y-auto rounded-md border border-border">
            {visibleSkills.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">No matching skills.</p>
            ) : visibleSkills.map((skill) => (
              <label key={skill.name} className="flex cursor-pointer items-start gap-2 border-b border-border px-3 py-2 last:border-b-0">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.skills.includes(skill.name)}
                  disabled={!draft.skills.includes(skill.name) && draft.skills.length >= 12}
                  onChange={() => toggleSkill(skill.name)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{skill.name}</span>
                  {skill.description ? <span className="block text-xs text-muted-foreground">{skill.description}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </div>
      </Field>
      {!executionValid ? <p role="alert" className="text-xs text-destructive">Choose a valid provider, model, reasoning level, and permission mode.</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={!valid || busy}>Save agent</Button>
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
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [defaultExecution, setDefaultExecution] = useState<ExecutionSelection | null>(null);
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [spawning, setSpawning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void rpc.call("profiles.list").then((result) => setProfiles(result.profiles)).catch((cause) => toast.error(errorMessage(cause)));
  }, [rpc]);
  useEffect(() => {
    refresh();
    void rpc.call("projects.list").then((result) => setProjects(result.projects)).catch(() => setProjects([]));
    void rpc.call("skills.list").then((result) => setSkillOptions(result.skills)).catch(() => setSkillOptions([]));
    void rpc.call("execution.default").then(setDefaultExecution).catch(() => setDefaultExecution(null));
  }, [refresh, rpc]);
  useRealtime(PROFILES_CHANGED, refresh);

  const save = async (draft: ProfileDraft) => {
    setBusy(true);
    try {
      if (editing === "new") await rpc.call("profiles.create", draft);
      else if (editing) await rpc.call("profiles.update", { id: editing, ...draft });
      setEditing(null);
      refresh();
      toast.success("Sidekick agent saved");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: Profile) => {
    if (!window.confirm(`Delete Sidekick agent "${profile.name}"?`)) return;
    setBusy(true);
    try {
      await rpc.call("profiles.delete", { id: profile.id });
      refresh();
      toast.success("Sidekick agent deleted");
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
            <h1 className="text-xl font-semibold">Agents</h1>
            <p className="mt-1 text-sm text-muted-foreground">Reusable agents for starting exactly one focused BB thread at a time.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}><Icon name="Plus" className="size-4" /> New agent</Button>
        </header>
        {profiles === null ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">Loading agents…</div>
        ) : profiles.length === 0 ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
            <p className="font-medium">No Sidekick agents yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Create the first agent when you are ready. Sidekick does not seed examples.</p>
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
          <DialogTitle>{editing === "new" ? "New Sidekick agent" : "Edit Sidekick agent"}</DialogTitle>
          <DialogDescription>Set instructions, execution defaults, and available skills.</DialogDescription>
          {editing === "new" || editingProfile ? (
            <ProfileEditor
              key={editing}
              initial={editing === "new" ? emptyProfile() : editingProfile!}
              skillOptions={skillOptions}
              defaultExecution={defaultExecution}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={(draft) => void save(draft)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </main>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sidekick",
    title: "Agents",
    icon: "UserRound",
    path: PANEL_PATH,
    component: SidekickPage,
  });
});
