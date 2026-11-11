"use client";

import type { FigmaImport } from "@figtest/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { UploadIcon } from "@/components/icons";
import { JobLog } from "@/components/job-log";
import { Button, Card, CardHeader, Empty, ErrorText, Input, Loading, Progress, QueryError, Stat, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { errorMessage, fmtBytes, fmtDate, isActive } from "@/lib/format";

/** Figma design of the project: a .fig upload or a Figma link, the imports and their logs. */
export default function DesignPage() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const imports = useQuery({
    queryKey: ["imports", slug], queryFn: () => api.imports.list(slug),
    refetchInterval: (q) => (q.state.data?.some((i) => isActive(i.status)) ? 3000 : false),
  });
  const [picked, setPicked] = useState<string | null>(null);
  const shown = imports.data?.find((i) => i.id === picked) ?? imports.data?.find((i) => isActive(i.status)) ?? imports.data?.[0] ?? null;

  const refresh = useCallback(() => {
    for (const key of ["imports", "groups", "screens", "jobs"]) qc.invalidateQueries({ queryKey: [key, slug] });
  }, [qc, slug]);

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (f: File) => api.imports.uploadFig(slug, f, f.name),
    onSuccess: (imp) => { setPicked(imp.id); setFile(null); refresh(); },
  });
  const pickFile = (f: File) => {
    if (!/\.fig$/i.test(f.name)) { setFileError(`${f.name}: not a .fig file`); return; }
    setFileError(null);
    setFile(f);
    upload.mutate(f);
  };

  const [link, setLink] = useState("");
  const fromLink = useMutation({
    mutationFn: () => api.imports.fromLink(slug, { url: link.trim() }),
    onSuccess: (imp) => { setPicked(imp.id); setLink(""); refresh(); },
  });
  const linkError = errorMessage(fromLink.error);
  const needsToken = !!linkError && /token/i.test(linkError);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Upload a .fig file" />
          <DropZone onFile={pickFile} disabled={upload.isPending} />
          {upload.isPending && file && (
            <div className="mt-3 flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-2"><span className="truncate">Uploading {file.name}…</span><span className="text-muted">{fmtBytes(file.size)}</span></div>
              <Progress indeterminate />
            </div>
          )}
          <ErrorText className="mt-3">{fileError}</ErrorText>
          <QueryError className="mt-3" error={upload.error} />
        </Card>

        <Card>
          <CardHeader title="Import a Figma link" />
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); fromLink.mutate(); }}>
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://www.figma.com/design/<key>/<name>?node-id=1-2" required />
            <p className="text-xs text-muted">Reads the file with the Figma REST API: the project needs a Figma access token.</p>
            <Button type="submit" className="self-start" disabled={fromLink.isPending || !link.trim()}>{fromLink.isPending ? "Starting…" : "Import"}</Button>
          </form>
          {linkError && (
            <ErrorText className="mt-3">
              {linkError}
              {needsToken && <> — <Link className="underline" href={`/projects/${slug}/settings#credentials`}>open the Settings</Link></>}
            </ErrorText>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Imports" />
        <QueryError error={imports.error} />
        {imports.isPending && <Loading />}
        {imports.data?.length === 0 && <Empty title="No import yet">Upload a .fig file (Figma: File › Save local copy…) or import a Figma link.</Empty>}
        {!!imports.data?.length && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <ul className="max-h-[32rem] divide-y divide-line overflow-auto text-sm">
              {imports.data.map((i) => (
                <li key={i.id}>
                  <button
                    className={cn("flex w-full flex-col gap-1 rounded px-2 py-2 text-left hover:bg-white/5", i.id === shown?.id && "bg-accent/10")}
                    onClick={() => setPicked(i.id)}
                  >
                    <div className="flex w-full items-center gap-2">
                      <StatusBadge status={i.status} />
                      <span className="min-w-0 flex-1 truncate font-medium">{i.fileName}</span>
                      <span className="text-xs text-muted">{i.source === "fig" ? ".fig upload" : "Figma link"}</span>
                    </div>
                    <div className="text-xs text-muted">
                      {fmtDate(i.createdAt)}
                      {i.stats && ` · ${i.stats.frames} frames · +${i.stats.created} ~${i.stats.updated} −${i.stats.removed}`}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {shown && <ImportDetail key={shown.id} imp={shown} onEnd={refresh} />}
          </div>
        )}
      </Card>
    </div>
  );
}

function ImportDetail({ imp, onEnd }: { imp: FigmaImport; onEnd: () => void }) {
  const s = imp.stats;
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm">
        <span className="font-medium">{imp.fileName}</span>
        {imp.fileKey && <span className="ml-2 text-xs text-muted">key {imp.fileKey}</span>}
      </div>
      {s ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Pages" value={s.pages} />
            <Stat label="Sections" value={s.sections} />
            <Stat label="Frames" value={s.frames} />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Stat label="Created" value={s.created} tone={s.created ? "ok" : undefined} />
            <Stat label="Updated" value={s.updated} tone={s.updated ? "accent" : undefined} />
            <Stat label="Unchanged" value={s.unchanged} />
            <Stat label="Removed" value={s.removed} tone={s.removed ? "warn" : undefined} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Images rendered" value={s.rendered} />
            <Stat label="Render failed" value={s.renderFailed} tone={s.renderFailed ? "bad" : undefined} />
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">{isActive(imp.status) ? "Stats come when the import ends." : "No stats for this import."}</p>
      )}
      {imp.jobId ? <JobLog key={imp.jobId} jobId={imp.jobId} onEnd={onEnd} /> : <p className="text-xs text-muted">No job for this import.</p>}
    </div>
  );
}

function DropZone({ onFile, disabled }: { onFile: (f: File) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f && !disabled) onFile(f); }}
      className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition", over ? "border-accent bg-accent/5" : "border-line")}
    >
      <UploadIcon className="text-muted" width={22} height={22} />
      <p className="text-sm">Drop a <b>.fig</b> file here</p>
      <p className="text-xs text-muted">Figma: File › Save local copy…</p>
      <Button variant="ghost" size="sm" onClick={() => input.current?.click()} disabled={disabled}>Choose a file</Button>
      <input
        ref={input} type="file" accept=".fig" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
      />
    </div>
  );
}
