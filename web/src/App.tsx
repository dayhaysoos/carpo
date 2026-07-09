import { useState } from "react";
import { addJobId, loadJobIds } from "./jobStorage";
import { CreatorForm } from "./components/CreatorForm";
import { StatusPanel } from "./components/StatusPanel";

export function App() {
  const [jobIds, setJobIds] = useState<string[]>(() => loadJobIds());

  const handleClipCreated = (clipId: string) => {
    setJobIds(addJobId(clipId));
  };

  const handleDismiss = (id: string) => {
    setJobIds((prev) => prev.filter((jobId) => jobId !== id));
  };

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
      </header>

      <main className="app-main">
        <CreatorForm onClipCreated={handleClipCreated} />
        <StatusPanel jobIds={jobIds} onDismiss={handleDismiss} />
      </main>
    </div>
  );
}
