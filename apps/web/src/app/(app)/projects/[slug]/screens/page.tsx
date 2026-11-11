"use client";

import type { Screen, ScreenGroup, ScreenListQuery } from "@figtest/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, EyeIcon, EyeOffIcon } from "@/components/icons";
import { Badge, Button, Card, Checkbox, Empty, Input, Loading, Pagination, QueryError, Select, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { pct01, pct100, plural } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";

const PAGE_SIZE = 48;
const STATUSES = ["passed", "failed", "blocked", "error", "none"] as const;
const oneOf = <T extends string>(v: string | null, values: readonly T[]): T | undefined => (values.includes(v as T) ? (v as T) : undefined);

export default function ScreensPage() {
  // the filters live in the query string (useSearchParams): a Suspense boundary above it
  return <Suspense fallback={<Loading />}><ScreensView /></Suspense>;
}

function ScreensView() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const qc = useQueryClient();

  const query = useMemo(() => ({
    q: sp.get("q") || undefined,
    groupId: sp.get("groupId") || undefined,
    hasUrl: oneOf(sp.get("hasUrl"), ["yes", "no"] as const),
    status: oneOf(sp.get("status"), STATUSES),
    hidden: sp.get("hidden") === "all" ? ("all" as const) : undefined,
    drafts: sp.get("drafts") === "show" ? ("show" as const) : undefined,
    page: Math.max(1, Number(sp.get("page")) || 1),
    pageSize: PAGE_SIZE,
  }) satisfies ScreenListQuery, [sp]);

  const setParams = useCallback((patch: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    if (!("page" in patch)) next.delete("page");
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  }, [sp, router, pathname]);

  // search: typed here, in the URL once the typing stops
  const [q, setQ] = useState(sp.get("q") ?? "");
  const dq = useDebounced(q.trim(), 300);
  const lastDq = useRef(dq);
  useEffect(() => {
    // only when the typed text settles (not when the URL changes by another way, e.g. Clear filters)
    if (dq === lastDq.current) return;
    lastDq.current = dq;
    if ((sp.get("q") ?? "") !== dq) setParams({ q: dq || null });
  }, [dq, sp, setParams]);

  const groups = useQuery({ queryKey: ["groups", slug], queryFn: () => api.groups.list(slug) });
  const screens = useQuery({ queryKey: ["screens", slug, "list", query], queryFn: () => api.screens.list(slug, query), placeholderData: keepPreviousData });

  const hideGroup = useMutation({
    mutationFn: (g: ScreenGroup) => api.groups.update(g.id, { hidden: !g.hidden }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["groups", slug] }); qc.invalidateQueries({ queryKey: ["screens", slug] }); },
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const run = useMutation({
    mutationFn: (screenIds?: string[]) => api.runs.create(slug, { screenIds, target: "site" }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["runs", slug] }); router.push(`/projects/${slug}/runs/${r.id}`); },
  });

  const tree = useMemo(() => buildTree(groups.data ?? []), [groups.data]);
  const items = screens.data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((s) => selected.has(s.id));
  const filtered = !!(query.q || query.groupId || query.hasUrl || query.status || query.hidden || query.drafts);

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="h-fit p-2 lg:sticky lg:top-4">
        <div className="px-2 py-1 text-xs font-semibold tracking-wide text-muted uppercase">Pages & sections</div>
        <button
          className={cn("flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-white/5", !query.groupId && "bg-accent/15")}
          onClick={() => setParams({ groupId: null })}
        >
          All screens
        </button>
        <QueryError error={groups.error ?? hideGroup.error} className="m-2" />
        {groups.isPending && <Loading className="p-2" />}
        {groups.data?.length === 0 && <p className="p-2 text-xs text-muted">Import the design to get its pages and sections.</p>}
        <ul className="max-h-[70vh] overflow-auto">
          {tree.map((n) => (
            <GroupItem
              key={n.id} node={n} depth={0} parentHidden={false} selected={query.groupId}
              onSelect={(id) => setParams({ groupId: id === query.groupId ? null : id })}
              onToggleHidden={(g) => hideGroup.mutate(g)} busy={hideGroup.isPending}
            />
          ))}
        </ul>
      </Card>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-64 max-w-full" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name or a URL" type="search" />
          <Select value={query.hasUrl ?? ""} onChange={(e) => setParams({ hasUrl: e.target.value })} aria-label="URL">
            <option value="">Any URL</option>
            <option value="yes">With a URL</option>
            <option value="no">Without URL</option>
          </Select>
          <Select value={query.status ?? ""} onChange={(e) => setParams({ status: e.target.value })} aria-label="Last result">
            <option value="">Any result</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s === "none" ? "Not tested" : s}</option>)}
          </Select>
          <Checkbox label="Show hidden" checked={query.hidden === "all"} onChange={(e) => setParams({ hidden: e.target.checked ? "all" : null })} />
          <Checkbox label="Show drafts & duplicates" checked={query.drafts === "show"} onChange={(e) => setParams({ drafts: e.target.checked ? "show" : null })} />
          {filtered && <Button variant="subtle" size="sm" onClick={() => { setQ(""); router.replace(pathname, { scroll: false }); }}>Clear filters</Button>}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm">
          <Checkbox
            label={selected.size ? `${selected.size} selected` : "Select page"} checked={allOnPage}
            onChange={() => setSelected((s) => { const n = new Set(s); for (const x of items) { if (allOnPage) n.delete(x.id); else n.add(x.id); } return n; })}
          />
          {selected.size > 0 && <Button variant="subtle" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" disabled={!selected.size || run.isPending} onClick={() => run.mutate([...selected])}>Run selected</Button>
            <Button size="sm" variant="ghost" disabled={run.isPending} onClick={() => run.mutate(undefined)}>Run all with a URL</Button>
          </div>
        </div>
        <QueryError error={run.error} />

        <QueryError error={screens.error} />
        {screens.isPending && <Loading />}
        {screens.data && !items.length && (
          <Empty title={filtered ? "No screen matches these filters" : "No screen yet"}>
            {filtered ? "Change the search or the filters." : <>Import the design in the <Link className="text-accent" href={`/projects/${slug}/design`}>Design</Link> tab: each frame becomes a screen.</>}
          </Empty>
        )}
        <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3", screens.isPlaceholderData && "opacity-60")}>
          {items.map((s) => <ScreenCard key={s.id} s={s} slug={slug} selected={selected.has(s.id)} onSelect={toggle} />)}
        </div>
        {screens.data && screens.data.total > 0 && (
          <Pagination page={query.page} pageSize={PAGE_SIZE} total={screens.data.total} onPage={(p) => setParams({ page: p > 1 ? String(p) : null })} />
        )}
      </div>
    </div>
  );
}

function ScreenCard({ s, slug, selected, onSelect }: { s: Screen; slug: string; selected: boolean; onSelect: (id: string) => void }) {
  const thumb = api.fileUrl(s.thumbUrl);
  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-lg border bg-panel transition", selected ? "border-accent" : "border-line hover:border-muted")}>
      <label className="absolute top-2 left-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded bg-bg/80" title="Select">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={selected} onChange={() => onSelect(s.id)} />
      </label>
      <Link href={`/projects/${slug}/screens/${s.id}`} className="flex flex-1 flex-col">
        <div className="h-40 overflow-hidden border-b border-line bg-bg">
          {thumb
            ? <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
            : <div className="flex h-full items-center justify-center text-xs text-muted">no image</div>}
        </div>
        <div className="flex flex-1 flex-col gap-1 p-2.5">
          <div className="truncate text-sm font-medium" title={s.name}>{s.name}</div>
          <div className="truncate text-xs text-muted" title={s.groupPath.join(" / ")}>{s.groupPath.join(" / ") || "—"}</div>
          <div className={cn("truncate text-xs", s.url ? "text-accent" : "text-muted italic")} title={s.url ?? undefined}>{s.url ?? "no URL"}</div>
          <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
            {s.lastResult
              ? <><StatusBadge status={s.lastResult.status} /><span className="text-xs text-muted tabular-nums">{pct01(s.lastResult.coverage)} · {pct100(s.lastResult.designScore)}</span></>
              : <span className="text-xs text-muted">not tested</span>}
          </div>
          {(s.mocks > 0 || s.draft || s.duplicateOf || s.hidden || s.missing || s.target === "storybook") && (
            <div className="flex flex-wrap gap-1">
              {s.mocks > 0 && <Badge tone="accent">{plural(s.mocks, "mock")}</Badge>}
              {s.target === "storybook" && <Badge>storybook</Badge>}
              {s.draft && <Badge tone="warn">draft</Badge>}
              {s.duplicateOf && <Badge tone="warn">duplicate</Badge>}
              {s.hidden && <Badge>hidden</Badge>}
              {s.missing && <Badge tone="bad">missing</Badge>}
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}

type Node = ScreenGroup & { children: Node[]; total: number };

/** the groups nested by parentId (the api lists them depth first), with the screens of each subtree */
function buildTree(groups: ScreenGroup[]): Node[] {
  const byId = new Map<string, Node>(groups.map((g) => [g.id, { ...g, children: [], total: 0 }]));
  const roots: Node[] = [];
  for (const g of groups) {
    const n = byId.get(g.id)!;
    const parent = g.parentId ? byId.get(g.parentId) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sum = (n: Node): number => (n.total = n.screens + n.children.reduce((a, c) => a + sum(c), 0));
  roots.forEach(sum);
  return roots;
}

function GroupItem({ node, depth, parentHidden, selected, onSelect, onToggleHidden, busy }: {
  node: Node; depth: number; parentHidden: boolean; selected?: string;
  onSelect: (id: string) => void; onToggleHidden: (g: ScreenGroup) => void; busy: boolean;
}) {
  const [open, setOpen] = useState(true);
  const hidden = node.hidden || parentHidden;
  return (
    <li>
      <div
        className={cn("flex items-center gap-1 rounded py-1 pr-1 text-sm", selected === node.id ? "bg-accent/15" : "hover:bg-white/5", hidden && "opacity-50")}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {node.children.length
          ? <button className="text-muted hover:text-text" onClick={() => setOpen(!open)} aria-label={open ? "Collapse" : "Expand"}>{open ? <ChevronDownIcon width={14} /> : <ChevronRightIcon width={14} />}</button>
          : <span className="w-3.5" />}
        <button className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(node.id)} title={`${node.kind}: ${node.name}`}>
          {node.name}
        </button>
        <span className="text-xs text-muted tabular-nums">{node.total}</span>
        <button
          className="rounded p-0.5 text-muted hover:text-text disabled:opacity-50" disabled={busy}
          title={node.hidden ? "Hidden: its screens are left out of the list and the runs. Click to show." : "Hide this group (and its screens)"}
          onClick={() => onToggleHidden(node)}
        >
          {node.hidden ? <EyeOffIcon width={14} /> : <EyeIcon width={14} />}
        </button>
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <GroupItem key={c.id} node={c} depth={depth + 1} parentHidden={hidden} selected={selected} onSelect={onSelect} onToggleHidden={onToggleHidden} busy={busy} />
          ))}
        </ul>
      )}
    </li>
  );
}
