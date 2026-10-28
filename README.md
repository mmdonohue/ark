# ARK

> ARK is a memory operating system in which immutable intent is resolved
> through contracts into governed execution, producing durable artifacts,
> provenance, and memory.
<table>
<tr>
<td width="40%" valign="top">
<img src="./media/ark_backpack.png" alt="ARK PACK" width="260">
</td>
<td valign="top">
<p>ARK is a portable, contract-driven memory and execution engine for applications, tools, and autonomous workflows.</p>

<p>Instead of building separate systems for storing information, executing workflows, tracking decisions, and preserving history, ARK composes those capabilities from a small set of reusable primitives.</p>

<p>Applications can integrate ARK through a governed dispatch interface while retaining control over their own architecture.</p>

<p>ARK preserves not only what happened, but what was requested, how it was resolved, and why the result exists.</p>
</td>
</tr>
</table>

> ARK Core
![ARK core components](./docs/core-components-light.svg)

> Architecture Overview
![ARK architecture overview](./docs/ark-overview-light.svg)

The full architecture reference is **[CHARTER.md](./CHARTER.md)**.
Read it before changing runtime primitives. This README is a short
orientation and does not replace it.

## Principles

A handful of constitutional rules shape everything else:

- **Everything is an Artifact.** Durable units of content/state/reference
  are the one substrate — notes, photos, templates, pipelines, even
  Arks themselves.
- **Everything meaningful is governed by Contracts.** Intent resolves
  into execution through declared rules, not ad hoc code paths.
- **There are no privileged execution paths.** The CLI, the HTTP gateway,
  and internal scripts all call the same `dispatch()` — none of them
  reach the database directly.
- **Capabilities are declared before execution, never assumed.** A
  provider being *able* to run is not the same as being *authorized* to.
- **History is durable; authority is not.** What happened is preserved
  even after the permission that allowed it expires.
- **Preserve first, understand second.** Raw preservation never depends
  on an LLM, classifier, or EXIF parse succeeding.
- **Execution must preserve provenance.** Every artifact can answer what
  produced it, from what source, through which contract.
- **Everything composes.** Prefer combining existing primitives
  (Artifact + Contract + Pipeline + Gateway + Resolver + Ledger) over
  inventing a new special-case engine for the next product idea.

See CHARTER.md §1 for the complete list, and §9 for the anti-patterns
these rule out.

## The primitives

| Term | Meaning |
|---|---|
| **Artifact** | Durable unit of content/state/reference |
| **Contract** | Declared rules governing intent, access, execution, or relationship |
| **Packet** | Immutable statement of requested intent |
| **Manifest** | Host configuration — which adapters, services, and providers this vessel has |
| **MemChart** | What a vessel intends to remember |
| **Pipeline** | Ordered, composable declaration of stages, registered as an artifact |
| **Gateway** | A governed boundary through which ARK is reached — HTTP, CLI, USB, peer, etc. |
| **Chain** | Durable record of an ordered execution instance |
| **Ledger** | Proof of authorized execution and resolution |
| **Persona / Role** | What kind of vessel this is / what an actor may do on it (rank-based) |

`dispatch(packet, ctx)` is the single governed entry point underneath all
of them. Every packet runs the same PCER trace before its handler:

```text
trace.open → auth.verify → ledger.open → scope.resolve → payload.project → service.bind
```

Provider resolution, Executor, Promise, and Audience are **proposed, not
built** — see CHARTER.md §4.

## Setup

Requires Node 18.

```bash
npm install
cp .env.example .env
npm test
```

No env vars are needed for the tests or the local CLI — the default
vessel is SQLite. `SUPABASE_URL` / `SUPABASE_KEY` are only read when
something actually talks to the cloud: `ark publish` (`sync.push`),
`cli/ark-dev.js`, and `scripts/`. `OPENROUTER_*` is only needed for
LLM-backed stages (`pipelines/classify`). See `.env.example` for the rest.

## CLI

`cli/ark.js` (`ark` when linked via `npm link`) is a Gateway like any
other: every command builds a packet and calls `dispatch()`.

```bash
ark dispatch <action> [--payload '<json>']   # any ACTION_REGISTRY action
ark ls [artifact_type]                       # artifact.list
ark show <artifact_id>                       # artifact.get
ark arks                                     # graph-level ark containers
ark ledger [--limit n]                       # ledger.list
ark status                                   # vessel / owner / pipelines / media summary

ark rescan [slug]                            # register pipelines/* by content hash
ark pipeline [slug] --path <dir>             # run a pipeline (prompts if omitted)
ark cache <pipeline_slug> <bucket>           # materialize a cache bucket for review
ark publish <pipeline_slug> <bucket> [--dry-run]   # cache bucket → local Ark → Supabase
ark fork <name> <new-name>                   # copy a local instance, version bumped
```

Pipeline flags: `--capture-year`, `--artifact-type`, `--archive-root <dir>`
(enables the archive-copy stage).

### Instances

Each local vessel is a self-contained folder under `arks/<name>/` — its own
`ark.sqlite`, `cache/`, and `ark.yaml` manifest (only the manifest is
tracked). `--ark <name>` selects one (default: `default`, auto-created);
`--db <path>` overrides it outright.

### Identity

With no flags, the CLI auto-provisions a local-only `ark_actor` with role
`owner` — no cloud account needed, capability checks still run.
`--persona <name>` sets the vessel's persona on first run (default `hiker`).
`--user <id> --role <ADMIN|PARTNER|TECH|USER>` uses a Seravanna-linked
identity instead.

## Pipelines

A pipeline is a directory: `pipeline.yaml` + `rules/*.yaml` + optional
`memchart.yaml`. Rules are ordered `when`/`then` lists evaluated by the
one shared `RuleEvaluator`.

| Pipeline | What it does |
|---|---|
| `usb-sd-birds` | Reference media import: discover → fingerprint → preserve → pair → MemChart assess → classify → partition into cache buckets |
| `classify` | Classify one media file's subject via a vision LLM; reusable child pipeline |
| `youtube-scenes` | One artifact per detected video scene, thumbnail per scene (PySceneDetect via `SCENEDETECT_BIN`) |
| `cinema-reel` | Render an Ark's Cinema slideshow to a 1080×1920 MP4 (Chromium + ffmpeg) and attach it as media |

## Embedding

A host app boots ARK by injecting its own clients through the Manifest
(`core/bootstrap.js`), then calls `dispatch()` from its own Gateway:

```js
const { bootstrap, dispatch } = require('ark');
const { supabase } = require('./services/supabase');

await bootstrap({
  db:      { client: supabase },
  storage: { client: supabase, bucket: 'ark-media' },
});

await dispatch({ action: 'artifact.list', payload: { artifact_type: 'note' } }, ctx);
```

## Layout

```text
core/        dispatch, PCER, Packet, Manifest, ChainExecutor, RuleEvaluator, pipeline registry/resolver
actions/     ACTION_REGISTRY handlers, grouped by domain
domain/      Artifact, ArtifactMedia, Ledger, Chain, ArkActor, media helpers
adapters/    db (sqlite/postgres), storage, auth, llm, cache, logger, tracer
pipelines/   pipeline recipes + personas.yaml
memcharts/   standalone MemCharts
arks/        local vessel instances (manifest tracked, data ignored)
cli/         ark CLI, local identity, ark-dev
scripts/     one-off cloud scripts (import-chats, register-pipeline, seed-users, migrate-media)
tests/       node:test unit suite
```

## Origin

Extracted from `seravanna-site/backend/ark/`. Seravanna is one
tenant/vessel of this engine, not the engine itself. `services/supabase.js`
moved with it; some file comments and script usage lines still reference
the old `backend/ark/` paths.
