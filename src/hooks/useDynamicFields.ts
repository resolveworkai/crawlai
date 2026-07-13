/** Authored by: Mohit Singh */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DynamicField, DynamicFieldType } from "@/types/api";

export const dynamicFieldKeys = {
  all: ["dynamic-fields"] as const,
};

interface CreateDynamicFieldInput {
  key: string;
  label: string;
  prompt: string;
  fieldType?: DynamicFieldType;
}

interface UpdateDynamicFieldInput {
  enabled?: boolean;
  label?: string;
  prompt?: string;
}

export function useDynamicFields() {
  return useQuery({
    queryKey: dynamicFieldKeys.all,
    queryFn: async () => (await api.get<{ fields: DynamicField[] }>("/dynamic-fields")).fields,
  });
}

export function useCreateDynamicField() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateDynamicFieldInput) =>
      (await api.post<{ field: DynamicField }>("/dynamic-fields", input)).field,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: dynamicFieldKeys.all });
    },
  });
}

export function useUpdateDynamicField() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateDynamicFieldInput }) =>
      (await api.patch<{ field: DynamicField }>(`/dynamic-fields/${id}`, patch)).field,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: dynamicFieldKeys.all });
    },
  });
}

export function useDeleteDynamicField() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/dynamic-fields/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: dynamicFieldKeys.all });
    },
  });
}
