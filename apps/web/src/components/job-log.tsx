"use client";

import { JobEvent, type Job, type JobLogLine } from "@figtest/contracts";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/format";
import { Button, ErrorText, Progress, StatusBadge } from "./ui";

const LEVEL: Record<string, string> = { debug: "text-muted", info: "text-text", warn: "text-warn", error: "text-bad" };
const ENDED = ["succeeded", "failed", "cancelled"];

/**
 * Live logs and progress of a job (SSE). The browser reconnects by itself after a network drop and sends the id of the
 * last line it got (Last-Event-ID): the api sends only the lines after it, nothing is shown twice.
 * onEnd is called once, when the job is seen ended (also right away for a job that ended before); it may change between
 * renders without reopening the stream. onCancel replaces the default cancel (api.jobs.cancel).
 */
export function JobLog({ jobId, onEnd, onCancel, className }: {
  jobId: string; onEnd?: (job: Job) => void; onCancel?: () => Promise<unknown>; className?: string;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [lines, setLines] = useState<JobLogLine[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const onEndRef = useRef(onEnd);
  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);

  useEffect(() => {
    setLines([]);
    setJob(null);
    let ended = false;
    const es = new EventSource(api.jobs.eventsUrl(jobId), { withCredentials: true });
    es.onmessage = (msg) => {
      let data: unknown;
      try { data = JSON.parse(msg.data); } catch { return; }
      const event = JobEvent.safeParse(data);
      if (!event.success) return;
      if (event.data.type === "log") {
        const line = event.data.line;
        setLines((l) => (l.some((x) => x.id === line.id) ? l : [...l, line]));
      } else {
        const j = event.data.job;
        setJob(j);
        if (!ended && ENDED.includes(j.status)) { ended = true; onEndRef.current?.(j); }
      }
    };
    // the stream ends with the job: do not reconnect then
    es.onerror = () => { if (ended) es.close(); };
    return () => es.close();
  }, [jobId]);

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [lines.length]);

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try { await (onCancel ? onCancel() : api.jobs.cancel(jobId)); } catch (e) { setCancelError(errorMessage(e)); } finally { setCancelling(false); }
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-3 text-sm">
        {job && <StatusBadge status={job.status} />}
        <span className="text-muted">{job ? `${job.kind} · ${job.done}/${job.total}` : "connecting…"}</span>
        {job && ["queued", "running"].includes(job.status) && (
          <Button variant="ghost" size="sm" className="ml-auto" disabled={cancelling} onClick={cancel}>Cancel</Button>
        )}
      </div>
      <Progress value={job?.done ?? 0} max={job?.total ?? 0} />
      <ErrorText>{cancelError}</ErrorText>
      {job?.error && <ErrorText>{job.error}</ErrorText>}
      <div ref={box} className="h-64 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs leading-5">
        {lines.map((l) => (
          <div key={l.id} className={cn("break-words", LEVEL[l.level])}>
            <span className="text-muted">{new Date(l.at).toLocaleTimeString()} </span>{l.message}
          </div>
        ))}
        {!lines.length && <div className="text-muted">No log line yet.</div>}
      </div>
    </div>
  );
}
