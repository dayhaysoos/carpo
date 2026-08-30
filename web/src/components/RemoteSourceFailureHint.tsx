import { Link } from "react-router-dom";
import type { RemoteSourceFailure } from "../types";

export function RemoteSourceFailureHint({
  failure,
}: {
  failure: RemoteSourceFailure;
}) {
  return (
    <p className="job-error-hint">
      <Link to={failure.recovery.href} className="inline-link">
        {failure.recovery.label}
      </Link>
      {failure.retryable ? " or retry the import later." : "."}
    </p>
  );
}
