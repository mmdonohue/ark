'use strict';

// dispatch() — the governed execution core, extracted from what used to be
// backend/routes/action.js. Transport-agnostic: takes a packet and a
// pre-resolved ctx, never touches Express/HTTP or any Seravanna-specific
// service. The HTTP boundary (backend/routes/action.js) is a thin caller —
// same as cli/ark.js, cli/ark-dev.js, and scripts/import-chats.js are.

const crypto = require('crypto');
const { getManifest } = require('./bootstrap');
const ChainExecutor    = require('./ChainExecutor');
const PCER             = require('./PCER');
const TemplateResolver = require('./TemplateResolver');
const ArkActions       = require('../actions/ArkActions');
const ArtifactActions  = require('../actions/ArtifactActions');
const WorkflowActions  = require('../actions/WorkflowActions');
const TemplateActions  = require('../actions/TemplateActions');
const ChainActions     = require('../actions/ChainActions');
const TraceActions     = require('../actions/TraceActions');
const LedgerActions    = require('../actions/LedgerActions');
const ChatActions      = require('../actions/ChatActions');
const SyncActions      = require('../actions/SyncActions');
const ArkActorActions  = require('../actions/ArkActorActions');
const MediaImportActions = require('../actions/MediaImportActions');
const VideoImportActions = require('../actions/VideoImportActions');
const ClassifyActions  = require('../actions/ClassifyActions');
const PipelineActions  = require('../actions/PipelineActions');
const CatalogActions   = require('../actions/CatalogActions');
const CinemaRenderActions = require('../actions/CinemaRenderActions');

// Trace contract handlers — run by PCER before every action handler.
// Separate namespace from ACTION_REGISTRY; contracts never see this registry.
const PCER_REGISTRY = {
  'trace.open':       TraceActions.open,
  'auth.verify':      TraceActions.verify,
  'ledger.open':      LedgerActions.open,
  'scope.resolve':    TraceActions.resolveScope,
  'payload.project':  TraceActions.projectPayload,
  'service.bind':     TraceActions.bindServices,
};

// ACTION_REGISTRY — every entry declares the minimum capability required to
// invoke that action. _assertCapability() enforces this at the dispatch boundary
// before any handler runs. null = unguarded (allowed for any authenticated actor).
const ACTION_REGISTRY = {
  'ark.create':            { capability: 'artifact.write',   handler: ArkActions.create },
  'ark.list':              { capability: 'artifact.read',    handler: ArkActions.list },
  'ark.get':               { capability: 'artifact.read',    handler: ArkActions.get },
  'ark.graph':             { capability: 'artifact.read',    handler: ArkActions.graph },
  'ark.update':            { capability: 'artifact.write',   handler: ArkActions.update },
  'ark.archive':           { capability: 'artifact.archive', handler: ArkActions.archive },
  'ark.add_artifact':      { capability: 'artifact.write',   handler: ArkActions.addArtifact },
  'ark.remove_artifact':   { capability: 'artifact.write',   handler: ArkActions.removeArtifact },
  'ark.move_artifact':     { capability: 'artifact.write',   handler: ArkActions.moveArtifact },
  'ark.reorder_artifacts': { capability: 'artifact.write',   handler: ArkActions.reorderArtifacts },

  'artifact.create':       { capability: 'artifact.write',   handler: ArtifactActions.create },
  'artifact.get':          { capability: 'artifact.read',    handler: ArtifactActions.get },
  'artifact.list':         { capability: 'artifact.read',    handler: ArtifactActions.list },
  'artifact.update':       { capability: 'artifact.write',   handler: ArtifactActions.update },
  'artifact.archive':      { capability: 'artifact.archive', handler: ArtifactActions.archive },
  'artifact.add_media':    { capability: 'artifact.write',   handler: ArtifactActions.addMedia },
  'artifact.remove_media': { capability: 'artifact.write',   handler: ArtifactActions.removeMedia },
  'artifact.like':         { capability: 'artifact.like',    handler: ArtifactActions.toggleLike },
  'artifact.relate':       { capability: 'artifact.write',   handler: ArtifactActions.relate },
  'artifact.unrelate':     { capability: 'artifact.write',   handler: ArtifactActions.unrelate },
  'artifact.resolve_url':  { capability: 'artifact.read',    handler: ArtifactActions.resolveUrl },
  'artifact.probe_media':  { capability: 'artifact.read',    handler: ArtifactActions.probeMedia },
  'artifact.events.list':  { capability: 'artifact.read',    handler: ArtifactActions.listEvents },

  'workflow.start':        { capability: 'workflow.execute',  handler: WorkflowActions.start },
  'workflow.get':          { capability: 'workflow.read',     handler: WorkflowActions.get },
  'workflow.complete_task':{ capability: 'workflow.execute',  handler: WorkflowActions.completeTask },

  'template.list':         { capability: 'template.read',    handler: TemplateActions.list },
  'template.get':          { capability: 'template.read',    handler: TemplateActions.get },

  'chain.get':             { capability: 'chain.read',       handler: ChainActions.get },
  'chain.list':            { capability: 'chain.read',       handler: ChainActions.list },

  'ledger.get':            { capability: 'ledger.read',      handler: LedgerActions.get },
  'ledger.list':           { capability: 'ledger.read',      handler: LedgerActions.list },

  'chat.import':           { capability: 'artifact.write',   handler: ChatActions.importChat },

  'sync.push':             { capability: 'sync.write',       handler: SyncActions.push },
  'catalog.generate_sale_code': { capability: 'catalog.write',  handler: CatalogActions.generateSaleCode },
  'catalog.redeem_sale_code':   { capability: 'catalog.redeem', handler: CatalogActions.redeemSaleCode },

  'ark_actor.create':      { capability: 'ark_actor.write',  handler: ArkActorActions.create },

  'source.discover':          { capability: 'filesystem.read',  handler: MediaImportActions.discoverSource },
  'source.filter':            { capability: null,               handler: MediaImportActions.filterSource },
  'media.identify':           { capability: null,               handler: MediaImportActions.identifyMedia },
  'media.fingerprint':        { capability: 'filesystem.read',  handler: MediaImportActions.fingerprintMedia },
  'artifact.resolve_duplicate': { capability: 'artifact.read',  handler: MediaImportActions.resolveDuplicate },
  'media.preserve':           { capability: 'artifact.write',   handler: MediaImportActions.preserveMedia },
  'media.pair':                { capability: null,               handler: MediaImportActions.pairMedia },
  'media.persist_pairing':    { capability: 'artifact.write',   handler: MediaImportActions.persistRepresentationRoles },
  'memchart.assess':          { capability: null,               handler: MediaImportActions.assessMemchart },
  'cache.partition':          { capability: 'filesystem.write', handler: MediaImportActions.partitionCache },
  'media.archive_copy':       { capability: 'filesystem.write', handler: MediaImportActions.archiveMedia },
  'cache.materialize_bucket': { capability: 'filesystem.write', handler: MediaImportActions.materializeBucket },
  'cache.promote_bucket':     { capability: 'artifact.write',   handler: MediaImportActions.promoteBucket },
  'media.classify.vision':    { capability: 'media.classify',   handler: ClassifyActions.classifyVision },
  'media.classify_batch':     { capability: 'media.classify',   handler: ClassifyActions.classifyBatch },
  'media.detect_scenes':      { capability: 'filesystem.write', handler: VideoImportActions.detectScenes },

  'pipeline.run':          { capability: 'pipeline.execute', handler: PipelineActions.run },
  'pipeline.list':         { capability: 'pipeline.read',    handler: PipelineActions.list },
  'pipeline.register':     { capability: 'pipeline.manage',  handler: PipelineActions.register },
  // Invoked as a pipeline stage (pipelines/cinema-reel), not typically
  // dispatched directly — capability matches media.preserve/promoteBucket,
  // both of which also produce new artifact/media rows.
  'cinema.render_reel':    { capability: 'artifact.write',   handler: CinemaRenderActions.renderReel },
};

// ── Capability enforcement ────────────────────────────────────────────────────
// Throws 403 if the required capability is not in the ExecutionPacket.
// Called at the dispatch boundary — before any handler runs.
// null capability = unguarded action (allowed unconditionally).
function _assertCapability(ep, capability) {
  if (!capability) return;
  if (!ep.capabilities?.includes(capability)) {
    throw Object.assign(
      new Error(`Capability required: ${capability}`),
      { status: 403, code: 'CAPABILITY_DENIED', required: capability },
    );
  }
}

// ── Egress shaping ────────────────────────────────────────────────────────────
// response.type controls only the shape of data. The outer envelope is stable.
function _shapeEgress(data, type) {
  if (!data) return data;
  switch (type) {
    case 'artifact':  return { artifact: data.artifact, ark_id: data.ark_id ?? null };
    case 'packet':    return { packet: data };
    case 'status':    return { status: data.status ?? 'ok', ...(data.message ? { message: data.message } : {}) };
    case 'composite': return data;
    default:          return data;
  }
}

// ── dispatch(rawPacket, ctx) ──────────────────────────────────────────────────
//
// The governed execution core. Accepts a packet and a pre-resolved context,
// runs the full PCER pipeline, dispatches the handler, and returns a result
// envelope identical in shape to the HTTP response.
//
// Called by the HTTP route handler in ../../routes/action.js, and directly by
// scripts and internal callers (import scripts, rules dispatcher, chain
// hooks) — no HTTP required.
//
// ctx must carry: { store_id, user_id, source }
// ctx may carry:  { site_id, request_id, ip, user_agent }
//
// Throws on PCER failures, unknown actions, and capability denials.
// Callers that want a structured error response should catch and format.
async function dispatch(rawPacket, ctx) {
  const { action, payload = {}, meta = {}, _objects: clientObjects = {} } = rawPacket;

  const request_id = meta.request_id || crypto.randomUUID();

  const packet = {
    action,
    payload,
    meta:     { ...meta, request_id, source: meta.source || ctx.source || 'system' },
    _objects: { ...clientObjects },
    events:   {},
    log:      [],
  };

  if (!action) throw Object.assign(new Error('action is required'), { status: 400, code: 'MISSING_ACTION' });

  const actionDef = ACTION_REGISTRY[action];
  if (!actionDef) throw Object.assign(new Error(`Unknown action: ${action}`), { status: 404, code: 'UNKNOWN_ACTION' });

  const fullCtx = {
    ...ctx,
    request_id,
    source: ctx.source || meta.source || 'system',
  };

  const logger = getManifest().get('logger');
  const start  = Date.now();
  const logTag = `req=${request_id} user=${fullCtx.user_id} store=${fullCtx.store_id}`;

  logger.info(`→ ${action}  ${logTag}  src=${fullCtx.source}`);
  packet.log.push(`[${action}] start`);

  let ep        = null;
  let chainMeta = null;
  let runtimeMeta = {};

  try {
    const contract = payload.template_id
      ? await TemplateResolver.resolve(payload.template_id)
      : null;

    const canonicalPacket = Object.freeze({
      action,
      payload:  Object.freeze({ ...payload }),
      meta:     Object.freeze({ ...packet.meta }),
      _objects: packet._objects,
    });

    ep = await PCER.resolve({
      canonicalPacket,
      contract,
      ctx: fullCtx,
      registry: PCER_REGISTRY,
    });

    const pcerStages = ep.trace.steps.map(s => s.action).join('→');
    logger.debug(`  ⬡ PCER  req=${request_id}  ${pcerStages}`);
    packet.log.push(`[pcer] ${pcerStages}`);

    _assertCapability(ep, actionDef.capability);

    const result = await actionDef.handler(ep, ep.payload, packet);

    let chainResult = null;
    if (result._chain_hooks?.length) {
      chainResult = await ChainExecutor.run({
        hooks:        result._chain_hooks,
        originAction: action,
        payload,
        ctx:          fullCtx,
        registry:     ACTION_REGISTRY,
        response:     result._chain_response || null,
      });
      if (chainResult) {
        packet._objects['chain'] = chainResult;
        chainMeta = {
          id:         chainResult.chain_id,
          status:     chainResult.status,
          resolution: chainResult.resolution,
          type:       chainResult.type || null,
        };
      }
    }

    const ms = Date.now() - start;
    const chainSuffix = chainResult ? `  chain:${chainResult.chain_id}  resolution:${chainResult.resolution}` : '';
    packet.log.push(`[${action}] ok`);
    logger.info(`← ${action}  req=${request_id}  ${ms}ms  ok${chainSuffix}`);

    if (ep?.ledger_id) {
      LedgerActions.close(ep.ledger_id, { chainResult }, ep).catch(err =>
        logger.warn(`ledger.close failed  req=${request_id}  ${err.message}`),
      );
    }

    const responseType = chainResult?.type || contract?.response?.type || null;
    const mergedData   = chainResult?.data ? { ...result.data, ...chainResult.data } : result.data;

    runtimeMeta = {
      packet_id:     ep?.packet_id  || null,
      ledger_id:     ep?.ledger_id  || null,
      resolution:    chainResult?.resolution || null,
      response_type: responseType,
    };

    return {
      ok:       true,
      action,
      data:     _shapeEgress(mergedData, responseType),
      _objects: packet._objects,
      events:   packet.events,
      log:      packet.log,
      meta:     { request_id, ...runtimeMeta, ...(chainMeta ? { chain: chainMeta } : {}) },
    };

  } catch (err) {
    const ms     = Date.now() - start;
    const status = err.status || 500;
    const code   = err.pcer_stage
      ? `PCER_${err.pcer_stage.toUpperCase().replace(/\./g, '_')}`
      : (err.code || 'ACTION_ERROR');
    const stage = err.pcer_stage ? `  pcer:${err.pcer_stage}` : '';
    packet.log.push(`[${action}] error: ${err.message}${stage}`);
    logger.error(`← ${action}  req=${request_id}  ${ms}ms  ERROR ${err.message}${stage}`);

    if (ep?.ledger_id) {
      LedgerActions.error(ep.ledger_id, err, ep).catch(e =>
        logger.warn(`ledger.error failed  req=${request_id}  ${e.message}`),
      );
    }

    throw Object.assign(err, { status, code, _log: packet.log });
  }
}

module.exports = { dispatch, ACTION_REGISTRY, PCER_REGISTRY, _shapeEgress, _assertCapability };
