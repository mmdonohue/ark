const ArtifactChain = require('../domain/ArtifactChain');

async function get(ctx, payload, packet) {
  const { chain_id } = payload;
  if (!chain_id) throw new Error('chain_id is required');

  const { data: chain, error } = await ArtifactChain.db
    .from('artifact_chains')
    .select('*')
    .eq('id', chain_id)
    .eq('store_id', ctx.store_id)
    .single();

  if (error || !chain) throw Object.assign(new Error('Chain not found'), { status: 404 });

  const { data: steps } = await ArtifactChain.db
    .from('artifact_chain_steps')
    .select('*')
    .eq('chain_id', chain_id)
    .order('step_index', { ascending: true });

  packet.log.push(`chain.get → ${chain_id} (${chain.status}, ${steps?.length || 0} steps)`);
  return { data: { chain, steps: steps || [] } };
}

async function list(ctx, payload, packet) {
  const { status, limit = 25 } = payload;

  let q = ArtifactChain.db
    .from('artifact_chains')
    .select('id, action, status, created_at, started_at, completed_at, error, context')
    .eq('store_id', ctx.store_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) q = q.eq('status', status);

  const { data: chains, error } = await q;
  if (error) throw new Error(error.message);

  packet.log.push(`chain.list → ${chains?.length || 0} chains`);
  return { data: { chains: chains || [] } };
}

module.exports = { get, list };
