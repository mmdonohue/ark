const Artifact          = require('../domain/Artifact');
const TemplateResolver  = require('../core/TemplateResolver');

async function list(ctx, payload, packet) {
  const { ark_type } = payload;

  // Global templates (store_id IS NULL) + this store's templates. Two plain
  // queries instead of a PostgREST .or() string: works on the local sqlite
  // adapter (which rejects .or()), and ctx.store_id is bound as a value
  // rather than interpolated into a filter expression.
  const base = () => Artifact.db
    .from('artifacts')
    .select('*')
    .eq('artifact_type', 'template')
    .eq('status', 'published')
    .eq('inactive', false);

  const queries = [base().is('store_id', null)];
  if (ctx.store_id) queries.push(base().eq('store_id', ctx.store_id));

  const results = await Promise.all(queries);
  const failed  = results.find(r => r.error);
  if (failed) throw new Error(failed.error.message);

  // ark_type lives in metadata JSON; filtered here rather than with a
  // JSON-path .filter() so both adapters behave the same.
  const meta = t => (typeof t.metadata === 'string' ? JSON.parse(t.metadata || '{}') : t.metadata) || {};
  const templates = results.flatMap(r => r.data || [])
    .filter(t => !ark_type || meta(t).ark_type === ark_type)
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

  packet.log.push(`template.list → ${templates.length} results`);
  return { data: { templates } };
}

async function get(ctx, payload, packet) {
  const { template_id } = payload;
  if (!template_id) throw new Error('template_id is required');

  const { data: template, error } = await Artifact.db
    .from('artifacts')
    .select('*')
    .eq('id', template_id)
    .eq('artifact_type', 'template')
    .single();

  if (error || !template) throw Object.assign(new Error('Template not found'), { status: 404 });

  const contract = await TemplateResolver.resolve(template_id);

  packet._objects['template'] = template;
  packet.log.push(`template.get → ${template_id} "${template.title}"${contract ? ' (contract resolved)' : ''}`);

  return { data: { template, contract } };
}

module.exports = { list, get };
