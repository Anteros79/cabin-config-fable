// Reachability note for hyperlinks on public hosts only (one HEAD request chain per distinct URL).
// Private/authenticated hosts are never requested. Reachability is not proof of approval or accuracy.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVIDENCE_DIR, F, writeJson } from './lib/common.mjs';

const CURL_ARGS = ['-sI', '-L', '--max-time', '15'];

function curlHead(url) {
  let stdout = '';
  let exitCode = 0;
  let error = null;
  try {
    stdout = execFileSync('curl', [...CURL_ARGS, url], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : -1;
    stdout = typeof e.stdout === 'string' ? e.stdout : '';
    error = String(e.message ?? e).split('\n')[0];
  }
  const statuses = [...stdout.matchAll(/^HTTP\/[\d.]+\s+(\d{3})/gm)].map((m) => Number(m[1]));
  const locations = [...stdout.matchAll(/^location:\s*(.+?)\s*$/gim)].map((m) => m[1]);
  const header = (name) => {
    const all = [...stdout.matchAll(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'gim'))].map((m) => m[1]);
    return all.length ? all.at(-1) : null;
  };
  return {
    curl_exit_code: exitCode,
    curl_error: error,
    status_code_chain: statuses,
    final_status_code: statuses.length ? statuses.at(-1) : null,
    redirect_locations: locations,
    final_content_type: header('content-type'),
    final_server: header('server'),
  };
}

export function run(ctx) {
  const targets = ctx.results.docx.hyperlinks.distinct_targets;
  const rtfLinks = ctx.results.rtf.hyperlinks;
  const skip = process.env.CABIN_KIT_SKIP_NETWORK === '1';
  const prevPath = join(EVIDENCE_DIR, 'extracts', 'hyperlinks-check.json');
  let previous = null;
  if (skip && existsSync(prevPath)) {
    try { previous = JSON.parse(readFileSync(prevPath, 'utf8')); } catch { previous = null; }
  }
  const checkedAt = new Date().toISOString();
  const results = targets.map((t) => {
    const base = { target_url: t.target_url, host: t.host, access_class: t.access_class, classification_reason: t.reason, source_file: F.DOCX, occurrences: t.occurrences };
    if (t.access_class !== 'public') return { ...base, check: 'not accessed (private)', requested: false };
    if (skip) {
      const old = previous?.results?.find((r) => r.target_url === t.target_url && r.requested);
      if (old) return { ...base, check: old.check, requested: true, reused_from_previous_run: true, checked_at: old.checked_at, command: old.command, result: old.result };
      return { ...base, check: 'not checked (network skipped by CABIN_KIT_SKIP_NETWORK=1)', requested: false };
    }
    const result = curlHead(t.target_url);
    return {
      ...base,
      check: result.final_status_code !== null ? `HTTP ${result.final_status_code}` : `no HTTP response (curl exit ${result.curl_exit_code})`,
      requested: true,
      reused_from_previous_run: false,
      checked_at: checkedAt,
      command: `curl ${CURL_ARGS.join(' ')} <url>`,
      result,
    };
  });
  const out = {
    purpose: 'Reachability note only. A status code says a host answered a HEAD request; it does not verify content, currency, authority or approval.',
    policy: {
      requested: 'hyperlinks whose host is public (no SharePoint / Office 365 / Outlook / internal marker)',
      never_requested: 'sharepoint.com, office365.com, outlook, and other private or authenticated hosts',
      command: `curl ${CURL_ARGS.join(' ')} <url> (one invocation per distinct URL)`,
    },
    network_skipped: skip,
    rtf_hyperlink_count: rtfLinks.length,
    summary: {
      distinct_targets: results.length,
      public_requested: results.filter((r) => r.requested).length,
      private_not_accessed: results.filter((r) => r.access_class === 'private').length,
      status_codes: results.filter((r) => r.requested).map((r) => ({ target_url: r.target_url, final_status_code: r.result?.final_status_code ?? null })),
    },
    results,
  };
  ctx.written.push(writeJson('extracts/hyperlinks-check.json', out));
  return out;
}
