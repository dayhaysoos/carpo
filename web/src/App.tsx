import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { getCurrentUser } from "./api";
import { CreatorPage } from "./pages/CreatorPage";
import { LibraryPage } from "./pages/LibraryPage";
import { VideoPage } from "./pages/VideoPage";

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

      <Routes>
        <Route path="/" element={<CreatorPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/library/videos/:videoId" element={<VideoPage />} />
      </Routes>
    </div>
  );
}
