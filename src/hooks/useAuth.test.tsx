/** Authored by: Mohit Singh */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCurrentUser, useLogin } from "./useAuth";
import { createQueryWrapper, mockFetchSequence } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCurrentUser", () => {
  it("returns the user on a successful /auth/me", async () => {
    mockFetchSequence({
      body: { user: { id: "u1", email: "a@b.com", fullName: null, roles: ["admin"] } },
    });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useCurrentUser(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      id: "u1",
      email: "a@b.com",
      fullName: null,
      roles: ["admin"],
    });
  });

  it("resolves to null on a 401 instead of throwing", async () => {
    // Two calls: the initial /auth/me 401, then api-client's transparent refresh attempt
    // (which also fails, since there's no session at all) before it gives up.
    mockFetchSequence(
      { body: { error: { code: "UNAUTHORIZED", message: "no session" } }, status: 401 },
      { status: 401 },
    );
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useCurrentUser(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe("useLogin", () => {
  it("unwraps the { user } envelope from POST /auth/login", async () => {
    mockFetchSequence({
      body: { user: { id: "u2", email: "b@c.com", fullName: "B C", roles: ["operator"] } },
    });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useLogin(), { wrapper: Wrapper });

    result.current.mutate({ email: "b@c.com", password: "secret" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      id: "u2",
      email: "b@c.com",
      fullName: "B C",
      roles: ["operator"],
    });
  });

  it("surfaces the API error message on invalid credentials", async () => {
    mockFetchSequence({
      body: { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } },
      status: 401,
    });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useLogin(), { wrapper: Wrapper });

    result.current.mutate({ email: "wrong@b.com", password: "bad" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Invalid email or password");
  });
});
