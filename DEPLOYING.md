# DEPLOYING.md — deploy runbook

One page: how each of the three surfaces (Pages site, Worker, Pi) gets updated,
and the cache gotcha that already cost one redeploy. Architecture + gotcha
background: `CLAUDE.md`. Worker reference: `worker/README.md`.

## Pages (the collage site)

```sh
bash avian/build-site.sh        # assembles _site/ (content-hashes shell assets,
                                # signatures.json + song-clip URLs, art-manifest.json)
npx wrangler pages deploy _site --project-name avianvisitors --branch avian-visitors
```

- `avian-visitors` IS the project's Production branch → feeds
  `birds-origin.indianridgeroad.com` → served publicly at `indianridgeroad.com/birds/`.
- **NEVER deploy to the `barrysbirds` project or with `--branch production`** —
  `barrysbirds` is only a static 301 stub for legacy links (deploying the real
  site there makes the ridge proxy chase its redirect in a loop), and a
  `--branch production` deploy lands on a preview URL the domain never sees.

### THE cache gotcha (cost a redeploy 2026-07-06)

After a Pages deploy, **verify via the `avianvisitors.pages.dev` ORIGIN first.**
Do NOT curl new `?v=<hash>` asset URLs through the `indianridgeroad.com` proxy
during the ~1-min production-alias flip: the proxy caches whatever origin
returns for **24 h**, so probing a new URL before the alias flips cache-poisons
it with the OLD bytes. Only hit the proxy once the origin shows the new build.

## Worker (`avian-worker`)

```sh
cd worker
npm run migrate:remote   # apply any new migrations FIRST — always before the code deploy
npx wrangler deploy
```

Secrets (`AVIAN_INGEST_SECRET`, `FRAME_KEY`) are already set via
`wrangler secret put`; vars live in `worker/wrangler.toml [vars]`.

## Pi (anything under `pi/` or `frame/`)

The box pulls this repo; nothing is copied by hand:

```sh
git push origin avian-visitors
ssh bird-pi 'bash ~/BirdNET-Pi/pi/update.sh'   # git pull + re-sync units + restart
```

## Health checks (after any deploy)

```sh
curl https://avian-worker.s-friedman.workers.dev/api/status   # 200 = Pi heartbeat fresh; 503 = box silent
cd worker && npx wrangler d1 info avian-detections            # rows_read_24h should be LOW MILLIONS;
                                                              # 9 digits = a query is full-scanning again
```

Site: load `https://avianvisitors.pages.dev` (origin), then
`https://indianridgeroad.com/birds/` once the alias has flipped.
