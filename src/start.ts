/** Authored by: Mohit Singh */
import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// No functionMiddleware — the frontend is a pure API client of backend/api (JWT via httpOnly
// cookies, see lib/api-client.ts); it has no TanStack Start server functions of its own that
// need request-scoped auth context.
export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware],
}));
