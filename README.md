# App-test

Working Timer con login, deployabile in modo semplice su Netlify + Supabase.

## Architettura consigliata (gratuita)

- Frontend statico: Netlify
- Auth + DB: Supabase

## Config frontend

Apri `public/config.js` e inserisci:

```js
window.APP_CONFIG = {
  supabaseUrl: "https://<project-ref>.supabase.co",
  supabaseAnonKey: "<anon-or-publishable-key>",
};
```

## Supabase (obbligatorio)

Devi avere create le tabelle:
- `profiles`
- `work_entries`
- `day_adjustments`

con RLS attivo e policy per utente (`auth.uid()`).

Per login con `username` (oltre a email), aggiungi:

```sql
alter table public.profiles
  add column if not exists username text unique,
  add column if not exists email_login text;

create or replace function public.get_email_by_username(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select email_login
  from public.profiles
  where lower(username) = lower(p_username)
  limit 1;
$$;

grant execute on function public.get_email_by_username(text) to anon, authenticated;
```

## Netlify

Impostazioni corrette:
- Base directory: vuoto
- Publish directory: `public`
- Build command: vuoto

## Locale rapido (solo frontend statico)

```bash
npx serve public
```

Poi apri l'URL locale mostrato.
