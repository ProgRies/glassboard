# Glassboard · self-hosted

A quiet whiteboard for a shared company workspace. Same glass UI, infinite canvas, touch and mouse controls, image paste/drop, notes, shapes, undo/redo and PNG export. No accounts. No OpenAI, Cloudflare, external APIs, database server, analytics or external fonts. One locked runtime dependency (`ws`) handles WebSockets.

## Run the published Docker image

After the first release is published, pull the prebuilt image:

```sh
docker run -d --name glassboard --restart unless-stopped --init \
  -p 3000:3000 -v glassboard-data:/app/data \
  ghcr.io/progries/glassboard:1.1.0
```

Or use `docker compose -f compose.ghcr.yaml up -d` from a source checkout. The registry image includes **linux/amd64** and **linux/arm64** (including Apple Silicon servers).

Open **http://localhost:3000** on the server, or **http://YOUR-SERVER-IP:3000** from another computer or touchscreen. Everyone uses the same board library. Boards and images are retained in the `glassboard-data` volume across restarts and updates. Never remove that volume unless you intend to delete your data.

GitHub Container Registry packages can initially be private. The repository owner should set this package to **Public** in its package settings to allow pulling without a registry login. Application users never need accounts.

## Behind an existing Traefik

Use [`compose.traefik.yaml`](compose.traefik.yaml) and copy [`.env.example`](.env.example) to `.env`. Set `GLASSBOARD_HOST`, then run:

```sh
docker compose pull && docker compose up -d
```

The `.env` selects the Traefik Compose file, which publishes no host port and uses your existing `reverse-proxy` network. See [the deployment guide](docs/deployment-traefik.md) for your `web-secure`, `letsencrypt` and `default@file` configuration. Glassboard uses **one service**; no Laravel queue, scheduler or Reverb is needed.

## Build with Docker yourself

From this folder:

```sh
docker compose up -d --build
```

Ordinary `docker compose down` keeps the data volume; `docker compose down -v` removes it.

## Download an image without a registry account

Each release includes a source ZIP, checksums, and a **linux/amd64 Docker image archive**. From the release download directory:

```sh
sha256sum -c SHA256SUMS.txt
gunzip -c glassboard-1.1.0-linux-amd64.docker.tar.gz | docker load
docker run -d --name glassboard --restart unless-stopped --init \
  -p 3000:3000 -v glassboard-data:/app/data glassboard:1.1.0
```

## Start without Docker

Install Node.js 22 or newer (Node 24 recommended), then:

```sh
npm ci --omit=dev --ignore-scripts
node server.mjs
```

Install the locked dependency once; there is no frontend build step. Open **http://localhost:3000**. By default it listens on all interfaces on port 3000 and writes to `data/` next to `server.mjs`.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` next to server | Persistent board/image directory |

Example:

```sh
DATA_DIR=/srv/glassboard-data PORT=8080 node server.mjs
```

## Working together

- Everyone can create, view, edit and delete boards. No sign-in or application-level roles.
- Different boards work independently. Edits to different objects on the same board merge automatically. Strokes, dragging, text previews and collaborator cursors stream through WebSockets while you work; completed changes push immediately.
- Your zoom and pan stay local to your browser. Other people do not move your camera.
- If two people change the **same object** or rename the same board differently, the second conflicting edit is saved as a separate **“(recovered)” board**. A dialog tells that person what happened. The original retains the first saved edit.
- A changed board cannot be deleted from an outdated board list. The list refreshes and asks you to try again.
- Undo applies to your local editing history. Remote additions are retained. Undo entries that conflict with a colleague’s edit are discarded so undo cannot erase that edit.
- Live previews are batched at up to 30 updates per second, with incremental stroke segments rather than repeated full strokes. The small “Live” indicator shows the number of connected screens. Durable saves happen shortly after a gesture or text edit finishes; conflicting saved edits are still protected. Latency depends on your network.

## Realtime transport

`/api/live` shares the existing HTTP server and port 3000. No additional container, port, Reverb, Redis or WebSocket service is needed. While the WebSocket is connected there is no periodic board polling. Committed updates use object deltas; drawing packets carry only new points. Heartbeats detect dead connections, reconnect uses exponential backoff, and revision checks resynchronize after a disconnect. Slow connections have bounded send queues. If WebSockets are unavailable, a two-second HTTP polling fallback keeps saved boards usable; the indicator shows “Reconnecting…”.

Live previews are temporary. A disconnected unfinished gesture can disappear from other screens until its owner finishes and saves it. Existing boards and images need no migration. After updating the server, **reload all open browser tabs** to activate the new client.

## Saving and recovery

Saved boards are individual JSON files in `data/boards/`; images are files in `data/assets/`. Saves use atomic replacement and synchronize file writes before replacing the previous version. Concurrent writes are serialized per board inside one server process.

A save failure shows **“Retry save”**. Click it to try again; reconnecting also retries. Unsaved edits have a browser recovery copy and are checked against current server data when reopened. Do not clear browser storage before unsaved work is saved. Images must finish uploading before they appear on the canvas; a failed image upload needs to be retried. Uploads are limited to 15 MB per PNG/JPEG/WebP/GIF; each board is limited to 8 MB of JSON.

Run **one server process/container per data directory**. Do not run multiple replicas against the same directory. Keep data on a reliable local filesystem rather than an NFS/network share.

## Company hosting

Anyone who can reach the server can access and change everything. Put it on your company LAN/VPN, or behind your existing reverse proxy/access control if exposing it outside that network. The app itself has no accounts. HTTPS through your existing proxy is supported; ordinary LAN HTTP also works for drawing, pasting images and UUID creation. Fullscreen availability depends on the browser.

A reverse proxy should pass the original `Host` header, allow up to 18 MB request bodies, and forward `/` and `/api/` to the same instance. WebSocket upgrades on `/api/live` must be allowed; HTTPS clients use `wss://` on the same hostname and port. Serve from a dedicated hostname or at the root of an IP/port, not a URL subdirectory. `/api/health` is a small health endpoint.

## Backup and restore

Stop the server/container, copy the **entire data directory** (boards and assets), then start it again. Restore those files into the same directory with permissions allowing the service user to read/write. With Docker, the named volume holds this directory. Keep backups outside the running container.

Unreferenced images are deliberately retained after object/board deletion so a concurrent editor’s recovered board never loses its images. Include them in backups; there is no automatic cleanup.

The package contains application source and starts with an empty shared library. Boards saved in the original hosted Sites app are not included. The existing hosted site is unchanged.

## Verification

```sh
npm ci --ignore-scripts
node --test test/*.test.mjs
```

Tests exercise actual WebSocket connections, live browser-controller emulation, HTTP requests, parallel edits, conflict preservation, guarded deletion, image persistence, restart recovery, client synchronization and undo merging. Tests use the same locked WebSocket library as the server. The CI and release workflows build the Docker image and test its HTTP startup, non-root runtime, and board/image persistence across a restart. Actual touchscreen/browser rendering is not covered by these automated checks.

## Publishing a release (maintainers)

1. Update `package.json` version, `CHANGELOG.md`, `compose.ghcr.yaml`, and version references in the README.
2. Add release notes at `releases/vMAJOR.MINOR.PATCH.md`.
3. Merge to `main`. Changes to version/release configuration automatically publish an unpublished package version after testing; existing published versions are skipped.
4. Alternatively, create and push an annotated tag matching `package.json`:

```sh
git tag -a v1.1.0 -m "Glassboard 1.1.0"
git push origin v1.1.0
```

The release workflow verifies the version, runs tests, smoke-tests an amd64 image, builds/pushes the multi-platform image, creates or verifies the annotated version tag, creates checksummed download assets and publishes the GitHub Release. It uses the repository's built-in `GITHUB_TOKEN`; no registry password or extra secret is required. Repository policy must allow GitHub Actions to write repository contents and packages.

If publication fails after creating a draft release, rerun the failed workflow. Already published releases are protected against asset replacement. Image tags `1.1.0` and `latest` are created for this release; deployments should pin a version or the digest in `container-digest.txt`.

No open-source license has been selected. `UNLICENSED` records this rather than assigning a license on the owner's behalf.
