## Branch naming

- Use conventional branch names such as `feat/some-feature`, with a short description of the work. Use ordinary feature names in branches and progress updates.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

## Required filenames — check before creating files and before finishing

- Use lowercase kebab-case for every authored filename, including components, hooks, utilities, tests, scripts, and documentation. Separate words with hyphens: `project-filters.tsx`, `use-projects-filters.ts`, and `project-filters.test.tsx`.
- Keep React component and type names in PascalCase inside the file. A component named `ProjectFilters` belongs in `project-filters.tsx`. Treat component-style names in requests, including `ProjectFilters.tsx`, as referring to the component and normalize the filename to kebab-case under this project convention.
- Before creating or renaming a file, check its proposed path against this rule. Preserve platform and test suffixes, such as `native-select.ios.tsx` and `project-filters.test.tsx`.
- Preserve filenames required by tools or frameworks, such as `AGENTS.md`, `CLAUDE.md`, Expo Router's `_layout.tsx`, and route parameter syntax. Preserve tool-generated filenames. These exceptions do not apply to ordinary component files.
- Before reporting completion, inspect every added or renamed file, including untracked files. Correct any filename that violates this rule, update imports and references, and verify that no stale paths remain. Filename verification is part of completing every file-changing task.

## Git

- Do not perform any Git actions like committing changes or creating branches, unless explicitly told to.
- Every commit subject must use only `type: description`. Choose a lowercase prefix such as `feat`, `fix`, `refactor`, `style`, `docs`, `test`, `build`, `ci`, `perf`, or `chore`. Never add a scope or specifier to the prefix.
- Never use parentheses anywhere in a commit message, including its subject and body. Check the entire message before committing.
- Prefer lowercase descriptions. Capitals are allowed when useful for proper names, acronyms, or case-sensitive code identifiers.
- Group commits by topic, feature, fix, or closely related changes. When a file contains changes for multiple topics, stage the relevant hunks separately across commits. Commit all changes in a file together only when every change belongs to that commit's topic.
- Review the staged diff before each commit to confirm that it contains only the intended related changes, and account for all requested changes across the resulting commits.

## Working process

- Before making changes, read `docs/SPEC.md` to understand the application's purpose, intended behavior, architecture, and constraints.
- Work like a practical, efficient senior engineer. Think through each task in steps and choose the simplest implementation that meets the requirements.
- Before implementing any new feature, always research the latest official documentation for the technologies involved, even when familiar with them. Make sure to also research the best practices, guidelines, and compatability information before continuing. Verify guidance against the versions used by this project. This research is required for every new feature, without exception.
- If you are going to implement tests to test the feature you are going to build, implement the tests first, before implementing the feature itself. Then test and continue from there.
- Never write or run dedicated tests for schema files, including database table definitions. Verify schema changes through code review and TypeScript typechecking instead.
- Break large features into small, realistically completable chunks with a clear outcome and verification step. Aim to touch fewer than ten files per chunk; use coherent boundaries rather than forcing an arbitrary file limit. If the feature is large and would require more than ten files to implement, go back and suggest a chunked step-by-step plan to the user where each step is less than ten files, UNLESS THEY SPECFIED OTHERWISE. Each chunk should be a complete, testable unit of work that can be verified independently.
- Implement and verify one chunk at a time, continuing through the requested feature while keeping each change manageable and easy to review.
- Prioritize clean, modular, efficient, scalable, and maintainable code that is easy to read and learn from. Introduce abstractions when they serve a concrete need.
- Before implementing a feature or custom utility, inspect the relevant workspace's package manifest, installed dependencies, and existing usage for libraries that already solve the problem; prefer a suitable installed library after checking its versioned API, such as TanStack Pacer for debouncing.
- Prefer the smallest readable implementation. Before adding components or utilities, search for equivalent behavior and extend a suitable existing implementation when a small change serves the same responsibility. Keep unrelated features separate; avoid abstractions added only for hypothetical reuse.
- Separate components and modules by responsibility. Keep files focused and use a clear, consistent folder structure that groups related code and makes it easy to find.
- Add comments where you need to explain why something is done a certain way, especially if it is not obvious. Avoid comments that simply restate what the code does and do not add comments excessively. Use comments to explain the reasoning behind decisions, trade-offs, and any non-obvious implementation details.
- Before starting a desktop or web development server, check for an existing server for that application and reuse it when available. Track which servers and application instances you start yourself. Leave user-started servers and application instances running; stop only those you started before finishing, unless the user explicitly requests otherwise.
- Before creating a helper or implementing reusable logic, search the codebase with `rg` for equivalent behavior, not just the proposed function name. Inspect relevant helper, utility, formatter, hook, and service files in shared folders and feature folders, plus their callers, to find implementations that already solve the same problem. Reuse or extend a suitable implementation before adding another. Create new logic only after this search finds no suitable implementation; keep feature-specific helpers in their feature folder and genuinely shared helpers in the appropriate shared folder.
- For table enums, export them from a `shared.ts` file in the root of the `db` folder. For each enum, you should export three things.

1. An array of all the enum values, for example `export const projectStatuses = ['draft', 'published', 'archived'] as const;`
2. A type that represents the enum values, for example `export type ProjectStatus = (typeof ProjectStatusValues)[number];`
3. The enum itself using PgEnum, for example `export const projectStatusEnum = pgEnum('project_statuses', projectStatuses);`
   Note the naming conventions for each.

- Generally, put all types in the `lib/types.ts` file, unless they are specific to a feature or resource, in which case they should be defined in that feature's folder or belong to a certain component. For example, types related to projects should be defined in `features/projects/types.ts`. On the other hand, types related to components like prop types and types related to those should live in the same file as the component. Similarly, put all shared constants in the `lib/constants.ts` file, unless they are specific to a feature or resource, in which case they should be defined in that feature's folder. Same component rule for constants and functions as the types. For example, constants related to projects should be defined in `features/projects/constants.ts`. Do not create your own files in the lib folder that have both types, constants, and functions related to some resource or functionality because that gets messy and hard to maintain. Keep the lib folder for shared types, constants, and functions that are used across the application.
- For all tables, make sure to export all relations defined along with two types. A select type and an insert type. For example, for the `projects` table, you should export `ProjectSelectData` and `ProjectInsertData` from the `ProjectTable.$inferSelect` and `ProjectTable.$inferInsert` respectively.
- Export each Zod schema's inferred type from the same file, using the schema variable's name in PascalCase with the `Schema` suffix. For example, `createProjectSchema` exports `type CreateProjectSchema = z.infer<typeof createProjectSchema>`.
- For every Zod enum, define and export its values as a named `as const` array, export a union type derived with `(typeof values)[number]`, and pass the array to `z.enum()`. Reuse existing arrays when available so schemas and UI options share one source of truth.
- Read actions return the requested data on success, including empty collections, and `null` on validation, request, or response failure. Catch errors and return `null`; keep error response objects in API routes.
- Keep each `useQuery` or `useInfiniteQuery` hook and all of its TanStack Query configuration and logic in the same hook file, with options defined directly inside the hook. This includes query keys, query functions, search normalization, pagination, and enabled conditions. Never separate query options into another file or a `queries/` folder. Shared helpers and resource-specific request functions may be imported when useful.
- After making changes to the codebase, use the `review-change-flows` skill and follow its instructions to give the user a flow-based review guide that groups all changed files and provides a recommended reading order.

## Project conventions

- Use exactly one blank line between imports and main code, between functions, and between unrelated definitions. Keep each Zod schema directly adjacent to its inferred type. Never add multiple blank lines; run formatting on changed authored files.
- Use flex layouts with gap utilities for spacing in authored application UI; never use Tailwind `space-*` utilities.
- Preserve generated shadcn/ui primitives by default. The shared Button ghost variant is an intentional project customization: transparent resting backgrounds and theme-muted hover backgrounds, with important background utilities to preserve this behavior in composed triggers. Preserve this customization when regenerating Button; keep other generated variants unchanged.
- Use `LoadingSwap` for button loading states and `useConfirm` for confirmation dialogs.
- Prefer icon buttons with tooltips over full text buttons whenever they make the design cleaner and simpler, even when space is available. Use full text buttons only when they have ample room and fit the layout without clutter. Give icon buttons accessible labels.
- Present visible metadata with consistent icons and values or separate labels and values, keeping colons for code, keys, values, and tooltips.
- Auto-save all settings after valid edits, preserve pending changes when settings close, and report progress or failures in the fixed settings sidebar indicator; settings never require a Save button.
- Keep user-facing explanations and helper copy to one sentence in 99% of cases, using at most two sentences when essential.
- Keep status and informational content concise. Prefer meaningful icons with tooltips and shorter content when full text adds crowding or visual noise, or when icons make the design cleaner regardless of available space. Preserve useful details in tooltips and accessible labels.
- Use Mobbin for design references anytime you are unsure about a layout or interaction pattern.
- Use shadcn/ui Select for application selection controls, following the installed Base UI composition API. Make authored inputs, Select triggers, and other form fields fill their container width.
- Give every authored state/status an exhaustive formatter returning its label and Lucide icon. Prefer icons with tooltips for compact metadata and actions; use Lucide icons for arrows and separators. Finding dismissal reasons and manual verification notes are optional.
- Use a Lucide dot icon or structured spacing to separate UI metadata; avoid the literal middle-dot character in authored UI text.
- Add shadcn components through the installed CLI using the existing `components.json`. Preserve the owner's theme and follow the primitive customization rule above. Follow the selected Base UI composition API in application callers.
- Generate Better Auth tables with the web package's `auth` command into one schema file. Never manually edit or split that generated schema or duplicate its table mapping in auth configuration. Generated names and formatting are exempt from authored table and function conventions; application tables remain convention-aligned.
- Use `getCurrentUser` from `src/lib/auth/helpers.ts` for server-side user/session reads. Pass request headers in Proxy and API routes; server components use its request-context default. Browser components use Better Auth client hooks, and standalone services validate through the authenticated web API.
- Use the shared toast system in `src/components/ui/toast.tsx` for submission and service feedback; keep field-validation and OTP-code errors inline.
- Use React Hook Form with the Zod resolver for every Next.js application form. Keep validation schemas and their inferred types together; show accessible field errors and use `noValidate` so browser constraint validation does not replace those messages.
- Use Express for custom HTTP services and `ws` for WebSockets. Keep Next.js native API routes. Use `@clack/prompts` for interactive CLI flows and preserve undecorated JSON output.
- Prefer standard package commands for Next.js, Express, and environment loading. Add a custom launcher script only when standard tooling cannot cover a concrete requirement.

- Read environment variables through the typed T3 Env Core exports: `serverEnv` from `@/data/env/server` in server-only code and `clientEnv` from `@/data/env/client` in client code. Add new variables to the corresponding env schema before using them. Keep direct `process.env` reads inside those env modules for their runtime mappings; elsewhere, use them only for a specific technical requirement (such as tooling that cannot load the application env module) and document the reason next to the read. Keep server-only env imports out of client code.
- Prefer type aliases for object shapes, props, and contracts. Use interfaces only when an interface-specific capability, such as declaration merging, is required.
- Always use arrow functions when possible, including for React components and callbacks.
- Always compose dynamic or conditional class names with `cn` from `@/lib/utils`, for example `cn("text-base", selected && "font-semibold", className)`, rather than template literals, string concatenation, or array joins. Static class strings can remain literals. Bypass `cn` only for a specific technical incompatibility, explained in an adjacent comment. Keep complete Tailwind utility names statically discoverable; select whole class strings instead of interpolating fragments such as `bg-${color}`.
- Always format values through named formatter functions; never use object lookup maps for labels, styles, or other presentation formatting. Use an exhaustive `switch` for enum values. A formatter may return an object of related presentation fields, such as `{ label, className, textClassName }`. Keep resource-specific formatters in that feature's `lib/formatters.ts` and call them from components.
- Use `text-base` or larger Tailwind classes for text. Use smaller text only when absolutely necessary to fit the layout. Apply the equivalent minimum size when styling without Tailwind.
- Use semantic colors from the theme in `src/global.css` for all UI colors, including icons and inline styles (for example, `text-foreground`, `text-muted-foreground`, and `bg-primary`). Never use Tailwind palette colors, arbitrary color utilities, or hardcoded color values in application components unless an external requirement makes it unavoidable; document the reason for that exception. Define color values centrally in the theme.
- Name variables holding database query or mutation results after the operation or lookup purpose and the resource: `insertedProject`, `updatedProject`, `deletedProject`, or `existingProject` for an existence lookup. Apply this convention to results from database helper functions too, and use plural resource names for collections, such as `insertedProjects`.
- Always name database tables with PascalCase and end with `Table`, for example `ProjectTable` The file name for this would be `project.ts` (singular version of the table subject) and the name of the table in the database would be `projects` (plural version of the table subject).
- When you use comments in the code, make sure to keep them short and concise. No more than 2 lines per comment because then it just gets hard for me to read them. Do not try to stuff all the content on one line, that is equally as bad. Keep comments to the point and make sure they are easy to read and understand. Also do not stack the commments on top of each other just to add more content. Keep things simple and clear.

## Folder structure

Organize application code under `src/`:

- `app/`: Expo Router screens, routes, and layouts.
- `lib/`: Shared types, constants, helpers, utilities, authentication setup, and other global code.
- `features/`: Resource-specific code, organized by resource, such as `projects/` and `drafts/`. Keep each resource's mutations, actions, fetch functions, and related logic together here.
- `db/`: Database setup, schema, migrations, and other database infrastructure.
- `data/env/`: Type-safe environment variables using T3 Env Core (`@t3-oss/env-core`), with server variables in `server.ts` and client variables in `client.ts`.
- `components/`: Shared components used across the application. Put base UI primitives such as buttons and cards in `components/ui/`; put other generic components, such as a link button, directly in `components/`.
- `hooks/`: Shared hooks used across resources. Keep resource-specific hooks within their corresponding feature.
- `services/`: Third-party integrations, organized by service, such as Trigger.dev, Daytona, or the Vercel AI SDK. For example, the AI integration could live in `services/ai/`.

Keep resource-specific code in its feature folder; use shared folders for code with application-wide responsibilities or reuse across resources.

When creating test files, place feature tests in `src/features/<feature>/tests/` and service tests in `src/services/<service>/tests/` (for example, `src/features/projects/tests/` and `src/services/github/tests/`). Keep tests for shared infrastructure, such as Query Client, in the root `tests/` folder. Use `.test.ts` or `.test.tsx` filenames.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
