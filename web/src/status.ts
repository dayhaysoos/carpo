import type { ClipStatus } from "./types";

export function isTerminalStatus(status: ClipStatus): boolean {
  return status === "complete" || status === "failed";
}

export function statusLabel(status: ClipStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading";
    case "encoding":
      return "Encoding";
    case "uploading":
      return "Uploading";
    case "complete":
      return "Complete";
    case "failed":
      return "Failed";
  }
}

export function statusProgress(status: ClipStatus): number {
  switch (status) {
    case "queued":
      return 10;
    case "downloading":
      return 35;
    case "encoding":
      return 65;
    case "uploading":
      return 85;
    case "complete":
      return 100;
    case "failed":
      return 100;
  }
}
