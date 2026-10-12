const Artifact         = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');

// Resolve an ACTION_REGISTRY entry to its callable handler. Entries are
// { capability, handler } objects, not bare functions — mirrors
// ChainExecutor._executeSteps's extraction so both call sites agree on shape.
function _resolveHandler(registry, actionName) {
  const entry = registry[actionName];
  return entry?.handler || (typeof entry === 'function' ? entry : null);
}

// Lazy-load to avoid circular require with core/dispatch.js
function getRegistry() {
  return require('../core/dispatch').ACTION_REGISTRY;
}

// Workflows and tasks are artifacts.
//
// workflow → artifact_type: 'collection'
//            context: { is_workflow, workflow_key, active_task_id, is_completed, data }
//
// task     → artifact_type: 'task'
//            context: { action, payload, template_id, active, completed, next_task_id, result }
//
// Relations: workflow —[has_task order_index=N]→ task

async function start(ctx, payload, packet) {
  const { workflow_key, title, artifact_id, tasks: taskDefs = [], initial_data = {} } = payload;
  if (!workflow_key) throw new Error('workflow_key is required');
  if (!taskDefs.length) throw new Error('tasks[] is required');

  const workflow = new Artifact({
    artifact_type: 'collection',
    title:         title || workflow_key,
    context: {
      is_workflow:      true,
      workflow_key,
      active_task_id:   null,
      is_completed:     false,
      linked_artifact:  artifact_id || null,
      data:             initial_data,
    },
  }, { context: ctx });

  await workflow.save();

  // Task order is array order — tasks[] has no separate ordering field, so
  // there's nothing to sort by; preserve exactly what the caller submitted.
  const ordered = [...taskDefs];

  // Create each task through Packet.save() — goes through prepare()/authorize()/
  // schema like every other artifact write, instead of a raw batch insert.
  const createdTasks = [];
  for (const t of ordered) {
    const task = new Artifact({
      artifact_type: 'task',
      title:         t.title || t.action,
      context: {
        action:       t.action,
        payload:      t.payload || {},
        template_id:  t.template_id || null,
        active:       false,
        completed:    false,
        next_task_id: null,
        result:       {},
      },
    }, { context: ctx });
    await task.save();
    createdTasks.push(task);
  }

  // Wire next_task_id as a linked list; mark the first task active.
  for (let i = 0; i < createdTasks.length; i++) {
    const nextId = createdTasks[i + 1]?.id || null;
    createdTasks[i].assign({
      context: { ...createdTasks[i].get('context'), next_task_id: nextId, active: i === 0 },
    });
    await createdTasks[i].save();
  }

  // Create has_task relations, preserving order.
  for (let i = 0; i < createdTasks.length; i++) {
    const rel = new ArtifactRelation({
      source_artifact_id: workflow.id,
      target_artifact_id: createdTasks[i].id,
      relation_type:      'has_task',
      order_index:         i,
    }, { context: ctx });
    await rel.save();
  }

  const firstTask = createdTasks[0];
  workflow.assign({ context: { ...workflow.get('context'), active_task_id: firstTask.id } });
  await workflow.save();

  packet._objects['workflow']    = workflow.data;
  packet._objects['active_task'] = firstTask.data;
  packet.log.push(`workflow.start → ${workflow.id} "${workflow_key}", ${createdTasks.length} tasks`);

  return {
    data: {
      workflow:    workflow.data,
      tasks:       createdTasks.map(t => t.data),
      active_task: firstTask.data,
    },
  };
}

async function get(ctx, payload, packet) {
  const { workflow_id } = payload;
  if (!workflow_id) throw new Error('workflow_id is required');

  const workflow = await Artifact.findById(workflow_id, ctx);
  if (!workflow) throw Object.assign(new Error('Workflow not found'), { status: 404 });

  const { data: rels } = await Artifact.db
    .from('artifact_relations')
    .select('target_artifact_id, order_index, artifacts!target_artifact_id(*)')
    .eq('source_artifact_id', workflow_id)
    .eq('relation_type', 'has_task')
    .order('order_index', { ascending: true });

  const tasks      = (rels || []).map(r => r.artifacts);
  const activeTask = tasks.find(t => t.id === workflow.get('context')?.active_task_id) || null;

  packet._objects['workflow']    = workflow.data;
  packet._objects['active_task'] = activeTask;
  packet.log.push(`workflow.get → ${workflow_id} "${workflow.get('context')?.workflow_key}", ${tasks.length} tasks`);

  return { data: { workflow: workflow.data, tasks, active_task: activeTask } };
}

async function completeTask(ctx, payload, packet) {
  const { workflow_id, task_id, data: runtimeData = {} } = payload;
  if (!workflow_id || !task_id) throw new Error('workflow_id and task_id are required');

  const [workflow, task] = await Promise.all([
    Artifact.findById(workflow_id, ctx),
    Artifact.findById(task_id, ctx),
  ]);

  if (!workflow) throw Object.assign(new Error('Workflow not found'), { status: 404 });
  if (!task)     throw Object.assign(new Error('Task not found'),     { status: 404 });

  const wfCtx   = workflow.get('context') || {};
  const taskCtx = task.get('context')     || {};

  if (wfCtx.active_task_id !== task_id) throw new Error('Task is not the active task');
  if (taskCtx.completed)                throw new Error('Task already completed');

  const mergedPayload = { ...taskCtx.payload, ...runtimeData };

  const handler = _resolveHandler(getRegistry(), taskCtx.action);
  if (!handler) throw new Error(`No handler registered for action: ${taskCtx.action}`);

  packet.log.push(`workflow.complete_task → executing "${taskCtx.action}" for task:${task_id}`);
  const result = await handler(ctx, mergedPayload, packet);

  task.assign({ context: { ...taskCtx, completed: true, active: false, result: result.data || {} } });
  await task.save();

  const nextTaskId = taskCtx.next_task_id || null;
  const isLast     = !nextTaskId;

  const updatedWfCtx = {
    ...wfCtx,
    active_task_id: nextTaskId,
    is_completed:   isLast,
    data: { ...wfCtx.data, ...packet._objects },
  };
  workflow.assign({ context: updatedWfCtx });
  await workflow.save();

  let nextTask = null;
  if (nextTaskId) {
    nextTask = await Artifact.findById(nextTaskId, ctx);
    if (nextTask) {
      nextTask.assign({ context: { ...nextTask.get('context'), active: true } });
      await nextTask.save();
    }
  }

  if (isLast) {
    packet.events['workflow.complete'] = [{ workflow_id, workflow_key: wfCtx.workflow_key }];
    packet.log.push(`workflow.complete_task → workflow ${workflow_id} COMPLETED`);
  } else {
    packet.events['task.complete'] = [{ task_id, next_task_id: nextTaskId }];
    packet.log.push(`workflow.complete_task → task:${task_id} done, next: "${nextTask?.get('title') || nextTask?.get('context')?.action}"`);
  }

  const completedTaskData = task.data;
  const nextTaskData      = nextTask ? nextTask.data : null;

  packet._objects['completed_task'] = completedTaskData;
  packet._objects['next_task']      = nextTaskData;

  return {
    data: {
      completed_task: completedTaskData,
      next_task:       nextTaskData,
      is_completed:    isLast,
      workflow_data:   updatedWfCtx.data,
    },
  };
}

module.exports = { start, get, completeTask };
module.exports._internals = { _resolveHandler };
