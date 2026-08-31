import * as stylex from "@stylexjs/stylex";
import { creatorWorkspaceTokens } from "../styles/creatorWorkspaceTokens.stylex";

export interface CreatorWorkspaceSourceSummary {
  title: string;
  sourceType: "youtube" | "upload";
  durationSeconds: number | null;
  thumbnailUrl: string | null;
}

interface CreatorWorkspaceSourceRibbonProps {
  source: CreatorWorkspaceSourceSummary;
  onChooseAnother: () => void;
}

function formatDuration(totalSeconds: number): string {
  const duration = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function sourceMetadata(source: CreatorWorkspaceSourceSummary): string {
  const sourceLabel =
    source.sourceType === "youtube" ? "YouTube source" : "Uploaded source";
  const duration =
    source.durationSeconds === null
      ? null
      : formatDuration(source.durationSeconds);

  return [sourceLabel, duration, "private workspace"]
    .filter(Boolean)
    .join(" · ");
}

export function CreatorWorkspaceSourceRibbon({
  source,
  onChooseAnother,
}: CreatorWorkspaceSourceRibbonProps) {
  return (
    <section
      aria-label="Active source"
      {...stylex.props(styles.ribbon)}
    >
      <span
        aria-hidden="true"
        {...stylex.props(styles.perforations, styles.perforationsLeft)}
      />
      <div {...stylex.props(styles.identity)}>
        {source.thumbnailUrl ? (
          <img
            src={source.thumbnailUrl}
            alt={`Thumbnail for ${source.title}`}
            {...stylex.props(styles.thumbnail)}
          />
        ) : (
          <span
            aria-hidden="true"
            {...stylex.props(styles.thumbnail, styles.thumbnailFallback)}
          >
            <svg viewBox="0 0 24 24" {...stylex.props(styles.placeholderIcon)}>
              <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
              <path d="M7 5v14M17 5v14M3.5 9h3.5M17 9h3.5M3.5 15h3.5M17 15h3.5" />
            </svg>
          </span>
        )}
        <div {...stylex.props(styles.copy)}>
          <strong title={source.title} {...stylex.props(styles.title)}>
            {source.title}
          </strong>
          <span {...stylex.props(styles.metadata)}>{sourceMetadata(source)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onChooseAnother}
        {...stylex.props(styles.chooseAnother)}
      >
        <span>Choose another video</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          {...stylex.props(styles.chevron)}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
      <span
        aria-hidden="true"
        {...stylex.props(styles.perforations, styles.perforationsRight)}
      />
    </section>
  );
}

const styles = stylex.create({
  ribbon: {
    gridColumn: "1 / -1",
    width: "100%",
    minHeight: "76px",
    position: "relative",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "18px",
    paddingBlock: "12px",
    paddingInline: "46px",
    overflow: "hidden",
    borderWidth: 0,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: creatorWorkspaceTokens.sourceLine,
    backgroundColor: creatorWorkspaceTokens.sourceSurface,
    color: creatorWorkspaceTokens.ink,
    fontFamily: creatorWorkspaceTokens.fontUi,
    textAlign: "left",
    "@media (max-width: 900px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
      gap: "10px",
      paddingInline: "40px",
    },
    "@media (max-width: 560px)": {
      paddingInline: "34px",
    },
  },
  perforations: {
    width: "18px",
    position: "absolute",
    top: 0,
    bottom: 0,
    opacity: 0.8,
    pointerEvents: "none",
    backgroundImage:
      "radial-gradient(circle, #12130f 0 3px, transparent 3.5px)",
    backgroundPosition: "center 4px",
    backgroundSize: "12px 16px",
  },
  perforationsLeft: {
    left: "10px",
  },
  perforationsRight: {
    right: "10px",
  },
  identity: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
  thumbnail: {
    width: "86px",
    aspectRatio: "16 / 9",
    flexShrink: 0,
    display: "block",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#656554",
    backgroundColor: creatorWorkspaceTokens.bench,
    objectFit: "cover",
    "@media (max-width: 560px)": {
      width: "66px",
    },
  },
  thumbnailFallback: {
    display: "grid",
    placeItems: "center",
    color: creatorWorkspaceTokens.inkFaint,
  },
  placeholderIcon: {
    width: "24px",
    height: "24px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  copy: {
    minWidth: 0,
  },
  title: {
    display: "block",
    overflow: "hidden",
    color: creatorWorkspaceTokens.ink,
    fontSize: "15px",
    fontWeight: 600,
    lineHeight: 1.3,
    letterSpacing: "0.01em",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "@media (max-width: 560px)": {
      fontSize: "13px",
    },
  },
  metadata: {
    display: "block",
    marginTop: "3px",
    overflow: "hidden",
    color: creatorWorkspaceTokens.inkDim,
    fontSize: "13px",
    lineHeight: 1.35,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chooseAnother: {
    minHeight: "42px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    justifySelf: "end",
    gap: "8px",
    paddingBlock: "8px",
    paddingInline: "14px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#838477",
    borderRadius: "8px",
    backgroundColor: "#272820",
    color: creatorWorkspaceTokens.ink,
    cursor: "pointer",
    fontWeight: 600,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    transitionDuration: "150ms",
    transitionProperty: "background-color, border-color",
    transitionTimingFunction: "ease-out",
    ":hover": {
      borderColor: creatorWorkspaceTokens.inkDim,
      backgroundColor: creatorWorkspaceTokens.benchHigh,
    },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: creatorWorkspaceTokens.focus,
      outlineOffset: "3px",
    },
    "@media (max-width: 900px)": {
      justifySelf: "end",
    },
    "@media (prefers-reduced-motion: reduce)": {
      transitionDuration: "0s",
    },
  },
  chevron: {
    width: "18px",
    height: "18px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
});
