/*
 * Public Supabase client settings for the static Witcher site.
 * This committed file points to PRODUCTION (WitcherAPP, iwpmsfoovppqnldciric).
 * The publishable key is designed for browser use; RLS and the edge functions are the security boundary.
 * Never put a service_role/secret API key in this file.
 * For local work against STAGING (WitcherAPP-staging, dvyeucfxwkibscooocby) the local copy is edited and
 * hidden from git with `git update-index --skip-worktree supabase-config.js`; never commit that edit.
 */
window.WITCHER_SUPABASE_CONFIG = {
  url: 'https://iwpmsfoovppqnldciric.supabase.co',
  publishableKey: 'sb_publishable_6p9aVFFcA9Uc-nW9-MofsQ_EAyjZoh9'
};
