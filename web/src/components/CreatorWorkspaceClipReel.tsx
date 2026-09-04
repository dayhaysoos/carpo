import { clipDownloadUrl, preferredClipMp4 } from "../clip-media";
import * as stylex from "@stylexjs/stylex";
import type { OwnedUploadClipJourneyView } from "../owned-upload-clip-journey";
import { statusLabel, statusProgress } from "../status";
import { carpoIdentityTokens } from "../styles/carpoIdentityTokens.stylex";
import type { ClipResponse, ClipStatus } from "../types";
import { formatTimestamp } from "../youtube";
import { ClipFailureMessage } from "./ClipFailureMessage";

export interface CreatorWorkspaceClipItem {
  id: string;
  title: string;
  status: ClipStatus;
  clip: ClipResponse | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}

export function getCreatorWorkspaceClipItems(
  clips: readonly ClipResponse[],
  journey: OwnedUploadClipJourneyView,
  sourceThumbnailUrl: string | null,
): CreatorWorkspaceClipItem[] {
  const sorted = [...clips].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  const items: CreatorWorkspaceClipItem[] = sorted.map((clip) => ({
    id: clip.id,
    title: clip.title,
    status: clip.status,
    clip,
    thumbnailUrl: clip.outputs.thumbnail ?? sourceThumbnailUrl,
    durationSeconds: Math.max(0, clip.trimEnd - clip.trimStart),
  }));

  if (
    journey.createdClip &&
    !items.some((item) => item.id === journey.createdClip?.id)
  ) {
    items.unshift({
      id: journey.createdClip.id,
      title: journey.createdClip.title,
      status: journey.createdClip.status,
      clip: null,
      thumbnailUrl: sourceThumbnailUrl,
      durationSeconds: null,
    });
  }

  return items;
}

interface CreatorWorkspaceClipReelProps {
  items: readonly CreatorWorkspaceClipItem[];
  selectedClipId: string | null;
  onSelect: (clipId: string, trigger: HTMLButtonElement) => void;
}

export function CreatorWorkspaceClipReel({
  items,
  selectedClipId,
  onSelect,
}: CreatorWorkspaceClipReelProps) {
  return (
    <aside aria-label="Clips from this video" {...stylex.props(styles.reel)}>
      <div {...stylex.props(styles.reelHeading)}>
        <h2 {...stylex.props(styles.reelTitle)}>Clips</h2>
        <span {...stylex.props(styles.reelCount)}>
          {items.length} {items.length === 1 ? "clip" : "clips"}
        </span>
      </div>

      {items.length === 0 ? (
        <p {...stylex.props(styles.empty)}>Created clips will appear here.</p>
      ) : (
        <ol aria-live="polite" {...stylex.props(styles.list)}>
          {items.map((item) => {
            const selected = selectedClipId === item.id;
            const label = statusLabel(item.status);
            return (
              <li key={item.id} {...stylex.props(styles.listItem)}>
                <button
                  type="button"
                  aria-label={`Preview ${item.title}, ${label}`}
                  aria-pressed={selected}
                  onClick={(event) => onSelect(item.id, event.currentTarget)}
                  {...stylex.props(styles.row)}
                >
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt=""
                      {...stylex.props(styles.thumbnail)}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      {...stylex.props(
                        styles.thumbnail,
                        styles.thumbnailFallback,
                      )}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        {...stylex.props(styles.filmIcon)}
                      >
                        <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
                        <path d="M7 5v14M17 5v14M3.5 9h3.5M17 9h3.5M3.5 15h3.5M17 15h3.5" />
                      </svg>
                    </span>
                  )}
                  <span {...stylex.props(styles.rowMain)}>
                    <strong
                      title={item.title}
                      {...stylex.props(styles.rowTitle)}
                    >
                      {item.title}
                    </strong>
                    <span {...stylex.props(styles.rowMeta)}>
                      {item.durationSeconds === null
                        ? "Pending"
                        : formatTimestamp(item.durationSeconds)}
                    </span>
                  </span>
                  <span
                    {...stylex.props(
                      styles.status,
                      item.status === "complete"
                        ? styles.statusReady
                        : item.status === "failed"
                          ? styles.statusFailed
                          : styles.statusWorking,
                    )}
                  >
                    <span
                      aria-hidden="true"
                      {...stylex.props(styles.statusDot)}
                    />
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

export function CreatorWorkspaceClipPreview({
  item,
  onClose,
}: {
  item: CreatorWorkspaceClipItem;
  onClose: () => void;
}) {
  const label = statusLabel(item.status);
  const duration =
    item.durationSeconds === null
      ? null
      : formatTimestamp(item.durationSeconds);

  return (
    <section
      role="region"
      aria-label={`Preview ${item.title}`}
      aria-live="polite"
      {...stylex.props(styles.preview)}
    >
      <header {...stylex.props(styles.previewHeader)}>
        <strong title={item.title} {...stylex.props(styles.previewTitle)}>
          {item.title}
        </strong>
        <button
          type="button"
          aria-label="Close clip preview"
          autoFocus
          onClick={onClose}
          {...stylex.props(styles.closeButton)}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            {...stylex.props(styles.closeIcon)}
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>

      <div {...stylex.props(styles.previewMedia)}>
        {item.clip?.status === "complete" && item.clip.outputs.mp4 ? (
          <video
            src={preferredClipMp4(item.clip.outputs) ?? undefined}
            poster={item.thumbnailUrl ?? undefined}
            aria-label={`${item.title} video`}
            controls
            autoPlay
            loop
            playsInline
            {...stylex.props(styles.previewVideo)}
          />
        ) : item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            {...stylex.props(styles.previewImage)}
          />
        ) : (
          <span aria-hidden="true" {...stylex.props(styles.previewFallback)} />
        )}
        {item.status !== "complete" && (
          <div {...stylex.props(styles.previewState)}>
            <span
              {...stylex.props(
                styles.status,
                item.status === "failed"
                  ? styles.statusFailed
                  : styles.statusWorking,
              )}
            >
              <span aria-hidden="true" {...stylex.props(styles.statusDot)} />
              {label}
            </span>
            {item.status !== "failed" && (
              <span
                role="progressbar"
                aria-label={`${label} progress`}
                aria-valuenow={statusProgress(item.status)}
                aria-valuemin={0}
                aria-valuemax={100}
                {...stylex.props(styles.progressTrack)}
              >
                <span
                  aria-hidden="true"
                  style={{ width: `${statusProgress(item.status)}%` }}
                  {...stylex.props(styles.progressFill)}
                />
              </span>
            )}
          </div>
        )}
      </div>

      {item.status === "failed" && item.clip?.errorMessage ? (
        <div {...stylex.props(styles.failure)}>
          <ClipFailureMessage
            message={item.clip.errorMessage}
            failure={item.clip.sourceFailure}
          />
        </div>
      ) : null}

      <footer {...stylex.props(styles.previewFooter)}>
        <span {...stylex.props(styles.previewMeta)}>
          {item.clip
            ? `${formatTimestamp(item.clip.trimStart)}–${formatTimestamp(item.clip.trimEnd)}`
            : "New clip"}
          {duration ? ` · ${duration}` : ""}
        </span>
        {item.clip?.status === "complete" && item.clip.outputs.mp4 ? (
          <a
            href={clipDownloadUrl(preferredClipMp4(item.clip.outputs)!)}
            {...stylex.props(styles.download)}
          >
            Download
          </a>
        ) : null}
      </footer>
    </section>
  );
}

const styles = stylex.create({
  reel: {
    gridArea: "reel",
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    paddingBlock: "22px 36px",
    paddingInline: "14px",
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderLeftColor: carpoIdentityTokens.lineMuted,
    backgroundColor: carpoIdentityTokens.navy,
    color: carpoIdentityTokens.ink,
    scrollbarColor: "#5c6982 transparent",
    "@media (max-width: 900px)": {
      overflowY: "visible",
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: carpoIdentityTokens.lineMuted,
      borderLeftWidth: 0,
    },
  },
  reelHeading: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "10px",
    paddingBlockEnd: "14px",
    paddingInline: "7px",
  },
  reelTitle: {
    position: "relative",
    margin: 0,
    fontFamily: carpoIdentityTokens.fontDisplay,
    fontSize: "23px",
    fontWeight: 700,
    lineHeight: 1.05,
    letterSpacing: "0.035em",
    textTransform: "uppercase",
    "::after": {
      content: '""',
      width: "36px",
      height: "4px",
      display: "block",
      marginTop: "7px",
      backgroundColor: carpoIdentityTokens.vermilion,
      transform: "skewX(-24deg)",
      transformOrigin: "left",
    },
  },
  reelCount: {
    color: carpoIdentityTokens.inkFaint,
    fontFamily: carpoIdentityTokens.fontTime,
    fontSize: "12px",
    whiteSpace: "nowrap",
  },
  empty: {
    margin: 0,
    paddingBlock: "20px",
    paddingInline: "7px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: carpoIdentityTokens.lineMuted,
    color: carpoIdentityTokens.inkFaint,
    fontSize: "13px",
    lineHeight: 1.5,
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: carpoIdentityTokens.lineMuted,
  },
  listItem: { margin: 0, padding: 0 },
  row: {
    width: "100%",
    minHeight: "56px",
    display: "grid",
    gridTemplateColumns: "42px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "8px",
    padding: "7px",
    borderWidth: 0,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: carpoIdentityTokens.lineMuted,
    backgroundColor: {
      default: "transparent",
      ":hover": "#20232b",
      "[aria-pressed='true']": carpoIdentityTokens.vermilionSurface,
    },
    boxShadow: {
      default: "none",
      "[aria-pressed='true']": `inset 0 2px 0 ${carpoIdentityTokens.vermilion}`,
    },
    color: carpoIdentityTokens.ink,
    cursor: "pointer",
    textAlign: "left",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: carpoIdentityTokens.focus,
      outlineOffset: "-2px",
    },
  },
  thumbnail: {
    width: "42px",
    height: "24px",
    display: "block",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#555b68",
    backgroundColor: "#090a0c",
    objectFit: "cover",
  },
  thumbnailFallback: {
    display: "grid",
    placeItems: "center",
    color: carpoIdentityTokens.inkFaint,
  },
  filmIcon: {
    width: "18px",
    height: "18px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  rowMain: { minWidth: 0 },
  rowTitle: {
    display: "block",
    overflow: "hidden",
    color: carpoIdentityTokens.ink,
    fontSize: "14px",
    fontWeight: 600,
    lineHeight: 1.35,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowMeta: {
    display: "block",
    marginTop: "3px",
    color: carpoIdentityTokens.inkFaint,
    fontFamily: carpoIdentityTokens.fontTime,
    fontSize: "11px",
    lineHeight: 1.35,
    whiteSpace: "nowrap",
  },
  status: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    fontSize: "12px",
    fontWeight: 600,
    lineHeight: 1.35,
    whiteSpace: "nowrap",
  },
  statusDot: {
    width: "6px",
    height: "6px",
    flexShrink: 0,
    borderRadius: 0,
    backgroundColor: "currentColor",
    transform: "rotate(45deg)",
  },
  statusReady: { color: carpoIdentityTokens.green },
  statusWorking: { color: carpoIdentityTokens.yellow },
  statusFailed: { color: carpoIdentityTokens.red },
  preview: {
    position: "absolute",
    zIndex: 12,
    top: "18px",
    left: "18px",
    right: "18px",
    display: "grid",
    gap: "12px",
    padding: "14px",
    borderWidth: "1px",
    borderTopWidth: "3px",
    borderStyle: "solid",
    borderColor: carpoIdentityTokens.lineStrong,
    borderTopColor: carpoIdentityTokens.vermilion,
    backgroundColor: "#121419",
    boxShadow: carpoIdentityTokens.offsetShadow,
    "@media (max-width: 560px)": {
      top: "10px",
      left: "10px",
      right: "10px",
    },
  },
  previewHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  previewTitle: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  closeButton: {
    width: "44px",
    height: "44px",
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: carpoIdentityTokens.lineInteractive,
    borderRadius: "2px",
    backgroundColor: carpoIdentityTokens.controlSurface,
    color: carpoIdentityTokens.inkDim,
    cursor: "pointer",
    ":hover": {
      borderColor: "#7d8494",
      backgroundColor: carpoIdentityTokens.controlHover,
      color: carpoIdentityTokens.ink,
    },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: carpoIdentityTokens.focus,
      outlineOffset: "2px",
    },
  },
  closeIcon: {
    width: "20px",
    height: "20px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
  },
  previewMedia: {
    position: "relative",
    width: "100%",
    aspectRatio: "16 / 9",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#454a57",
    backgroundColor: carpoIdentityTokens.mediaSurface,
    clipPath:
      "polygon(0 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%)",
  },
  previewVideo: {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
    backgroundColor: carpoIdentityTokens.mediaSurface,
  },
  previewImage: {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "cover",
    opacity: 0.72,
  },
  previewFallback: {
    width: "100%",
    height: "100%",
    display: "block",
    backgroundImage:
      "linear-gradient(135deg, #0c0e13 25%, #171a22 25%, #171a22 50%, #0c0e13 50%, #0c0e13 75%, #171a22 75%)",
    backgroundSize: "24px 24px",
  },
  previewState: {
    position: "absolute",
    inset: 0,
    display: "grid",
    alignContent: "center",
    justifyItems: "center",
    gap: "12px",
    padding: "24px",
    backgroundColor: "rgba(6, 7, 10, 0.74)",
  },
  progressTrack: {
    width: "min(220px, 72%)",
    height: "4px",
    overflow: "hidden",
    backgroundColor: carpoIdentityTokens.trackSurface,
  },
  progressFill: {
    height: "100%",
    display: "block",
    backgroundColor: carpoIdentityTokens.vermilion,
  },
  failure: {
    color: carpoIdentityTokens.red,
    fontSize: "13px",
  },
  previewFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  previewMeta: {
    color: carpoIdentityTokens.inkDim,
    fontFamily: carpoIdentityTokens.fontTime,
    fontSize: "13px",
  },
  download: {
    minHeight: "44px",
    display: "inline-flex",
    alignItems: "center",
    paddingInline: "12px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: carpoIdentityTokens.lineInteractive,
    borderRadius: "2px",
    backgroundColor: carpoIdentityTokens.controlSurface,
    color: carpoIdentityTokens.ink,
    fontSize: "13px",
    fontWeight: 600,
    textDecoration: "none",
    ":hover": {
      borderColor: "#7d8494",
      backgroundColor: carpoIdentityTokens.controlHover,
    },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: carpoIdentityTokens.focus,
      outlineOffset: "2px",
    },
  },
});
