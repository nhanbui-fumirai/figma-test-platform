"use client";

/**
 * Report of one screen: the Figma image and the screenshot of the page side by side at the same scale, boxes of the
 * report drawn over them (CSS px × scale), and the list of issues. Clicking an issue (or a box) highlights its boxes on
 * both images and scrolls them into view.
 */
import type { Box, Check, CompareReport, ResultReport } from "@figtest/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox, Input, Segmented, Select, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

type Kind = "text" | "container" | "spacing" | "missing";
type ItemStatus = "pass" | "fail" | "missing";
type Item = {
  id: string; kind: Kind; status: ItemStatus; title: string; sub: string; checks: Check[];
  figma: Box[]; dom: Box[]; shape: "text" | "container";
};

const KIND_LABEL: Record<Kind, string> = { text: "Text", container: "Container", spacing: "Spacing", missing: "Missing" };
const BOX_COLOR: Record<ItemStatus, string> = { pass: "border-ok/60 bg-ok/5", fail: "border-bad bg-bad/10", missing: "border-warn bg-warn/10" };
const DOT: Record<ItemStatus, string> = { pass: "bg-ok", fail: "bg-bad", missing: "bg-warn" };

/** the report as served (unknown in the contract), when it looks like a CompareReport */
export function asReport(v: unknown): CompareReport | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<CompareReport>;
  if (!Array.isArray(r.texts) || !Array.isArray(r.containers) || !r.frame?.size || !r.page) return null;
  return { ...(v as CompareReport), spacing: Array.isArray(r.spacing) ? r.spacing : [], unmatchedContainers: Array.isArray(r.unmatchedContainers) ? r.unmatchedContainers : [] };
}

function buildItems(report: CompareReport): Item[] {
  const items: Item[] = [];
  const textByNode = new Map<string, CompareReport["texts"][number]>();
  for (const t of report.texts) {
    if (!textByNode.has(t.node)) textByNode.set(t.node, t);
    if (t.status === "ignored") continue;
    items.push({
      id: `t:${t.key}`, kind: t.status === "missing" ? "missing" : "text", status: t.status, title: t.text || t.name,
      sub: [t.name, t.match && `${t.match} match`, t.dom?.sel].filter(Boolean).join(" · "),
      checks: t.checks, figma: [t.figma], dom: t.dom ? [t.dom.box] : [], shape: "text",
    });
  }
  for (const c of report.containers) {
    if (c.status === "ignored") continue;
    items.push({
      id: `c:${c.key}`, kind: "container", status: c.status, title: c.name,
      sub: [c.type, c.confidence === "low" && "low confidence", c.dom?.sel].filter(Boolean).join(" · "),
      checks: c.checks, figma: [c.figma], dom: c.dom ? [c.dom.box] : [], shape: "container",
    });
  }
  report.unmatchedContainers.forEach((u, i) => items.push({
    id: `u:${i}:${u.node}`, kind: "missing", status: "missing", title: u.name, sub: `${u.type} · not found on the page: ${u.reason}`,
    checks: [], figma: [u.figma], dom: [], shape: "container",
  }));
  for (const s of report.spacing) {
    if (s.check.status === "ignored") continue;
    const from = textByNode.get(s.from.node);
    const to = textByNode.get(s.to.node);
    items.push({
      id: `s:${s.key}`, kind: "spacing", status: s.check.status === "fail" ? "fail" : "pass", title: `${s.from.text} ↕ ${s.to.text}`,
      sub: "vertical space between two texts", checks: [s.check],
      figma: [from?.figma, to?.figma].filter((b): b is Box => !!b),
      dom: [from?.dom?.box, to?.dom?.box].filter((b): b is Box => !!b), shape: "text",
    });
  }
  return items;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

type Zoom = "fit" | "50" | "100";
type Overlay = "all" | "issues" | "none";

export function ReportViewer({ data }: { data: ResultReport }) {
  const report = useMemo(() => asReport(data.report), [data.report]);
  const items = useMemo(() => (report ? buildItems(report) : []), [report]);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [overlay, setOverlay] = useState<Overlay>("all");
  const [sync, setSync] = useState(true);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [prop, setProp] = useState("");
  const [search, setSearch] = useState("");
  const [passing, setPassing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const figRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const [measureRef, colWidth] = useWidth<HTMLDivElement>();
  const driver = useRef<"fig" | "app" | null>(null);
  const lockUntil = useRef(0);

  const figW = report?.frame.size.w ?? 0;
  const appW = report?.page.w || data.viewport?.w || 0;
  const fitScale = colWidth && Math.max(figW, appW) ? (colWidth - 2) / Math.max(figW, appW) : 0;
  const scale = zoom === "fit" ? fitScale : zoom === "50" ? 0.5 : 1;

  const needle = search.trim().toLowerCase();
  const matches = (it: Item, withProp = true) =>
    (kind === "all" || it.kind === kind)
    && (!withProp || !prop || it.checks.some((c) => c.prop === prop && (it.status === "pass" ? c.status !== "ignored" : c.status === "fail")))
    && (!needle || it.title.toLowerCase().includes(needle) || it.sub.toLowerCase().includes(needle));
  const shown = items.filter((it) => matches(it) && (passing || it.status !== "pass"));
  const drawn = overlay === "none" ? [] : items.filter((it) => matches(it) && (overlay === "all" || it.status !== "pass"));
  const sel = items.find((it) => it.id === selected) ?? null;
  const drawnWithSel = sel && !drawn.includes(sel) ? [...drawn, sel] : drawn;

  const counts = useMemo(() => {
    const c: Record<Kind | "all", number> = { all: 0, text: 0, container: 0, spacing: 0, missing: 0 };
    for (const it of items) if (passing || it.status !== "pass") { c[it.kind]++; c.all++; }
    return c;
  }, [items, passing]);
  const props = useMemo(() => {
    const n = new Map<string, number>();
    for (const it of items) {
      if (kind !== "all" && it.kind !== kind) continue;
      for (const c of it.checks) if (c.status === "fail" || (passing && c.status === "pass")) n.set(c.prop, (n.get(c.prop) ?? 0) + 1);
    }
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [items, kind, passing]);

  function scrollToBox(el: HTMLDivElement | null, box: Box | undefined) {
    if (!el || !box) return;
    el.scrollTo({
      top: Math.max(0, (box.y + box.h / 2) * scale - el.clientHeight / 2),
      left: Math.max(0, (box.x + box.w / 2) * scale - el.clientWidth / 2),
      behavior: "smooth",
    });
  }
  function pick(it: Item) {
    setSelected(it.id);
    lockUntil.current = Date.now() + 900; // both images scroll to their own box: no sync meanwhile
    scrollToBox(figRef.current, it.figma[0]);
    scrollToBox(appRef.current, it.dom[0]);
    document.getElementById(`issue-${it.id}`)?.scrollIntoView({ block: "nearest" });
  }
  const onScroll = (from: "fig" | "app") => () => {
    if (!sync || driver.current !== from || Date.now() < lockUntil.current) return;
    const a = from === "fig" ? figRef.current : appRef.current;
    const b = from === "fig" ? appRef.current : figRef.current;
    if (a && b && Math.abs(b.scrollTop - a.scrollTop) > 1) b.scrollTop = a.scrollTop;
  };

  const figSrc = api.fileUrl(data.result.figmaUrl);
  const appSrc = api.fileUrl(data.result.screenshotUrl);

  if (!report) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted">No comparison report for this result{data.result.status === "blocked" ? " (the page was blocked)" : data.result.status === "error" ? " (the test failed)" : ""}.</p>
        {appSrc
          ? <a href={appSrc} target="_blank" rel="noreferrer" className="block max-h-[80vh] overflow-auto rounded-md border border-line bg-bg"><img src={appSrc} alt="Screenshot of the page" className="w-full" /></a>
          : <p className="text-sm text-muted">No screenshot.</p>}
      </div>
    );
  }

  const pane = (side: "fig" | "app") => {
    const src = side === "fig" ? figSrc : appSrc;
    const w = side === "fig" ? figW : appW;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{side === "fig" ? `Figma · ${report.frame.name}` : "Website"}</span>
          <span className="tabular-nums">{Math.round(w)} px{scale ? ` · ${Math.round(scale * 100)}%` : ""}</span>
        </div>
        <div
          ref={(el) => { if (side === "fig") { figRef.current = el; measureRef.current = el; } else appRef.current = el; }}
          onScroll={onScroll(side)} onMouseEnter={() => { driver.current = side; }} onWheel={() => { driver.current = side; }} onTouchStart={() => { driver.current = side; }}
          className="h-[calc(100vh-16rem)] min-h-96 overflow-auto rounded-md border border-line bg-bg"
        >
          {!src ? <p className="p-3 text-sm text-muted">No image.</p> : scale > 0 && (
            <div className="relative" style={{ width: w * scale }}>
              <img src={src} alt={side === "fig" ? "Figma design" : "Screenshot of the page"} className="block w-full max-w-none" draggable={false} />
              {drawnWithSel.flatMap((it) => (side === "fig" ? it.figma : it.dom).map((b, i) => (
                <div
                  key={`${it.id}:${i}`} title={`${KIND_LABEL[it.kind]} · ${it.status}: ${it.title}`} onClick={() => pick(it)}
                  className={cn(
                    "absolute cursor-pointer rounded-[1px]", it.shape === "container" ? "border border-dashed" : "border", BOX_COLOR[it.status],
                    it.id === selected && "z-10 border-2 border-solid border-accent bg-accent/20 shadow-[0_0_0_3px_rgba(109,140,255,0.35)]",
                  )}
                  style={{ left: b.x * scale, top: b.y * scale, width: Math.max(2, b.w * scale), height: Math.max(2, b.h * scale) }}
                />
              )))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Segmented value={zoom} onChange={setZoom} options={[{ value: "fit", label: "Fit width" }, { value: "50", label: "50%" }, { value: "100", label: "100%" }]} />
          <Segmented value={overlay} onChange={setOverlay} options={[{ value: "all", label: "All boxes" }, { value: "issues", label: "Issues" }, { value: "none", label: "No box" }]} />
          <Toggle checked={sync} onChange={setSync} label="Sync scroll" />
          <div className="ml-auto flex items-center gap-3 text-xs text-muted">
            <Legend color="border-ok bg-ok/10" label="pass" />
            <Legend color="border-bad bg-bad/10" label="fail" />
            <Legend color="border-warn bg-warn/10" label="missing" />
            <Legend color="border-dashed border-muted" label="container" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">{pane("fig")}{pane("app")}</div>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          {(["all", "text", "container", "spacing", "missing"] as const).map((k) => (
            <button
              key={k} onClick={() => setKind(k)}
              className={cn("rounded-md px-2 py-1 text-xs transition", kind === k ? "bg-accent/20 text-text" : "text-muted hover:bg-white/5 hover:text-text")}
            >
              {k === "all" ? "All" : KIND_LABEL[k]} <span className="tabular-nums">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Select className="w-40 shrink-0" value={prop} onChange={(e) => setProp(e.target.value)} aria-label="Property">
            <option value="">Any property</option>
            {props.map(([p, n]) => <option key={p} value={p}>{p} ({n})</option>)}
            {prop && !props.some(([p]) => p === prop) && <option value={prop}>{prop}</option>}
          </Select>
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a text, a name, a selector" />
        </div>
        <Checkbox label={<span className="text-xs">Include passing</span>} checked={passing} onChange={(e) => setPassing(e.target.checked)} />
        <ul className="h-[calc(100vh-19rem)] min-h-80 divide-y divide-line overflow-auto rounded-md border border-line">
          {shown.length === 0 && <li className="p-3 text-sm text-muted">{items.some((i) => i.status !== "pass") ? "No issue matches." : "No issue: everything compared passes."}</li>}
          {shown.map((it) => (
            <li key={it.id} id={`issue-${it.id}`}>
              <button className={cn("flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-white/5", it.id === selected && "bg-accent/10")} onClick={() => pick(it)}>
                <div className="flex w-full items-center gap-2">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[it.status])} />
                  <span className="text-xs text-muted">{KIND_LABEL[it.kind]}</span>
                  {!it.dom.length && it.kind !== "missing" && <span className="text-xs text-warn">no DOM box</span>}
                </div>
                <div className="line-clamp-2 text-sm break-words">{it.title}</div>
                {it.sub && <div className="truncate text-xs text-muted" title={it.sub}>{it.sub}</div>}
                <ChecksTable checks={it.id === selected ? it.checks : it.checks.filter((c) => c.status === "fail" || (passing && it.status === "pass" && c.status === "pass"))} />
              </button>
            </li>
          ))}
        </ul>
        <div className="text-xs text-muted">{shown.length} shown · tolerances: font ±{report.tolerances.fontSize}px, color ±{report.tolerances.color}, spacing ±{report.tolerances.spacing}px</div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={cn("inline-block h-3 w-3 border", color)} />{label}</span>;
}

const isColor = (v: unknown) => typeof v === "string" && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(v.trim());
function Value({ v }: { v: string | number | null }) {
  if (v === null) return <span className="text-muted">–</span>;
  return (
    <span className="inline-flex items-center gap-1 break-all">
      {isColor(v) && <span className="inline-block h-3 w-3 shrink-0 rounded-sm border border-line" style={{ background: String(v) }} />}
      {String(v)}
    </span>
  );
}

function ChecksTable({ checks }: { checks: Check[] }) {
  if (!checks.length) return null;
  return (
    <table className="mt-1 w-full table-fixed text-xs">
      <thead className="text-muted">
        <tr><th className="w-[24%] text-left font-normal">prop</th><th className="w-[26%] text-left font-normal">expected</th><th className="w-[26%] text-left font-normal">actual</th><th className="text-left font-normal">diff · tol</th></tr>
      </thead>
      <tbody>
        {checks.map((c, i) => (
          <tr key={i} className={c.status === "fail" ? "text-bad" : c.status === "pass" ? "text-ok" : "text-muted"} title={c.reason ?? c.note}>
            <td className="truncate pr-1 align-top">{c.prop}</td>
            <td className="pr-1 align-top"><Value v={c.expected} /></td>
            <td className="pr-1 align-top"><Value v={c.actual} /></td>
            <td className="align-top">{c.diff !== undefined ? String(c.diff) : ""}{c.tol ? ` · ${c.tol}` : ""}{c.status === "ignored" ? " ignored" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
