import { timingSafeEqual } from "node:crypto";

export const REVIEW_COOKIE = "carpo_review_view";

export async function tokensMatch(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(
    new Uint8Array(providedHash),
    new Uint8Array(expectedHash),
  );
}

export function bearerToken(header: string | undefined) {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

export function cookieValue(header: string | undefined, name: string) {
  for (const segment of (header ?? "").split(";")) {
    const [key, ...value] = segment.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

export function safeReturnPath(value: string | undefined) {
  return value && /^\/reports\/[A-Za-z0-9._-]{1,140}$/.test(value)
    ? value
    : "/";
}
