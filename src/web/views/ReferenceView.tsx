import { api } from "../api.ts";
import { ScrollRegion } from "../components/ScrollRegion.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { FINDING_SEVERITY_LABEL, formatCounts, formatDate, formatDateTime } from "../format.ts";
import { useResource } from "../hooks/useResource.ts";
import { contentKeyed } from "../model.ts";

/** Names for the release counts; a count split by namespace reads "5 candidate, 2 fixture". */
const COUNT_LABEL: Record<string, string> = {
  aircraft: "Aircraft (tails)",
  variants: "Maintenance variants",
  layoutRevisions: "Layout revisions",
  rules: "Parts rules",
  substitutes: "Approved alternates",
  parts: "Parts",
  sources: "Sources",
  accepted: "Accepted airline records",
};
const FINDING_COUNT_NOUN: Record<string, string> = { error: "blocking finding", conflict: "conflict", warning: "warning", info: "note" };

function countText(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const counts = Object.fromEntries(Object.entries(value).filter((e): e is [string, number] => typeof e[1] === "number"));
    return formatCounts(counts, {});
  }
  return String(value ?? "—");
}

const Time = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={iso}>
    {formatDateTime(iso)}
  </time>
);

/** What the reference data is, where it came from, and what is still missing. */
export function ReferenceView() {
  const res = useResource("reference", (signal) => api.reference({ signal }));
  const info = res.data ?? null;
  const error =
    res.state !== "error" ? null : res.error.kind === "network" ? "The server could not be reached. Retry when the connection is back." : res.error.message;
  if (error) {
    return (
      <section className="panel">
        <h2 tabIndex={-1}>Reference data</h2>
        <div className="alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={res.reload}>
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (!info) {
    return (
      <section className="panel" aria-label="Reference data" aria-busy="true">
        <Skeleton thing="reference data" shape="facts" />
      </section>
    );
  }
  const order = ["error", "conflict", "warning", "info"];
  const findings = [...info.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return (
    <section className="panel" aria-labelledby="ref-h">
      <h2 id="ref-h" tabIndex={-1}>
        Reference data
      </h2>
      <p className="authority">{info.authorityNotice}</p>
      <dl className="facts wide">
        <dt>Active release</dt>
        <dd>
          {info.releaseId} — {info.label}
        </dd>
        <dt>Activated</dt>
        <dd>{info.activatedAt ? <Time iso={info.activatedAt} /> : "not activated"}</dd>
        <dt>Content SHA-256</dt>
        <dd className="mono">{info.contentHash}</dd>
        <dt>Date rule</dt>
        <dd>{info.dateRule}</dd>
        <dt>Replacement counts</dt>
        <dd>{info.replacementCountSemantics}</dd>
      </dl>

      <h3>Namespaces</h3>
      <dl className="facts wide">
        {Object.entries(info.namespaces).map(([k, v]) => (
          <div key={k} className="pair">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3>Counts</h3>
      <dl className="facts wide">
        {Object.entries(info.counts).map(([k, v]) => (
          <div key={k} className="pair">
            <dt>{COUNT_LABEL[k] ?? k}</dt>
            <dd>{countText(v)}</dd>
          </div>
        ))}
      </dl>

      <h3>Import findings ({findings.length})</h3>
      <ul className="findings">
        {contentKeyed(findings, (f) => `${f.severity}|${f.code}|${f.message}|${(f.refs ?? []).join(",")}`).map(([key, f]) => (
          <li key={key} className={`finding ${f.severity}`}>
            <strong>{FINDING_SEVERITY_LABEL[f.severity] ?? f.severity}</strong> <span className="code">{f.code}</span> {f.message}
          </li>
        ))}
      </ul>

      <h3>Visual families</h3>
      <ul>
        {info.visualProfiles.map((p) => (
          <li key={p.id}>
            <strong>{p.name}</strong> — unassigned, illustrative ({p.basis}). {p.note}
            <br />
            <span className="fine">Evidence: {p.evidence.join(", ")}</span>
          </li>
        ))}
      </ul>

      <h3>Sources ({info.sources.length})</h3>
      <ScrollRegion label="Sources table">
        <table>
          <thead>
            <tr>
              <th scope="col">Id</th>
              <th scope="col">Namespace</th>
              <th scope="col">Title</th>
              <th scope="col">Revision</th>
              <th scope="col">Authority</th>
              <th scope="col">Released</th>
              <th scope="col">Effective / expires</th>
              <th scope="col">File, size, SHA-256, read status</th>
            </tr>
          </thead>
          <tbody>
            {info.sources.map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.id}</th>
                <td>{s.namespace}</td>
                <td>{s.title}</td>
                <td>{s.revision}</td>
                <td>{s.authority}</td>
                <td>{s.released ? "yes" : "no"}</td>
                <td>
                  {s.effectiveFrom ? formatDate(s.effectiveFrom) : "not stated"} / {s.expiresOn ? formatDate(s.expiresOn) : "none"}
                </td>
                <td>
                  {s.file ? (
                    <>
                      {s.file.path} · {s.file.bytes} bytes
                      <br />
                      <span className="mono fine">{s.file.sha256}</span>
                      <br />
                      <span className="fine">{s.file.parseStatus}</span>
                    </>
                  ) : (
                    "fictional fixture (no file)"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>

      <h3>Releases</h3>
      <ul>
        {info.releases.map((r) => (
          <li key={r.id}>
            {r.id} — {r.status}, created <Time iso={r.createdAt} />, findings: {formatCounts(r.findingCounts, FINDING_COUNT_NOUN)}
          </li>
        ))}
      </ul>
    </section>
  );
}
