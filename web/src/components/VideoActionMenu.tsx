import { useEffect, useRef, useState } from "react";

interface VideoActionMenuProps {
  videoTitle: string;
  archived: boolean;
  disabled?: boolean;
  onArchive: () => void;
  onDelete: () => void;
}

export function VideoActionMenu({
  videoTitle,
  archived,
  disabled = false,
  onArchive,
  onDelete,
}: VideoActionMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={menuRef} className={`video-menu${open ? " open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="video-menu-trigger"
        aria-label={`More actions for ${videoTitle}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {open && (
        <div
          className="video-menu-popover"
          role="group"
          aria-label={`Actions for ${videoTitle}`}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onArchive();
            }}
          >
            {archived ? "Restore" : "Archive"}
          </button>
          <button
            type="button"
            className="video-menu-delete"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete video
          </button>
        </div>
      )}
    </div>
  );
}
