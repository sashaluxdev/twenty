# Override marker arc: Task 0 platform probe results

Probed 2026-09-03 against a fresh local 2.35.0 seed (workspace "Apple"), formula-field 0.5.1 installed via `dev --once -r dev`. Attempt 1 the same day was inconclusive because the local database was four minor versions behind the server code; the database was reset before attempt 2.

- **P1 PASS** (2026-09-03): app-token `createOneField` succeeded from a temporary cron logic function using `MetadataApiClient`. `core.fieldMetadata` shows `company.fxOverrides`, label `Overrides`, type TEXT, `isUIEditable = false`, `isActive = true`. Note: the created field's `applicationId` is the workspace "Custom" application, not the Formula Field application, so an app uninstall does not remove it (same attribution as the wizard-created value fields).
- **P2 PASS, case (a)** (2026-09-03): on the Google company record page the `Overrides` field appears directly in the Fields card with no user reveal needed (not in a hidden-fields section). (c) held: the field cell is rendered disabled, and a click attempt times out with "element is not enabled", while an ordinary TEXT field (Tagline) opens an editor on click.
- **P3 PASS** (2026-09-03): from the authenticated page context (user Bearer token from the front's `tokenPairState`), `updateCompany(id, data: { fxOverrides: "probe" })` on http://localhost:3000/graphql returned `fxOverrides: "probe"`; a follow-up read confirmed it; resetting with `fxOverrides: null` returned `fxOverrides: ""` (TEXT null normalizes to blank, ADR 0030).

Consequences for the plan: no fallbacks triggered. The §5.1 front-side creation fallback is not needed, Task 9's user-token widget write is viable, and README wording for Task 10 can say the field appears in the Fields card without a reveal step.

Cleanup: probe function deleted and the app redeployed so the probe cron is gone; the probe field on Company was deactivated and deleted after the probes so Task 11's live checklist observes lazy creation.
