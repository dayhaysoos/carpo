import { dispatch } from "@flue/runtime";
import { CarpoDurableReviewer } from "./agents/carpo-durable-reviewer";
import { parseReviewQueueMessage, resolveReviewInput } from "./build-events";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env) {
    for (const message of batch.messages) {
      const parsed = parseReviewQueueMessage(message.body);
      if (!parsed) {
        console.warn("[carpo-review] ignoring unsupported queue event");
        message.ack();
        continue;
      }
      try {
        // Intentionally serialize work that targets the shared review origin and bounded Browser/AI budget.
        // eslint-disable-next-line react-doctor/async-await-in-loop
        const initialData = await resolveReviewInput(parsed, env);
        if (!initialData) {
          console.info("[carpo-review] no exact frozen package for build event");
          message.ack();
          continue;
        }
        await dispatch(CarpoDurableReviewer, {
          id: initialData.executionId,
          initialData,
          idempotencyKey: `carpo-review:${initialData.executionId}:${initialData.candidate.headSha}`,
          message: {
            kind: "signal",
            type: "review_candidate",
            body: `Inspect exact candidate ${initialData.candidate.headSha}.`,
          },
        });
        message.ack();
      } catch (error) {
        console.error("[carpo-review] queued review dispatch failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
};
