/** Authored by: Mohit Singh */
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCurrentUser } from "@/hooks/useAuth";

/**
 * Client-side auth gate for every protected screen. The access-token cookie is httpOnly
 * (see auth/cookies.ts), so there's no way to know auth state before asking the API —
 * this renders a brief loading state, then redirects to /login on a null (401) result.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isLoading } = useCurrentUser();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && user === null) {
      void navigate({ to: "/login" });
    }
  }, [isLoading, user, navigate]);

  if (isLoading || user === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  return <>{children}</>;
}
