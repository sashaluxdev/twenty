# DRAFT — not filed. Upstream issue for twentyhq/twenty

> Deliverable of the `writeissue` skill run on 2026-07-21. Read-only research only; nothing was posted to GitHub. The human reviews and files. The body below conforms to the repo's `report-bug.md` template.

---

## Title

App front-component bundles re-download on every mount

---

## Bug Description

Every time an installed app's front component renders, the platform spawns a fresh Web Worker that fetches the built bundle from `GET /rest/front-components/:id?checksum=…`. The server redirects to a **freshly signed S3 presigned URL on every request**, and the response carries `cache-control: private, no-store`. Because the URL's signature changes on every call, the browser can never get a cache hit — even though the request already carries a content-addressing `?checksum` param. So each widget mount (and each tab reopen, which spins up a new worker with a cold cache) re-downloads the full bundle.

The impact is large on cloud workspaces far from the origin region. On an EU-hosted cloud workspace accessed from East Asia, a 588 KB widget bundle takes **1.8–2.1 s per mount** to download from S3 (connect ~0.26 s, TTFB ~0.8–0.9 s), on top of ~0.3 s for the `/rest/front-components/:id` redirect itself. A well-optimized widget therefore cannot open in under ~2.5 s on a far-from-origin workspace, no matter how few queries it makes — the fixed cost is the uncacheable bundle.

Observed response headers on the bundle fetch (signature redacted):

```
cache-control: private, no-store
content-type: application/javascript
# 302 redirect target is a presigned S3 URL with:
#   X-Amz-Expires=900
#   X-Amz-Signature=<unique per request — redacted>
# bundle body: 588,084 bytes
```

<!-- attach network-panel.png — DevTools Network waterfall showing the bundle re-downloaded on two consecutive tab opens with no 304/from-cache -->

## Steps to Reproduce

1. On a cloud workspace, install an app that ships a front component (widget/tab).
2. Open DevTools → Network and open the widget's tab.
3. Note the `GET /rest/front-components/:id?checksum=…` request and the S3 bundle download that follows.
4. Close the tab and open it again.
5. Observe the bundle is downloaded in full again — no `304`, no `(from disk cache)` — and the request headers show `cache-control: private, no-store` with a different `X-Amz-Signature` on the redirect target.

## Expected behavior

Because the bundle is content-addressed by `checksum`, a re-mount or tab reopen with an unchanged checksum should serve from cache (a fast `304` or `from cache`) rather than re-downloading the full bundle.

## Technical inputs

- `front-component.controller.ts` (`getBuiltJs`) redirects to the presigned URL; `set-file-response-headers.utils.ts` sets only `Content-Type`, `nosniff`, and `Content-Disposition` — no `Cache-Control`.
- `front-component.service.ts` (`getBuiltComponentPresignedUrlOrThrow`, ~L328) mints a new signed URL each call (`STORAGE_S3_PRESIGNED_URL_EXPIRES_IN`), so the redirect target is never byte-stable and defeats HTTP caching even though `getFrontComponentUrl.ts` already passes the checksum as a query param.
- Client side, each mount fetches the bundle in a fresh worker (`remote-worker.ts` `fetchComponentSource`), and the worker is terminated on unmount (`FrontComponentWorkerEffect.tsx`), so there's no in-memory reuse across mounts either — making the HTTP cache the only line of defense.
- Possible fix directions (maintainers' choice): serve the bundle with `Cache-Control: public, max-age=31536000, immutable` keyed on the checksum — either by proxying the bundle body through the controller with those headers instead of a per-request signed redirect, or by redirecting to a stable, cache-friendly CDN URL. The `?checksum` already provides a safe cache key.

**Version / deployment:** current `main`; observed on a hosted cloud workspace (EU region) with the client in East Asia, 2026-07-21.

---

## Filing notes (for the human — not part of the issue body)

- **Template matched:** `.github/ISSUE_TEMPLATE/report-bug.md` → auto-labels `type: bug`. Used its exact headings (`## Bug Description`, `## Expected behavior`, `## Technical inputs`) and added `## Steps to Reproduce` + a version/deployment line, which the strong accepted bugs here (#8962, #13250) include.
- **Maintainer patterns mirrored:** sentence-case symptom-first title (~7 words); short factual lead (no hedging, no AI-essay tone); a redacted evidence block in place of speculation; `## Technical inputs` names specific files + a concrete hypothesis and presents the fix as *options*, not a prescribed patch — the profile flags deep root-cause+patch essays (#21549) as argued-down. Triagers to expect: Weiko / charlesBochet / ehconitin (backend/infra); Bonapara may spec it further.
- **Screenshot — REQUIRED before filing.** Screenshots are non-negotiable in this repo, and `gh` cannot upload images. Capture the DevTools Network waterfall showing the bundle re-downloaded on two consecutive tab opens (no 304 / from-cache), redact any signed-URL query string, and drag it in via the GitHub web "New issue" form (which also loads the template + label). A second annotated shot of the `cache-control: private, no-store` response headers strengthens it.
- **Local-vs-cloud capture caveat (verified 2026-07-21 on the local dev stack):** locally the bundle request returns a plain `200` streaming the JS — **no `cache-control` header at all, no `302` → S3 presigned redirect** (local storage driver). A local screenshot therefore proves the re-download-on-every-mount defect (both opens full-download, nothing from cache) but CANNOT show `private, no-store` or the `X-Amz-Signature` churn described in the body — those are cloud-only. Either capture on a cloud workspace, or pair a local waterfall shot with the verbatim cloud headers block already in the body and say which is which. Capture recipe (local): record page `/object/company/20202020-aa7c-45db-9d28-e9cdc97e1b77` → Variations tab, DevTools Network filtered to `front-components`, open the tab twice.
- **Redaction done:** no customer workspace/instance URL named (described generically as "EU-hosted cloud workspace, client in East Asia"); no tokens; presigned-URL signature redacted. Keep it that way when filing.
- **Repro honesty:** the "reproduce first" step is satisfied by the 2026-07-21 measurements from a real EU cloud workspace, not a fresh local run — the body states observed facts only, no fabricated repro.
- **Secondary asks deliberately SPLIT OUT, not bundled.** This repo rewards one confirmed defect scoped small. Two adjacent inefficiencies were left out of the body and should be separate issues *if* worth filing: (1) worker creation is gated on the sdk-client blob fetch although the SDK URLs are only needed after the bundle is fetched (`remote-worker.ts`); (2) `/rest/sdk-client/:appId/{core,metadata}` re-downloads and unzips the app archive on every request (`sdk-client-archive.service.ts`). Do not append these to this issue — bundling would dilute the ask and invite scope debate.
- **Labels to request:** `type: bug` (auto). Optionally suggest a `scope: backend` / performance label in the first comment; do not self-apply.
- **Venue:** main repo `twentyhq/twenty` — this is a confirmed backend defect, not a roadmap/feature ask, so it does not belong in `twentyhq/core-team-issues`. Search open issues for "front-component" / "presigned" / "cache-control" duplicates before filing.
