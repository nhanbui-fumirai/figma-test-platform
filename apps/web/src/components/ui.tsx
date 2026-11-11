"use client";

/** Small UI primitives of the app (shadcn/ui style: plain components on Tailwind classes). */
import Link from "next/link";
import {
  useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/format";
import { XIcon } from "./icons";

type Variant = "primary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md";

const buttonClass = (variant: Variant, size: Size, className?: string) => cn(
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50",
  size === "md" ? "px-3 py-1.5 text-sm" : "px-2 py-1 text-xs",
  variant === "primary" && "bg-accent text-white hover:brightness-110",
  variant === "ghost" && "border border-line text-text hover:bg-white/5",
  variant === "danger" && "border border-bad/50 text-bad hover:bg-bad/10",
  variant === "subtle" && "text-muted hover:bg-white/5 hover:text-text",
  className,
);

export function Button({
  className, variant = "primary", size = "md", type = "button", ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

/** a link that looks like a button */
export function ButtonLink({ href, className, variant = "ghost", size = "md", children, download }: {
  href: string; className?: string; variant?: Variant; size?: Size; children: ReactNode; download?: boolean;
}) {
  // a download goes to the api origin with the session cookie: a plain link, not a client navigation
  return download
    ? <a href={href} download className={buttonClass(variant, size, className)}>{children}</a>
    : <Link href={href} className={buttonClass(variant, size, className)}>{children}</Link>;
}

const field = "rounded-md border border-line bg-bg text-sm outline-none placeholder:text-muted focus:border-accent disabled:opacity-60";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("w-full px-3 py-1.5", field, className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("px-2 py-1.5", field, className)} {...props} />;
}

export function Textarea({ className, mono, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cn("w-full px-3 py-2", field, mono && "font-mono text-xs leading-5", className)} {...props} />;
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("flex flex-col gap-1 text-xs text-muted", className)} {...props} />;
}

export function Checkbox({ label, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label?: ReactNode }) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-sm select-none", className)}>
      <input type="checkbox" className="h-4 w-4 accent-accent" {...props} />
      {label}
    </label>
  );
}

/** on/off switch */
export function Toggle({ checked, onChange, disabled, label, title, className }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; title?: string; className?: string;
}) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-sm select-none", disabled ? "opacity-50" : "cursor-pointer", className)} title={title}>
      <button
        type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn("relative h-5 w-9 shrink-0 rounded-full transition disabled:cursor-not-allowed", checked ? "bg-accent" : "bg-line")}
      >
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      {label}
    </label>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-panel p-4", className)} {...props} />;
}

export function CardHeader({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-center justify-between gap-2", className)}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function ErrorText({ children, className }: { children?: React.ReactNode; className?: string }) {
  return children ? <p className={cn("rounded-md bg-bad/10 px-3 py-2 text-sm break-words text-bad", className)}>{children}</p> : null;
}

/** the message of a failed query or mutation (ApiError, zod error of the client, network error) */
export function QueryError({ error, className }: { error: unknown; className?: string }) {
  return error ? <ErrorText className={className}>{errorMessage(error)}</ErrorText> : null;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn("inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent", className)} aria-hidden="true" />;
}

export function Loading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return <p className={cn("flex items-center gap-2 text-sm text-muted", className)}><Spinner />{label}</p>;
}

export function Empty({ title, children, action, className }: { title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-4 py-10 text-center", className)}>
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- badges

export type Tone = "ok" | "bad" | "warn" | "accent" | "muted";
export const TONE_TEXT: Record<Tone, string> = { ok: "text-ok", bad: "text-bad", warn: "text-warn", accent: "text-accent", muted: "text-muted" };

export function Badge({ tone = "muted", className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-current/30", TONE_TEXT[tone], className)}>
      {children}
    </span>
  );
}

/** job, run, result, preview and repository statuses */
const STATUS_TONE: Record<string, Tone> = {
  queued: "muted", running: "accent", succeeded: "ok", failed: "bad", cancelled: "warn",
  passed: "ok", blocked: "warn", error: "bad", skipped: "muted",
  ok: "ok", none: "muted", syncing: "accent", ready: "ok",
};
export const statusTone = (status: string): Tone => STATUS_TONE[status] ?? "muted";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return <Badge tone={statusTone(status)} className={className}>{status}</Badge>;
}

// ---------------------------------------------------------------- tiles, progress

export function Stat({ label, value, tone, hint, className }: { label: ReactNode; value: ReactNode; tone?: Tone; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-line bg-panel px-3 py-2", className)}>
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", tone && TONE_TEXT[tone])}>{value}</div>
      {hint && <div className="truncate text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Progress({ value, max, className, indeterminate }: { value?: number; max?: number; className?: string; indeterminate?: boolean }) {
  const pct = max ? Math.min(100, Math.round(((value ?? 0) / max) * 100)) : 0;
  return (
    <div className={cn("h-1.5 overflow-hidden rounded bg-line", className)}>
      {indeterminate
        ? <div className="h-full w-1/3 animate-pulse rounded bg-accent" />
        : <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />}
    </div>
  );
}

// ---------------------------------------------------------------- tabs, segmented control

export type TabItem<T extends string> = { value: T; label: ReactNode; href?: string; count?: number };

/** tabs: links when the items have an href, buttons otherwise */
export function Tabs<T extends string>({ items, value, onChange, className }: {
  items: TabItem<T>[]; value: T | null; onChange?: (v: T) => void; className?: string;
}) {
  return (
    <div className={cn("flex gap-1 overflow-x-auto border-b border-line", className)} role="tablist">
      {items.map((it) => {
        const active = it.value === value;
        const cls = cn(
          "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition",
          active ? "border-accent text-text" : "border-transparent text-muted hover:text-text",
        );
        const inner = (
          <>
            {it.label}
            {it.count !== undefined && <span className="ml-1.5 rounded bg-white/5 px-1.5 text-xs text-muted tabular-nums">{it.count}</span>}
          </>
        );
        return it.href
          ? <Link key={it.value} href={it.href} className={cls} aria-current={active ? "page" : undefined}>{inner}</Link>
          : <button key={it.value} type="button" role="tab" aria-selected={active} className={cls} onClick={() => onChange?.(it.value)}>{inner}</button>;
      })}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, className }: {
  options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div className={cn("inline-flex overflow-hidden rounded-md border border-line", className)}>
      {options.map((o) => (
        <button
          key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cn("px-2.5 py-1 text-xs transition", o.value === value ? "bg-accent/20 text-text" : "text-muted hover:bg-white/5 hover:text-text")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- pagination

export function Pagination({ page, pageSize, total, onPage, className }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return (
    <div className={cn("flex items-center justify-between gap-3 text-sm text-muted", className)}>
      <span className="tabular-nums">{from}–{to} of {total}</span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(1)}>«</Button>
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
          <span className="tabular-nums">{page} / {pages}</span>
          <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
          <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(pages)}>»</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- overlays

function useEscape(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded p-1 text-muted hover:bg-white/5 hover:text-text" aria-label="Close">
      <XIcon />
    </button>
  );
}

export function Modal({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; className?: string }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" className={cn("max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-line bg-panel p-4 shadow-2xl", className)}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <CloseButton onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

/** a panel on the right side of the window */
export function Drawer({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; className?: string }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" className={cn("flex h-full w-full max-w-2xl flex-col border-l border-line bg-panel shadow-2xl", className)}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          <CloseButton onClick={onClose} />
        </div>
        <div className="flex-1 overflow-auto p-4">{children}</div>
      </aside>
    </div>
  );
}
