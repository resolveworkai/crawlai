/** Authored by: Mohit Singh */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCreateJob, useJobs } from "./useJobs";
import { createQueryWrapper, mockFetchSequence } from "./test-utils";
import type { CrawlJob } from "@/types/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleJob: CrawlJob = {
  id: "11111111-1111-1111-1111-111111111111",
  created_by: "u1",
  business_type: "gym",
  location_label: "Berlin, DE",
  center_lat: 52.52,
  center_lng: 13.405,
  radius_km: "5.00",
  status: "pending",
  cancel_requested: false,
  pause_requested: false,
  found_count: 0,
  crawled_count: 0,
  website_crawled_count: 0,
  failed_count: 0,
  current_business: null,
  error_message: null,
  started_at: null,
  finished_at: null,
  created_at: "2026-07-13T00:00:00.000Z",
  updated_at: "2026-07-13T00:00:00.000Z",
};

describe("useJobs", () => {
  it("unwraps the { jobs } envelope from GET /jobs", async () => {
    mockFetchSequence({ body: { jobs: [sampleJob] } });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useJobs(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([sampleJob]);
  });
});

describe("useCreateJob", () => {
  it("unwraps the { job } envelope from POST /jobs and sends the given input", async () => {
    const fetchMock = mockFetchSequence({ body: { job: sampleJob }, status: 201 });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useCreateJob(), { wrapper: Wrapper });

    result.current.mutate({ businessType: "gym", radiusKm: 5, location: "Berlin, DE" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleJob);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      businessType: "gym",
      radiusKm: 5,
      location: "Berlin, DE",
    });
  });

  it("surfaces a validation error message on a 400", async () => {
    mockFetchSequence({
      body: { error: { code: "VALIDATION_ERROR", message: "radiusKm must be positive" } },
      status: 400,
    });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useCreateJob(), { wrapper: Wrapper });

    result.current.mutate({ businessType: "gym", radiusKm: -1, location: "Berlin, DE" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("radiusKm must be positive");
  });
});
