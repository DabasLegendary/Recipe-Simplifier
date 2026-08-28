# Recipe Matrix — Backend

A small Node/Express server that:
- Serves the Recipe Matrix frontend (`public/index.html`)
- Holds your Anthropic API key server-side and proxies requests to it, so the key is never exposed in the browser
- Fetches recipe URLs server-side too, which avoids the CORS errors the browser-only version ran into

## 1. Run it locally

```bash
cd recipe-matrix-backend
npm install
cp .env.example .env
```

Open `.env` and paste in your real key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then start it:

```bash
npm start
```

Visit **http://localhost:3000** — the app should load and the demo recipe should render. Try uploading a real recipe photo or pasting text to confirm the API call works end-to-end.

## 2. Deploy it for real (so anyone can use it)

Any Node host works. **Render's free tier** is the easiest starting point:

1. Push this folder to a GitHub repo (the `.gitignore` already keeps `.env` and `node_modules` out of it — never commit your real key).
2. Go to [render.com](https://render.com) → **New** → **Web Service** → connect your repo.
3. Set:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Under **Environment**, add an environment variable:
   - `ANTHROPIC_API_KEY` = your real key
5. Deploy. Render gives you a live URL like `https://recipe-matrix.onrender.com` — that's your whole site, frontend and backend together.

Railway and Fly.io work the same way — install command, start command, one environment variable.

## 3. Notes

- **Never** put your API key in `public/index.html` or anywhere in frontend code — that file is sent to every visitor's browser and the key would be visible in seconds via "View Source."
- The free tiers of most hosts spin down when idle and take a few seconds to wake back up on the first request after a while — normal, not a bug.
- Consider setting a spending limit in the Anthropic Console (Settings → Billing) so a spike in traffic can't run up a surprise bill.
- If you want to restrict who can use it, add a simple shared password check or rate limiter to `/api/build-matrix` in `server.js` before making the URL public.
