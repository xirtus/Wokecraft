# Celandia: Xirtoth — Running & Hosting Guide (Native, VPS & Flux Orbit)

## 1. Rebuilding the Celandia World & Asset Corpus (`WoW/Data/`)

All Celandia and sister-project assets (`Reincarnation`, `Valley Girl of Death`, `Tekkajem`) are owned by **XIRTUS** and compiled into a standalone loose-file `WoW/Data/` directory by:

```bash
node scripts/build-celandia-data.mjs
```

This generates:
- **Terrain (`WDT` + `ADT`)**: 4×4 `ADT` tiles (`30..=33, 30..=33`) under `WoW/Data/World/Maps/Celandia/` (plus `Azeroth` and `Kalimdor` aliases), sampled directly from Celandia's `atlas.js` heightfield and placed with Celandia architecture, ring arches, spire crystals, and biome trees.
- **Rigged & Animated `.glb` Characters (`Creature\Celandia\*\*.m2`)**: 14 Celandia cast heroes with a 21-bone humanoid skeleton and 10 procedural animation sequences (`Stand`, `Death`, `Walk`, `Run`, `AttackUnarmed`, `ParryUnarmed`, `Jump`, `Swim`, `SpellCastDirected`, `SpellCastOmni`), plus Celandia fauna/bosses and sister-project enemies.
- **Textures & Minimap (`BLP2`)**: 5 terrain tilesets, 15 spell/weapon icons, 16 top-down 256×256 minimap tiles + `md5translate.trs`, and UI minimap arrows/icons.
- **Database Tables (`DBFilesClient\*.dbc`)**: Complete `WDBC` tables for maps, zones, creatures, classes, races, items, spells, lighting, factions, and pickup gameobjects.

---

## 2. Running Locally (macOS / Linux / Windows Desktop)

### Survivors Mode (5 Celandia Arenas, 9 Classes, 30-Minute Runs)
```bash
cargo run --release -p benilla-app --bin warcraft-survivors -- --data WoW/Data
```

### Client-Server RPG / World Explorer Mode
```bash
# Offline / Sandbox World Exploration at the Porcelain Court:
cargo run --release -p benilla-app --bin benilla -- --data WoW/Data --pos 0,0,5 --map 0

# Connect to a Live Realm Server (Self-Hosted VPS or Flux Orbit):
cargo run --release -p benilla-app --bin benilla -- --data WoW/Data --auth <VPS_IP>:3724
```

---

## 3. Self-Hosted VPS Deployment (Recommended for Authoritative MMO World)

A single 4-vCPU / 8-GB RAM VPS can host both the authoritative RPG/MMO world server (`3724` Auth + `8085` World) and `wenilla-host` (`8090` WebGPU browser client + `/data` asset server + `/ws` proxy) for 300–800 concurrent players with sub-millisecond local database writes:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

---

## 4. Flux Orbit Deployment (`https://runonflux.com/apps/orbit`)

Use [`deploy/flux-orbit-spec.json`](./flux-orbit-spec.json) to deploy on Flux Orbit:
1. Build and push the container image:
   ```bash
   docker build -f deploy/Dockerfile -t ghcr.io/j3games/xirtoth-celandia-host:latest .
   docker push ghcr.io/j3games/xirtoth-celandia-host:latest
   ```
2. Open [Flux Orbit](https://runonflux.com/apps/orbit), import `deploy/flux-orbit-spec.json`, set your `owner` ZelID, and launch.
   - **Co-op Survivors / Asset Edge CDN**: Set `"instances": 3` (or higher) to geo-distribute `wenilla-host` across North America, Europe, and Asia.
   - **Stateful MMO Realm**: Either point `UPSTREAM_HOST` at your primary VPS IP (Hybrid Edge + Core VPS), or set `"instances": 1` with `"staticip": true` so all players enter the same authoritative world instance.
