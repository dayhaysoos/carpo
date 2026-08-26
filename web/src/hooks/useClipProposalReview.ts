import { useSyncExternalStore } from "react";
import type { ClipProposalReview } from "../clip-proposal-review";

export function useClipProposalReview(review: ClipProposalReview) {
  return useSyncExternalStore(
    review.subscribe,
    review.getSnapshot,
    review.getSnapshot,
  );
}
