import { createClipFromSourceVideo } from "./api";
import { ClipProposalReview } from "./clip-proposal-review";

export function createClipProposalReview(): ClipProposalReview {
  return new ClipProposalReview({
    create: async (proposal, input) => {
      const clip = await createClipFromSourceVideo(
        proposal.videoId,
        {
          title: input.title,
          trimStart: input.startSeconds,
          trimEnd: input.endSeconds,
          quality: input.quality ?? "1080p",
          filters: input.caption
            ? [{ type: "caption", text: input.caption }]
            : [],
        },
        proposal.idempotencyKey,
      );
      return {
        id: clip.id,
        title: clip.title,
        startSeconds: clip.trimStart,
        endSeconds: clip.trimEnd,
        quality: clip.quality,
        status: clip.status,
      };
    },
  });
}
