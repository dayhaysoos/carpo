import { lazy, Suspense, useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { getCurrentUser } from "./api";

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
  import("./pages/VideoPage").then(({ VideoPage }) => ({
    default: VideoPage,
  })),
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
    <main className="not-found-page" aria-labelledby="not-found-title">
      <div className="not-found-content">
        <h2 id="not-found-title">That page isn’t here.</h2>
        <p>
          The address may be outdated. Return to your Library or start a new
          clip without losing anything you already saved.
        </p>
        <div className="not-found-actions">
          <Link className="btn-primary" to="/library">
            Open Library
          </Link>
          <Link className="btn-secondary" to="/">
            Create a clip
          </Link>
        </div>
      </div>
    </main>
  );
}

export function App() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    void getCurrentUser()
      .then((user) => setEmail(user.email))
      .catch(() => setEmail(null));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Carpo</h1>
            <p>Seize the moment.</p>
          </div>
        </div>
        <div className="header-actions">
          <nav className="app-nav" aria-label="Main">
            <NavLink
              to="/"
              end
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
          {email ? (
            <div className="account-summary">
              <span title={email}>{email}</span>
              <a href="/cdn-cgi/access/logout">Sign out</a>
            </div>
          ) : null}
        </div>
      </header>

      <Suspense fallback={<PageLoadingFallback />}>
        <Routes>
          <Route path="/" element={<CreatorPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/library/videos/:videoId" element={<VideoPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </div>
  );
}
