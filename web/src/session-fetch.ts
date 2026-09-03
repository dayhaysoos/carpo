/** Transport-level session failures shared by fetch, upload, and the app shell. */
export class SessionRequiredError extends Error {
  constructor() {
    super("Your session has ended. Sign in again to continue.");
    this.name = "SessionRequiredError";
  }
}

const listeners = new Set<() => void>();

export function onSessionRequired(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requireSession(): SessionRequiredError {
  for (const listener of listeners) listener();
  return new SessionRequiredError();
}

export async function sessionFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  // Access's login redirect must not be followed as an API request (or replay a write).
  const response = await fetch(input, {
    ...init,
    redirect: "manual",
    credentials: "same-origin",
  });
  if (
    response.status === 401 ||
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw requireSession();
  }
  // Access denial pages are HTML, while application permission errors are JSON.
  if (
    response.status === 403 &&
    response.headers.get("content-type")?.includes("text/html")
  ) {
    throw new Error(
      "This account does not have access to Carpo yet. Try another Google account or contact the person who gave you access.",
    );
  }
  return response;
}

export async function uploadFailure(status: number): Promise<Error> {
  if (status === 401) return requireSession();
  if (status === 0) {
    // XHR reports a cross-origin Access redirect as a network error. Distinguish it
    // from an offline connection without retrying or duplicating the upload.
    try {
      await sessionFetch("/api/me", { signal: AbortSignal.timeout(10000) });
    } catch (error) {
      if (error instanceof SessionRequiredError) return error;
    }
  }
  return new Error(
    "Upload interrupted. Check your connection and retry the upload.",
  );
}
