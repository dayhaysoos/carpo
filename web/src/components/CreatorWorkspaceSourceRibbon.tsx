import * as stylex from "@stylexjs/stylex";
import { carpoIdentityTokens } from "../styles/carpoIdentityTokens.stylex";

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
    <section aria-label="Active source" {...stylex.props(styles.ribbon)}>
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
          <span {...stylex.props(styles.metadata)}>
            {sourceMetadata(source)}
          </span>
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
    </section>
  );
}

const styles = stylex.create({
  ribbon: {
    gridColumn: "1 / -1",
    width: "100%",
    minHeight: "82px",
    position: "relative",
    isolation: "isolate",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "18px",
    paddingBlock: "12px",
    paddingInline: "38px",
    overflow: "hidden",
    borderWidth: 0,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: "#6b2730",
    backgroundColor: carpoIdentityTokens.navy,
    color: carpoIdentityTokens.ink,
    fontFamily: carpoIdentityTokens.fontUi,
    textAlign: "left",
    "@media (max-width: 900px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
      gap: "10px",
      paddingInline: "20px",
    },
    "@media (max-width: 560px)": {
      paddingInline: "16px",
    },
  },
  perforations: {
    position: "absolute",
    pointerEvents: "none",
  },
  perforationsLeft: {
    zIndex: -1,
    insetBlock: 0,
    left: 0,
    right: "42%",
    backgroundImage:
      "radial-gradient(circle, rgba(239, 239, 239, 0.18) 0 1px, transparent 1.3px)",
    backgroundSize: "7px 7px",
    opacity: 0.3,
    maskImage: "linear-gradient(90deg, #000, transparent)",
  },
  identity: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "15px",
  },
  thumbnail: {
    width: "92px",
    aspectRatio: "16 / 9",
    flexShrink: 0,
    display: "block",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#666b78",
    backgroundColor: carpoIdentityTokens.carbon,
    boxShadow: "5px 5px 0 #08090c",
    clipPath: "polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%)",
    objectFit: "cover",
    "@media (max-width: 560px)": {
      width: "66px",
    },
  },
  thumbnailFallback: {
    display: "grid",
    placeItems: "center",
    color: carpoIdentityTokens.inkFaint,
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
    maxWidth: "min(58vw, 760px)",
    overflow: "hidden",
    color: carpoIdentityTokens.ink,
    fontFamily: carpoIdentityTokens.fontDisplay,
    fontSize: "clamp(17px, 1.6vw, 23px)",
    fontWeight: 700,
    lineHeight: 1.08,
    letterSpacing: "0.025em",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  metadata: {
    display: "block",
    marginTop: "5px",
    overflow: "hidden",
    color: carpoIdentityTokens.inkDim,
    fontFamily: carpoIdentityTokens.fontTime,
    fontSize: "11px",
    lineHeight: 1.35,
    letterSpacing: "0.035em",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chooseAnother: {
    minHeight: "44px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    justifySelf: "end",
    gap: "8px",
    paddingBlock: "8px",
    paddingInline: "14px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#858a96",
    borderRadius: "2px",
    backgroundColor: "#101116",
    boxShadow: "3px 3px 0 rgba(0, 0, 0, 0.45)",
    color: carpoIdentityTokens.ink,
    cursor: "pointer",
    fontFamily: carpoIdentityTokens.fontDisplay,
    fontSize: "15px",
    fontWeight: 600,
    letterSpacing: "0.025em",
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    transitionDuration: "150ms",
    transitionProperty: "background-color, border-color",
    transitionTimingFunction: "ease-out",
    ":hover": {
      borderColor: carpoIdentityTokens.vermilion,
      backgroundColor: "#1b1d24",
    },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: carpoIdentityTokens.focus,
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
