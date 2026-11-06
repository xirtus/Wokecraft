# Wokecraft NoW — Celandia & The Elsewhere

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-f59ab8.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Repository](https://img.shields.io/badge/GitHub-xirtus%2FWokecraft-8fd6f0)](https://github.com/xirtus/Wokecraft)

**Wokecraft NoW** is an open-source, copyleft (**GNU GPLv3**) 3D fantasy RPG/MMO and Co-Op Survivors engine owned by **XIRTUS**, built in Rust and Bevy (`0.18`), and set in the floating porcelain archipelagos of **Celandia & The Elsewhere** — where the **Porcelain Court** and the **Nocturnum Accord** clash across the shimmering Elsewhere Tide.

Every 3D character rig, creature, WMO citadel, multi-layer terrain ADT tile, DBC database table, BLP2 UI chrome texture, procedural audio stem, and open-source font in `WoW/Data/` is **100% original, owned by XIRTUS, and procedurally generated** via [`scripts/build-celandia-data.mjs`](scripts/build-celandia-data.mjs) — requiring **zero proprietary third-party game assets**.

---

## Highlights & Game Modes

### 1. Wokecraft NoW — Survivors Mode (Solo & 2–8 Player Multiplayer Co-Op)
An action-packed 3D horde-survival mode set across five bespoke Celandia arenas (**Porcelain Court**, **Ribbon Spires**, **Glasswake Shoals**, **Frostbell Reach**, and **Nocturnum Keep**):
- **14 Playable Celandia Cast Heroes** across **Porcelain** and **Nocturnum** lineages with 21-bone skeletal rigs, procedural combat & spell animations, weapons, and shields.
- **2–8 Player Lockstep & Snapshot Multiplayer Co-Op**:
  - **Native UDP Co-Op (`:8091`)**: Host or join low-latency peer/authority sessions directly from the character selection screen (`Press C to cycle Solo / Host / Join`) or via CLI flags (`--coop-host`, `--coop-join <ip:port>`).
  - **Browser WebSocket Co-Op (`/ws/survivors/{room}`)**: Built-in WebSocket room relay inside [`wenilla-host`](crates/wenilla-host/src/main.rs) so browser and native players can party up seamlessly.
  - **Full Co-Op HUD & Revive Mechanics**: Live 8-player party vitals panel, 3D floating ally nameplates, shared XP/wave progression, and in-world ally revival rings.

### 2. Wokecraft NoW — Full 3D RPG / MMO Mode
A complete standalone 3D RPG/MMO client and authoritative server stack:
- **Native Rust `celandia-server`** ([`crates/celandia-server`](crates/celandia-server)): Zero-C++, self-contained SRP6 Auth Server (`:3724`) and authoritative World Server (`:8085`) with SQLite persistence (`--db`), live multiplayer movement & chat broadcast, NPC & creature spawns across all Celandia zones, interactive quests, vendor/loot tables, and spell casting.
- **Native TCP→WebSocket Proxy & Web Gateway** ([`crates/wenilla-host`](crates/wenilla-host)): Serves the WebAssembly/WebGPU browser client, streams `WoW/Data/` over HTTP Range requests, bridges browser WebSockets (`/ws/auth`, `/ws/world`) directly to `:3724` and `:8085`, and hosts Co-Op Survivors rooms (`/ws/survivors/{room}`).

---

## Quick Start

### 1. Build the 100% Custom Celandia Asset Corpus (`WoW/Data/`)
Generate all terrain tiles, rigged `.glb`/`.m2` characters and creatures, WMO citadels, DBC tables, BLP2 UI chrome, procedural audio, and fonts:

```bash
node scripts/build-celandia-data.mjs
```

### 2. Play Wokecraft NoW — Survivors (Native Desktop)
```bash
# Launch Solo Survivors (or toggle Co-Op in-game with [C]):
cargo run --release -p benilla --bin warcraft-survivors

# Host a 2-8 player UDP Co-Op session on 0.0.0.0:8091:
cargo run --release -p benilla --bin warcraft-survivors -- --coop-host 0.0.0.0:8091

# Join a Co-Op host:
cargo run --release -p benilla --bin warcraft-survivors -- --coop-join 127.0.0.1:8091
```

### 3. Play Wokecraft NoW — Full RPG / MMO Mode (Native Server + Desktop Client)
Start the self-contained Rust auth + world server in one terminal:
```bash
cargo run --release -p celandia-server -- --db celandia-characters.sqlite
```
Then launch the Wokecraft NoW RPG client in a second terminal (default login: `PLAY` / `PLAY`):
```bash
cargo run --release -p benilla --bin benilla
```

### 4. Play in the Browser (WASM + WebGPU/WebGL2 via `wenilla-host`)
```bash
cargo run --release -p wenilla-host -- --port 8080
```
Open `http://127.0.0.1:8080` for the RPG client or `http://127.0.0.1:8080/?mode=survivors&coop=join&room=default` for Multiplayer Co-Op Survivors.

---

## Self-Hosted VPS & Flux Orbit Deployment

Production Docker & Flux Orbit deployment manifests are included in [`deploy/`](deploy/):
- [`deploy/Dockerfile.orbit`](deploy/Dockerfile.orbit) & [`deploy/flux-orbit-spec.json`](deploy/flux-orbit-spec.json): Single-container multi-service image running `celandia-server` (`:3724` / `:8085`) + `wenilla-host` (`:8080` Web & Co-Op WebSocket gateway).
- [`deploy/docker-compose.yml`](deploy/docker-compose.yml): Multi-container compose stack with persistent volumes and optional SQL world seed ([`deploy/celandia-world.sql`](deploy/celandia-world.sql)).

---

## Workspace Architecture

| Crate / Directory | Description |
| :--- | :--- |
| [`crates/benilla-app`](crates/benilla-app) | Core Wokecraft NoW client & Survivors engine (Bevy 0.18, custom terrain/WMO/M2-glTF pipelines, Glue screens, RPG HUD, and 2–8 player Co-Op Survivors). |
| [`crates/benilla-formats`](crates/benilla-formats) | Pure-Rust parsers for ADT, WDT, WMO, M2/glTF, BLP2, WDBC, MPQ, and WTF formats. |
| [`crates/benilla-net`](crates/benilla-net) | SRP6 authentication and world packet framing over native TCP or browser WebSockets. |
| [`crates/celandia-server`](crates/celandia-server) | Standalone authoritative Rust RPG/MMO Auth (`:3724`) & World (`:8085`) server with SQLite persistence. |
| [`crates/wenilla-host`](crates/wenilla-host) | HTTP Range asset server, TCP↔WebSocket MMO bridge, and multiplayer Co-Op Survivors WebSocket room relay. |
| [`scripts/`](scripts) | Procedural Celandia world, character rig, WMO citadel, UI chrome, audio, and DBC generators. |

---

## Upstream Attribution & License

**Wokecraft NoW** ([`https://github.com/xirtus/Wokecraft`](https://github.com/xirtus/Wokecraft)) is a fork and total-conversion expansion of [**`azeroth-survivors-re`**](https://github.com/outthislife/azeroth-survivors-re) originally created by **sam** (`outthislife`). We gratefully acknowledge and credit [`outthislife/azeroth-survivors-re`](https://github.com/outthislife/azeroth-survivors-re) for the foundational clean-room Rust/Bevy client architecture and format parsers.

This project is free software released under the **GNU General Public License v3.0 or later (`GPL-3.0-or-later`)**. See [`LICENSE`](LICENSE) for the full license text.
