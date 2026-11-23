'use strict';

// The output contract for structured model replies: a small JSON-Schema
// subset — type, required, properties, additionalProperties:false, enum,
// minimum/maximum, minLength/maxLength, items. Enough to reject a reply
// that parses but isn't what the caller asked for, without a dependency.
//
// validate(schema, value) → [] when valid, else ['$.path: problem', ...].

const MAX_ERRORS = 10;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matches(type, v) {
  const t = typeOf(v);
  return type === t || (type === 'number' && t === 'integer');
}

function validate(schema, value, at = '$', errors = []) {
  if (errors.length >= MAX_ERRORS) return errors;
  const fail = msg => { if (errors.length < MAX_ERRORS) errors.push(`${at}: ${msg}`); return errors; };

  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some(t => matches(t, value))) return fail(`expected ${types.join('|')}, got ${typeOf(value)}`);
  }
  if (schema.enum && !schema.enum.some(e => e === value)) return fail(`must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`);

  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) fail(`must be ≥ ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) fail(`must be ≤ ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength != null && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors));

  if (typeOf(value) === 'object') {
    for (const k of schema.required || []) if (!(k in value)) fail(`missing "${k}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) fail(`unexpected "${k}"`);
    }
  }
  return errors;
}

module.exports = { validate };
