"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, ErrorText, Input, Label } from "@/components/ui";
import { api } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({ mutationFn: () => api.auth.login({ email, password }), onSuccess: () => router.replace("/projects") });

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold">Figma Test Platform</h1>
        <p className="mb-4 text-sm text-muted">Sign in to compare your websites with their Figma design.</p>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
          <Label>Email<Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Label>
          <Label>Password<Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Label>
          <ErrorText>{login.error?.message}</ErrorText>
          <Button type="submit" disabled={login.isPending}>{login.isPending ? "Signing in…" : "Sign in"}</Button>
        </form>
      </Card>
    </main>
  );
}
