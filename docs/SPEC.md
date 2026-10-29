# ScholarOS Specification

## Product summary

**The AI that learns your classes so it can teach you.**

ScholarOS connects the academic resources a student authorizes, understands course expectations, and turns that context into personalized study sessions.

A bounded local browser agent gathers context so students do not have to manually collect and upload everything. ScholarOS answers: **What matters now, what do I understand, and what should I learn next?**

ScholarOS is the working name. The experience must suit nontechnical students.

## Core experience

1. Install one desktop application with normal consumer installation steps.
2. Create an account and sign in through the system browser.
3. Set up a dedicated academic browser workspace and choose permitted services.
4. Sign into each academic service directly on its real website, including SSO and MFA.
5. Review access boundaries, data handling, and optional background activity.
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
- Preserve source links, course context, and retrieval times alongside extracted information.

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

Make scheduled syncing and launch at login opt-in and revocable. Show activity and sync status; support pause, cancellation, and manual sync. Background work stays within existing permissions.

## Architecture and technology

```text
Electron desktop application
  React interface → narrow preload/IPC bridge → main process
                                             ├─ browser agent and permission enforcement
                                             ├─ dedicated Chromium profile through CDP
                                             └─ local SQLite academic data

Next.js web application and API
  Browser authentication, account services, and authorized cloud operations
  └─ PostgreSQL account/authentication data

Shared packages
  UI and styles · authentication · typed environment variables · services · utilities
```

- **Workspace:** TypeScript, pnpm workspaces, and Turborepo, with applications under `apps/` and reusable packages under `packages/`.
- **Desktop:** Electron, Electron Forge, Vite, and React. The renderer uses isolated preload APIs; privileged work belongs in the main process.
- **Web/API:** Next.js App Router and route handlers for browser authentication, account services, and a web interface sharing application logic.
- **UI:** Shared shadcn/Base UI components, Tailwind CSS, and theme tokens. Use React Hook Form and Zod for web forms.
- **Authentication:** Better Auth and its Electron integration, Google/GitHub OAuth, and email/password with email verification. Mailjet delivers verification emails.
- **Data:** Drizzle ORM with PostgreSQL/Neon for cloud account data and `better-sqlite3` for local academic data. Keep cloud database credentials on the server and local database access outside the renderer.
- **Agent:** Stagehand with Chromium/CDP for semantic navigation and extraction; use ordinary browser/DOM APIs for deterministic operations where appropriate.
- **Verification:** Vitest for tests, TypeScript checks, Oxlint, and Oxfmt. Build and test commands belong in workspace manifests.

## Meta model integration

Meta models must interpret course material, connect concepts, synthesize evidence, and adapt tutoring.

- Use a suitable Meta reasoning/multimodal model, such as Muse Spark, for academic understanding and learning decisions.
- Voice transcription can turn a spoken study request into a mission.
- Visual analysis can help explain handwritten work and diagrams when it improves the learning experience.
- Treat SAM as a segmentation tool when supported by its verified API; do not assume it is a general screen classifier or safety decision-maker.

Verify model capabilities in current official documentation. Add models only for concrete learning benefits.

## Privacy, permissions, and authentication

- Keep academic resources, the course graph, and study history local by default. Cloud accounts support authentication, service access, and rate limits.
- Explain and minimize content sent to model providers. Local storage does not imply local inference; avoid academic content in cloud logs by default.
- Students enter academic-service passwords only on the real service. Persist isolated sessions locally and request reconnection when needed.
- Keep personal browser profiles inaccessible. Manage the academic workspace without terminal commands, browser flags, ports, API keys, or developer setup.
- Enforce domain/resource allowlists and mission boundaries in code, outside model prompts. Account for redirects, subframes, popups, downloads, and SSO destinations.
- Agent missions are read-only: read, search, navigate, and retrieve permitted material. Block submissions, quiz-taking, messages, uploads, account changes, deletion, and purchases. Safe navigation can require clicking; enforce effects rather than button appearance or HTTP method.
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
