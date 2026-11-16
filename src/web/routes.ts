/** The hash routes of the app. Parsing never throws; what cannot be read is a `notFound` route that keeps the raw hash. */
export type Route =
  | { name: "check"; tail: string | null; date: string | null }
  | { name: "visit"; id: string }
  | { name: "report"; id: string }
  | { name: "prep"; visitId: string | null; tail: string | null; date: string | null }
  | { name: "visits"; status: "DRAFT" | "COMPLETED" | null; q: string; page: number }
  | { name: "layouts"; id: string | null }
  | { name: "reference" }
  | { name: "notFound"; hash: string };

/** How a view asks App to change route. `replace` rewrites the current history entry instead of adding one. */
export interface NavigateOptions {
  replace?: boolean;
}

/** The highest page a route may ask for: keeps the list offset a small safe integer. */
export const MAX_PAGE = 1_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A hash that points at an element on the page ("#main"), not at a route. Routes start with "#/"; an empty hash or "#" is the home route. */
export function isInPageAnchor(hash: string): boolean {
  return hash.length > 1 && !hash.startsWith("#/");
}

function query(params: [string, string | null][]): string {
  const out = new URLSearchParams();
  for (const [k, v] of params) if (v) out.set(k, v);
  const s = out.toString();
  return s ? `?${s}` : "";
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case "check":
      return `#/check${query([
        ["tail", route.tail],
        ["date", route.date],
      ])}`;
    case "visit":
      return `#/visit/${encodeURIComponent(route.id)}`;
    case "report":
      return `#/visit/${encodeURIComponent(route.id)}/report`;
    case "prep":
      return route.visitId
        ? `#/visit/${encodeURIComponent(route.visitId)}/prep`
        : `#/prep${query([
            ["tail", route.tail],
            ["date", route.date],
          ])}`;
    case "visits":
      return `#/visits${query([
        ["status", route.status],
        ["q", route.q],
        ["page", route.page > 1 ? String(route.page) : null],
      ])}`;
    case "layouts":
      return route.id ? `#/layouts/${encodeURIComponent(route.id)}` : "#/layouts";
    case "reference":
      return "#/reference";
    case "notFound":
      return route.hash;
  }
}

export function parseRoute(hash: string): Route {
  const notFound: Route = { name: "notFound", hash };
  if (isInPageAnchor(hash)) return notFound;
  const body = hash.replace(/^#\/?/, "");
  const cut = body.indexOf("?");
  const path = cut === -1 ? body : body.slice(0, cut);
  const params = new URLSearchParams(cut === -1 ? "" : body.slice(cut + 1));
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return notFound;
  }
  const [first, second, third] = parts;
  if (parts.length === 0 || (first === "check" && parts.length === 1)) {
    return { name: "check", tail: params.get("tail") || null, date: params.get("date") || null };
  }
  if (first === "visit") {
    if (!second || !UUID.test(second) || parts.length > 3) return notFound;
    if (parts.length === 2) return { name: "visit", id: second };
    if (third === "report") return { name: "report", id: second };
    if (third === "prep") return { name: "prep", visitId: second, tail: null, date: null };
    return notFound;
  }
  if (first === "prep" && parts.length === 1) return { name: "prep", visitId: null, tail: params.get("tail") || null, date: params.get("date") || null };
  if (first === "visits" && parts.length === 1) {
    const status = params.get("status");
    const page = Number(params.get("page"));
    return {
      name: "visits",
      status: status === "DRAFT" || status === "COMPLETED" ? status : null,
      q: params.get("q") ?? "",
      page: Number.isInteger(page) && page > 1 ? Math.min(page, MAX_PAGE) : 1,
    };
  }
  if (first === "layouts" && parts.length <= 2) return { name: "layouts", id: second ?? null };
  if (first === "reference" && parts.length === 1) return { name: "reference" };
  return notFound;
}
