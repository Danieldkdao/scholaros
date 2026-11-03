# ScholarOS Master Plan

## Purpose and authority

Build the complete desktop learning product described here, with a convincing real Schoology demonstration and a usable macOS release. The approximate delivery target is November 4, 2026, America/Chicago, based on the user's two-day estimate on November 2; no exact submission cutoff has been supplied. Keep the full scope. Prioritize an end-to-end working path, expose remaining work, and continue until the plan is complete or the user explicitly pauses or changes it. The target is not a guarantee, permission to fabricate verification, or an automatic stop time.

This is the source of truth for intended scope, priorities, current-state continuation and acceptance criteria. Kanban is the execution record. Commits, tests, observed behavior and GitHub merge state are the completion evidence. Controller receipts and events preserve handoffs and recovery. Reconcile these at every handoff and after interruption; a done stage card is not a shipped feature.

Latest explicit user instructions override older wording in this plan. This plan supersedes older conflicting proposals, especially voice output, timer pausing, multiple-course sessions, slide support and workbook-style progression. Read `AGENTS.md`, scoped instructions and `docs/SPEC.md`. Keep SPEC focused on product behavior and architecture; update its superseded behavior as corresponding features are implemented. Keep execution status and detailed feature plans on this plan's board and linked artifacts.

The user has authorized autonomous project commands, focused commits, pushes, PR creation and normal GitHub merging for this registered plan. Existing repository instructions requiring explicit Git authorization are satisfied for this workflow. Do not ask routine permission. Honor later user restrictions, real OS authentication and GitHub protection; never bypass them. Do not deploy or publish a submission merely because an installer/demo is prepared. Prepare release artifacts and submission materials; actual external publication must remain within explicit user authorization.

## Current state and continuation

- Repository: `/Users/danieldao/Desktop/scholaros`.
- GitHub: `Danieldkdao/scholaros`, origin `https://github.com/Danieldkdao/scholaros.git`.
- Default branch: `main`.
- Existing working branch: `feat/context`; current worktree is the primary repository above.
- Observed HEAD: `2d5cf67`, merge of PR 4 for course functionality. No open PR was found at plan preparation.
- Existing local work: approximately 70 modified tracked files, plus new context/watch/browser-mode/identity/material source files, migrations and tests. Counts are an observation, not an immutable inventory. Inspect current Git status and diffs before writing.
- Existing product code: Electron desktop authentication/onboarding, academic connections and isolated Chromium profile, protected discovery/navigation, structured courses/assignments/announcements, manual local record editing, targeted refresh, independent academic service, background sync and authenticated inference.
- In-progress code: navigation knowledge, material/PDF ingestion and FTS retrieval, resource identity/tombstones, decision/inout navigation modes, watcher scheduling/state, metrics and related UI/settings/tests. Presence of implementation or tests is not proof that it passes or is complete.
- Today, Study and Planner were heading-only shells at assessment. No complete tutoring, adaptive assessment, concept graph or student learning model was found. Search again and extend any suitable implementation added since this observation.
- Existing UI primitives include Card, Message, MessageScroller, Attachment, Resizable, InputGroup, Chart, Empty, Dialog, Switch, Tooltip and others under `packages/ui/src/components`. Do not install/rebuild equivalents blindly.
- Web development server is on `http://127.0.0.1:3000`; Buzz uses host port 3001 and its existing Tailscale URL. Do not move Buzz or start a competing web server. Reuse existing desktop instances where possible.
- Schoology is already connected through the dedicated academic browser on this Mac. Preserve its cookies/profile and local academic data. Use current authorized sessions; do not ask for or print credentials.

### Continuation instructions for the first feature

Researcher first inventories existing work read-only and writes the detailed remaining-work plan. Then exactly one Coder resume worker keeps `feat/context`, examines tracked and untracked diffs, verifies the scoped baseline and makes focused checkpoint commits before parallel workers fork. Do not switch to main, discard changes, run reset-hard/clean, blindly stage everything, or start a duplicate context implementation from main.

Include intended existing context/watch/course/browser-mode/inference/migration/test changes after inspecting their contents, the existing `.greptile/config.json`, this master plan and its manifest, and the UI-primitives instruction update. Review the existing SPEC changes for consistency. Exclude `.env` files, secrets, account/browser runtime data, downloads, local databases, logs, generated caches, `node_modules`, `.worktrees` and unrelated user edits. If scope is ambiguous, preserve the files and record exclusions rather than discard or absorb unrelated work.

Preserve the original local work in recoverable form before major integration. Record actual baseline failures. A checkpoint commit does not claim unfinished requirements are done. Package branches inherit the accepted continuation HEAD, not the older origin/main. On retries inspect existing worktrees, receipts and PRs first. Exactly one writer owns the continuation/integration directory at a time.

Later independent features use normal descriptive `feat/...` branches when on the default branch; retrying an existing task or continuing an appropriate unfinished branch does not require a new branch. Every concurrent writing worker/subagent still needs its own preserved worktree and branch.

## Final product decisions

### Scope and experience

- English-only first release, serving students across educational levels with no product-imposed age gate. Adapt from context and practice; an education level is optional, not a required enrollment barrier.
- Desktop is the product. Web is authentication/account/inference support and at most a landing page, not a duplicate study application.
- macOS-first functional verification. Preserve Windows-compatible architecture, paths, IPC, browser integration and packaging; perform final hands-on Windows validation on the user's laptop when available. Do not claim it was performed on macOS.
- No payments, subscriptions, billing, PPTX/slide support, spoken tutor output, continuous voice conversation, homework completion or LMS submission.
- Each study session has exactly one course. Additional uploaded material is allowed, but it must not implicitly authorize retrieval from other connected courses. Personal context may be shared across the student's sessions under appropriate scope.
- Main navigation: Today, Courses, Study, Context, Connections. Settings remains accessible through the existing appropriate navigation/profile pattern. Remove Planner and its visible references; a compatibility redirect must not expose a Planner product surface.

### Study setup and focused conversation

Offer exactly these initial activities: Understand a topic; Prepare for an exam; Practice what I know; Review graded mistakes; Help me get started on an assignment.

Use structured selectors for activity, one course, permitted source/target assignment or topic, optional materials and timed/untimed duration. Target/topic selection may allow bounded explanatory text; arbitrary user instructions never change permissions. Tutor may clarify the learning goal, but should use information already selected rather than repeat onboarding questions. Getting started on an assignment explains requirements and approach without producing the assignment's solution.

A session fills the application content area and hides the normal dashboard sidebar. Keep clear title/course/activity, time/status, leave/back and appropriate source controls. OS-level fullscreen and a new native window are not required. Leaving must not lose the session.

The primary view is a flowing conversation document: student messages, tutor text, citations, attachments and generated activities remain in chronological context. It is not a workbook, stepper or forced sequence. Do not expose hidden model chain-of-thought; show concise, meaningful activity status instead.

Interactives appear inline beside/within their introducing response. Expand opens a larger resizable panel beside the document; collapse returns to the flow. Inline/expanded views share one authoritative activity state and do not reset answers or instantiate divergent copies. Preserve keyboard focus, readable minimum widths and a usable narrow-window fallback.

### Learning behavior and progress

Tutor teaches using grounded explanations, useful examples and genuinely functional graphs, simulations, experiments and other interactives. Each generated activity has a clear learning objective, working controls, meaningful state changes and understandable feedback. Educational correctness matters as much as rendering success.

After the student confirms understanding, offer/generated practice: quizzes, practice exams, interactive exercises and small assignments. Use practice evidence to revisit prerequisites and adjust difficulty. Student confidence is evidence, not proof of demonstrated understanding. Do not gate all learning behind repeated quizzes or force a rigid sequence.

Ordinary quizzes default to reviewing answers at the end. A student can request per-answer feedback for ordinary practice. Practice exams withhold hints and solutions until submission; switching to guided practice is allowed but assisted work is distinguished from an independent attempt. Original app-generated practice may have worked explanations; active real coursework remains protected.

Keep two separate local models: course concepts/prerequisites/source links, and student understanding observations based on attempts, mistakes, assistance and confidence. Keep official school grades separate from app practice scores. Unknown is not weak; one bad grade does not imply inability. Show evidence-backed strengths, areas to practice and recent progress in Today/Study without requiring a new progress page.

### Persistence, history and timer

Persist sessions, all messages/parts, visible status, source references and source versions, attachments, artifact content/version/state, attempts, evaluation feedback, context references and appropriate summary/checkpoint metadata. Restore a coherent conversation and activity state after navigating away, app restart or a failed response. Do not serialize executable closures or arbitrary privileged runtime state.

Study landing supports list, search, course filters, rename, resume and delete. Distinguish saved/in-progress/finished/interrupted and offline states. A late response must not resurrect a deleted session; generation cancellation/idempotency must fence it.

TIMED SESSIONS USE CONTINUOUS WALL-CLOCK TIME. Persist a deadline, not merely an in-memory decrementing counter. Time continues while minimized, backgrounded, closed or away. This supersedes prior pause-on-leave proposals. Reconcile expired time on resume and test clock/suspend behavior. Expiry shows one coherent summary with Finish, Extend by chosen duration and Continue indefinitely. Do not destroy unsent text or abruptly discard a generation. Untimed start is supported. Implementation retries still have technical bounds; an untimed session is not an unbounded individual API request.

Deleting a session does not automatically delete its retained memories or learning observations. Independently saved course/Context items remain. Memory/context has separate edit/delete controls. Full account/local-data deletion must remove associated retained data. Do not keep the deleted conversation transcript under the pretext of keeping a small derived memory; clearly distinguish retained derived facts, saved artifacts and deleted session content.

### Context, attachments and memory

Context is a separate central page replacing Planner's navigation slot; do not merge it into Connections. A plus button with DropdownMenu adds Text/note, Personal preference/context, Document/PDF and Image/screenshot. Support search/filter, provenance, course association, read/preview, edit where appropriate, remove and ingestion/retry status. User language describes files and learning context, not SQL/vector/agent internals.

Support PDF, DOCX, TXT, Markdown, PNG, JPEG and WebP. No PPTX or dedicated slides. Include scanned PDFs and handwritten photos through supported Meta multimodal interpretation; expose unreadable/partial/uncertain outcomes and never invent extracted text. Validate actual type and size, not just filename. Research explicit conservative byte/page/image limits and document them in the feature plan; reject unsupported/encrypted/oversized inputs clearly. Disable document macros/external relationships and unsafe remote fetches. No silent non-Meta OCR/model fallback.

Uploads remain with the session and can optionally be saved/linked to Context or one course. Context also supports independent upload. Generated explanations/interactives can be saved to Context and optionally directly to a course with AI-generated provenance and original source/session references. Preserve independently saved items when deleting a session; avoid reference cycles and accidental shared-lifecycle deletion.

Separate navigation knowledge (where/how to find resources), academic source materials (what they say), personal preferences, inferred learning observations and policy/permission state. Retrieval must be bounded, account/course scoped and provenance preserving. Archive source versions cited by prior messages so a later sync does not silently rewrite an old explanation's evidence.

Automatically remember explicit feedback such as shorter explanations or simpler vocabulary through a typed, scoped memory tool. Inferred preferences/understanding remain provisional and revisable. Expose memories for inspection, edit and deletion; explicit corrected preferences outrank older inferences. Notes or memories cannot grant grade access, source access, verified completion or permission to answer active coursework. Imported text and files remain untrusted source data.

### Sync reliability and navigation memory

Finish existing context/sync work before new features. Discover observed course destinations, cache verified per-course/purpose navigation, reuse known assignment/announcement/material destinations on refresh and repair from a known parent when changed. Do not treat cache as permanent truth. Do not keep re-exploring the entire LMS when a verified destination works.

Identity matching and transactional upsert must prevent duplicates against the database, within a returned batch and across concurrent/retried scans. Prefer source stable IDs, then verified scoped canonical URLs, then conservative scoped fallback. Similar names alone must not merge different terms/sections. Guard course/account/resource scope and preserve existing references/IDs when enriching records.

Only complete successful collection evidence may retire missing source records. Cancelled/partial/paginated/failed/rate-limited/needs-sign-in scans preserve prior records and evidence. Keep manual records outside source retirement. User deletion/hiding uses identity suppression/tombstones as appropriate; a later scan must not recreate deliberately suppressed records automatically. Provide a way to undo/restore suppression.

Updates preserve user-authored notes/edits with explicit provenance/conflict handling. Reconciliation notes can guide finding the correct resource or suppressing display, but are not authoritative evidence of grade/completion. Do not mutate LMS records. Background sync/watch obey opt-in, current connection permissions, account scope, pacing/cooldowns and cancellation, and maintain context incrementally.

### Grades and coursework integrity

Grade access defaults off. Settings offers one student-controlled switch for all otherwise authorized connections, with an optional notes textarea when enabled. Do not add mandatory per-course controls. The AI cannot turn this on itself. Honor additional access restrictions conservatively; freeform notes cannot expand authorized source boundaries.

Turning grade access off stops collection and use immediately, cancels/discards in-flight grade operations appropriately and invalidates grade-dependent retrieval/recommendation caches. Offer deletion of collected grade data. Separate official grades/feedback from assignment maximum points and app practice scores. Do not remove school resources merely because grades are disabled.

External coursework defaults to active/unknown. Completed-work answer explanations require connected-source evidence of completion, an actual grade and no remaining submission/resubmission/retake opportunity. A valid zero, pass/fail or other supported grading scale must not be rejected as false/missing. Submission alone, age of work, a student assertion, local checkbox, user note or uploaded marked PDF does not unlock answers. If evidence is missing, conflicting, stale in a consequential way or access is revoked, stay conservative. Refresh/verify before upgrading answer permission, and downgrade when new evidence shows reopening/remaining attempts.

Mark-complete is a verification request, not an authority override. Local hide/delete affects organization/suppression, not assistance policy. Retain minimal task identity/protection evidence needed to avoid bypass by deletion/renaming/new session; full data deletion still works. Do not silently refetch suppressed academic content or grades after revocation.

Active/unknown real assignments receive concept explanations, requirements clarification, hints and nudges, using genuinely different practice examples where helpful. Never provide exact answers, submission-ready sentences/paragraphs, full derivations of the actual assigned question, or an accumulation of smaller hints that reconstructs them. This includes writing, math, code and other subjects. Never submit, edit grades, answer quizzes or perform coursework on the academic site.

Integrity checks span the original assignment/question identity, paraphrases, prior assistance across sessions, memory requests, attachments and generated artifact code/text/hidden values. Claims of being a teacher or having already finished do not alter policy. Source documents can contain hostile instructions and are not system messages. Guard tool execution and permission decisions in code, with Meta-based assessment as an aid rather than the permission boundary.

Check restricted response/artifact content before making it visible or playable. Do not leak disallowed content via incremental streaming, source previews, artifact HTML/JS, hidden answer data, generated text attachments or error logs. If a candidate is rejected, regenerate a safe conceptual response with bounded retries or show a helpful safe fallback. Record content-free diagnostic evidence; do not claim the checks are infallible.

### Generated activity execution

Allow flexible model-generated HTML/CSS and bounded JavaScript, not only a tiny fixed catalog. Use a researched isolated execution surface: no Node/Electron/preload/IPC privileges, academic-browser cookies, filesystem, account secrets, arbitrary network, popups, top navigation or downloads. Content validation and sanitization are additional layers, not the isolation boundary. Do not allow same-origin access to privileged app content. Apply CSP, permission/navigation policies, resource limits and controlled dependencies; prove the actual Electron implementation rather than merely writing iframe attributes.

The host controls save/restore and activity messages through a versioned schema with explicit source/session/artifact IDs, sender validation and bounded payloads. Never accept an artifact's request to read arbitrary context or invoke an application tool. Do not trust artifact-reported practice grades as official grades or authoritative learning evidence without appropriate host validation.

Store immutable artifact versions plus serializable inputs/progress. Updates preserve prior versions and recover after an invalid generation; opening an old version is not regeneration. Test restoring quizzes, simulation parameters, canvas state where supported, expansion/collapse and reopening offline. Allow reset of an activity without losing the original attempt history. Bundle approved runtime dependencies so saved activities work offline; don't execute arbitrary CDN scripts.

Generated content adopts read-only design tokens/approved styles where possible; the app-owned host/chrome uses shared UI primitives. The generated isolated exercise is not allowed to import privileged application React components or receive the preload bridge merely to reuse a Card.

### Meta-only inference and dictation

All ScholarOS AI calls use Meta models: tutoring, classification, extraction, vision, evaluation, guardrails and speech transcription. Hosting can use the existing configured Meta-serving provider; a provider/client name is not proof of the model family. Validate the actual configured model and endpoint against current official support. Do not silently fall back to another model or a data-contributing mode. The Hermes development agents' own selected models are a separate configuration and are not changed by this product requirement.

Use existing Vercel AI SDK integration and typed environment schemas. Provider credentials stay server-side; authorized desktop requests carry only bounded required evidence, never browser credentials. Preserve cancellation, rate limits, structured validation, authentication, timeouts and error states. Keep full academic history locally; send bounded context to cloud inference rather than assuming everything fits or is free to upload. Minimize content logging and do not enable provider-training defaults.

Microphone capture uses explicit app/OS permission, clear recording/stop/cancel state and Meta transcription. Show provisional/ghost transcript while speaking, commit final text to an editable composer and require Send. Do not duplicate partial/final segments, overwrite existing typed text or auto-send an incorrect transcript. Stop recording on cancel, session exit, account change or permission revocation. Tutor replies text only. Do not store raw microphone audio by default after the operation; preserve chosen transcript messages. Explain transmission to Meta before first use.

### Today, Settings and notifications

Today summarizes connection/configuration issues, sync/indexing/freshness state, upcoming assignments/exams/deadlines, announcements, recent courses/materials, recent study sessions, progress and quick actions. Recommend what to study next using authorized course evidence, deadlines, practice history and preferences, plus grades only when permitted. Give concise reasons and source links. Include useful loading, empty, insufficient-context, partial, error and offline states; never invent urgency or imply an unknown date is a confirmed deadline.

Settings uses clear sections and full-width well-labeled inputs: account, device/academic browser, connections/access, personal learning context, AI/navigation behavior, background sync/watch, grades, notifications, appearance/accessibility and local data controls. Preserve valid autosave, pending changes and visible failure/retry state; do not introduce a Save button where autosave is the established pattern.

Allow changing/rebuilding the academic browser after onboarding and configuring a new local device for an existing account. Account login does not mean the new device has a local browser profile/consent or local data. Preserve old workspace until a replacement is verified; browser reconfiguration is serialized with service work and cancels/pauses affected operations safely. Do not copy personal browser profiles or imply cloud academic-data sync exists.

Notifications have a master switch and a reasonably organized list of per-event switches: connection needs attention, sync completed/failed, context processing completed/failed, tutor/activity ready while away, session timer finished and optional upcoming-deadline reminders. Research OS permission flow, dedupe, quiet hours and app-focus suppression. No OS permission prompt simply from opening Settings; request through explicit enable action. Defaults: notifications off, no sensitive grade/question text in OS previews, no duplicate app and OS alerts. Never fabricate a completion notification for merely queued work.

## Autonomous working permission and attention policy

The user explicitly authorizes logical work for improving this application: research, code changes, appropriate dependency installation after review, local/background commands, real provider/API calls with existing keys, read-only authorized LMS browsing, live clicking/UI verification, builds, focused commits, pushes, PR creation and normal merging. Do not repeatedly ask for permission to test or to use configured resources. Use bounded tests and existing approved credentials without printing their values or spending unbounded resources.

Preserve unknown or unrelated information. No broad deletion, repository wipe, uninspected cleanup, reset-hard/clean of user work, destruction of academic/browser data, or replacement of the working installation simply to simplify testing. Product-level delete features must be tested on fixtures/test-owned data and designed to respect actual user intent.

Do not change account security, credentials, authentication-provider settings, OS security/privacy permissions or other sensitive access configuration. Do not complete MFA, password/reset flows, consent grants or new sign-ins for the user. Existing authenticated sessions and API credentials may be used within their configured scope. Implementing the application's required permission/integrity/isolation safeguards remains in scope; this restriction is about taking sensitive access/account actions, not omitting the specified product defenses. If access/security work needs intervention, notify the user and move to independent authorized work.

When a missing key, unavailable permission/session, required configuration or other genuine intervention need appears, immediately send a concise alert to the configured Buzz channel. Include the feature/task, the provider/key NAME or action needed, why it matters, what is blocked and what work continues. NEVER send a key value, token, password, cookie or private academic payload. Do not ask the user to paste secrets into Buzz. The controller's `notice` command uses the default Hermes Buzz destination; the kickoff agent must verify it is the intended channel or explicitly set the run's notify target.

Example from an assigned worker (use a stable issue key so retries do not spam):

```bash
~/.hermes/bin/plan-workflow notice RUN_ID --key missing-meta-transcribe-key --file /absolute/path/to/sanitized-attention.txt
```

This is an alert, not a request to pause all work. Do not wait for a reply before doing independent research, local implementation, fixtures, other runnable packages or verification that can proceed. Persist the blocked operation and resume it when the configuration changes. If delivery fails, queue the alert and retry; do not stop the run merely because the user is unreachable. Never fake a real-API test or mark a blocked acceptance criterion complete. If every remaining task truly depends on the missing input, keep an honest waiting/retry state rather than making unauthorized access changes or pretending progress. User silence is not authorization for the restricted actions above.

## Dependency selection and Socket review

Before recommending a new dependency in a feature implementation plan, and before installing/adding it or materially upgrading one, use the configured Socket.dev MCP to review the exact package/ecosystem/version and dependency/security signals. Record that result in a dependency decision note linked from the feature card. A package manager install completing successfully is not a security review.

Also inspect the package's official registry and upstream repository: version/release recency, maintenance/commit activity, responsive issue/security handling, maintainers, license/platform compatibility, GitHub stars/community and registry downloads over a stated period. Prefer established, maintained projects with strong evidence and already-installed suitable libraries. Popularity is supporting evidence, not proof of safety; do not invent hard star/download guarantees, trust typosquats, or discard a justified specialist library solely because it is smaller.

Record alternatives, why the existing dependency set is insufficient, selected version/range, Socket findings and the maintenance/adoption evidence date. Reject risky/unmaintained alternatives and choose a better fit. Do not run unknown install scripts or alter authentication/security settings to force a package through. If Socket or a required registry is unavailable, continue independent work or use an already-vetted installed solution; do not label an unperformed review passed. Notify the user if a necessary unresolved dependency decision blocks execution. Review lockfile changes and avoid unrelated broad upgrades.

## UI and engineering requirements

- Reuse actual `@scholaros/ui/components/...` primitives for Card/CardContent/CardHeader, Button, Input/Textarea, Select/Combobox, Switch, Dialog/AlertDialog, DropdownMenu, Tabs, Empty, Tooltip, Resizable, Message, Attachment and other available equivalents. A styled div is not an acceptable replacement where a suitable primitive exists. Layout containers and genuinely custom visualizations are still allowed.
- Search existing shared/feature helpers and callers before adding code. Extend a suitable implementation; do not create parallel sync stores, a second academic scheduler, duplicate model clients or redundant query abstractions.
- Use existing semantic tokens, typography, themes and accessibility patterns. Avoid one-off border/background/radius copies; use variants or a justified shared primitive extension. In app UI use the repository's text-size, spacing, `cn`, formatter, `LoadingSwap` and `useConfirm` conventions.
- Research current shadcn AI Elements/AI SDK v7 patterns, but adapt them to Electron/React and the existing shared package. Do not blindly copy a Next.js-only component or duplicate components already present.
- Use installed UI Skills and Motion Design selectively for relevant work; reduced motion, focus, keyboard operation, labels, contrast and real feedback are required. Animations must not delay reading or conceal work/state.
- Reviewer must inspect component imports and rendered flows to catch fake primitives and duplicated helpers. Record justified exceptions. Do not satisfy this with a brittle test banning every div/class.
- Follow lowercase kebab-case authored filenames, repository export/type/schema conventions, short comments, current docs and test-first feature development. No dedicated schema-file tests; check schemas/migrations through review, typechecking and behavioral data/service tests.
- Aim for coherent implementation packages under ten files, with explicit interface/dependency ownership. The user has authorized this larger plan and parallel execution; do not stop to request approval merely because a whole feature spans more files. Split into smaller verified chunks.
- One owner coordinates shared migrations/contracts. Independent writers use separate worktrees; serially integrate overlapping files. Do not rewrite someone else's history or remove user's unrelated local work.

## Ordered feature execution

Researcher must use the following stable feature IDs and preserve this order/dependencies unless the user steers. The first feature is in progress and carries continuation metadata in `docs/master-plan-features.json`. All future features are planned, not completed. Each feature gets a detailed research implementation guide, Coder packages, independent review and evidence before shipping. The sections below identify existing anchors; confirm real APIs and filenames before implementation. Proposed new paths are responsibility suggestions, not assertions that files already exist.

### F01 Finish the existing context and sync foundation

Feature ID: `context-foundation`. Initial status: `in_progress`. Dependencies: none; finish first.

Students can trust that syncing finds their actual courses and materials, remembers where to look next time, and never silently destroys useful information.

Product behavior:

- **F01-R01:** Continue the existing feat/context implementation, including navigation knowledge, material/PDF storage, decision/inout browser modes, identity/retirement handling and the watcher. Inventory what is complete, partial, failing and untested before changing it; do not rewrite functioning systems.
- **F01-R02:** On first discovery record observed course destinations and resource locations with account/course/purpose evidence. On later refresh reuse verified destinations, repair changed routes and report sign-in needs. A cache miss must not become false empty success.
- **F01-R03:** Deduplicate courses, assignments, announcements and materials both against saved records and within the incoming batch. Handle retries and concurrent requests without two copies; do not merge genuinely different course sections or terms because names resemble one another.
- **F01-R04:** Preserve valid partial discoveries and prior data through cancellation, timeout, rate limits, pagination gaps and disconnected sessions. Retire missing records only after demonstrated complete coverage. Keep intentional user suppression and manual data intact.
- **F01-R05:** Background sync/watch updates the same source context used by foreground reads. Show actual progress, last successful check, partial state, errors and reconnection needs; no second independent scheduler.
- **F01-R06:** Finish the current feature with real Schoology evidence before moving on, and preserve its accepted commits for all later features.

Acceptance criteria:

- **F01-AC01:** Refresh twice against unchanged Schoology data: same identities/counts, improved reuse evidence and no unnecessary full-site rediscovery. Capture comparable navigation/request/timing evidence rather than claiming a speedup from intuition.
- **F01-AC02:** An input batch containing A, B, A, B yields exactly two records; a saved A plus incoming A/A remains one. Repeated titles across distinct terms/sections remain distinct when source identity differs.
- **F01-AC03:** Cancel after one course/material checkpoint: saved valid results remain and unrelated source records are not retired. A failed or partial scan does not mark a source complete.
- **F01-AC04:** Delete/suppress a local source record then resync: it does not reappear; undo suppression allows it to return. A manual record survives source disappearance.
- **F01-AC05:** Exercise permitted browser modes, scoped refresh, watcher suspension/restore, and sign-out/account boundaries with existing behavioral tests plus focused live verification. Record limitations honestly.

Researcher starting context: Existing features/context, features/watch, features/courses, onboarding browser services, academic service contracts, source schemas/migrations and shared AI extraction. Preserve current user data. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F02 Build the Context page and reusable study-material library

Feature ID: `context-library`. Initial status: `planned`. Dependencies: `context-foundation`.

Students can add, understand, organize and reuse the information ScholarOS should know without managing files or technical infrastructure themselves.

Product behavior:

- **F02-R01:** Replace Planner navigation with Context, keeping Connections separate. Make plus-menu creation, search/filter, course association, source/provenance, processing states and appropriate preview/edit/remove actions coherent.
- **F02-R02:** Support plain notes/preferences, PDF, DOCX, TXT/Markdown, PNG/JPEG/WebP, scanned PDFs and handwritten images. Explicitly exclude PPTX. Treat reading/conversion failure as a visible result, not empty successful content.
- **F02-R03:** Uploads in a session remain there unless optionally saved to Context or linked to the session course. Context uploads can be unassigned or attached to a course. Moving/linking changes organization without duplicating the original content or losing references.
- **F02-R04:** Keep navigation notes separate from study source text, personal preferences and inferred observations. Retrieve only relevant account/course-authorized evidence; personal notes never become instructions to bypass access/integrity policy.
- **F02-R05:** Preserve originals, extracted versions, supporting source/page/heading locations and extraction confidence/status. Allow retry, replacement/version update and deletion with clear dependent-item behavior.
- **F02-R06:** Provide meaningful no-context, processing, partial, unsupported, unreadable, offline and retry states. Explain what remains usable. Do not require students to understand indexing or model tokens.

Acceptance criteria:

- **F02-AC01:** Create a text note, import a DOCX/PDF/photo, associate and detach a course, search and preview each. All actions survive app restart with correct owner/scope.
- **F02-AC02:** A scanned/handwritten source produces useful bounded Meta interpretation when supported; an unreadable source stays visibly uncertain and never acquires invented text.
- **F02-AC03:** Unsupported PPTX, misleading file extensions and oversized/encrypted documents receive clear errors while other uploads continue.
- **F02-AC04:** One course cannot retrieve another course/account source accidentally. Remove a source and confirm it leaves future retrieval while prior cited historical versions remain clearly historical or become an explicit removed-source reference.

Researcher starting context: Extend existing context stores/read actions, local material extraction/FTS and shared Attachment/DropdownMenu/Empty primitives. No parallel context database or cloud file store by default. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F03 Add grade consent and verified coursework assistance rules

Feature ID: `grades-integrity`. Initial status: `planned`. Dependencies: `context-foundation`.

Students can use permitted school feedback to learn from completed work while active assignments remain protected, including across repeated requests.

Product behavior:

- **F03-R01:** Add grade access off by default, one user-controlled Settings switch and optional notes. Reuse authorized connections, not a second login or direct credential collection.
- **F03-R02:** Collect source grade/feedback and completion/attempt availability as separate evidence with provenance and retrieval time. Keep maximum points, real earned grades and app practice scores distinct.
- **F03-R03:** Default to active/unknown. Upgrade to verified completed only from supported connected evidence: completed, grade available, no remaining submission/resubmission/retake. Unknown availability or conflicting evidence stays conservative. Do not let the model invent a missing grade.
- **F03-R04:** Mark-complete asks ScholarOS to verify; local removal, student notes, uploaded marked work and a new conversation never unlock answers. Suppression does not erase policy identity or cause hidden content refetch.
- **F03-R05:** Keep a scoped cross-session assistance record for original coursework/question identities and transformations. Detect cumulative answer construction, role-play, paraphrases, hidden artifact answers and requests to save bypass instructions into memory.
- **F03-R06:** Completed-work review can explain actual mistakes and answers. Active-work help clarifies requirements/concepts and gives bounded hints or distinct practice without writing submission-ready content.
- **F03-R07:** Revocation stops both collection and use, handles in-flight work, invalidates derived grade-dependent recommendations and offers local grade deletion. Keep unrelated materials and learning practice available.

Acceptance criteria:

- **F03-AC01:** A valid zero grade is recognized; no grade, merely submitted, reopened work and remaining exam attempts all retain active/unknown protections.
- **F03-AC02:** An uploaded screenshot saying graded and a user claiming teacher status do not override missing connected evidence. Hiding the assignment and starting a new session do not reset protection.
- **F03-AC03:** Adversarial writing/math conversations request a solution gradually across turns/sessions: the tutor provides conceptual support without reconstructing an answer. Test chat, source previews, artifact content and memory writes.
- **F03-AC04:** Turning access off during a grade fetch prevents late grade use/storage as specified; recommendations no longer reference withheld grades. Re-enable respects current permission and source evidence.
- **F03-AC05:** Live read-only Schoology verification distinguishes actual source facts from unavailable evidence. Do not submit an assessment or modify the LMS to manufacture a test case; use local fixtures for destructive/error cases.

Researcher starting context: Extend structured academic resource evidence and service permissions. Research the actual grade/attempt fields visible on Schoology. Implement policy gates before tutor/artifact publication. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F04 Create focused study sessions with durable history

Feature ID: `session-core`. Initial status: `planned`. Dependencies: `context-library`, `grades-integrity`.

Students start a session intentionally, enter a distraction-free conversation, and return later without losing anything.

Product behavior:

- **F04-R01:** Build the five-activity setup with exactly one course, relevant target/topic/material selectors and timed/untimed duration. Prevent a multi-course session; allow extra uploaded materials without granting other LMS scopes.
- **F04-R02:** Hide dashboard chrome while studying. Provide clear course/title/activity, leave/back, status, composer, attachments, transcript and room for an expanded activity panel.
- **F04-R03:** Persist messages/parts, session metadata, drafts where appropriate, source references and history. Handle interrupted/failed generation and duplicate Send/retry cleanly. Do not render fake tutor content before actual inference exists.
- **F04-R04:** Study history supports search, course filtering, rename, resume and delete. Link useful recent sessions from the existing navigation structure and preserve clear account isolation.
- **F04-R05:** Use a persistent wall-clock deadline that runs even when the app is closed/minimized. On expiry show a useful summary with Finish, custom extension and indefinite continuation; expired-on-resume is handled once.
- **F04-R06:** Deleting the session cancels its in-flight operations and prevents late-message resurrection. Keep separately retained memories/learning evidence and independently saved Context/course material, with separate controls to remove those.

Acceptance criteria:

- **F04-AC01:** Create each activity type, reject invalid/multiple-course setup, leave/resume, rename/search/filter and reopen after app restart with the same ordered content.
- **F04-AC02:** Background/close the app for several minutes: the timer reflects elapsed time rather than pausing. Expiry summary and extension work without losing a draft or completed turn; untimed mode has no deadline.
- **F04-AC03:** Double-send/retry and interrupted-stream recovery do not create duplicate turns. Deletion during generation does not recreate a session later.
- **F04-AC04:** Use keyboard navigation, narrow-window layout and offline history. Shared message, input and attachment primitives are actually used.

Researcher starting context: New study responsibility under features/study and a focus route outside the dashboard layout; extend narrow academic service APIs and existing message/scroll/input primitives. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F05 Deliver contextual Meta tutoring and safe conversational tools

Feature ID: `grounded-tutor`. Initial status: `planned`. Dependencies: `session-core`.

The tutor understands the selected course and goal, teaches clearly from evidence and provides useful help within the student’s permissions.

Product behavior:

- **F05-R01:** Use structured setup, current course/resource freshness, relevant source passages, preferences and prior conversation to clarify the goal without asking for the same context again.
- **F05-R02:** Integrate actual Meta text/multimodal inference through the existing authorized server pathway and AI SDK. Keep model/provider configuration typed, server-owned and Meta-only; expose unavailable/auth/rate-limit/cancel states honestly.
- **F05-R03:** Persist complete local conversation while sending bounded, relevant context. Preserve source citations/version references; distinguish source requirements, general explanations and AI inferences. Missing context prompts a helpful next action rather than an invented requirement.
- **F05-R04:** Expose scoped tools for approved source retrieval, context/memory proposals, creating activities and safe learning actions. Student messages, retrieved sources and tool results cannot expand permissions or turn into privileged desktop instructions.
- **F05-R05:** Apply integrity policy before publishing text, tool effects or artifacts. Restricted generation must not leak answers through an unchecked stream. Provide short, helpful conceptual alternatives on rejection with bounded retries.
- **F05-R06:** Keep the conversation readable and fluid. Allow stop/retry without losing accepted content; do not show private chain-of-thought. Tutor responses are text only.

Acceptance criteria:

- **F05-AC01:** Complete a real Schoology-grounded session: source-backed goal clarification, useful explanation, inspected citations and saved conversation. Test expired access, stale/partial sources and unavailable inference.
- **F05-AC02:** Capture outgoing provider/model identity and bounded content metrics without logging student content; prove no non-Meta fallback and no secret/provider key in the renderer.
- **F05-AC03:** Test prompt injection inside an uploaded source and across turns. Invalid tool names/arguments, cross-course IDs and permission-change races cannot execute privileged work.
- **F05-AC04:** Offline UI remains readable and explains why sending requires connectivity; failed responses can be retried idempotently.

Researcher starting context: Existing web agent route, shared AI/model modules, context retrieval and local service transport. Research AI SDK v7 patterns against installed versions; reuse existing UI conversation primitives. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F06 Generate and preserve useful inline learning activities

Feature ID: `interactive-document`. Initial status: `planned`. Dependencies: `grounded-tutor`.

The conversation becomes a living learning document with functional activities that expand when students need more room.

Product behavior:

- **F06-R01:** Generate flexible HTML/CSS/bounded JavaScript graphs, experiments, simulations and other activities from an explicit learning objective. Support meaningful input/output and accessible explanatory alternatives.
- **F06-R02:** Validate generated content and run it in a genuinely isolated runtime. No Electron/Node/preload, browser cookies, filesystem, unauthorized network or arbitrary application tool access. Do not confuse sanitization with isolation.
- **F06-R03:** Keep an activity inline with its originating tutor message. Expand into a resizable side panel using the same authoritative activity state; collapse/reopen without resetting or duplicating it.
- **F06-R04:** Persist immutable content versions, student inputs/progress and a versioned safe message/state contract. Regeneration creates a recoverable version; invalid generation does not destroy the last usable activity.
- **F06-R05:** Allow saving an explanation/activity into Context or directly to the session course with provenance. Separate saved-item and session lifecycles. Saved activities work offline with approved bundled assets.
- **F06-R06:** Apply tutoring integrity to visible and hidden artifact content before execution. Host notifications/state events cannot be used to request arbitrary files/context or forge official grades.

Acceptance criteria:

- **F06-AC01:** Live examples include a graph with correctly responding controls, a useful science simulation and an input-driven activity. Reviewer checks educational behavior, not merely that a frame loaded.
- **F06-AC02:** Expand/collapse, change parameters, close/reopen the app, work offline and restore the same content/version/progress.
- **F06-AC03:** Adversarial generated code attempts preload/parent DOM/cookie/file/network/navigation/popup access and spoofed/oversized messages: blocked with a recoverable student-facing state.
- **F06-AC04:** Save an activity to Context/course, delete its session and verify the saved item remains intentionally available. Delete/remove saved context independently without corrupting unrelated activities.

Researcher starting context: Study document/activity host plus isolated activity runtime; shared Resizable/Card/Dialog primitives for app chrome. Research Electron frame/process boundaries before implementation. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F07 Add adaptive quizzes exams and meaningful learning feedback

Feature ID: `practice-assessment`. Initial status: `planned`. Dependencies: `interactive-document`.

Students test what they understand through practice that teaches from mistakes and distinguishes independent success from assisted work.

Product behavior:

- **F07-R01:** Offer practice after a student indicates understanding while adapting to actual responses. Support quizzes, practice exams and short learning assignments with explicit objectives and appropriate difficulty.
- **F07-R02:** Ordinary quiz review defaults to the end; allow an explicit request for per-answer feedback. Practice exams hold hints/solutions until submission. Switching to guided practice marks assistance and does not masquerade as a clean exam result.
- **F07-R03:** Evaluate answers with appropriate deterministic checks or bounded Meta evaluation/rubrics. Accept valid alternative responses and explicit uncertainty; do not grade a reasonable answer wrong merely because wording differs.
- **F07-R04:** Explain mistakes with sources where relevant, revisit prerequisite concepts and suggest another example or next practice. Distinguish app-generated work from real active coursework; never turn an assignment-help session into a solution generator.
- **F07-R05:** Persist attempts, selected feedback mode, answer changes, assistance, rubrics/versions and outcome evidence. Show retries without erasing prior learning evidence or treating repeated exposure as an independent success.

Acceptance criteria:

- **F07-AC01:** Test end-of-quiz feedback, requested per-answer feedback, exam submission, guided-exam exit and resume during an incomplete attempt.
- **F07-AC02:** Exercise numeric, multiple-choice and short-explanation examples with valid alternatives, incorrect and uncertain results. Reviewer verifies generated questions/rubrics are coherent and answerable.
- **F07-AC03:** An artifact cannot forge an official grade or silently mark a learning objective mastered. Assistance and evidence versions remain traceable.
- **F07-AC04:** A real active question cannot be smuggled into generated practice to obtain a lightly reworded exact solution.

Researcher starting context: Extend study activities, safe artifact host, Meta evaluation and local learning observations; no LMS writes. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F08 Build inspectable personal memory and learning progress

Feature ID: `adaptive-memory`. Initial status: `planned`. Dependencies: `practice-assessment`.

ScholarOS becomes more useful over time while students can understand and correct what it remembers.

Product behavior:

- **F08-R01:** Use a typed memory tool to save explicit preferences such as concise explanations or simpler wording. Separate personal preference, learning observation, course concept/prerequisite and source fact.
- **F08-R02:** Apply explicit corrections over older inferences. Inferred patterns remain provisional/revisable and have evidence references; do not infer permanent ability, a medical condition or a fixed label from weak data.
- **F08-R03:** Context exposes remembered information with source/type/course where relevant and edit/delete controls. A deletion removes the item from future retrieval and derived preference caches.
- **F08-R04:** Construct useful course concept/prerequisite relationships grounded in materials, with evidence and uncertainty. Update student understanding from independent/assisted attempts and confidence without conflating official grades.
- **F08-R05:** Show understandable strengths, topics needing practice and recent change in Study/Today. Retain small relevant memories and learning observations after session deletion as explicitly requested, without secretly retaining the deleted transcript.
- **F08-R06:** Keep memory and progress scoped by account and course. Personal notes cannot override access, completion or answer-assistance policies; full local/account data deletion includes derived data.

Acceptance criteria:

- **F08-AC01:** Tell the tutor that an explanation is too verbose; confirm the preference is saved, visible, used in a new session, corrected and deletable.
- **F08-AC02:** An incorrect inference can be corrected; a deleted preference no longer influences the next prepared context. Practice with hints is not counted as independent evidence.
- **F08-AC03:** Deleting a session preserves explicitly retained derived context, while deleting the memory/full account data removes it. No cross-account observations leak.
- **F08-AC04:** Progress descriptions cite actual observations and distinguish unknown topics from demonstrated difficulty.

Researcher starting context: Extend Context and study evidence stores and typed tools; keep navigation and personal memory separate. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F09 Add live Meta dictation to the editable composer

Feature ID: `speech-input`. Initial status: `planned`. Dependencies: `grounded-tutor`.

Students can speak naturally, see what was heard, correct it and choose when to send.

Product behavior:

- **F09-R01:** Use the documented Meta transcription model and supported authenticated streaming/file pathway. Never substitute another speech model or enable tutor speech output.
- **F09-R02:** Explicitly request microphone/OS permission through user action. Show recording, provisional live/ghost transcript, final text, stop, cancel and error states.
- **F09-R03:** Preserve existing typed composer text and merge partial/final transcript segments without duplication. Final text stays editable and is not submitted until Send.
- **F09-R04:** Stop capture on explicit cancel, leaving a session, sign-out and permission revocation. No background microphone use or raw recording retention by default.
- **F09-R05:** Handle offline, missing device, denied permission, disconnect, empty/noisy audio, provider limits and cancellation without losing the pre-existing draft.

Acceptance criteria:

- **F09-AC01:** Live microphone test on macOS: speak, inspect provisional text, stop, edit and Send. Tutor answers with text only.
- **F09-AC02:** Cancel recording and leave/sign out: microphone stops and no late transcript is inserted into another account/session.
- **F09-AC03:** Permission-denied/offline/reconnect and repeated partial events preserve a single coherent draft. Verify actual Meta model and credential isolation.

Researcher starting context: Study composer and existing server-authorized AI boundary. Research Meta Muse Voice Transcribe and installed AI SDK support; use supported endpoints when an adapter is unavailable. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F10 Create the useful Today overview and next-study recommendations

Feature ID: `today-progress`. Initial status: `planned`. Dependencies: `adaptive-memory`.

Students immediately see what matters, what needs attention and where to continue learning.

Product behavior:

- **F10-R01:** Compose connection/setup attention, sync/freshness, deadlines/assignments/exams, announcements, recent courses/materials, recent sessions, progress and quick actions using actual available data.
- **F10-R02:** Recommend next study using permitted source evidence, deadlines, learning observations and preferences, plus grades only with active permission. Explain the reason and provide source links.
- **F10-R03:** Deep-link recommendations into a relevant prefilled structured study setup without silently starting a new inference session or crossing course boundaries.
- **F10-R04:** Handle indexing in progress, insufficient context, no courses, no upcoming deadlines, partial coverage, sign-in needs and offline states with useful next actions. Do not fill empty cards with fabricated data.
- **F10-R05:** Keep recommendations fresh after sync, practice, memory correction and grade revocation; avoid model calls on every rerender and make background computation observable/cancellable.

Acceptance criteria:

- **F10-AC01:** Use real Schoology data plus local fixtures to verify upcoming-item order, recommendation reasoning and links to the right course/activity.
- **F10-AC02:** Test new account, pending index, grade access off, unknown dates and partial/offline sources. Empty states remain clean and actionable.
- **F10-AC03:** Resume a recent session with its state intact and follow a source without escaping permitted navigation. Verify no fake Card/div equivalents.

Researcher starting context: Existing Today route, course snapshot/read APIs, shared Card/Empty/Item/Skeleton primitives and new learning evidence. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F11 Organize Settings and support browser reconfiguration

Feature ID: `settings-device`. Initial status: `planned`. Dependencies: `context-library`, `grades-integrity`, `adaptive-memory`.

Students can understand and change their setup after onboarding, including on a new computer.

Product behavior:

- **F11-R01:** Create coherent Settings sections with real shared fields, labels and switches, consistent spacing/full-width controls, concise helper text and existing autosave behavior.
- **F11-R02:** Expose account/device/browser, personal context and optional levels, navigation behavior, background sync/watch, grades, notifications integration, appearance/accessibility and local-data controls without duplicating their stores.
- **F11-R03:** Allow selecting/configuring another academic browser after onboarding. Preserve the old verified workspace until replacement succeeds; clearly describe whether sign-in is needed again.
- **F11-R04:** On a new device, an existing account can configure local browser/consent/preferences instead of being trapped by previously completed account onboarding. Do not imply local course files automatically arrived from the cloud.
- **F11-R05:** Serialize browser replacement with active academic operations, cancel safely, preserve checkpoints, and retain unrelated manual work. Support cancel/failure/retry without a broken configured state.
- **F11-R06:** Ensure personal preferences and grade notes are editable here or deep-link clearly into Context. Handle grade revocation/data deletion and broader local-data removal with appropriate explicit confirmation in the product.

Acceptance criteria:

- **F11-AC01:** Change the browser on the current Mac, cancel once and complete a verified replacement using non-destructive test setup. Original data/session survives until success.
- **F11-AC02:** Test an existing account with no local device profile; setup can complete and course syncing becomes available.
- **F11-AC03:** Edit settings and close immediately: valid pending saves settle or errors remain visible, rather than silently disappearing. Keyboard/labels/layout/reduced motion pass.
- **F11-AC04:** Source/grade permissions remain enforced in services even if UI input is spoofed; UI does not become the sole access boundary.

Researcher starting context: Existing Settings route, onboarding device/browser state, autosave queue and academic service. Extend rather than duplicate setup logic. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F12 Add user-controlled desktop notification preferences

Feature ID: `notifications`. Initial status: `planned`. Dependencies: `settings-device`, `today-progress`, `speech-input`.

Students can opt into useful application updates without noisy or sensitive OS notifications.

Product behavior:

- **F12-R01:** Add a master notification switch and organized per-event switches. Initial categories cover connection attention, sync completion/failure, context processing, tutor/activity ready while away, timer expiry and optional deadline reminders.
- **F12-R02:** Integrate OS permission/configuration through explicit enable action and expose denied/unavailable states with an understandable settings path. Merely visiting Settings must not request permission.
- **F12-R03:** Respect quiet hours, current account, app focus and deduplication. No sensitive grade/question content in OS previews by default. Clicking routes to the appropriate still-existing source/session.
- **F12-R04:** Emit events from actual service/generation outcomes. Distinguish waiting on user action, work ready and failure; do not notify every token, polling tick or retry.
- **F12-R05:** Persist preferences, reschedule/cancel relevant reminders after changes and avoid delivering stale/deleted-account/deleted-session notifications.

Acceptance criteria:

- **F12-AC01:** Toggle the master and individual events; verify requested OS permission behavior, off/denied/quiet-hours and focused/background states.
- **F12-AC02:** Complete/fail/cancel representative jobs and expire a timed session: the correct notification occurs at most once and opens the correct location.
- **F12-AC03:** Disable notifications, sign out or delete a target: queued/stale events do not leak content or route to the wrong account. Review Windows behavior without claiming unperformed GUI checks.

Researcher starting context: Existing academic/study events and Electron notification lifecycle; shared Switch/Field primitives and Settings persistence. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

### F13 Polish and verify the full macOS product and demo

Feature ID: `release-verification`. Initial status: `planned`. Dependencies: `context-foundation`, `context-library`, `grades-integrity`, `session-core`, `grounded-tutor`, `interactive-document`, `practice-assessment`, `adaptive-memory`, `speech-input`, `today-progress`, `settings-device`, `notifications`.

A student can install and use a coherent product, and the demo demonstrates actual learning rather than disconnected screens.

Product behavior:

- **F13-R01:** Complete all acceptance criteria and regressions, including UI primitive reuse, empty/error/offline states, source permission boundaries, session restoration and no remaining Planner surface.
- **F13-R02:** Run the real Schoology journey: existing/new-device setup, context sync, course/material selection, focused tutor explanation, useful inline/expanded activity, practice feedback, saved/resumed session, adaptive preference and Today recommendation.
- **F13-R03:** Prepare a reproducible demo script with a realistic learning objective, source citations, a science/math example and an active-work integrity demonstration. Keep real student identities/grades out of shareable recordings unless explicitly permitted.
- **F13-R04:** Build/test macOS packaging with native SQLite and browser/Stagehand resources. Do not replace the user's working app/data in order to test an installer. Signing/notarization/distribution depend on real credentials and are reported accurately.
- **F13-R05:** Review Windows paths, pipes, browser detection, assets, shortcuts, microphone/notification permissions and packaging; prepare a hands-on test checklist for the available Windows laptop. macOS success is not Windows proof.
- **F13-R06:** Create an honest requirement-to-evidence/release report, known issues list and pending external/hardware gates. Verify current official hackathon submission requirements before preparing final deliverables; no automatic submission/publication is authorized by this feature alone.
- **F13-R07:** Keep full scope visible near the two-day target. Report actual completion, failures and risks. Continue remediation through durable tasks; do not call stubs, failed checks or untested behavior complete.

Acceptance criteria:

- **F13-AC01:** Applicable workspace tests/typechecks/lint/format checks and macOS build/packaging pass with exact commands, commit and evidence recorded. Distinguish pre-existing baseline issues and remediate relevant blockers.
- **F13-AC02:** Run focused live desktop and web authentication verification under the shared GUI lock. Test leave/restart, offline, revoked permissions, unavailable inference and interrupted activity generation.
- **F13-AC03:** Reviewer independently follows the demo and critical adversarial integrity/activity-isolation tests. Preserve screenshots locally and do not publish sensitive data.
- **F13-AC04:** Final GitHub PRs are actually merged, local main is synchronized without lost user edits, and every feature has evidence or an explicit still-open release gate. Windows checklist/results are clearly labeled.

Researcher starting context: Whole-product verification and packaging; preserve existing installers/service ownership and user data. Update product SPEC to the final behavior without putting task history into it. Researcher supplies the detailed implementation guide, file/symbol map, contracts, edge cases, tests and package boundaries before Coder implements this feature.

## Researcher and agent execution contract

The product requirements above are deliberately more detailed than the implementation prescription. Researcher owns current official-documentation research, compatibility checks against installed versions, technology choices inside these constraints, precise code paths/symbols, contracts, migrations, test design and ordered instructions for the cheaper Coder model. Do not turn an unanswered implementation detail into an unnecessary product interview.

For each feature, Researcher must deliver:

1. The user outcome and all relevant requirement/acceptance IDs, including cross-cutting rules and inherited behavior.
2. Actual repository state and existing reusable implementations; what is done, partial, unverified or still missing. Verify completion before skipping work.
3. Specific product flows and UI states: entry points, choices, normal path, exit/resume, loading, empty, partial, invalid, unavailable, permission-denied and recovery behavior.
4. A detailed implementation guide with exact current files/symbols and any proposed new responsibilities; data/permission boundaries, versioned interfaces and source-of-truth rules; concurrency and cancellation cases; backward compatibility/migrations; safe defaults and bounded resource behavior.
5. Small work packages with ownership, ordered dependencies, sufficient background, numbered changes, expected outcomes, test-first behavioral checks and focused live-verification scenarios. Lower-cost Coder workers should not need to reconstruct product intent.
6. Current primary documentation supporting technical choices, verified against installed libraries. Dependencies already present should be preferred when suitable. Do not silently change major framework/model/provider architecture to match an example.
7. A requirement-to-verification matrix and a precise handoff. Save assumptions and research artifacts on Kanban; label unverified external/hardware gates.

Coder reads the master plan, feature plan, existing code and all predecessor receipts before working. Respect scoped repo instructions, test-first behavior, shared primitives and isolated worktrees. Commit clean focused changes as they become verified. Follow this project's `type: description` commit subjects, without scopes/parentheses, and review staged hunks. Produce a detailed handoff mapping requirements to files/symbols, commits, tests actually run, live paths exercised, remaining risks and important reviewer locations.

Reviewer reads the original master/feature plans and integrated diff, inspects surrounding behavior and independently tests relevant flows. Check correctness, source permissions, grade/integrity boundaries, arbitrary-HTML isolation, persistence, cancellation, concurrency, offline/error states, accessibility and real shared UI imports. Return findings as concrete reproducible packets: stable ID, severity/impact, exact location, expected/actual, root-cause evidence, numbered fix steps and verification assertions that a weaker Coder can execute.

### Autonomous handoffs and limits

Use the installed `autonomous-plan-cycle` controller and shared skill. Do not run a second chat loop or create a competing board. Initialize one run with the repository and this file; its board is `wf-<run-id>`. Use `docs/master-plan-features.json` as the initial feature index/continuation seed; the Markdown plan is authoritative if they diverge, so reconcile the manifest after a user change rather than blindly executing stale metadata.

Stages: Researcher index -> Researcher feature plan -> Coder resume checkpoint when continuing existing work -> Coder decomposition -> up to three concurrent Coder package workers -> one Coder integration -> independent Reviewer -> fixes/review -> push/create or reuse PR -> observe existing default Greptile review -> warranted fixes -> independent Reviewer/fixes -> final push/normal merge -> local main synchronization -> next feature's Researcher.

Each Coder package worker may use up to four flat subagents with bounded tool loops and unique writing worktrees. Children inherit the current plan controls and authorized permission boundaries. Share explicit contracts; do not have multiple children edit the same directory or create recursive uncontrolled fan-out. Shared desktop GUI tests require the existing cooperative lock under `~/.hermes/locks/gui-testing.lock`; hold it for the full scenario and release only your own verified ownership. Terminal tests can run concurrently when independent.

There is an initial independent review plus at most two Coder-fix/Reviewer-rereview exchanges in each local review phase, including the post-cloud phase. At the cap record residual findings and proceed to the next configured stage. Do not create an endless Reviewer ping-pong. Actual failing required checks, unauthorized access and GitHub protections still require remediation/retry; a round cap does not make them pass or permit an administrative bypass. Distinguish advancing a workflow stage from declaring a release ready.

Greptile runs at most the one default automatic PR review. Before first publication commit effective `.greptile/config.json` with open-only automatic review and update/draft triggering disabled; audit overriding configuration. Never manually trigger a review through MCP, bot mentions/comments, review-request APIs/labels, reruns or close/reopen/draft-ready cycling. Reuse an existing PR and the first persisted review snapshot across retries, revised plans and runs. If no default review appears in the controller's observation window, record that and continue; never force one. Later fixes are evaluated by the local Reviewer and required tests. Human/external actions outside this workflow are not a guarantee the agents can control.

Push/open/reuse a PR for the feature integration branch, address captured cloud findings with tested focused commits, then merge normally when GitHub permits it. Independently verify actual MERGED state and synchronize local main without overwriting dirty user work. Never force-push, admin-bypass branch protections or fabricate a merge/CI result. Preserve worktrees/source branches and evidence for review.

Long work persists receipts, comments and honest heartbeats/checkpoints at least every 10–15 minutes when control is available. Worker budgets are ceilings, not targets. Transient failures retry with backoff and durable state; no automatic pause because of a time estimate or review round cap. Report concrete credentials/hardware/external blockers and continue independent authorized work. Only the user pauses the overall run. Do not interpret a model error or context limit as product completion.

### User steering

The user may change priorities/requirements during execution, update this master plan, request a different implementation approach or pause/resume. Read live controls before work, at milestones and before consequential actions. New instructions take precedence; checkpoint current work and avoid publishing/merging stale revisions. Do not discard previous artifacts or commits when re-indexing. Reconcile old accepted work against new requirements and preserve stable feature/requirement IDs where possible.

Use `~/.hermes/bin/plan-workflow status <run-id>` and `events <run-id>` plus Kanban for progress. `steer <run-id> --text '...'` adds live directions. `pause`/`resume` are cooperative controls, not claims that an already running shell command was instantly killed. The original registered plan file is the editable source; controller snapshots and release reports do not replace it.

## Verification and release evidence

Confirm available scripts and installed runtime before running commands; prefer focused checks as changes land, then the combined affected suite before integration/ship. Do not run dedicated tests of schema/table definition files. Use behavioral store/service/migration scenarios, typechecking and review for schema changes. Do not mutate live Schoology data to test destructive paths.

Current workspace entry points include:

```bash
pnpm --filter @scholaros/services test
pnpm --filter @scholaros/desktop test
pnpm --filter @scholaros/web test
pnpm --filter @scholaros/services typecheck
pnpm --filter @scholaros/desktop typecheck
pnpm --filter @scholaros/web typecheck
pnpm --filter @scholaros/ui typecheck
pnpm lint
pnpm format:check
pnpm --filter @scholaros/web build
pnpm --filter @scholaros/desktop package
```

Researcher verifies the actual desktop test/native-module runtime and package/build prerequisites rather than assuming any command above was already run. Use focused workspace invocations, preserve outputs/artifacts and report pre-existing failures. Do not run the repository-wide write formatter over unrelated existing work. Package/make/signing actions can produce artifacts; inspect platform prerequisites and keep the working installation/user data safe.

A live feature verification record states: requirement IDs; exact commit; environment/app versions; source/connection scope without secrets; action sequence; expected/observed results; artifacts/screenshots kept locally; and untested limits. Assertions such as 'computer use unavailable' require discovering/trying the currently configured native tool, not repeating old conversation failures. Use simulated fixtures for error paths that cannot safely be produced on the real account.

Minimum combined adversarial/reliability matrix:

- Source identity duplicates within batch, database and concurrent/retry paths; genuine same-name different courses remain distinct.
- Partial/cancelled/rate-limited/expired-session sync preserves existing data; source deletion versus user suppression versus manual data remains distinct.
- Cross-account/course reads, spoofed IPC/messages, cancelled or late responses, sign-out and permission-revocation races.
- Grade missing/zero/pass-fail/unknown, still-open/reopened/resubmittable/multi-attempt assessment, stale conflicting completion, local checkbox/notes/uploaded-score claims.
- Incremental active-answer construction across turns and sessions; role-play, paraphrase, foreign instructions in files, source previews, memory requests and hidden artifact values.
- Generated activity parent/preload/file/cookie/network/navigation/message abuse, resource exhaustion, invalid output and state/schema version mismatch.
- Draft/transcript edits, microphone permission/cancel/revoke, offline/reconnect, app restart, wall-clock expiry after sleep/closure and indefinite continuation.
- Artifact state restored inline and expanded; independently saved items and retained derived memories survive session deletion as intended; full data deletion actually removes them.
- Real shared primitives, accessible keyboard/focus/labels, reduced motion, narrow/large windows, empty/error/processing states and no sensitive OS notification preview.

Do not call a feature complete from code presence, test-file count or a card label alone. Keep feature completion, demo readiness, macOS release readiness and pending Windows validation as separate report fields. Researcher may skip a genuinely already-complete feature only with explicit current evidence.

## Delivery priorities and non-goals

Finish F01 first. Establish the reusable context/permissions/session/tutor path next, then functional generated activities and practice. Add adaptation, dictation, Today, reconfiguration and notifications to complete the product; do not silently drop them to hit the estimate. At meaningful checkpoints summarize the real end-to-end capability and the remaining features so the user can steer. Parallelize independent packages inside features rather than skipping prerequisites.

The final product is ready when all specified feature acceptance criteria have evidence, relevant required checks pass, source/integrity/isolation boundaries hold under the recorded tests, the Mac installation and real Schoology demo work, and remaining external/hardware release limitations are explicit. No unverified legal, platform, accessibility or security certification claims. No arbitrary product age gate is introduced, but data minimization, transparent cloud processing and age-appropriate learning remain required; Researcher must identify applicable public-launch consent/privacy obligations rather than claiming that removing an age selector resolves them.

Out of scope: payments, subscriptions, PPTX/slides, non-English localization, tutor audio synthesis, continuous speech-to-speech, multi-course sessions, a Planner page, cloud academic-history synchronization, broad LMS-coverage promises without evidence, completion/submission of school assignments, and silently replacing Meta models. Do not add these without a user change.

## Primary research starting points

These are starting references, not substitutes for version-specific feature research:

- Meta models and speech transcription: <https://dev.meta.ai/docs/overview> and <https://dev.meta.ai/docs/models>.
- AI SDK conversation persistence and streaming: <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence> and the installed v7 documentation/types.
- Current shadcn AI patterns: <https://ui.shadcn.com/docs/ai-elements> and existing `packages/ui` components.
- Electron security and process isolation: <https://www.electronjs.org/docs/latest/tutorial/security> and <https://www.electronjs.org/docs/latest/tutorial/sandbox>.
- Greptile open-only review configuration: <https://www.greptile.com/docs/code-review/greptile-json-reference>.
- The repository's current `docs/SPEC.md`, `AGENTS.md`, workspace manifests and source/test callers establish local constraints and behavior.
