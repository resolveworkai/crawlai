/** Authored by: Mohit Singh */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useCreateDynamicField,
  useDeleteDynamicField,
  useDynamicFields,
  useUpdateDynamicField,
} from "./useDynamicFields";
import { createQueryWrapper, mockFetchSequence } from "./test-utils";
import type { DynamicField } from "@/types/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleField: DynamicField = {
  id: "f-1",
  key: "wholesale",
  label: "Accepts Wholesale",
  prompt: "Does this business offer wholesale pricing?",
  field_type: "boolean",
  enabled: true,
  created_at: "2026-07-13T00:00:00.000Z",
  updated_at: "2026-07-13T00:00:00.000Z",
};

describe("useDynamicFields", () => {
  it("unwraps the { fields } envelope from GET /dynamic-fields", async () => {
    mockFetchSequence({ body: { fields: [sampleField] } });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useDynamicFields(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([sampleField]);
  });
});

describe("useCreateDynamicField", () => {
  it("unwraps the { field } envelope from POST /dynamic-fields", async () => {
    mockFetchSequence({ body: { field: sampleField }, status: 201 });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useCreateDynamicField(), { wrapper: Wrapper });

    result.current.mutate({
      key: "wholesale",
      label: "Accepts Wholesale",
      prompt: "Does this business offer wholesale pricing?",
      fieldType: "boolean",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleField);
  });

  it("surfaces a 409 conflict when the key already exists", async () => {
    mockFetchSequence({
      body: {
        error: { code: "CONFLICT", message: 'A dynamic field with key "wholesale" already exists' },
      },
      status: 409,
    });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useCreateDynamicField(), { wrapper: Wrapper });

    result.current.mutate({
      key: "wholesale",
      label: "Accepts Wholesale",
      prompt: "Does this business offer wholesale pricing?",
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe(
      'A dynamic field with key "wholesale" already exists',
    );
  });
});

describe("useUpdateDynamicField", () => {
  it("unwraps the { field } envelope from PATCH /dynamic-fields/:id", async () => {
    const updated = { ...sampleField, enabled: false };
    mockFetchSequence({ body: { field: updated } });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useUpdateDynamicField(), { wrapper: Wrapper });

    result.current.mutate({ id: sampleField.id, patch: { enabled: false } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(updated);
  });
});

describe("useDeleteDynamicField", () => {
  it("handles a 204 No Content response", async () => {
    mockFetchSequence({ status: 204 });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useDeleteDynamicField(), { wrapper: Wrapper });

    result.current.mutate(sampleField.id);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
