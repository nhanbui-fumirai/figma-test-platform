"use client";

import { Cookies, type Cookie, type Project, type Screen, type ScreenTarget, type ScreenUpdate } from "@figtest/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { XIcon } from "@/components/icons";
import { Button, Card, CardHeader, ErrorText, Input, Label, QueryError, Select, Textarea, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { resolveScreenUrl, storyUrl } from "@/lib/format";
import { StepsEditor, fromStep, validateSteps, type StepDraft } from "./steps-editor";

type CookieRow = { uid: number; name: string; value: string; domain: string; path: string };
let uids = 0;
const cookieRow = (c?: Cookie): CookieRow => ({ uid: ++uids, name: c?.name ?? "", value: c?.value ?? "", domain: c?.domain ?? "", path: c?.path ?? "" });

/**
 * The config of a screen, saved with api.screens.update. Mount it with key={screen.updatedAt}: it starts from the saved
 * screen and starts over after each save (or after a job that changed the screen, like AI steps).
 */
export function ConfigForm({ screen, project, slug }: { screen: Screen; project: Project; slug: string }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(screen.url ?? "");
  const [requiresLogin, setRequiresLogin] = useState(screen.requiresLogin);
  const [cookies, setCookies] = useState<CookieRow[]>(() => screen.cookies.map(cookieRow));
  const [steps, setSteps] = useState<StepDraft[]>(() => screen.steps.map(fromStep));
  const [prompt, setPrompt] = useState(screen.prompt ?? "");
  const [target, setTarget] = useState<ScreenTarget>(screen.target);
  const [storyId, setStoryId] = useState(screen.storyId ?? "");
  const [hidden, setHidden] = useState(screen.hidden);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };

  const save = useMutation({
    mutationFn: (body: ScreenUpdate) => api.screens.update(screen.id, body),
    onSuccess: (s) => {
      qc.setQueryData(["screen", screen.id], s);
      qc.invalidateQueries({ queryKey: ["screens", slug] });
    },
  });

  function submit() {
    const errs: string[] = [];
    const st = validateSteps(steps);
    if (!st.ok) errs.push(...st.errors);
    const rows = cookies.filter((c) => c.name.trim() || c.value || c.domain.trim() || c.path.trim());
    const ck = Cookies.safeParse(rows.map((c) => ({
      name: c.name.trim(), value: c.value,
      ...(c.domain.trim() ? { domain: c.domain.trim() } : {}), ...(c.path.trim() ? { path: c.path.trim() } : {}),
    })));
    if (!ck.success) errs.push(...ck.error.issues.map((i) => `Cookie ${typeof i.path[0] === "number" ? i.path[0] + 1 : ""}${i.path.length > 1 ? ` · ${String(i.path[1])}` : ""}: ${i.message}`));
    if (target === "storybook" && !storyId.trim()) errs.push("A Storybook screen needs a story id.");
    setErrors(errs);
    if (errs.length || !st.ok || !ck.success) return;
    save.mutate({
      url: url.trim() || null, requiresLogin, cookies: ck.data, steps: st.steps, prompt: prompt.trim() || null, target,
      storyId: storyId.trim() || null, hidden,
    });
  }

  const resolved = target === "storybook"
    ? project.storybookUrl && storyId.trim() ? storyUrl(project.storybookUrl, storyId.trim()) : null
    : resolveScreenUrl(project.baseUrl, url);

  return (
    <Card>
      <CardHeader title="Configuration">
        {dirty && <span className="text-xs text-warn">unsaved changes</span>}
        <Button onClick={submit} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
      </CardHeader>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <Label>Target
            <Select value={target} onChange={(e) => touch(setTarget)(e.target.value as ScreenTarget)}>
              <option value="site">Website</option>
              <option value="storybook">Storybook</option>
            </Select>
          </Label>
          {target === "site" ? (
            <Label>URL — absolute, or a path of the website
              <Input value={url} onChange={(e) => touch(setUrl)(e.target.value)} placeholder="/products/42 or https://…" />
            </Label>
          ) : (
            <Label>Story id
              <Input value={storyId} onChange={(e) => touch(setStoryId)(e.target.value)} placeholder="components-header--default" />
            </Label>
          )}
        </div>
        <p className="-mt-3 text-xs break-all text-muted">
          Opens: {resolved ? <a className="text-accent hover:underline" href={resolved} target="_blank" rel="noreferrer">{resolved}</a> : <i>{target === "storybook" && !project.storybookUrl ? "set the Storybook URL in Settings" : "no URL: the screen is left out of the runs"}</i>}
        </p>
        <div className="flex flex-col gap-2">
          <Toggle checked={requiresLogin} onChange={touch(setRequiresLogin)} label="Requires login" />
          {requiresLogin && (
            <p className="text-xs text-muted">
              The page opens signed in with the test login of the project — set it in{" "}
              <Link className="text-accent hover:underline" href={`/projects/${slug}/settings#test-login`}>Settings</Link>.
            </p>
          )}
          <Toggle checked={hidden} onChange={touch(setHidden)} label="Hidden (left out of the list and the runs)" />
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Cookies</h3>
          {cookies.length === 0 && <p className="text-xs text-muted">No cookie. A cookie is set before the page opens (a cart id, a consent flag).</p>}
          {cookies.map((c, i) => (
            <div key={c.uid} className="grid grid-cols-[1fr_1.5fr_1fr_0.7fr_auto] gap-2">
              <Input value={c.name} placeholder="name" onChange={(e) => touch(setCookies)(cookies.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input value={c.value} placeholder="value" onChange={(e) => touch(setCookies)(cookies.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <Input value={c.domain} placeholder="domain (URL host)" onChange={(e) => touch(setCookies)(cookies.map((x, j) => (j === i ? { ...x, domain: e.target.value } : x)))} />
              <Input value={c.path} placeholder="path" onChange={(e) => touch(setCookies)(cookies.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
              <Button variant="subtle" size="sm" aria-label="Remove the cookie" onClick={() => touch(setCookies)(cookies.filter((_, j) => j !== i))}><XIcon width={14} /></Button>
            </div>
          ))}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => touch(setCookies)([...cookies, cookieRow()])} disabled={cookies.length >= 50}>Add a cookie</Button>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Steps</h3>
          <p className="-mt-1 text-xs text-muted">Bring the page to the state of the design (open a menu, pick a tab…), in order, after it opens.</p>
          <StepsEditor steps={steps} onChange={touch(setSteps)} />
        </section>

        <Label>Prompt — what the AI should know about this screen (state, data, how to reach it)
          <Textarea rows={3} value={prompt} onChange={(e) => touch(setPrompt)(e.target.value)} maxLength={4000} placeholder="The cart has 2 items; the coupon field is open." />
        </Label>

        {errors.length > 0 && <ErrorText>{errors.map((e, i) => <span key={i} className="block">{e}</span>)}</ErrorText>}
        <QueryError error={save.error} />
      </form>
    </Card>
  );
}
