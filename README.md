# ScholarOS

A desktop study workspace that turns your course materials into focused, interactive learning sessions. ScholarOS brings together course context, a grounded AI tutor, simulations, and practice so students can understand their work and build confidence.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon).

[Run locally](#run-locally) · [Try a study session](#try-a-study-session) · [Build the desktop app](#build-the-desktop-app)

## Features

- **Your courses in one place:** courses, assignments, announcements, read-only LMS connections, and optional background syncing. Schoology is the primary integration target.
- **A personal Context library:** notes, preferences, PDFs, Word documents (.docx), text/Markdown, images, and screenshots that can be associated with a course.
- **Focused AI tutoring:** choose one course and a goal, then learn through a flowing conversation with source references and optional timers.
- **Interactive learning:** generated simulations, graphs, quizzes, and practice exams alongside the conversation, with an expanded activity panel and saved history.
- **Help that supports learning:** concept explanations and bounded hints for active coursework, with review of graded work only when current evidence permits it; ScholarOS never submits schoolwork.
- **An adaptive workspace:** learning preferences, Today recommendations, optional grade context, editable microphone dictation, and configurable notifications.

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

There is no published desktop download or hosted study demo at present; the local desktop is the reproducible way to try this version. [The longer demo runbook](docs/demo-script.md) includes a synthetic-data scenario and expected checks, not a claim that every native journey has been verified.

## Build the desktop app

For a macOS app bundle, including the registered browser-to-app sign-in scheme:

```sh
pnpm exec dotenv -e apps/desktop/.env -- pnpm package
```

On Apple Silicon, open the result with:

```sh
open apps/desktop/out/scholaros-darwin-arm64/scholaros.app
```

Keep the web service running. Local packages are development builds, not signed/notarized distribution releases. To use your own hosted backend, deploy `apps/web`, configure its server variables and production OAuth callbacks, then set the desktop API URL to that HTTPS origin **before rebuilding**.

## Checks and troubleshooting

```sh
pnpm --filter @scholaros/desktop test
pnpm --filter @scholaros/services test
pnpm --filter @scholaros/web test
pnpm typecheck
pnpm lint
```

Ordinary tests use fixtures. Live-model, packaged-runtime, and hardware checks have separate opt-in requirements; see [release verification](docs/release-verification.md) for their scope and remaining manual checks.

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

Read the [product specification](docs/SPEC.md), [master plan](docs/master-plan.md), and [verification record](docs/release-verification.md) for deeper context. This release is English-first and macOS-first; live LMS, signed-in native flows, microphone/notification delivery, and Windows still need the documented manual checks.
