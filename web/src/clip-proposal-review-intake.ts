import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  getPreparedLibraryMomentReview,
  getPreparedVisualMomentReview,
} from "./api";
import type {
  ClipProposalAdmissionIssue,
  ClipProposalReview,
  ClipProposalVideoContext,
  PreparedClipProposalHandoff,
} from "./clip-proposal-review";

export type ClipProposalReviewIntakeAdapter = "library" | "visual";

export interface ClipProposalReviewIntakeIssue {
  adapter: ClipProposalReviewIntakeAdapter;
  proposalId: string;
  phase: "load" | "admission";
  code: string;
  message: string;
  path?: string;
  retryable: boolean;
}

export interface ClipProposalReviewIntakeView {
  issues: readonly ClipProposalReviewIntakeIssue[];
}

export interface ClipProposalReviewIntake {
  view: ClipProposalReviewIntakeView;
  presentVisual(proposalId: string): void;
}

export interface ClipProposalReviewIntakeLoader {
  loadLibrary(
    proposalId: string,
    signal: AbortSignal,
  ): Promise<PreparedClipProposalHandoff>;
  loadVisual(
    proposalId: string,
    signal: AbortSignal,
  ): Promise<PreparedClipProposalHandoff>;
}

interface UseClipProposalReviewIntakeOptions {
  activeVideo: ClipProposalVideoContext | null;
  review: ClipProposalReview;
}

interface StoredAdmissionIssue extends ClipProposalReviewIntakeIssue {
  token: string;
}

const productionLoader: ClipProposalReviewIntakeLoader = {
  async loadLibrary(proposalId, signal) {
    const prepared = await getPreparedLibraryMomentReview(proposalId, signal);
    if (prepared.proposalId !== proposalId) {
      throw new Error("The loaded Library proposal identity does not match the route.");
    }
    return {
      adapter: "library",
      requestId: prepared.proposalId,
      videoId: prepared.videoId,
      proposalId: prepared.searchResultId,
      input: { ...prepared.input },
      evidence: { ...prepared.evidence },
    };
  },
  async loadVisual(proposalId, signal) {
    const prepared = await getPreparedVisualMomentReview(proposalId, signal);
    if (prepared.proposalId !== proposalId) {
      throw new Error("The loaded Visual proposal identity does not match the route.");
    }
    return {
      adapter: "visual",
      requestId: prepared.proposalId,
      videoId: prepared.videoId,
      proposalId: prepared.searchResultId,
      input: { ...prepared.input },
      evidence: { ...prepared.evidence },
    };
  },
};

function routeSignature(libraryProposalId: string, visualProposalId: string) {
  return `${encodeURIComponent(libraryProposalId)}:${encodeURIComponent(visualProposalId)}`;
}

function intakeToken(
  activeVideoId: string,
  adapter: ClipProposalReviewIntakeAdapter,
  proposalId: string,
) {
  return `${encodeURIComponent(activeVideoId)}:${adapter}:${encodeURIComponent(proposalId)}`;
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The prepared Clip Proposal could not be loaded.";
}

function admissionIssueIsRetryable(issue: ClipProposalAdmissionIssue): boolean {
  return issue.code === "QUEUE_FULL";
}

function admissionIssues(
  adapter: ClipProposalReviewIntakeAdapter,
  routeProposalId: string,
  token: string,
  issues: readonly ClipProposalAdmissionIssue[],
): StoredAdmissionIssue[] {
  return issues.map((issue) => ({
    adapter,
    proposalId: routeProposalId,
    phase: "admission",
    code: issue.code,
    message: issue.message,
    path: issue.path,
    retryable: admissionIssueIsRetryable(issue),
    token,
  }));
}

function sameIssues(
  left: readonly StoredAdmissionIssue[],
  right: readonly StoredAdmissionIssue[],
) {
  return (
    left.length === right.length &&
    left.every((issue, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        issue.token === candidate.token &&
        issue.code === candidate.code &&
        issue.message === candidate.message &&
        issue.path === candidate.path
      );
    })
  );
}

export function createUseClipProposalReviewIntake(
  loader: ClipProposalReviewIntakeLoader,
) {
  return function useConfiguredClipProposalReviewIntake({
    activeVideo,
    review,
  }: UseClipProposalReviewIntakeOptions): ClipProposalReviewIntake {
    const [searchParams, setSearchParams] = useSearchParams();
    const routeVideoId = searchParams.get("video") ?? null;
    const libraryProposalId = searchParams.get("libraryProposal") ?? "";
    const visualProposalId = searchParams.get("visualProposal") ?? "";
    const activeVideoId = activeVideo?.id ?? null;
    const signature = routeSignature(libraryProposalId, visualProposalId);
    const renderedSearch = searchParams.toString();
    const observedSearch = useRef(renderedSearch);
    const latestSearchParams = useRef(new URLSearchParams(searchParams));
    if (observedSearch.current !== renderedSearch) {
      observedSearch.current = renderedSearch;
      latestSearchParams.current = new URLSearchParams(searchParams);
    }
    const previousActiveVideoId = useRef<string | null>(null);
    const previousHandoffs = useRef({
      libraryProposalId,
      visualProposalId,
    });
    const abandonedSignature = useRef<string | null>(null);
    const attemptedTokens = useRef(new Set<string>());
    const [storedAdmissionIssues, setStoredAdmissionIssues] = useState<
      readonly StoredAdmissionIssue[]
    >([]);

    const updateRoute = useCallback(
      (
        mutate: (next: URLSearchParams) => void,
        options?: { replace?: boolean },
      ) => {
        const next = new URLSearchParams(latestSearchParams.current);
        mutate(next);
        if (next.toString() === latestSearchParams.current.toString()) return;
        latestSearchParams.current = next;
        setSearchParams(next, options);
      },
      [setSearchParams],
    );

    const library = useQuery({
      queryKey: ["library-moment-proposal", libraryProposalId],
      queryFn: ({ signal }) => loader.loadLibrary(libraryProposalId, signal),
      enabled: Boolean(libraryProposalId),
      retry: false,
    });
    const visual = useQuery({
      queryKey: ["visual-moment-proposal", visualProposalId],
      queryFn: ({ signal }) => loader.loadVisual(visualProposalId, signal),
      enabled: Boolean(visualProposalId),
      retry: false,
    });

    const transitionedAway =
      previousActiveVideoId.current !== null &&
      previousActiveVideoId.current !== activeVideoId;
    const transitionAbandonsCurrentHandoff =
      transitionedAway &&
      ((Boolean(previousHandoffs.current.libraryProposalId) &&
        previousHandoffs.current.libraryProposalId === libraryProposalId) ||
        (Boolean(previousHandoffs.current.visualProposalId) &&
          previousHandoffs.current.visualProposalId === visualProposalId));
    const routeWasAbandoned =
      transitionAbandonsCurrentHandoff ||
      abandonedSignature.current === signature;

    useEffect(() => {
      const previousId = previousActiveVideoId.current;
      const previousRouteHandoffs = previousHandoffs.current;
      previousActiveVideoId.current = activeVideoId;
      if (previousId === null) {
        previousHandoffs.current = { libraryProposalId, visualProposalId };
        return;
      }
      if (previousId === activeVideoId) {
        if (routeVideoId === null || routeVideoId === activeVideoId) {
          previousHandoffs.current = { libraryProposalId, visualProposalId };
        }
        return;
      }
      previousHandoffs.current = { libraryProposalId, visualProposalId };

      attemptedTokens.current.clear();
      setStoredAdmissionIssues([]);
      const abandonLibrary =
        Boolean(previousRouteHandoffs.libraryProposalId) &&
        previousRouteHandoffs.libraryProposalId === libraryProposalId;
      const abandonVisual =
        Boolean(previousRouteHandoffs.visualProposalId) &&
        previousRouteHandoffs.visualProposalId === visualProposalId;
      if (!abandonLibrary && !abandonVisual) return;

      abandonedSignature.current = signature;
      updateRoute(
        (next) => {
          if (
            abandonLibrary &&
            next.get("libraryProposal") ===
              previousRouteHandoffs.libraryProposalId
          ) {
            next.delete("libraryProposal");
          }
          if (
            abandonVisual &&
            next.get("visualProposal") ===
              previousRouteHandoffs.visualProposalId
          ) {
            next.delete("visualProposal");
          }
        },
        { replace: true },
      );
    }, [
      activeVideoId,
      libraryProposalId,
      routeVideoId,
      signature,
      updateRoute,
      visualProposalId,
    ]);

    useEffect(() => {
      if (
        abandonedSignature.current !== null &&
        abandonedSignature.current !== signature
      ) {
        abandonedSignature.current = null;
      }
    }, [signature]);

    useEffect(() => {
      const currentTokens = new Set<string>();
      if (activeVideoId && libraryProposalId) {
        currentTokens.add(
          intakeToken(activeVideoId, "library", libraryProposalId),
        );
      }
      if (activeVideoId && visualProposalId) {
        currentTokens.add(
          intakeToken(activeVideoId, "visual", visualProposalId),
        );
      }
      for (const token of attemptedTokens.current) {
        if (!currentTokens.has(token)) attemptedTokens.current.delete(token);
      }
      setStoredAdmissionIssues((current) => {
        const next = current.filter((issue) => currentTokens.has(issue.token));
        return sameIssues(current, next) ? current : next;
      });
    }, [activeVideoId, libraryProposalId, visualProposalId]);

    useEffect(() => {
      if (!activeVideo || routeWasAbandoned) return;
      if (routeVideoId && routeVideoId !== activeVideo.id) return;
      if (libraryProposalId && library.isPending) return;

      const candidates: Array<{
        adapter: ClipProposalReviewIntakeAdapter;
        parameter: "libraryProposal" | "visualProposal";
        routeProposalId: string;
        handoff: PreparedClipProposalHandoff;
      }> = [];
      if (
        libraryProposalId &&
        library.data?.adapter === "library" &&
        library.data.requestId === libraryProposalId
      ) {
        candidates.push({
          adapter: "library",
          parameter: "libraryProposal",
          routeProposalId: libraryProposalId,
          handoff: library.data,
        });
      }
      if (
        visualProposalId &&
        visual.data?.adapter === "visual" &&
        visual.data.requestId === visualProposalId
      ) {
        candidates.push({
          adapter: "visual",
          parameter: "visualProposal",
          routeProposalId: visualProposalId,
          handoff: visual.data,
        });
      }
      if (candidates.length === 0) return;

      const attemptedNow = new Set<string>();
      const nextIssues: StoredAdmissionIssue[] = [];
      const consumed: Array<{
        parameter: "libraryProposal" | "visualProposal";
        routeProposalId: string;
      }> = [];
      for (const candidate of candidates) {
        const token = intakeToken(
          activeVideo.id,
          candidate.adapter,
          candidate.routeProposalId,
        );
        if (attemptedTokens.current.has(token)) continue;

        attemptedTokens.current.add(token);
        attemptedNow.add(token);
        const result = review.intakePrepared(activeVideo, candidate.handoff);
        if (result.consumable) {
          consumed.push(candidate);
        } else {
          nextIssues.push(
            ...admissionIssues(
              candidate.adapter,
              candidate.routeProposalId,
              token,
              result.issues,
            ),
          );
        }
      }

      if (attemptedNow.size > 0) {
        setStoredAdmissionIssues((current) => {
          const next = [
            ...current.filter((issue) => !attemptedNow.has(issue.token)),
            ...nextIssues,
          ];
          return sameIssues(current, next) ? current : next;
        });
      }
      if (consumed.length > 0) {
        updateRoute(
          (next) => {
            for (const candidate of consumed) {
              if (
                next.get(candidate.parameter) === candidate.routeProposalId
              ) {
                next.delete(candidate.parameter);
              }
            }
          },
          { replace: true },
        );
      }
    }, [
      activeVideo,
      library.data,
      library.isPending,
      libraryProposalId,
      review,
      routeVideoId,
      routeWasAbandoned,
      updateRoute,
      visual.data,
      visualProposalId,
    ]);

    const loadIssues = useMemo(() => {
      const issues: ClipProposalReviewIntakeIssue[] = [];
      if (libraryProposalId && library.error && !routeWasAbandoned) {
        issues.push({
          adapter: "library",
          proposalId: libraryProposalId,
          phase: "load",
          code: "LOAD_FAILED",
          message: message(library.error),
          retryable: true,
        });
      }
      if (visualProposalId && visual.error && !routeWasAbandoned) {
        issues.push({
          adapter: "visual",
          proposalId: visualProposalId,
          phase: "load",
          code: "LOAD_FAILED",
          message: message(visual.error),
          retryable: true,
        });
      }
      return issues;
    }, [
      library.error,
      libraryProposalId,
      routeWasAbandoned,
      visual.error,
      visualProposalId,
    ]);

    const issues = useMemo(() => {
      const currentTokens = new Set<string>();
      if (activeVideoId && libraryProposalId) {
        currentTokens.add(
          intakeToken(activeVideoId, "library", libraryProposalId),
        );
      }
      if (activeVideoId && visualProposalId) {
        currentTokens.add(
          intakeToken(activeVideoId, "visual", visualProposalId),
        );
      }
      return [
        ...loadIssues,
        ...storedAdmissionIssues
          .filter((issue) => currentTokens.has(issue.token))
          .map(({ token: _token, ...issue }) => issue),
      ].sort((left, right) => {
        const leftOrder = left.adapter === "library" ? 0 : 1;
        const rightOrder = right.adapter === "library" ? 0 : 1;
        return leftOrder - rightOrder;
      });
    }, [
      activeVideoId,
      libraryProposalId,
      loadIssues,
      storedAdmissionIssues,
      visualProposalId,
    ]);

    const presentVisual = useCallback(
      (proposalId: string) => {
        if (!proposalId) return;
        updateRoute((next) => {
          next.set("visualProposal", proposalId);
        });
      },
      [updateRoute],
    );

    return useMemo(
      () => ({ view: { issues }, presentVisual }),
      [issues, presentVisual],
    );
  };
}

export const useClipProposalReviewIntake =
  createUseClipProposalReviewIntake(productionLoader);
