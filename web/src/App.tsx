import { NavLink, Route, Routes } from "react-router-dom";
import { CreatorPage } from "./pages/CreatorPage";
import { LibraryPage } from "./pages/LibraryPage";

export function App() {
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
      </header>

      <Routes>
        <Route path="/" element={<CreatorPage />} />
        <Route path="/library" element={<LibraryPage />} />
      </Routes>
    </div>
  );
}
