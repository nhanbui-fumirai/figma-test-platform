"use client";

import type { MockOp, MockRoute, MockRouteSummary } from "@figtest/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, Drawer, Empty, ErrorText, Input, Label, Loading, Modal, QueryError, Select, Textarea, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ORIGIN_TONE = { recorded: "muted", ai: "accent", manual: "ok" } as const;

const json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));
function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: null };
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: `not valid JSON: ${(e as Error).message}` }; }
}

/** The mocked API calls of a screen: replayed when the page opens in a preview or a run. */
export function MocksPanel({ screenId }: { screenId: string }) {
  const qc = useQueryClient();
  const mocks = useQuery({ queryKey: ["mocks", screenId], queryFn: () => api.mocks.list(screenId) });
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["mocks", screenId] });
    qc.invalidateQueries({ queryKey: ["screen", screenId] });
  };
  const toggle = useMutation({
    mutationFn: (m: MockRouteSummary) => api.mocks.update(m.id, { enabled: !m.enabled }),
    onSuccess: (m) => { qc.setQueryData(["mock", m.id], m); refresh(); },
  });

  return (
    <Card>
      <CardHeader title={`Mocks${mocks.data ? ` (${mocks.data.length})` : ""}`}>
        <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>Add a mock</Button>
      </CardHeader>
      <QueryError error={mocks.error ?? toggle.error} />
      {mocks.isPending && <Loading />}
      {mocks.data?.length === 0 && (
        <Empty title="No mock">Record the API calls of the page, let the AI write them, or add one by hand.</Empty>
      )}
      {!!mocks.data?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-2 font-normal">On</th>
                <th className="py-1.5 pr-2 font-normal">Call</th>
                <th className="py-1.5 pr-2 font-normal">Status</th>
                <th className="py-1.5 pr-2 font-normal">Origin</th>
                <th className="py-1.5 font-normal">Ops</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {mocks.data.map((m) => (
                <tr key={m.id} className="hover:bg-white/5">
                  <td className="py-1.5 pr-2"><Toggle checked={m.enabled} onChange={() => toggle.mutate(m)} disabled={toggle.isPending} title={m.enabled ? "Served" : "Not served"} /></td>
                  <td className="max-w-0 py-1.5 pr-2">
                    <button className="w-full truncate text-left hover:text-accent" onClick={() => setOpen(m.id)} title={`${m.method} ${m.host}${m.path}`}>
                      <span className="font-mono text-xs text-muted">{m.method}</span> {m.host}<span className="text-muted">{m.path}</span>
                      {Object.keys(m.query).length > 0 && <span className="text-muted">?{new URLSearchParams(m.query).toString()}</span>}
                    </button>
                    {m.operationName && <div className="truncate text-xs text-accent">{m.operationName}</div>}
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{m.status}</td>
                  <td className="py-1.5 pr-2"><Badge tone={ORIGIN_TONE[m.origin]}>{m.origin}</Badge></td>
                  <td className="py-1.5 tabular-nums">{m.ops}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <MockDrawer id={open} onClose={() => setOpen(null)} onChanged={refresh} />}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a mock" className="max-w-xl">
        <AddMockForm screenId={screenId} onDone={() => { setAdding(false); refresh(); }} />
      </Modal>
    </Card>
  );
}

function MockDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const mock = useQuery({ queryKey: ["mock", id], queryFn: () => api.mocks.get(id) });
  const m = mock.data;
  const done = (next: MockRoute) => { qc.setQueryData(["mock", id], next); onChanged(); };
  const update = useMutation({ mutationFn: (body: Parameters<typeof api.mocks.update>[1]) => api.mocks.update(id, body), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api.mocks.remove(id), onSuccess: () => { onChanged(); onClose(); } });

  return (
    <Drawer open onClose={onClose} title={m ? `${m.method} ${m.host}${m.path}` : "Mock"}>
      <QueryError error={mock.error} />
      {mock.isPending && <Loading />}
      {m && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={ORIGIN_TONE[m.origin]}>{m.origin}</Badge>
            {m.operationName && <Badge tone="accent">{m.operationName}</Badge>}
            <span className="text-xs text-muted">{m.contentType} · updated {fmtDate(m.updatedAt)}</span>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <Toggle checked={m.enabled} onChange={(v) => update.mutate({ enabled: v })} disabled={update.isPending} label={m.enabled ? "Served" : "Not served"} />
            <StatusEditor key={`${m.id}-${m.status}`} status={m.status} busy={update.isPending} onSave={(status) => update.mutate({ status })} />
            <Button
              variant="danger" size="sm" className="ml-auto" disabled={remove.isPending}
              onClick={() => { if (window.confirm("Delete this mock? The page will call the real API for it.")) remove.mutate(); }}
            >
              Delete
            </Button>
          </div>
          <QueryError error={update.error ?? remove.error} />

          {m.violations.length > 0 && (
            <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              <div className="mb-1 font-medium">Edits refused by the guards</div>
              <ul className="list-disc pl-5">{m.violations.map((v, i) => <li key={i}>{v}</li>)}</ul>
            </div>
          )}

          {Object.keys(m.query).length > 0 && (
            <div className="text-xs text-muted">Query: <span className="font-mono">{new URLSearchParams(m.query).toString()}</span></div>
          )}
          {m.variables !== null && m.variables !== undefined && (
            <details className="rounded-md border border-line">
              <summary className="cursor-pointer px-3 py-2 text-sm">Variables</summary>
              <pre className="max-h-60 overflow-auto border-t border-line p-3 font-mono text-xs">{json(m.variables)}</pre>
            </details>
          )}
          <details className="rounded-md border border-line">
            <summary className="cursor-pointer px-3 py-2 text-sm">Recorded body <span className="text-xs text-muted">(read-only)</span></summary>
            <pre className="max-h-80 overflow-auto border-t border-line p-3 font-mono text-xs">{json(m.recordedBody) || "—"}</pre>
          </details>

          <BodyEditor
            key={m.updatedAt} body={m.body} busy={update.isPending}
            onSave={(value) => update.mutate({ ops: [{ op: "set", path: "", value }] })}
            onReset={m.opsList.length ? () => update.mutate({ ops: [] }) : undefined}
          />

          <section>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Ops ({m.opsList.length})</h3>
            {m.opsList.length === 0
              ? <p className="text-xs text-muted">None: the page gets the recorded body.</p>
              : <ul className="divide-y divide-line rounded-md border border-line font-mono text-xs">{m.opsList.map((op, i) => <li key={i} className="px-3 py-1.5">{describeOp(op)}</li>)}</ul>}
          </section>
        </div>
      )}
    </Drawer>
  );
}

function describeOp(op: MockOp): string {
  const path = op.path || "(whole body)";
  const short = (v: unknown) => { const s = JSON.stringify(v) ?? "undefined"; return s.length > 80 ? `${s.slice(0, 80)}…` : s; };
  switch (op.op) {
    case "set": return `set ${path} = ${short(op.value)}`;
    case "remove": return `remove ${path}`;
    case "insert": return `insert ${path}[${op.index}] = ${short(op.value)}`;
    case "duplicate": return `duplicate ${path}[${op.index}] ×${op.count}`;
  }
}

function StatusEditor({ status, busy, onSave }: { status: number; busy: boolean; onSave: (s: number) => void }) {
  const [v, setV] = useState(String(status));
  const n = Number(v);
  const valid = Number.isInteger(n) && n >= 100 && n <= 599;
  return (
    <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) onSave(n); }}>
      <Label>Status code<Input className="w-24" type="number" min={100} max={599} value={v} onChange={(e) => setV(e.target.value)} /></Label>
      <Button type="submit" variant="ghost" size="sm" disabled={busy || !valid || n === status}>Save</Button>
    </form>
  );
}

function BodyEditor({ body, busy, onSave, onReset }: { body: unknown; busy: boolean; onSave: (v: unknown) => void; onReset?: () => void }) {
  const [text, setText] = useState(() => json(body));
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Served body</h3>
      <p className="-mt-1 text-xs text-muted">The recorded body with the ops: what the page gets. Saving replaces the ops with this whole body.</p>
      <Textarea mono rows={16} value={text} onChange={(e) => { setText(e.target.value); setError(null); }} spellCheck={false} />
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button
          size="sm" disabled={busy}
          onClick={() => { const p = parseJson(text); if (p.ok) onSave(p.value); else setError(p.error); }}
        >
          Save the body
        </Button>
        {onReset && <Button variant="ghost" size="sm" disabled={busy} onClick={onReset}>Back to the recorded body</Button>}
      </div>
    </section>
  );
}

function AddMockForm({ screenId, onDone }: { screenId: string; onDone: () => void }) {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("200");
  const [body, setBody] = useState("{\n  \n}");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (value: unknown) => api.mocks.create(screenId, { method, url: url.trim(), status: Number(status), body: value }),
    onSuccess: onDone,
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => { e.preventDefault(); const p = parseJson(body); if (!p.ok) { setError(p.error); return; } setError(null); create.mutate(p.value); }}
    >
      <div className="grid grid-cols-[110px_1fr_90px] gap-2">
        <Label>Method<Select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m}>{m}</option>)}</Select></Label>
        <Label>URL<Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1/cart" required /></Label>
        <Label>Status<Input type="number" min={100} max={599} value={status} onChange={(e) => setStatus(e.target.value)} /></Label>
      </div>
      <Label>JSON body<Textarea mono rows={10} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} /></Label>
      <ErrorText>{error}</ErrorText>
      <QueryError error={create.error} />
      <Button type="submit" className="self-end" disabled={create.isPending}>{create.isPending ? "Adding…" : "Add"}</Button>
    </form>
  );
}
