'use strict';

// seed-users.js — mirrors Seravanna's `users` table into ARK as
// artifact_type: 'user'. This is a projection, not a new source of truth:
// ownership (artifacts.owner_id/created_by) stays exactly as-is, bigint
// pointing at Seravanna's users.id (see ArkActor.js's own comment on why
// that's deliberate) — metadata.seravanna_user_id here is a reference back
// to that same row, not a replacement for it.
//
// "For now" per Matt: a full mirror of the Seravanna row, EXCEPT
// auth_code — that's a live, currently-usable 2FA login code, not a hash,
// and copying it into a second table with its own separate visibility
// model would let a future ARK visibility bug leak a working login code,
// not just profile data (password's bcrypt hash is mirrored as-is — a
// one-way hash is a fundamentally different risk). signed_id (last-login
// timestamp) is also excluded — not identity, no clear use mirrored.
//
// Idempotent: matched by metadata.seravanna_user_id, so re-running only
// ever updates existing rows rather than duplicating them. Later, a
// separate ARK-native user-creation process (its own 2FA, etc.) replaces
// this seed — not built here.
//
// Usage:
//   node backend/ark/scripts/seed-users.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { supabase } = require('../services/supabase');
const { bootstrap, dispatch } = require('../index');
const Artifact = require('../domain/Artifact');

const STORE_ID = 1; // Seravanna — the only tenant today, see routes/action.js

// Privileged script ctx — rank 100 so a re-run's artifact.update on an
// existing user artifact always passes assertOwnerOrAdmin, regardless of
// what owner_id a prior run stamped.
const CTX = { store_id: STORE_ID, role: 'ADMIN', rank: 100, user_id: 1, source: 'seed-users-script' };

function mapMetadata(row, roleName, roleRank) {
  return {
    seravanna_user_id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    password: row.password,
    auth_code_sent: row.auth_code_sent,
    address_1: row.address_1,
    address_2: row.address_2,
    city: row.city,
    state: row.state,
    zipcode: row.zipcode,
    phone: row.phone,
    role: roleName,
    role_id: row.role_id,
    rank: roleRank,
    store_id: row.store_id,
    inactive: row.inactive,
    opt_out: row.opt_out,
    email_opt_in: row.email_opt_in,
    soft_launch: row.soft_launch,
  };
}

async function main() {
  await bootstrap({
    db:      { client: supabase },
    storage: { client: supabase, bucket: 'ark-media' },
  });

  const { data: users, error: usersError } = await supabase.from('users').select('*');
  if (usersError) throw usersError;

  const { data: roles, error: rolesError } = await supabase.from('roles').select('id, role, rank');
  if (rolesError) throw rolesError;
  const roleById = new Map(roles.map(r => [r.id, r]));

  console.log(`${users.length} Seravanna user(s) to seed`);

  let created = 0;
  let updated = 0;

  for (const row of users) {
    const role = roleById.get(row.role_id);
    const roleName = role?.role || null;
    const roleRank = role?.rank ?? null;

    const title = `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.email;
    const summary = roleName ? `${roleName} — ${row.email}` : row.email;
    const metadata = mapMetadata(row, roleName, roleRank);
    const status = row.inactive ? 'archived' : 'published';

    const existing = await Artifact.query(
      { artifact_type: 'user', filters: [['metadata->>seravanna_user_id', 'eq', String(row.id)]], limit: 1 },
      CTX,
    );

    if (existing.length) {
      await dispatch(
        { action: 'artifact.update', payload: { artifact_id: existing[0].id, title, summary, status, metadata } },
        CTX,
      );
      console.log(`  updated  ${row.id}  ${title}`);
      updated++;
    } else {
      await dispatch(
        { action: 'artifact.create', payload: { artifact_type: 'user', title, summary, status, metadata } },
        CTX,
      );
      console.log(`  created  ${row.id}  ${title}`);
      created++;
    }
  }

  console.log(`Done — created ${created}, updated ${updated}`);
  process.exit(0);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
