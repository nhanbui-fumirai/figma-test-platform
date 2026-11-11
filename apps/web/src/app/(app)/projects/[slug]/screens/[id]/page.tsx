"use client";

import type { Preview, Screen } from "@figtest/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { JobLog } from "@/components/job-log";
import { ConfigForm } from "@/components/screen/config-form";
import { MocksPanel } from "@/components/screen/mocks-panel";
import { Badge, Button, ButtonLink, Card, CardHeader, Input, Loading, QueryError, Segmented, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate, pct01, pct100 } from "@/lib/format";

type Action = "preview" | "run" | "aiSteps" | "record" | "aiMocks";
type Running = { label: string; jobId: string; runId?: string };

/** One screen: its design, its config (URL, login, cookies, steps, prompt), previews, runs, mocks. */
export default function ScreenPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.projects.get(slug) });
  const screen = useQuery({ queryKey: ["screen", id], queryFn: () => api.screens.get(id) });
  const [running, setRunning] = useState<Running | null>(null);
  const [goal, setGoal] = useState("");

  const refresh = useCallback(() => {
    for (const key of [["screen", id], ["preview", id], ["mocks", id], ["mock"], ["screens", slug], ["runs", slug], ["jobs", slug]]) {
      qc.invalidateQueries({ queryKey: key });
    }
  }, [qc, id, slug]);

  const start = useMutation({
    mutationFn: async (action: Action): Promise<Running> => {
      switch (action) {
        case "preview": return { label: "Preview", jobId: (await api.screens.preview(id)).id };
        case "run": {
          const run = await api.runs.create(slug, { screenIds: [id], target: screen.data?.target ?? "site" });
          return { label: "Run", jobId: run.jobId, runId: run.id };
        }
        case "aiSteps": return { label: "AI steps", jobId: (await api.ai.steps(id, goal.trim() ? { goal: goal.trim() } : {})).id };
        case "record": return { label: "Record mocks", jobId: (await api.mocks.record(id)).id };
        case "aiMocks": return { label: "AI mocks", jobId: (await api.ai.mocks(id)).id };
      }
    },
    onSuccess: (r) => setRunning(r),
  });

  if (screen.error) return <QueryError error={screen.error} />;
  if (!screen.data || !project.data) return project.error ? <QueryError error={project.error} /> : <Loading />;
  const s = screen.data;
  const busy = start.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/projects/${slug}/screens`} className="text-xs text-muted hover:text-text">← Screens</Link>
          <h2 className="truncate text-lg font-semibold" title={s.name}>{s.name}</h2>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>{s.groupPath.join(" / ") || "no section"}</span>
            <span>· {Math.round(s.width)}×{Math.round(s.designHeight)} · viewport {s.viewport.w}×{s.viewport.h}{s.scrolls ? " · scrolls" : ""}</span>
            {s.draft && <Badge tone="warn">draft</Badge>}
            {s.duplicateOf && <Badge tone="warn" title={`duplicate of ${s.duplicateOf}`}>duplicate</Badge>}
            {s.hidden && <Badge>hidden</Badge>}
            {s.missing && <Badge tone="bad">missing</Badge>}
            {s.lastResult && <StatusBadge status={s.lastResult.status} />}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => start.mutate("preview")}>Preview</Button>
          <Button disabled={busy} onClick={() => start.mutate("run")}>Run this screen</Button>
          <Button variant="ghost" disabled={busy} onClick={() => start.mutate("record")}>Record mocks</Button>
          <Button variant="ghost" disabled={busy} onClick={() => start.mutate("aiMocks")}>AI mocks</Button>
        </div>
      </div>

      {s.missing && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">This frame is gone from the design since the last import: it is kept for its reports.</p>
      )}

      <Card className="flex flex-wrap items-center gap-2 py-3">
        <span className="text-sm font-medium">AI steps</span>
        <Input className="min-w-60 flex-1" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Optional goal: open the size menu, pick the second tab…" maxLength={2000} />
        <Button variant="ghost" disabled={busy} onClick={() => start.mutate("aiSteps")}>Write the steps with AI</Button>
        <span className="w-full text-xs text-muted">The AI opens the page, compares it with the design and writes the steps (it uses the prompt below). Save your edits first: the form reloads after it.</span>
      </Card>
      <QueryError error={start.error} />

      {running && (
        <Card>
          <CardHeader title={running.label}>
            {running.runId && <ButtonLink size="sm" href={`/projects/${slug}/runs/${running.runId}`}>Open the run</ButtonLink>}
            <Button variant="subtle" size="sm" onClick={() => setRunning(null)}>Close</Button>
          </CardHeader>
          <JobLog key={running.jobId} jobId={running.jobId} onEnd={refresh} onCancel={running.runId ? () => api.runs.cancel(running.runId!) : undefined} />
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <DesignImage screen={s} />
          <PreviewCard screenId={id} />
          <LastResultCard screen={s} slug={slug} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ConfigForm key={`${s.id}-${s.updatedAt}`} screen={s} project={project.data} slug={slug} />
          <MocksPanel screenId={id} />
        </div>
      </div>
    </div>
  );
}

function DesignImage({ screen }: { screen: Screen }) {
  const [zoom, setZoom] = useState<"fit" | "100">("fit");
  const src = api.fileUrl(screen.imageUrl);
  return (
    <Card>
      <CardHeader title="Design">
        <Segmented value={zoom} onChange={setZoom} options={[{ value: "fit", label: "Fit" }, { value: "100", label: "100%" }]} />
        {src && <a href={src} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">Open</a>}
      </CardHeader>
      {src ? (
        <div className="max-h-[75vh] overflow-auto rounded-md border border-line bg-bg">
          <img src={src} alt={screen.name} style={zoom === "100" ? { width: screen.width, maxWidth: "none" } : undefined} className={zoom === "fit" ? "w-full" : ""} />
        </div>
      ) : (
        <p className="text-sm text-muted">No image for this frame yet (rendered by the import).</p>
      )}
    </Card>
  );
}

function PreviewCard({ screenId }: { screenId: string }) {
  const preview = useQuery({ queryKey: ["preview", screenId], queryFn: () => api.screens.lastPreview(screenId) });
  return (
    <Card>
      <CardHeader title="Last preview" />
      <QueryError error={preview.error} />
      {preview.isPending && <Loading />}
      {preview.data === null && <p className="text-sm text-muted">No preview yet. A preview opens the page like a test (state, login, mocks) without comparing it.</p>}
      {preview.data && <PreviewView p={preview.data} />}
    </Card>
  );
}

function PreviewView({ p }: { p: Preview }) {
  const shot = api.fileUrl(p.screenshotUrl);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2"><StatusBadge status={p.status} /><span className="text-xs text-muted">{fmtDate(p.at)}</span></div>
      {p.reason && <p className={p.status === "ok" ? "text-muted" : "text-warn"}>{p.reason}</p>}
      {p.finalUrl && <div className="text-xs break-all">Final URL: <a className="text-accent hover:underline" href={p.finalUrl} target="_blank" rel="noreferrer">{p.finalUrl}</a></div>}
      {p.unmocked.length > 0 && (
        <details className="rounded-md border border-warn/40">
          <summary className="cursor-pointer px-3 py-1.5 text-xs text-warn">{p.unmocked.length} call(s) not mocked</summary>
          <ul className="max-h-40 overflow-auto border-t border-line px-3 py-1.5 font-mono text-xs">{p.unmocked.map((u, i) => <li key={i} className="break-all">{u}</li>)}</ul>
        </details>
      )}
      {shot && (
        <a href={shot} target="_blank" rel="noreferrer" className="block max-h-[60vh] overflow-auto rounded-md border border-line bg-bg">
          <img src={shot} alt="Screenshot of the preview" className="w-full" />
        </a>
      )}
    </div>
  );
}

function LastResultCard({ screen, slug }: { screen: Screen; slug: string }) {
  const r = screen.lastResult;
  return (
    <Card>
      <CardHeader title="Last result" />
      {!r ? (
        <p className="text-sm text-muted">Not tested yet.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={r.status} />
          <span className="tabular-nums">coverage {pct01(r.coverage)}</span>
          <span className="tabular-nums">design {pct100(r.designScore)}</span>
          <span className="text-xs text-muted">{fmtDate(r.at)}</span>
          <div className="ml-auto flex gap-2">
            <ButtonLink size="sm" href={`/projects/${slug}/runs/${r.runId}`}>Run</ButtonLink>
            <ButtonLink size="sm" variant="primary" href={`/projects/${slug}/results/${r.id}`}>Report</ButtonLink>
          </div>
        </div>
      )}
    </Card>
  );
}
