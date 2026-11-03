# ScholarOS Product Specification

## Product purpose

ScholarOS is a desktop learning workspace that uses a student's authorized course context to help them understand one course at a time. The web application provides authentication and the bounded inference API; it does not mirror the desktop product. This document states intended product behavior, not release verification; actual evidence and open gates belong in `docs/release-verification.md`.

## Product surface

The desktop app centers on **Today**, **Courses**, **Study**, **Context**, **Connections**, and **Settings**. There is no Planner product surface; any legacy Planner route redirects to the appropriate Study or Today destination. The experience is English-first and macOS-first, with Windows distribution planned but not considered verified by macOS results.

Today presents current authorized course attention, source freshness, upcoming work, recent study activity, and evidence-backed next steps. Recommendations explain their source and prefill Study setup; they never start a session or infer a grade. Empty, partial, offline, disconnected, and stale states are explicit and useful rather than filled with invented content.

## Focused Study

A study session has exactly one selected course, one of five goals, and an optional target assignment, topic, selected Context items, and duration:

- **Understand a topic**
- **Prepare for an exam**
- **Practice what I know**
- **Review graded mistakes**
- **Help me get started on an assignment**

Setup saves before the session begins, validates the selected course and target, and never autostarts from a prefilled link. Supplementary uploaded material does not grant access to another connected course. Session history is searchable and resumable; a focused session view keeps the course, goal, cited context, draft, timer, and exit action easy to find.

Timed sessions use an absolute persisted deadline. Minimizing, changing windows, suspending the machine, or closing the last window does not pause time. Finish, extend, or continue without a timer are explicit idempotent actions. Expiry preserves accepted work and the draft, produces one status per timer revision, and is reconciled when the app reopens; explicit Quit stops the app-owned service and does not promise background reminders.

The tutor is **text-only**. Microphone dictation is optional input: the user explicitly starts and stops capture, sees editable provisional/final text, and chooses when to send it. ScholarOS does not speak tutor responses, automatically submit recognized speech, or save raw audio. A changed draft is never overwritten by a late transcript.

Tutor answers distinguish connected-source facts, general explanations, and inferences. Course-specific claims use inspectable references to the selected course or selected personal Context, with page/heading locators where available. Missing, stale, partial, historical, removed, unreadable, or uncertain evidence is labeled honestly. Students can stop or retry a response without duplicating a turn; provider errors do not become fabricated answers or fallback-provider calls.

## Learning activities and assessment

Practice can use generated interactive activities and app-owned quizzes. An interactive activity may use bounded HTML/CSS/JavaScript, DOM/SVG/Canvas and accessible input, but runs in a dedicated isolated Electron process/view with no preload, Node access, app bridge, cookies, file access, external navigation, network, popup, download, permission, or WebRTC egress. The trusted host owns authorization, content versions, state validation, attempt identity, persistence, and the single live executor. Inline and expanded presentations move the same runtime; expansion must not reset state. Saved activities remain versioned and can be resumed offline when their authorized data is present.

A quiz defaults to end-of-quiz feedback. Per-answer feedback is an explicit option for ordinary practice. Exam mode withholds answer keys, hints, and solutions until submission and permitted review. Switching to guided help marks that attempt as assisted before help is shown. Scores are learning feedback only; activity output never changes an official LMS grade or claims mastery by itself. Uncertain answers and accepted alternatives remain possible outcomes.

Assignments whose completion or remaining attempts are unknown, active, reopened, or conflicting stay protected. The tutor may explain concepts, requirements, and a bounded next step, but does not provide a worked answer to active assessed work or reconstruct it cumulatively across turns, sessions, source previews, memory, practice, or hidden activity data. Verified source-provided feedback may be explained only while current local policy allows it. This is a defense-in-depth learning policy, not a promise that semantic assessment is infallible.

## Context, course knowledge, and memory

Context holds user-authored notes/preferences, user-selected files, and appropriately authorized course material. File selection is native and explicit; the renderer cannot submit an arbitrary path or remote URL. Extraction is bounded. PDF page numbers remain aligned across blank pages; scanned/handwritten interpretation remains uncertain unless actually supported. Unsupported formats, including PowerPoint, are not silently treated as readable. Each source version is immutable; retries or replacements preserve historical citations while current search uses only an available, authorized version. Removing a source stops future retrieval and marks earlier references historical or removed.

The course-knowledge graph describes course concepts, relationships, prerequisites, and supporting sources. The learning model stores small, evidence-linked observations about practice and demonstrated understanding. Unknown is not failure, and no fixed ability, intelligence, or clinical label is inferred. Explicit preferences remain distinct from provisional observations; user corrections override inferred older preferences, and deletion invalidates prepared context and recommendations.

## Grades, consent, and connected services

Grade collection is off by default behind one explicit revocable setting. A collected value is not treated as proof that an assignment is finished or has no retry, resubmission, or retake opportunity. Missing, stale, conflicting, and pass/fail evidence retains its observed uncertainty, including a legitimate numeric zero. Revoking consent invalidates pending reads and future grade-derived use; removing collected grades does not erase unrelated Context or practice history.

Connected academic services are read-only. ScholarOS may use an already authorized session to inspect permitted course and assignment pages, but never submits, edits, starts, resumes, or retakes coursework. It respects the existing browser scope, rate limits, cancellation, sign-in boundaries, and user-selected connections. Personal browsing profiles and credentials are not imported into the dedicated academic browser workspace.

## Settings, devices, and notifications

Settings apply valid edits automatically, preserve pending changes when closed, and show save/retry status in the fixed settings indicator; there is no Save button. Invalid fields have accessible inline errors. Browser-workspace replacement stages and verifies a separate candidate before committing, does not copy personal cookies, and can cancel without replacing the current workspace. A signed-in account on a new device still requires local device/browser setup.

Notifications are off by default and require an explicit enable action before requesting operating-system permission. User-controlled categories, quiet hours, focus state, account, current target, and permissions are rechecked before delivery and routing. Only actual settled outcomes can notify; queued work, polling, or streaming tokens are not completion. Delivery is at-most-once when uncertain. Explicit Quit stops app-owned work; deadlines and pending state are reconciled on reopening rather than promising a daemon or push service.

## Data and architecture

The Electron desktop renderer uses shared UI components and a narrow authenticated preload/IPC bridge. Desktop main owns trusted windows, file/microphone/notification adapters, and the academic service lifecycle. A separate service process inside the shipped Electron runtime owns local academic SQLite data, migrations, Context originals, the dedicated browser profile, scoped jobs, cancellation, and named service operations. Native SQLite remains outside the renderer; test/build processes use isolated fixture profiles and never replace a user's working profile.

The Next.js web app owns browser authentication and bounded server-side Meta inference/transcription. The current model decision is Meta Muse Spark Standard `muse-spark-1.3` for text/vision and Meta `muse-voice-transcribe-1.0` for dictation input; there is no provider/model fallback. The exact configured identity, supported operation, and current provider terms must be verified for release. Cloud storage is for account/authentication data, not academic transcripts or a synchronized academic history. The renderer and local database never receive provider credentials. Inference sends only a bounded, currently authorized context package. Model output remains private until host-side schema, ownership, policy, citation, and resource checks approve it.

Generated activities use an actual isolated Electron runtime rather than a DOM iframe or Node `vm`. Verify the packaged Electron process, native module ABI, fuse wire, private protocol, CSP/headers, process boundary, file controls, network/WebRTC denial and offline assets on the real packaged binary. Source config and DOM-only tests do not prove isolation. If required isolation fails, execution must fail closed with recoverable UI rather than weakening security settings.

## Privacy and launch boundary

Academic sources, browser sessions, grades, practice answers, study history, learning observations, and original uploads are sensitive. Minimize local retention and provider transmission, avoid academic text/grades/audio in logs and notifications, and delete only the requesting fixture/account's data. Shareable demos use synthetic identities and test-owned course/source/assignment data; do not publish real student records, grades, questions, or screenshots without explicit permission.

The product does not impose an age gate. That is a product choice, not a legal-compliance conclusion or exemption. COPPA, education-record privacy, GDPR and other regional rules, school/provider terms, guardian or school consent, retention, and data-processing obligations require qualified human review before any public child-facing launch. See `docs/privacy-launch-review.md`; this specification makes no legal certification.

## Platform and release boundaries

macOS packaging must verify the actual app bundle, native SQLite migration/FTS, PDF.js and worker resources, Stagehand extension resources, SDK/worklet assets, runtime versions, actual fuse wire, signed/notarized state when required, and a reproducible test-owned demo profile. Windows requires a separate real-device checklist for paths, named pipes/ACLs, browser assets, native modules, installer/shortcuts, microphone, notifications, and package lifecycle; macOS verification cannot close it. See `docs/windows-verification.md` and `docs/release-verification.md` for evidence and gates.

Hackathon eligibility, waiver, video, repository visibility, source/asset/model rights, and submission rules must be checked against the organizer's current official materials before any external submission. Prepare demo materials only until the complete rules and required human approvals are available.

`AGENTS.md` remains the authority for repository working conventions. Keep implementation history and test claims out of this product specification.
