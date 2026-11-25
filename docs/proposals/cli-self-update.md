# Governed self-update for portable ARK

**Status (2026-11-24):** read-only part built; installing and rollback planned. This is the one spec for ARK self-update. Sections say **Built** or **Planned**.

## Goal

Someone handed ARK on a USB drive can check for, install and roll back verified ARK releases, meaning the runtime code and its bundled npm packages. The operating system and Node are the host's and out of scope. Owner data (vessels: SQLite databases, caches, manifests, MemChart, secrets, configuration) is never replaced, and is never migrated without a separate, explicit decision.

## Commands

```sh
ark version                              # Built
ark update --check [--source <url|dir>]  # Built — read-only
ark update                               # Planned — says "not in this version yet" (exit 2)
ark update --rollback                    # Planned — same
```

## Decisions

- **Separate from `ark.update`.** `ark.update` changes an Ark artifact. The runtime has its own `runtime.*` domain: `runtime.version` and `runtime.check` are built; `runtime.stage`, `runtime.activate` and `runtime.rollback` are planned. They use their own owner-only capabilities (`runtime.read` is built), go through `dispatch()`, and are ledgered. There is no second execution path.
- **First install type: a portable folder,** with no symlinks (exFAT):
  ```
  <usb>/runtime/<version>/   code + node_modules + install.json
  <usb>/runtime/current.json pointer to the active version, swapped atomically
  <usb>/vessels/<name>/      owner data, beside the runtime, never inside it
  <usb>/ark, ark.cmd         launcher that reads current.json
  ```
  Developer checkouts update with git. `ark update --check` tells them so.
- **Release source:** a URL or a local/USB folder serving `release.json` plus `release.json.sig`. Local-first; GitHub Releases can be one such URL.
- **Trust root:** Ed25519. The release owner holds the private key, made by `scripts/release-sign.js keygen`, which refuses to write inside the repo. Runtimes ship only public keys, in `trust/release-keys.json`. Node's built-in crypto; no new dependency.
- **Bundles are per platform** (`<os>-<arch>`), because `better-sqlite3` is native. Each carries its own `node_modules`.

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
  - runs `npm ci --omit=dev` for this platform and writes `install.json` (portable, `data_root: ../../vessels`)
  - writes `ark-<v>-<os>-<arch>.tar.gz` and its sha256 and size into `release.json`, merged per version so other platforms can be added; a different channel or notes for the same version is refused
  - signs it when given a key
  - `--trust` sets the keys the bundle will trust for its own updates
- **`scripts/make-usb.js --bundle <tgz> --to <dir> [--trust]`** lays out a fresh portable install: `runtime/<v>/`, `runtime/current.json`, an empty `vessels/`, and the `ark` / `ark.cmd` launchers that read `current.json`.
  - **Verifies a sibling release:** if `release.json` and its signature sit next to the bundle, it checks the signature, file name, size and sha256, and refuses on any mismatch. Otherwise it warns that the bundle is unverified.
  - **Never leaves a partial install:** it checks `install.json` before moving anything into place.
  - **Refuses** a folder that already holds an install.
- **Verified:** a real darwin-arm64 bundle is 26 MB (92 MB unpacked) and runs standalone from a USB-style folder.

## Planned

### Owner key

- The release owner runs `scripts/release-sign.js keygen`. Its public entry goes into `trust/release-keys.json` (a code change), and the first signed release is built with that key.

### PR 3 — staging

- **Verification before anything is unpacked:** the bundle's sha256 and size, both from the signed manifest. A checksum from the same unsigned source is not proof.
- **Staging location:** `runtime/<version>.staging/`, outside the active version.
- **Fail closed, leaving the active runtime untouched:**
  - not enough disk space, measured before download
  - read-only media
  - permission denied
  - an interrupted download, which resumes or starts again and is never half-trusted
- **Confirmation:** asked for when interactive. Without a terminal, `--yes` is required. Nothing installs without the owner's authorization, and there is no automatic update.

### PR 4 — activation and rollback

- **Activation:**
  - an atomic swap of `current.json` (write a temporary file, then rename)
  - a health check against the new version: boot plus `runtime.version` on an in-memory vessel
  - on failure, an automatic switch back to the previous version
- **Rollback** returns `current.json` to the last known-good version.
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
- [ ] Bundle hash or size mismatch rejected before unpacking.
- [ ] Not enough disk, read-only media, permission denied, interrupted download.
- [ ] Interrupted staging and activation leave the current runtime usable.
- [ ] Failed health check rolls back; manual rollback works; rollback across a data-format change is refused.
- [ ] Owner data checksums unchanged across update and rollback.
- [ ] USB-like smoke test: update one version, then roll back.
- [ ] No bypass of `dispatch()`, capabilities or the ledger (all runtime actions governed).
