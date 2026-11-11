"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button, Card, Input, Label, Loading, QueryError } from "@/components/ui";
import { api } from "@/lib/api";

const slugOf = (name: string) => name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 49);

export default function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects.list });
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const create = useMutation({
    mutationFn: () => api.projects.create({ name, slug: slug || slugOf(name), baseUrl }),
    onSuccess: () => { setName(""); setSlug(""); setBaseUrl(""); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Projects</h1>
        <p className="text-sm text-muted">A project is a website compared with its Figma design.</p>
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">New project</h2>
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Label>Name<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ANA DP" required /></Label>
          <Label>Slug<Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugOf(name) || "ana-dp"} /></Label>
          <Label>Website URL<Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" required /></Label>
          <div className="sm:col-span-3 flex items-center justify-between gap-3">
            <QueryError error={create.error} />
            <Button type="submit" className="ml-auto" disabled={create.isPending}>Create</Button>
          </div>
        </form>
      </Card>

      <QueryError error={projects.error} />
      {projects.isPending && <Loading />}
      <div className="grid gap-3 sm:grid-cols-2">
        {projects.data?.map((p) => (
          <Link key={p.id} href={`/projects/${p.slug}`}>
            <Card className="transition hover:border-accent">
              <div className="font-medium">{p.name}</div>
              <div className="truncate text-xs text-muted">{p.baseUrl}</div>
            </Card>
          </Link>
        ))}
        {projects.data?.length === 0 && <p className="text-sm text-muted">No project yet.</p>}
      </div>
    </div>
  );
}
