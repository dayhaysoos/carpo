import {
  HELPER_TOKEN_HEADER,
  verifyHelperToken,
} from "./auth";
import {
  claimOldestPendingHelperJob,
  expireClaimedHelperJob,
  expirePendingHelperJob,
  fulfillHelperJob,
  getClipById,
  listRecoverableHelperClips,
  markHelperRecovering,
  sweepStaleHelperClaims,
} from "./db";
import type { Env } from "./env";
import { dispatchEncodingJob } from "./jobs";
import { parseFilters, recordToResponse } from "./serialize";
import type { ClipRecord, CreateClipRequest } from "./types";
import { isValidUploadKey } from "./uploads";

export function isHelperEnabled(env: Env): boolean {
  return Boolean(env.HELPER_TOKEN);
}

export function helperClaimWindowMs(env: Env): number {
  const raw = env.HELPER_CLAIM_WINDOW_SECONDS;
  if (raw === undefined || raw === "") {
    return 10_000;
  }
  const seconds = Number(raw);
  return (Number.isFinite(seconds) ? seconds : 10) * 1000;
}

export function recordToCreateClipRequest(record: ClipRecord): CreateClipRequest {
  const source =
    record.source_type === "youtube"
      ? { type: "youtube" as const, url: record.source_ref }
      : { type: "upload" as const, key: record.source_ref };
  return {
    title: record.title,
    source,
    trimStart: record.trim_start,
    trimEnd: record.trim_end,
    quality: record.quality,
    filters: parseFilters(record.filters_json),
  };
}

export async function scheduleHelperClaimWindowFallback(
  env: Env,
  clipId: string,
  origin: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const windowMs = helperClaimWindowMs(env);
  if (windowMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
  }
  const expired = await expirePendingHelperJob(env.DB, clipId);
  if (!expired) {
    return;
  }
  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return;
  }
  await recoverHelperFallback(env, record, origin, ctx);
}

// Claims the row via helper_state 'expired'→'recovering' rather than advancing
// status: the container DO durably sets status via markClipDownloadingIfQueued
// in its dispatch handler, so status leaving 'queued' is proof the dispatch
// actually reached the DO. If the isolate dies between this CAS and the DO
// receiving the dispatch, the row sits at recovering/queued, which the sweep
// detects and flips back to 'expired' for retry. The CAS keeps recovery
// idempotent and race-safe across concurrent pollers.
export async function recoverHelperFallback(
  env: Env,
  record: ClipRecord,
  origin: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const claimed = await markHelperRecovering(env.DB, record.id);
  if (!claimed) {
    return;
  }
  ctx.waitUntil(
    dispatchEncodingJob(
      env,
      record.id,
      recordToCreateClipRequest(record),
      origin,
    ),
  );
}

// Expired-and-queued youtube clips are exactly "awaiting container fallback",
// whichever path left them there (stale sweep, fail endpoint, claim-window
// expiry, or a recovery waitUntil that died before dispatching).
export async function sweepAndRecoverHelperClips(
  env: Env,
  origin: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  await sweepStaleHelperClaims(env.DB, helperClaimWindowMs(env) / 1000);
  const records = await listRecoverableHelperClips(env.DB);
  for (const record of records) {
    await recoverHelperFallback(env, record, origin, ctx);
  }
}

function helperAuthError(request: Request, env: Env): Response | null {
  if (!isHelperEnabled(env)) {
    return json({ error: "Not found" }, 404);
  }
  const provided = request.headers.get(HELPER_TOKEN_HEADER);
  if (!verifyHelperToken(provided, env.HELPER_TOKEN!)) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

export async function handleHelperClaim(
  request: Request,
  env: Env,
): Promise<Response> {
  const authError = helperAuthError(request, env);
  if (authError) {
    return authError;
  }

  const record = await claimOldestPendingHelperJob(env.DB);
  if (!record) {
    return new Response(null, { status: 204 });
  }

  return json({
    clipId: record.id,
    url: record.source_ref,
    trimStart: record.trim_start,
    trimEnd: record.trim_end,
    quality: record.quality,
  });
}

interface FulfillBody {
  uploadKey?: string;
  sectionStart?: number;
}

export async function handleHelperFulfill(
  request: Request,
  clipId: string,
  env: Env,
  ctx: ExecutionContext,
  origin: string,
): Promise<Response> {
  const authError = helperAuthError(request, env);
  if (authError) {
    return authError;
  }

  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  let body: FulfillBody;
  try {
    body = (await request.json()) as FulfillBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const uploadKey =
    typeof body.uploadKey === "string" ? body.uploadKey.trim() : "";
  if (!uploadKey || !isValidUploadKey(uploadKey)) {
    return json(
      {
        error: "Validation failed",
        details: [
          {
            field: "uploadKey",
            message: "uploadKey must be a valid uploads/ object key",
          },
        ],
      },
      400,
    );
  }

  if (
    typeof body.sectionStart !== "number" ||
    !Number.isFinite(body.sectionStart) ||
    body.sectionStart < 0
  ) {
    return json(
      {
        error: "Validation failed",
        details: [
          {
            field: "sectionStart",
            message: "sectionStart must be a finite number >= 0",
          },
        ],
      },
      400,
    );
  }

  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }
  if (record.helper_state !== "claimed") {
    return json({ error: "Clip is not in a claimed helper state" }, 409);
  }
  if (body.sectionStart > record.trim_start) {
    return json(
      {
        error: "Validation failed",
        details: [
          {
            field: "sectionStart",
            message: "sectionStart must be <= trimStart",
          },
        ],
      },
      400,
    );
  }

  const object = await env.CLIPS_BUCKET.head(uploadKey);
  if (!object) {
    return json(
      {
        error: "Upload not found",
        details: [
          {
            field: "uploadKey",
            message: "Uploaded source object was not found in R2",
          },
        ],
      },
      404,
    );
  }

  const adjStart = record.trim_start - body.sectionStart;
  const adjEnd = record.trim_end - body.sectionStart;
  if (adjEnd <= adjStart) {
    return json(
      {
        error: "Validation failed",
        details: [
          {
            field: "sectionStart",
            message: "Adjusted trim window must be positive",
          },
        ],
      },
      400,
    );
  }

  const fulfilled = await fulfillHelperJob(env.DB, clipId, uploadKey);
  if (!fulfilled) {
    return json({ error: "Clip is not in a claimed helper state" }, 409);
  }

  const syntheticRequest: CreateClipRequest = {
    title: record.title,
    source: { type: "upload", key: uploadKey },
    trimStart: adjStart,
    trimEnd: adjEnd,
    quality: record.quality,
    filters: parseFilters(record.filters_json),
  };

  ctx.waitUntil(dispatchEncodingJob(env, clipId, syntheticRequest, origin));

  const updated = await getClipById(env.DB, clipId);
  return json(recordToResponse(updated!, env.R2_PUBLIC_PREFIX), 202);
}

interface FailBody {
  errorMessage?: string;
}

export async function handleHelperFail(
  request: Request,
  clipId: string,
  env: Env,
  ctx: ExecutionContext,
  origin: string,
): Promise<Response> {
  const authError = helperAuthError(request, env);
  if (authError) {
    return authError;
  }

  if (!clipId) {
    return json({ error: "Clip id is required" }, 400);
  }

  const record = await getClipById(env.DB, clipId);
  if (!record) {
    return json({ error: "Clip not found" }, 404);
  }
  if (record.helper_state !== "claimed") {
    return json({ error: "Clip is not in a claimed helper state" }, 409);
  }

  const expired = await expireClaimedHelperJob(env.DB, clipId);
  if (!expired) {
    return json({ error: "Clip is not in a claimed helper state" }, 409);
  }

  const refreshed = await getClipById(env.DB, clipId);
  if (refreshed) {
    ctx.waitUntil(recoverHelperFallback(env, refreshed, origin, ctx));
  }

  const updated = await getClipById(env.DB, clipId);
  return json(recordToResponse(updated!, env.R2_PUBLIC_PREFIX), 202);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
