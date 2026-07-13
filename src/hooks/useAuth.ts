/** Authored by: Mohit Singh */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { AuthenticatedUser } from "@/types/api";

export const authKeys = {
  me: ["auth", "me"] as const,
};

interface LoginInput {
  email: string;
  password: string;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: authKeys.me,
    queryFn: async () => {
      try {
        const { user } = await api.get<{ user: AuthenticatedUser }>("/auth/me");
        return user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LoginInput) => {
      const { user } = await api.post<{ user: AuthenticatedUser }>("/auth/login", input);
      return user;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(authKeys.me, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => {
      queryClient.setQueryData(authKeys.me, null);
      void queryClient.invalidateQueries();
    },
  });
}
