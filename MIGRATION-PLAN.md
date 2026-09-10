# Desktop release operations

All four apps publish installers to `Sonoran-Software/Sonoran-Desktop-Apps` using
product tags such as `cad-v3.43.31`. Installer versions stay ordinary semver.
The README links to each platform's successfully published version. Initially,
Windows/macOS links and feeds reference the existing public releases; each moves
to the hub when its first bridge build succeeds.

## Promote a release

For CAD, CMS and Radio, run **Promote Staging** from the **staging** branch. Select
**patch** (or a larger bump), and enable Windows, macOS and Linux. Web/iOS/Android
are independent selections. A staging push alone does not publish desktop builds.
Staging Codemagic desktop builds validate artifacts but never update public feeds.

Studio builds all three desktop platforms on a master push, without GitHub Actions
or a new Codemagic API token. A shared source-commit reservation allocates the same
version for every Studio platform above all previously allocated/published versions.
Use `[skip announcement]` in an operational Studio commit to skip its Discord step.

Wait for the selected Codemagic builds to finish before promoting another version.
Do not rebuild changed binaries into an already published version. The publisher
refuses to overwrite a different existing artifact; use a new source/version.

## Publish and bridge sequence

1. Build with `--publish never`, preserving existing Windows and macOS signing.
2. Verify installer hashes against the generated update metadata. Linux additionally
   signs and verifies `SHA256SUMS-linux` and final `latest-linux.yml` with GnuPG.
3. Upload verified assets to a product/version release in the hub. The release is
   public but not marked latest; this uniquely reserves a tag across concurrent
   platforms. Its contents can be incomplete while builds run. Download links and
   update feeds are advanced only when that platform's uploads pass digest checks.
4. Atomically update `catalog.json`, README and the isolated platform manifest in
   `docs/updates/<product>/<platform>/`. GitHub Pages serves `/docs` from master.
   Conflict retries preserve concurrent product/platform changes and reject downgrades.
5. Wait until public Pages serves the exact manifest bytes, then mirror the same
   signed Windows/macOS artifacts and original metadata to the legacy repository.
   Old clients receive the bridge installer, which embeds the new generic feed.
   Studio's legacy release stays a draft until BOTH Windows and macOS are complete.
6. Keep old repositories public and their bridge releases available indefinitely.
   Existing installations switch feeds after installing and restarting the bridge.
   New downloads embed the new feed immediately. No reinstall is normally required.

Each product/platform uses its own generic HTTPS feed, for example
`https://sonoran-software.github.io/Sonoran-Desktop-Apps/updates/cad/windows/`.
Do not use the hub's global `/releases/latest` as an updater destination.
Standard filenames are `latest.yml`, `latest-mac.yml`, and `latest-linux.yml`.
macOS ZIPs and blockmaps remain release assets for automatic updates.

## Credentials and signing

The existing Codemagic `Github` group's `GH_TOKEN` needs Contents write access to
the hub and its legacy repositories. It is never embedded in apps or public files.
Per-app groups `Linux Signing CAD`, `Linux Signing CMS`, `Linux Signing Radio` and
`Linux Signing Studio` contain `LINUX_GPG_PRIVATE_KEY` (secret encrypted signing
subkey), `LINUX_GPG_PASSPHRASE` (secret), and `LINUX_GPG_FINGERPRINT` (public subkey
fingerprint). The primary secret keys and revocation certificates stay offline.

Public keys and customer instructions are in `docs/keys` and `docs/signing.html`.
Renew or rotate the signing subkeys before September 9, 2028 UTC, then update the
product fingerprint in the publisher, Codemagic and public key files together.
GPG signatures support manual download verification; electron-updater does not
currently enforce detached GPG signatures. Windows/macOS retain existing signing
identities and notarization. No paid Linux signing certificate is required.

## Recovery and verification

The canonical publisher is `scripts/desktop-release.cjs`; identical copies are
vendored into each source repo. Run `npm ci && npm test` here after editing it.
Never execute a mutable remote publishing script inside a build.

A failed platform leaves its prior feed and download link available. Incomplete
hub releases are not update feeds. If Pages deployment fails, fix Pages and retry
publication using the SAME archived artifacts, or build a higher version.
Rebuilding/re-signing can change bytes; do not bypass the digest guard.

Legacy publishing is serialized with temporary hub tags named
`desktop-publish-lock-<legacy-repo>`. A normal failure releases the lock. If a build
is forcibly terminated, confirm no publisher for that legacy repo is running,
then delete ONLY its stale lock tag before retrying. Never steal an active lock.

Validate both upgrade hops on real Windows/macOS installations: old feed to bridge,
then bridge to a newer central release. Test fresh Linux AppImages, older-to-newer
Linux updating, GUI and native integrations on supported distributions. CI runtime
checks cannot establish those desktop integration results. Radio's Linux build
currently lacks background keyboard/mouse hotkeys; Studio ER:LC detection remains
Windows/macOS only. Studio's changelog is intentionally unchanged for this work.

## References

- https://www.electron.build/v26/docs/publish/
- https://www.electron.build/v26/docs/features/auto-update/
- https://docs.github.com/en/rest/releases/releases
- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
