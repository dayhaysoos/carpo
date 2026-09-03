import { useQuery } from "@tanstack/react-query";
import {
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getVideoTranscript } from "../api";
import { type TranscriptBlock } from "../types";
import { formatTimestamp } from "../youtube";

interface TranscriptPanelProps {
  videoId: string;
  currentTime: number;
  editorReady: boolean;
  onSeek: (seconds: number) => void;
  onRangeSelect: (range: {
    startSeconds: number;
    endSeconds: number;
  }) => void;
}

export function TranscriptPanel({
  videoId,
  currentTime,
  editorReady,
  onSeek,
  onRangeSelect,
}: TranscriptPanelProps) {
  const [query, setQuery] = useState("");
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(
    new Set(),
  );
  const activeElement = useRef<HTMLButtonElement | null>(null);
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["video-transcript", videoId],
    queryFn: () => getVideoTranscript(videoId),
    enabled: Boolean(videoId),
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const result = query.state.data;
      return result?.transcriptStatus === "checking"
        ? result.retryAfterMs
        : false;
    },
  });
  const transcript = data && "blocks" in data ? data : undefined;
  const preparing =
    !error && (isLoading || data?.transcriptStatus === "checking");
  const blocks = transcript?.blocks ?? [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleBlocks = useMemo(
    () =>
      blocks
        .map((block, index) => ({ block, index }))
        .filter(({ block }) =>
          normalizedQuery
            ? block.text.toLocaleLowerCase().includes(normalizedQuery)
            : true,
        ),
    [blocks, normalizedQuery],
  );
  const activeIndex = blocks.findIndex(
    (block) =>
      currentTime >= block.startSeconds && currentTime < block.endSeconds,
  );
  const selectedBlocks = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => blocks[index])
    .filter((block): block is TranscriptBlock => Boolean(block));
  useEffect(() => {
    setQuery("");
    setAnchorIndex(null);
    setSelectedIndexes(new Set());
  }, [videoId]);

  useEffect(() => {
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeElement.current?.scrollIntoView?.({
      block: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [activeIndex]);

  const selectBlock = (
    event: MouseEvent<HTMLButtonElement>,
    index: number,
    block: TranscriptBlock,
  ) => {
    onSeek(block.startSeconds);
    if (event.shiftKey && anchorIndex !== null) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      setSelectedIndexes(
        new Set(
          Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
        ),
      );
      return;
    }
    setAnchorIndex(index);
    setSelectedIndexes(new Set([index]));
  };

  const useSelection = () => {
    const first = selectedBlocks[0];
    const last = selectedBlocks.at(-1);
    if (!first || !last) return;
    onRangeSelect({
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
    });
  };

  return (
    <section className="transcript-panel" aria-labelledby="transcript-title">
      <div className="transcript-header">
        <div>
          <h3 id="transcript-title">Transcript</h3>
          <p>
            {transcript
              ? `${transcript.automatic ? "Automatic" : "Creator"} transcript · ${transcript.language}`
              : "Search, seek, or select text for the clip editor."}
          </p>
        </div>
        {transcript && (
          <span
            className="transcript-ready"
            role="status"
            aria-label="Transcript ready"
          >
            Ready
          </span>
        )}
      </div>

      {preparing && (
        <div className="transcript-state" role="status">
          <strong>Preparing transcript…</strong>
          <span>
            Videos without captions may take a few minutes to transcribe.
          </span>
        </div>
      )}

      {error && (
        <div className="transcript-state transcript-error" role="alert">
          <strong>Transcript unavailable</strong>
          <span>
            We couldn’t prepare a transcript for this video. You can still create
            clips by setting the start and end times manually.
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void refetch()}
          >
            Try again
          </button>
        </div>
      )}

      {transcript && (
        <>
          <label className="transcript-search">
            <span className="sr-only">Search transcript</span>
            <input
              type="search"
              aria-label="Search transcript"
              placeholder="Search transcript"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p className="transcript-instructions">
            Click to seek. Shift-click another passage to select a range.
          </p>
          <div className="transcript-scroll" aria-label="Video transcript">
            {visibleBlocks.map(({ block, index }) => {
              const active = index === activeIndex;
              const selected = selectedIndexes.has(index);
              return (
                <button
                  key={block.id}
                  type="button"
                  ref={active ? activeElement : undefined}
                  className={`transcript-block${active ? " active" : ""}${selected ? " selected" : ""}`}
                  aria-current={active ? "true" : undefined}
                  aria-pressed={selected}
                  aria-label={`${formatTimestamp(block.startSeconds).replace(/\.000$/, "")} ${block.text}`}
                  disabled={!editorReady}
                  onClick={(event) => selectBlock(event, index, block)}
                >
                  <time>{formatTimestamp(block.startSeconds).replace(/\.000$/, "")}</time>
                  <span>{block.text}</span>
                </button>
              );
            })}
            {visibleBlocks.length === 0 && (
              <p className="transcript-empty" role="status">
                No transcript text matches.
              </p>
            )}
          </div>
          <div className="transcript-selection">
            <span aria-live="polite">
              {!editorReady
                ? "Waiting for the video player"
                : selectedBlocks.length === 0
                ? "No text selected"
                : `${selectedBlocks.length} passage${selectedBlocks.length === 1 ? "" : "s"} selected`}
            </span>
            <div>
              {selectedBlocks.length > 0 && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setSelectedIndexes(new Set());
                    setAnchorIndex(null);
                  }}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                onClick={useSelection}
                disabled={
                  !editorReady ||
                  selectedBlocks.length === 0
                }
              >
                Use selected text
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
