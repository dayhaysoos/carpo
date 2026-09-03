import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCurrentUser } from "../api";
import { SessionActivity } from "../session-activity";
import { onSessionRequired, SessionRequiredError } from "../session-fetch";
import type { CurrentUserResponse } from "../types";

type Status = "loading" | "ready" | "signed-out" | "expired" | "error";
type Workspace = { user: CurrentUserResponse; client: QueryClient };

export function signInUrl(returnTo = "/create"): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function SessionBoundary({
  children,
}: {
  children: (user: CurrentUserResponse) => ReactNode;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");
  const current = useRef<Workspace | null>(null);
  const generation = useRef(0);

  const check = useCallback(async () => {
    const request = ++generation.current;
    try {
      const user = await getCurrentUser();
      if (request !== generation.current) return;
      if (!current.current || current.current.user.id !== user.id) {
        current.current?.client.clear();
        current.current = {
          user,
          client: new QueryClient({
            defaultOptions: {
              queries: {
                staleTime: 1000,
                retry: (count, error) =>
                  !(error instanceof SessionRequiredError) && count < 2,
              },
            },
          }),
        };
        setWorkspace(current.current);
      }
      setStatus("ready");
      setMessage("");
      void current.current.client.invalidateQueries();
    } catch (error) {
      if (request !== generation.current) return;
      setStatus(
        error instanceof SessionRequiredError
          ? current.current
            ? "expired"
            : "signed-out"
          : "error",
      );
      setMessage(
        error instanceof Error
          ? error.message
          : "We couldn’t check your session.",
      );
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onSessionRequired(() => {
      ++generation.current;
      setStatus(current.current ? "expired" : "signed-out");
      void current.current?.client.cancelQueries();
    });
    void check();
    const onFocus = () => {
      void check();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ++generation.current;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [check]);

  const active = status === "ready";
  return (
    <>
      {workspace && (
        <SessionActivity value={active}>
          <QueryClientProvider client={workspace.client}>
            <div key={workspace.user.id} hidden={!active} inert={!active}>
              {children(workspace.user)}
            </div>
          </QueryClientProvider>
        </SessionActivity>
      )}
      {!active && (
        <main className="session-page" aria-labelledby="session-title">
          <a className="public-wordmark" href="/">
            Carpo<span>.</span>
          </a>
          <div className="session-panel">
            <h1 id="session-title">
              {status === "loading"
                ? "Opening your workspace…"
                : status === "expired"
                  ? "Pick up where you left off."
                  : status === "error"
                    ? "We couldn’t open your workspace."
                    : "Your clips start here."}
            </h1>
            {status === "loading" ? (
              <p role="status">Checking your session…</p>
            ) : (
              <>
                <p role={status === "error" ? "alert" : undefined}>
                  {status === "expired"
                    ? "Your session has ended. Sign in again in a new tab, then return here. Your draft stays in this tab."
                    : status === "error"
                      ? message
                      : "Sign in with your Google account to open your private video library."}
                </p>
                <div className="session-actions">
                  <a
                    className="btn-primary"
                    href={signInUrl(
                      workspace
                        ? "/auth/refresh"
                        : window.location.pathname + window.location.search,
                    )}
                    target={workspace ? "_blank" : undefined}
                    rel={workspace ? "noopener" : undefined}
                  >
                    {workspace
                      ? "Sign in again (new tab)"
                      : "Continue with Google"}
                  </a>
                  {(workspace || status === "error") && (
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        void check();
                      }}
                    >
                      Check session again
                    </button>
                  )}
                </div>
                <p className="session-note">
                  Using a different account opens that account’s workspace.
                  Saved clips stay with their owner.
                </p>
                <a className="inline-link" href="/">
                  Back to Carpo
                </a>
              </>
            )}
          </div>
        </main>
      )}
    </>
  );
}
