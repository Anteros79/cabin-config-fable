# Security

Cabin Kit is a fictional home-lab demonstration. It is not an approved maintenance authority and holds no real aircraft data.

## Threat model

- The server listens on the loopback interface only (`127.0.0.1`). Do not expose it to a network.
- There is no authentication and no user accounts. Anyone who can reach the port can read and write visits.
- Data is stored in a local SQLite file under `data/`. Stored snapshots, reports and events are immutable.

## Host and Origin checks

Every request, whatever its method, is checked first.

- **Host.** The `Host` header's host name (port ignored, lower-cased, `[::1]` handled) must be `localhost`, `127.0.0.1`, `::1`, the configured listen host (`CABIN_KIT_HOST`) or a name in `CABIN_KIT_ALLOWED_HOSTS` (comma-separated). Anything else, or a missing or malformed `Host`, is refused with 403 `HOST_NOT_ALLOWED`. This closes DNS rebinding, where a hostile page re-points its own name at `127.0.0.1` and then talks to the API as if it were same-origin.
- **Origin, on writes.** For every method other than GET and HEAD, an `Origin` header must be a parseable `http` or `https` origin whose host name and effective port equal those of `Host`. A missing port means the scheme default (80 or 443), so `http://localhost` matches `localhost:80`. `Origin: null`, an unparseable value or any mismatch is refused with 403 `CROSS_ORIGIN_WRITE`.
- **Sec-Fetch-Site, on writes.** If sent, it must be `same-origin` or `none`. `same-site` and `cross-site` are refused with 403 `CROSS_ORIGIN_WRITE`.
- **No `Origin` and no `Sec-Fetch-Site`** (for example curl) is allowed. These checks defend against browsers, not against other local programs.

Refusals use the standard error envelope with `details: null`. Binding to a non-loopback address still exposes an unauthenticated API; the Host list does not change that.

## Reporting a problem

Open a private security advisory on the GitHub repository, or contact the maintainer directly. Please include the version or commit, steps to reproduce, and the impact you expect. Do not post details in a public issue until a fix is available.
