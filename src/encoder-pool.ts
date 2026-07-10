import type { Env } from "./env";

/** Single warm encoder container instance shared by all clip and GIF jobs. */
export const ENCODER_POOL_INSTANCE = "encoder-0";

/** Idempotent warm-up via the container's /__carpo/start endpoint. */
export async function prewarmEncoder(
  env: Env,
  options?: { body?: unknown },
): Promise<void> {
  const container = env.ENCODER_CONTAINER.getByName(ENCODER_POOL_INSTANCE);
  const init: RequestInit = { method: "POST" };
  if (options?.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await container.fetch("http://encoder/__carpo/start", init);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail || `Encoder container start failed (${response.status})`,
    );
  }
}
