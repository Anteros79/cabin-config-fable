import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { VisualProfile } from "../domain/types.ts";
import { ApiError, api, type Health } from "./api.ts";
import { useResource } from "./hooks/useResource.ts";
import { isInPageAnchor, type NavigateOptions, parseRoute, type Route } from "./routes.ts";
import { CheckView } from "./views/CheckView.tsx";
import { LayoutsView } from "./views/LayoutsView.tsx";
import { PrepView } from "./views/PrepView.tsx";
import { ReferenceView } from "./views/ReferenceView.tsx";
import { ReportView } from "./views/ReportView.tsx";
import { VisitsView } from "./views/VisitsView.tsx";

const TITLES: Record<Route["name"], string> = {
  check: "Appearance check",
  visit: "Visit",
  report: "Report",
  prep: "Preparation",
  visits: "Saved visits",
  layouts: "Layouts",
  reference: "Reference data",
  notFound: "Page not found",
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
          <h2 tabIndex={-1}>This screen could not be shown</h2>
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

/** Which view a route shows: a change of view moves focus; a change of query on the same view does not. */
function viewKey(route: Route): string {
  switch (route.name) {
    case "visit":
    case "report":
      return `${route.name}:${route.id}`;
    case "prep":
      return `prep:${route.visitId ?? ""}`;
    case "layouts":
      return `layouts:${route.id ?? ""}`;
    default:
      return route.name;
  }
}

/** What the page title needs to name an open visit. */
interface VisitMeta {
  id: string;
  number: number;
  tail: string;
}

export function App() {
  // A hash that points at an element ("#main") is not a route: the route on screen stays.
  const [hash, setHash] = useState(() => (isInPageAnchor(window.location.hash) ? "" : window.location.hash));
  const [visitMeta, setVisitMeta] = useState<VisitMeta | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  const [profiles, setProfiles] = useState<VisualProfile[]>(FALLBACK_PROFILES);
  const mainRef = useRef<HTMLElement | null>(null);
  const route = parseRoute(hash);

  useEffect(() => {
    const onHash = () => {
      const next = window.location.hash;
      if (!isInPageAnchor(next)) setHash(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The health poll runs only while the page is visible; showing the page again checks at once.
  useEffect(() => {
    let inFlight: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      try {
        const h = await api.health({ signal: controller.signal });
        if (inFlight === controller) {
          setHealth(h);
          setOffline(false);
        }
      } catch (e) {
        if (inFlight === controller && !(e instanceof ApiError && e.kind === "aborted")) setOffline(true);
      }
    };
    const pause = () => {
      clearInterval(timer);
      timer = undefined;
      inFlight?.abort();
      inFlight = null;
    };
    const resume = () => {
      if (timer !== undefined) return;
      void check();
      timer = setInterval(check, 15000);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? pause() : resume());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
    };
  }, []);

  // Visual profiles come with the layouts; a change of active release reads them again.
  const releaseId = health?.reference.releaseId;
  const layouts = useResource(`layouts:${releaseId ?? ""}`, (signal) => api.layouts({ signal }));
  const loadedProfiles = layouts.data?.visualProfiles;
  useEffect(() => {
    if (loadedProfiles?.length) setProfiles(loadedProfiles);
  }, [loadedProfiles]);

  const routeId = route.name === "visit" || route.name === "report" ? route.id : null;
  const meta = routeId && visitMeta?.id === routeId ? visitMeta : null;
  const label = meta ? `${route.name === "report" ? "Report" : "Visit"} #${meta.number} · ${meta.tail}` : TITLES[route.name];
  const title = `${label} · Cabin Kit`;
  useEffect(() => {
    document.title = title;
  }, [title]);

  // A new view (not a new query on the same view) moves focus to its heading, and the page title is announced. Not on first load.
  const view = viewKey(route);
  const lastView = useRef(view);
  const navigated = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const titleRef = useRef(title);
  titleRef.current = title;
  useEffect(() => {
    const main = mainRef.current;
    if (view === lastView.current || !main) return;
    lastView.current = view;
    navigated.current = true;
    setAnnouncement(titleRef.current);
    const focusHeading = (): boolean => {
      const heading = main.querySelector<HTMLElement>("h2");
      heading?.focus();
      return heading !== null;
    };
    if (focusHeading()) return;
    // A view that is still loading shows its heading later; focus it when it appears, unless the person has moved focus meanwhile.
    const before = document.activeElement;
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (active !== null && active !== before && active !== document.body && active !== main) {
        observer.disconnect();
        return;
      }
      if (focusHeading()) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [view]);
  // A title that fills in after the view loads (the visit number) is announced too.
  useEffect(() => {
    if (navigated.current) setAnnouncement(title);
  }, [title]);

  // `replace` swaps the current history entry (a redirect), so Back does not land on the URL that was replaced.
  const navigate = useCallback((next: string, options?: NavigateOptions) => {
    if (options?.replace) window.location.replace(next);
    else window.location.hash = next;
  }, []);
  const nav: [string, string, boolean][] = [
    ["#/check", "Check", route.name === "check" || route.name === "visit" || (route.name === "prep" && !route.visitId)],
    ["#/visits", "Saved visits", route.name === "visits" || route.name === "report" || (route.name === "prep" && !!route.visitId)],
    ["#/layouts", "Layouts", route.name === "layouts"],
    ["#/reference", "Reference", route.name === "reference"],
  ];

  return (
    <>
      {/* A button, not a link: following "#main" would replace the route in the address bar. */}
      <button type="button" className="skip" onClick={() => mainRef.current?.focus()}>
        Skip to content
      </button>
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
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <main id="main" ref={mainRef} tabIndex={-1}>
        <ErrorBoundary resetKey={hash}>
          {route.name === "notFound" && (
            <section className="panel" aria-labelledby="notfound-h">
              <h2 id="notfound-h" tabIndex={-1}>
                Page not found
              </h2>
              <p>This page does not exist.</p>
              <a href="#/">Go to the appearance check</a>
            </section>
          )}
          {route.name === "check" && <CheckView visitId={null} tail={route.tail} date={route.date} navigate={navigate} visualProfiles={profiles} />}
          {/* keyed by visit (here and for the report): each visit gets its own write queue, so no status or key carries over */}
          {route.name === "visit" && <CheckView key={route.id} visitId={route.id} onVisit={setVisitMeta} navigate={navigate} visualProfiles={profiles} />}
          {route.name === "report" && <ReportView key={route.id} visitId={route.id} onVisit={setVisitMeta} />}
          {route.name === "prep" && <PrepView visitId={route.visitId} tail={route.tail} date={route.date} />}
          {route.name === "visits" && <VisitsView status={route.status} q={route.q} page={route.page} navigate={navigate} />}
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
