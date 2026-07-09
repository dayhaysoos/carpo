import { Link } from "react-router-dom";

export function YoutubeBlockedHint() {
  return (
    <p className="job-error-hint">
      <Link to="/?source=upload" className="inline-link">
        Switch to Upload file
      </Link>{" "}
      and upload the video directly instead.
    </p>
  );
}
