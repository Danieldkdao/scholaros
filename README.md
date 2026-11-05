# ScholarOS

A desktop study workspace that turns your course materials into focused, interactive learning sessions. ScholarOS brings together course context, a grounded AI tutor, simulations, and practice so students can understand their work and build confidence.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon).

[Try the demo](#try-the-demo--no-account-needed) · [Full setup](#run-locally) · [Try a study session](#try-a-study-session) · [Build the desktop app](#build-the-desktop-app)

## Features

- **Your courses in one place:** courses, assignments, announcements, read-only LMS connections, and optional background syncing. Schoology is the primary integration target.
- **A personal Context library:** notes, preferences, PDFs, Word documents (.docx), text/Markdown, images, and screenshots that can be associated with a course.
- **Focused AI tutoring:** choose one course and a goal, then learn through a flowing conversation with source references and optional timers.
- **Interactive learning:** generated simulations, graphs, quizzes, and practice exams alongside the conversation, with an expanded activity panel and saved history.
- **Help that supports learning:** concept explanations and bounded hints for active coursework, with review of graded work only when current evidence permits it; ScholarOS never submits schoolwork.
- **An adaptive workspace:** learning preferences, Today recommendations, optional grade context, editable microphone dictation, and configurable notifications.

## Try the demo — no account needed

Choose **Try demo** on the desktop sign-in screen, or open `/demo` on the web server. The guided walkthrough uses clearly labeled sample courses, editable temporary notes, a working Python exercise, and a quiz. No account, database URL, OAuth setup, or sign-in is required for the public walkthrough. Its sample content is separate from the optional live AI result.

Use Node.js 24+ and pnpm 12.15.0, then clone and install:

```sh
git clone https://github.com/Danieldkdao/scholaros.git
cd scholaros
pnpm install --frozen-lockfile
```

Create `apps/web/.env.local` with the following values. The API key enables live sample tutoring; leave it out to explore the prepared activities without model calls:

```dotenv
DEMO_API_ENABLED=1
META_API_KEY=your-meta-model-api-key
META_MODEL=muse-spark-1.3
META_DEMO_LOGGING=1
```

Start the web server with `pnpm dev:web` and visit `http://localhost:3000/demo`. The demo endpoint accepts only fixed sample lesson actions and has bounded requests, output, concurrency, and timeouts; it cannot read accounts, uploaded files, grades, or connected courses. Real account routes and personal AI features continue to require normal authentication. Leave `DEMO_API_ENABLED=0` when public sample inference is not wanted.

With `META_DEMO_LOGGING=1`, the terminal prints `[Meta API]` records containing the actual endpoint, model, request ID, HTTP status, duration, and reported token counts. Prompts, responses, headers, credentials, and student content are excluded. A missing token count is reported as `null`. Restart the web server after changing these values; never put the API key in desktop or public client environment files.

## How it works

The **Electron desktop app** is the study workspace. It stores academic context, uploads, and study history locally in SQLite and manages a separate browser workspace for authorized course access. The **Next.js web app** provides sign-in and authenticated AI services, backed by PostgreSQL. Open the desktop app to study; the website is its account and API service.

Inference uses the Vercel AI SDK with [Meta Model API](https://dev.meta.ai/docs/overview):

| Model                                                   | Role in ScholarOS                                                                                                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Muse Spark Standard — `muse-spark-1.3`**              | Course discovery, grounded tutoring, document understanding, learning activities, practice generation, and feedback. Structured responses let the host validate sources and proposed actions before showing them. |
| **Muse Voice Transcribe — `muse-voice-transcribe-1.0`** | Speech-to-text for editable chat input. Students review and send the transcript; tutor replies are text.                                                                                                          |

Model credentials stay on the web server. Inference calls Meta directly, and the desktop runs without a local GPU.

## Run locally

### 1. Install the prerequisites

- **macOS** for the verified desktop build; Apple Silicon packaging has been checked. Windows needs separate device testing.
- **Node.js 24+**, Git, and **pnpm 12.15.0**.
- **Google Chrome, Microsoft Edge, or Brave** for the dedicated academic browser workspace.
- A PostgreSQL database, Meta Model API access, Google and GitHub OAuth credentials, and Mailjet credentials with a verified sender, configured below.

```sh
npm install --global pnpm@12.15.0
git clone https://github.com/Danieldkdao/scholaros.git
cd scholaros
pnpm install --frozen-lockfile
```

The workspace installs the JavaScript and native dependencies, including Electron, React, Next.js, Drizzle, SQLite, PDF.js, and document extraction libraries. If a native dependency needs compiling on macOS, install Apple's Command Line Tools with `xcode-select --install`, then retry installation.

### 2. Configure services and environment files

```sh
cp apps/web/.env.example apps/web/.env.local
cp apps/desktop/.env.example apps/desktop/.env
```

Fill in **`apps/web/.env.local`** using your own development credentials:

| Variable                                   | What to set                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                             | PostgreSQL connection string. A [Neon](https://neon.com/docs/connect/connect-hub) development database works; keep its supplied SSL options. |
| `DATABASE_URL_UNPOOLED`                    | Direct database connection string for migrations. Required when `DATABASE_URL` uses a pooled endpoint; otherwise leave blank.                |
| `BETTER_AUTH_URL`                          | `http://localhost:3000` for this local setup.                                                                                                |
| `BETTER_AUTH_SECRET`                       | A random secret of at least 32 characters; generate one with `openssl rand -base64 32`.                                                      |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credentials for a [Google OAuth web application](https://better-auth.com/docs/authentication/google).                                        |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Credentials for a [GitHub OAuth application](https://better-auth.com/docs/authentication/github).                                            |
| `MAILJET_API_KEY`, `MAILJET_API_SECRET`    | Your [Mailjet](https://dev.mailjet.com/docs/email-api) API credentials for verification email.                                               |
| `SENDER_EMAIL`                             | An email address verified as a sender in Mailjet.                                                                                            |
| `META_API_KEY`                             | Your Meta Model API key with access to the models above. Required for AI features, though the server can start without it.                   |
| `META_MODEL`                               | Keep `muse-spark-1.3`; the study pipeline expects this Standard model.                                                                       |
| `BROWSER_NAV`                              | Keep `decision`, the default browser navigation mode. `inout` is the alternative supported mode.                                             |

Both OAuth credential pairs and the Mailjet fields are required by the current server configuration, even if you intend to use just one sign-in method. `NODE_ENV` is set by the development/build commands; you do not need to add it.

Register these local OAuth callback URLs with the respective providers:

| Provider | Callback URL                                     |
| -------- | ------------------------------------------------ |
| Google   | `http://localhost:3000/api/auth/callback/google` |
| GitHub   | `http://localhost:3000/api/auth/callback/github` |

Use `http://localhost:3000` as the application origin/homepage. If Google OAuth is in testing mode, add your sign-in account as a test user.

In **`apps/desktop/.env`**, set:

```dotenv
VITE_API_URL=http://localhost:3000
```

Keep `VITE_API_URL` and `BETTER_AUTH_URL` on the same origin, including hostname and port; do not mix `localhost` and `127.0.0.1`. Only the public API URL belongs in the desktop environment. Keep database, email, OAuth secrets, and model keys in the web environment; these files are ignored by Git.

### 3. Initialize the database

After filling in the web environment, run the checked-in PostgreSQL migrations:

```sh
pnpm --filter @scholaros/cloud-db db:migrate
```

The desktop creates and migrates its own local SQLite database on startup. No separate SQLite installation or manual table creation is needed.

### 4. Start both applications

From the repository root, run the web service in one terminal:

```sh
pnpm dev:web
```

It runs at **[http://localhost:3000](http://localhost:3000)**. In another terminal, also from the root:

```sh
pnpm exec dotenv -e apps/desktop/.env -- pnpm dev:desktop
```

The explicit environment loader supplies the desktop API URL to both Electron and its renderer. Keep the web service running while using online features.

## Try a study session

1. Open the desktop app, sign in through its browser flow, and finish local browser setup.
2. In **Courses**, choose **Add courses** and create a sample course such as _Intro Physics Lab_. A manual course lets you try studying before connecting an LMS.
3. In **Context**, add a note and associate it with that course. For example: “For an ideal pendulum at a small angle, period is `T = 2π√(L/g)`. Increasing length increases period; mass does not affect this ideal model.”
4. In **Study**, select the course, choose **Understand a topic**, select the note, and start a session.
5. Ask: “Help me understand what changes a pendulum's period, then make an interactive comparison and a short practice quiz.” Explore the activity, expand it, and inspect its source references.
6. Return to **Study** to revisit saved sessions. Add your own authorized LMS connection in **Connections** when you want course syncing; enable grade access, dictation, or notifications only when you want them.

The public walkthrough is available locally at [localhost:3000/demo](http://localhost:3000/demo); the full study workspace runs in the desktop app. There is no published installer or hosted demo URL. Use sample materials when recording; [the demo runbook](docs/demo-script.md) includes a synthetic-data scenario.

## Build the desktop app

For a macOS app bundle, including the registered browser-to-app sign-in scheme:

```sh
pnpm exec dotenv -e apps/desktop/.env -- pnpm package
```

On Apple Silicon, open the result with:

```sh
open apps/desktop/out/scholaros-darwin-arm64/scholaros.app
```

Keep the web service running. Local macOS packages are ad hoc signed for development and are not notarized distribution releases; open the packaged app from Finder when granting microphone or other macOS permissions. To use your own hosted backend, deploy `apps/web`, configure its server variables and production OAuth callbacks, then set the desktop API URL to that HTTPS origin **before rebuilding**.

### Temporary sign-in without Keychain

For a temporary desktop session that avoids Keychain access, quit the running desktop and launch the **newly built package** explicitly:

```sh
open -n apps/desktop/out/scholaros-darwin-arm64/scholaros.app --args --session-only
```

Normal browser sign-in and server authorization still apply. Desktop credentials and pending sign-in state stay in RAM and disappear when the app quits; existing encrypted credentials are neither read nor replaced. This mode requires the online backend and does not use saved offline sign-in grants. Course data still uses the normal local workspace.

For UI development, `pnpm exec dotenv -e apps/desktop/.env -- pnpm dev:desktop:session` enables the same temporary mode. On macOS, complete browser sign-in in the packaged app: generic development `Electron.app` instances can share a URL-scheme identity with old worktrees, sending the callback to the wrong process. A callback must return to the same instance that started sign-in.

## Checks and troubleshooting

```sh
pnpm --filter @scholaros/desktop test
pnpm --filter @scholaros/services test
pnpm --filter @scholaros/web test
pnpm typecheck
pnpm lint
```

Ordinary tests use fixtures. Live-model and packaged-runtime checks require explicit opt-in; microphone, notifications, and Windows behavior also need device testing.

| Problem                                             | Check                                                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing environment variables                       | Fill every required web field above; restart the web server after edits.                                                                                                                        |
| Database migration fails                            | Use the direct connection in `DATABASE_URL_UNPOOLED` when the regular URL is pooled.                                                                                                            |
| Browser sign-in finishes but the desktop is waiting | Confirm matching origins and OAuth callbacks, keep the intended app open, and try the packaged app so macOS can register its URL scheme. The native handoff remains a manual verification item. |
| AI features are unavailable                         | Check Meta key access/quota and `META_MODEL=muse-spark-1.3`; unsupported configurations fail closed rather than switching providers.                                                            |
| Dictation or notifications do not work              | Enable the feature in ScholarOS Settings and check the app's corresponding macOS permission.                                                                                                    |

## Project layout

- `apps/desktop` — Electron study workspace, local database, and academic browser service.
- `apps/web` — Next.js authentication and AI API.
- `packages/services` — Meta inference, learning contracts, and email services.
- `packages/auth`, `packages/cloud-db`, `packages/env`, `packages/ui` — shared authentication, PostgreSQL schema, environment validation, and UI primitives.

Read the [product specification](docs/SPEC.md), [demo runbook](docs/demo-script.md), and [Windows checklist](docs/windows-verification.md) for deeper context. This release is English-first and macOS-first. Live LMS content varies by source; partially verified collections remain labeled, and native permissions and Windows need device-specific checks.
