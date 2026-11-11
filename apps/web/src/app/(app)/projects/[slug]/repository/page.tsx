"use client";

import type { Repository } from "@figtest/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { FileIcon, FolderIcon } from "@/components/icons";
import { JobLog } from "@/components/job-log";
import { Button, Card, CardHeader, Empty, Input, Label, Loading, QueryError, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fmtBytes, fmtDate } from "@/lib/format";

/** The source repository of the project: a read-only copy to browse (and for the AI to read). */
export default function RepositoryPage() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const repo = useQuery({ queryKey: ["repository", slug], queryFn: () => api.repository.get(slug) });
  const [jobId, setJobId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["repository", slug] });
    qc.invalidateQueries({ queryKey: ["repo-tree", slug] });
    qc.invalidateQueries({ queryKey: ["repo-file", slug] });
  }, [qc, slug]);
  const sync = useMutation({ mutationFn: () => api.repository.sync(slug), onSuccess: (job) => { setJobId(job.id); refresh(); } });
  const remove = useMutation({ mutationFn: () => api.repository.remove(slug), onSuccess: () => { setJobId(null); refresh(); } });

  if (repo.error) return <QueryError error={repo.error} />;
  if (repo.isPending) return <Loading />;
  const r = repo.data;
  const shownJob = jobId ?? (r?.status === "syncing" ? r.jobId : null);

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted">
        Read-only: the platform keeps a bare copy of the repository to browse it and to give the AI the code of the pages. It never writes or pushes to it.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <RepoForm key={r ? `${r.url}#${r.branch}` : "new"} slug={slug} repo={r} onSaved={refresh} />
        {r && (
          <Card>
            <CardHeader title="Copy">
              <Button onClick={() => sync.mutate()} disabled={sync.isPending || r.status === "syncing"}>{r.status === "syncing" ? "Syncing…" : "Sync"}</Button>
              <Button
                variant="danger" disabled={remove.isPending}
                onClick={() => { if (window.confirm("Remove the repository settings and its local copy?")) remove.mutate(); }}
              >
                Remove
              </Button>
            </CardHeader>
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted">Status</dt><dd><StatusBadge status={r.status} /></dd>
              <dt className="text-muted">Head</dt><dd className="font-mono text-xs">{r.headSha ? r.headSha.slice(0, 12) : "–"}</dd>
              <dt className="text-muted">Last synced</dt><dd>{fmtDate(r.lastSyncedAt)}</dd>
              <dt className="text-muted">Token</dt>
              <dd>
                {r.hasToken ? <span className="text-ok">GitHub token set</span> : <span className="text-muted">none — public repositories only</span>}
                {" · "}<Link className="text-accent hover:underline" href={`/projects/${slug}/settings#credentials`}>Settings</Link>
              </dd>
            </dl>
            {r.error && <p className="mt-2 rounded-md bg-bad/10 px-3 py-2 text-sm break-words text-bad">{r.error}</p>}
            <QueryError className="mt-2" error={sync.error ?? remove.error} />
          </Card>
        )}
      </div>

      {shownJob && (
        <Card>
          <CardHeader title="Sync" />
          <JobLog key={shownJob} jobId={shownJob} onEnd={refresh} />
        </Card>
      )}

      {r?.headSha ? <CodeBrowser slug={slug} /> : r && <Empty title="Not synced yet">Sync the repository to browse its code.</Empty>}
    </div>
  );
}

function RepoForm({ slug, repo, onSaved }: { slug: string; repo: Repository | null; onSaved: () => void }) {
  const [url, setUrl] = useState(repo?.url ?? "");
  const [branch, setBranch] = useState(repo?.branch ?? "main");
  const save = useMutation({ mutationFn: () => api.repository.put(slug, { url: url.trim(), branch: branch.trim() }), onSuccess: onSaved });
  return (
    <Card>
      <CardHeader title="Repository" />
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Label>HTTPS URL<Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/acme/website.git" required /></Label>
        <Label>Branch<Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" required /></Label>
        <p className="text-xs text-muted">A private repository needs a GitHub token (read-only, fine-grained: Contents read) in the Settings. Changing the URL or the branch drops the current copy.</p>
        <QueryError error={save.error} />
        <Button type="submit" className="self-start" disabled={save.isPending}>{save.isPending ? "Saving…" : repo ? "Save" : "Set the repository"}</Button>
      </form>
    </Card>
  );
}

function CodeBrowser({ slug }: { slug: string }) {
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const tree = useQuery({ queryKey: ["repo-tree", slug, dir], queryFn: () => api.repository.tree(slug, dir) });
  const content = useQuery({ queryKey: ["repo-file", slug, file], queryFn: () => api.repository.file(slug, file!), enabled: !!file });
  const parts = dir ? dir.split("/") : [];
  const entries = [...(tree.data ?? [])].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-4 py-2 text-sm">
        <button className="text-accent hover:underline" onClick={() => { setDir(""); setFile(null); }}>root</button>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted">/</span>
            <button className="text-accent hover:underline" onClick={() => { setDir(parts.slice(0, i + 1).join("/")); setFile(null); }}>{p}</button>
          </span>
        ))}
        {file && <span className="flex items-center gap-1"><span className="text-muted">/</span><span>{file.split("/").pop()}</span></span>}
      </div>
      <div className="grid min-h-96 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="max-h-[70vh] overflow-auto border-b border-line lg:border-r lg:border-b-0">
          <QueryError className="m-3" error={tree.error} />
          {tree.isPending && <Loading className="p-3" />}
          <ul className="py-1 text-sm">
            {dir && (
              <li>
                <button className="flex w-full items-center gap-2 px-4 py-1 text-left text-muted hover:bg-white/5" onClick={() => { setDir(parts.slice(0, -1).join("/")); setFile(null); }}>
                  <FolderIcon width={14} /> ..
                </button>
              </li>
            )}
            {entries.map((e) => (
              <li key={e.path}>
                <button
                  className={cn("flex w-full items-center gap-2 px-4 py-1 text-left hover:bg-white/5", file === e.path && "bg-accent/10")}
                  onClick={() => { if (e.type === "dir") { setDir(e.path); setFile(null); } else setFile(e.path); }}
                >
                  {e.type === "dir" ? <FolderIcon width={14} className="shrink-0 text-accent" /> : <FileIcon width={14} className="shrink-0 text-muted" />}
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  {e.type === "file" && <span className="text-xs text-muted">{fmtBytes(e.size)}</span>}
                </button>
              </li>
            ))}
            {tree.data?.length === 0 && <li className="px-4 py-2 text-muted">Empty folder.</li>}
          </ul>
        </div>
        <div className="min-w-0">
          {!file && <p className="p-4 text-sm text-muted">Pick a file to read it.</p>}
          {file && <QueryError className="m-3" error={content.error} />}
          {file && content.isPending && <Loading className="p-4" />}
          {content.data && file && (
            <div className="flex flex-col">
              <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-xs text-muted">
                <span className="font-mono text-text">{content.data.path}</span>
                <span>{fmtBytes(content.data.size)}</span>
                {content.data.truncated && <span className="text-warn">truncated: only the start of the file is shown</span>}
              </div>
              {content.data.binary
                ? <p className="p-4 text-sm text-muted">Binary file: not shown.</p>
                : <CodeView text={content.data.content} />}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function CodeView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return (
    <div className="max-h-[70vh] overflow-auto">
      <table className="font-mono text-xs leading-5">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="sticky left-0 bg-panel px-3 text-right align-top text-muted select-none tabular-nums">{i + 1}</td>
              <td className="pr-4 whitespace-pre">{l || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
