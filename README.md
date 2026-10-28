# Witcher

AI interviews for hiring teams (working name). A candidate receives a link and a code by e-mail, gives consent, answers a few questions out loud, and the hiring team gets a short written evaluation and the transcript. Audio is never stored. It works on its own and plugs into [Pathway](https://github.com/SoyFelps/pathway).

**Status:** early setup. Only the static site skeleton exists so far.

## Run locally

Static HTML/CSS/JavaScript, no build step and no `package.json`.

```sh
node serve-local.js
```

Then open http://localhost:8001/. Run the checks with:

```sh
node --test tests/*.test.js
```

## Backend

Supabase (Postgres, Auth, Edge Functions). Two projects: production `WitcherAPP` and `WitcherAPP-staging`. `supabase-config.js` holds only the public (publishable) key. Secrets (Gemini, Resend, shared Pathway keys) live only in the Supabase dashboard and are never committed.
