import { lazy, Suspense, useEffect } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  Navigate,
  Outlet,
} from "react-router-dom";
import { SessionBoundary, signInUrl } from "./components/SessionBoundary";
import { LandingPage } from "./pages/LandingPage";
import type { CurrentUserResponse } from "./types";

const CreatorPage = lazy(() =>
  import("./pages/CreatorPage").then(({ CreatorPage }) => ({
    default: CreatorPage,
  })),
);
const LibraryPage = lazy(() =>
  import("./pages/LibraryPage").then(({ LibraryPage }) => ({
    default: LibraryPage,
  })),
);
const VideoPage = lazy(() =>
  import("./pages/VideoPage").then(({ VideoPage }) => ({ default: VideoPage })),
);

function PageLoadingFallback() {
  return (
    <main className="app-main" aria-busy="true">
      <p role="status">Loading Carpo…</p>
    </main>
  );
}

function NotFoundPage() {
  return (
    <main className="session-page">
      <a className="public-wordmark" href="/">
        Carpo<span>.</span>
      </a>
      <div className="session-panel">
        <h1>That page isn’t here.</h1>
        <p>
          The address may be outdated. Your saved clips are still in your
          Library.
        </p>
        <div className="session-actions">
          <a className="btn-primary" href="/library">
            Open Library
          </a>
          <a className="btn-secondary" href="/create">
            Create a clip
          </a>
        </div>
      </div>
    </main>
  );
}

function SignedInApp({ user }: { user: CurrentUserResponse }) {
  return (
    <div className="app">
      <header className="app-header">
        <Link className="brand" to="/" aria-label="Carpo home">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <div>
            <h1>Carpo</h1>
            <p>Seize the moment.</p>
          </div>
        </Link>
        <div className="header-actions">
          <nav className="app-nav" aria-label="Main">
            <NavLink
              to="/create"
              className={({ isActive }) =>
                isActive ? "nav-link active" : "nav-link"
              }
            >
              Create
            </NavLink>
            <NavLink
              to="/library"
              className={({ isActive }) =>
                isActive ? "nav-link active" : "nav-link"
              }
            >
              Library
            </NavLink>
          </nav>
          <div className="account-summary">
            <span title={user.email ?? "Local workspace"}>
              {user.email ?? "Local workspace"}
            </span>
            {user.email && <a href="/cdn-cgi/access/logout">Sign out</a>}
          </div>
        </div>
      </header>
      <Suspense fallback={<PageLoadingFallback />}>
        <Outlet />
      </Suspense>
    </div>
  );
}

function SignInPage() {
  const location = useLocation();
  const returnTo =
    new URLSearchParams(location.search).get("returnTo") ?? "/create";
  return (
    <main className="session-page">
      <a className="public-wordmark" href="/">
        Carpo<span>.</span>
      </a>
      <div className="session-panel">
        <h1>Your next great clip starts here.</h1>
        <p>
          Sign in with your Google account. Your videos and clips stay in your
          own private library.
        </p>
        <a className="btn-primary" href={signInUrl(returnTo)}>
          Continue with Google
        </a>
        <p className="session-note">
          New to Carpo? Your private workspace is created the first time you
          sign in.
        </p>
        <a className="inline-link" href="/">
          Back to Carpo
        </a>
      </div>
    </main>
  );
}

export function App() {
  const location = useLocation();
  useEffect(() => {
    document.title =
      location.pathname === "/" ? "Carpo — Make more of your video." : "Carpo";
  }, [location.pathname]);
  // Preserve existing source/review handoffs without making the public homepage an editor.
  if (
    location.pathname === "/" &&
    /(?:^|[?&])(video|libraryProposal|visualProposal)=/.test(location.search)
  ) {
    return <Navigate to={`/create${location.search}`} replace />;
  }
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/sign-in" element={<SignInPage />} />
      <Route
        path="/auth/refresh"
        element={
          <SessionBoundary>
            {(user) => (
              <main className="session-page">
                <div className="session-panel">
                  <h1>You’re signed in.</h1>
                  <p>
                    Signed in as {user.email ?? "the local account"}. Return to
                    your original tab to continue your draft.
                  </p>
                  <a className="btn-secondary" href="/create">
                    Open a new workspace
                  </a>
                </div>
              </main>
            )}
          </SessionBoundary>
        }
      />
      <Route
        element={
          <SessionBoundary>
            {(user) => <SignedInApp user={user} />}
          </SessionBoundary>
        }
      >
        <Route path="/create" element={<CreatorPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/library/videos/:videoId" element={<VideoPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
