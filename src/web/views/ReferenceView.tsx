import { api } from "../api.ts";
import { useResource } from "../hooks/useResource.ts";

const SEVERITY: Record<string, string> = { error: "Blocking", conflict: "Conflict / unresolved", warning: "Warning", info: "Information" };

/** What the reference data is, where it came from, and what is still missing. */
export function ReferenceView() {
  const res = useResource("reference", (signal) => api.reference({ signal }));
  const info = res.data ?? null;
  const error =
    res.state !== "error" ? null : res.error.kind === "network" ? "The server could not be reached. Retry when the connection is back." : res.error.message;
  if (error) {
    return (
      <section className="panel">
        <h2>Reference data</h2>
        <div className="alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={res.reload}>
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (!info) return <p role="status">Loading reference data…</p>;
  const order = ["error", "conflict", "warning", "info"];
  const findings = [...info.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return (
    <section className="panel" aria-labelledby="ref-h">
      <h2 id="ref-h">Reference data</h2>
      <p className="authority">{info.authorityNotice}</p>
      <dl className="facts wide">
        <dt>Active release</dt>
        <dd>
          {info.releaseId} — {info.label}
        </dd>
        <dt>Activated (UTC)</dt>
        <dd>{info.activatedAt ?? "—"}</dd>
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
      <p className="fine">Counts: {JSON.stringify(info.counts)}</p>

      <h3>Import findings ({findings.length})</h3>
      <ul className="findings">
        {findings.map((f, i) => (
          <li key={i} className={`finding ${f.severity}`}>
            <strong>{SEVERITY[f.severity] ?? f.severity}</strong> <span className="code">{f.code}</span> {f.message}
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
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Sources table">
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
                  {s.effectiveFrom ?? "not stated"} / {s.expiresOn ?? "none"}
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
      </div>

      <h3>Releases</h3>
      <ul>
        {info.releases.map((r) => (
          <li key={r.id}>
            {r.id} — {r.status}, created {r.createdAt}, findings {JSON.stringify(r.findingCounts)}
          </li>
        ))}
      </ul>
    </section>
  );
}
