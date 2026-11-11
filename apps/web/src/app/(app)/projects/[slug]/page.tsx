"use client";

import type { ScreenListQuery } from "@figtest/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { JobLog } from "@/components/job-log";
import { Button, ButtonLink, Card, CardHeader, Empty, Loading, Progress, QueryError, Stat, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { between, fmtAgo, fmtDate, fmtDuration, isActive } from "@/lib/format";

/** Project overview: screen counts, the last run, recent jobs with their live logs, quick actions. */
export default function OverviewPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: ["runs", slug], queryFn: () => api.runs.list(slug),
    refetchInterval: (q) => (q.state.data?.some((r) => isActive(r.status)) ? 3000 : false),
  });
  const jobs = useQuery({
    queryKey: ["jobs", slug], queryFn: () => api.jobs.listForProject(slug),
    refetchInterval: (q) => (q.state.data?.some((j) => isActive(j.status)) ? 3000 : false),
  });
  const [picked, setPicked] = useState<string | null>(null);
  const shown = picked ?? jobs.data?.[0]?.id ?? null;
  const startRun = useMutation({
    mutationFn: () => api.runs.create(slug, {}),
    onSuccess: (run) => { qc.invalidateQueries({ queryKey: ["runs", slug] }); router.push(`/projects/${slug}/runs/${run.id}`); },
  });
  const refresh = useCallback(() => {
    for (const key of ["jobs", "runs", "screens", "imports", "groups"]) qc.invalidateQueries({ queryKey: [key, slug] });
  }, [qc, slug]);

  const lastRun = runs.data?.[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Count slug={slug} label="Screens" query={{}} hint="visible, without drafts" />
        <Count slug={slug} label="With a URL" query={{ hasUrl: "yes" }} hint="ready to test" />
        <Count slug={slug} label="Hidden" query={{ hidden: "yes", drafts: "show" }} hint="hidden or missing" />
        <Count slug={slug} label="Drafts & duplicates" query={{ drafts: "show" }} minus={{}} hint="left out of runs" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Last run">
            {lastRun && <Link className="text-sm text-accent hover:underline" href={`/projects/${slug}/runs`}>All runs</Link>}
          </CardHeader>
          <QueryError error={runs.error} />
          {runs.isPending && <Loading />}
          {runs.data && !lastRun && (
            <Empty title="No run yet">Give the screens a URL, then start a run to compare the website with the design.</Empty>
          )}
          {lastRun && (
            <Link href={`/projects/${slug}/runs/${lastRun.id}`} className="block rounded-md border border-line p-3 transition hover:border-accent">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <StatusBadge status={lastRun.status} />
                <span className="text-muted">{lastRun.target} · {fmtDate(lastRun.createdAt)}</span>
                <span className="ml-auto text-xs text-muted">{fmtDuration(between(lastRun.createdAt, lastRun.endedAt))}</span>
              </div>
              <Progress className="my-3" value={lastRun.done} max={lastRun.total} />
              <div className="flex flex-wrap gap-4 text-sm tabular-nums">
                <span>{lastRun.done}/{lastRun.total} done</span>
                <span className="text-ok">{lastRun.passed} passed</span>
                <span className="text-bad">{lastRun.failed} failed</span>
                <span className="text-warn">{lastRun.blocked} blocked</span>
                <span className="text-bad">{lastRun.errors} errors</span>
              </div>
            </Link>
          )}
        </Card>

        <Card className="flex flex-col gap-2">
          <CardHeader title="Quick actions" className="mb-1" />
          <ButtonLink href={`/projects/${slug}/design`} className="w-full">Import the design</ButtonLink>
          <ButtonLink href={`/projects/${slug}/screens?hasUrl=no`} className="w-full">Screens without a URL</ButtonLink>
          <Button onClick={() => startRun.mutate()} disabled={startRun.isPending}>{startRun.isPending ? "Starting…" : "Start a run (all screens with a URL)"}</Button>
          <QueryError error={startRun.error} />
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent jobs" />
        <QueryError error={jobs.error} />
        {jobs.isPending && <Loading />}
        {jobs.data?.length === 0 && <Empty title="No job yet">Imports, previews, recordings, AI and runs show up here with their logs.</Empty>}
        {!!jobs.data?.length && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <ul className="max-h-[22rem] divide-y divide-line overflow-auto text-sm">
              {jobs.data.slice(0, 30).map((j) => (
                <li key={j.id}>
                  <button
                    className={cn("flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-white/5", j.id === shown && "bg-accent/10")}
                    onClick={() => setPicked(j.id)}
                  >
                    <StatusBadge status={j.status} />
                    <span className="min-w-0 flex-1 truncate">{j.kind}</span>
                    <span className="text-xs text-muted tabular-nums">{j.done}/{j.total}</span>
                    <span className="w-20 text-right text-xs text-muted">{fmtAgo(j.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {shown && <JobLog key={shown} jobId={shown} onEnd={refresh} />}
          </div>
        )}
      </Card>
    </div>
  );
}

/** a screen count: the total of a list query (minus the total of another one) */
function Count({ slug, label, query, minus, hint }: { slug: string; label: string; query: ScreenListQuery; minus?: ScreenListQuery; hint?: string }) {
  const a = useQuery({ queryKey: ["screens", slug, "count", query], queryFn: () => api.screens.list(slug, { ...query, pageSize: 1 }) });
  const b = useQuery({
    queryKey: ["screens", slug, "count", minus ?? null], enabled: !!minus,
    queryFn: () => api.screens.list(slug, { ...minus, pageSize: 1 }),
  });
  const value = a.error ? "!" : a.data && (!minus || b.data) ? a.data.total - (minus ? b.data?.total ?? 0 : 0) : "…";
  return <Stat label={label} value={value} hint={a.error ? a.error.message : hint} tone={a.error ? "bad" : undefined} />;
}
