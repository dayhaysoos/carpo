import { isYoutubeBlockedError } from "../errors";
import { YoutubeBlockedHint } from "./YoutubeBlockedHint";

interface ClipFailureMessageProps {
  message: string;
}

export function ClipFailureMessage({ message }: ClipFailureMessageProps) {
  return (
    <div className="clip-failure">
      <p className="job-error job-error-prominent">{message}</p>
      {isYoutubeBlockedError(message) && <YoutubeBlockedHint />}
    </div>
  );
}
