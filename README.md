# Android Emulator Dashboard

A self-hosted web dashboard for launching and managing Android emulators via Docker. Built with Node.js + Express on the backend and vanilla JS on the frontend. Emulators run inside [`budtmo/docker-android`](https://github.com/budtmo/docker-android) containers and expose a noVNC browser interface.

## Features

- Launch Android emulators (API 28–34) from the browser
- Live pull progress when downloading an image for the first time
- Real-time boot status — pulsing dot while Android is booting, solid green when ready
- Live log panel streaming Docker container output
- Device picker (Nexus 5, Nexus 5X, Nexus 6P, Pixel 2/3a/4)
- Persistent emulator data via named Docker volumes — installed apps survive container restarts
- Restart stopped emulators without re-pulling the image
- Stop All button
- Images pre-pulled in the background on dashboard startup

## Requirements

- Docker with `/dev/kvm` available on the host (hardware virtualisation)
- Docker Compose v2
- KVM-enabled Linux host (bare metal or VM with nested virtualisation enabled)

## Quick Start

```bash
cp .env.example .env
# edit .env — set HOST_IP to the IP your browser will reach the server on
docker compose up -d
```

Dashboard is available at `http://<HOST_IP>:3000`.

## Configuration

All config is via environment variables (set in `.env` or in Coolify/your deploy platform):

| Variable | Default | Description |
|---|---|---|
| `HOST_IP` | `localhost` | IP address used to build VNC and ADB URLs. **Must be set to your server's IP.** |
| `NOVNC_PORT_START` | `6080` | First noVNC port. Emulator N uses `NOVNC_PORT_START + N`. |
| `ADB_PORT_START` | `5554` | First ADB port. Emulator N uses `ADB_PORT_START + N*2`. |
| `MAX_EMULATORS` | `5` | Maximum number of simultaneous emulators. |

## Port Layout

| Purpose | Ports |
|---|---|
| Dashboard UI | `3000` |
| noVNC (browser → emulator) | `6080` – `6084` |
| ADB | `5554`, `5556`, `5558`, `5560`, `5562` |

Make sure these are open in your firewall if accessing remotely.

## Project Structure

```
.
├── Dockerfile               # Dashboard container (node:20-alpine)
├── docker-compose.yml       # Compose service definition + healthcheck
├── .env.example             # Environment variable template
└── dashboard/
    ├── server.js            # Express API + Docker management
    ├── package.json
    └── public/
        ├── index.html       # UI (single page, inline CSS)
        └── app.js           # Frontend logic
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/versions` | List available Android versions |
| `GET` | `/api/devices` | List available device types |
| `GET` | `/api/emulators` | List all running/stopped emulators |
| `POST` | `/api/emulators` | Launch a new emulator (returns `202` + `jobId`) |
| `GET` | `/api/emulators/launch-progress/:jobId` | SSE stream of pull + start progress |
| `GET` | `/api/emulators/:id/status` | Boot status (`booting` / `booted` / `exited`) |
| `GET` | `/api/emulators/:id/logs` | SSE stream of container logs |
| `POST` | `/api/emulators/:id/start` | Restart a stopped emulator |
| `DELETE` | `/api/emulators/:id` | Stop, remove container and its data volume |

## Data Persistence

Each emulator gets a named Docker volume (`android-avd-<container-name>`) mounted at `/home/androidusr` inside the container. This persists the AVD configuration and any installed apps across restarts.

The volume is deleted when the emulator is explicitly removed (stop button). Use the restart button (▶) to keep data intact.

Docker images are cached by the host Docker daemon and survive dashboard redeploys.

## Deploying on Coolify

1. Point Coolify at this repo, build from `docker-compose.yml`
2. Set `HOST_IP` to your server's LAN/public IP in Coolify's Environment Variables
3. Ensure `/dev/kvm` exists on the host — Coolify must run on a KVM-capable machine
4. Deploy — images will be pre-pulled in the background on first start

## Supported Android Versions

| API Level | Android Version | Image |
|---|---|---|
| 34 | Android 14 | `budtmo/docker-android:emulator_14.0` |
| 33 | Android 13 | `budtmo/docker-android:emulator_13.0` |
| 31 | Android 12 | `budtmo/docker-android:emulator_12.0` |
| 30 | Android 11 | `budtmo/docker-android:emulator_11.0` |
| 29 | Android 10 | `budtmo/docker-android:emulator_10.0` |
| 28 | Android 9  | `budtmo/docker-android:emulator_9.0`  |
