/** Authored by: Mohit Singh */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useCurrentUser, useLogin } from "@/hooks/useAuth";
import { Radar } from "lucide-react";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const navigate = useNavigate();
  const { data: user, isLoading: isLoadingUser } = useCurrentUser();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!isLoadingUser && user !== null && user !== undefined) {
      void navigate({ to: "/" });
    }
  }, [isLoadingUser, user, navigate]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: () => void navigate({ to: "/" }),
      },
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background bg-grid px-4">
      <Card className="w-full max-w-sm border-border bg-card p-6">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
            <Radar className="h-4.5 w-4.5 text-primary" strokeWidth={2.25} />
          </div>
          <span className="font-display text-sm font-semibold tracking-tight">
            Business Scout AI
          </span>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <Label htmlFor="email" className="mb-1.5 block text-[11px] uppercase tracking-wide">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-input border-border"
            />
          </div>
          <div>
            <Label htmlFor="password" className="mb-1.5 block text-[11px] uppercase tracking-wide">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="bg-input border-border"
            />
          </div>
          {login.isError && <p className="text-xs text-destructive">{login.error.message}</p>}
          <Button
            type="submit"
            disabled={login.isPending}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
