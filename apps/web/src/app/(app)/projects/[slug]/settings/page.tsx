"use client";

import type { AiSettings, CredentialInfo, CredentialKind, Project, ProjectUpdate } from "@figtest/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button, ButtonLink, Card, CardHeader, ErrorText, Input, Label, Loading, QueryError, Select, Stat, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";

/** Settings of the project: website, runs, AI, credentials (never shown back), test login, exports. */
export default function SettingsPage() {
  const { slug } = useParams<{ slug: string }>();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.projects.get(slug) });
  const credentials = useQuery({ queryKey: ["credentials", slug], queryFn: () => api.credentials.list(slug) });

  if (project.error) return <QueryError error={project.error} />;
  if (!project.data) return <Loading />;
  const p = project.data;
  const cred = (kind: CredentialKind) => credentials.data?.find((c) => c.kind === kind) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <ProjectForm key={`p-${p.updatedAt}`} project={p} />
        <RunsForm key={`r-${p.updatedAt}`} project={p} />
        <AiForm key={`a-${p.updatedAt}`} project={p} />
        <Card>
          <CardHeader title="Storybook mocks" />
          <p className="mb-3 text-sm text-muted">A zip of MSW handlers, fixtures and stories made from the mocks of the screens.</p>
          <ButtonLink href={api.storybook.exportUrl(slug)} download>Download the Storybook mocks</ButtonLink>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card id="credentials">
          <CardHeader title="Credentials" />
          <p className="mb-3 text-xs text-muted">Kept encrypted. They are never shown again: only their last characters.</p>
          <QueryError error={credentials.error} />
          {credentials.isPending && <Loading />}
          {credentials.data && (
            <div className="flex flex-col divide-y divide-line">
              <TokenRow
                slug={slug} kind="figma_token" info={cred("figma_token")} label="Figma access token"
                help="Figma › Settings › Security › Personal access tokens (file content: read). Used to import Figma links."
              />
              <TokenRow
                slug={slug} kind="github_token" info={cred("github_token")} label="GitHub token"
                help="Use a fine-grained token with read-only access (Contents: read) to this repository only."
              />
              <TokenRow slug={slug} kind="ai_key" info={cred("ai_key")} label="AI API key" help="The key of the AI provider chosen in the AI settings." />
            </div>
          )}
        </Card>
        <TestLoginForm key={cred("test_login")?.updatedAt ?? "none"} slug={slug} info={cred("test_login")} baseUrl={p.baseUrl} loaded={!!credentials.data} />
        <AiUsageCard slug={slug} />
      </div>
    </div>
  );
}

function useProjectUpdate(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectUpdate) => api.projects.update(slug, body),
    onSuccess: (p) => { qc.setQueryData(["project", slug], p); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });
}

function SaveRow({ pending, error, children }: { pending: boolean; error: unknown; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <QueryError error={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        {children}
      </div>
    </div>
  );
}

function ProjectForm({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [baseUrl, setBaseUrl] = useState(project.baseUrl);
  const [storybookUrl, setStorybookUrl] = useState(project.storybookUrl ?? "");
  const save = useProjectUpdate(project.slug);
  return (
    <Card id="project">
      <CardHeader title="Project" />
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); save.mutate({ name: name.trim(), baseUrl: baseUrl.trim(), storybookUrl: storybookUrl.trim().replace(/\/+$/, "") || null }); }}
      >
        <Label>Name<Input value={name} onChange={(e) => setName(e.target.value)} required /></Label>
        <Label>Website URL — the paths of the screens are joined to it<Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" required /></Label>
        <Label>Storybook URL (optional)<Input value={storybookUrl} onChange={(e) => setStorybookUrl(e.target.value)} placeholder="https://storybook.example.com" /></Label>
        <SaveRow pending={save.isPending} error={save.error} />
      </form>
    </Card>
  );
}

function RunsForm({ project }: { project: Project }) {
  const [include, setInclude] = useState(project.settings.apiInclude.join("\n"));
  const [concurrency, setConcurrency] = useState(String(project.settings.runConcurrency));
  const save = useProjectUpdate(project.slug);
  return (
    <Card id="runs">
      <CardHeader title="Runs and API calls" />
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const apiInclude = include.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          save.mutate({ settings: { apiInclude, runConcurrency: Number(concurrency) } });
        }}
      >
        <Label>
          API calls to record and mock — URL globs, one per line (empty: the fetch / XHR calls to the website host)
          <Textarea mono rows={4} value={include} onChange={(e) => setInclude(e.target.value)} placeholder={"**/api/**\n**/graphql"} />
        </Label>
        <Label>Screens tested at the same time (1–8)<Input className="w-24" type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} /></Label>
        <SaveRow pending={save.isPending} error={save.error} />
      </form>
    </Card>
  );
}

function AiForm({ project }: { project: Project }) {
  const [provider, setProvider] = useState<AiSettings["provider"] | "">(project.settings.ai?.provider ?? "");
  const [model, setModel] = useState(project.settings.ai?.model ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useProjectUpdate(project.slug);
  return (
    <Card id="ai">
      <CardHeader title="AI" />
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (provider && !model.trim()) { setError("Give the model of the provider."); return; }
          setError(null);
          save.mutate({ settings: { ai: provider ? { provider, model: model.trim() } : null } });
        }}
      >
        <div className="grid grid-cols-[160px_1fr] gap-3">
          <Label>Provider
            <Select value={provider} onChange={(e) => setProvider(e.target.value as AiSettings["provider"] | "")}>
              <option value="">None (AI off)</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
            </Select>
          </Label>
          <Label>Model<Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id of the provider" disabled={!provider} /></Label>
        </div>
        <p className="text-xs text-muted">The AI writes steps and mocks of the screens. Its key is the AI API key credential.</p>
        <ErrorText>{error}</ErrorText>
        <SaveRow pending={save.isPending} error={save.error} />
      </form>
    </Card>
  );
}

function TokenRow({ slug, kind, info, label, help }: {
  slug: string; kind: "figma_token" | "github_token" | "ai_key"; info: CredentialInfo | null; label: string; help: string;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const done = () => { setValue(""); qc.invalidateQueries({ queryKey: ["credentials", slug] }); qc.invalidateQueries({ queryKey: ["repository", slug] }); };
  const put = useMutation({ mutationFn: () => api.credentials.put(slug, { kind, value: value.trim() }), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api.credentials.remove(slug, kind), onSuccess: done });
  return (
    <form className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" onSubmit={(e) => { e.preventDefault(); put.mutate(); }}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        {info
          ? <span className="text-xs text-ok">set · …{info.hint} · {fmtDate(info.updatedAt)}</span>
          : <span className="text-xs text-muted">not set</span>}
      </div>
      <div className="flex gap-2">
        <Input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={info ? "Paste a new value to replace it" : "Paste the token"} />
        <Button type="submit" disabled={put.isPending || !value.trim()}>Save</Button>
        {info && (
          <Button variant="danger" disabled={remove.isPending} onClick={() => { if (window.confirm(`Remove the ${label}?`)) remove.mutate(); }}>Remove</Button>
        )}
      </div>
      <p className="text-xs text-muted">{help}</p>
      <QueryError error={put.error ?? remove.error} />
    </form>
  );
}

const metaString = (info: CredentialInfo | null, key: string) => {
  const v = info?.meta[key];
  return typeof v === "string" ? v : "";
};

function TestLoginForm({ slug, info, baseUrl, loaded }: { slug: string; info: CredentialInfo | null; baseUrl: string; loaded: boolean }) {
  const qc = useQueryClient();
  const [loginUrl, setLoginUrl] = useState(metaString(info, "loginUrl"));
  const [username, setUsername] = useState(info?.hint ?? "");
  const [password, setPassword] = useState("");
  const [usernameSelector, setUsernameSelector] = useState(metaString(info, "usernameSelector"));
  const [passwordSelector, setPasswordSelector] = useState(metaString(info, "passwordSelector"));
  const [submitSelector, setSubmitSelector] = useState(metaString(info, "submitSelector"));
  const [successSelector, setSuccessSelector] = useState(metaString(info, "successSelector"));
  const done = () => { setPassword(""); qc.invalidateQueries({ queryKey: ["credentials", slug] }); };
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  const put = useMutation({
    mutationFn: () => api.credentials.put(slug, {
      kind: "test_login",
      value: {
        loginUrl: loginUrl.trim(), username: username.trim(), password,
        usernameSelector: opt(usernameSelector), passwordSelector: opt(passwordSelector), submitSelector: opt(submitSelector), successSelector: opt(successSelector),
      },
    }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.credentials.remove(slug, "test_login"), onSuccess: done });
  let host = "";
  try { host = new URL(baseUrl).host; } catch { /* the base URL is checked by the api */ }

  return (
    <Card id="test-login">
      <CardHeader title="Test login">
        {info ? <span className="text-xs text-ok">set · {info.hint} · {fmtDate(info.updatedAt)}</span> : loaded && <span className="text-xs text-muted">not set</span>}
      </CardHeader>
      <p className="mb-3 text-xs text-muted">
        The account the screens that require a login are opened with. The password is only ever typed on the website host
        {host && <> (<span className="font-mono">{host}</span>)</>}: the login URL must be on it. It is kept encrypted and never shown again.
      </p>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); put.mutate(); }}>
        <Label>Login URL<Input value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} placeholder={`${baseUrl.replace(/\/+$/, "")}/login`} required /></Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label>User name<Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required /></Label>
          <Label>Password<Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={info ? "type it again to save" : ""} required /></Label>
        </div>
        <details>
          <summary className="cursor-pointer text-xs text-muted">Selectors (optional: found by themselves most of the time)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Label>User name field<Input value={usernameSelector} onChange={(e) => setUsernameSelector(e.target.value)} placeholder="#email" /></Label>
            <Label>Password field<Input value={passwordSelector} onChange={(e) => setPasswordSelector(e.target.value)} placeholder="#password" /></Label>
            <Label>Submit button<Input value={submitSelector} onChange={(e) => setSubmitSelector(e.target.value)} placeholder="button[type=submit]" /></Label>
            <Label>Signed in when visible<Input value={successSelector} onChange={(e) => setSuccessSelector(e.target.value)} placeholder="text=My account" /></Label>
          </div>
        </details>
        <QueryError error={put.error ?? remove.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={put.isPending}>{put.isPending ? "Saving…" : "Save the test login"}</Button>
          {info && <Button variant="danger" disabled={remove.isPending} onClick={() => { if (window.confirm("Remove the test login?")) remove.mutate(); }}>Remove</Button>}
        </div>
      </form>
    </Card>
  );
}

function AiUsageCard({ slug }: { slug: string }) {
  const usage = useQuery({ queryKey: ["ai-usage", slug], queryFn: () => api.ai.usage(slug) });
  return (
    <Card>
      <CardHeader title="AI usage" />
      <QueryError error={usage.error} />
      {usage.isPending && <Loading />}
      {usage.data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Calls" value={usage.data.calls.toLocaleString()} />
          <Stat label="Input tokens" value={usage.data.inputTokens.toLocaleString()} />
          <Stat label="Output tokens" value={usage.data.outputTokens.toLocaleString()} />
          <Stat label="Cost" value={usage.data.costUsd === null ? "–" : `$${usage.data.costUsd.toFixed(2)}`} />
        </div>
      )}
    </Card>
  );
}
