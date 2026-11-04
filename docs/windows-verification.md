# Windows package and hardware verification

**Status:** source review only. No Windows device or VM was used for this packet; macOS results do not close Windows acceptance. Record every actual laptop run in `docs/release-verification.md`, with its Windows build, package hash, test profile, commands, result, and evidence path.

## Source-review baseline

The current desktop uses Electron Forge with a Windows Squirrel maker, a separate academic-service process, an authenticated local transport, a dedicated browser workspace, native SQLite, PDF.js, and packaged Stagehand extension resources. Relevant source includes `apps/desktop/forge.config.mts`, `apps/desktop/src/services/academic/{transport,runtime,client}.ts`, `apps/desktop/src/lib/application-paths.ts`, `apps/desktop/src/db/index.ts`, and `apps/desktop/stagehand-assets.mts`. This is a source map, not proof that the Windows artifact includes or correctly executes those components.

## Required Windows laptop checklist

Run from a disposable checkout/package build and test-owned Windows account/profile. Do not install over or point the harness at a user's working ScholarOS installation, browser profile, database, or credentials.

### Build, install, update, and removal

- [ ] Build the Windows target using the installed Forge version and record the exact command, Node/pnpm/Electron/Forge versions, exit code, output path, and SHA-256 of the package.
- [ ] Confirm the expected Squirrel installer, app identity, icon, Start Menu/Desktop shortcut behavior, upgrade code, uninstall entry, and AppUserModelID/ToastActivatorCLSID where required by the selected notification route.
- [ ] Install, launch, close, update, roll back if supported, and uninstall using only a test-owned profile. Verify the installer never overwrites or cleans another app/profile's userData.
- [ ] Verify native-module ABI after packaging using the actual Electron process; start the academic service and create/migrate/read a test database. Do not infer Windows native compatibility from macOS.
- [ ] Test signed/package integrity according to the intended distribution channel. Record missing certificate/action by name only; never put secret values or private keys in logs.

### Paths, local service, and browser workspace

- [ ] Exercise all file/resource paths with Windows separators, spaces, non-ASCII names, long-but-supported paths, profile relocation, and unavailable folders. Confirm `path.join`/`path.resolve` are used and no renderer-supplied arbitrary path reaches the service.
- [ ] Inspect the actual endpoint and process launch: the named-pipe form must be valid for Windows (`\\\\.\\pipe\\...`), unique to the test-owned service, authenticated with a random main/service credential, and closed when the owner exits. The renderer must never receive that credential.
- [ ] Verify inherited Windows ACLs protect the endpoint/token/profile directory from other OS users; POSIX `mode: 0o600` alone is not Windows ACL evidence. Test cross-user access is denied, while the owning desktop client can reconnect after a service restart.
- [ ] Confirm start, duplicate-instance guard, cancellation, graceful Quit, crash/restart, app update, and stale-pipe cleanup do not kill or attach to an unrelated process or erase user data.
- [ ] Launch only the packaged, dedicated browser workspace. Verify browser executable discovery, browser assets/extension/archive, separate profile, protected CDP endpoint, sign-in/MFA continuation by the user, and no copied personal cookies or profile paths.
- [ ] Verify PDF.js module/worker, Stagehand extension directory and archive, activity SDK/worklet resources, migrations, and native SQLite binary are present at runtime-relative paths in the actual installer and installed app.

### Audio, notifications, and user interaction

- [ ] Verify a real Windows microphone device can be explicitly selected/authorized, captured as bounded PCM through the packaged AudioWorklet, stopped/cancelled promptly, and converted into an editable draft. No automatic Send, output speech, or raw-audio file is permitted.
- [ ] Test missing/denied/revoked microphone, device unplug, app background/close, and relay failure without losing typed text or retaining audio buffers.
- [ ] Verify Notifications are off by default; the explicit user enable action, supported OS permission path, quiet hours, focus suppression, dedupe, and safe internal click route work on the installed package.
- [ ] Verify Start Menu/taskbar AppUserModelID and toast activation with both enabled and denied notification states. Test account switch, sign-out, target removal, and stale notification click cannot reveal or route another account's academic context.
- [ ] Confirm keyboard navigation, accessible field errors, scaling/zoom, window resizing, non-ASCII text input, clipboard restrictions, and screen-reader labels on the installed app.

## Evidence record

| Check                                    | Source review                                                                  | Actual Windows result | Evidence / blocker                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------- |
| Windows build and installer              | Forge/Squirrel configuration inspected                                         | **Not run**           | Requires actual Windows package build and test installation.                             |
| Named pipe, ACLs, and restart            | Shared transport/runtime source inspected                                      | **Not run**           | Requires Windows cross-user ACL and process-lifecycle tests.                             |
| Browser/PDF/Stagehand/runtime assets     | Packaging paths reviewed                                                       | **Not run**           | Requires installed Windows artifact inspection and launch.                               |
| Shortcuts, AppUserModelID, notifications | Requirements recorded; source behavior must be checked against current package | **Not run**           | Requires installed app and Windows notification center.                                  |
| Microphone and AudioWorklet              | Contract and source path identified                                            | **Not run**           | Requires actual device and user-granted OS permission; workers do not grant permissions. |

**Release gate:** a Windows release is blocked until the actual Windows rows pass or a concrete environment limitation is recorded with an owner and remediation. A macOS build, source inspection, or mocked Windows path is not a Windows result.
