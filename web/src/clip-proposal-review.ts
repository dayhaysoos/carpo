import type { ClipQuality, ClipStatus } from "./types";

export interface ClipProposalInput {
  title: string;
  startSeconds: number;
  endSeconds: number;
  caption?: string;
  quality?: ClipQuality;
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

export interface ClipProposalEnvelope {
  id: string;
  videoId: string;
  idempotencyKey: string;
  input: ClipProposalInput;
  settle: (outcome: ClipProposalOutcome) => void | Promise<void>;
}

export interface ClipProposalPersistence {
  create: (
    proposal: Pick<ClipProposalEnvelope, "id" | "videoId" | "idempotencyKey">,
    input: ClipProposalInput,
  ) => Promise<CreatedClipResult>;
}

export interface ClipProposalReviewItem {
  proposalId: string;
  originalInput: ClipProposalInput;
  input: ClipProposalInput;
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
  envelope: ClipProposalEnvelope;
  originalInput: ClipProposalInput;
  input: ClipProposalInput;
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
  videoId: string;
  activeBatch: InternalReviewBatch | null;
  queued: ClipProposalEnvelope[];
  completedProposalIds: Set<string>;
}

function cloneInput(input: ClipProposalInput): ClipProposalInput {
  return { ...input };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The proposal could not be completed.";
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

  activate(videoId: string): void {
    if (videoId === this.activeVideoId) return;
    this.activeVideoId = videoId;
    this.publish();
  }

  synchronize(videoId: string, proposals: ClipProposalEnvelope[]): void {
    if (!videoId) return;
    const session = this.session(videoId);
    let snapshotChanged = false;

    for (const proposal of proposals) {
      if (
        proposal.videoId !== videoId ||
        session.completedProposalIds.has(proposal.id)
      ) {
        continue;
      }

      const activeItem = session.activeBatch?.items.find(
        (item) => item.envelope.id === proposal.id,
      );
      if (activeItem) {
        activeItem.envelope = proposal;
        continue;
      }

      const queuedIndex = session.queued.findIndex(
        (queued) => queued.id === proposal.id,
      );
      if (queuedIndex >= 0) {
        session.queued[queuedIndex] = proposal;
        continue;
      }

      session.queued.push(proposal);
      snapshotChanged = true;
    }

    if (!session.activeBatch && this.startNextBatch(session)) {
      snapshotChanged = true;
    }
    if (snapshotChanged) this.publish();
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
          ({ envelope }) => envelope.id === command.proposalId,
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
          ({ envelope }) => envelope.id === command.proposalId,
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
    const emptyResult = {
      created: [],
    };
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
    // Clip creation is deliberately chronological and sequential. The review
    // contract favors predictable encoder load while isolating each failure.
    await runSequentially(batch.items, async (item) => {
      item.error = null;
      try {
        if (!item.outcome) {
          if (item.decision) {
            const clip = await this.persistence.create(
              {
                id: item.envelope.id,
                videoId: item.envelope.videoId,
                idempotencyKey: item.envelope.idempotencyKey,
              },
              cloneInput(item.input),
            );
            item.outcome = { status: "created", clip };
            created.push(clip);
          } else {
            item.outcome = { status: "rejected" };
          }
        }

        try {
          await item.envelope.settle(item.outcome);
          item.settled = true;
        } catch (error) {
          if (item.outcome.status === "rejected") {
            // Rejection acknowledgement is deliberately one-shot. Retrying it
            // could duplicate a provider-side terminal response.
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
      session.completedProposalIds.add(item.envelope.id);
    }

    const result: FinishClipProposalReviewResult = {
      created,
    };

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

  private session(videoId: string): VideoReviewSession {
    const existing = this.sessions.get(videoId);
    if (existing) return existing;
    const session: VideoReviewSession = {
      videoId,
      activeBatch: null,
      queued: [],
      completedProposalIds: new Set(),
    };
    this.sessions.set(videoId, session);
    return session;
  }

  private activeBatch(): InternalReviewBatch | null {
    return this.sessions.get(this.activeVideoId)?.activeBatch ?? null;
  }

  private startNextBatch(session: VideoReviewSession): boolean {
    if (session.activeBatch || session.queued.length === 0) return false;
    const proposals = session.queued.splice(0).sort(
      (left, right) =>
        left.input.startSeconds - right.input.startSeconds ||
        left.input.endSeconds - right.input.endSeconds,
    );
    session.activeBatch = {
      items: proposals.map((envelope) => ({
        envelope,
        originalInput: cloneInput(envelope.input),
        input: cloneInput(envelope.input),
        decision: null,
        outcome: null,
        settled: false,
        error: null,
      })),
      isOpen: true,
      submitting: false,
      submitError: null,
      activeIndex: 0,
    };
    return true;
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ClipProposalReviewSnapshot {
    const session = this.sessions.get(this.activeVideoId);
    const batch = session?.activeBatch;
    if (!session || !batch) {
      return emptySnapshot(this.activeVideoId);
    }

    const items = batch.items.map<ClipProposalReviewItem>((item) => ({
      proposalId: item.envelope.id,
      originalInput: cloneInput(item.originalInput),
      input: cloneInput(item.input),
      decision: item.decision,
      error: item.error,
    }));
    const reviewedCount = items.filter(({ decision }) => decision !== null).length;
    const approvedCount = items.filter(({ decision }) => decision === true).length;
    return {
      videoId: session.videoId,
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
