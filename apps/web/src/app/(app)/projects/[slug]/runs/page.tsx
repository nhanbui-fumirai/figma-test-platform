"use client";

import type { ScreenTarget } from "@figtest/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CardHeader, Empty, Loading, Progress, QueryError, Select, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { between, fmtDate, fmtDuration, isActive } from "@/lib/format";

/** Runs of the project: start one, the list with progress and counts. */
export default function RunsPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: ["runs", slug], queryFn: () => api.runs.list(slug),
    refetchInterval: (q) => (q.state.data?.some((r) => isActive(r.status)) ? 2000 : false),
  });
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.projects.get(slug) });
  const [target, setTarget] = useState<ScreenTarget>("site");
  const start = useMutation({
    mutationFn: () => api.runs.create(slug, { target }),
    onSuccess: (run) => { qc.invalidateQueries({ queryKey: ["runs", slug] }); router.push(`/projects/${slug}/runs/${run.id}`); },
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Start a run" />
        <div className="flex flex-wrap items-center gap-3">
          <Select value={target} onChange={(e) => setTarget(e.target.value as ScreenTarget)} aria-label="Target">
            <option value="site">Website — every visible screen with a URL</option>
            <option value="storybook" disabled={!project.data?.storybookUrl}>Storybook — every visible screen with a story id</option>
          </Select>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? "Starting…" : "Start the run"}</Button>
          <span className="text-xs text-muted">To test some screens only, select them in the Screens tab.</span>
        </div>
        <QueryError className="mt-3" error={start.error} />
      </Card>

      <Card>
        <CardHeader title="Runs" />
        <QueryError error={runs.error} />
        {runs.isPending && <Loading />}
        {runs.data?.length === 0 && <Empty title="No run yet">A run opens every screen on the website and compares it with its design.</Empty>}
        {!!runs.data?.length && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-normal">Status</th>
                  <th className="py-2 pr-3 font-normal">Started</th>
                  <th className="py-2 pr-3 font-normal">Target</th>
                  <th className="w-48 py-2 pr-3 font-normal">Progress</th>
                  <th className="py-2 pr-3 text-right font-normal">Passed</th>
                  <th className="py-2 pr-3 text-right font-normal">Failed</th>
                  <th className="py-2 pr-3 text-right font-normal">Blocked</th>
                  <th className="py-2 pr-3 text-right font-normal">Errors</th>
                  <th className="py-2 text-right font-normal">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {runs.data.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-white/5" onClick={() => router.push(`/projects/${slug}/runs/${r.id}`)}>
                    <td className="py-2 pr-3"><StatusBadge status={r.status} /></td>
                    <td className="py-2 pr-3"><Link href={`/projects/${slug}/runs/${r.id}`} className="hover:text-accent" onClick={(e) => e.stopPropagation()}>{fmtDate(r.createdAt)}</Link></td>
                    <td className="py-2 pr-3 text-muted">{r.target}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2"><Progress className="flex-1" value={r.done} max={r.total} /><span className="text-xs text-muted tabular-nums">{r.done}/{r.total}</span></div>
                    </td>
                    <td className="py-2 pr-3 text-right text-ok tabular-nums">{r.passed}</td>
                    <td className="py-2 pr-3 text-right text-bad tabular-nums">{r.failed}</td>
                    <td className="py-2 pr-3 text-right text-warn tabular-nums">{r.blocked}</td>
                    <td className="py-2 pr-3 text-right text-bad tabular-nums">{r.errors}</td>
                    <td className="py-2 text-right text-muted tabular-nums">{fmtDuration(between(r.createdAt, r.endedAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
