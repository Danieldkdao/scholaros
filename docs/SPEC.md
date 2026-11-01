# ScholarOS Specification

## Product summary

**The AI that learns your classes so it can teach you.**

ScholarOS connects the academic resources a student authorizes, understands course expectations, and turns that context into personalized study sessions.

A bounded local browser agent gathers context so students do not have to manually collect and upload everything. ScholarOS answers: **What matters now, what do I understand, and what should I learn next?**

ScholarOS is the working name. The experience must suit nontechnical students.

Build the product experience for desktop only. The web application exists for browser authentication, the authorized inference API, and at most a landing page; it does not mirror the desktop experience, and any broader web surface is deferred to a later decision.

## Core experience

1. Install one desktop application with normal consumer installation steps.
2. Create an account and sign in through the system browser.
3. Set up a dedicated academic browser workspace and choose permitted services.
4. Sign into each academic service directly on its real website, including SSO and MFA.
5. Add optional context in a notes-only step, then review access boundaries, data handling, and optional background activity; course discovery is not a prerequisite or a course-map scan in onboarding.
6. Open a unified academic home or give the agent a mission.

Example mission: **“I have a biology exam Friday and 30 minutes to study. Get me ready.”**

The agent finds authorized exam information and materials, connects the concepts, and builds a study session that adapts to the student’s responses.

## Main product areas

### Academic home and radar

- Show courses, upcoming deadlines, exams, announcements, and recommended priorities.
- Explain why a recommendation matters using the deadline, course evidence, and study history.
- Offer clear entry points to start a study session, give a mission, or sync classes.
- Show connection health, last sync times, and services that need the student to sign in again.

### Academic browser and missions

- Maintain a persistent, dedicated Chromium workspace separate from personal browsing.
- Navigate authorized LMS pages, portals, textbook sites, documents, and other connected resources.
- Support missions such as finding exam material, catching up after an absence, or reviewing the coming week.
- Show understandable activity updates, discovered sources, and a way to cancel a mission.
- Pace school navigation, reuse observed rendering dependencies to avoid repeated bootstrap reloads, and respect rate-limit cooldowns across attempts; stop clearly on rate-limit responses instead of treating them as empty course pages.
- Preserve source links, course context, and retrieval times alongside extracted information; checkpoint findings to local storage as pages are read so cancellation does not discard completed work.
- Discover the course list once, then scan each course in its own parallel worker tab within the same academic profile, inheriting connection notes and stopping at that course’s task.
- Auto-save agent settings: a shared navigation delay greater than zero and at most five seconds, defaulting to one second, and an optional URL word block list that is empty by default.
- Open mission tabs in the background without activating each tab; the browser itself may still appear when its process first starts.
- Discover courses from confirmed academic home pages through bounded, protected navigation and Meta classification of observed links; unfamiliar platforms do not require a school-name or course-path allowlist.
- Treat empty course lists as explicit observed evidence, preserve prior results on cancelled or inconclusive refreshes, and distinguish partial coverage and sign-in requirements from successful discovery.

Browsing gathers context; the learning system decides what to learn next.

### Course knowledge and student understanding

Keep two distinct models:

| Model                  | Purpose                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Course knowledge graph | Concepts, prerequisites, relationships, course expectations, and supporting resources.                              |
| Student learning model | Estimates of understanding supported by practice responses, mistakes, confidence checks, and tutoring interactions. |

Link concepts to supporting course material. Distinguish unknown topics from demonstrated difficulties. Understanding estimates are learning aids, not assessments of intelligence or ability.

### Adaptive study sessions

- Build sessions around a deadline, topic, goal, or available time.
- Combine explanations, retrieval practice, worked examples, and feedback where useful.
- Update the learning model from explicit study interactions.
- Revisit prerequisites when a mistake suggests an underlying gap; move on when the student demonstrates understanding.
- Make progress and the next recommended activity easy to understand.

### Evidence-backed assistance

Ground course-specific claims in connected resources. Distinguish teacher-provided requirements from AI inferences, identify conflicting or missing information, and let students inspect the supporting sources.

### Background assistance

Make scheduled syncing and launch at login opt-in and revocable. Show activity and sync status; support pause, cancellation, and manual sync. Background work starts after onboarding is complete and stays within existing permissions.

## Architecture and technology

```text
Electron desktop application
  React interface → narrow preload/IPC bridge → academic service client
                                                │ authenticated local socket
Dedicated Electron academic service process      │
  Structured reads, commands and scoped events ←─┘
  ├─ local SQLite academic data and migrations
  ├─ one scheduler and bounded refresh workers
  └─ protected academic browser workspace through CDP

Next.js web application and API
  Browser authentication, account services, and authorized cloud operations
  └─ PostgreSQL account/authentication data

Shared packages
  UI and styles · authentication · typed environment variables · services · utilities
```

- **Workspace:** TypeScript, pnpm workspaces, and Turborepo, with applications under `apps/` and reusable packages under `packages/`.
- **Desktop:** Electron, Electron Forge, Vite, and React. The renderer uses isolated preload APIs; the desktop main process authenticates renderer frames and delegates academic operations to a separate service process.
- **Web/API:** Next.js App Router and route handlers for browser authentication, account services, and the authorized inference API the desktop app calls. Keep it to those server responsibilities plus an optional landing page; do not rebuild desktop product surfaces for the web.
- **UI:** Shared shadcn/Base UI components, Tailwind CSS, and theme tokens. Use React Hook Form and Zod for web forms.
- **Assets:** Shared images, media, and fonts live in `@scholaros/assets` under `src/`, grouped by purpose with lowercase kebab-case names, and are imported by path — `import logo from '@scholaros/assets/images/logo-light.png'`. Each app bundles what it imports, so no build step or public server is involved: Next.js gives that import static image metadata and Vite gives a URL string, which is why image import typing stays in the consuming app instead of the package. Render light/dark artwork through each app's theme-aware `Image` component, which takes `src={{ light, dark? }}` and falls back to `light` when no dark variant is given. Keep files that need fixed public URLs in `apps/web/public`, installer icons in desktop packaging resources, and student uploads or downloads in runtime storage. See `packages/assets/readme.md`.
- **Authentication:** Better Auth and its Electron integration, Google/GitHub OAuth, and email/password with email verification. Mailjet delivers verification emails.
- **Data:** Drizzle ORM with PostgreSQL/Neon for cloud account data and `better-sqlite3` for local academic data. Keep cloud database credentials on the server and local database access outside the renderer.
- **AI services:** All model calls use Vercel AI SDK through `packages/services/src/ai/`; provider instances live in `models/baseten.ts` and `models/meta.ts`, selected through `models/inference.ts`, configured from typed `serverEnv`. Use the official `@ai-sdk/baseten` and `@ai-sdk/typesafe-ai` adapters.
- **Agent:** Stagehand with Chromium/CDP for semantic navigation and extraction; use ordinary browser/DOM APIs for deterministic operations where appropriate.
- **Verification:** Vitest for tests, TypeScript checks, Oxlint, and Oxfmt. Build and test commands belong in workspace manifests.

## Local academic service

The installed executable also runs independently with `--academic-service`, without creating a desktop window. Hosting it in the shipped Electron runtime keeps the native SQLite ABI, encrypted Better Auth storage, browser integration, extension assets, and installer together; it does not require a separately installed Node runtime. Electron Node mode remains disabled. The desktop process never imports the academic stores or opens the dedicated browser profile.

The service owns academic database access, migrations, browser sessions, refresh jobs, cancellation, and the existing background scheduler. A process singleton and service ownership guard prevent a second academic service from owning the database and browser workspace. SQLite uses normal WAL locking so Drizzle Studio can inspect committed data while the service runs. Close older desktop instances before activating an updated installation; records and account-specific browser profiles remain in their existing locations.

Communication uses a Unix domain socket on macOS/Linux and a named pipe on Windows. A private endpoint file supplies a random credential to the desktop main process; the credential is never passed to the renderer, placed in a URL, or logged. Every request and subscription authenticates and validates its protocol version, and only named academic operations are available. Subscriptions acknowledge readiness before the desktop loads its snapshot. Events identify account and resource scope; reconnecting clients reload persisted state instead of requiring an event history.

Cached reads do not wait for browser navigation or inference. Equivalent refresh requests share one job; all-course work is exclusive and uses at most four course-content workers, while at most two individual courses can refresh together. Targeted refresh uses a saved course destination and the existing authenticated profile, verifies the destination after SSO, and does not rediscover every course. Navigation pacing, request guards, model limits, rate-limit cooldowns, and cancellation remain enforced in code. Completed findings are checkpointed before subsequent navigation and survive partial or cancelled scans.

Scheduling requires saved academic consent, completed onboarding, a ready workspace, and the opt-in background preference. Manual refresh does not require scheduled-sync consent. Transient scheduled failures back off and stop after three failed attempts; sign-in failures wait for explicit intervention. Confirmed expired ScholarOS credentials are not repeatedly retried until the credential changes. Login preferences are applied only when the OS state differs from the saved choice. Pause applies to the current service session; disabling background sync is the persistent revocation control.

Closing the last desktop window exits the desktop process and leaves the independent service running only when background sync is enabled. Explicitly quitting the desktop application requests service shutdown, cancels browser work, and closes the academic workspace. Reopening the desktop reconnects to an existing service or starts one and reloads cached data; restarting the service restores saved scheduling eligibility. This is not an installed operating-system daemon and does not promise continuation after explicit Quit. Launch at login remains opt-in and uses the existing application login-item integration; OS-managed unattended service installation is a separate delivery task. Background tabs do not activate themselves, but starting Chromium can still show its window.

Installers bundle the service in the same application executable, including the existing native-module unpacking and Stagehand extension resources. Application updates must stop the service before replacing the installation; breaking transport changes require a protocol-version change, which incompatible clients reject. Windows startup, named-pipe ACLs, signing, and installer updates must be verified on Windows hardware.

## Structured academic records and freshness

Course discovery selects only observed destination IDs. Extraction is a separate, resource-specific operation: courses carry explicit names, codes, sections, terms, descriptions and instructors; assignments carry requirements, kind, submission/availability state, separate due/opening/closing dates, points and supporting links; announcements carry body, author, publication/update dates and supporting links. A course label is never parsed into a confirmed code or term, and an exam mentioned in an announcement is never treated as its publication date.

Dates distinguish exact instants with offsets, local dates and times whose timezone is unresolved, calendar dates without times, and unresolved source wording with a reason; an absent deadline is `null`. The application supplies the actual retrieval timestamp, observed locale, course scope and source context. The device timezone is not a course timezone. Calendar validity, source references, offered link IDs, numerical bounds and coverage are checked before persistence; invalid records downgrade collection coverage while valid findings remain usable. Reaching a batch or text limit is partial coverage.

Normalized resource fields and supporting evidence are stored as typed JSON alongside existing identity and query columns. Trusted retrieval/freshness timestamps and meaningful content-change timestamps are separate. Source IDs take precedence over observed item URLs for identity, with a scoped page-and-title fallback for items that have neither; a collection URL alone never identifies all its items. Existing IDs and relationships survive adoption of richer metadata. Legacy records remain readable immediately, preserving validated ISO dates and retaining other date wording as unresolved until refreshed.

Only a successful, complete collection scan can retire missing records. Partial coverage, unknown assignment eligibility, pagination gaps, failed authentication, timeouts, limits and cancellation preserve previous records. Retirement is reversible and keeps evidence and associated history. An unchanged check advances freshness and evidence without claiming that academic content changed. Unknown assignment status never becomes confirmed active, unsubmitted work.

Consumers use normalized dates and fields. Exact instants compare chronologically; date-only values compare as calendar days, with the viewer's display day used when mixing precisions and date-only items listed before timed items on the same day. Local times with unresolved timezones form a separate ordered group, followed by unresolved/missing dates in stable order. Date wording and precision remain visible through concise labels and tooltips; only an exact instant establishes a timed overdue claim.

A future study-session preparation operation should use the existing targeted course refresh and structured course read, inspecting collection status and freshness before presenting requirements as verified. Cached or partial sources remain available with their uncertainty; this boundary does not implement tutoring, study UI, continuous page watchers, or a learning-model schema.

Runtime and contract guidance follows the installed dependencies and the official [Electron process and fuse documentation](https://www.electronjs.org/docs/latest/tutorial/fuses), [SQLite WAL concurrency](https://www.sqlite.org/wal.html), [AI SDK structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), and [Base UI composition](https://base-ui.com/react/handbook/composition).

## Meta model integration

Meta models must interpret course material, connect concepts, synthesize evidence, and adapt tutoring.

- Use a suitable Meta reasoning/multimodal model, such as Muse Spark, for academic understanding and learning decisions.
- Voice transcription can turn a spoken study request into a mission.
- Visual analysis can help explain handwritten work and diagrams when it improves the learning experience.
- Treat SAM as a segmentation tool when supported by its verified API; do not assume it is a general screen classifier or safety decision-maker.

Use `generateText` with schema-validated `Output.object` for academic extraction and bounded navigation choices through the selected inference provider; navigation results may only select offered target IDs. Route desktop inference through the authenticated Next.js API; keep provider credentials in the web server environment, never the desktop renderer or distributed app. Preserve cancellation, request limits, source validation, and user permissions; do not replace these with model decisions. Disable content telemetry by default and bound provider calls with deadlines and explicit retry limits.

Server configuration uses `INFERENCE_PROVIDER` (`baseten` by default, or `meta`) and the selected provider's API key, supplied in the web app environment and read via `@scholaros/env/server`. `BASETEN_MODEL` defaults to `meta-models/muse-spark-open-1026`; `META_MODEL` defaults to `muse-spark-1.3-contributor`. All agent inference operations use this selection without falling back to another provider.

Verify model capabilities in current official documentation. Add models only for concrete learning benefits.

## Privacy, permissions, and authentication

- Keep academic resources, the course graph, and study history local by default. Cloud accounts support authentication, service access, and rate limits.
- Explain and minimize content sent to model providers. Local storage does not imply local inference; avoid academic content in cloud logs by default.
- Students enter academic-service passwords only on the real service. Persist isolated sessions locally and request reconnection when needed.
- Resource notes may authorize choosing one explicitly named existing account from an unambiguous account picker; credential inputs, unmatched accounts, and further consent require the student to continue manually.
- Keep personal browser profiles inaccessible. Manage the academic workspace without terminal commands, browser flags, ports, API keys, or developer setup.
- Enforce domain/resource allowlists and mission boundaries in code, outside model prompts. Account for redirects, subframes, popups, downloads, and SSO destinations.
- Agent missions gather context by reading, searching, and navigating permitted material; exam, quiz, and submission words do not prevent reading by default. Keep mutating requests and form submissions blocked, and apply URL word restrictions only when the student configures them.
- Require fresh user authorization for any future expansion into write actions. A model classifier may assist review but cannot be the permission boundary.
- Protect browser sessions and application credentials, restrict IPC, and prevent cloud requests from becoming arbitrary machine-control commands.
- Provide controls to revoke sources, stop background work, and delete local academic data and the dedicated profile.
- Desktop sign-in requests use fresh state/PKCE and explicit user action. Completed browser handoffs must be refresh-safe and must not replay requests or cause redirect loops.

## Product boundaries and delivery

ScholarOS is a proactive learning workspace, not a homework-completion bot, cheating assistant, generic chatbot, PDF uploader, or flashcard collection.

Prioritize reliable workflows over broad LMS coverage. Demonstrate one mission from source discovery to evidence-backed planning, practice, and adaptation to the student’s answer.

Distribute consumer-friendly macOS and Windows installers from one codebase. Account for platform-specific builds, signing, updates, and startup permissions.

For the Meta hackathon, target “Build for Your World,” materially use Meta models, and demonstrate original event-built functionality. Verify requirements for the public repository and three-minute demo against the official guide.

`AGENTS.md` is the authority for repository working conventions. Keep this document focused on product behavior and architecture, not implementation progress, task lists, or development history.
