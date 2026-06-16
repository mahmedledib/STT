# Deployment guide — STT Platform

## What you're deploying

| File | Where |
|---|---|
| `worker/` | Cloudflare Worker (the backend) |
| `app/index.html` | Cloudflare Pages site 1 — user app |
| `admin/index.html` | Cloudflare Pages site 2 — dashboard |
| `schema.sql` | Loaded into Cloudflare D1 (the database) |

---

## Before you start

Install Node.js, then:
```
npm install -g wrangler
wrangler login
```

---

## Step 1 — Create the D1 database

```
wrangler d1 create stt-platform-db
```

Copy the `database_id` it prints.
Open `worker/wrangler.toml` and replace `PASTE_YOUR_D1_DATABASE_ID_HERE` with it.

---

## Step 2 — Load the schema

```
wrangler d1 execute stt-platform-db --remote --file=schema.sql
```

---

## Step 3 — Deploy the Worker

```
cd worker
wrangler deploy
```

It prints your Worker URL: `https://stt-platform.<account>.workers.dev`

---

## Step 4 — Create the first super-admin (one-time only)

```
curl -X POST https://stt-platform.<account>.workers.dev/api/setup/seed \
  -H "Content-Type: application/json" \
  -d '{"full_name":"Super Admin","phone":"12345678","password":"choose-something"}'
```

This endpoint is disabled as soon as a super-admin exists.

---

## Step 5 — Set your Worker URL in the front-end files

In **both** `app/index.html` and `admin/index.html`, find the line:
```js
const API_BASE = "https://stt-platform.YOUR-ACCOUNT.workers.dev/api";
```
Replace with your real Worker URL.

---

## Step 6 — Set the Google Drive folder IDs in app/index.html

In `app/index.html`, find the `DRIVE` object and paste your real folder IDs:
```js
const DRIVE = {
  main:     "19OBQpJhmJ0RMeCJRXh7s3r9yZpr720ce",  // your real IDs
  demo:     "...",
  deleted:  "...",
  rejected: "...",
  trash:    "...",
  ...
};
```

---

## Step 7 — Deploy the user app to Cloudflare Pages

Go to https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Upload assets**.
Upload the `app/` folder (just `index.html`).
Name it e.g. `stt-app`. You get `https://stt-app.pages.dev`.

---

## Step 8 — Deploy the dashboard to Cloudflare Pages

Same thing for `admin/index.html`.
Name it e.g. `stt-admin`. You get `https://stt-admin.pages.dev`.

---

## Step 9 — Fix CORS

Open `worker/wrangler.toml`, change:
```toml
ALLOWED_ORIGINS = "https://stt-app.pages.dev,https://stt-admin.pages.dev"
```
Then redeploy the Worker:
```
cd worker && wrangler deploy
```

---

## Step 10 — Enter your secrets from the dashboard

1. Open `https://stt-admin.pages.dev`, log in as Super-Admin.
2. Go to **Clés secrètes**.
3. Enter your Google Client ID, Client Secret, and Refresh Token.
4. Enter your AssemblyAI key.
5. Enter the same Drive folder IDs as in Step 6 (these go into D1 so the Worker can use them for file moves).

---

## Step 11 — Google OAuth: avoid 7-day token expiry

In Google Cloud Console → **APIs & Services → OAuth consent screen**:
- Set **Publishing status → In production**.
- After publishing, generate a **new refresh token** — the old one (minted while in Testing) keeps its 7-day clock.

---

## Done

- User app: `https://stt-app.pages.dev`
- Dashboard: `https://stt-admin.pages.dev`
- Worker API: `https://stt-platform.<account>.workers.dev/api`

Everything is free tier. No credit card required.
