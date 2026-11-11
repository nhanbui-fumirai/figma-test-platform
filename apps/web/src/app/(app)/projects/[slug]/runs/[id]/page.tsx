"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { JobLog } from "@/components/job-log";
import { Button, Card, CardHeader, Empty, Input, Loading, Progress, QueryError, Select, Stat, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { between, fmtDate, fmtDuration, isActive, pct01, pct100 } from "@/lib/format";

const STATUSES = ["queued", "running", "passed", "failed", "blocked", "error", "skipped"] as const;

/** One run: summary, live log, the result of each screen. */
export default function RunPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const run = useQuery({
    queryKey: ["run", id], queryFn: () => api.runs.get(id),
    refetchInterval: (q) => (isActive(q.state.data?.status) ? 2000 : false),
  });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const onEnd = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["run", id] });
    qc.invalidateQueries({ queryKey: ["runs", slug] });
    qc.invalidateQueries({ queryKey: ["screens", slug] });
  }, [qc, id, slug]);
  const cancel = useMutation({ mutationFn: () => api.runs.cancel(id), onSuccess: onEnd });

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (run.data?.results ?? []).filter((r) =>
      (!status || r.status === status)
      && (!needle || [r.screenName, r.url ?? "", r.finalUrl ?? "", r.groupPath.join(" / ")].some((x) => x.toLowerCase().includes(needle))));
  }, [run.data, q, status]);

  if (run.error) return <QueryError error={run.error} />;
  if (!run.data) return <Loading />;
  const r = run.data;
  const active = isActive(r.status);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/projects/${slug}/runs`} className="text-xs text-muted hover:text-text">← Runs</Link>
          <h2 className="flex items-center gap-2 text-lg font-semibold">Run of {fmtDate(r.createdAt)} <StatusBadge status={r.status} /></h2>
        </div>
        {active && <Button variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel the run</Button>}
      </div>
      <QueryError error={cancel.error} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Target" value={r.target} />
        <Stat label="Done" value={`${r.done}/${r.total}`} hint={<Progress value={r.done} max={r.total} className="mt-1" />} />
        <Stat label="Passed" value={r.passed} tone="ok" />
        <Stat label="Failed" value={r.failed} tone={r.failed ? "bad" : undefined} />
        <Stat label="Blocked" value={r.blocked} tone={r.blocked ? "warn" : undefined} />
        <Stat label="Errors" value={r.errors} tone={r.errors ? "bad" : undefined} />
        <Stat label="Time" value={fmtDuration(between(r.createdAt, r.endedAt))} />
        <Stat label="Ended" value={r.endedAt ? new Date(r.endedAt).toLocaleTimeString() : "–"} />
      </div>

      <Card>
        <CardHeader title="Log" />
        <JobLog jobId={r.jobId} onEnd={onEnd} onCancel={() => api.runs.cancel(id)} />
      </Card>

      <Card>
        <CardHeader title={`Results (${results.length}${results.length !== r.results.length ? ` of ${r.results.length}` : ""})`}>
          <Input className="w-64" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a screen or a URL" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </CardHeader>
        {r.results.length === 0 && <Empty title="No result">This run has no screen.</Empty>}
        {r.results.length > 0 && results.length === 0 && <p className="text-sm text-muted">No result matches.</p>}
        {results.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-normal">Screen</th>
                  <th className="py-2 pr-3 font-normal">URL</th>
                  <th className="py-2 pr-3 font-normal">Status</th>
                  <th className="py-2 pr-3 text-right font-normal">Coverage</th>
                  <th className="py-2 pr-3 text-right font-normal">Design</th>
                  <th className="py-2 pr-3 text-right font-normal" title="design texts not found on the page">Missing</th>
                  <th className="py-2 pr-3 text-right font-normal" title="failed checks">Failed</th>
                  <th className="py-2 pr-3 text-right font-normal" title="API calls not mocked">Unmocked</th>
                  <th className="py-2 text-right font-normal">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {results.map((x) => {
                  const open = !isActive(x.status) && x.status !== "skipped";
                  return (
                    <tr
                      key={x.id} className={open ? "cursor-pointer hover:bg-white/5" : ""}
                      onClick={() => { if (open) router.push(`/projects/${slug}/results/${x.id}`); }}
                    >
                      <td className="max-w-72 py-2 pr-3">
                        <div className="truncate font-medium" title={x.screenName}>{x.screenName}</div>
                        <div className="truncate text-xs text-muted">{x.groupPath.join(" / ")}</div>
                      </td>
                      <td className="max-w-80 py-2 pr-3 text-xs">
                        <div className="truncate" title={x.url ?? undefined}>{x.url ?? "–"}</div>
                        {x.finalUrl && x.finalUrl !== x.url && <div className="truncate text-muted" title={x.finalUrl}>→ {x.finalUrl}</div>}
                        {x.error && <div className="truncate text-warn" title={x.error}>{x.error}</div>}
                      </td>
                      <td className="py-2 pr-3"><StatusBadge status={x.status} /></td>
                      <td className="py-2 pr-3 text-right tabular-nums">{pct01(x.coverage)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{pct100(x.designScore)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{x.counts?.missing ?? "–"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{x.counts ? `${x.counts.failed}/${x.counts.checks}` : "–"}</td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${x.unmocked ? "text-warn" : ""}`}>{x.unmocked}</td>
                      <td className="py-2 text-right text-muted tabular-nums">{fmtDuration(x.durationMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
