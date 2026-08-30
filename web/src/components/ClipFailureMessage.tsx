import { isYoutubeBlockedError } from "../errors";
import type { RemoteSourceFailure } from "../types";
import { RemoteSourceFailureHint } from "./RemoteSourceFailureHint";
import { YoutubeBlockedHint } from "./YoutubeBlockedHint";

interface ClipFailureMessageProps {
  message: string;
  failure?: RemoteSourceFailure | null;
}

export function ClipFailureMessage({
  message,
  failure,
}: ClipFailureMessageProps) {
  return (
    <div className="clip-failure">
      <p className="job-error job-error-prominent">
        {failure?.message ?? message}
      </p>
      {failure ? (
        <RemoteSourceFailureHint failure={failure} />
      ) : (
        isYoutubeBlockedError(message) && <YoutubeBlockedHint />
      )}
    </div>
  );
}
