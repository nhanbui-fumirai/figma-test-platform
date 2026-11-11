"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSelectedLayoutSegment } from "next/navigation";
import { QueryError, Tabs } from "@/components/ui";
import { api } from "@/lib/api";

const TABS = [
  { value: "overview", label: "Overview", path: "" },
  { value: "design", label: "Design", path: "/design" },
  { value: "screens", label: "Screens", path: "/screens" },
  { value: "runs", label: "Runs", path: "/runs" },
  { value: "repository", label: "Repository", path: "/repository" },
  { value: "settings", label: "Settings", path: "/settings" },
];

/** The project area: its name and website, the tabs, then the page of the tab. */
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const segment = useSelectedLayoutSegment();
  // a result report belongs to a run
  const active = !segment || segment.startsWith("__") ? "overview" : segment === "results" ? "runs" : segment;
  const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.projects.get(slug) });

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <div className="text-xs text-muted"><Link href="/projects" className="hover:text-text">Projects</Link> /</div>
        <h1 className="truncate text-xl font-semibold">{project.data?.name ?? slug}</h1>
        {project.data && (
          <a className="text-sm break-all text-accent hover:underline" href={project.data.baseUrl} target="_blank" rel="noreferrer">{project.data.baseUrl}</a>
        )}
      </div>
      <Tabs items={TABS.map((t) => ({ value: t.value, label: t.label, href: `/projects/${slug}${t.path}` }))} value={active} />
      {project.error ? <QueryError error={project.error} /> : children}
    </div>
  );
}
