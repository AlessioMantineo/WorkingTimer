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
