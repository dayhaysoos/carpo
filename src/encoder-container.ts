import { Container } from "@cloudflare/containers";
import type { Env } from "./env";
import { UPLOAD_KEY_PREFIX } from "./uploads";

// Hard ceiling for stale jobRunning keepalive. If the worker isolate dies
// mid-/run, dispatchEncodingJob's finally never clears the flag; without a
// TTL the container would renew forever and leak a max_instances slot.
//
// Budget (container/encoder.py): download 600s + encode pass 600s + encode
// pass 600s + upload 600s + upload 600s = 3000s (~50 min) sequential worst
// case. TTL must exceed that; 70 min gives headroom.
const JOB_RUNNING_TTL_MS = 70 * 60 * 1000;

export class EncoderContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__carpo/source" && request.method === "GET") {
      return this.handleUploadSourceFetch(url);
    }

    if (url.pathname === "/__carpo/start" && request.method === "POST") {
      await this.startAndWaitForPorts({
        ports: 8080,
        startOptions: {
          enableInternet: true,
        },
        cancellationOptions: {
          portReadyTimeoutMS: 60_000,
        },
      });
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__carpo/renew-activity" && request.method === "POST") {
      this.renewActivityTimeout();
      await this.ctx.storage.put("lastActivity", Date.now());
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__carpo/job-running" && request.method === "POST") {
      const body = (await request.json()) as { running?: boolean };
      const running = Boolean(body.running);
      await this.ctx.storage.put("jobRunning", running);
      if (running) {
        await this.ctx.storage.put("jobStartedAt", Date.now());
      } else {
        await this.ctx.storage.delete("jobStartedAt");
      }
      return new Response(null, { status: 204 });
    }

    return super.fetch(request);
  }

  override async onActivityExpired(): Promise<void> {
    const jobRunning = await this.ctx.storage.get<boolean>("jobRunning");
    if (jobRunning) {
      const jobStartedAt = await this.ctx.storage.get<number>("jobStartedAt");
      const elapsed = jobStartedAt ? Date.now() - jobStartedAt : Infinity;
      if (elapsed < JOB_RUNNING_TTL_MS) {
        this.renewActivityTimeout();
        return;
      }
      await this.ctx.storage.put("jobRunning", false);
      await this.ctx.storage.delete("jobStartedAt");
    }
    await this.stop();
  }

  private async handleUploadSourceFetch(url: URL): Promise<Response> {
    const uploadKey = url.searchParams.get("key")?.trim() ?? "";
    if (!uploadKey.startsWith(UPLOAD_KEY_PREFIX)) {
      return new Response("Invalid upload key", { status: 400 });
    }

    const object = await this.env.CLIPS_BUCKET.get(uploadKey);
    if (!object) {
      return new Response("Upload source not found", { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, no-store");

    return new Response(object.body, { headers });
  }
}
