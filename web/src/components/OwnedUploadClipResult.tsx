import { clipDownloadUrl, preferredClipMp4 } from "../clip-media";
import { Link } from "react-router-dom";
import type { OwnedUploadClipJourneyView } from "../owned-upload-clip-journey";
import { statusLabel, statusProgress } from "../status";
import { ClipFailureMessage } from "./ClipFailureMessage";

export function OwnedUploadClipResult({
  journey,
}: {
  journey: OwnedUploadClipJourneyView;
}) {
  if (!journey.createdClip || !journey.sourceVideoId) return null;

  const { createdClip, clip } = journey;
  const progress = statusProgress(createdClip.status);
  const libraryPath = `/library/videos/${encodeURIComponent(journey.sourceVideoId)}`;

  return (
    <section className="owned-clip-result" aria-labelledby="owned-clip-title">
      <div className="owned-clip-result-header">
        <div>
          <h3 id="owned-clip-title">{createdClip.title}</h3>
          <p aria-live="polite">
            {journey.phase === "complete"
              ? "Your clip is ready."
              : journey.phase === "failed"
                ? "This clip could not be finished."
                : "Your clip is being prepared."}
          </p>
        </div>
        <span className={`status-badge status-${createdClip.status}`}>
          {statusLabel(createdClip.status)}
        </span>
      </div>

      {journey.phase === "rendering" && (
        <div className="owned-clip-progress" role="status">
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span>Keep this page open or return from your private Library.</span>
        </div>
      )}

      {journey.phase === "failed" && clip?.errorMessage && (
        <>
          <ClipFailureMessage
            message={clip.errorMessage}
            failure={clip.sourceFailure}
          />
          <p className="owned-clip-recovery">
            Adjust the title or trim above, then create the clip again.
          </p>
        </>
      )}

      {journey.phase === "complete" && clip?.outputs.mp4 && (
        <video
          className="owned-clip-preview"
          src={preferredClipMp4(clip.outputs) ?? undefined}
          poster={clip.outputs.thumbnail ?? undefined}
          aria-label={`${clip.title} video`}
          controls
          playsInline
        />
      )}

      <div className="owned-clip-actions">
        {journey.phase === "complete" && clip?.outputs.mp4 && (
          <a href={clipDownloadUrl(preferredClipMp4(clip.outputs)!)} className="btn-secondary">
            Download MP4
          </a>
        )}
        <Link to={libraryPath} className="inline-link">
          Open in Library
        </Link>
      </div>
    </section>
  );
}
