import { Container } from "@cloudflare/containers";

// Hard ceiling for stale jobRunning keepalive. If the worker isolate dies
// mid-/run, dispatchEncodingJob's finally never clears the flag; without a
// TTL the container would renew forever and leak a max_instances slot.
const JOB_RUNNING_TTL_MS = 30 * 60 * 1000;

export class EncoderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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
}
