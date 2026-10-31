# Windows test installer and updates

This change selectively brings the Windows **local** runtime and packaging
foundation from `feat/windows-client` into main. It does not merge that branch,
change Server migrations/protocols, phone control, voice, or multi-device logic.
Main's existing `/ws/device` and login registration contract are retained.

Included foundation: LOCALAPPDATA paths; authenticated loopback IPC; DPAPI
credentials and current-user ACLs; PowerShell UTF-8 command transport; native
Job Object process-tree cancellation; parent-pipe service lifetime; Squirrel
user-level x64 installer, Windows icon, locked standalone runtime and smoke tests.

`npm run pack:win --workspace=pi-bot-desktop` must run on **native Windows x64**
with MSVC. It builds, runs native regression gates, prepares a locked production
runtime, stages it outside the checkout to detect missing dependencies, then
creates `.w/make/squirrel.windows/x64/Pi-Bot-Windows-x64-Setup.exe`.
The output is an **unsigned test installer**, not a production Authenticode-signed
release. Installation, overlay upgrades, SmartScreen interactions and data
preservation require user acceptance; no agent auto-installs it.

Settings → Client updates defaults to stable; explicitly select test and check.
The Electron main process alone resolves the release/manifest, owns the candidate
and random private download path, bounds size and redirects, verifies SHA256,
and launches an installer with fixed empty argument list after native user
confirmation and activity checks. Renderer never supplies paths or arbitrary
URLs. IPC enforces same trusted main frame as existing bridge operations.
No token is embedded and NAS is not a download intermediary. If Server is
unreachable, local service activity is still authoritative, and a second explicit
confirmation warns that remote state could not be refreshed. Calls/phone control
must be ended by the user; they are not added to main by this change.

The private data directory and DPAPI credentials are outside the application
installation, and Squirrel updates must reuse app identity `PiBot`. Users must
not uninstall the old app first. Shared stable/test identity allows channel
switching only when the target build number is newer, never forced downgrade.

Build identity is injected by `desktop/scripts/build.mjs` from generated root
`client-build.json`; local development fallback is 0.3.0 / buildNumber 0.
See [client-updates.md](client-updates.md) for metadata contract and Android
signing prerequisites. A first manual bootstrap install is necessary for old
clients without this updater.

The renderer bridge now forwards the existing preload `updates` interface.
Previously the missing forwarding caused Settings to hide the whole updater,
even though the packaged main process already implemented it. Manual checks
show checking, latest, available and failure separately. The UI polls byte
progress while downloading and after reopening Settings during an operation;
cancelled installation keeps the verified package available for retry.

Before installer IPC, message text and image drafts are flushed to the existing
Electron profile. A storage failure prevents installation and is shown to the
user. After confirmation and activity checks, the main process persists window
size and flushes profile storage. SHA256 and size are checked again immediately
before the existing installer is launched. An installation receipt records the
old version and target build; reopening Settings compares the running build
with that target. Merely launching the installer never counts as a verified
upgrade. Windows still uses the Squirrel installer with app identity `PiBot`.

For installed-client acceptance, first install a compatible build containing
the updater over the existing installation, then publish a newer build and
matching manifest in the selected channel. In Settings, run check → download
(observe progress) → install → confirm. After the installer restarts the app,
verify the displayed version/build and receipt, account binding, channel,
message drafts and library files. Cancel once and retry; also check that network
and corrupted-package failures leave the old client usable. This requires real
release assets and interactive confirmation; mocked UI tests and package builds
do not establish installed-client upgrade acceptance.
