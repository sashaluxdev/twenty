# Cloud widget load — live-measured evidence (2026-07-21)

Status: DIAGNOSIS. Supersedes the latency assumptions in
`2026-07-17-widget-load-perf.md` — v0.1.9 shipped that plan's 7 tasks, and the user
reports cloud tab-open is still ~5–7s. This doc records what was actually measured on
the hosted instance and the confirmed request chain, as input to the v0.1.10 plan.

## Measurements (curl against luxurique.twenty.com, 2026-07-21 ~05:40 UTC)

Client near a Tokyo Cloudflare edge (`cf-ray *-NRT`); origin + S3 in eu-central-1.

| Probe | Result |
|---|---|
| TCP connect / TLS to edge | ~15ms / ~30ms |
| `POST /graphql` `{ __typename }` (unauthed) | TTFB ~0.27–0.32s, outlier 0.81s |
| `GET /` (static index.html, 36KB) | TTFB ~0.30–0.32s |
| `POST /client-config` | ~0.27–0.75s |
| `GET /rest/front-components/:id` (authed) | ~0.31s, returns 2KB JSON `{url: <presigned S3>}` with `cache-control: private, no-store`; presigned URL is freshly signed per request (unique query string, 900s expiry) |
| S3 bundle download (variation-widget.mjs, 588,084 bytes, direct from `s3.eu-central-1.amazonaws.com`) | **1.79s / 2.05s / 2.06s** (connect ~0.26–0.30s, TTFB ~0.79–0.93s) |
| Authed `POST /graphql` `formulaDefinitions(first:3)` | 0.31 / 0.31 / 0.31 / 0.40 / 0.75s |

Takeaways:

- **~300ms server floor on every request** (edge→origin long haul + origin processing);
  regular outliers at ~0.75–0.8s. Local dev pays ~10ms — this is the entire reason the
  problem is invisible locally.
- **The widget bundle is uncacheable by construction**: `no-store` on the JSON, and the
  S3 URL changes every call (fresh signature), so the browser can never produce a hit
  even though the request URL carries `?checksum=…`. Fresh worker per mount ⇒ ~2s paid
  on EVERY tab open, first or remount.

## Confirmed request chain (code trace of current main, v0.1.9)

Full leg-by-leg table with file:line: `2026-07-21-widget-chain-trace.md`; summary:

First open = **8 sequential floor legs**, remount = **6**:

| # | Leg | Remount |
|---|-----|---------|
| H1 | `FindOneFrontComponent` (`FrontComponentRenderer.tsx:67`, no fetchPolicy ⇒ Apollo **cache-first**) | 0 (cache) |
| H2 | sdk-client core+metadata, 2 fetches in parallel (`fetchSdkClientBlobUrls.ts:30`); **gates worker creation** (`FrontComponentRendererWithSdkClient.tsx:46`) though the worker needs the URLs only after the bundle fetch (`remote-worker.ts:128`). Server unzips the app archive per request (`sdk-client-archive.service.ts:99-113`) | 0 (jotai session state) |
| H3 | Bundle: worker `fetchComponentSource` → `/rest/front-components/:id?checksum` → 302 fresh-presigned S3 (`front-component.controller.ts:48`, `front-component.service.ts:328-338`) | **1 (~2s)** |
| A1 | enabled VariationConfig scan (`variation-widget.tsx:110`) | 1 |
| A2 | host-resolution probes, parallel per candidate object (`variation-widget.tsx:124`); worker-local cache cold every mount | 1 |
| A3 | role pointer read (`variation-widget-data.ts:111`) — re-reads the record A2 already touched | 1 |
| A4 | metadata catalog pull (`metadata-objects.ts:148`), 60s worker-local cache cold every mount | 1 |
| A5 | `Promise.all`: formula scan ∥ overrides ∥ variation records (`variation-widget-data.ts:323`) | 1 |

Arithmetic: 8 × ~0.31s + ~2s bundle ≈ 4.5–6.5s first open; 6 legs ≈ ~4s remount.
Matches the reported 5–7s. **Why v0.1.9 didn't help:** all three v0.1.9 caches
(host-resolution, metadata TTL, formula-scan) are worker-module-global, and the platform
terminates + recreates the worker every mount (`FrontComponentWorkerEffect.tsx:67-147`),
so they start cold on every tab open and only benefit the in-mount 4s poll.

Corrections to the 2026-07-17 diagnosis: H1 is cache-first (NOT cache-and-network);
the "8–12 sequential GraphQL legs" was an overcount — it's 5 app-side sequential legs
(with internal parallel fan-out).

## Fix menu (ranked)

App-side (v0.1.10 candidates — see the v0.1.10 plan when written):
1. Merge A3 into A2 (probe also selects the relation id) — −1 leg every open.
2. Get the host record's object into the widget → kills A2 — mechanism TBD by discovery
   (execution context contents vs per-placement config).
3. Parallelize A5b (overrides) with A4 (metadata).
4. Shrink the 588KB bundle (~1s of the ~2s is raw download).

Platform-side (upstream twentyhq/twenty candidates; issue draft in
`docs/upstream/`):
- `Cache-Control: public, immutable` on the checksum-keyed bundle route (+ stable
  redirect target or proxied body) — kills the ~2s H3 on every remount.
- Don't gate worker creation on sdk-client blob fetch — overlaps H2 with H3.
- Server-side sdk-archive extraction cache (minor: 2/session).

## Method notes

- Browser-level waterfall on cloud was NOT captured: Playwright profile has no session
  and the instance is Microsoft-SSO-only; user on WSL cannot drive the GUI. Decision
  2026-07-21: proceed on curl + trace evidence.
- Auth for curl probes: Twenty CLI OAuth access token for remote `cloud`
  (refresh via `remote:status -r cloud`). Read-only queries only.
