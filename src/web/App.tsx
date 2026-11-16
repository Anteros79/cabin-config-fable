import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import type { VisualProfile } from "../domain/types.ts";
import { api, type Health } from "./api.ts";
import { CheckView } from "./views/CheckView.tsx";
import { LayoutsView } from "./views/LayoutsView.tsx";
import { PrepView } from "./views/PrepView.tsx";
import { ReferenceView } from "./views/ReferenceView.tsx";
import { ReportView } from "./views/ReportView.tsx";
import { VisitsView } from "./views/VisitsView.tsx";

type Route =
  | { name: "check" }
  | { name: "visit"; id: string }
  | { name: "report"; id: string }
  | { name: "prep"; visitId: string | null; tail: string | null; date: string | null }
  | { name: "visits" }
  | { name: "layouts"; id: string | null }
  | { name: "reference" };

function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] === "visit" && parts[1]) {
    if (parts[2] === "report") return { name: "report", id: parts[1] };
    if (parts[2] === "prep") return { name: "prep", visitId: parts[1], tail: null, date: null };
    return { name: "visit", id: parts[1] };
  }
  if (parts[0] === "prep") return { name: "prep", visitId: null, tail: params.get("tail"), date: params.get("date") };
  if (parts[0] === "visits") return { name: "visits" };
  if (parts[0] === "layouts") return { name: "layouts", id: parts[1] ?? null };
  if (parts[0] === "reference") return { name: "reference" };
  return { name: "check" };
}

const TITLES: Record<Route["name"], string> = {
  check: "Appearance check",
  visit: "Visit",
  report: "Report",
  prep: "Preparation",
  visits: "Saved visits",
  layouts: "Layouts",
  reference: "Reference data",
};

const FALLBACK_PROFILES: VisualProfile[] = [
  { id: "photo-navy-band", name: "Photographed navy with pale-blue band", basis: "Photographs", status: "unassigned-illustrative", evidence: [], note: "" },
  { id: "photo-navy-plain", name: "Photographed navy without band", basis: "Photographs", status: "unassigned-illustrative", evidence: [], note: "" },
  { id: "concept-gray", name: "Concept/render gray treatment", basis: "Probable computer renders", status: "unassigned-illustrative", evidence: [], note: "" },
];

class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  override render() {
    if (this.state.error) {
      return (
        <section className="panel" role="alert">
          <h2>This screen could not be shown</h2>
          <p>{this.state.error.message}</p>
          <p>Saved visits are stored on the server and are not affected.</p>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>{" "}
          <a href="#/visits">Saved visits</a>
        </section>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const [hash, setHash] = useState(window.location.hash);
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  const [profiles, setProfiles] = useState<VisualProfile[]>(FALLBACK_PROFILES);
  const mainRef = useRef<HTMLElement | null>(null);
  const route = parseRoute(hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const h = await api.health();
        if (!stopped) {
          setHealth(h);
          setOffline(false);
        }
      } catch {
        if (!stopped) setOffline(true);
      }
    };
    void check();
    const timer = setInterval(check, 15000);
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list kept as authored to preserve behaviour; fixed in Task 4.4
  useEffect(() => {
    api
      .layouts()
      .then((r) => r.visualProfiles.length && setProfiles(r.visualProfiles))
      .catch(() => undefined);
  }, [health?.reference.releaseId]);

  useEffect(() => {
    document.title = `${TITLES[route.name]} - Cabin Kit (fictional demonstration)`;
  }, [route.name]);

  const navigate = (next: string) => {
    window.location.hash = next;
  };
  const nav: [string, string, boolean][] = [
    ["#/check", "Check", route.name === "check" || route.name === "visit"],
    ["#/visits", "Saved visits", route.name === "visits" || route.name === "report"],
    ["#/layouts", "Layouts", route.name === "layouts"],
    ["#/reference", "Reference", route.name === "reference"],
  ];

  return (
    <>
      <a className="skip" href="#main" onClick={() => mainRef.current?.focus()}>
        Skip to content
      </a>
      <header className="app-header no-print">
        <div className="brand">
          <h1>Cabin Kit</h1>
          <p className="demo-badge">Fictional demonstration · not a maintenance authority</p>
        </div>
        <nav aria-label="Main">
          <ul>
            {nav.map(([href, label, active]) => (
              <li key={href}>
                <a href={href} aria-current={active ? "page" : undefined}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <div aria-live="assertive" className="no-print">
        {offline && (
          <p className="system-banner bad" role="alert">
            The Cabin Kit server cannot be reached. Saved work stays on the server. Nothing you do now is saved until the connection returns; each screen offers
            a retry.
          </p>
        )}
        {!offline && health && !health.reference.available && (
          <p className="system-banner warn" role="alert">
            Reference data is unavailable ({health.reference.message}). Lookups and new visits are refused until it is restored. Saved visits and reports remain
            available.
          </p>
        )}
        {!offline && health && !health.visits.available && (
          <p className="system-banner bad" role="alert">
            The visit store is unavailable ({health.visits.message}). Nothing can be saved right now.
          </p>
        )}
      </div>
      <main id="main" ref={mainRef} tabIndex={-1}>
        <ErrorBoundary resetKey={hash}>
          {route.name === "check" && <CheckView visitId={null} navigate={navigate} visualProfiles={profiles} />}
          {route.name === "visit" && <CheckView visitId={route.id} navigate={navigate} visualProfiles={profiles} />}
          {route.name === "report" && <ReportView visitId={route.id} />}
          {route.name === "prep" && <PrepView visitId={route.visitId} tail={route.tail} date={route.date} />}
          {route.name === "visits" && <VisitsView />}
          {route.name === "layouts" && <LayoutsView layoutId={route.id} visualProfiles={profiles} />}
          {route.name === "reference" && <ReferenceView />}
        </ErrorBoundary>
      </main>
      <footer className="app-footer no-print">
        <p>
          Home-lab demonstration with fictional fixtures and unverified candidate layouts. Not an approved maintenance source or work instruction.
          {health?.reference.releaseId ? ` Reference release ${health.reference.releaseId}.` : ""}
        </p>
      </footer>
    </>
  );
}
