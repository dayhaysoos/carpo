import { BrowserRenderingError, getBrowserRecording } from "agents/browser";
import type { RrwebEvent } from "./types";

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleRecording(env: Env, sessionId: string) {
  if (!SESSION_ID_RE.test(sessionId)) {
    return Response.json({ error: "Invalid session id" }, { status: 400 });
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_READ_TOKEN) {
    return Response.json(
      { error: "Browser recording credentials are not configured" },
      { status: 503 },
    );
  }
  try {
    const recording = await getBrowserRecording({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_READ_TOKEN,
      sessionId,
    });
    const events = (Object.values(recording.events).flat() as RrwebEvent[]).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    return Response.json(
      { events, duration: recording.duration },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (error) {
    const status = error instanceof BrowserRenderingError ? error.status : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : "Recording fetch failed" },
      { status: status === 404 ? 404 : 502 },
    );
  }
}
