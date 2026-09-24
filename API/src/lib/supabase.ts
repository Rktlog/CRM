import { createClient } from '@supabase/supabase-js';

// Anon key is enough here — this client only ever verifies a token
// a rep sends us, it never acts on their behalf with elevated rights.
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);
