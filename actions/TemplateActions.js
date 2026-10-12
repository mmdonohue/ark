const Artifact          = require('../domain/Artifact');
const TemplateResolver  = require('../core/TemplateResolver');

async function list(ctx, payload, packet) {
  const { ark_type } = payload;

  // Global templates (store_id IS NULL) + store-specific templates — can't use Artifact.query for OR
  let query = Artifact.db
    .from('artifacts')
    .select('*')
    .eq('artifact_type', 'template')
    .eq('status', 'published')
    .eq('inactive', false)
    .or(`store_id.is.null,store_id.eq.${ctx.store_id}`)
    .order('title');

  if (ark_type) {
    query = query.filter('metadata->>ark_type', 'eq', ark_type);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  packet.log.push(`template.list → ${data.length} results`);
  return { data: { templates: data } };
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
