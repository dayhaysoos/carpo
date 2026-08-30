import {
  CLIP_QUALITIES,
  MAX_CAPTION_LENGTH,
  MAX_CLIP_LENGTH_SECONDS,
  MIN_TRIM_GAP_SECONDS,
  type ClipQuality,
  type ClipStatus,
} from "./types";

export const MAX_CLIP_PROPOSALS_PER_BATCH = 10;
export const MAX_QUEUED_CLIP_PROPOSAL_BATCHES = 3;

export type ClipProposalAdapter = "library" | "visual" | "think" | "webmcp";

export interface ClipProposalInput {
  title: string;
  startSeconds: number;
  endSeconds: number;
  caption?: string;
  quality?: ClipQuality;
}

export interface ClipProposalProvenance {
  adapter: ClipProposalAdapter;
  label: string;
  rationale?: string;
  sourceBlockIds?: string[];
  workspaceRevision?: string;
  contractVersion?: string;
  sourceFrameIds?: string[];
  sourceRevision?: string;
  proposedAt: string;
}

export interface ClipProposalEvidence {
  rationale?: string;
  sourceBlockIds?: string[];
  workspaceRevision?: string;
  contractVersion?: string;
  sourceFrameIds?: string[];
  sourceRevision?: string;
}

export interface CreatedClipResult {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  quality: ClipQuality;
  status: ClipStatus;
}

export type ClipProposalOutcome =
  | { status: "created"; clip: CreatedClipResult }
  | { status: "rejected" }
  | { status: "cancelled" };

export interface ClipProposalDraft {
  proposalId: string;
  input: ClipProposalInput;
  evidence?: ClipProposalEvidence;
  settle: (outcome: ClipProposalOutcome) => void | Promise<void>;
}

export interface ClipProposalSubmission {
  adapter: ClipProposalAdapter;
  requestId: string;
  videoId: string;
  atomic?: boolean;
  proposals: ClipProposalDraft[];
}

export interface ClipProposalVideoContext {
  id: string;
  durationSeconds: number | null;
}

export type ClipProposalAdmissionIssueCode =
  | "ATOMIC_SUBMISSION_REJECTED"
  | "BATCH_FROZEN"
  | "BATCH_TOO_LARGE"
  | "DUPLICATE_PROPOSAL_ID"
  | "INVALID_IDENTITY"
  | "INVALID_OVERLAY_TEXT"
  | "INVALID_QUALITY"
  | "INVALID_RANGE"
  | "INVALID_TITLE"
  | "QUEUE_FULL"
  | "VIDEO_MISMATCH";

export interface ClipProposalAdmissionIssue {
  code: ClipProposalAdmissionIssueCode;
  path: string;
  message: string;
}

export type ClipProposalAdmissionState =
  | "ready-for-review"
  | "queued"
  | "completed"
  | "rejected";

export interface ClipProposalAdmissionItem {
  proposalId: string;
  canonicalId: string | null;
  state: ClipProposalAdmissionState;
  replayed: boolean;
  issues: ClipProposalAdmissionIssue[];
}

export interface ClipProposalAdmissionResult {
  issues: ClipProposalAdmissionIssue[];
  items: ClipProposalAdmissionItem[];
  snapshot: ClipProposalReviewSnapshot;
}

interface AdmittedClipProposalIdentity {
  id: string;
  videoId: string;
  idempotencyKey: string;
}

export interface ClipProposalPersistence {
  create: (
    proposal: AdmittedClipProposalIdentity,
    input: ClipProposalInput,
  ) => Promise<CreatedClipResult>;
}

export interface ClipProposalReviewItem {
  proposalId: string;
  originalInput: ClipProposalInput;
  input: ClipProposalInput;
  provenance: ClipProposalProvenance;
  decision: boolean | null;
  error: string | null;
}

export interface ClipProposalReviewSnapshot {
  videoId: string;
  isOpen: boolean;
  submitting: boolean;
  submitError: string | null;
  activeIndex: number;
  items: ClipProposalReviewItem[];
  approvedCount: number;
  reviewedCount: number;
  allReviewed: boolean;
}

export type ClipProposalReviewCommand =
  | { type: "open" }
  | { type: "dismiss" }
  | { type: "navigate"; index: number }
  | { type: "edit"; proposalId: string; input: ClipProposalInput }
  | { type: "decide"; proposalId: string; approved: boolean }
  | { type: "decide-all"; approved: boolean };

export interface FinishClipProposalReviewResult {
  created: CreatedClipResult[];
}

interface InternalReviewItem {
  identity: AdmittedClipProposalIdentity;
  originalInput: ClipProposalInput;
  input: ClipProposalInput;
  provenance: ClipProposalProvenance;
  settle: ClipProposalDraft["settle"];
  decision: boolean | null;
  outcome: ClipProposalOutcome | null;
  settled: boolean;
  error: string | null;
}

interface InternalReviewBatch {
  items: InternalReviewItem[];
  isOpen: boolean;
  submitting: boolean;
  submitError: string | null;
  activeIndex: number;
}

interface VideoReviewSession {
  video: ClipProposalVideoContext;
  activeBatch: InternalReviewBatch | null;
  queuedBatches: InternalReviewBatch[];
  completedProposalIds: Set<string>;
  submissions: Map<string, Set<string>>;
}

interface PendingAdmission {
  index: number;
  draft: ClipProposalDraft;
  canonicalId: string;
  input: ClipProposalInput;
}

const ADAPTER_LABELS: Record<ClipProposalAdapter, string> = {
  library: "Library search",
  visual: "Visual search",
  think: "Think",
  webmcp: "WebMCP",
};

function cloneInput(input: ClipProposalInput): ClipProposalInput {
  return { ...input };
}

function cloneProvenance(
  provenance: ClipProposalProvenance,
): ClipProposalProvenance {
  return {
    ...provenance,
    sourceBlockIds: provenance.sourceBlockIds
      ? [...provenance.sourceBlockIds]
      : undefined,
    sourceFrameIds: provenance.sourceFrameIds
      ? [...provenance.sourceFrameIds]
      : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The proposal could not be completed.";
}

function runSequentially<T>(
  items: readonly T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  return items.reduce(
    (completion, item) => completion.then(() => task(item)),
    Promise.resolve(),
  );
}

function emptySnapshot(videoId: string): ClipProposalReviewSnapshot {
  return {
    videoId,
    isOpen: false,
    submitting: false,
    submitError: null,
    activeIndex: 0,
    items: [],
    approvedCount: 0,
    reviewedCount: 0,
    allReviewed: false,
  };
}

function identityIsValid(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function encodeIdentity(value: string): string {
  return encodeURIComponent(value);
}

function submissionKey(submission: ClipProposalSubmission): string {
  return [
    submission.adapter,
    encodeIdentity(submission.videoId),
    encodeIdentity(submission.requestId),
  ].join(":");
}

function canonicalProposalId(
  submission: ClipProposalSubmission,
  proposalId: string,
): string {
  return `${submissionKey(submission)}:${encodeIdentity(proposalId)}`;
}

function issue(
  code: ClipProposalAdmissionIssueCode,
  path: string,
  message: string,
): ClipProposalAdmissionIssue {
  return { code, path, message };
}

function validateInput(
  input: ClipProposalInput,
  video: ClipProposalVideoContext,
  pathPrefix: string,
): { input: ClipProposalInput | null; issues: ClipProposalAdmissionIssue[] } {
  const candidate = input as Partial<ClipProposalInput>;
  const issues: ClipProposalAdmissionIssue[] = [];
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const startSeconds = candidate.startSeconds;
  const endSeconds = candidate.endSeconds;
  const caption =
    typeof candidate.caption === "string" ? candidate.caption.trim() : undefined;

  if (!title || title.length > 200) {
    issues.push(
      issue(
        "INVALID_TITLE",
        `${pathPrefix}.title`,
        "Title must contain 1 to 200 characters.",
      ),
    );
  }

  if (
    typeof startSeconds !== "number" ||
    !Number.isFinite(startSeconds) ||
    startSeconds < 0 ||
    typeof endSeconds !== "number" ||
    !Number.isFinite(endSeconds) ||
    endSeconds - startSeconds < MIN_TRIM_GAP_SECONDS ||
    endSeconds - startSeconds > MAX_CLIP_LENGTH_SECONDS
  ) {
    issues.push(
      issue(
        "INVALID_RANGE",
        `${pathPrefix}.range`,
        `Clip range must be finite, non-negative, increasing, and no longer than ${MAX_CLIP_LENGTH_SECONDS} seconds.`,
      ),
    );
  } else if (
    video.durationSeconds !== null &&
    video.durationSeconds > 0 &&
    endSeconds > video.durationSeconds
  ) {
    issues.push(
      issue(
        "INVALID_RANGE",
        `${pathPrefix}.endSeconds`,
        `Clip range exceeds the ${video.durationSeconds}-second Video duration.`,
      ),
    );
  }

  if (
    candidate.caption !== undefined &&
    (typeof candidate.caption !== "string" ||
      (caption?.length ?? 0) > MAX_CAPTION_LENGTH)
  ) {
    issues.push(
      issue(
        "INVALID_OVERLAY_TEXT",
        `${pathPrefix}.caption`,
        `Overlay Text must be ${MAX_CAPTION_LENGTH} characters or fewer.`,
      ),
    );
  }

  if (
    candidate.quality !== undefined &&
    !CLIP_QUALITIES.includes(candidate.quality as ClipQuality)
  ) {
    issues.push(
      issue(
        "INVALID_QUALITY",
        `${pathPrefix}.quality`,
        "Quality must be '720p' or '1080p'.",
      ),
    );
  }

  return {
    input:
      issues.length > 0
        ? null
        : {
            title,
            startSeconds: startSeconds as number,
            endSeconds: endSeconds as number,
            ...(caption ? { caption } : {}),
            quality: candidate.quality ?? "1080p",
          },
    issues,
  };
}

function rejectedAdmission(
  proposalId: string,
  issues: ClipProposalAdmissionIssue[],
  canonicalId: string | null = null,
): ClipProposalAdmissionItem {
  return {
    proposalId,
    canonicalId,
    state: "rejected",
    replayed: false,
    issues,
  };
}

export class ClipProposalReview {
  private readonly sessions = new Map<string, VideoReviewSession>();
  private readonly listeners = new Set<() => void>();
  private activeVideoId = "";
  private snapshot = emptySnapshot("");

  constructor(private readonly persistence: ClipProposalPersistence) {}

  getSnapshot = (): ClipProposalReviewSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate(video: ClipProposalVideoContext | null): void {
    const nextVideoId = video?.id ?? "";
    if (video) {
      const session = this.session(video);
      session.video = { ...video };
    }
    if (nextVideoId === this.activeVideoId) return;
    this.activeVideoId = nextVideoId;
    this.publish();
  }

  admit(submission: ClipProposalSubmission): ClipProposalAdmissionResult {
    const activeSession = this.sessions.get(this.activeVideoId);
    const baseSnapshot = () => this.getSnapshot();
    const rejectAll = (
      makeIssues: (index: number) => ClipProposalAdmissionIssue[],
    ): ClipProposalAdmissionResult => {
      const items = submission.proposals.map((draft, index) =>
        rejectedAdmission(draft.proposalId, makeIssues(index)),
      );
      return {
        issues: items.length === 0 ? makeIssues(0) : [],
        items,
        snapshot: baseSnapshot(),
      };
    };

    if (!activeSession || submission.videoId !== this.activeVideoId) {
      return rejectAll((index) => [
        issue(
          "VIDEO_MISMATCH",
          `proposals[${index}].videoId`,
          "The proposal Video does not match the active Video.",
        ),
      ]);
    }

    if (!identityIsValid(submission.requestId)) {
      return rejectAll((index) => [
        issue(
          "INVALID_IDENTITY",
          `proposals[${index}].requestId`,
          "Request identity must contain 1 to 128 printable characters.",
        ),
      ]);
    }

    if (
      submission.proposals.length < 1 ||
      submission.proposals.length > MAX_CLIP_PROPOSALS_PER_BATCH
    ) {
      return rejectAll((index) => [
        issue(
          "BATCH_TOO_LARGE",
          `proposals[${index}]`,
          `A Clip Proposal Batch must contain 1 to ${MAX_CLIP_PROPOSALS_PER_BATCH} proposals.`,
        ),
      ]);
    }

    const key = submissionKey(submission);
    const frozenProposalIds = activeSession.submissions.get(key);
    const seenProposalIds = new Set<string>();
    const results: Array<ClipProposalAdmissionItem | undefined> = new Array(
      submission.proposals.length,
    );
    const pending: PendingAdmission[] = [];

    submission.proposals.forEach((draft, index) => {
      const proposalPath = `proposals[${index}]`;
      if (!identityIsValid(draft.proposalId)) {
        results[index] = rejectedAdmission(draft.proposalId, [
          issue(
            "INVALID_IDENTITY",
            `${proposalPath}.proposalId`,
            "Proposal identity must contain 1 to 128 printable characters.",
          ),
        ]);
        return;
      }
      if (seenProposalIds.has(draft.proposalId)) {
        results[index] = rejectedAdmission(draft.proposalId, [
          issue(
            "DUPLICATE_PROPOSAL_ID",
            `${proposalPath}.proposalId`,
            "Proposal identity must be unique within its batch.",
          ),
        ]);
        return;
      }
      seenProposalIds.add(draft.proposalId);

      const canonicalId = canonicalProposalId(submission, draft.proposalId);
      const existing = this.findProposal(activeSession, canonicalId);
      if (existing) {
        existing.item.settle = draft.settle;
        results[index] = {
          proposalId: draft.proposalId,
          canonicalId,
          state: existing.state,
          replayed: true,
          issues: [],
        };
        return;
      }
      if (activeSession.completedProposalIds.has(canonicalId)) {
        results[index] = {
          proposalId: draft.proposalId,
          canonicalId,
          state: "completed",
          replayed: true,
          issues: [],
        };
        return;
      }
      if (frozenProposalIds && !frozenProposalIds.has(canonicalId)) {
        results[index] = rejectedAdmission(
          draft.proposalId,
          [
            issue(
              "BATCH_FROZEN",
              `${proposalPath}.proposalId`,
              "This Clip Proposal Batch is already frozen; use a new request identity for new proposals.",
            ),
          ],
          canonicalId,
        );
        return;
      }

      const validated = validateInput(
        draft.input,
        activeSession.video,
        `${proposalPath}.input`,
      );
      if (!validated.input) {
        results[index] = rejectedAdmission(
          draft.proposalId,
          validated.issues,
          canonicalId,
        );
        return;
      }
      pending.push({ index, draft, canonicalId, input: validated.input });
    });

    const hasRejected = results.some((result) => result?.state === "rejected");
    if (submission.atomic && hasRejected && pending.length > 0) {
      for (const candidate of pending) {
        results[candidate.index] = rejectedAdmission(
          candidate.draft.proposalId,
          [
            issue(
              "ATOMIC_SUBMISSION_REJECTED",
              `proposals[${candidate.index}]`,
              "Another proposal in this atomic submission was invalid, so no new proposals were admitted.",
            ),
          ],
          candidate.canonicalId,
        );
      }
      return {
        issues: [],
        items: results.filter(
          (result): result is ClipProposalAdmissionItem => Boolean(result),
        ),
        snapshot: baseSnapshot(),
      };
    }

    if (
      pending.length > 0 &&
      activeSession.activeBatch &&
      activeSession.queuedBatches.length >= MAX_QUEUED_CLIP_PROPOSAL_BATCHES
    ) {
      for (const candidate of pending) {
        results[candidate.index] = rejectedAdmission(
          candidate.draft.proposalId,
          [
            issue(
              "QUEUE_FULL",
              `proposals[${candidate.index}]`,
              `This Video already has one active and ${MAX_QUEUED_CLIP_PROPOSAL_BATCHES} queued Clip Proposal Batches.`,
            ),
          ],
          candidate.canonicalId,
        );
      }
      return {
        issues: [],
        items: results.filter(
          (result): result is ClipProposalAdmissionItem => Boolean(result),
        ),
        snapshot: baseSnapshot(),
      };
    }

    if (pending.length > 0) {
      const proposedAt = new Date().toISOString();
      const batch: InternalReviewBatch = {
        items: pending
          .map(({ draft, canonicalId, input }) => ({
            identity: {
              id: canonicalId,
              videoId: submission.videoId,
              idempotencyKey: canonicalId,
            },
            originalInput: cloneInput(input),
            input: cloneInput(input),
            provenance: {
              adapter: submission.adapter,
              label: ADAPTER_LABELS[submission.adapter],
              ...draft.evidence,
              sourceBlockIds: draft.evidence?.sourceBlockIds
                ? [...draft.evidence.sourceBlockIds]
                : undefined,
              proposedAt,
            },
            settle: draft.settle,
            decision: null,
            outcome: null,
            settled: false,
            error: null,
          }))
          .sort(
            (left, right) =>
              left.input.startSeconds - right.input.startSeconds ||
              left.input.endSeconds - right.input.endSeconds,
          ),
        isOpen: true,
        submitting: false,
        submitError: null,
        activeIndex: 0,
      };
      const state: ClipProposalAdmissionState = activeSession.activeBatch
        ? "queued"
        : "ready-for-review";
      if (activeSession.activeBatch) {
        activeSession.queuedBatches.push(batch);
      } else {
        activeSession.activeBatch = batch;
      }
      activeSession.submissions.set(
        key,
        new Set(pending.map(({ canonicalId }) => canonicalId)),
      );
      for (const candidate of pending) {
        results[candidate.index] = {
          proposalId: candidate.draft.proposalId,
          canonicalId: candidate.canonicalId,
          state,
          replayed: false,
          issues: [],
        };
      }
      this.publish();
    }

    return {
      issues: [],
      items: results.filter(
        (result): result is ClipProposalAdmissionItem => Boolean(result),
      ),
      snapshot: baseSnapshot(),
    };
  }

  dispatch = (command: ClipProposalReviewCommand): void => {
    const batch = this.activeBatch();
    if (!batch || batch.submitting) return;

    switch (command.type) {
      case "open":
        batch.isOpen = true;
        break;
      case "dismiss":
        batch.isOpen = false;
        break;
      case "navigate":
        batch.activeIndex = Math.max(
          0,
          Math.min(command.index, batch.items.length - 1),
        );
        break;
      case "edit": {
        const item = batch.items.find(
          ({ identity }) => identity.id === command.proposalId,
        );
        if (item && !item.outcome) {
          item.input = cloneInput(command.input);
          item.error = null;
          batch.submitError = null;
        }
        break;
      }
      case "decide": {
        const item = batch.items.find(
          ({ identity }) => identity.id === command.proposalId,
        );
        if (item && !item.outcome) {
          item.decision = command.approved;
          item.error = null;
          batch.submitError = null;
        }
        break;
      }
      case "decide-all":
        for (const item of batch.items) {
          if (!item.outcome) item.decision = command.approved;
        }
        batch.submitError = null;
        break;
    }

    this.publish();
  };

  finish = async (): Promise<FinishClipProposalReviewResult> => {
    const session = this.sessions.get(this.activeVideoId);
    const batch = session?.activeBatch;
    const emptyResult = { created: [] };
    if (!session || !batch || batch.submitting) return emptyResult;

    if (batch.items.some((item) => item.decision === null)) {
      batch.submitError = "Review every clip before finishing.";
      this.publish();
      return emptyResult;
    }

    batch.submitting = true;
    batch.submitError = null;
    this.publish();

    const created: CreatedClipResult[] = [];
    await runSequentially(batch.items, async (item) => {
      item.error = null;
      try {
        if (!item.outcome) {
          if (item.decision) {
            const validation = validateInput(item.input, session.video, "input");
            if (!validation.input) {
              throw new Error(validation.issues[0].message);
            }
            const clip = await this.persistence.create(
              item.identity,
              cloneInput(validation.input),
            );
            item.outcome = { status: "created", clip };
            created.push(clip);
          } else {
            item.outcome = { status: "rejected" };
          }
        }

        try {
          await item.settle(item.outcome);
          item.settled = true;
        } catch (error) {
          if (item.outcome.status === "rejected") {
            item.settled = true;
          } else {
            throw error;
          }
        }
      } catch (error) {
        item.error = errorMessage(error);
      }
      this.publish();
    });

    const completed = batch.items.filter((item) => item.settled);
    const failed = batch.items.filter((item) => !item.settled);
    for (const item of completed) {
      session.completedProposalIds.add(item.identity.id);
    }

    const result: FinishClipProposalReviewResult = { created };

    if (failed.length > 0) {
      batch.items = failed;
      batch.activeIndex = 0;
      batch.submitting = false;
      batch.isOpen = true;
      batch.submitError = `${failed.length} clip proposal${
        failed.length === 1 ? "" : "s"
      } could not be completed. Review and retry ${
        failed.length === 1 ? "it" : "them"
      }.`;
    } else {
      session.activeBatch = null;
      this.startNextBatch(session);
    }

    this.publish();
    return result;
  };

  async cancel(videoId: string): Promise<void> {
    const session = this.sessions.get(videoId);
    if (!session) return;
    const items = [
      ...(session.activeBatch?.items ?? []),
      ...session.queuedBatches.flatMap((batch) => batch.items),
    ];
    this.sessions.delete(videoId);
    if (this.activeVideoId === videoId) {
      this.activeVideoId = "";
      this.publish();
    }
    await Promise.allSettled(
      items.map((item) => Promise.resolve(item.settle({ status: "cancelled" }))),
    );
  }

  private session(video: ClipProposalVideoContext): VideoReviewSession {
    const existing = this.sessions.get(video.id);
    if (existing) return existing;
    const session: VideoReviewSession = {
      video: { ...video },
      activeBatch: null,
      queuedBatches: [],
      completedProposalIds: new Set(),
      submissions: new Map(),
    };
    this.sessions.set(video.id, session);
    return session;
  }

  private activeBatch(): InternalReviewBatch | null {
    return this.sessions.get(this.activeVideoId)?.activeBatch ?? null;
  }

  private findProposal(
    session: VideoReviewSession,
    proposalId: string,
  ):
    | {
        item: InternalReviewItem;
        state: "ready-for-review" | "queued";
      }
    | null {
    const activeItem = session.activeBatch?.items.find(
      ({ identity }) => identity.id === proposalId,
    );
    if (activeItem) return { item: activeItem, state: "ready-for-review" };
    for (const batch of session.queuedBatches) {
      const item = batch.items.find(({ identity }) => identity.id === proposalId);
      if (item) return { item, state: "queued" };
    }
    return null;
  }

  private startNextBatch(session: VideoReviewSession): boolean {
    if (session.activeBatch || session.queuedBatches.length === 0) return false;
    session.activeBatch = session.queuedBatches.shift() ?? null;
    return Boolean(session.activeBatch);
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ClipProposalReviewSnapshot {
    const session = this.sessions.get(this.activeVideoId);
    const batch = session?.activeBatch;
    if (!session || !batch) return emptySnapshot(this.activeVideoId);

    const items = batch.items.map<ClipProposalReviewItem>((item) => ({
      proposalId: item.identity.id,
      originalInput: cloneInput(item.originalInput),
      input: cloneInput(item.input),
      provenance: cloneProvenance(item.provenance),
      decision: item.decision,
      error: item.error,
    }));
    const reviewedCount = items.filter(({ decision }) => decision !== null).length;
    const approvedCount = items.filter(({ decision }) => decision === true).length;
    return {
      videoId: session.video.id,
      isOpen: batch.isOpen,
      submitting: batch.submitting,
      submitError: batch.submitError,
      activeIndex: Math.min(batch.activeIndex, Math.max(0, items.length - 1)),
      items,
      approvedCount,
      reviewedCount,
      allReviewed: items.length > 0 && reviewedCount === items.length,
    };
  }
}
