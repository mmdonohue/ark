'use strict';

// Seed content for artifact_type: 'skill' — durable, hard-won technical
// knowledge, distinct from artifact_type: 'session_log' (chronological
// narrative) and from whatever Professor's future ark-learning-path
// content will be (curated/pedagogical — the opposite direction: authored
// to teach, not earned through doing). Adapted from
// .claude/diary/relationship.md's "Architectural Gotchas" section — that
// prose was already written and verified; this just re-shapes it into
// independently discoverable, taggable artifacts instead of one flat file
// section.
//
// confidence/source_type follow the trust-hierarchy pattern from Google's
// Context Engineering (Sessions & Memory) writeup: a skill backed by an
// actual fix + a regression test is high-confidence and proven; a plain
// naming/convention fact is real but a different kind of certainty.

const SKILLS = [
  {
    slug: 'payload-project-merge-not-replace',
    title: 'payload.project must merge onto ep.payload, not replace it',
    summary: 'PCER\'s generic merge response type does Object.assign(ep, {payload: result}) — a full replacement, not a merge into the existing payload.',
    body: `TraceActions.projectPayload used to return only the fields declared in a resolved template's contract.fields — but PCER.js's generic 'merge' response handling (_applyMerge, 'assign' strategy) does Object.assign(ep, { payload: shaped }), which fully REPLACES ep.payload with whatever the stage returns, not a key-by-key merge into it.

Result: any templated ark.create/ark.update silently discarded every payload field the resolved template's contract.fields didn't happen to declare — summary, is_arc, metadata, visibility all vanished. This affected Journal and Journal Core from the start (both declare only { title, body }), not just a newly-added template. Root cause: contract.fields describes the shape of ENTRIES captured within an ark of that type (used by JournalCapture, the Packet Builder dev tool) — it was never meant to gate ark.create/ark.update's own payload, but the same resolved contract gets attached to both because template_id appears in both.

Fix: projectPayload now returns { payload: { ...ep.payload, ...projected } } instead of { payload: projected } — validated/defaulted declared fields still apply, everything else survives. Every real handler downstream (ArkActions.*, ArtifactActions.*) already applies its own explicit allowlist, so the old stripping was never a security boundary, just silent data loss.`,
    tags: ['pcer', 'templates', 'data-loss', 'dispatch'],
    applies_to: ['backend/ark/actions/TraceActions.js', 'backend/ark/core/PCER.js'],
    confidence: 'high',
    source_type: 'tested_fix',
  },
  {
    slug: 'default-capabilities-per-domain',
    title: 'Registering an action is not enough — _defaultCapabilities must be updated too',
    summary: 'ACTION_REGISTRY and TraceActions._defaultCapabilities(domain, verb, rank) are two separate switches; forgetting the second one 403s everyone, including ADMIN.',
    body: `dispatch.js's ACTION_REGISTRY maps an action name to a capability string + handler, but that capability string doesn't grant itself — TraceActions._defaultCapabilities(domain, verb, rank) is a SEPARATE switch statement that decides which capability names an authenticated actor actually holds for a given domain.verb pair.

Forgot this once when adding catalog.list_categories/catalog.publish_items: both actions were fully registered in ACTION_REGISTRY, syntax-checked, and looked complete — but nobody actually held the catalog.read/catalog.write capabilities yet, so every call 403'd, including from ADMIN. Caught via a live dispatch test, not by reading the code (the registration alone looks correct).

Any new action domain needs an entry added to _defaultCapabilities alongside its ACTION_REGISTRY registration — these are two things to update, not one.`,
    tags: ['capabilities', 'dispatch', 'authorization'],
    applies_to: ['backend/ark/core/dispatch.js', 'backend/ark/actions/TraceActions.js'],
    confidence: 'high',
    source_type: 'tested_fix',
  },
  {
    slug: 'cover-image-logic-must-agree',
    title: 'Multiple read paths computing the same derived value must share one implementation',
    summary: 'ark.list, ark.get, and ark.graph each independently computed an Ark\'s cover image — they disagreed once until consolidated into one shared helper.',
    body: `Three different read actions each needed to answer "what's this Ark's cover image" — own media wins if present, else the first member (in visual order) with a displayable image. Each one had its own inline copy of that logic. ark.get's copy only checked the Ark's own media, missing the member-derived fallback ark.list had — caught by a live dispatch test comparing the two responses for the same Ark before/after setting and removing a test splash photo, not by code review.

Consolidated into domain/mediaDisplay.js (pickDisplayableImage/imageSrcFor), used by all three call sites now. General pattern: once the same derived-value logic exists in 3 places, that's the signal to extract a shared helper (2 places was tolerated once for a similar image-selection rule before this).`,
    tags: ['media', 'consistency', 'cover-image'],
    applies_to: ['backend/ark/actions/ArkActions.js', 'backend/ark/domain/mediaDisplay.js'],
    confidence: 'high',
    source_type: 'tested_fix',
  },
  {
    slug: 'npm-test-path-after-restructure',
    title: 'A restructure can silently break the test runner if nobody runs it',
    summary: 'package.json\'s test script pointed at the pre-restructure tests/unit.test.js after everything moved under backend/ark/ — nobody had run npm test since.',
    body: `When backend/ was restructured into the self-contained backend/ark/ package, the actual test file moved to ark/tests/unit.test.js, but package.json's "test" script still pointed at the old tests/unit.test.js path. npm test had been failing outright (file not found) since the restructure, and nobody noticed because nobody ran it in between.

Lesson isn't really about this one path — it's that a structural reorganization needs an explicit "does the test runner still work" check as part of the change, not an assumption that it does. Fixed the path, ran it, found a second real bug in the same pass (see the skill about undeclared payload keys) because the suite's own test for that behavior encoded the bug as expected.`,
    tags: ['testing', 'restructure', 'process'],
    applies_to: ['backend/package.json'],
    confidence: 'high',
    source_type: 'tested_fix',
  },
  {
    slug: 'bodyparser-default-limit-too-small',
    title: 'Express body-parser defaults to 100kb — well under any real image upload',
    summary: 'bodyParser.json() with no limit set silently rejects any request body over 100kb, and the failure mode looks like a frozen UI, not a clear error.',
    body: `backend/index.js had bodyParser.json() with no limit option — Express's default is 100kb, far under any real inline image (ArtifactActions.js's own MAX_BLOB_BYTES cap assumed much more headroom than that existed at the HTTP layer). A request rejected at this layer comes back as an HTML/plain-text error page, not JSON.

Compounding bug: frontend/utils/action.ts's executeAction called res.json() unconditionally on every response. A non-JSON error response threw an uncaught SyntaxError deep in whatever button triggered it — which looked exactly like a frozen or badly-cached UI, not an obvious upload-size error, and was reported as "the UI seems to have a bad cache" before the real cause was found.

Fixed both: raised the body-parser limit (currently 20mb, headroom above MAX_BLOB_BYTES's 10mb after base64 inflation + JSON envelope), and made executeAction catch a non-JSON response and normalize it into the same {ok:false, error} shape every caller already handles, so this class of failure can't look like a stuck UI again regardless of what triggers it next.`,
    tags: ['http', 'uploads', 'error-handling'],
    applies_to: ['backend/index.js', 'frontend/utils/action.ts'],
    confidence: 'high',
    source_type: 'tested_fix',
  },
  {
    slug: 'jsonb-columns-need-shallow-merge',
    title: 'metadata/context are JSONB columns written as a raw overwrite, not merged',
    summary: 'Packet.save() writes dirty fields as a plain column value (no jsonb_set/||) — setting one key in metadata or context silently wipes every other key already stored there unless the caller merges first.',
    body: `Both metadata and context are JSONB columns. Packet.save() persists dirty-tracked fields via a plain SQL UPDATE ... SET column = $1 — there's no jsonb_set or || merge operator involved, so passing { metadata: { subtitle: 'x' } } to ark.update replaces the ENTIRE metadata column with just { subtitle: 'x' }, discarding whatever else was stored there (label, color, fields, defaults, ...).

Hit this twice, same class of bug in two different places: ArkActions.update first (fixed by shallow-merging the caller's partial update onto the current value, fetched fresh, before saving), then ArtifactActions.update second (same missing protection, found while scoping the Template composer — which edits template metadata one field at a time, e.g. just changing color, and would have wiped label/fields/entry_artifact_type on every edit without this fix).

Any future *Actions.update handler that accepts metadata or context in its payload needs this same shallow-merge-before-save treatment. Don't assume it's already handled just because a sibling action has it.`,
    tags: ['jsonb', 'data-loss', 'update'],
    applies_to: ['backend/ark/actions/ArkActions.js', 'backend/ark/actions/ArtifactActions.js'],
    confidence: 'high',
    source_type: 'tested_fix',
  },
  {
    slug: 'ephemera-vs-is-arc',
    title: 'Ephemera and is_arc are deliberately separate flags, not one concept',
    summary: 'Ephemera (context.is_ephemera) is the triage/inbox source a future Librarian processes FROM; is_arc:true is a curated destination it promotes INTO. Conflating them would need special-casing anyway.',
    body: `Two flags that could look redundant but aren't: Ephemera is a singleton per store (Artifact.getOrCreateEphemera()), the triage inbox where unattached artifacts land — it should never be tagged is_arc:true even though it's technically an Ark, because it isn't a finished, curated destination the way a real Ark is. Giving it is_arc:true would mean every consumer of "is_arc:true" (a future Librarian, the UI's "Arc" pill) would need to special-case "except this one" anyway — the two-flag split costs nothing since Ephemera is always reached via its own dedicated lookup, never a generic is_arc scan.

The initial framing mistake (corrected mid-conversation): a Librarian agent does NOT skip Ephemera — Ephemera is exactly what it processes to decide what gets promoted. "Not is_arc" means "not yet a finished destination," not "not relevant."`,
    tags: ['ephemera', 'librarian', 'data-model'],
    applies_to: ['backend/ark/domain/Artifact.js'],
    confidence: 'high',
    source_type: 'observed_pattern',
  },
  {
    slug: 'contract-fields-is-not-create-payload-shape',
    title: 'A template\'s contract.fields describes entry-capture shape, not the Ark\'s own creation payload',
    summary: 'JournalCapture and the Packet Builder use contract.fields to know what an entry within an ark should look like — it was never meant to validate/gate ark.create or ark.update\'s own fields.',
    body: `A template's metadata.fields ([{key, type, label, required, default}, ...]) exists to describe what fields an ENTRY captured within that ark type should have — the thing JournalCapture renders a form for, and what the admin Packet Builder dev tool previews. ark.create and ark.update happen to resolve and attach the same template contract (because template_id appears in both an ark's own creation payload and separately as "which contract governs entries here") — but that's two different concerns sharing one resolved object by coincidence of the payload shape, not by design.

The payload.project PCER stage doesn't know the difference — it applies contract.fields narrowing to whatever payload it's handed, regardless of whether that payload is "create this ark" or "capture this entry." This ambiguity is the root cause of the payload-project-merge-not-replace skill's bug. Worth remembering when authoring a new template: its fields array is for entries, not for what ark.create itself will accept.`,
    tags: ['templates', 'pcer', 'contracts'],
    applies_to: ['backend/ark/core/TemplateResolver.js', 'backend/ark/actions/TraceActions.js'],
    confidence: 'high',
    source_type: 'observed_pattern',
  },
  {
    slug: 'created-by-not-ark-actor',
    title: 'created_by/owner_id are Seravanna user IDs, not ark_actor IDs',
    summary: 'ark_actors is ARK\'s own identity concept, unrelated to Seravanna\'s users table — anything created via an ark_actor-authenticated path (the CLI publish flow) never had a user_id in context, so created_by silently stayed null.',
    body: `ark_actors (permission/rank, ARK's own notion of "who") is deliberately NOT the same table as Seravanna's users — see ArkActor.js's own comment on why (retyping bigint FKs across the whole schema to UUID to unify them wasn't worth it). But Artifact.prepare()'s created_by/owner_id fallback only reads ctx.user_id — which is never populated on the CLI publish path (sync.push authenticates via ark_actor_id instead). Result: 19 store-1 artifacts (Birds and its 18 photos) had created_by: null until backfilled by hand.

Fixed by having SyncActions.push resolve the store's ADMIN-rank Seravanna user (resolveCloudUserId, mirroring the existing resolveCloudActorId's "explicit id wins, else auto-resolve the one unambiguous owner, else error" shape) and backfill created_by/owner_id before upsert, so this shouldn't recur for future CLI-published artifacts. Anything authenticated via ark_actor_id rather than a real user session needs the same consideration if it ever writes created_by-sensitive data.`,
    tags: ['ark-actors', 'sync', 'attribution'],
    applies_to: ['backend/ark/actions/SyncActions.js', 'backend/ark/domain/Artifact.js'],
    confidence: 'high',
    source_type: 'tested_fix',
  },
  {
    slug: 'store-table-is-singular',
    title: 'The tenant table is `store`, not `stores`',
    summary: 'Supabase queries must use .from(\'store\') — .from(\'stores\') returns a silent "relation does not exist" error, not obviously a naming mismatch.',
    body: `The tenant table is named store (singular) throughout this schema, not the more conventional plural stores. Using .from('stores') fails with a "relation does not exist" Postgres error — not obviously a naming-convention mismatch at a glance, especially since every other core table in this schema IS plural (artifacts, artifact_media, artifact_relations...). This has caused confusion more than once. No code fix needed, just worth remembering before assuming pluralization is consistent across the schema.`,
    tags: ['schema', 'naming', 'gotcha'],
    applies_to: [],
    confidence: 'high',
    source_type: 'observed_pattern',
  },
  {
    slug: 'heic-cannot-be-decoded-client-side',
    title: 'Browsers cannot decode HEIC/HEIF at all — client-side Image()/canvas approaches silently hang on it',
    summary: 'new Image().onload never fires for a HEIC data_url in essentially any browser — the exact format an iPhone photo defaults to, so anything client-side that assumes it can decode an uploaded image will hang on the most common real-world case.',
    body: `HEIC/HEIF (iPhone's default photo capture format since iOS 11) cannot be decoded by essentially any browser's <img>/Image()/canvas machinery — not rendered with wrong colors, not a visible error, onload simply never fires and the operation hangs indefinitely. This bit twice: once for a naive image preview thumbnail (accepted as a known, low-stakes limitation — just shows a broken image icon, not worth fixing), and once for real when a canvas-based client-side photo-scaling feature used new Image() to decode a file for resizing — a large HEIC photo (the primary real-world case that feature needed to handle) would have hung the UI instead of scaling, silently, with no error path at all.

Any feature that needs to read pixels, dimensions, or re-encode an uploaded image must do it server-side (after HEIC has already been transcoded to a real format), or via a header-only reader that doesn't require a full decode (image-size, used for artifact.probe_media, reads container dimensions directly without this problem). Never assume a client-side Image()/canvas step will work uniformly across upload formats.`,
    tags: ['heic', 'media', 'uploads', 'browser-limitation'],
    applies_to: ['backend/ark/domain/transcodeHeic.js', 'frontend/components/arks/EditArkDialog.tsx'],
    confidence: 'high',
    source_type: 'tested_fix',
  },
];

module.exports = { SKILLS };
