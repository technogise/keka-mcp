# keka-mcp

A local MCP (Model Context Protocol) server that wraps Keka HR's PSA
timesheet and HRIS APIs, read-only, over stdio. Runs in Docker on your
machine and connects to Claude Desktop (or any MCP client) as a local
stdio server.

This is scaffolding only: seven read-only tools, OAuth token handling, and
pagination. No reporting/analysis logic and no write/POST endpoints - that's
a later phase, driven by prompting Claude against this server.

## Tools

| Tool | Wraps | Notes |
|---|---|---|
| `get_timesheet_entries` | `GET /api/v1/psa/timeentries` | `from`, `to`, `employeeIds`, `projectIds`, `pageSize`. Auto-paginates. Max 60-day range (confirmed against the live sandbox - see below). |
| `get_project_time_entries` | `GET /api/v1/psa/projects/{id}/timeentries` | `projectId` (required), `from`, `to`, `employeeIds`, `pageSize`. Auto-paginates. Max 60-day range (confirmed against the live sandbox - see below). |
| `get_employees` | `GET /api/v1/hris/employees` | `pageSize`. Auto-paginates. |
| `get_projects` | `GET /api/v1/psa/projects` | `pageSize`. Auto-paginates. |
| `get_clients` | `GET /api/v1/psa/clients` | `pageSize`. Auto-paginates. Use to map a project's `clientId` to a readable client/customer name - see "Discovery: how a project maps to its client" below. |
| `get_leaves` | `GET /api/v1/time/leaverequests` | `from`, `to`, `employeeIds`, `pageSize`. Auto-paginates. Max 60-day range, same as the timesheet tools. `status` (0-4) is preserved raw, no label - see the tools table note below. |
| `get_holidays` | `GET /api/v1/time/holidayscalendar/{calendarId}/holidays` | `calendarId`, `calendarYear`, `pageSize`. Auto-paginates. Keka scopes holidays per calendar, not org-wide - if `calendarId` is omitted, this tool first looks up every calendar (`GET /api/v1/time/holidayscalendar`) and fetches + combines holidays from all of them, tagging each with `calendarId`/`calendarName`. Most tenants have exactly one calendar. |

All seven auto-paginate internally (looping `pageNumber` until Keka reports no
more pages) and return the fully combined result set - the MCP client never
has to page itself. `pageSize` only controls the chunk size of each request
to Keka (capped at 200); it does not limit the total number of results returned.

## Setup

```bash
cp .env.example .env
# edit .env with your real client_id / client_secret / api_key / base URL
npm install
npm run build
npm test        # unit tests
npm start        # run directly with Node, without Docker
```

### Required environment variables

See `.env.example` for the full list and descriptions:

- `KEKA_CLIENT_ID`, `KEKA_CLIENT_SECRET`, `KEKA_API_KEY` - from Keka's Global
  admin settings -> Integrations & Automations -> API access -> API key.
- `KEKA_BASE_URL` - your company's data API host, e.g. `https://yourcompany.keka.com`.
- `KEKA_TOKEN_URL` - Keka's OAuth **login** host, e.g.
  `https://login.keka.com/connect/token` for production or
  `https://login.kekademo.com/connect/token` for the demo/sandbox environment.
  **This is a different host from `KEKA_BASE_URL`** and isn't derivable from
  it - see "Open questions" below.

Missing any of these causes a clean fatal error at startup (by design - this
is the one class of failure allowed to stop the process). Every other error
(bad API response, network failure, an unhandled exception inside a tool
handler) is caught and returned to the caller as a normal MCP tool error;
the server process itself keeps running.

## Auth

`src/auth.ts` implements Keka's API-key OAuth exchange
([docs](https://developers.keka.com/reference/token-1)):

1. POSTs `grant_type=kekaapi&scope=kekaapi&client_id=...&client_secret=...&api_key=...`
   (form-urlencoded) to `KEKA_TOKEN_URL`.
2. Caches the returned `access_token` and its expiry in memory, refreshing
   ~60s before it actually expires.
3. If a `refresh_token` comes back, it's cached and used against the same
   token endpoint with `grant_type=refresh_token`
   ([docs](https://developers.keka.com/reference/refresh-token-generate-access-token-using-refresh-token-endpoint))
   on renewal, instead of re-running the full API-key exchange. If the
   refresh call fails (e.g. the refresh token was revoked), it falls back to
   a full API-key exchange automatically. If no `refresh_token` is ever
   returned (Keka's documented example response for this grant type doesn't
   include one), the API-key exchange is simply re-run on expiry.
4. `TokenManager.getValidToken()` is the single entry point every tool call
   goes through; concurrent calls during a refresh are coalesced into one
   outstanding token request.

## Docker

```bash
docker build -t keka-mcp .
docker run --env-file .env keka-mcp
```

Single-stage, pinned base image (`node:22.12.0-bookworm-slim`), TypeScript
compiled at build time, `npm prune --omit=dev` after the build so no
dev-only dependencies ship in the final image, no secrets baked in (`.env`
is excluded via `.dockerignore` - only `--env-file` at `docker run` time
supplies credentials).

**Important:** `docker run --env-file .env keka-mcp` (no `-i`) is fine as a
smoke test - it starts, connects to stdio, logs its ready message, and exits
cleanly when stdin closes. But an actual MCP client (Claude Desktop
included) needs `-i` so Docker attaches the container's stdin/stdout to the
client's pipes - without it, Docker never forwards stdio and the client
can't talk to the server at all. See the Claude Desktop config below.

## Claude Desktop configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "keka": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/absolute/path/to/keka-mcp/.env",
        "keka-mcp"
      ]
    }
  }
}
```

Restart Claude Desktop after editing the config. Use an absolute path to
`.env` since Claude Desktop does not run this command from the project
directory.

## Testing

```bash
npm test
```

Unit tests (`src/__tests__/`, vitest) cover, with no network/Docker
involved:

- **Pagination** (`pagination.test.ts`) - a mocked 3-page response combines
  correctly into one result set, a single-page response doesn't over-fetch,
  and an empty page stops the loop even if `totalPages` implies more. The
  same three cases are repeated against `Client`-, `LeaveRequest`-, and
  `Holiday`-shaped rows (the shapes `get_clients`, `get_leaves`, and
  `get_holidays` use) to cover those tools' pagination specifically, since
  they go through the exact same `paginateAll` helper as every other tool.
- **Date-range validation** (`dateRange.test.ts`) - accepts ranges up to
  and including `MAX_DATE_RANGE_DAYS` (60), rejects longer ranges with a
  message naming the limit and the dates given, rejects `from` after `to`,
  and skips validation when either side is omitted (matching Keka's own
  default-window behavior).
- **Token caching/expiry** (`auth.test.ts`) - reuses a cached token while
  valid, re-runs the API-key exchange on expiry when no `refresh_token` was
  issued, uses the refresh endpoint instead when one was, and falls back to
  a full exchange if the refresh call itself fails.

`scripts/mcp-smoke-test.mjs` is a small standalone script (not part of the
shipped server) that drives the built Docker image as a real MCP client
over stdio - used for the manual verification below and reusable for future
smoke-testing. It's written specifically against **placeholder/dummy**
credentials (it asserts every data call comes back as a clean auth error) -
that's intentional, it's exercising the failure path. It is not the script
used for the real-sandbox run below.

## Verified

Everything below was actually run in this environment, not assumed:

- **Unit tests**: `npm test` - 24/24 passing (pagination x12 - generic +
  `get_clients`-shaped + `get_leaves`-shaped + `get_holidays`-shaped,
  date-range x7, token caching/refresh x5).
- **TypeScript build**: `npm run build` completes with no errors.
- **Docker build**: `docker build -t keka-mcp .` succeeds; final image has
  0 known vulnerabilities after `npm prune --omit=dev` (dev-only
  vulnerabilities in `vitest`'s `esbuild`/`vite` chain do not ship in the
  image).
- **Docker run / stays alive**: `docker run --env-file .env keka-mcp` with
  a complete (dummy-valued) `.env` starts, logs its ready message, and
  exits 0 only when stdin closes - confirmed it does **not** crash or exit
  on its own while stdin stays open (`docker ps` showed `Up` during a 5s
  window with stdin held open).
- **Fatal startup path**: running with required env vars missing produces a
  single clean `FATAL error during startup` log line naming the missing
  vars and exits 1, as designed - confirmed with `KEKA_CLIENT_ID` set alone.
- **MCP protocol handshake, over the real Docker container, via
  `scripts/mcp-smoke-test.mjs`** (a real `@modelcontextprotocol/sdk` `Client`
  spawning `docker run --rm -i --env-file .env keka-mcp`, exactly as Claude
  Desktop would):
  - `initialize` succeeds and `tools/list` returns exactly the 7 expected
    tools: `get_timesheet_entries`, `get_project_time_entries`,
    `get_employees`, `get_projects`, `get_clients`, `get_leaves`,
    `get_holidays`.
  - Calling all 7 tools with dummy credentials against
    `KEKA_TOKEN_URL=https://login.kekademo.com/connect/token`: each
    returned a clean `isError: true` MCP result with message
    `Keka token request failed (HTTP 400): invalid_client` - i.e. Keka's
    real login host was reached and gave a real OAuth rejection (not a
    network failure or a 404), and the server surfaced it cleanly instead
    of crashing or leaking a stack trace to the client. `get_clients`,
    `get_leaves`, and `get_holidays` behave identically to the other four
    here - same auth flow via `getValidToken()`, same error shape.
  - Calling `get_timesheet_entries` with `from=2026-01-01, to=2026-12-01`
    (334 days) returned `isError: true` with a message naming the limit
    and the dates given, **without ever making a network call** (the
    validation runs before the Keka client is touched). The smoke test
    script now asserts the message names the *60-day* limit (updated to
    match the discovery below - it had been left asserting the original
    90-day spec value, which no longer matched the code).
  - The container process was still alive and responsive after all 8 of
    the above calls, including the 7 induced failures - confirming a failed
    tool call does not take the process down.

### Live sandbox run (real credentials, `docker run --env-file .env keka-mcp` via a real MCP client over stdio)

Once real values were in `.env`, I ran the tools end-to-end against the
real sandbox tenant (never printing the credential values themselves) -
five in the original run, `get_leaves` and `get_holidays` each added and
verified in later sessions:

- **Auth**: real API-key exchange succeeded against `KEKA_TOKEN_URL`,
  returned a token with `expires_in: 86400`, no `refresh_token` (matches
  the documented response shape and the "no refresh token yet" you told me
  up front).
- **`get_timesheet_entries`** (`from=2026-06-01, to=2026-06-15`, no
  filters): `isError: false`, **958 records across 10 pages** (default
  page size 100) - confirms pagination actually loops across a real
  multi-page dataset, not just the mocked unit test.
- **`get_project_time_entries`** with a real project ID pulled from
  `get_projects` (`NotificationHub`, `046a855d-cedf-4aa4-bb73-fd2e9053296a`):
  `isError: false`, 31 entries, all correctly scoped to that `projectId`.
- **`get_projects`**: `isError: false`, **112 projects across 2 pages** -
  a second confirmation of real multi-page pagination.
- **`get_employees`**: initially `isError: true` with a real 403 from Keka
  (`"You don't have privilege to access this resource."`) - not a code bug,
  the API key lacked an HRIS/employees scope grant. After you added that
  privilege on the tenant, re-ran it: `isError: false`, **237 employees
  across 3 pages** - a third confirmation of real multi-page pagination.
  (A later re-run for the `get_clients` addition below showed 238, i.e. one
  new employee was added to the tenant between sessions - not a bug.)
- **`get_clients`** (added for this task): `isError: false`, **47 clients**.
  At the default `pageSize=100` all 47 fit on one page; re-ran with
  `pageSize=10` to force multi-page pagination and got the same 47 records
  combined correctly across **5 pages**, matching page-by-page against the
  raw API response with no duplicates or drops - a fourth confirmation of
  real multi-page pagination.
- **`get_leaves`** (added later, wraps `GET /time/leaverequests`):
  `isError: false` on the first try, no extra privilege grant needed
  (unlike `get_employees`) - **294 leave requests across 3 pages**, a fifth
  confirmation of real multi-page pagination.
- **`get_holidays`** (added later, wraps `GET /time/holidayscalendar` +
  `GET /time/holidayscalendar/{calendarId}/holidays`): `isError: false` on
  the first try, no extra privilege grant needed - the tenant has exactly
  one calendar (`"Holiday List"`), and calling with no `calendarId`
  correctly auto-discovered it and returned **21 holidays for
  `calendarYear=2026`** in a single page, each tagged with the right
  `calendarId`/`calendarName`. Only one calendar meant this didn't exercise
  the multi-calendar combine path, but the per-calendar pagination is the
  same `paginateAll` proven five times over already, and the calendar
  lookup call and the holidays call are each single, unremarkable GETs -
  the last of the seven tools proven end-to-end.
- **Invalid-input handling**:
  - Out-of-range dates (`from=2026-01-01, to=2026-12-01`, 334 days):
    `isError: true` with the 90-day message, and (confirmed via the tool
    call being logged before any Keka request would appear) rejected
    client-side without ever calling the API.
  - A bad/nonexistent `employeeIds` value: **not an error** - Keka treats
    it as a filter that matches nothing and returns `totalRecords: 0`
    rather than a 4xx. That's Keka's own behavior (same as an unknown
    `projectId`, which also just returns 0 rows), not something this
    server should override.
- **Process resilience**: the container stayed alive and kept answering
  correctly through all of the above, including the two induced failures.

**Partially open**: every one of the 958 timesheet entries pulled in that
window had `status: 2`. That's consistent with `2 = Approved` (the mapping
this code assumes) but doesn't exercise the other five values - I have not
seen a real `0/1/3/4/5` entry to confirm the full ordering. Still flagging
this per "Open questions" below rather than calling it verified.

### Discovery: the real date-range limit is 60 days, not 90

While probing for entries with a non-`Approved` status, a 90-day-wide
request (`from=2025-12-01, to=2026-02-28`) came back from Keka itself with
`HTTP 400: "Total days should not exceed more than 60 days"` - not a rate
limit, not our own validation (a genuine content error from the API). That
contradicts both the task spec and Keka's own public API reference, both of
which say 90. **`MAX_DATE_RANGE_DAYS` was changed to 60** to match what the
live sandbox actually enforces (unit tests and tool descriptions updated to
match, Docker image rebuilt) - you confirmed this rather than keeping the
spec's original 90. If a different tenant/plan really does get 90 days,
that's the one constant to change back.

### Discovery: how a project maps to its client

Checked the real response shape of `get_projects` against the sandbox
specifically to confirm this: each project object has a **flat, top-level
`clientId` field** (a plain UUID string) - not a nested `client.id` or a
`client` object. Example from the live sandbox:

```json
// GET /api/v1/psa/projects
{ "id": "046a855d-...", "name": "NotificationHub", "clientId": "c0a7cc1a-be9b-4211-8b93-0cc1b004158a", ... }
```

That `clientId` is exactly the `id` field on the corresponding object
returned by `get_clients`:

```json
// GET /api/v1/psa/clients
{ "id": "c0a7cc1a-be9b-4211-8b93-0cc1b004158a", "name": "Technogise", "billingName": "Technogise", "code": "Technogise", ... }
```

Confirmed by fetching all 47 clients from the live sandbox and looking up
`NotificationHub`'s `clientId` (`c0a7cc1a-...`) by exact match against each
client's `id` - it resolved to a real client (`"Technogise"`), not a miss.
So the mapping for reporting is simply `project.clientId === client.id`,
no nesting or extra lookup involved. `get_clients` objects also carry
`billingName`, `code`, `description`, `billingAddress`, and
`clientContacts` beyond the bare `name`, in case those are useful later.

### Discovery: Keka enforces a 50 API-calls/minute quota

Repeated testing (pulling the 958-entry / 10-page dataset, the 112-project
/ 2-page dataset, the 237-employee / 3-page dataset, plus several probe
calls) tripped Keka's own rate limiter: `"API calls quota exceeded! maximum
admitted 50 per 1m."` This surfaces cleanly as an `isError: true` result
(`KekaApiError`, labeled "Rate limited by Keka - back off and retry
later") rather than a crash, so no code change was needed here - but it's
worth knowing for the next phase: a single `get_timesheet_entries` call
over a wide range can itself cost 5-10+ underlying HTTP calls once
pagination kicks in, so a handful of broad tool calls in quick succession
can exhaust the budget for the rest of that minute (and in this session,
the quota stayed exhausted for several minutes rather than clearing after
60s, so the reset window may be longer than 1 minute in practice, or the
quota may be shared with other integrations on the same tenant). Nothing to
fix now, since it's out of scope for this task, but the reporting/analysis
phase should batch and pace its calls with this in mind.

## Open questions for you (flagging rather than guessing)

- **`status` field shape mismatch**: the task described
  `get_timesheet_entries`'s per-entry `status` as a string enum
  (`UnSubmitted`, `Submitted`, `Approved`, `Rejected`, `InApprovalProcess`,
  `Invoiced`). Keka's own API reference for `/psa/timeentries` documents
  `status` as an **integer, 0-5**, with no explicit label mapping given.
  The code preserves the raw integer from the API unmodified (as required)
  and adds a `statusLabel` field using the order you listed
  (0=UnSubmitted ... 5=Invoiced) as a best-effort guess. The live sandbox
  run confirmed `2 → Approved` is at least plausible (958/958 entries in
  the tested window were `status: 2`, all approved-looking data), but every
  entry pulled had the same value, so the other five haven't been seen in
  practice. Confirm the full ordering with Keka (or point me at an entry
  with a different status) before relying on `statusLabel`.
- **`KEKA_TOKEN_URL` is a new required env var**, not in your original list.
  Keka's docs show the OAuth token endpoint lives on a separate `login.*`
  host (e.g. `login.keka.com`, `login.kekademo.com`) from the company data
  API host in `KEKA_BASE_URL` - there's no way to derive one from the other,
  so it's a separate, explicit setting. **Resolved**: your sandbox uses
  the value now in `.env`, confirmed working against the live token
  exchange.
- **`get_employees` 403** - **resolved**. It was an HRIS/employees scope
  missing on the API key; you granted the privilege on the tenant and a
  re-run confirmed 237 employees across 3 pages. No code change was needed.
- **`get_leaves`'s `status` field (0-4) has no label mapping at all** -
  unlike timesheet status, you never gave an expected enum for leave
  requests, and Keka's own reference doesn't publish one either ("specific
  meanings not provided"). Unlike `timeEntries.ts`, `leaves.ts`
  deliberately does **not** add a guessed `statusLabel` - the raw integer
  is passed through as-is. If you know the mapping (something like
  Pending/Approved/Rejected/Cancelled plus one more), let me know and I'll
  add it the same way.

## Project structure

```
keka-mcp/
  src/
    auth.ts            # OAuth token fetch + refresh (TokenManager)
    dateRange.ts        # date-range validation, shared by both timesheet tools
    kekaClient.ts        # HTTP wrapper: base URL, auth header, pagination helper
    tools/
      helpers.ts         # shared error handling / logging / JSON result wrapper
      timeEntries.ts      # get_timesheet_entries, get_project_time_entries
      employees.ts        # get_employees
      projects.ts         # get_projects
      clients.ts          # get_clients
      leaves.ts           # get_leaves
      holidays.ts          # get_holidays
    index.ts            # MCP server entrypoint, registers all tools
    __tests__/           # vitest unit tests
  scripts/
    mcp-smoke-test.mjs   # manual end-to-end stdio smoke test (see "Verified")
  Dockerfile
  .env.example
  package.json
  tsconfig.json
```
