# CurseForge Marketplace Proxy — Deployment Guide (Owner Only)

This document explains how the AnxOS project owner deploys and configures the CurseForge
Marketplace proxy backend so ordinary end users can browse, search, and install CurseForge
modpacks without ever configuring a CurseForge API key.

This is an **owner-only, one-time (per environment) infrastructure task**. It requires access to
the AnxOS Supabase project and a CurseForge Studio API key. It is not part of the desktop app
build and does not need to be repeated by end users or contributors.

## What this deploys

A Supabase Edge Function, `anxos-marketplace-curseforge`
(`supabase/functions/anxos-marketplace-curseforge/index.ts`), that:

- Holds the private CurseForge API key only as a server-side Supabase secret.
- Validates and narrowly allowlists which CurseForge API paths and CDN download hosts may be
  requested.
- Enforces request timeouts, response/download size limits, and best-effort rate limiting.
- Returns a stable, flat `{code, message}` JSON error contract on failure.
- Never returns, logs, or echoes the CurseForge API key to any caller.

The desktop app already knows how to call this function — see "Desktop integration" below.

## Prerequisites

- Supabase CLI installed and authenticated (`npx supabase login`).
- Access to the AnxOS Supabase project (`arqfbxstobusuamlizyq`), the same project already used by
  `supabase/functions/anxos-account`.
- A valid CurseForge Studio API key (from https://console.curseforge.com/).

## 1. Deploy the function

```bash
cd supabase
npx supabase functions deploy anxos-marketplace-curseforge --project-ref arqfbxstobusuamlizyq
```

## 2. Configure the CurseForge API key secret

```bash
npx supabase secrets set CURSEFORGE_API_KEY="REPLACE_WITH_REAL_CURSEFORGE_KEY" --project-ref arqfbxstobusuamlizyq
```

Never commit this value, put it in `.env`, or paste it into chat/logs/tickets. It only ever lives
in the Supabase secret store.

## 3. (Optional) Configure allowed origins

By default the function allows `https://anxoscontrolcenter.org` and local development origins. To
add more trusted origins:

```bash
npx supabase secrets set ANXOS_ALLOWED_ORIGINS="https://anxoscontrolcenter.org,https://staging.anxoscontrolcenter.org" --project-ref arqfbxstobusuamlizyq
```

## 4. Verify the deployment

```bash
curl -s https://arqfbxstobusuamlizyq.functions.supabase.co/anxos-marketplace-curseforge/api/v1/marketplace/curseforge/status \
  -H "apikey: <supabase-anon-key>"
```

Expected response: `{"configured": true}`. If the secret is missing you will instead see a `503`
with `{"code":"CURSEFORGE_AUTH_CONFIGURATION_MISSING", ...}` — deploy the function then repeat
step 2.

## Desktop integration (already implemented, no owner action required)

- `website/marketplace-config.js` bundles the public function URL
  (`curseforgeProxyUrl`) with every packaged build. This file contains no secret.
- `src/services/providers/curseforgeProvider.js` automatically falls back to this bundled URL
  whenever no explicit proxy override, Agent proxy, or local API key is configured
  (`resolveEffectiveHostedProxyUrl`), and attaches the public Supabase anon key as
  `apikey`/`Authorization: Bearer` headers when the request targets a `*.functions.supabase.co`
  host (`getHostedProxyAuthHeaders`).
- Structured `{code, message}` errors from the function are parsed and propagated to the desktop
  app and renderer unchanged (`parseHostedProxyErrorBody`).

## Rotating or revoking the CurseForge key

```bash
npx supabase secrets set CURSEFORGE_API_KEY="NEW_KEY" --project-ref arqfbxstobusuamlizyq
```

No desktop update or redeploy of the desktop app is required — existing installs pick up the
change automatically on their next request.

## Known limitations

- Rate limiting is best-effort and per-isolate (in-memory); it is not a durable, globally
  consistent limiter across all Supabase Edge Function isolates. For stronger abuse protection,
  add a CDN/WAF-level rate limit in front of the function.
- This guide does not perform the deployment itself — it can only be executed by someone with
  Supabase project credentials. No deployment was performed as part of the change that introduced
  this document.
