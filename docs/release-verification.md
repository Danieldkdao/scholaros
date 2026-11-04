# Whole-product release verification

## Status and authority

This is an executable release matrix and handoff template, not a product pass report. It is generated from the revision-1 master-plan requirement matrix and global-rule inventory; every product requirement and global rule remains `blocked` until the whole-product integration/verification worker records evidence on the exact combined HEAD.

- Current packet branch: `feat/scholaros-build/r1/p32-release-evidence`.
- Accepted packet base: `3f503e941e35c08ad6b3920da3b0c2ddbaf1b4df`; the packet commit is recorded in the Kanban receipt and is not the combined tested HEAD.
- Required integration branch/worktree: `feat/scholaros-complete-product` at `/Users/danieldao/Desktop/scholaros/.worktrees/scholaros-complete-product`.
- `tested_head_sha: null` deliberately means no whole-product exact-head verification is claimed yet.
- Every required software check is blocking until it has actually passed; a code packet receipt, skipped test, planned GUI journey, or source/config inspection is not a pass.
- Update the embedded manifest only from actual command/journey outputs. Keep test logs and private screenshots outside the public repository; the controller’s final receipt must point to existing evidence files.

The `text` and `source` fields preserve the original global-rule inventory for traceability. If a row has `workflow_override`, that current whole-product override is authoritative over historical wording; in particular, the current workflow has no Reviewer stage, uses `autoReview: []`, and permits exactly one controller-owned Apex request. Never trigger that review from a worker.

The Greptile audit found one configuration file (`.greptile/config.json`) and no nested `.greptile` overrides. The effective root configuration is `autoReview: []`, update/draft triggers disabled, `effort: "apex"`, and `statusCheck: true`; this packet has not requested or triggered any review.

Opt-in packaged-test commands compile `VITE_API_URL=http://127.0.0.1:39787`; the build rejects non-loopback origins, the runtime marker must match the bound test endpoint, and the harness owns a loopback 404 sink that requires zero requests, so never substitute a production endpoint. `RUN_PACKAGED_PRODUCT_INSPECTION=1` reads actual fuses/resources without launching Electron; runtime smoke uses a disposable profile and never approves or bypasses OS authentication prompts.

## Organizer source check (2026-11-03)

The [official Meta Global AI Developer Hackathon page](https://events.cerebralvalley.ai/e/meta-ai-developer-hackathon), checked November 3, 2026, lists submissions due November 4, 2026 at 9:00 PM ET and says selected participants must accept Official Rules. Its public text does not expose those detailed rules. The linked [event waiver](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) returned only a `Loading...` shell; no sign-in was attempted, so detailed video, repository-visibility, and submission/IP-rights terms remain unverified. No submission or external publication was made.

## Required heavy-check command matrix

| ID   | Check                                                      | Command / journey                                                                                                                                                                                                                                                                     | Initial state | Blocking |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------- |
| C001 | whole-product integration harness                          | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop test tests/whole-product.integration.test.ts`                                                                                                             | blocked       | true     |
| C023 | probe-enabled packaged test build                          | `VITE_API_URL=http://127.0.0.1:39787 SCHOLAROS_PACKAGED_RUNTIME_PROBE=1 /opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop package`                                                                           | blocked       | true     |
| C024 | packaged base-runtime smoke                                | `VITE_API_URL=http://127.0.0.1:39787 RUN_PACKAGED_PRODUCT_INSPECTION=1 RUN_PACKAGED_PRODUCT_SMOKE=1 /opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop test tests/packaged-product.integration.test.ts`       | blocked       | true     |
| C002 | packaged-product integration harness                       | `VITE_API_URL=http://127.0.0.1:39787 RUN_PACKAGED_PRODUCT_INSPECTION=1 RUN_PACKAGED_PRODUCT_INTEGRATION=1 /opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop test tests/packaged-product.integration.test.ts` | blocked       | true     |
| C003 | desktop tests                                              | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop test`                                                                                                                                                     | blocked       | true     |
| C004 | services tests                                             | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/services test`                                                                                                                                                    | blocked       | true     |
| C005 | web tests                                                  | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/web test`                                                                                                                                                         | blocked       | true     |
| C006 | desktop typecheck                                          | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop typecheck`                                                                                                                                                | blocked       | true     |
| C007 | services typecheck                                         | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/services typecheck`                                                                                                                                               | blocked       | true     |
| C008 | web typecheck without Next typegen side effects            | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/web exec tsc --noEmit`                                                                                                                                            | blocked       | true     |
| C009 | UI typecheck                                               | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/ui typecheck`                                                                                                                                                     | blocked       | true     |
| C010 | workspace lint                                             | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm lint`                                                                                                                                                                                 | blocked       | true     |
| C011 | workspace format check                                     | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm format:check`                                                                                                                                                                         | blocked       | true     |
| C012 | web production build                                       | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/web build`                                                                                                                                                        | blocked       | true     |
| C013 | desktop package build                                      | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop package`                                                                                                                                                  | blocked       | true     |
| C014 | Drizzle migration lineage check                            | `/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop exec drizzle-kit check`                                                                                                                                   | blocked       | true     |
| C015 | read-only Schoology repeat-refresh comparison              | `Focused real-session journey; record identities, counts, requests, successful route reuse/repairs, timing, coverage, and freshness without changing LMS data.`                                                                                                                       | blocked       | true     |
| C016 | actual configured Meta model/capability smoke              | `Use existing authorized configuration only; record model/endpoint category and bounded counters, never keys or academic content.`                                                                                                                                                    | blocked       | true     |
| C017 | full desktop/web and cross-feature GUI journeys            | `Acquire /Users/danieldao/.hermes/locks/gui-testing.lock for the complete scenario; use fixture data for destructive cases.`                                                                                                                                                          | blocked       | true     |
| C018 | actual packaged Electron isolation and runtime assets      | `Run the packaged-product harness against the integrated .app; inspect fuse wire and verify real activity, PDF, Stagehand, SDK, worklet and offline state paths.`                                                                                                                     | blocked       | true     |
| C019 | Windows hardware verification                              | `Run docs/windows-verification.md on the actual Windows laptop; macOS results do not satisfy this check.`                                                                                                                                                                             | blocked       | false    |
| C020 | official hackathon rules, waiver and submission guide      | `Read the complete organizer terms, waiver and submission guide before preparing any external submission; do not sign in or accept terms on the user’s behalf.`                                                                                                                       | blocked       | false    |
| C021 | public-launch privacy, consent and provider-terms approval | `Human legal/privacy review of child-data, education-record, provider terms, consent and regional obligations; no engineering test is a legal certification.`                                                                                                                         | blocked       | false    |
| C022 | signing/notarization/distribution                          | `Verify the actual signed/notarized output and required CI/GitHub state for the intended distribution channel.`                                                                                                                                                                       | blocked       | false    |

All expensive suites, typechecks, builds, and Electron processes use the four-slot `heavy_check.py` wrapper. For opt-in integration tests, set the environment variable before the wrapper. The shared desktop lock is held across the entire GUI scenario; never take over another owner’s lock.

## Cross-feature journey index

| Section | Scope                                                                  | Required evidence                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| J01     | persistence, identity, coverage, suppression, Schoology repeat refresh | Actual migrated fixture DB, FTS/search behavior, source coverage/revision races, plus read-only Schoology evidence when authorized.                                      |
| J02     | Context, uploads, extraction and citations                             | Real note/file import, bounded DOCX/PDF/image extraction, blank-page locators, uncertainty, current/historical source lifecycle, restart and removal.                    |
| J03     | grades and cumulative integrity                                        | Default-off consent, zero/pass-fail/unknown/reopened fixtures, revocation races, active-answer attacks across turns/sessions/artifacts/previews/memory.                  |
| J04     | sessions, history, timers and deletion                                 | Five activities, single-course scope, draft/turn idempotency, timer expiry/extension, offline restore, deletion fences and retained-item lifecycle.                      |
| J05     | tutor and conversation                                                 | Real configured Meta/Schoology journey, bounded inputs, citations, no fallback, stop/retry/offline and shared UI accessibility.                                          |
| J06     | activity isolation and offline state                                   | Actual packaged Electron fuses/process, OS process boundary, network/file/WebRTC/message attacks, functional graph/science/input and same-state inline/expanded restore. |
| J07     | practice, memory, progress and Today                                   | Quiz/exam/guided states, alternative/uncertain answers, evidence-backed memory and recommendations, grade revoke invalidation.                                           |
| J08     | dictation                                                              | Actual Meta realtime relay and microphone/worklet partial/final/stop/cancel with typed draft preservation; OS permission remains user-controlled.                        |
| J09     | settings, device replacement and notifications                         | Autosave failure recovery, candidate browser rollback, new-device setup, opt-in permission, dedupe, quiet hours, focus and account-safe routing.                         |
| J10     | packaging, demo, Windows, organizer rules and privacy                  | Test-owned packaged Mac service and assets, reproducible source-cited demo, Windows hardware checklist, official event terms and human legal/consent gates.              |

## Current external and hardware gates

- **Organizer terms:** The [official Meta event listing](https://dev.meta.ai/events/global-hackathon) displayed a November 4, 2026, 9:00 PM ET submission deadline on November 3, 2026, and stated that official rules are to be published before October 26 and accepted by selected participants. Its linked [Application Overview and Event Waiver](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) returned only `Loading...` in web retrieval and a `Sign In` / `Loading...` shell in browser inspection. The complete rules, waiver, video/repository/rights requirements remain unverified. No sign-in, terms acceptance, submission, or publication was performed.
- **Windows:** This packet is running on macOS. The separate checklist records source review only; only a real Windows laptop run can close the hardware gate.
- **Privacy/legal:** `docs/privacy-launch-review.md` records topics for qualified human review, not compliance certification. Product choice of no age gate is not evidence that child-data or education-record duties are inapplicable.
- **Signing/notarization and OS grants:** Package resource tests do not establish a signed/notarized distributor build or grant microphone/notification permissions. Record the actual named certificate, permission action, or blocking status without exposing secrets.

## Evidence manifest

The embedded JSON is intentionally pre-integration. Its rows include a `status`, `evidence_paths`, `blocking`, and `reason` field for each F01–F13 requirement/acceptance criterion and each G001–G126 global rule. Replace blocked rows only after the actual integrated checks run.

<!-- release-evidence-manifest:begin -->

````json
{
  "schema": 1,
  "run": "scholaros-full-product",
  "revision": 1,
  "integrated_branch": "feat/scholaros-complete-product",
  "integrated_worktree": "/Users/danieldao/Desktop/scholaros/.worktrees/scholaros-complete-product",
  "tested_head_sha": null,
  "requirements": {
    "F01-R01": {
      "text": "Continue the existing feat/context implementation, including navigation knowledge, material/PDF storage, decision/inout browser modes, identity/retirement handling and the watcher. Inventory what is complete, partial, failing and untested before changing it; do not rewrite functioning systems.",
      "source": "docs/master-plan.md#f01-r01",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p02-identity-suppression",
        "p04-destination-coverage",
        "p06-refresh-task-truth",
        "p15-app-boundaries"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-R02": {
      "text": "On first discovery record observed course destinations and resource locations with account/course/purpose evidence. On later refresh reuse verified destinations, repair changed routes and report sign-in needs. A cache miss must not become false empty success.",
      "source": "docs/master-plan.md#f01-r02",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p03-protected-browser",
        "p04-destination-coverage",
        "p05-material-versioning",
        "p06-refresh-task-truth",
        "p10-model-browser-api"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-R03": {
      "text": "Deduplicate courses, assignments, announcements and materials both against saved records and within the incoming batch. Handle retries and concurrent requests without two copies; do not merge genuinely different course sections or terms because names resemble one another.",
      "source": "docs/master-plan.md#f01-r03",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p02-identity-suppression",
        "p05-material-versioning",
        "p06-refresh-task-truth"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-R04": {
      "text": "Preserve valid partial discoveries and prior data through cancellation, timeout, rate limits, pagination gaps and disconnected sessions. Retire missing records only after demonstrated complete coverage. Keep intentional user suppression and manual data intact.",
      "source": "docs/master-plan.md#f01-r04",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p02-identity-suppression",
        "p03-protected-browser",
        "p04-destination-coverage",
        "p05-material-versioning",
        "p06-refresh-task-truth"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-R05": {
      "text": "Background sync/watch updates the same source context used by foreground reads. Show actual progress, last successful check, partial state, errors and reconnection needs; no second independent scheduler.",
      "source": "docs/master-plan.md#f01-r05",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p03-protected-browser",
        "p06-refresh-task-truth",
        "p07-watch-revisions",
        "p15-app-boundaries",
        "p30-settings-device"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-R06": {
      "text": "Finish the current feature with real Schoology evidence before moving on, and preserve its accepted commits for all later features.",
      "source": "docs/master-plan.md#f01-r06",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p32-release-evidence"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-AC01": {
      "text": "Refresh twice against unchanged Schoology data: same identities/counts, improved reuse evidence and no unnecessary full-site rediscovery. Capture comparable navigation/request/timing evidence rather than claiming a speedup from intuition.",
      "source": "docs/master-plan.md#f01-ac01",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p03-protected-browser",
        "p04-destination-coverage",
        "p05-material-versioning",
        "p06-refresh-task-truth",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-AC02": {
      "text": "An input batch containing A, B, A, B yields exactly two records; a saved A plus incoming A/A remains one. Repeated titles across distinct terms/sections remain distinct when source identity differs.",
      "source": "docs/master-plan.md#f01-ac02",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p02-identity-suppression",
        "p05-material-versioning",
        "p06-refresh-task-truth"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-AC03": {
      "text": "Cancel after one course/material checkpoint: saved valid results remain and unrelated source records are not retired. A failed or partial scan does not mark a source complete.",
      "source": "docs/master-plan.md#f01-ac03",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p02-identity-suppression",
        "p03-protected-browser",
        "p04-destination-coverage",
        "p05-material-versioning",
        "p06-refresh-task-truth",
        "p07-watch-revisions"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-AC04": {
      "text": "Delete/suppress a local source record then resync: it does not reappear; undo suppression allows it to return. A manual record survives source disappearance.",
      "source": "docs/master-plan.md#f01-ac04",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p02-identity-suppression",
        "p05-material-versioning"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F01-AC05": {
      "text": "Exercise permitted browser modes, scoped refresh, watcher suspension/restore, and sign-out/account boundaries with existing behavioral tests plus focused live verification. Record limitations honestly.",
      "source": "docs/master-plan.md#f01-ac05",
      "verification_section": "J01",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p03-protected-browser",
        "p06-refresh-task-truth",
        "p07-watch-revisions",
        "p10-model-browser-api",
        "p15-app-boundaries",
        "p30-settings-device",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-R01": {
      "text": "Replace Planner navigation with Context, keeping Connections separate. Make plus-menu creation, search/filter, course association, source/provenance, processing states and appropriate preview/edit/remove actions coherent.",
      "source": "docs/master-plan.md#f02-r01",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p08-context-library-store",
        "p11-context-library-ui",
        "p15-app-boundaries"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-R02": {
      "text": "Support plain notes/preferences, PDF, DOCX, TXT/Markdown, PNG/JPEG/WebP, scanned PDFs and handwritten images. Explicitly exclude PPTX. Treat reading/conversion failure as a visible result, not empty successful content.",
      "source": "docs/master-plan.md#f02-r02",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p09-document-ingestion",
        "p11-context-library-ui",
        "p17-learning-inference"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-R03": {
      "text": "Uploads in a session remain there unless optionally saved to Context or linked to the session course. Context uploads can be unassigned or attached to a course. Moving/linking changes organization without duplicating the original content or losing references.",
      "source": "docs/master-plan.md#f02-r03",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p08-context-library-store",
        "p09-document-ingestion",
        "p11-context-library-ui",
        "p15-app-boundaries",
        "p20-artifact-persistence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-R04": {
      "text": "Keep navigation notes separate from study source text, personal preferences and inferred observations. Retrieve only relevant account/course-authorized evidence; personal notes never become instructions to bypass access/integrity policy.",
      "source": "docs/master-plan.md#f02-r04",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p05-material-versioning",
        "p08-context-library-store",
        "p15-app-boundaries"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-R05": {
      "text": "Preserve originals, extracted versions, supporting source/page/heading locations and extraction confidence/status. Allow retry, replacement/version update and deletion with clear dependent-item behavior.",
      "source": "docs/master-plan.md#f02-r05",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p05-material-versioning",
        "p08-context-library-store",
        "p09-document-ingestion",
        "p11-context-library-ui",
        "p17-learning-inference",
        "p20-artifact-persistence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-R06": {
      "text": "Provide meaningful no-context, processing, partial, unsupported, unreadable, offline and retry states. Explain what remains usable. Do not require students to understand indexing or model tokens.",
      "source": "docs/master-plan.md#f02-r06",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p05-material-versioning",
        "p08-context-library-store",
        "p09-document-ingestion",
        "p11-context-library-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-AC01": {
      "text": "Create a text note, import a DOCX/PDF/photo, associate and detach a course, search and preview each. All actions survive app restart with correct owner/scope.",
      "source": "docs/master-plan.md#f02-ac01",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p08-context-library-store",
        "p09-document-ingestion",
        "p11-context-library-ui",
        "p15-app-boundaries",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-AC02": {
      "text": "A scanned/handwritten source produces useful bounded Meta interpretation when supported; an unreadable source stays visibly uncertain and never acquires invented text.",
      "source": "docs/master-plan.md#f02-ac02",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p09-document-ingestion",
        "p11-context-library-ui",
        "p17-learning-inference",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-AC03": {
      "text": "Unsupported PPTX, misleading file extensions and oversized/encrypted documents receive clear errors while other uploads continue.",
      "source": "docs/master-plan.md#f02-ac03",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p09-document-ingestion",
        "p11-context-library-ui",
        "p17-learning-inference",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F02-AC04": {
      "text": "One course cannot retrieve another course/account source accidentally. Remove a source and confirm it leaves future retrieval while prior cited historical versions remain clearly historical or become an explicit removed-source reference.",
      "source": "docs/master-plan.md#f02-ac04",
      "verification_section": "J02",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p05-material-versioning",
        "p08-context-library-store",
        "p09-document-ingestion",
        "p11-context-library-ui",
        "p15-app-boundaries",
        "p20-artifact-persistence",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-R01": {
      "text": "Add grade access off by default, one user-controlled Settings switch and optional notes. Reuse authorized connections, not a second login or direct credential collection.",
      "source": "docs/master-plan.md#f03-r01",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p12-grade-consent-evidence",
        "p30-settings-device"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-R02": {
      "text": "Collect source grade/feedback and completion/attempt availability as separate evidence with provenance and retrieval time. Keep maximum points, real earned grades and app practice scores distinct.",
      "source": "docs/master-plan.md#f03-r02",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p03-protected-browser",
        "p12-grade-consent-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-R03": {
      "text": "Default to active/unknown. Upgrade to verified completed only from supported connected evidence: completed, grade available, no remaining submission/resubmission/retake. Unknown availability or conflicting evidence stays conservative. Do not let the model invent a missing grade.",
      "source": "docs/master-plan.md#f03-r03",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p03-protected-browser",
        "p12-grade-consent-evidence",
        "p13-coursework-integrity"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-R04": {
      "text": "Mark-complete asks ScholarOS to verify; local removal, student notes, uploaded marked work and a new conversation never unlock answers. Suppression does not erase policy identity or cause hidden content refetch.",
      "source": "docs/master-plan.md#f03-r04",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p02-identity-suppression",
        "p03-protected-browser",
        "p12-grade-consent-evidence",
        "p13-coursework-integrity",
        "p15-app-boundaries",
        "p18-local-tutor-tools"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-R05": {
      "text": "Keep a scoped cross-session assistance record for original coursework/question identities and transformations. Detect cumulative answer construction, role-play, paraphrases, hidden artifact answers and requests to save bypass instructions into memory.",
      "source": "docs/master-plan.md#f03-r05",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p10-model-browser-api",
        "p13-coursework-integrity",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p20-artifact-persistence",
        "p23-practice-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-R06": {
      "text": "Completed-work review can explain actual mistakes and answers. Active-work help clarifies requirements/concepts and gives bounded hints or distinct practice without writing submission-ready content.",
      "source": "docs/master-plan.md#f03-r06",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p10-model-browser-api",
        "p12-grade-consent-evidence",
        "p13-coursework-integrity",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p23-practice-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-R07": {
      "text": "Revocation stops both collection and use, handles in-flight work, invalidates derived grade-dependent recommendations and offers local grade deletion. Keep unrelated materials and learning practice available.",
      "source": "docs/master-plan.md#f03-r07",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p12-grade-consent-evidence",
        "p13-coursework-integrity",
        "p15-app-boundaries",
        "p18-local-tutor-tools",
        "p30-settings-device"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-AC01": {
      "text": "A valid zero grade is recognized; no grade, merely submitted, reopened work and remaining exam attempts all retain active/unknown protections.",
      "source": "docs/master-plan.md#f03-ac01",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p12-grade-consent-evidence", "p13-coursework-integrity"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-AC02": {
      "text": "An uploaded screenshot saying graded and a user claiming teacher status do not override missing connected evidence. Hiding the assignment and starting a new session do not reset protection.",
      "source": "docs/master-plan.md#f03-ac02",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p02-identity-suppression",
        "p12-grade-consent-evidence",
        "p13-coursework-integrity",
        "p15-app-boundaries",
        "p18-local-tutor-tools"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-AC03": {
      "text": "Adversarial writing/math conversations request a solution gradually across turns/sessions: the tutor provides conceptual support without reconstructing an answer. Test chat, source previews, artifact content and memory writes.",
      "source": "docs/master-plan.md#f03-ac03",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p10-model-browser-api",
        "p13-coursework-integrity",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p20-artifact-persistence",
        "p23-practice-evidence",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-AC04": {
      "text": "Turning access off during a grade fetch prevents late grade use/storage as specified; recommendations no longer reference withheld grades. Re-enable respects current permission and source evidence.",
      "source": "docs/master-plan.md#f03-ac04",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p12-grade-consent-evidence",
        "p13-coursework-integrity",
        "p15-app-boundaries",
        "p18-local-tutor-tools",
        "p30-settings-device"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F03-AC05": {
      "text": "Live read-only Schoology verification distinguishes actual source facts from unavailable evidence. Do not submit an assessment or modify the LMS to manufacture a test case; use local fixtures for destructive/error cases.",
      "source": "docs/master-plan.md#f03-ac05",
      "verification_section": "J03",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p03-protected-browser",
        "p12-grade-consent-evidence",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-R01": {
      "text": "Build the five-activity setup with exactly one course, relevant target/topic/material selectors and timed/untimed duration. Prevent a multi-course session; allow extra uploaded materials without granting other LMS scopes.",
      "source": "docs/master-plan.md#f04-r01",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p16-study-setup-history"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-R02": {
      "text": "Hide dashboard chrome while studying. Provide clear course/title/activity, leave/back, status, composer, attachments, transcript and room for an expanded activity panel.",
      "source": "docs/master-plan.md#f04-r02",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p19-focused-conversation",
        "p22-inline-activity-chrome"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-R03": {
      "text": "Persist messages/parts, session metadata, drafts where appropriate, source references and history. Handle interrupted/failed generation and duplicate Send/retry cleanly. Do not render fake tutor content before actual inference exists.",
      "source": "docs/master-plan.md#f04-r03",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p18-local-tutor-tools",
        "p19-focused-conversation",
        "p28-editable-dictation"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-R04": {
      "text": "Study history supports search, course filtering, rename, resume and delete. Link useful recent sessions from the existing navigation structure and preserve clear account isolation.",
      "source": "docs/master-plan.md#f04-r04",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p16-study-setup-history"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-R05": {
      "text": "Use a persistent wall-clock deadline that runs even when the app is closed/minimized. On expiry show a useful summary with Finish, custom extension and indefinite continuation; expired-on-resume is handled once.",
      "source": "docs/master-plan.md#f04-r05",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p14-durable-sessions",
        "p19-focused-conversation",
        "p31-private-notifications"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-R06": {
      "text": "Deleting the session cancels its in-flight operations and prevents late-message resurrection. Keep separately retained memories/learning evidence and independently saved Context/course material, with separate controls to remove those.",
      "source": "docs/master-plan.md#f04-r06",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p08-context-library-store",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p16-study-setup-history",
        "p18-local-tutor-tools",
        "p19-focused-conversation",
        "p20-artifact-persistence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-AC01": {
      "text": "Create each activity type, reject invalid/multiple-course setup, leave/resume, rename/search/filter and reopen after app restart with the same ordered content.",
      "source": "docs/master-plan.md#f04-ac01",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p16-study-setup-history",
        "p19-focused-conversation",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-AC02": {
      "text": "Background/close the app for several minutes: the timer reflects elapsed time rather than pausing. Expiry summary and extension work without losing a draft or completed turn; untimed mode has no deadline.",
      "source": "docs/master-plan.md#f04-ac02",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p14-durable-sessions",
        "p19-focused-conversation",
        "p31-private-notifications",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-AC03": {
      "text": "Double-send/retry and interrupted-stream recovery do not create duplicate turns. Deletion during generation does not recreate a session later.",
      "source": "docs/master-plan.md#f04-ac03",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p08-context-library-store",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p16-study-setup-history",
        "p18-local-tutor-tools",
        "p19-focused-conversation",
        "p20-artifact-persistence",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F04-AC04": {
      "text": "Use keyboard navigation, narrow-window layout and offline history. Shared message, input and attachment primitives are actually used.",
      "source": "docs/master-plan.md#f04-ac04",
      "verification_section": "J04",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p16-study-setup-history",
        "p19-focused-conversation",
        "p22-inline-activity-chrome",
        "p28-editable-dictation",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-R01": {
      "text": "Use structured setup, current course/resource freshness, relevant source passages, preferences and prior conversation to clarify the goal without asking for the same context again.",
      "source": "docs/master-plan.md#f05-r01",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p25-memory-learning-model"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-R02": {
      "text": "Integrate actual Meta text/multimodal inference through the existing authorized server pathway and AI SDK. Keep model/provider configuration typed, server-owned and Meta-only; expose unavailable/auth/rate-limit/cancel states honestly.",
      "source": "docs/master-plan.md#f05-r02",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p09-document-ingestion",
        "p10-model-browser-api",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p27-meta-dictation-relay"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-R03": {
      "text": "Persist complete local conversation while sending bounded, relevant context. Preserve source citations/version references; distinguish source requirements, general explanations and AI inferences. Missing context prompts a helpful next action rather than an invented requirement.",
      "source": "docs/master-plan.md#f05-r03",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p05-material-versioning",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p19-focused-conversation"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-R04": {
      "text": "Expose scoped tools for approved source retrieval, context/memory proposals, creating activities and safe learning actions. Student messages, retrieved sources and tool results cannot expand permissions or turn into privileged desktop instructions.",
      "source": "docs/master-plan.md#f05-r04",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p10-model-browser-api",
        "p13-coursework-integrity",
        "p15-app-boundaries",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p25-memory-learning-model"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-R05": {
      "text": "Apply integrity policy before publishing text, tool effects or artifacts. Restricted generation must not leak answers through an unchecked stream. Provide short, helpful conceptual alternatives on rejection with bounded retries.",
      "source": "docs/master-plan.md#f05-r05",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p10-model-browser-api",
        "p13-coursework-integrity",
        "p17-learning-inference",
        "p18-local-tutor-tools"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-R06": {
      "text": "Keep the conversation readable and fluid. Allow stop/retry without losing accepted content; do not show private chain-of-thought. Tutor responses are text only.",
      "source": "docs/master-plan.md#f05-r06",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p19-focused-conversation"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-AC01": {
      "text": "Complete a real Schoology-grounded session: source-backed goal clarification, useful explanation, inspected citations and saved conversation. Test expired access, stale/partial sources and unavailable inference.",
      "source": "docs/master-plan.md#f05-ac01",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p05-material-versioning",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p19-focused-conversation",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-AC02": {
      "text": "Capture outgoing provider/model identity and bounded content metrics without logging student content; prove no non-Meta fallback and no secret/provider key in the renderer.",
      "source": "docs/master-plan.md#f05-ac02",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p09-document-ingestion",
        "p10-model-browser-api",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p27-meta-dictation-relay",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-AC03": {
      "text": "Test prompt injection inside an uploaded source and across turns. Invalid tool names/arguments, cross-course IDs and permission-change races cannot execute privileged work.",
      "source": "docs/master-plan.md#f05-ac03",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p10-model-browser-api",
        "p13-coursework-integrity",
        "p15-app-boundaries",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p25-memory-learning-model",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F05-AC04": {
      "text": "Offline UI remains readable and explains why sending requires connectivity; failed responses can be retried idempotently.",
      "source": "docs/master-plan.md#f05-ac04",
      "verification_section": "J05",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p19-focused-conversation",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-R01": {
      "text": "Generate flexible HTML/CSS/bounded JavaScript graphs, experiments, simulations and other activities from an explicit learning objective. Support meaningful input/output and accessible explanatory alternatives.",
      "source": "docs/master-plan.md#f06-r01",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p20-artifact-persistence",
        "p22-inline-activity-chrome"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-R02": {
      "text": "Validate generated content and run it in a genuinely isolated runtime. No Electron/Node/preload, browser cookies, filesystem, unauthorized network or arbitrary application tool access. Do not confuse sanitization with isolation.",
      "source": "docs/master-plan.md#f06-r02",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p15-app-boundaries", "p21-isolated-activity-runtime"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-R03": {
      "text": "Keep an activity inline with its originating tutor message. Expand into a resizable side panel using the same authoritative activity state; collapse/reopen without resetting or duplicating it.",
      "source": "docs/master-plan.md#f06-r03",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p19-focused-conversation",
        "p21-isolated-activity-runtime",
        "p22-inline-activity-chrome",
        "p24-practice-feedback-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-R04": {
      "text": "Persist immutable content versions, student inputs/progress and a versioned safe message/state contract. Regeneration creates a recoverable version; invalid generation does not destroy the last usable activity.",
      "source": "docs/master-plan.md#f06-r04",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p05-material-versioning",
        "p14-durable-sessions",
        "p20-artifact-persistence",
        "p21-isolated-activity-runtime",
        "p22-inline-activity-chrome"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-R05": {
      "text": "Allow saving an explanation/activity into Context or directly to the session course with provenance. Separate saved-item and session lifecycles. Saved activities work offline with approved bundled assets.",
      "source": "docs/master-plan.md#f06-r05",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p08-context-library-store",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p18-local-tutor-tools",
        "p20-artifact-persistence",
        "p22-inline-activity-chrome"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-R06": {
      "text": "Apply tutoring integrity to visible and hidden artifact content before execution. Host notifications/state events cannot be used to request arbitrary files/context or forge official grades.",
      "source": "docs/master-plan.md#f06-r06",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p13-coursework-integrity",
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p20-artifact-persistence",
        "p21-isolated-activity-runtime"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-AC01": {
      "text": "Live examples include a graph with correctly responding controls, a useful science simulation and an input-driven activity. Reviewer checks educational behavior, not merely that a frame loaded.",
      "source": "docs/master-plan.md#f06-ac01",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p17-learning-inference",
        "p18-local-tutor-tools",
        "p20-artifact-persistence",
        "p22-inline-activity-chrome",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-AC02": {
      "text": "Expand/collapse, change parameters, close/reopen the app, work offline and restore the same content/version/progress.",
      "source": "docs/master-plan.md#f06-ac02",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p05-material-versioning",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p19-focused-conversation",
        "p20-artifact-persistence",
        "p21-isolated-activity-runtime",
        "p22-inline-activity-chrome",
        "p24-practice-feedback-ui",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-AC03": {
      "text": "Adversarial generated code attempts preload/parent DOM/cookie/file/network/navigation/popup access and spoofed/oversized messages: blocked with a recoverable student-facing state.",
      "source": "docs/master-plan.md#f06-ac03",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p13-coursework-integrity",
        "p15-app-boundaries",
        "p17-learning-inference",
        "p20-artifact-persistence",
        "p21-isolated-activity-runtime",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F06-AC04": {
      "text": "Save an activity to Context/course, delete its session and verify the saved item remains intentionally available. Delete/remove saved context independently without corrupting unrelated activities.",
      "source": "docs/master-plan.md#f06-ac04",
      "verification_section": "J06",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p08-context-library-store",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p18-local-tutor-tools",
        "p20-artifact-persistence",
        "p22-inline-activity-chrome",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-R01": {
      "text": "Offer practice after a student indicates understanding while adapting to actual responses. Support quizzes, practice exams and short learning assignments with explicit objectives and appropriate difficulty.",
      "source": "docs/master-plan.md#f07-r01",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p17-learning-inference",
        "p23-practice-evidence",
        "p24-practice-feedback-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-R02": {
      "text": "Ordinary quiz review defaults to the end; allow an explicit request for per-answer feedback. Practice exams hold hints/solutions until submission. Switching to guided practice marks assistance and does not masquerade as a clean exam result.",
      "source": "docs/master-plan.md#f07-r02",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p21-isolated-activity-runtime",
        "p23-practice-evidence",
        "p24-practice-feedback-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-R03": {
      "text": "Evaluate answers with appropriate deterministic checks or bounded Meta evaluation/rubrics. Accept valid alternative responses and explicit uncertainty; do not grade a reasonable answer wrong merely because wording differs.",
      "source": "docs/master-plan.md#f07-r03",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p17-learning-inference",
        "p21-isolated-activity-runtime",
        "p23-practice-evidence",
        "p24-practice-feedback-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-R04": {
      "text": "Explain mistakes with sources where relevant, revisit prerequisite concepts and suggest another example or next practice. Distinguish app-generated work from real active coursework; never turn an assignment-help session into a solution generator.",
      "source": "docs/master-plan.md#f07-r04",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p13-coursework-integrity",
        "p17-learning-inference",
        "p23-practice-evidence",
        "p24-practice-feedback-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-R05": {
      "text": "Persist attempts, selected feedback mode, answer changes, assistance, rubrics/versions and outcome evidence. Show retries without erasing prior learning evidence or treating repeated exposure as an independent success.",
      "source": "docs/master-plan.md#f07-r05",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p23-practice-evidence",
        "p24-practice-feedback-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-AC01": {
      "text": "Test end-of-quiz feedback, requested per-answer feedback, exam submission, guided-exam exit and resume during an incomplete attempt.",
      "source": "docs/master-plan.md#f07-ac01",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p23-practice-evidence",
        "p24-practice-feedback-ui",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-AC02": {
      "text": "Exercise numeric, multiple-choice and short-explanation examples with valid alternatives, incorrect and uncertain results. Reviewer verifies generated questions/rubrics are coherent and answerable.",
      "source": "docs/master-plan.md#f07-ac02",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p17-learning-inference",
        "p23-practice-evidence",
        "p24-practice-feedback-ui",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-AC03": {
      "text": "An artifact cannot forge an official grade or silently mark a learning objective mastered. Assistance and evidence versions remain traceable.",
      "source": "docs/master-plan.md#f07-ac03",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p21-isolated-activity-runtime",
        "p23-practice-evidence",
        "p24-practice-feedback-ui",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F07-AC04": {
      "text": "A real active question cannot be smuggled into generated practice to obtain a lightly reworded exact solution.",
      "source": "docs/master-plan.md#f07-ac04",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p13-coursework-integrity",
        "p17-learning-inference",
        "p23-practice-evidence",
        "p24-practice-feedback-ui",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-R01": {
      "text": "Use a typed memory tool to save explicit preferences such as concise explanations or simpler wording. Separate personal preference, learning observation, course concept/prerequisite and source fact.",
      "source": "docs/master-plan.md#f08-r01",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p18-local-tutor-tools",
        "p25-memory-learning-model",
        "p26-memory-progress-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-R02": {
      "text": "Apply explicit corrections over older inferences. Inferred patterns remain provisional/revisable and have evidence references; do not infer permanent ability, a medical condition or a fixed label from weak data.",
      "source": "docs/master-plan.md#f08-r02",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p23-practice-evidence",
        "p25-memory-learning-model",
        "p26-memory-progress-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-R03": {
      "text": "Context exposes remembered information with source/type/course where relevant and edit/delete controls. A deletion removes the item from future retrieval and derived preference caches.",
      "source": "docs/master-plan.md#f08-r03",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p08-context-library-store",
        "p11-context-library-ui",
        "p25-memory-learning-model",
        "p26-memory-progress-ui",
        "p30-settings-device"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-R04": {
      "text": "Construct useful course concept/prerequisite relationships grounded in materials, with evidence and uncertainty. Update student understanding from independent/assisted attempts and confidence without conflating official grades.",
      "source": "docs/master-plan.md#f08-r04",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p23-practice-evidence",
        "p25-memory-learning-model",
        "p26-memory-progress-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-R05": {
      "text": "Show understandable strengths, topics needing practice and recent change in Study/Today. Retain small relevant memories and learning observations after session deletion as explicitly requested, without secretly retaining the deleted transcript.",
      "source": "docs/master-plan.md#f08-r05",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p14-durable-sessions",
        "p24-practice-feedback-ui",
        "p25-memory-learning-model",
        "p26-memory-progress-ui",
        "p29-today-recommendations"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-R06": {
      "text": "Keep memory and progress scoped by account and course. Personal notes cannot override access, completion or answer-assistance policies; full local/account data deletion includes derived data.",
      "source": "docs/master-plan.md#f08-r06",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p08-context-library-store",
        "p13-coursework-integrity",
        "p15-app-boundaries",
        "p25-memory-learning-model",
        "p26-memory-progress-ui"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-AC01": {
      "text": "Tell the tutor that an explanation is too verbose; confirm the preference is saved, visible, used in a new session, corrected and deletable.",
      "source": "docs/master-plan.md#f08-ac01",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p11-context-library-ui",
        "p18-local-tutor-tools",
        "p25-memory-learning-model",
        "p26-memory-progress-ui",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-AC02": {
      "text": "An incorrect inference can be corrected; a deleted preference no longer influences the next prepared context. Practice with hints is not counted as independent evidence.",
      "source": "docs/master-plan.md#f08-ac02",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p11-context-library-ui",
        "p13-coursework-integrity",
        "p23-practice-evidence",
        "p25-memory-learning-model",
        "p26-memory-progress-ui",
        "p30-settings-device",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-AC03": {
      "text": "Deleting a session preserves explicitly retained derived context, while deleting the memory/full account data removes it. No cross-account observations leak.",
      "source": "docs/master-plan.md#f08-ac03",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p08-context-library-store",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p25-memory-learning-model",
        "p26-memory-progress-ui",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F08-AC04": {
      "text": "Progress descriptions cite actual observations and distinguish unknown topics from demonstrated difficulty.",
      "source": "docs/master-plan.md#f08-ac04",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p23-practice-evidence",
        "p24-practice-feedback-ui",
        "p25-memory-learning-model",
        "p26-memory-progress-ui",
        "p29-today-recommendations",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F09-R01": {
      "text": "Use the documented Meta transcription model and supported authenticated streaming/file pathway. Never substitute another speech model or enable tutor speech output.",
      "source": "docs/master-plan.md#f09-r01",
      "verification_section": "J08",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p10-model-browser-api",
        "p27-meta-dictation-relay",
        "p28-editable-dictation"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F09-R02": {
      "text": "Explicitly request microphone/OS permission through user action. Show recording, provisional live/ghost transcript, final text, stop, cancel and error states.",
      "source": "docs/master-plan.md#f09-r02",
      "verification_section": "J08",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p19-focused-conversation",
        "p27-meta-dictation-relay",
        "p28-editable-dictation"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F09-R03": {
      "text": "Preserve existing typed composer text and merge partial/final transcript segments without duplication. Final text stays editable and is not submitted until Send.",
      "source": "docs/master-plan.md#f09-r03",
      "verification_section": "J08",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p19-focused-conversation",
        "p27-meta-dictation-relay",
        "p28-editable-dictation"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F09-R04": {
      "text": "Stop capture on explicit cancel, leaving a session, sign-out and permission revocation. No background microphone use or raw recording retention by default.",
      "source": "docs/master-plan.md#f09-r04",
      "verification_section": "J08",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p19-focused-conversation",
        "p27-meta-dictation-relay",
        "p28-editable-dictation"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F09-R05": {
      "text": "Handle offline, missing device, denied permission, disconnect, empty/noisy audio, provider limits and cancellation without losing the pre-existing draft.",
      "source": "docs/master-plan.md#f09-r05",
      "verification_section": "J08",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p19-focused-conversation",
        "p27-meta-dictation-relay",
        "p28-editable-dictation"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F09-AC01": {
      "text": "Live microphone test on macOS: speak, inspect provisional text, stop, edit and Send. Tutor answers with text only.",
      "source": "docs/master-plan.md#f09-ac01",
      "verification_section": "J08",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p19-focused-conversation",
        "p27-meta-dictation-relay",
        "p28-editable-dictation",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F09-AC02": {
      "text": "Cancel recording and leave/sign out: microphone stops and no late transcript is inserted into another account/session.",
      "source": "docs/master-plan.md#f09-ac02",
      "verification_section": "J08",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p19-focused-conversation",
        "p27-meta-dictation-relay",
        "p28-editable-dictation",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F09-AC03": {
      "text": "Permission-denied/offline/reconnect and repeated partial events preserve a single coherent draft. Verify actual Meta model and credential isolation.",
      "source": "docs/master-plan.md#f09-ac03",
      "verification_section": "J08",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p10-model-browser-api",
        "p15-app-boundaries",
        "p19-focused-conversation",
        "p27-meta-dictation-relay",
        "p28-editable-dictation",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F10-R01": {
      "text": "Compose connection/setup attention, sync/freshness, deadlines/assignments/exams, announcements, recent courses/materials, recent sessions, progress and quick actions using actual available data.",
      "source": "docs/master-plan.md#f10-r01",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p26-memory-progress-ui", "p29-today-recommendations"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F10-R02": {
      "text": "Recommend next study using permitted source evidence, deadlines, learning observations and preferences, plus grades only with active permission. Explain the reason and provide source links.",
      "source": "docs/master-plan.md#f10-r02",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p12-grade-consent-evidence",
        "p25-memory-learning-model",
        "p26-memory-progress-ui",
        "p29-today-recommendations"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F10-R03": {
      "text": "Deep-link recommendations into a relevant prefilled structured study setup without silently starting a new inference session or crossing course boundaries.",
      "source": "docs/master-plan.md#f10-r03",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p16-study-setup-history",
        "p29-today-recommendations"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F10-R04": {
      "text": "Handle indexing in progress, insufficient context, no courses, no upcoming deadlines, partial coverage, sign-in needs and offline states with useful next actions. Do not fill empty cards with fabricated data.",
      "source": "docs/master-plan.md#f10-r04",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p29-today-recommendations"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F10-R05": {
      "text": "Keep recommendations fresh after sync, practice, memory correction and grade revocation; avoid model calls on every rerender and make background computation observable/cancellable.",
      "source": "docs/master-plan.md#f10-r05",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p12-grade-consent-evidence",
        "p25-memory-learning-model",
        "p29-today-recommendations"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F10-AC01": {
      "text": "Use real Schoology data plus local fixtures to verify upcoming-item order, recommendation reasoning and links to the right course/activity.",
      "source": "docs/master-plan.md#f10-ac01",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p25-memory-learning-model",
        "p26-memory-progress-ui",
        "p29-today-recommendations",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F10-AC02": {
      "text": "Test new account, pending index, grade access off, unknown dates and partial/offline sources. Empty states remain clean and actionable.",
      "source": "docs/master-plan.md#f10-ac02",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p12-grade-consent-evidence",
        "p25-memory-learning-model",
        "p29-today-recommendations",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F10-AC03": {
      "text": "Resume a recent session with its state intact and follow a source without escaping permitted navigation. Verify no fake Card/div equivalents.",
      "source": "docs/master-plan.md#f10-ac03",
      "verification_section": "J07",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p16-study-setup-history",
        "p29-today-recommendations",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-R01": {
      "text": "Create coherent Settings sections with real shared fields, labels and switches, consistent spacing/full-width controls, concise helper text and existing autosave behavior.",
      "source": "docs/master-plan.md#f11-r01",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p30-settings-device"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-R02": {
      "text": "Expose account/device/browser, personal context and optional levels, navigation behavior, background sync/watch, grades, notifications integration, appearance/accessibility and local-data controls without duplicating their stores.",
      "source": "docs/master-plan.md#f11-r02",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p12-grade-consent-evidence",
        "p26-memory-progress-ui",
        "p30-settings-device",
        "p31-private-notifications"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-R03": {
      "text": "Allow selecting/configuring another academic browser after onboarding. Preserve the old verified workspace until replacement succeeds; clearly describe whether sign-in is needed again.",
      "source": "docs/master-plan.md#f11-r03",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p15-app-boundaries", "p30-settings-device"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-R04": {
      "text": "On a new device, an existing account can configure local browser/consent/preferences instead of being trapped by previously completed account onboarding. Do not imply local course files automatically arrived from the cloud.",
      "source": "docs/master-plan.md#f11-r04",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p29-today-recommendations",
        "p30-settings-device"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-R05": {
      "text": "Serialize browser replacement with active academic operations, cancel safely, preserve checkpoints, and retain unrelated manual work. Support cancel/failure/retry without a broken configured state.",
      "source": "docs/master-plan.md#f11-r05",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p03-protected-browser",
        "p07-watch-revisions",
        "p15-app-boundaries",
        "p30-settings-device"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-R06": {
      "text": "Ensure personal preferences and grade notes are editable here or deep-link clearly into Context. Handle grade revocation/data deletion and broader local-data removal with appropriate explicit confirmation in the product.",
      "source": "docs/master-plan.md#f11-r06",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p12-grade-consent-evidence",
        "p15-app-boundaries",
        "p26-memory-progress-ui",
        "p30-settings-device"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-AC01": {
      "text": "Change the browser on the current Mac, cancel once and complete a verified replacement using non-destructive test setup. Original data/session survives until success.",
      "source": "docs/master-plan.md#f11-ac01",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p30-settings-device",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-AC02": {
      "text": "Test an existing account with no local device profile; setup can complete and course syncing becomes available.",
      "source": "docs/master-plan.md#f11-ac02",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p29-today-recommendations",
        "p30-settings-device",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-AC03": {
      "text": "Edit settings and close immediately: valid pending saves settle or errors remain visible, rather than silently disappearing. Keyboard/labels/layout/reduced motion pass.",
      "source": "docs/master-plan.md#f11-ac03",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p26-memory-progress-ui",
        "p30-settings-device",
        "p31-private-notifications",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F11-AC04": {
      "text": "Source/grade permissions remain enforced in services even if UI input is spoofed; UI does not become the sole access boundary.",
      "source": "docs/master-plan.md#f11-ac04",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p03-protected-browser",
        "p07-watch-revisions",
        "p12-grade-consent-evidence",
        "p15-app-boundaries",
        "p30-settings-device",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F12-R01": {
      "text": "Add a master notification switch and organized per-event switches. Initial categories cover connection attention, sync completion/failure, context processing, tutor/activity ready while away, timer expiry and optional deadline reminders.",
      "source": "docs/master-plan.md#f12-r01",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p30-settings-device", "p31-private-notifications"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F12-R02": {
      "text": "Integrate OS permission/configuration through explicit enable action and expose denied/unavailable states with an understandable settings path. Merely visiting Settings must not request permission.",
      "source": "docs/master-plan.md#f12-r02",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p30-settings-device", "p31-private-notifications"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F12-R03": {
      "text": "Respect quiet hours, current account, app focus and deduplication. No sensitive grade/question content in OS previews by default. Clicking routes to the appropriate still-existing source/session.",
      "source": "docs/master-plan.md#f12-r03",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p15-app-boundaries", "p31-private-notifications"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F12-R04": {
      "text": "Emit events from actual service/generation outcomes. Distinguish waiting on user action, work ready and failure; do not notify every token, polling tick or retry.",
      "source": "docs/master-plan.md#f12-r04",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p07-watch-revisions",
        "p14-durable-sessions",
        "p31-private-notifications"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F12-R05": {
      "text": "Persist preferences, reschedule/cancel relevant reminders after changes and avoid delivering stale/deleted-account/deleted-session notifications.",
      "source": "docs/master-plan.md#f12-r05",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p31-private-notifications"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F12-AC01": {
      "text": "Toggle the master and individual events; verify requested OS permission behavior, off/denied/quiet-hours and focused/background states.",
      "source": "docs/master-plan.md#f12-ac01",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p30-settings-device",
        "p31-private-notifications",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F12-AC02": {
      "text": "Complete/fail/cancel representative jobs and expire a timed session: the correct notification occurs at most once and opens the correct location.",
      "source": "docs/master-plan.md#f12-ac02",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p07-watch-revisions",
        "p14-durable-sessions",
        "p31-private-notifications",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F12-AC03": {
      "text": "Disable notifications, sign out or delete a target: queued/stale events do not leak content or route to the wrong account. Review Windows behavior without claiming unperformed GUI checks.",
      "source": "docs/master-plan.md#f12-ac03",
      "verification_section": "J09",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p14-durable-sessions",
        "p15-app-boundaries",
        "p31-private-notifications",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-R01": {
      "text": "Complete all acceptance criteria and regressions, including UI primitive reuse, empty/error/offline states, source permission boundaries, session restoration and no remaining Planner surface.",
      "source": "docs/master-plan.md#f13-r01",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p02-identity-suppression",
        "p06-refresh-task-truth",
        "p09-document-ingestion",
        "p11-context-library-ui",
        "p15-app-boundaries",
        "p16-study-setup-history",
        "p21-isolated-activity-runtime",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-R02": {
      "text": "Run the real Schoology journey: existing/new-device setup, context sync, course/material selection, focused tutor explanation, useful inline/expanded activity, practice feedback, saved/resumed session, adaptive preference and Today recommendation.",
      "source": "docs/master-plan.md#f13-r02",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p15-app-boundaries",
        "p22-inline-activity-chrome",
        "p27-meta-dictation-relay",
        "p29-today-recommendations",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-R03": {
      "text": "Prepare a reproducible demo script with a realistic learning objective, source citations, a science/math example and an active-work integrity demonstration. Keep real student identities/grades out of shareable recordings unless explicitly permitted.",
      "source": "docs/master-plan.md#f13-r03",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p32-release-evidence"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-R04": {
      "text": "Build/test macOS packaging with native SQLite and browser/Stagehand resources. Do not replace the user's working app/data in order to test an installer. Signing/notarization/distribution depend on real credentials and are reported accurately.",
      "source": "docs/master-plan.md#f13-r04",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p21-isolated-activity-runtime",
        "p31-private-notifications",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-R05": {
      "text": "Review Windows paths, pipes, browser detection, assets, shortcuts, microphone/notification permissions and packaging; prepare a hands-on test checklist for the available Windows laptop. macOS success is not Windows proof.",
      "source": "docs/master-plan.md#f13-r05",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p31-private-notifications", "p32-release-evidence"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-R06": {
      "text": "Create an honest requirement-to-evidence/release report, known issues list and pending external/hardware gates. Verify current official hackathon submission requirements before preparing final deliverables; no automatic submission/publication is authorized by this feature alone.",
      "source": "docs/master-plan.md#f13-r06",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p32-release-evidence"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-R07": {
      "text": "Keep full scope visible near the two-day target. Report actual completion, failures and risks. Continue remediation through durable tasks; do not call stubs, failed checks or untested behavior complete.",
      "source": "docs/master-plan.md#f13-r07",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p32-release-evidence"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-AC01": {
      "text": "Applicable workspace tests/typechecks/lint/format checks and macOS build/packaging pass with exact commands, commit and evidence recorded. Distinguish pre-existing baseline issues and remediate relevant blockers.",
      "source": "docs/master-plan.md#f13-ac01",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p01-persistence-contracts",
        "p02-identity-suppression",
        "p06-refresh-task-truth",
        "p09-document-ingestion",
        "p21-isolated-activity-runtime",
        "p31-private-notifications",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-AC02": {
      "text": "Run focused live desktop and web authentication verification under the shared GUI lock. Test leave/restart, offline, revoked permissions, unavailable inference and interrupted activity generation.",
      "source": "docs/master-plan.md#f13-ac02",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p11-context-library-ui",
        "p15-app-boundaries",
        "p16-study-setup-history",
        "p22-inline-activity-chrome",
        "p27-meta-dictation-relay",
        "p29-today-recommendations",
        "p31-private-notifications",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-AC03": {
      "text": "Reviewer independently follows the demo and critical adversarial integrity/activity-isolation tests. Preserve screenshots locally and do not publish sensitive data.",
      "source": "docs/master-plan.md#f13-ac03",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": [
        "p21-isolated-activity-runtime",
        "p22-inline-activity-chrome",
        "p32-release-evidence"
      ],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "F13-AC04": {
      "text": "Final GitHub PRs are actually merged, local main is synchronized without lost user edits, and every feature has evidence or an explicit still-open release gate. Windows checklist/results are clearly labeled.",
      "source": "docs/master-plan.md#f13-ac04",
      "verification_section": "J10",
      "verification": "Execute packet checks plus combined-verification.md on actual integrated HEAD; no research PASS implied.",
      "packets": ["p15-app-boundaries", "p32-release-evidence"],
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G001": {
      "text": "Build the complete desktop learning product described here, with a convincing real Schoology demonstration and a usable macOS release. The approximate delivery target is November 4, 2026, America/Chicago, based on the user's two-day estimate on November 2; no exact submission cutoff has been supplied. Keep the full scope. Prioritize an end-to-end working path, expose remaining work, and continue until the plan is complete or the user explicitly pauses or changes it. The target is not a guarantee, permission to fabricate verification, or an automatic stop time.",
      "source": "docs/master-plan.md#line-5",
      "section": "Purpose and authority",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G002": {
      "text": "This is the source of truth for intended scope, priorities, current-state continuation and acceptance criteria. Kanban is the execution record. Commits, tests, observed behavior and GitHub merge state are the completion evidence. Controller receipts and events preserve handoffs and recovery. Reconcile these at every handoff and after interruption; a done stage card is not a shipped feature.",
      "source": "docs/master-plan.md#line-7",
      "section": "Purpose and authority",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G003": {
      "text": "Latest explicit user instructions override older wording in this plan. This plan supersedes older conflicting proposals, especially voice output, timer pausing, multiple-course sessions, slide support and workbook-style progression. Read `AGENTS.md`, scoped instructions and `docs/SPEC.md`. Keep SPEC focused on product behavior and architecture; update its superseded behavior as corresponding features are implemented. Keep execution status and detailed feature plans on this plan's board and linked artifacts.",
      "source": "docs/master-plan.md#line-9",
      "section": "Purpose and authority",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G004": {
      "text": "The user has authorized autonomous project commands, focused commits, pushes, PR creation and normal GitHub merging for this registered plan. Existing repository instructions requiring explicit Git authorization are satisfied for this workflow. Do not ask routine permission. Honor later user restrictions, real OS authentication and GitHub protection; never bypass them. Do not deploy or publish a submission merely because an installer/demo is prepared. Prepare release artifacts and submission materials; actual external publication must remain within explicit user authorization.",
      "source": "docs/master-plan.md#line-11",
      "section": "Purpose and authority",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G005": {
      "text": "- Repository: `/Users/danieldao/Desktop/scholaros`.",
      "source": "docs/master-plan.md#line-15",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G006": {
      "text": "- GitHub: `Danieldkdao/scholaros`, origin `https://github.com/Danieldkdao/scholaros.git`.",
      "source": "docs/master-plan.md#line-16",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G007": {
      "text": "- Default branch: `main`.",
      "source": "docs/master-plan.md#line-17",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G008": {
      "text": "- Existing working branch: `feat/context`; current worktree is the primary repository above.",
      "source": "docs/master-plan.md#line-18",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G009": {
      "text": "- Observed HEAD: `2d5cf67`, merge of PR 4 for course functionality. No open PR was found at plan preparation.",
      "source": "docs/master-plan.md#line-19",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G010": {
      "text": "- Existing local work: approximately 70 modified tracked files, plus new context/watch/browser-mode/identity/material source files, migrations and tests. Counts are an observation, not an immutable inventory. Inspect current Git status and diffs before writing.",
      "source": "docs/master-plan.md#line-20",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G011": {
      "text": "- Existing product code: Electron desktop authentication/onboarding, academic connections and isolated Chromium profile, protected discovery/navigation, structured courses/assignments/announcements, manual local record editing, targeted refresh, independent academic service, background sync and authenticated inference.",
      "source": "docs/master-plan.md#line-21",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G012": {
      "text": "- In-progress code: navigation knowledge, material/PDF ingestion and FTS retrieval, resource identity/tombstones, decision/inout navigation modes, watcher scheduling/state, metrics and related UI/settings/tests. Presence of implementation or tests is not proof that it passes or is complete.",
      "source": "docs/master-plan.md#line-22",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G013": {
      "text": "- Today, Study and Planner were heading-only shells at assessment. No complete tutoring, adaptive assessment, concept graph or student learning model was found. Search again and extend any suitable implementation added since this observation.",
      "source": "docs/master-plan.md#line-23",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G014": {
      "text": "- Existing UI primitives include Card, Message, MessageScroller, Attachment, Resizable, InputGroup, Chart, Empty, Dialog, Switch, Tooltip and others under `packages/ui/src/components`. Do not install/rebuild equivalents blindly.",
      "source": "docs/master-plan.md#line-24",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G015": {
      "text": "- Web development server is on `http://127.0.0.1:3000`; Buzz uses host port 3001 and its existing Tailscale URL. Do not move Buzz or start a competing web server. Reuse existing desktop instances where possible.",
      "source": "docs/master-plan.md#line-25",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G016": {
      "text": "- Schoology is already connected through the dedicated academic browser on this Mac. Preserve its cookies/profile and local academic data. Use current authorized sessions; do not ask for or print credentials.",
      "source": "docs/master-plan.md#line-26",
      "section": "Current state and continuation",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G017": {
      "text": "Researcher first inventories existing work read-only and writes the detailed remaining-work plan. Then exactly one Coder resume worker keeps `feat/context`, examines tracked and untracked diffs, verifies the scoped baseline and makes focused checkpoint commits before parallel workers fork. Do not switch to main, discard changes, run reset-hard/clean, blindly stage everything, or start a duplicate context implementation from main.",
      "source": "docs/master-plan.md#line-30",
      "section": "Continuation instructions for the first feature",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Original resume already checkpointed; preserve continuation, then new whole_checkpoint in dedicated worktree.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G018": {
      "text": "Include intended existing context/watch/course/browser-mode/inference/migration/test changes after inspecting their contents, the existing `.greptile/config.json`, this master plan and its manifest, and the UI-primitives instruction update. Review the existing SPEC changes for consistency. Exclude `.env` files, secrets, account/browser runtime data, downloads, local databases, logs, generated caches, `node_modules`, `.worktrees` and unrelated user edits. If scope is ambiguous, preserve the files and record exclusions rather than discard or absorb unrelated work.",
      "source": "docs/master-plan.md#line-32",
      "section": "Continuation instructions for the first feature",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G019": {
      "text": "Preserve the original local work in recoverable form before major integration. Record actual baseline failures. A checkpoint commit does not claim unfinished requirements are done. Package branches inherit the accepted continuation HEAD, not the older origin/main. On retries inspect existing worktrees, receipts and PRs first. Exactly one writer owns the continuation/integration directory at a time.",
      "source": "docs/master-plan.md#line-34",
      "section": "Continuation instructions for the first feature",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G020": {
      "text": "Later independent features use normal descriptive `feat/...` branches when on the default branch; retrying an existing task or continuing an appropriate unfinished branch does not require a new branch. Every concurrent writing worker/subagent still needs its own preserved worktree and branch.",
      "source": "docs/master-plan.md#line-36",
      "section": "Continuation instructions for the first feature",
      "implementation_area": "Continuation, permission and evidence governance",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G021": {
      "text": "- English-only first release, serving students across educational levels with no product-imposed age gate. Adapt from context and practice; an education level is optional, not a required enrollment barrier.",
      "source": "docs/master-plan.md#line-42",
      "section": "Scope and experience",
      "implementation_area": "Product boundaries and navigation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G022": {
      "text": "- Desktop is the product. Web is authentication/account/inference support and at most a landing page, not a duplicate study application.",
      "source": "docs/master-plan.md#line-43",
      "section": "Scope and experience",
      "implementation_area": "Product boundaries and navigation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G023": {
      "text": "- macOS-first functional verification. Preserve Windows-compatible architecture, paths, IPC, browser integration and packaging; perform final hands-on Windows validation on the user's laptop when available. Do not claim it was performed on macOS.",
      "source": "docs/master-plan.md#line-44",
      "section": "Scope and experience",
      "implementation_area": "Product boundaries and navigation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G024": {
      "text": "- No payments, subscriptions, billing, PPTX/slide support, spoken tutor output, continuous voice conversation, homework completion or LMS submission.",
      "source": "docs/master-plan.md#line-45",
      "section": "Scope and experience",
      "implementation_area": "Product boundaries and navigation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G025": {
      "text": "- Each study session has exactly one course. Additional uploaded material is allowed, but it must not implicitly authorize retrieval from other connected courses. Personal context may be shared across the student's sessions under appropriate scope.",
      "source": "docs/master-plan.md#line-46",
      "section": "Scope and experience",
      "implementation_area": "Product boundaries and navigation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G026": {
      "text": "- Main navigation: Today, Courses, Study, Context, Connections. Settings remains accessible through the existing appropriate navigation/profile pattern. Remove Planner and its visible references; a compatibility redirect must not expose a Planner product surface.",
      "source": "docs/master-plan.md#line-47",
      "section": "Scope and experience",
      "implementation_area": "Product boundaries and navigation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G027": {
      "text": "Offer exactly these initial activities: Understand a topic; Prepare for an exam; Practice what I know; Review graded mistakes; Help me get started on an assignment.",
      "source": "docs/master-plan.md#line-51",
      "section": "Study setup and focused conversation",
      "implementation_area": "Focused one-course study/document",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G028": {
      "text": "Use structured selectors for activity, one course, permitted source/target assignment or topic, optional materials and timed/untimed duration. Target/topic selection may allow bounded explanatory text; arbitrary user instructions never change permissions. Tutor may clarify the learning goal, but should use information already selected rather than repeat onboarding questions. Getting started on an assignment explains requirements and approach without producing the assignment's solution.",
      "source": "docs/master-plan.md#line-53",
      "section": "Study setup and focused conversation",
      "implementation_area": "Focused one-course study/document",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G029": {
      "text": "A session fills the application content area and hides the normal dashboard sidebar. Keep clear title/course/activity, time/status, leave/back and appropriate source controls. OS-level fullscreen and a new native window are not required. Leaving must not lose the session.",
      "source": "docs/master-plan.md#line-55",
      "section": "Study setup and focused conversation",
      "implementation_area": "Focused one-course study/document",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G030": {
      "text": "The primary view is a flowing conversation document: student messages, tutor text, citations, attachments and generated activities remain in chronological context. It is not a workbook, stepper or forced sequence. Do not expose hidden model chain-of-thought; show concise, meaningful activity status instead.",
      "source": "docs/master-plan.md#line-57",
      "section": "Study setup and focused conversation",
      "implementation_area": "Focused one-course study/document",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G031": {
      "text": "Interactives appear inline beside/within their introducing response. Expand opens a larger resizable panel beside the document; collapse returns to the flow. Inline/expanded views share one authoritative activity state and do not reset answers or instantiate divergent copies. Preserve keyboard focus, readable minimum widths and a usable narrow-window fallback.",
      "source": "docs/master-plan.md#line-59",
      "section": "Study setup and focused conversation",
      "implementation_area": "Focused one-course study/document",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G032": {
      "text": "Tutor teaches using grounded explanations, useful examples and genuinely functional graphs, simulations, experiments and other interactives. Each generated activity has a clear learning objective, working controls, meaningful state changes and understandable feedback. Educational correctness matters as much as rendering success.",
      "source": "docs/master-plan.md#line-63",
      "section": "Learning behavior and progress",
      "implementation_area": "Learning activities and evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G033": {
      "text": "After the student confirms understanding, offer/generated practice: quizzes, practice exams, interactive exercises and small assignments. Use practice evidence to revisit prerequisites and adjust difficulty. Student confidence is evidence, not proof of demonstrated understanding. Do not gate all learning behind repeated quizzes or force a rigid sequence.",
      "source": "docs/master-plan.md#line-65",
      "section": "Learning behavior and progress",
      "implementation_area": "Learning activities and evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G034": {
      "text": "Ordinary quizzes default to reviewing answers at the end. A student can request per-answer feedback for ordinary practice. Practice exams withhold hints and solutions until submission; switching to guided practice is allowed but assisted work is distinguished from an independent attempt. Original app-generated practice may have worked explanations; active real coursework remains protected.",
      "source": "docs/master-plan.md#line-67",
      "section": "Learning behavior and progress",
      "implementation_area": "Learning activities and evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G035": {
      "text": "Keep two separate local models: course concepts/prerequisites/source links, and student understanding observations based on attempts, mistakes, assistance and confidence. Keep official school grades separate from app practice scores. Unknown is not weak; one bad grade does not imply inability. Show evidence-backed strengths, areas to practice and recent progress in Today/Study without requiring a new progress page.",
      "source": "docs/master-plan.md#line-69",
      "section": "Learning behavior and progress",
      "implementation_area": "Learning activities and evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G036": {
      "text": "Persist sessions, all messages/parts, visible status, source references and source versions, attachments, artifact content/version/state, attempts, evaluation feedback, context references and appropriate summary/checkpoint metadata. Restore a coherent conversation and activity state after navigating away, app restart or a failed response. Do not serialize executable closures or arbitrary privileged runtime state.",
      "source": "docs/master-plan.md#line-73",
      "section": "Persistence, history and timer",
      "implementation_area": "Durable history, wall clock and independent deletion",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G037": {
      "text": "Study landing supports list, search, course filters, rename, resume and delete. Distinguish saved/in-progress/finished/interrupted and offline states. A late response must not resurrect a deleted session; generation cancellation/idempotency must fence it.",
      "source": "docs/master-plan.md#line-75",
      "section": "Persistence, history and timer",
      "implementation_area": "Durable history, wall clock and independent deletion",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G038": {
      "text": "TIMED SESSIONS USE CONTINUOUS WALL-CLOCK TIME. Persist a deadline, not merely an in-memory decrementing counter. Time continues while minimized, backgrounded, closed or away. This supersedes prior pause-on-leave proposals. Reconcile expired time on resume and test clock/suspend behavior. Expiry shows one coherent summary with Finish, Extend by chosen duration and Continue indefinitely. Do not destroy unsent text or abruptly discard a generation. Untimed start is supported. Implementation retries still have technical bounds; an untimed session is not an unbounded individual API request.",
      "source": "docs/master-plan.md#line-77",
      "section": "Persistence, history and timer",
      "implementation_area": "Durable history, wall clock and independent deletion",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G039": {
      "text": "Deleting a session does not automatically delete its retained memories or learning observations. Independently saved course/Context items remain. Memory/context has separate edit/delete controls. Full account/local-data deletion must remove associated retained data. Do not keep the deleted conversation transcript under the pretext of keeping a small derived memory; clearly distinguish retained derived facts, saved artifacts and deleted session content.",
      "source": "docs/master-plan.md#line-79",
      "section": "Persistence, history and timer",
      "implementation_area": "Durable history, wall clock and independent deletion",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G040": {
      "text": "Context is a separate central page replacing Planner's navigation slot; do not merge it into Connections. A plus button with DropdownMenu adds Text/note, Personal preference/context, Document/PDF and Image/screenshot. Support search/filter, provenance, course association, read/preview, edit where appropriate, remove and ingestion/retry status. User language describes files and learning context, not SQL/vector/agent internals.",
      "source": "docs/master-plan.md#line-83",
      "section": "Context, attachments and memory",
      "implementation_area": "Context sources, scoping and inspectable memory",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G041": {
      "text": "Support PDF, DOCX, TXT, Markdown, PNG, JPEG and WebP. No PPTX or dedicated slides. Include scanned PDFs and handwritten photos through supported Meta multimodal interpretation; expose unreadable/partial/uncertain outcomes and never invent extracted text. Validate actual type and size, not just filename. Research explicit conservative byte/page/image limits and document them in the feature plan; reject unsupported/encrypted/oversized inputs clearly. Disable document macros/external relationships and unsafe remote fetches. No silent non-Meta OCR/model fallback.",
      "source": "docs/master-plan.md#line-85",
      "section": "Context, attachments and memory",
      "implementation_area": "Context sources, scoping and inspectable memory",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G042": {
      "text": "Uploads remain with the session and can optionally be saved/linked to Context or one course. Context also supports independent upload. Generated explanations/interactives can be saved to Context and optionally directly to a course with AI-generated provenance and original source/session references. Preserve independently saved items when deleting a session; avoid reference cycles and accidental shared-lifecycle deletion.",
      "source": "docs/master-plan.md#line-87",
      "section": "Context, attachments and memory",
      "implementation_area": "Context sources, scoping and inspectable memory",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G043": {
      "text": "Separate navigation knowledge (where/how to find resources), academic source materials (what they say), personal preferences, inferred learning observations and policy/permission state. Retrieval must be bounded, account/course scoped and provenance preserving. Archive source versions cited by prior messages so a later sync does not silently rewrite an old explanation's evidence.",
      "source": "docs/master-plan.md#line-89",
      "section": "Context, attachments and memory",
      "implementation_area": "Context sources, scoping and inspectable memory",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G044": {
      "text": "Automatically remember explicit feedback such as shorter explanations or simpler vocabulary through a typed, scoped memory tool. Inferred preferences/understanding remain provisional and revisable. Expose memories for inspection, edit and deletion; explicit corrected preferences outrank older inferences. Notes or memories cannot grant grade access, source access, verified completion or permission to answer active coursework. Imported text and files remain untrusted source data.",
      "source": "docs/master-plan.md#line-91",
      "section": "Context, attachments and memory",
      "implementation_area": "Context sources, scoping and inspectable memory",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G045": {
      "text": "Finish existing context/sync work before new features. Discover observed course destinations, cache verified per-course/purpose navigation, reuse known assignment/announcement/material destinations on refresh and repair from a known parent when changed. Do not treat cache as permanent truth. Do not keep re-exploring the entire LMS when a verified destination works.",
      "source": "docs/master-plan.md#line-95",
      "section": "Sync reliability and navigation memory",
      "implementation_area": "Existing source foundation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Existing foundation preserved/reconciled first in checkpoint/integration, not sequential packet dispatch.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G046": {
      "text": "Identity matching and transactional upsert must prevent duplicates against the database, within a returned batch and across concurrent/retried scans. Prefer source stable IDs, then verified scoped canonical URLs, then conservative scoped fallback. Similar names alone must not merge different terms/sections. Guard course/account/resource scope and preserve existing references/IDs when enriching records.",
      "source": "docs/master-plan.md#line-97",
      "section": "Sync reliability and navigation memory",
      "implementation_area": "Existing source foundation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G047": {
      "text": "Only complete successful collection evidence may retire missing source records. Cancelled/partial/paginated/failed/rate-limited/needs-sign-in scans preserve prior records and evidence. Keep manual records outside source retirement. User deletion/hiding uses identity suppression/tombstones as appropriate; a later scan must not recreate deliberately suppressed records automatically. Provide a way to undo/restore suppression.",
      "source": "docs/master-plan.md#line-99",
      "section": "Sync reliability and navigation memory",
      "implementation_area": "Existing source foundation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G048": {
      "text": "Updates preserve user-authored notes/edits with explicit provenance/conflict handling. Reconciliation notes can guide finding the correct resource or suppressing display, but are not authoritative evidence of grade/completion. Do not mutate LMS records. Background sync/watch obey opt-in, current connection permissions, account scope, pacing/cooldowns and cancellation, and maintain context incrementally.",
      "source": "docs/master-plan.md#line-101",
      "section": "Sync reliability and navigation memory",
      "implementation_area": "Existing source foundation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G049": {
      "text": "Grade access defaults off. Settings offers one student-controlled switch for all otherwise authorized connections, with an optional notes textarea when enabled. Do not add mandatory per-course controls. The AI cannot turn this on itself. Honor additional access restrictions conservatively; freeform notes cannot expand authorized source boundaries.",
      "source": "docs/master-plan.md#line-105",
      "section": "Grades and coursework integrity",
      "implementation_area": "Grade and cumulative integrity boundary",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G050": {
      "text": "Turning grade access off stops collection and use immediately, cancels/discards in-flight grade operations appropriately and invalidates grade-dependent retrieval/recommendation caches. Offer deletion of collected grade data. Separate official grades/feedback from assignment maximum points and app practice scores. Do not remove school resources merely because grades are disabled.",
      "source": "docs/master-plan.md#line-107",
      "section": "Grades and coursework integrity",
      "implementation_area": "Grade and cumulative integrity boundary",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G051": {
      "text": "External coursework defaults to active/unknown. Completed-work answer explanations require connected-source evidence of completion, an actual grade and no remaining submission/resubmission/retake opportunity. A valid zero, pass/fail or other supported grading scale must not be rejected as false/missing. Submission alone, age of work, a student assertion, local checkbox, user note or uploaded marked PDF does not unlock answers. If evidence is missing, conflicting, stale in a consequential way or access is revoked, stay conservative. Refresh/verify before upgrading answer permission, and downgrade when new evidence shows reopening/remaining attempts.",
      "source": "docs/master-plan.md#line-109",
      "section": "Grades and coursework integrity",
      "implementation_area": "Grade and cumulative integrity boundary",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G052": {
      "text": "Mark-complete is a verification request, not an authority override. Local hide/delete affects organization/suppression, not assistance policy. Retain minimal task identity/protection evidence needed to avoid bypass by deletion/renaming/new session; full data deletion still works. Do not silently refetch suppressed academic content or grades after revocation.",
      "source": "docs/master-plan.md#line-111",
      "section": "Grades and coursework integrity",
      "implementation_area": "Grade and cumulative integrity boundary",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G053": {
      "text": "Active/unknown real assignments receive concept explanations, requirements clarification, hints and nudges, using genuinely different practice examples where helpful. Never provide exact answers, submission-ready sentences/paragraphs, full derivations of the actual assigned question, or an accumulation of smaller hints that reconstructs them. This includes writing, math, code and other subjects. Never submit, edit grades, answer quizzes or perform coursework on the academic site.",
      "source": "docs/master-plan.md#line-113",
      "section": "Grades and coursework integrity",
      "implementation_area": "Grade and cumulative integrity boundary",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G054": {
      "text": "Integrity checks span the original assignment/question identity, paraphrases, prior assistance across sessions, memory requests, attachments and generated artifact code/text/hidden values. Claims of being a teacher or having already finished do not alter policy. Source documents can contain hostile instructions and are not system messages. Guard tool execution and permission decisions in code, with Meta-based assessment as an aid rather than the permission boundary.",
      "source": "docs/master-plan.md#line-115",
      "section": "Grades and coursework integrity",
      "implementation_area": "Grade and cumulative integrity boundary",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G055": {
      "text": "Check restricted response/artifact content before making it visible or playable. Do not leak disallowed content via incremental streaming, source previews, artifact HTML/JS, hidden answer data, generated text attachments or error logs. If a candidate is rejected, regenerate a safe conceptual response with bounded retries or show a helpful safe fallback. Record content-free diagnostic evidence; do not claim the checks are infallible.",
      "source": "docs/master-plan.md#line-117",
      "section": "Grades and coursework integrity",
      "implementation_area": "Grade and cumulative integrity boundary",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G056": {
      "text": "Allow flexible model-generated HTML/CSS and bounded JavaScript, not only a tiny fixed catalog. Use a researched isolated execution surface: no Node/Electron/preload/IPC privileges, academic-browser cookies, filesystem, account secrets, arbitrary network, popups, top navigation or downloads. Content validation and sanitization are additional layers, not the isolation boundary. Do not allow same-origin access to privileged app content. Apply CSP, permission/navigation policies, resource limits and controlled dependencies; prove the actual Electron implementation rather than merely writing iframe attributes.",
      "source": "docs/master-plan.md#line-121",
      "section": "Generated activity execution",
      "implementation_area": "Actual isolated generated runtime",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G057": {
      "text": "The host controls save/restore and activity messages through a versioned schema with explicit source/session/artifact IDs, sender validation and bounded payloads. Never accept an artifact's request to read arbitrary context or invoke an application tool. Do not trust artifact-reported practice grades as official grades or authoritative learning evidence without appropriate host validation.",
      "source": "docs/master-plan.md#line-123",
      "section": "Generated activity execution",
      "implementation_area": "Actual isolated generated runtime",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G058": {
      "text": "Store immutable artifact versions plus serializable inputs/progress. Updates preserve prior versions and recover after an invalid generation; opening an old version is not regeneration. Test restoring quizzes, simulation parameters, canvas state where supported, expansion/collapse and reopening offline. Allow reset of an activity without losing the original attempt history. Bundle approved runtime dependencies so saved activities work offline; don't execute arbitrary CDN scripts.",
      "source": "docs/master-plan.md#line-125",
      "section": "Generated activity execution",
      "implementation_area": "Actual isolated generated runtime",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G059": {
      "text": "Generated content adopts read-only design tokens/approved styles where possible; the app-owned host/chrome uses shared UI primitives. The generated isolated exercise is not allowed to import privileged application React components or receive the preload bridge merely to reuse a Card.",
      "source": "docs/master-plan.md#line-127",
      "section": "Generated activity execution",
      "implementation_area": "Actual isolated generated runtime",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G060": {
      "text": "All ScholarOS AI calls use Meta models: tutoring, classification, extraction, vision, evaluation, guardrails and speech transcription. Hosting can use the existing configured Meta-serving provider; a provider/client name is not proof of the model family. Validate the actual configured model and endpoint against current official support. Do not silently fall back to another model or a data-contributing mode. The Hermes development agents' own selected models are a separate configuration and are not changed by this product requirement.",
      "source": "docs/master-plan.md#line-131",
      "section": "Meta-only inference and dictation",
      "implementation_area": "Meta-only bounded inference and editable dictation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G061": {
      "text": "Use existing Vercel AI SDK integration and typed environment schemas. Provider credentials stay server-side; authorized desktop requests carry only bounded required evidence, never browser credentials. Preserve cancellation, rate limits, structured validation, authentication, timeouts and error states. Keep full academic history locally; send bounded context to cloud inference rather than assuming everything fits or is free to upload. Minimize content logging and do not enable provider-training defaults.",
      "source": "docs/master-plan.md#line-133",
      "section": "Meta-only inference and dictation",
      "implementation_area": "Meta-only bounded inference and editable dictation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G062": {
      "text": "Microphone capture uses explicit app/OS permission, clear recording/stop/cancel state and Meta transcription. Show provisional/ghost transcript while speaking, commit final text to an editable composer and require Send. Do not duplicate partial/final segments, overwrite existing typed text or auto-send an incorrect transcript. Stop recording on cancel, session exit, account change or permission revocation. Tutor replies text only. Do not store raw microphone audio by default after the operation; preserve chosen transcript messages. Explain transmission to Meta before first use.",
      "source": "docs/master-plan.md#line-135",
      "section": "Meta-only inference and dictation",
      "implementation_area": "Meta-only bounded inference and editable dictation",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G063": {
      "text": "Today summarizes connection/configuration issues, sync/indexing/freshness state, upcoming assignments/exams/deadlines, announcements, recent courses/materials, recent study sessions, progress and quick actions. Recommend what to study next using authorized course evidence, deadlines, practice history and preferences, plus grades only when permitted. Give concise reasons and source links. Include useful loading, empty, insufficient-context, partial, error and offline states; never invent urgency or imply an unknown date is a confirmed deadline.",
      "source": "docs/master-plan.md#line-139",
      "section": "Today, Settings and notifications",
      "implementation_area": "Today, Settings/device and private outcomes",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G064": {
      "text": "Settings uses clear sections and full-width well-labeled inputs: account, device/academic browser, connections/access, personal learning context, AI/navigation behavior, background sync/watch, grades, notifications, appearance/accessibility and local data controls. Preserve valid autosave, pending changes and visible failure/retry state; do not introduce a Save button where autosave is the established pattern.",
      "source": "docs/master-plan.md#line-141",
      "section": "Today, Settings and notifications",
      "implementation_area": "Today, Settings/device and private outcomes",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G065": {
      "text": "Allow changing/rebuilding the academic browser after onboarding and configuring a new local device for an existing account. Account login does not mean the new device has a local browser profile/consent or local data. Preserve old workspace until a replacement is verified; browser reconfiguration is serialized with service work and cancels/pauses affected operations safely. Do not copy personal browser profiles or imply cloud academic-data sync exists.",
      "source": "docs/master-plan.md#line-143",
      "section": "Today, Settings and notifications",
      "implementation_area": "Today, Settings/device and private outcomes",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G066": {
      "text": "Notifications have a master switch and a reasonably organized list of per-event switches: connection needs attention, sync completed/failed, context processing completed/failed, tutor/activity ready while away, session timer finished and optional upcoming-deadline reminders. Research OS permission flow, dedupe, quiet hours and app-focus suppression. No OS permission prompt simply from opening Settings; request through explicit enable action. Defaults: notifications off, no sensitive grade/question text in OS previews, no duplicate app and OS alerts. Never fabricate a completion notification for merely queued work.",
      "source": "docs/master-plan.md#line-145",
      "section": "Today, Settings and notifications",
      "implementation_area": "Today, Settings/device and private outcomes",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G067": {
      "text": "The user explicitly authorizes logical work for improving this application: research, code changes, appropriate dependency installation after review, local/background commands, real provider/API calls with existing keys, read-only authorized LMS browsing, live clicking/UI verification, builds, focused commits, pushes, PR creation and normal merging. Do not repeatedly ask for permission to test or to use configured resources. Use bounded tests and existing approved credentials without printing their values or spending unbounded resources.",
      "source": "docs/master-plan.md#line-149",
      "section": "Autonomous working permission and attention policy",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G068": {
      "text": "Preserve unknown or unrelated information. No broad deletion, repository wipe, uninspected cleanup, reset-hard/clean of user work, destruction of academic/browser data, or replacement of the working installation simply to simplify testing. Product-level delete features must be tested on fixtures/test-owned data and designed to respect actual user intent.",
      "source": "docs/master-plan.md#line-151",
      "section": "Autonomous working permission and attention policy",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G069": {
      "text": "Do not change account security, credentials, authentication-provider settings, OS security/privacy permissions or other sensitive access configuration. Do not complete MFA, password/reset flows, consent grants or new sign-ins for the user. Existing authenticated sessions and API credentials may be used within their configured scope. Implementing the application's required permission/integrity/isolation safeguards remains in scope; this restriction is about taking sensitive access/account actions, not omitting the specified product defenses. If access/security work needs intervention, notify the user and move to independent authorized work.",
      "source": "docs/master-plan.md#line-153",
      "section": "Autonomous working permission and attention policy",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G070": {
      "text": "When a missing key, unavailable permission/session, required configuration or other genuine intervention need appears, immediately send a concise alert to the configured Buzz channel. Include the feature/task, the provider/key NAME or action needed, why it matters, what is blocked and what work continues. NEVER send a key value, token, password, cookie or private academic payload. Do not ask the user to paste secrets into Buzz. The controller's `notice` command uses the default Hermes Buzz destination; the kickoff agent must verify it is the intended channel or explicitly set the run's notify target.",
      "source": "docs/master-plan.md#line-155",
      "section": "Autonomous working permission and attention policy",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G071": {
      "text": "Example from an assigned worker (use a stable issue key so retries do not spam):",
      "source": "docs/master-plan.md#line-157",
      "section": "Autonomous working permission and attention policy",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G072": {
      "text": "```bash\n~/.hermes/bin/plan-workflow notice RUN_ID --key missing-meta-transcribe-key --file /absolute/path/to/sanitized-attention.txt\n```",
      "source": "docs/master-plan.md#line-159",
      "section": "Autonomous working permission and attention policy",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G073": {
      "text": "This is an alert, not a request to pause all work. Do not wait for a reply before doing independent research, local implementation, fixtures, other runnable packages or verification that can proceed. Persist the blocked operation and resume it when the configuration changes. If delivery fails, queue the alert and retry; do not stop the run merely because the user is unreachable. Never fake a real-API test or mark a blocked acceptance criterion complete. If every remaining task truly depends on the missing input, keep an honest waiting/retry state rather than making unauthorized access changes or pretending progress. User silence is not authorization for the restricted actions above.",
      "source": "docs/master-plan.md#line-163",
      "section": "Autonomous working permission and attention policy",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G074": {
      "text": "Before recommending a new dependency in a feature implementation plan, and before installing/adding it or materially upgrading one, use the configured Socket.dev MCP to review the exact package/ecosystem/version and dependency/security signals. Record that result in a dependency decision note linked from the feature card. A package manager install completing successfully is not a security review.",
      "source": "docs/master-plan.md#line-167",
      "section": "Dependency selection and Socket review",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G075": {
      "text": "Also inspect the package's official registry and upstream repository: version/release recency, maintenance/commit activity, responsive issue/security handling, maintainers, license/platform compatibility, GitHub stars/community and registry downloads over a stated period. Prefer established, maintained projects with strong evidence and already-installed suitable libraries. Popularity is supporting evidence, not proof of safety; do not invent hard star/download guarantees, trust typosquats, or discard a justified specialist library solely because it is smaller.",
      "source": "docs/master-plan.md#line-169",
      "section": "Dependency selection and Socket review",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G076": {
      "text": "Record alternatives, why the existing dependency set is insufficient, selected version/range, Socket findings and the maintenance/adoption evidence date. Reject risky/unmaintained alternatives and choose a better fit. Do not run unknown install scripts or alter authentication/security settings to force a package through. If Socket or a required registry is unavailable, continue independent work or use an already-vetted installed solution; do not label an unperformed review passed. Notify the user if a necessary unresolved dependency decision blocks execution. Review lockfile changes and avoid unrelated broad upgrades.",
      "source": "docs/master-plan.md#line-171",
      "section": "Dependency selection and Socket review",
      "implementation_area": "Permission, alerts and reviewed dependencies",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G077": {
      "text": "- Reuse actual `@scholaros/ui/components/...` primitives for Card/CardContent/CardHeader, Button, Input/Textarea, Select/Combobox, Switch, Dialog/AlertDialog, DropdownMenu, Tabs, Empty, Tooltip, Resizable, Message, Attachment and other available equivalents. A styled div is not an acceptable replacement where a suitable primitive exists. Layout containers and genuinely custom visualizations are still allowed.",
      "source": "docs/master-plan.md#line-175",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G078": {
      "text": "- Search existing shared/feature helpers and callers before adding code. Extend a suitable implementation; do not create parallel sync stores, a second academic scheduler, duplicate model clients or redundant query abstractions.",
      "source": "docs/master-plan.md#line-176",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G079": {
      "text": "- Use existing semantic tokens, typography, themes and accessibility patterns. Avoid one-off border/background/radius copies; use variants or a justified shared primitive extension. In app UI use the repository's text-size, spacing, `cn`, formatter, `LoadingSwap` and `useConfirm` conventions.",
      "source": "docs/master-plan.md#line-177",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G080": {
      "text": "- Research current shadcn AI Elements/AI SDK v7 patterns, but adapt them to Electron/React and the existing shared package. Do not blindly copy a Next.js-only component or duplicate components already present.",
      "source": "docs/master-plan.md#line-178",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G081": {
      "text": "- Use installed UI Skills and Motion Design selectively for relevant work; reduced motion, focus, keyboard operation, labels, contrast and real feedback are required. Animations must not delay reading or conceal work/state.",
      "source": "docs/master-plan.md#line-179",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G082": {
      "text": "- Reviewer must inspect component imports and rendered flows to catch fake primitives and duplicated helpers. Record justified exceptions. Do not satisfy this with a brittle test banning every div/class.",
      "source": "docs/master-plan.md#line-180",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Shared primitive inspection retained; actor is integration/combined verification, NO local Reviewer stage.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G083": {
      "text": "- Follow lowercase kebab-case authored filenames, repository export/type/schema conventions, short comments, current docs and test-first feature development. No dedicated schema-file tests; check schemas/migrations through review, typechecking and behavioral data/service tests.",
      "source": "docs/master-plan.md#line-181",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G084": {
      "text": "- Aim for coherent implementation packages under ten files, with explicit interface/dependency ownership. The user has authorized this larger plan and parallel execution; do not stop to request approval merely because a whole feature spans more files. Split into smaller verified chunks.",
      "source": "docs/master-plan.md#line-182",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G085": {
      "text": "- One owner coordinates shared migrations/contracts. Independent writers use separate worktrees; serially integrate overlapping files. Do not rewrite someone else's history or remove user's unrelated local work.",
      "source": "docs/master-plan.md#line-183",
      "section": "UI and engineering requirements",
      "implementation_area": "Shared UI, conventions and isolated ownership",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G086": {
      "text": "Researcher must use the following stable feature IDs and preserve this order/dependencies unless the user steers. The first feature is in progress and carries continuation metadata in `docs/master-plan-features.json`. All future features are planned, not completed. Each feature gets a detailed research implementation guide, Coder packages, independent review and evidence before shipping. The sections below identify existing anchors; confirm real APIs and filenames before implementation. Proposed new paths are responsibility suggestions, not assertions that files already exist.",
      "source": "docs/master-plan.md#line-187",
      "section": "Ordered feature execution",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Stable feature/requirement IDs retained; feature dependency sequencing replaced by32 independent packets.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G087": {
      "text": "The product requirements above are deliberately more detailed than the implementation prescription. Researcher owns current official-documentation research, compatibility checks against installed versions, technology choices inside these constraints, precise code paths/symbols, contracts, migrations, test design and ordered instructions for the cheaper Coder model. Do not turn an unanswered implementation detail into an unnecessary product interview.",
      "source": "docs/master-plan.md#line-500",
      "section": "Researcher and agent execution contract",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G088": {
      "text": "For each feature, Researcher must deliver:",
      "source": "docs/master-plan.md#line-502",
      "section": "Researcher and agent execution contract",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G089": {
      "text": "1. The user outcome and all relevant requirement/acceptance IDs, including cross-cutting rules and inherited behavior.\n2. Actual repository state and existing reusable implementations; what is done, partial, unverified or still missing. Verify completion before skipping work.\n3. Specific product flows and UI states: entry points, choices, normal path, exit/resume, loading, empty, partial, invalid, unavailable, permission-denied and recovery behavior.\n4. A detailed implementation guide with exact current files/symbols and any proposed new responsibilities; data/permission boundaries, versioned interfaces and source-of-truth rules; concurrency and cancellation cases; backward compatibility/migrations; safe defaults and bounded resource behavior.\n5. Small work packages with ownership, ordered dependencies, sufficient background, numbered changes, expected outcomes, test-first behavioral checks and focused live-verification scenarios. Lower-cost Coder workers should not need to reconstruct product intent.\n6. Current primary documentation supporting technical choices, verified against installed libraries. Dependencies already present should be preferred when suitable. Do not silently change major framework/model/provider architecture to match an example.\n7. A requirement-to-verification matrix and a precise handoff. Save assumptions and research artifacts on Kanban; label unverified external/hardware gates.",
      "source": "docs/master-plan.md#line-504",
      "section": "Researcher and agent execution contract",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G090": {
      "text": "Coder reads the master plan, feature plan, existing code and all predecessor receipts before working. Respect scoped repo instructions, test-first behavior, shared primitives and isolated worktrees. Commit clean focused changes as they become verified. Follow this project's `type: description` commit subjects, without scopes/parentheses, and review staged hunks. Produce a detailed handoff mapping requirements to files/symbols, commits, tests actually run, live paths exercised, remaining risks and important reviewer locations.",
      "source": "docs/master-plan.md#line-512",
      "section": "Researcher and agent execution contract",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G091": {
      "text": "Reviewer reads the original master/feature plans and integrated diff, inspects surrounding behavior and independently tests relevant flows. Check correctness, source permissions, grade/integrity boundaries, arbitrary-HTML isolation, persistence, cancellation, concurrency, offline/error states, accessibility and real shared UI imports. Return findings as concrete reproducible packets: stable ID, severity/impact, exact location, expected/actual, root-cause evidence, numbered fix steps and verification assertions that a weaker Coder can execute.",
      "source": "docs/master-plan.md#line-514",
      "section": "Researcher and agent execution contract",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Critical independent combined checks retained; no Reviewer agent dispatched.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G092": {
      "text": "Use the installed `autonomous-plan-cycle` controller and shared skill. Do not run a second chat loop or create a competing board. Initialize one run with the repository and this file; its board is `wf-<run-id>`. Use `docs/master-plan-features.json` as the initial feature index/continuation seed; the Markdown plan is authoritative if they diverge, so reconcile the manifest after a user change rather than blindly executing stale metadata.",
      "source": "docs/master-plan.md#line-518",
      "section": "Autonomous handoffs and limits",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G093": {
      "text": "Stages: Researcher index -> Researcher feature plan -> Coder resume checkpoint when continuing existing work -> Coder decomposition -> up to three concurrent Coder package workers -> one Coder integration -> independent Reviewer -> fixes/review -> push/create or reuse PR -> observe existing default Greptile review -> warranted fixes -> independent Reviewer/fixes -> final push/normal merge -> local main synchronization -> next feature's Researcher.",
      "source": "docs/master-plan.md#line-520",
      "section": "Autonomous handoffs and limits",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Replaced by CURRENT whole-product two-pass stage sequence.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G094": {
      "text": "Each Coder package worker may use up to four flat subagents with bounded tool loops and unique writing worktrees. Children inherit the current plan controls and authorized permission boundaries. Share explicit contracts; do not have multiple children edit the same directory or create recursive uncontrolled fan-out. Shared desktop GUI tests require the existing cooperative lock under `~/.hermes/locks/gui-testing.lock`; hold it for the full scenario and release only your own verified ownership. Terminal tests can run concurrently when independent.",
      "source": "docs/master-plan.md#line-522",
      "section": "Autonomous handoffs and limits",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "NO nested writing subagent fan-out in32-worker passes; isolated native packets only.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G095": {
      "text": "There is an initial independent review plus at most two Coder-fix/Reviewer-rereview exchanges in each local review phase, including the post-cloud phase. At the cap record residual findings and proceed to the next configured stage. Do not create an endless Reviewer ping-pong. Actual failing required checks, unauthorized access and GitHub protections still require remediation/retry; a round cap does not make them pass or permit an administrative bypass. Distinguish advancing a workflow stage from declaring a release ready.",
      "source": "docs/master-plan.md#line-524",
      "section": "Autonomous handoffs and limits",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "No Reviewer ping-pong phases; two broad passes do not waive failed tests.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G096": {
      "text": "Greptile runs at most the one default automatic PR review. Before first publication commit effective `.greptile/config.json` with open-only automatic review and update/draft triggering disabled; audit overriding configuration. Never manually trigger a review through MCP, bot mentions/comments, review-request APIs/labels, reruns or close/reopen/draft-ready cycling. Reuse an existing PR and the first persisted review snapshot across retries, revised plans and runs. If no default review appears in the controller's observation window, record that and continue; never force one. Later fixes are evaluated by the local Reviewer and required tests. Human/external actions outside this workflow are not a guarantee the agents can control.",
      "source": "docs/master-plan.md#line-526",
      "section": "Autonomous handoffs and limits",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Replaced: autoReview[], updates/drafts false; controller alone ONE explicit Apex, wait for actual completion.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G097": {
      "text": "Push/open/reuse a PR for the feature integration branch, address captured cloud findings with tested focused commits, then merge normally when GitHub permits it. Independently verify actual MERGED state and synchronize local main without overwriting dirty user work. Never force-push, admin-bypass branch protections or fabricate a merge/CI result. Preserve worktrees/source branches and evidence for review.",
      "source": "docs/master-plan.md#line-528",
      "section": "Autonomous handoffs and limits",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "One whole-product PR/review/fix32/final normal merge and local sync, not per-feature PRs.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G098": {
      "text": "Long work persists receipts, comments and honest heartbeats/checkpoints at least every 10–15 minutes when control is available. Worker budgets are ceilings, not targets. Transient failures retry with backoff and durable state; no automatic pause because of a time estimate or review round cap. Report concrete credentials/hardware/external blockers and continue independent authorized work. Only the user pauses the overall run. Do not interpret a model error or context limit as product completion.",
      "source": "docs/master-plan.md#line-530",
      "section": "Autonomous handoffs and limits",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G099": {
      "text": "The user may change priorities/requirements during execution, update this master plan, request a different implementation approach or pause/resume. Read live controls before work, at milestones and before consequential actions. New instructions take precedence; checkpoint current work and avoid publishing/merging stale revisions. Do not discard previous artifacts or commits when re-indexing. Reconcile old accepted work against new requirements and preserve stable feature/requirement IDs where possible.",
      "source": "docs/master-plan.md#line-534",
      "section": "User steering",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G100": {
      "text": "Use `~/.hermes/bin/plan-workflow status <run-id>` and `events <run-id>` plus Kanban for progress. `steer <run-id> --text '...'` adds live directions. `pause`/`resume` are cooperative controls, not claims that an already running shell command was instantly killed. The original registered plan file is the editable source; controller snapshots and release reports do not replace it.",
      "source": "docs/master-plan.md#line-536",
      "section": "User steering",
      "implementation_area": "Current controller workflow and explicit overrides",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G101": {
      "text": "Confirm available scripts and installed runtime before running commands; prefer focused checks as changes land, then the combined affected suite before integration/ship. Do not run dedicated tests of schema/table definition files. Use behavioral store/service/migration scenarios, typechecking and review for schema changes. Do not mutate live Schoology data to test destructive paths.",
      "source": "docs/master-plan.md#line-540",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G102": {
      "text": "Current workspace entry points include:",
      "source": "docs/master-plan.md#line-542",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G103": {
      "text": "```bash\npnpm --filter @scholaros/services test\npnpm --filter @scholaros/desktop test\npnpm --filter @scholaros/web test\npnpm --filter @scholaros/services typecheck\npnpm --filter @scholaros/desktop typecheck\npnpm --filter @scholaros/web typecheck\npnpm --filter @scholaros/ui typecheck\npnpm lint\npnpm format:check\npnpm --filter @scholaros/web build\npnpm --filter @scholaros/desktop package\n```",
      "source": "docs/master-plan.md#line-544",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G104": {
      "text": "Researcher verifies the actual desktop test/native-module runtime and package/build prerequisites rather than assuming any command above was already run. Use focused workspace invocations, preserve outputs/artifacts and report pre-existing failures. Do not run the repository-wide write formatter over unrelated existing work. Package/make/signing actions can produce artifacts; inspect platform prerequisites and keep the working installation/user data safe.",
      "source": "docs/master-plan.md#line-558",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G105": {
      "text": "A live feature verification record states: requirement IDs; exact commit; environment/app versions; source/connection scope without secrets; action sequence; expected/observed results; artifacts/screenshots kept locally; and untested limits. Assertions such as 'computer use unavailable' require discovering/trying the currently configured native tool, not repeating old conversation failures. Use simulated fixtures for error paths that cannot safely be produced on the real account.",
      "source": "docs/master-plan.md#line-560",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G106": {
      "text": "Minimum combined adversarial/reliability matrix:",
      "source": "docs/master-plan.md#line-562",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G107": {
      "text": "- Source identity duplicates within batch, database and concurrent/retry paths; genuine same-name different courses remain distinct.",
      "source": "docs/master-plan.md#line-564",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G108": {
      "text": "- Partial/cancelled/rate-limited/expired-session sync preserves existing data; source deletion versus user suppression versus manual data remains distinct.",
      "source": "docs/master-plan.md#line-565",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G109": {
      "text": "- Cross-account/course reads, spoofed IPC/messages, cancelled or late responses, sign-out and permission-revocation races.",
      "source": "docs/master-plan.md#line-566",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G110": {
      "text": "- Grade missing/zero/pass-fail/unknown, still-open/reopened/resubmittable/multi-attempt assessment, stale conflicting completion, local checkbox/notes/uploaded-score claims.",
      "source": "docs/master-plan.md#line-567",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G111": {
      "text": "- Incremental active-answer construction across turns and sessions; role-play, paraphrase, foreign instructions in files, source previews, memory requests and hidden artifact values.",
      "source": "docs/master-plan.md#line-568",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G112": {
      "text": "- Generated activity parent/preload/file/cookie/network/navigation/message abuse, resource exhaustion, invalid output and state/schema version mismatch.",
      "source": "docs/master-plan.md#line-569",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G113": {
      "text": "- Draft/transcript edits, microphone permission/cancel/revoke, offline/reconnect, app restart, wall-clock expiry after sleep/closure and indefinite continuation.",
      "source": "docs/master-plan.md#line-570",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G114": {
      "text": "- Artifact state restored inline and expanded; independently saved items and retained derived memories survive session deletion as intended; full data deletion actually removes them.",
      "source": "docs/master-plan.md#line-571",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G115": {
      "text": "- Real shared primitives, accessible keyboard/focus/labels, reduced motion, narrow/large windows, empty/error/processing states and no sensitive OS notification preview.",
      "source": "docs/master-plan.md#line-572",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G116": {
      "text": "Do not call a feature complete from code presence, test-file count or a card label alone. Keep feature completion, demo readiness, macOS release readiness and pending Windows validation as separate report fields. Researcher may skip a genuinely already-complete feature only with explicit current evidence.",
      "source": "docs/master-plan.md#line-574",
      "section": "Verification and release evidence",
      "implementation_area": "Combined behavioral/adversarial/release evidence",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G117": {
      "text": "Finish F01 first. Establish the reusable context/permissions/session/tutor path next, then functional generated activities and practice. Add adaptation, dictation, Today, reconfiguration and notifications to complete the product; do not silently drop them to hit the estimate. At meaningful checkpoints summarize the real end-to-end capability and the remaining features so the user can steer. Parallelize independent packages inside features rather than skipping prerequisites.",
      "source": "docs/master-plan.md#line-578",
      "section": "Delivery priorities and non-goals",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Full scope/legacy priority retained;32 independent packets after common checkpoint, integrate/test foundation first.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G118": {
      "text": "The final product is ready when all specified feature acceptance criteria have evidence, relevant required checks pass, source/integrity/isolation boundaries hold under the recorded tests, the Mac installation and real Schoology demo work, and remaining external/hardware release limitations are explicit. No unverified legal, platform, accessibility or security certification claims. No arbitrary product age gate is introduced, but data minimization, transparent cloud processing and age-appropriate learning remain required; Researcher must identify applicable public-launch consent/privacy obligations rather than claiming that removing an age selector resolves them.",
      "source": "docs/master-plan.md#line-580",
      "section": "Delivery priorities and non-goals",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G119": {
      "text": "Out of scope: payments, subscriptions, PPTX/slides, non-English localization, tutor audio synthesis, continuous speech-to-speech, multi-course sessions, a Planner page, cloud academic-history synchronization, broad LMS-coverage promises without evidence, completion/submission of school assignments, and silently replacing Meta models. Do not add these without a user change.",
      "source": "docs/master-plan.md#line-582",
      "section": "Delivery priorities and non-goals",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G120": {
      "text": "These are starting references, not substitutes for version-specific feature research:",
      "source": "docs/master-plan.md#line-586",
      "section": "Primary research starting points",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G121": {
      "text": "- Meta models and speech transcription: <https://dev.meta.ai/docs/overview> and <https://dev.meta.ai/docs/models>.",
      "source": "docs/master-plan.md#line-588",
      "section": "Primary research starting points",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G122": {
      "text": "- AI SDK conversation persistence and streaming: <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence> and the installed v7 documentation/types.",
      "source": "docs/master-plan.md#line-589",
      "section": "Primary research starting points",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G123": {
      "text": "- Current shadcn AI patterns: <https://ui.shadcn.com/docs/ai-elements> and existing `packages/ui` components.",
      "source": "docs/master-plan.md#line-590",
      "section": "Primary research starting points",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G124": {
      "text": "- Electron security and process isolation: <https://www.electronjs.org/docs/latest/tutorial/security> and <https://www.electronjs.org/docs/latest/tutorial/sandbox>.",
      "source": "docs/master-plan.md#line-591",
      "section": "Primary research starting points",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G125": {
      "text": "- Greptile open-only review configuration: <https://www.greptile.com/docs/code-review/greptile-json-reference>.",
      "source": "docs/master-plan.md#line-592",
      "section": "Primary research starting points",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": "Documentation reference retained; open-only configuration replaced by autoReview[]/one controller Apex.",
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    "G126": {
      "text": "- The repository's current `docs/SPEC.md`, `AGENTS.md`, workspace manifests and source/test callers establish local constraints and behavior.",
      "source": "docs/master-plan.md#line-593",
      "section": "Primary research starting points",
      "implementation_area": "Full scope, current primary sources and release gates",
      "verification_documents": [
        "whole-product-guide.md",
        "shared-contracts.md",
        "api-contracts.md",
        "combined-verification.md"
      ],
      "workflow_override": null,
      "status": "blocked",
      "evidence_paths": [],
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    }
  },
  "checks": [
    {
      "id": "C001",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop test tests/whole-product.integration.test.ts",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C023",
      "command_or_journey": "VITE_API_URL=http://127.0.0.1:39787 SCHOLAROS_PACKAGED_RUNTIME_PROBE=1 /opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop package",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C024",
      "command_or_journey": "VITE_API_URL=http://127.0.0.1:39787 RUN_PACKAGED_PRODUCT_INSPECTION=1 RUN_PACKAGED_PRODUCT_SMOKE=1 /opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop test tests/packaged-product.integration.test.ts",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C002",
      "command_or_journey": "VITE_API_URL=http://127.0.0.1:39787 RUN_PACKAGED_PRODUCT_INSPECTION=1 RUN_PACKAGED_PRODUCT_INTEGRATION=1 /opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop test tests/packaged-product.integration.test.ts",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C003",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop test",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C004",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/services test",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C005",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/web test",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C006",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop typecheck",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C007",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/services typecheck",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C008",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/web exec tsc --noEmit",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C009",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/ui typecheck",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C010",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm lint",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C011",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm format:check",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C012",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/web build",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C013",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop package",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C014",
      "command_or_journey": "/opt/homebrew/bin/python3 /Users/danieldao/.hermes/workflows/plan-cycle/heavy_check.py -- pnpm --filter @scholaros/desktop exec drizzle-kit check",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C015",
      "command_or_journey": "Focused real-session journey; record identities, counts, requests, successful route reuse/repairs, timing, coverage, and freshness without changing LMS data.",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C016",
      "command_or_journey": "Use existing authorized configuration only; record model/endpoint category and bounded counters, never keys or academic content.",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C017",
      "command_or_journey": "Acquire /Users/danieldao/.hermes/locks/gui-testing.lock for the complete scenario; use fixture data for destructive cases.",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C018",
      "command_or_journey": "Run the packaged-product harness against the integrated .app; inspect fuse wire and verify real activity, PDF, Stagehand, SDK, worklet and offline state paths.",
      "result": "blocked",
      "evidence_path": null,
      "blocking": true,
      "reason": "Awaiting real packet integration and verification on the exact combined HEAD; planning and packet-local claims are not combined evidence."
    },
    {
      "id": "C019",
      "command_or_journey": "Run docs/windows-verification.md on the actual Windows laptop; macOS results do not satisfy this check.",
      "result": "blocked",
      "evidence_path": null,
      "blocking": false,
      "reason": "Not exercised in this macOS packet; owner must confirm Windows hardware availability and attach actual laptop results or record the concrete blocker."
    },
    {
      "id": "C020",
      "command_or_journey": "Read the complete organizer terms, waiver and submission guide before preparing any external submission; do not sign in or accept terms on the user’s behalf.",
      "result": "blocked",
      "evidence_path": null,
      "blocking": false,
      "reason": "The public waiver route showed only a Sign In/Loading shell on November 3, 2026. Authenticated organizer access and human acceptance of terms remain external gates."
    },
    {
      "id": "C021",
      "command_or_journey": "Human legal/privacy review of child-data, education-record, provider terms, consent and regional obligations; no engineering test is a legal certification.",
      "result": "blocked",
      "evidence_path": null,
      "blocking": false,
      "reason": "Requires the product owner’s qualified human review before public child-facing launch."
    },
    {
      "id": "C022",
      "command_or_journey": "Verify the actual signed/notarized output and required CI/GitHub state for the intended distribution channel.",
      "result": "blocked",
      "evidence_path": null,
      "blocking": false,
      "reason": "Not exercised by the package smoke test; report the exact certificate/action gate after checking the integrated release environment."
    }
  ]
}
````

<!-- release-evidence-manifest:end -->
