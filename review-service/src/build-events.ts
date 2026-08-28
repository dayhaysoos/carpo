import * as v from "valibot";
import { durableReviewInitialDataSchema } from "./types";

const workersBuildSucceededSchema = v.object({
  type: v.literal("cf.workersBuilds.worker.build.succeeded"),
  source: v.object({
    type: v.literal("workersBuilds.worker"),
    workerName: v.string(),
  }),
  payload: v.object({
    buildUuid: v.string(),
    status: v.string(),
    buildOutcome: v.literal("success"),
    buildTriggerMetadata: v.object({
      branch: v.string(),
      commitHash: v.string(),
      repoName: v.string(),
      providerType: v.string(),
    }),
  }),
  metadata: v.object({ accountId: v.string() }),
});

const candidateReadySchema = v.object({
  type: v.literal("carpo.review.candidate-ready.v1"),
  headSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i)),
});

export type WorkersBuildSucceededEvent = v.InferOutput<
  typeof workersBuildSucceededSchema
>;

export type ReviewQueueMessage =
  | { type: "candidate-ready"; headSha: string }
  | { type: "workers-build"; event: WorkersBuildSucceededEvent };

export function parseReviewQueueMessage(value: unknown): ReviewQueueMessage | null {
  const direct = v.safeParse(candidateReadySchema, value);
  if (direct.success) {
    return { type: "candidate-ready", headSha: direct.output.headSha };
  }
  const build = v.safeParse(workersBuildSucceededSchema, value);
  return build.success ? { type: "workers-build", event: build.output } : null;
}

export async function resolveReviewInput(
  message: ReviewQueueMessage,
  env: Pick<
    Env,
    "CLOUDFLARE_ACCOUNT_ID" | "EVIDENCE_BUCKET" | "TARGET_REVIEW_WORKER_NAME"
  >,
) {
  if (
    message.type === "workers-build" &&
    ((env.TARGET_REVIEW_WORKER_NAME &&
      message.event.source.workerName !== env.TARGET_REVIEW_WORKER_NAME) ||
      (env.CLOUDFLARE_ACCOUNT_ID &&
        message.event.metadata.accountId !== env.CLOUDFLARE_ACCOUNT_ID))
  ) {
    return null;
  }
  const sha =
    message.type === "candidate-ready"
      ? message.headSha.toLowerCase()
      : message.event.payload.buildTriggerMetadata.commitHash.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const stored = await env.EVIDENCE_BUCKET.get(`durable-inputs/${sha}.json`);
  if (!stored) return null;
  const parsed = v.safeParse(
    durableReviewInitialDataSchema,
    await stored.json<unknown>(),
  );
  if (!parsed.success || parsed.output.candidate.headSha.toLowerCase() !== sha) {
    throw new Error("The staged build-event review package does not match the build commit");
  }
  return message.type === "workers-build"
    ? {
        ...parsed.output,
        source: {
          provider: "cloudflare-builds" as const,
          sourceUrl: parsed.output.source.sourceUrl,
        },
      }
    : parsed.output;
}
