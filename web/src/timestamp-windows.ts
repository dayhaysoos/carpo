import { formatTimestamp, parseTimestampInput } from "./youtube";

export interface TimestampWindow {
  label: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ClipWindowRequest extends TimestampWindow {
  requestId: number;
}

interface TimestampMatch {
  label: string;
  seconds: number;
  startIndex: number;
  endIndex: number;
}

const TIMESTAMP_PATTERN = /\b\d{1,4}:[0-5]\d(?:\.\d{1,3})?\b/g;
const RANGE_CONNECTOR = /^\s*(?:-|–|—|to|until|through)\s*$/i;

function compactTimestamp(seconds: number): string {
  return formatTimestamp(seconds).replace(/\.000$/, "");
}

function timestampMatches(text: string): TimestampMatch[] {
  return Array.from(text.matchAll(TIMESTAMP_PATTERN)).flatMap((match) => {
    const label = match[0];
    const seconds = parseTimestampInput(label);
    if (seconds === null || match.index === undefined) return [];
    return [
      {
        label,
        seconds,
        startIndex: match.index,
        endIndex: match.index + label.length,
      },
    ];
  });
}

export function extractTimestampWindows(
  text: string,
  defaultDurationSeconds: number,
): TimestampWindow[] {
  const matches = timestampMatches(text);
  const windows: TimestampWindow[] = [];
  const seen = new Set<string>();
  const defaultDuration = Math.max(1, defaultDurationSeconds);

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const connector = next
      ? text.slice(current.endIndex, next.startIndex)
      : "";
    const isExplicitRange =
      Boolean(next) &&
      RANGE_CONNECTOR.test(connector) &&
      next.seconds > current.seconds;
    const endSeconds = isExplicitRange
      ? next.seconds
      : current.seconds + defaultDuration;
    const endLabel = isExplicitRange
      ? next.label
      : compactTimestamp(endSeconds);
    const key = `${current.seconds}:${endSeconds}`;

    if (!seen.has(key)) {
      seen.add(key);
      windows.push({
        label: `${current.label} → ${endLabel}`,
        startSeconds: current.seconds,
        endSeconds,
      });
    }

    if (isExplicitRange) index += 1;
  }

  return windows;
}
