import { useMutation } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import {
  prepareVisualMomentReview,
  searchVisualMoments,
} from "../api";
import type { VisualMomentResult, VisualSearchResponse } from "../types";
import { formatTimestamp } from "../youtube";

function resultRequest(result: VisualMomentResult) {
  return {
    resultId: result.resultId,
    query: result.query,
    videoId: result.videoId,
    sourceRevision: result.sourceRevision,
    observationIds: result.evidence.map(({ observationId }) => observationId),
    startSeconds: result.proposedRange.startSeconds,
    endSeconds: result.proposedRange.endSeconds,
  };
}

export function VisualMomentSearchPanel({
  videoId,
  onPrepared,
}: {
  videoId: string;
  onPrepared: (proposalId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<VisualSearchResponse | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const search = useMutation({
    mutationFn: (target: string) => searchVisualMoments(videoId, target),
    onSuccess: setResponse,
  });
  const prepare = useMutation({
    mutationFn: async (result: VisualMomentResult) => {
      setOpeningId(result.resultId);
      return prepareVisualMomentReview(resultRequest(result));
    },
    onSuccess: (prepared) => onPrepared(prepared.proposalId),
    onSettled: () => setOpeningId(null),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = query.trim();
    if (target) search.mutate(target);
  };

  return (
    <section className="panel visual-search" aria-labelledby="visual-search-title">
      <div className="visual-search-heading">
        <div>
          <span className="eyebrow">Visual tracer</span>
          <h2 id="visual-search-title">Find a visible moment</h2>
        </div>
        <span className="visual-search-scope">Uploads · sampled frames</span>
      </div>
      <p className="visual-search-intro">
        Describe a logo, object, or layout. Carpo checks a bounded set of private
        frames and proposes editable timestamps—it never creates a clip for you.
      </p>
      <form className="visual-search-form" onSubmit={submit}>
        <label htmlFor="visual-target">What should Carpo look for?</label>
        <div>
          <input
            id="visual-target"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Every time the blue Carpo logo appears"
          />
          <button className="btn-primary" type="submit" disabled={!query.trim() || search.isPending}>
            {search.isPending ? "Checking frames…" : "Find moments"}
          </button>
        </div>
      </form>
      {search.error && <p className="form-error" role="alert">{search.error.message}</p>}
      {prepare.error && <p className="form-error" role="alert">{prepare.error.message}</p>}
      {response && (
        <div className="visual-search-results" aria-live="polite">
          <p className="visual-search-coverage">{response.coverageMessage}</p>
          {response.results.length === 0 ? (
            <p className="visual-search-empty">No matching sampled frames were found.</p>
          ) : (
            response.results.map((result) => (
              <article className="visual-search-result" key={result.resultId}>
                <div className="visual-search-frames">
                  {result.evidence.map((evidence) => (
                    <figure key={evidence.observationId}>
                      <img
                        src={evidence.frameUrl}
                        alt={`Sampled video frame at ${formatTimestamp(evidence.timestampSeconds)}`}
                      />
                      <figcaption>
                        {formatTimestamp(evidence.timestampSeconds)} · {evidence.confidence}
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <div className="visual-search-result-copy">
                  <strong>
                    Proposed {formatTimestamp(result.proposedRange.startSeconds)}–
                    {formatTimestamp(result.proposedRange.endSeconds)}
                  </strong>
                  <p>{result.evidence[0]?.rationale}</p>
                  <p className="visual-search-uncertainty">
                    Uncertainty: {result.evidence[0]?.uncertainty}
                  </p>
                  <button
                    className="btn-primary"
                    type="button"
                    disabled={prepare.isPending}
                    onClick={() => prepare.mutate(result)}
                  >
                    {openingId === result.resultId ? "Opening…" : "Review timestamps"}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      )}
    </section>
  );
}
