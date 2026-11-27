# Governed self-update for portable ARK

**Status (2026-11-26):** checking and installing built; rollback and the data-format guard planned. This is the one spec for ARK self-update. Sections say **Built** or **Planned**.

## Goal

Someone handed ARK on a USB drive can check for, install and roll back verified ARK releases, meaning the runtime code, its bundled npm packages, and the Node it runs on. The operating system is the host's and out of scope; the host needs no Node of its own. Owner data (vessels: SQLite databases, caches, manifests, MemChart, secrets, configuration) is never replaced, and is never migrated without a separate, explicit decision.

## Commands

```sh
ark version                              # Built
ark update --check [--source <url|dir>]  # Built — read-only
ark update [--source] [--yes]            # Built — portable installs; asks first
ark update --rollback                    # Planned — says "not in this version yet" (exit 2)
```

## Decisions

- **Separate from `ark.update`.** `ark.update` changes an Ark artifact. The runtime has its own `runtime.*` domain: `runtime.version` and `runtime.check` are built; `runtime.stage`, `runtime.activate` and `runtime.rollback` are planned. They use their own owner-only capabilities (`runtime.read` is built), go through `dispatch()`, and are ledgered. There is no second execution path.
- **First install type: a portable folder,** packed, with no symlinks (FAT32/exFAT):
  ```
  <usb>/packages/<bundle>     one signed package per version (+ its release.json/.sig)
  <usb>/runtime/current.json  { version, package, sha256, previous }, swapped atomically
  <usb>/vessels/<name>/       owner data, always on the drive
  <usb>/ark, ark.cmd          launchers; Start ARK.command / .cmd to double-click
  <usb>/ark.json              { unpack: auto | host | stick }
  ```
  A version stays one file on the drive: a cheap FAT32 stick writes about 2 small files a second, so unpacking ~3,600 files onto it takes ~40 minutes. The launcher unpacks a version the first time it runs, after checking the package's sha256 against `current.json`: on this computer (`~/.ark/runtime/<version>-<sha>`) when it can write there, else onto the drive (`runtime/<version>/`), once. It unpacks into a `.partial` folder and uses only a `.complete` one. `ark cleanup-host` removes this computer's copies. An update writes one file to the drive.
  Developer checkouts update with git. `ark update --check` tells them so.
- **Release source:** a URL or a local/USB folder serving `release.json` plus `release.json.sig`. Local-first; GitHub Releases can be one such URL.
- **Trust root:** Ed25519. The release owner holds the private key, made by `scripts/release-sign.js keygen`, which refuses to write inside the repo. Runtimes ship only public keys, in `trust/release-keys.json`. Node's built-in crypto; no new dependency.
- **Bundles are per platform** (`<os>-<arch>`), because `better-sqlite3` is native. Each carries its own `node_modules` **and its own Node**. Native modules only load on the Node ABI they were built for, so a bundle that relied on the host's Node would crash on any other major version (a Node 18 build failed on Node 25).
- **Node 24 LTS** (end of life 2028-04-30), pinned to an exact release with per-platform sha256 in `trust/node.json`. Node 18 reached end of life in 2025. Moving to another major (26 is the newest LTS) is a reviewed change to that file.

## Built

**Vessels outside the runtime (#32).** `utils/arkHome.js` resolves the data root in this order:
1. `ARK_HOME` → `<ARK_HOME>/vessels`
2. `install.json` `data_root`, relative to the runtime. Refused if it points inside the runtime.
3. a checkout's `<runtime>/arks`, unchanged

`installMode()` returns portable, checkout or unknown.

**Version and check (#33/#35).**
- `ark version` prints version, build, channel, install type, runtime and vessel directories, platform, Node, and update source.
- `ark update --check` reads the signed manifest and verifies it before using any of it. Every outcome is a status, never a throw:
  - `no_source`
  - `no_trusted_keys`
  - `unreachable` (offline, missing media, missing signature)
  - `unverified`
  - `invalid_manifest` (including bundle names that try to escape the folder)
  - `other_channel`
  - `up_to_date` (never a downgrade)
  - `unsupported_platform`
  - `incompatible_node`
  - `available`
- Nothing but the manifest is fetched, and nothing is run.

**Reading writes nothing.** On a fresh install, `version` and `--check` create no vessel: they run the same `dispatch()` against an in-memory vessel. With an existing vessel, the call is recorded in its ledger.

Manifest:
```json
{ "name": "ark", "version": "0.2.0", "channel": "stable", "released_at": "…",
  "min_node": "18.0.0", "notes": "…",
  "platforms": { "darwin-arm64": { "file": "ark-0.2.0-darwin-arm64.tar.gz", "sha256": "…", "size": 123 } } }
```
Signature: `{ "key_id": "…", "signature": "<base64 Ed25519 over release.json's exact bytes>" }`.

**Release bundles and a USB layout (PR 2).**
- **`scripts/release-build.js --out <dir> [--version] [--channel] [--notes] [--source-url] [--trust] [--key --key-id] [--skip-deps] [--repo] [--allow-dirty]`:**
  - builds from the **committed tree** (`git archive HEAD`), so a bundle is exactly the commit `install.json` names
  - refuses a dirty tree; `--allow-dirty` still builds `HEAD` and warns
  - never ships `arks/`, `.env`, `node_modules` or anything untracked
  - downloads the pinned Node for this platform and verifies it against `trust/node.json` (cached; `--skip-node` for tests). It ships only `node/bin/node` and its LICENSE.
  - runs `npm ci --omit=dev` with **that Node's own npm**, so native modules match the ABI that ships, then smoke-tests them with it (an in-memory SQLite database, and loading `sharp`). It fails if they don't load.
  - writes `install.json` (portable, `node`, `data_root: ../../vessels`) and records `node` and `node_abi` per platform in `release.json`. A bundle with its own Node ignores the host's Node; `min_node` applies only to one without.
  - writes `ark-<v>-<os>-<arch>.tar.gz` and its sha256 and size into `release.json`, merged per version so other platforms can be added; a different channel or notes for the same version is refused
  - signs it when given a key
  - `--trust` sets the keys the bundle will trust for its own updates
- **`scripts/make-usb.js --bundle <tgz> --to <dir> [--trust] [--upgrade] [--unpack auto|host|stick]`** lays out a packed portable install (above). The package is copied and its copy re-hashed before `current.json` names it.
  - **`--upgrade`** adds a version to an existing install, including the earlier unpacked 0.1.0 layout. It records the previous version for rollback, keeps the owner's `ark.json`, and never touches `vessels/`. This is the one-time manual step for a drive whose ARK predates `ark update`.
  - **Verifies a sibling release:** if `release.json` and its signature sit next to the bundle, it checks the signature, file name, size and sha256, and refuses on any mismatch. Otherwise it warns that the bundle is unverified.
  - **Never leaves a partial install:** it checks `install.json` before moving anything into place.
  - **Refuses** a folder that already holds an install.
- **The launchers** (`ark`, `ark.cmd`) run the active version's bundled Node, falling back to the host's only for a bundle built without one. Neither needs Node just to read `current.json`.
- **Verified:** a real darwin-arm64 bundle with Node 24.22.3 is 72 MB. It runs from a USB-style folder with no Node on `PATH`. Building on macOS needs Xcode's command-line tools, because `better-sqlite3` 11 compiles from source for Node 24.

**Owner key (#43).** The release owner's key is `matt-2026`, made by `scripts/release-sign.js keygen`. Its public entry is in `trust/release-keys.json`; 0.1.0 and later are signed with it.

## Built — installing (`runtime.install`)

`ark update` runs `runtime.check`, prints it, asks (or takes `--yes`; without a terminal `--yes` is required, refused before anything is read), then dispatches `runtime.install`. It's owner-only (`runtime.write`, rank 100), takes no source in its payload (the same rule as `runtime.check`), and is ledgered when a vessel exists. Packed portable installs only: a checkout or embedded copy refuses (`NOT_PORTABLE`); Windows isn't supported yet.

- **Verified as it copies:** the bundle streams into `packages/<file>.part`, checked against the signed manifest's size and sha256. It's always started afresh, renamed only once it matches and after an fsync. A tampered, truncated or interrupted copy is deleted, and nothing changes. The verified `release.json` and signature are kept beside the package.
- **Fail closed, before copying:** a read-only drive or denied permission (`NOT_WRITABLE`); not enough space, meaning the bundle plus 16 MB (`NO_SPACE`); another update running on the install (`runtime/update.lock`); a runtime that's older than what `current.json` already names (`STALE_RUNTIME`).
- **No replay:** `runtime/seen.json` holds the highest version this install has activated. A signed manifest older than that reports `replayed`. A manifest past its `expires_at` reports `expired`. Neither installs.
- **Activation:** an atomic swap of `current.json`, recording `previous`. Then a health check: `ark version` through the install's own launcher, exactly as the next start runs it, so it unpacks the new version first. If that fails, `current.json` is restored byte for byte and the status is `rolled_back`. `seen.json` advances only on success.
- The running process stays on the old version: restart ARK to use the new one.
- **Known gap:** a crash between the swap and the end of the health check leaves `current.json` on the new, verified but unchecked version. `ark update --rollback` (next) is the way back.

## Planned

### Rollback and the data-format guard

- **Rollback** returns `current.json` to `previous`, only ever to a version already on the drive, never one fetched from the network.
- **Data-format guard:** each vessel records a data-format version.
  - A runtime refuses to open a vessel newer than it understands.
  - Rollback refuses if the target version can't read the current data.
  - Additive changes (new columns, which older code ignores) don't bump the version.
  - A real migration does, and needs its own reviewed plan and a backup first.
- **Smoke test:** a disposable, USB-like folder that updates one version and rolls back, with checksums showing vessels, MemChart and Manifest unchanged.

### Later

- Other install types (npm, containers) through narrow adapters, only once there's evidence they're needed. Documentation states unsupported types plainly.

## Acceptance

- [x] Argument parsing and output for all four commands; unbuilt ones say so (exit 2).
- [x] `--check`: offline, no source, no keys, unsupported platform, wrong Node, no update, downgrade.
- [x] Modified or unsigned manifest, untrusted key, non-Ed25519 key: rejected before use.
- [x] `version` and `--check` write nothing on a fresh install; with a vessel, the call is ledgered.
- [x] Bundle hash or size mismatch rejected before unpacking.
- [x] A correctly signed but older (or expired) release is refused: no replay downgrade.
- [x] A bad `install.json` `data_root` fails vessel commands with a clear message, and `ark version` still runs.
- [x] Not enough disk (unit), read-only media, permission denied, interrupted download.
- [ ] Interrupted staging and activation leave the current runtime usable. (Staging: yes. Activation: the gap above.)
- [ ] Failed health check rolls back (done); manual rollback works; rollback across a data-format change is refused.
- [ ] Owner data checksums unchanged across update and rollback.
- [ ] USB-like smoke test: update one version, then roll back.
- [ ] No bypass of `dispatch()`, capabilities or the ledger (all runtime actions governed).
