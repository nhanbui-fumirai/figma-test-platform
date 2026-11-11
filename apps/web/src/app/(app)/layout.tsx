"use client";

import { ApiError } from "@figtest/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";

/** The signed-in part of the app: a session is required, else the login page. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = useQuery({ queryKey: ["me"], queryFn: api.auth.me });
  const logout = useMutation({ mutationFn: api.auth.logout, onSuccess: () => router.replace("/login") });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace("/login");
  }, [me.error, router]);

  if (!me.data) {
    return <main className="p-6 text-sm text-muted">{me.error && !(me.error instanceof ApiError && me.error.status === 401) ? `API not reachable: ${me.error.message}` : "Loading…"}</main>;
  }
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-line px-6 py-3">
        <Link href="/projects" className="font-semibold">Figma Test Platform</Link>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span>{me.data.email}</span>
          <Button variant="ghost" onClick={() => logout.mutate()}>Sign out</Button>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] p-6">{children}</main>
    </div>
  );
}
