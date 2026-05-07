# Deploy FitAI Planner

This app is set up for Render because it needs a writable disk for `users.json` and `user-data.json`.

## What was added

- `render.yaml` creates a Node web service with a persistent disk mounted at `/var/data`
- `.node-version` pins Node.js to `22.22.0`
- `server.js` now supports `DATA_DIR`, a health endpoint at `/healthz`, and signed cookies that survive restarts

## Deploy on Render

1. Push this repo to GitHub.
2. In Render, create a new Blueprint and select this repository.
3. Render will read `render.yaml` and create the web service.
4. When prompted, set `OPENROUTER_API_KEY`.
5. After the deploy finishes, open the generated `onrender.com` URL.

## Important notes

- Render's filesystem is ephemeral by default, so this app needs the attached disk in `render.yaml`.
- The Blueprint uses the `starter` plan because Render persistent disks require a paid web service.
- Your local `.env` should stay local only. A tracked `.env` or committed API key should be rotated and removed from Git history if the repo is public.
- This repo currently tracks `.env` and `data/*.json`. To stop tracking them in the next commit while keeping the local files, run:

```bash
git rm --cached .env data/users.json data/user-data.json
```
