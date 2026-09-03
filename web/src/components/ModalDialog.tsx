import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSessionActive } from "../session-activity";

interface ModalDialogProps {
  children: ReactNode;
  labelledBy: string;
  onDismiss?: () => void;
  role?: "dialog" | "alertdialog";
  className?: string;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "video[controls]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ModalDialog({
  children,
  labelledBy,
  onDismiss,
  role = "dialog",
  className = "",
}: ModalDialogProps) {
  const sessionActive = useSessionActive();
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (!dialog) return;
    if (!sessionActive) {
      dialog.querySelectorAll<HTMLMediaElement>("video, audio").forEach((media) => {
        if (!media.paused) media.pause();
      });
      return;
    }

    const focusable = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    (focusable()[0] ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissRef.current) {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [sessionActive]);

  return createPortal(
    <div
      className="modal-backdrop"
      hidden={!sessionActive}
      inert={!sessionActive}
      style={sessionActive ? undefined : { display: "none" }}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss?.();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal-panel ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
