import {
  Component,
  lazy,
  Suspense,
  use,
  useState,
  type ReactNode,
} from "react";
import type { DurableReviewResult, Finding } from "./types";

const RecordingPlayer = lazy(() => import("./RecordingPlayer"));

function reportId() {
  const match = location.pathname.match(/^\/reports\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const reports = new Map<string, Promise<DurableReviewResult>>();

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function loadReport(id: string) {
  let pending = reports.get(id);
  if (!pending) {
    pending = (async () => {
      while (true) {
        const response = await fetch(`/api/reviews/${encodeURIComponent(id)}`, {
          credentials: "same-origin",
        });
        if (response.status === 404) {
          await wait(4_000);
          continue;
        }
        if (response.status === 401) {
          location.assign(`/login?returnTo=${encodeURIComponent(location.pathname)}`);
          await new Promise(() => {});
        }
        const body = (await response.json()) as DurableReviewResult & {
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        return body;
      }
    })();
    reports.set(id, pending);
  }
  return pending;
}

class ReportErrorBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.error) {
      return <main className="shell"><p className="eyebrow">Review unavailable</p><h1>{this.state.error}</h1></main>;
    }
    return this.props.children;
  }
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <article className={`finding finding-${finding.severity}`}>
      <div className="finding-meta">
        <span>{finding.severity}</span>
        <span>{finding.category}</span>
        <code>{finding.path}</code>
      </div>
      <h3>{finding.title}</h3>
      <p>{finding.description}</p>
      <dl>
        <dt>Evidence</dt>
        <dd>{finding.evidence}</dd>
      </dl>
      <details>
        <summary>Reproduction</summary>
        <ol>
          {finding.reproduction.map((step, index) => (
            <li key={`${index}-${step}`}>{step}</li>
          ))}
        </ol>
      </details>
    </article>
  );
}

function Report({ id }: { id: string }) {
  const report = use(loadReport(id));
  const [showReplay, setShowReplay] = useState(false);

  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">Exact-candidate advisory evidence</p>
          <h1>{report.verdict.replace("_", " ")}</h1>
        </div>
        <div className={`verdict verdict-${report.verdict}`}>{report.status}</div>
      </header>

      <section className="panel">
        <h2>Agent assessment</h2>
        <p>{report.summary}</p>
        <p className="muted">Execution {report.executionId} · {new Date(report.completedAt).toLocaleString()}</p>
      </section>

      <section>
        <div className="section-title"><h2>Visual evidence</h2><span>{report.screenshots.length} captures</span></div>
        <div className="screenshots">
          {report.screenshots.map((shot) => (
            <figure key={shot.file}>
              <a href={shot.downloadUrl} target="_blank" rel="noreferrer">
                <img src={shot.downloadUrl} alt={shot.note} loading="lazy" />
              </a>
              <figcaption><code>{shot.path}</code> — {shot.note}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section>
        <div className="section-title"><h2>Findings</h2><span>{report.findings.length}</span></div>
        {report.findings.length === 0 ? (
          <p className="panel">No reproducible issue was observed on the inspected paths.</p>
        ) : (
          <div className="findings">{report.findings.map((finding) => <FindingCard key={`${finding.path}-${finding.title}`} finding={finding} />)}</div>
        )}
      </section>

      <section className="panel">
        <h2>Coverage and remaining boundaries</h2>
        <div className="columns">
          <ul>{report.testedAreas.map((area) => <li key={area}>{area}</li>)}</ul>
          <ul>{report.remainingRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
        </div>
        <p className="boundary">{report.proofBoundary}</p>
      </section>

      {report.browserSessionId && (
        <section className="panel">
          <div className="section-title">
            <div><p className="eyebrow">Private Browser Run recording</p><h2>Replay the agent’s browser session</h2></div>
            <button type="button" onClick={() => setShowReplay((value) => !value)}>{showReplay ? "Close replay" : "Open replay"}</button>
          </div>
          {showReplay && <Suspense fallback={<p>Loading replay…</p>}><RecordingPlayer sessionId={report.browserSessionId} /></Suspense>}
        </section>
      )}
    </main>
  );
}

export default function App() {
  const id = reportId();
  if (id) {
    return (
      <ReportErrorBoundary>
        <Suspense fallback={<main className="shell"><p className="eyebrow">Carpo / durable Flue review</p><h1>The agent is inspecting the candidate.</h1><p className="muted">This private dossier refreshes when the report is published.</p></main>}>
          <Report id={id} />
        </Suspense>
      </ReportErrorBoundary>
    );
  }
  return (
    <main className="shell landing">
      <p className="eyebrow">Carpo / Cloudflare / Flue</p>
      <h1>Private, durable pull-request browser evidence.</h1>
      <p>The local runner and optional Cloudflare build-event adapter both feed the same exact-candidate reviewer. GitHub is a reporting convenience, not a runtime dependency.</p>
    </main>
  );
}
