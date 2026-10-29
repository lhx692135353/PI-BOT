# Client updates (Android / Windows x64 / Linux x64)

Main still runs existing CI and Android artifact builds. `Client test prerelease`
additionally tests all clients, builds installers, then publishes an immutable
GitHub **Pre-release** only after project checks and all platform builds pass.
No NAS/Server deployment is involved. Default client channel is **stable**;
users must explicitly select **test** to receive main builds.

## Identity and channels

One workflow owns the test sequence: `buildNumber = 1000 + github.run_number`,
version `0.3.<buildNumber>`, tag `client-test-<buildNumber>`, commit is full SHA.
Reruns keep identity and never overwrite published assets. Build number is bounded
to 65535 (Windows numeric version component); plan a version scheme migration
before reaching that bound, do not reset it or rename this workflow's sequence.
Android `versionCode` equals the build number. Local development defaults to 3,
which is higher than the previous versionCode 2 but is not a published identity.

Clients enumerate releases (up to 500; if the bound is reached, report an explicit
manual-check error rather than silently claiming no update), ignore drafts, and match explicit
prerelease + `client-test-*` for test, non-prerelease + `client-stable-*` for
stable. They compare numeric build numbers, not commit hashes. Stable publication
is manual/not implemented by this main workflow; its metadata must follow the
same contract, have `channel: stable`, and use a higher global build number.
Stable and test builds share app identity and data: switching channels never
forces downgrade. No available newer version is not a network error.

`update-manifest.json` schemaVersion 1 carries channel, buildNumber, version,
commit, minimumServerVersion (null = no additional requirement), and platforms
`android` / `windows-x64` / `linux-x64`, each with file, sha256, size. Metadata and files come
only from the configured public repository release. No GitHub token is embedded.
SHA256 authenticates package bytes against the HTTPS release metadata, not an
independent signing authority. Protect repository write permissions.

## Upstream CI and signing integration

The update source is `lhx692135353/PI-BOT`, not the contributor fork. Existing
upstream Android and desktop workflows remain intact. PRs only test/build; they
do not publish and do not need signing secrets. Release publishing uses the
built-in `GITHUB_TOKEN` with job-scoped `contents: write`, not a personal token.

At integration time, upstream's Android workflow builds `assembleDebug` on a
fresh hosted runner and does not restore a fixed keystore. Reusing that workflow
alone therefore does not guarantee the same signing certificate across builds.
The optional configuration below is one implementation of persistent signing,
not an intrinsic requirement for online updates or for opening/merging this PR.
If maintainers already have another protected signing mechanism, adapt the signed
APK step to reuse it and retain the certificate verification. Do not generate a
replacement key or publish a random debug-signed package as a compatible update.
Without persistent signing, validation still runs, but the main publishing job
is deliberately blocked; maintainer signing setup/reuse is needed before an
actual Android update release. No secrets need to be supplied to a fork PR.

## Fixed Android signing — current publishing implementation

**Do not generate a new key. Do not upload a debug keystore from a different
machine and assume compatibility.** Use the existing keystore that signed the
user's installed compatible APK, with a secure offline backup.

A repository administrator must configure these Actions Secrets through GitHub's
secure UI (Settings → Secrets and variables → Actions), not chat:

- `ANDROID_TEST_KEYSTORE_BASE64`: base64 of the existing compatible keystore
- `ANDROID_TEST_STORE_PASSWORD`
- `ANDROID_TEST_KEY_ALIAS`
- `ANDROID_TEST_KEY_PASSWORD`

Configure repository Actions variable `ANDROID_TEST_CERT_SHA256` with the
64-hex SHA256 certificate fingerprint of the known-compatible APK, with no
colons. This is a public certificate digest, not a private key. Verify using
`apksigner verify --print-certs <known-compatible.apk>` on the owner's machine.

The workflow materializes the key only under runner.temp, cleans it on exit,
never uploads it, verifies resulting APK certificate against the pinned digest,
and refuses publishing when any signing input is absent. Regular debug tests
still run without secrets. Successful publication does **not** prove real-device
cover installation: that requires user-confirmed installation, never uninstall.
The client independently checks APK package ID, versionCode, SHA256 and current
installed signer before offering installation. Signing rotation is not supported.

## Upgrade interaction and boundaries

Settings → Client updates → choose channel → check → explicitly download →
verify → explicitly install. Android invokes the platform package installer,
requests unknown-source permission only on explicit installation, and rechecks
file integrity and Bot activity (refreshing when Server is reachable) before install.
When Server is offline, cached activity can be incomplete: the dialog explicitly
requires the user to confirm that all activities have ended. If tasks are running,
installation is deferred; users must also end calls/phone control first. No
silent installation, background forced restart, uninstall or data migration.
Windows installer is currently unsigned, and must be confirmed by the user.
Existing installations without the updater need one manual bootstrap install.
Network/rate-limit/download/hash/signature failure must leave the old app usable.

## Verification

- `node --test scripts/client-update/update.test.mjs`
- Android: `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`
- Windows: `npm run pack:win --workspace=pi-bot-desktop` on native Windows x64
- Main workflow gates publication on reusable full CI and all platform builds.
- Final acceptance: a real release with all packages/manifest; stable sees no
  test prompt; test sees newer numeric build; corrupt file rejected; update
  overlay preserves settings; activity defers install; network failure preserves
  old app. These are acceptance steps, not claims of completed device tests.

## Linux x64 tar.gz online updates

The existing official `pi-bot-desktop-linux-x64.tar.gz` format is supported;
this is NOT just a browser/download-page link. Settings uses the same stable/test
selection, build-number comparison, trusted GitHub HTTPS hosts, size and SHA256
verification. The manifest requires the Linux **desktop** archive, not the
service-only tarball. CI builds and uploads that archive and main attaches it to
the same complete immutable Pre-release.

After explicit install confirmation and activity checks, the main process
revalidates the archive, requires `python3`, checks current-user ownership and
write permission on the install directory and its parent, and unpacks into a
private sibling directory on the same filesystem. Extraction validates paths,
size/count limits and safe relative links; absolute/traversal paths, device
nodes, hardlinks, link ancestors and privileged modes are rejected. The staged
bundle must contain the desktop executable, app.asar, bundled Node and the
`.pi-bot-linux-tar` marker. The trusted helper uses bundled Node, waits for the
client to exit, renames the old directory to a timestamped sibling backup, moves
the new directory into the same path and restarts it. No shell interpolation,
sudo/pkexec, background forced install, removal of the backup or user-data
migration is performed. The normal quit path stops the client's owned service;
independently managed services must be stopped manually before upgrading.

Download/staging failures leave the current application untouched. Rename or
executable-launch failure after exit restores and restarts the old directory
where possible; error detail stays in the sibling `.pi-bot-update-*/update-error.txt`.
Old directories are retained as `<install>.backup-<timestamp>` for manual recovery.
This is NOT transactional against power loss between renames, nor an automatic
rollback for a newly launched app that later crashes. Keep the backup and user
data until the new app has been checked. The extra archive/extraction/backup
requires free disk space; disk failures are reported, not silently ignored.

User settings and the library remain outside the installation directory.
Updating is refused when configured data/library paths are inside that directory.
Do not relocate existing user data into the app bundle. No application or service
was installed/replaced on the user's actual machine during development/testing;
helper tests use only disposable fixture directories and fake launchers.

Only Linux x86_64 official writable **desktop tar.gz** installs with the marker
support in-place updates. Older bundles without this updater/marker need one
manual bootstrap; developer runs, AppImage, deb/rpm, package-manager installs,
read-only/root-owned installs, service-only bundles and other architectures do
not support this replacement path. The Linux update section reports a specific
error/instructions for unsupported installation layouts; it never treats opening
a web page as a completed installation. Python is checked at staging and is not
automatically installed. A real desktop-to-desktop upgrade still needs separate
user-authorized acceptance testing after release; CI does not prove that step.
