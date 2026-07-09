export const JOB_SECRET_HEADER = "X-Carpo-Job-Secret";
export const HELPER_TOKEN_HEADER = "X-Carpo-Helper-Token";

export function generateCallbackSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function verifyJobSecret(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (!provided || !expected) {
    return false;
  }
  if (provided.length !== expected.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < provided.length; i += 1) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export function verifyHelperToken(
  provided: string | null | undefined,
  expected: string,
): boolean {
  return verifyJobSecret(provided, expected);
}
