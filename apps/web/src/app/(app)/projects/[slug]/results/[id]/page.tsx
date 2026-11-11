"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { ReportViewer, asReport } from "@/components/report/report-viewer";
import { ButtonLink, Card, Loading, QueryError, Stat, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate, fmtDuration, pct01, pct100 } from "@/lib/format";

/** The report of one screen of a run. */
export default function ResultPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const data = useQuery({ queryKey: ["report", id], queryFn: () => api.results.report(id) });
  const report = useMemo(() => asReport(data.data?.report), [data.data]);

  if (data.error) return <QueryError error={data.error} />;
  if (!data.data) return <Loading label="Loading the report…" />;
  const { result: r, unmocked } = data.data;
  const s = report?.summary;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/projects/${slug}/runs/${r.runId}`} className="text-xs text-muted hover:text-text">← Run</Link>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            <Link href={`/projects/${slug}/screens/${r.screenId}`} className="truncate hover:text-accent">{r.screenName}</Link>
            <StatusBadge status={r.status} />
          </h2>
          <div className="text-xs text-muted">{r.groupPath.join(" / ")} · {fmtDate(r.createdAt)}</div>
          <div className="mt-1 text-xs break-all">
            {r.url ? <a className="text-accent hover:underline" href={r.url} target="_blank" rel="noreferrer">{r.url}</a> : <span className="text-muted">no URL</span>}
            {r.finalUrl && r.finalUrl !== r.url && <span className="text-muted"> → <a className="hover:underline" href={r.finalUrl} target="_blank" rel="noreferrer">{r.finalUrl}</a></span>}
          </div>
        </div>
        <ButtonLink size="sm" href={`/projects/${slug}/screens/${r.screenId}`}>Screen config</ButtonLink>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Coverage" value={pct01(r.coverage)} hint={r.counts ? `${r.counts.matched}/${r.counts.texts} texts found` : undefined} />
        <Stat label="Design score" value={pct100(r.designScore)} hint={r.counts ? `${r.counts.checks - r.counts.failed}/${r.counts.checks} checks pass` : undefined} />
        <Stat label="Missing texts" value={r.counts?.missing ?? "–"} tone={r.counts?.missing ? "warn" : undefined} />
        <Stat label="Failed checks" value={r.counts?.failed ?? "–"} tone={r.counts?.failed ? "bad" : undefined} />
        <Stat label="Fails by kind" value={s ? `${s.typographyFails} · ${s.containerFails} · ${s.spacingFails}` : "–"} hint="typography · container · spacing" />
        <Stat label="Unmocked calls" value={r.unmocked} tone={r.unmocked ? "warn" : undefined} />
        <Stat label="Duration" value={fmtDuration(r.durationMs)} />
      </div>

      {r.error && (
        <p className={`rounded-md border px-3 py-2 text-sm break-words ${r.status === "blocked" ? "border-warn/40 bg-warn/10 text-warn" : "border-bad/40 bg-bad/10 text-bad"}`}>
          {r.status === "blocked" ? "Blocked: " : "Error: "}{r.error}
        </p>
      )}
      {unmocked.length > 0 && (
        <details className="rounded-md border border-warn/40">
          <summary className="cursor-pointer px-3 py-1.5 text-sm text-warn">{unmocked.length} API call(s) went to the real API (not mocked)</summary>
          <ul className="max-h-48 overflow-auto border-t border-line px-3 py-1.5 font-mono text-xs">{unmocked.map((u, i) => <li key={i} className="break-all">{u}</li>)}</ul>
        </details>
      )}

      <Card className="p-3">
        <ReportViewer data={data.data} />
      </Card>
    </div>
  );
}
