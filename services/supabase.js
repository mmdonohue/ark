// Relocated verbatim from seravanna-site/backend/services/supabase.js as
// part of extracting ark/ into its own repo — this file itself was never
// part of ark's engine code, just the one external dependency ~9 files
// reached outside the tree for (require('../../services/supabase')).
// Two deltas from the original, both forced by moving repos rather than
// a redesign: the .env path is one level shallower (services/ is now at
// the repo root, not nested under backend/), and the connection check
// below queries `artifacts` (ark's own core table) instead of `bookings`
// (a Seravanna business table with no reason to exist in an arbitrary
// Supabase project this repo might point at).
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function verifySupabaseConnection() {
  try {
    const { error } = await supabase
      .from('artifacts')
      .select('id')
      .limit(1);
    if (error) {
      console.error('Supabase connection test failed:', error.message);
      return false;
    }
    console.log('Supabase connection test succeeded.');
    return true;
  } catch (err) {
    console.error('Supabase connection test error:', err);
    return false;
  }
}

module.exports = { supabase, verifySupabaseConnection };
