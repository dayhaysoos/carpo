import * as stylex from "@stylexjs/stylex";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { creatorWorkspaceTokens } from "../styles/creatorWorkspaceTokens.stylex";

interface CreatorWorkspaceAskCarpoProps {
  children: ReactNode;
}

export function CreatorWorkspaceAskCarpo({
  children,
}: CreatorWorkspaceAskCarpoProps) {
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;

    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-controls={drawerId}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        {...stylex.props(styles.trigger, open && styles.triggerHidden)}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          {...stylex.props(styles.triggerIcon)}
        >
          <path d="M5 5.75h14v9.5H9.75L6 18.5v-3.25H5z" />
        </svg>
        <span>Ask Carpo</span>
      </button>

      <aside
        id={drawerId}
        role="dialog"
        aria-label="Ask Carpo"
        aria-hidden={!open}
        inert={!open}
        data-state={open ? "open" : "closed"}
        {...stylex.props(
          styles.drawer,
          open ? styles.drawerOpen : styles.drawerClosed,
        )}
      >
        <button
          ref={closeRef}
          type="button"
          aria-label="Close Ask Carpo"
          onClick={close}
          {...stylex.props(styles.close)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" {...stylex.props(styles.closeIcon)}>
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
        <div {...stylex.props(styles.content)}>{children}</div>
      </aside>
    </>
  );
}

const styles = stylex.create({
  trigger: {
    position: "fixed",
    right: "18px",
    bottom: "18px",
    zIndex: 40,
    minHeight: "44px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "9px",
    paddingBlock: "9px",
    paddingInline: "14px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#62635a",
    borderRadius: "7px",
    backgroundColor: "#252620",
    boxShadow: "0 12px 30px rgba(0, 0, 0, 0.34)",
    color: creatorWorkspaceTokens.inkDim,
    cursor: "pointer",
    fontFamily: creatorWorkspaceTokens.fontUi,
    fontSize: "13px",
    fontWeight: 600,
    lineHeight: 1.2,
    transitionDuration: "150ms",
    transitionProperty: "background-color, border-color, transform",
    transitionTimingFunction: "ease-out",
    ":hover": {
      backgroundColor: "#303129",
      borderColor: "#8b8c82",
      color: creatorWorkspaceTokens.ink,
      transform: "translateY(-1px)",
    },
    ":focus-visible": {
      outlineWidth: "3px",
      outlineStyle: "solid",
      outlineColor: creatorWorkspaceTokens.focus,
      outlineOffset: "3px",
    },
    "@media (prefers-reduced-motion: reduce)": {
      transitionDuration: "0ms",
    },
    "@media (max-width: 560px)": {
      right: "12px",
      bottom: "12px",
    },
  },
  triggerIcon: {
    width: "18px",
    height: "18px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  triggerHidden: {
    visibility: "hidden",
    opacity: 0,
    pointerEvents: "none",
  },
  drawer: {
    position: "fixed",
    top: "82px",
    right: "18px",
    bottom: "18px",
    zIndex: 50,
    width: "min(390px, calc(100vw - 36px))",
    minHeight: 0,
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: creatorWorkspaceTokens.sourceLine,
    borderRadius: "8px",
    backgroundColor: creatorWorkspaceTokens.benchRaised,
    boxShadow: "0 18px 42px rgba(0, 0, 0, 0.46)",
    color: creatorWorkspaceTokens.ink,
    fontFamily: creatorWorkspaceTokens.fontUi,
    transformOrigin: "right center",
    transitionDuration: "180ms",
    transitionProperty: "opacity, transform, visibility",
    transitionTimingFunction: "ease-out",
    "@media (prefers-reduced-motion: reduce)": {
      transitionDuration: "0ms",
    },
    "@media (max-width: 560px)": {
      top: "72px",
      right: "12px",
      bottom: "12px",
      width: "calc(100vw - 24px)",
    },
  },
  drawerOpen: {
    visibility: "visible",
    opacity: 1,
    transform: "translateX(0)",
    pointerEvents: "auto",
  },
  drawerClosed: {
    visibility: "hidden",
    opacity: 0,
    transform: "translateX(18px)",
    pointerEvents: "none",
  },
  close: {
    position: "absolute",
    top: "12px",
    right: "12px",
    zIndex: 2,
    width: "36px",
    height: "36px",
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: creatorWorkspaceTokens.line,
    borderRadius: "6px",
    backgroundColor: creatorWorkspaceTokens.benchHigh,
    color: creatorWorkspaceTokens.inkDim,
    cursor: "pointer",
    ":hover": {
      borderColor: creatorWorkspaceTokens.inkFaint,
      color: creatorWorkspaceTokens.ink,
    },
    ":focus-visible": {
      outlineWidth: "3px",
      outlineStyle: "solid",
      outlineColor: creatorWorkspaceTokens.focus,
      outlineOffset: "2px",
    },
  },
  closeIcon: {
    width: "18px",
    height: "18px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
  },
  content: {
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
});
