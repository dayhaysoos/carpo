import * as v from "valibot";
import {
  durableReviewInitialDataSchema,
  durableReviewResultSchema,
  findingSchema,
  reviewReportInputSchema,
  screenshotSchema,
} from "@carpo/review-contract";

export {
  durableReviewInitialDataSchema,
  durableReviewResultSchema,
  findingSchema,
  reviewReportInputSchema,
  screenshotSchema,
};

export type Finding = v.InferOutput<typeof findingSchema>;
export type ReviewReportInput = v.InferOutput<typeof reviewReportInputSchema>;
export type DurableReviewResult = v.InferOutput<typeof durableReviewResultSchema>;
export type DurableReviewInitialData = v.InferOutput<
  typeof durableReviewInitialDataSchema
>;

export interface ReviewElement {
  id: string;
  tag: string;
  role?: string;
  type?: string;
  name: string;
  text: string;
  ariaLabel?: string;
  href?: string;
  disabled?: boolean;
}

export interface ScreenshotEvidence {
  file: string;
  note: string;
  url: string;
  path: string;
  sha256: string;
  downloadUrl: string;
}

export interface BrowserReviewState {
  phase: "browsing" | "published";
  browserSessionId: string | null;
  targetId: string | null;
  currentPath: string;
  elements: ReviewElement[];
  screenshots: ScreenshotEvidence[];
  screenshotHashes: string[];
  readSources: Array<"context" | "diff">;
  visitedPaths: string[];
  navigationStatuses: Record<string, number | null>;
  layoutChecks: Array<"desktop" | "mobile">;
  diagnosticsRead: boolean;
  startedAt: string | null;
  proofChallengeSteps: Array<{
    language: string;
    value: string;
    screenshot: string;
  }>;
  pendingProofChallenge: {
    language: string;
    value: string;
    elementId: string;
  } | null;
}

export interface RrwebEvent {
  timestamp: number;
  type: number;
  data: unknown;
}
