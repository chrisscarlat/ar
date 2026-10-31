// Public Supabase settings. The anon (or publishable) key is safe to commit:
// Row Level Security in supabase/schema.sql decides what it may do.
// NEVER put the service_role / secret key here or anywhere in this repo.
window.AR_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-OR-PUBLISHABLE-KEY'
};
