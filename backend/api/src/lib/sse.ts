/** Authored by: Mohit Singh */
import type { Response } from "express";

// Shared SSE plumbing — headers, heartbeat, clean teardown. Used by GET /jobs/:id/stream and
// GET /logs/stream. httpOnly-cookie auth (not bearer tokens) is exactly why these endpoints
// work with the browser's native EventSource — see auth/cookies.ts.
export class SseChannel {
  private readonly res: Response;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(res: Response) {
    this.res = res;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Keep intermediary proxies from timing out an idle connection.
    this.heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  }

  send(event: string, data: unknown): void {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.res.end();
  }
}
