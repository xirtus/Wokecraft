/**
 * Build Celandia RPG Mode UI Chrome, Painted World Map Art (`M` Key), Loading Screens,
 * Default Keybindings (`WTF/DefaultBindings.wtf`), and UI Catalog DBCs (`WorldMap*.dbc`,
 * `LoadingScreens.dbc`, `ItemClass.dbc`, `AuctionHouse.dbc`).
 *
 * Exports `buildCelandiaUi(writeFile, WdbcBuilder, f32, createBlp2, sampleHeight, BIOMES)`
 * to be called by `scripts/build-celandia-data.mjs`.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CELANDIA_DIR = '/Users/xmacbookm5/Projects/j3games/Celandia';
const atlas = await import(
  pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/world/atlas.js')).href
);

// ============================================================================
// Coordinate & Biome Helpers for Painted Celandia Cartography
// ============================================================================

const CONTINENT_BOUNDS = {
  locLeft: 1066.6666,
  locRight: -1066.6666,
  locTop: 1066.6666,
  locBottom: -1066.6666,
};

/**
 * The 5 Celandia Island Kingdoms in `AreaTable.dbc` (IDs 1..5) and `WorldMapArea.dbc` (IDs 2..6).
 * Note: WoW world coordinates `(wx, wy)` map to Celandia `atlas.js` coordinates via:
 *   `cx = -wy` (East)
 *   `cz = -wx` (South)
 * Therefore `locLeft > locRight` (`wy` West to East) and `locTop > locBottom` (`wx` North to South).
 */
export const CELANDIA_WORLD_MAP_ZONES = [
  {
    worldMapAreaId: 2,
    areaId: 1,
    areaName: 'PorcelainWake',
    title: 'The Porcelain Wake',
    locLeft: 450.0,
    locRight: -450.0,
    locTop: 480.0,
    locBottom: -280.0,
    cx: 0.0,
    cz: -110.0,
    tint: [144, 186, 112],
    hi: [242, 234, 224],
    accent: [245, 154, 184],
  },
  {
    worldMapAreaId: 3,
    areaId: 2,
    areaName: 'FrostbellLagoon',
    title: 'Frostbell Lagoon',
    locLeft: 760.0,
    locRight: 180.0,
    locTop: 700.0,
    locBottom: 160.0,
    cx: -470.0,
    cz: -430.0,
    tint: [204, 228, 250],
    hi: [248, 252, 255],
    accent: [142, 218, 255],
  },
  {
    worldMapAreaId: 4,
    areaId: 3,
    areaName: 'GlasswakeMesas',
    title: 'Glasswake Mesas',
    locLeft: -200.0,
    locRight: -760.0,
    locTop: 220.0,
    locBottom: -300.0,
    cx: 480.0,
    cz: 40.0,
    tint: [228, 178, 134],
    hi: [112, 224, 216],
    accent: [90, 216, 208],
  },
  {
    worldMapAreaId: 5,
    areaId: 4,
    areaName: 'AureateReach',
    title: 'The Aureate Reach',
    locLeft: -80.0,
    locRight: -580.0,
    locTop: 740.0,
    locBottom: 260.0,
    cx: 330.0,
    cz: -500.0,
    tint: [224, 188, 106],
    hi: [252, 238, 184],
    accent: [255, 214, 92],
  },
  {
    worldMapAreaId: 6,
    areaId: 5,
    areaName: 'NocturnumIsle',
    title: 'Nocturnum Obsidian Isle',
    locLeft: 580.0,
    locRight: 140.0,
    locTop: -120.0,
    locBottom: -520.0,
    cx: -360.0,
    cz: 320.0,
    tint: [86, 66, 118],
    hi: [158, 114, 210],
    accent: [198, 108, 255],
  },
];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function classifyZoneAt(wx, wy) {
  const cx = -wy;
  const cz = -wx;
  const dNoc = Math.hypot(cx - atlas.NOCTURNUM_ISLE.x, cz - atlas.NOCTURNUM_ISLE.z);
  if (dNoc < atlas.NOCTURNUM_ISLE.rx * 1.3) {
    return CELANDIA_WORLD_MAP_ZONES[4]; // NocturnumIsle (areaId = 5)
  }
  const bw = atlas.biomeWeights(cx, cz);
  if (bw.frost >= bw.wake && bw.frost >= bw.glass && bw.frost >= bw.aureate && bw.frost > 0.22) {
    return CELANDIA_WORLD_MAP_ZONES[1]; // FrostbellLagoon (areaId = 2)
  }
  if (bw.glass >= bw.wake && bw.glass >= bw.aureate && bw.glass > 0.22) {
    return CELANDIA_WORLD_MAP_ZONES[2]; // GlasswakeMesas (areaId = 3)
  }
  if (bw.aureate >= bw.wake && bw.aureate > 0.22) {
    return CELANDIA_WORLD_MAP_ZONES[3]; // AureateReach (areaId = 4)
  }
  return CELANDIA_WORLD_MAP_ZONES[0]; // PorcelainWake (areaId = 1)
}

/**
 * Distance from point `(cx, cz)` to segment `(ax, az) -> (bx, bz)` in Celandia atlas coords.
 */
function distToSegment(cx, cz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) return Math.hypot(cx - ax, cz - az);
  const t = clamp(((cx - ax) * dx + (cz - az) * dz) / lenSq, 0, 1);
  return Math.hypot(cx - (ax + t * dx), cz - (az + t * dz));
}

// ============================================================================
// 1. Painted World Map Canvas (`1002x668` sliced into `4x3` 256x256 BLP2 tiles)
// ============================================================================

const MAP_CANVAS_W = 1002;
const MAP_CANVAS_H = 668;
const TILE_DIM = 256;

const SKY_BRIDGES = [
  [0, -110, -470, -430], // Porcelain Wake <-> Frostbell Lagoon
  [0, -110, 330, -500],  // Porcelain Wake <-> Aureate Reach
  [0, -110, 480, 40],    // Porcelain Wake <-> Glasswake Mesas
  [0, -110, -360, 320],  // Porcelain Wake <-> Nocturnum Isle
  [330, -500, 480, 40],  // Aureate Reach <-> Glasswake Mesas
];

/**
 * Render a full `1002x668` RGBA buffer of the Celandia world or zone map, then slice
 * it into `4x3 = 12` `256x256` BLP2 tiles (`<prefix>1.blp` .. `<prefix>12.blp`).
 */
function renderAndSliceWorldMapTiles(writeFile, createBlp2, folderName, filePrefix, bounds, focusAreaId = 0) {
  const rgba = new Uint8Array(MAP_CANVAS_W * MAP_CANVAS_H * 4);
  const spanY = bounds.locLeft - bounds.locRight;
  const spanX = bounds.locTop - bounds.locBottom;
  const stepY = spanY / MAP_CANVAS_W;
  const stepX = spanX / MAP_CANVAS_H;

  for (let py = 0; py < MAP_CANVAS_H; py++) {
    const v = (py + 0.5) / MAP_CANVAS_H;
    const wx = bounds.locTop - v * spanX;
    const cz = -wx;

    for (let px = 0; px < MAP_CANVAS_W; px++) {
      const u = (px + 0.5) / MAP_CANVAS_W;
      const wy = bounds.locLeft - u * spanY;
      const cx = -wy;

      const idx = (py * MAP_CANVAS_W + px) * 4;

      // Ornate porcelain-and-gilt outer parchment frame (14px wide)
      const edgeDist = Math.min(px, py, MAP_CANVAS_W - 1 - px, MAP_CANVAS_H - 1 - py);
      if (edgeDist < 14) {
        if (edgeDist < 3 || (edgeDist >= 10 && edgeDist <= 12)) {
          // Rose-gold / antique gilt border trim
          rgba[idx + 0] = 228;
          rgba[idx + 1] = 188;
          rgba[idx + 2] = 112;
          rgba[idx + 3] = 255;
        } else {
          // Deep twilight indigo enamel inset
          rgba[idx + 0] = 36;
          rgba[idx + 1] = 28;
          rgba[idx + 2] = 54;
          rgba[idx + 3] = 255;
        }
        continue;
      }

      const h = atlas.height(cx, cz);
      const grain = (hash2(px * 0.7, py * 0.7) - 0.5) * 8.0;

      let r = 0;
      let g = 0;
      let b = 0;

      if (h < atlas.SEA) {
        // Elsewhere Tide ocean cartography: bathymetric rings + parchment wave hatching
        const depth = clamp((atlas.SEA - h) / 7.5, 0.0, 1.0);
        const shelf = Math.exp(-depth * 3.2);
        const waveHatch = Math.sin(cx * 0.045 + Math.cos(cz * 0.04) * 1.8) * 0.5 + 0.5;
        const contourRing = Math.abs(((atlas.SEA - h) * 1.6) % 1.0 - 0.5) < 0.06 ? 1.0 : 0.0;

        // Blend from luminous turquoise-pearl shoals to deep cerulean-indigo abyssal parchment
        r = lerp(108, 34, depth) + shelf * 46 + waveHatch * 6 + contourRing * 18 + grain * 0.5;
        g = lerp(210, 74, depth) + shelf * 38 + waveHatch * 8 + contourRing * 24 + grain * 0.5;
        b = lerp(228, 124, depth) + shelf * 24 + waveHatch * 10 + contourRing * 22 + grain * 0.5;

        // Faint golden ley-bridges linking the 5 Celandia island kingdoms
        for (const [ax, az, bx, bz] of SKY_BRIDGES) {
          const dBridge = distToSegment(cx, cz, ax, az, bx, bz);
          if (dBridge < 10.0) {
            const dash = Math.sin((cx + cz) * 0.18) > -0.2 ? 1.0 : 0.35;
            const glow = (1.0 - dBridge / 10.0) * dash * 0.65;
            r = lerp(r, 248, glow);
            g = lerp(g, 214, glow);
            b = lerp(b, 134, glow);
          }
        }
      } else {
        // Dry land: sample height gradient for NW cartographic hillshading
        const hx = atlas.height(cx + stepY * 1.5, cz) - h;
        const hz = atlas.height(cx, cz + stepX * 1.5) - h;
        const slope = Math.hypot(hx, hz) / Math.max(1.0, stepY * 1.5);
        const shade = clamp(1.0 + (-hx * 0.65 - hz * 0.65) * 0.22, 0.68, 1.32);

        const bw = atlas.biomeWeights(cx, cz);
        const dNoc = Math.hypot(cx - atlas.NOCTURNUM_ISLE.x, cz - atlas.NOCTURNUM_ISLE.z);
        const nocWeight = clamp(1.0 - dNoc / (atlas.NOCTURNUM_ISLE.rx * 1.25), 0.0, 1.0);

        // Blend biome palette smoothly across island transitions
        const wakeCol = [146, 188, 114];
        const frostCol = [208, 232, 252];
        const glassCol = [232, 182, 138];
        const aureateCol = [230, 192, 108];
        const nocCol = [92, 68, 128];

        let baseR =
          wakeCol[0] * bw.wake +
          frostCol[0] * bw.frost +
          glassCol[0] * bw.glass +
          aureateCol[0] * bw.aureate;
        let baseG =
          wakeCol[1] * bw.wake +
          frostCol[1] * bw.frost +
          glassCol[1] * bw.glass +
          aureateCol[1] * bw.aureate;
        let baseB =
          wakeCol[2] * bw.wake +
          frostCol[2] * bw.frost +
          glassCol[2] * bw.glass +
          aureateCol[2] * bw.aureate;

        if (nocWeight > 0.0) {
          baseR = lerp(baseR, nocCol[0], nocWeight);
          baseG = lerp(baseG, nocCol[1], nocWeight);
          baseB = lerp(baseB, nocCol[2], nocWeight);
        }

        // Porcelain-ivory high plateau tinting
        const altFactor = clamp((h - atlas.SEA) / 28.0, 0.0, 1.0);
        baseR = lerp(baseR, 246, altFactor * 0.42);
        baseG = lerp(baseG, 238, altFactor * 0.42);
        baseB = lerp(baseB, 230, altFactor * 0.42);

        // Golden shoreline rim & elevation contour ink lines
        const shoreBand = h - atlas.SEA < 1.35 ? 1.0 - (h - atlas.SEA) / 1.35 : 0.0;
        const elevContour = Math.abs(((h - atlas.SEA) / 4.5) % 1.0 - 0.5) < 0.055 ? 1.0 : 0.0;

        r = baseR * shade + grain;
        g = baseG * shade + grain;
        b = baseB * shade + grain;

        if (shoreBand > 0.0) {
          r = lerp(r, 244, shoreBand * 0.75);
          g = lerp(g, 212, shoreBand * 0.75);
          b = lerp(b, 148, shoreBand * 0.75);
        }
        if (elevContour > 0.0 || slope > 0.85) {
          const ink = Math.max(elevContour * 0.28, clamp((slope - 0.85) * 0.25, 0.0, 0.32));
          r = lerp(r, 64, ink);
          g = lerp(g, 46, ink);
          b = lerp(b, 72, ink);
        }

        // Subtle highlight boost for the active zone on single-zone maps
        if (focusAreaId > 0) {
          const zone = classifyZoneAt(wx, wy);
          if (zone.areaId !== focusAreaId) {
            // Softly desaturate neighboring zones into warm sepia parchment
            const lum = r * 0.3 + g * 0.59 + b * 0.11;
            r = lerp(r, lum * 0.95 + 18, 0.45);
            g = lerp(g, lum * 0.90 + 12, 0.45);
            b = lerp(b, lum * 0.82 + 8, 0.45);
          }
        }
      }

      // Draw Kingdom Capital Spire & Citadel medallions at the 5 island centers
      for (const z of CELANDIA_WORLD_MAP_ZONES) {
        const dCitadel = Math.hypot(cx - z.cx, cz - z.cz);
        const markerRadius = focusAreaId > 0 ? 14.0 : 24.0;
        if (dCitadel < markerRadius) {
          const nd = dCitadel / markerRadius;
          if (nd > 0.72 && nd < 0.95) {
            // Gilt outer ring
            r = 250;
            g = 212;
            b = 118;
          } else if (nd <= 0.72) {
            // Jewel-toned kingdom core with 4-point star
            const dx = cx - z.cx;
            const dz = cz - z.cz;
            const star = Math.abs(dx) < markerRadius * 0.14 || Math.abs(dz) < markerRadius * 0.14;
            r = star ? 255 : z.accent[0];
            g = star ? 248 : z.accent[1];
            b = star ? 228 : z.accent[2];
          }
        }
      }

      // Ornate Compass Rose in the bottom-right corner (`px` near `910`, `py` near `580`)
      const crX = px - 912;
      const crY = py - 582;
      const crR = Math.hypot(crX, crY);
      if (crR < 48) {
        const ang = Math.atan2(crY, crX);
        const ring = Math.abs(crR - 38) < 2.2 || Math.abs(crR - 26) < 1.5;
        const points4 = Math.pow(Math.abs(Math.cos(ang * 2.0)), 6.0) * (1.0 - crR / 46.0) > 0.35;
        const points8 = Math.pow(Math.abs(Math.cos((ang + Math.PI / 4) * 2.0)), 8.0) * (1.0 - crR / 34.0) > 0.4;
        if (ring || points4 || points8 || crR < 5.0) {
          r = points4 ? 252 : 218;
          g = points4 ? 224 : 178;
          b = points4 ? 142 : 104;
        }
      }

      rgba[idx + 0] = clamp(Math.round(r), 0, 255);
      rgba[idx + 1] = clamp(Math.round(g), 0, 255);
      rgba[idx + 2] = clamp(Math.round(b), 0, 255);
      rgba[idx + 3] = 255;
    }
  }

  // Slice the 1002x668 canvas into 4x3 = 12 256x256 BLP2 tiles (1..12)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const tileNum = row * 4 + col + 1;
      const originX = col * TILE_DIM;
      const originY = row * TILE_DIM;

      const tileBlp = createBlp2(TILE_DIM, TILE_DIM, (tx, ty) => {
        const sx = Math.min(MAP_CANVAS_W - 1, originX + tx);
        const sy = Math.min(MAP_CANVAS_H - 1, originY + ty);
        const off = (sy * MAP_CANVAS_W + sx) * 4;
        // Beyond the 1002x668 detail frame inside the 1024x768 grid, keep alpha 255 dark gilt
        return [rgba[off], rgba[off + 1], rgba[off + 2], 255];
      });

      writeFile(`Interface/WorldMap/${folderName}/${filePrefix}${tileNum}.blp`, tileBlp);
    }
  }

  // Also write `<filePrefix>Highlight.blp` (256x256 soft radial golden-porcelain glow for hover highlight)
  const highlightBlp = createBlp2(256, 256, (x, y, w, h) => {
    const nx = (x - w * 0.5) / (w * 0.5);
    const ny = (y - h * 0.5) / (h * 0.5);
    const d = Math.hypot(nx, ny);
    if (d >= 1.0) return [0, 0, 0, 0];
    const glow = Math.pow(1.0 - d, 1.6);
    const ring = Math.abs(d - 0.72) < 0.04 ? 0.65 : 0.0;
    const alpha = clamp(Math.round((glow * 0.55 + ring * 0.45) * 255), 0, 220);
    return [255, 226, 148, alpha];
  });
  writeFile(`Interface/WorldMap/${folderName}/${filePrefix}Highlight.blp`, highlightBlp);
}

/**
 * Build `Interface/WorldMap/Celandia.zmp` (128x128 u32 little-endian zone lookup grid = 65536 bytes).
 *
 * Matches `area_grid_cell` (`0x4a6ec0`) in `crates/benilla-ui/src/script/worldmap.rs`:
 *   `f1 = 0.5 - wy * K`, `f2 = 0.5 - wx * K` where `K = 2.929_687_6e-5` (`1 / (64 * 533.33333)`),
 *   `col = (f1 * 128.0) as i32`, `row = (f2 * 128.0) as i32`, `cell = col + row * 128`.
 */
function buildCelandiaZmp(writeFile) {
  const K = 2.9296876e-5;
  const buf = Buffer.alloc(128 * 128 * 4, 0);

  for (let row = 0; row < 128; row++) {
    const f2 = (row + 0.5) / 128.0;
    const wx = (0.5 - f2) / K;
    for (let col = 0; col < 128; col++) {
      const f1 = (col + 0.5) / 128.0;
      const wy = (0.5 - f1) / K;
      const cx = -wy;
      const cz = -wx;
      let areaId = 0;
      if (Math.abs(wx) <= 1350.0 && Math.abs(wy) <= 1350.0) {
        const h = atlas.height(cx, cz);
        if (h >= atlas.SEA - 4.0) {
          areaId = classifyZoneAt(wx, wy).areaId;
        }
      }
      buf.writeUInt32LE(areaId, (row * 128 + col) * 4);
    }
  }

  writeFile('Interface/WorldMap/Celandia.zmp', buf);
  writeFile('Interface/WorldMap/Celandia/Celandia.zmp', buf);
}

// ============================================================================
// 2. WorldMap*.dbc, LoadingScreens.dbc, ItemClass.dbc & AuctionHouse.dbc
// ============================================================================

function buildWorldMapAndUiDbcs(writeFile, WdbcBuilder, f32) {
  // 1. WorldMapArea.dbc (8 cols, string col [3])
  // Schema: 0:ID, 1:MapID, 2:AreaID, 3:AreaName, 4:LocLeft, 5:LocRight, 6:LocTop, 7:LocBottom
  const wmaDbc = new WdbcBuilder(8, [3]);

  // Row 1: Continent row for MapID = 0 (AreaID = 0)
  wmaDbc.addRow({
    0: 1,
    1: 0,
    2: 0,
    3: 'Celandia',
    4: f32(CONTINENT_BOUNDS.locLeft),
    5: f32(CONTINENT_BOUNDS.locRight),
    6: f32(CONTINENT_BOUNDS.locTop),
    7: f32(CONTINENT_BOUNDS.locBottom),
  });

  // Rows 2..6: The 5 Celandia Kingdom zones on MapID = 0
  for (const z of CELANDIA_WORLD_MAP_ZONES) {
    wmaDbc.addRow({
      0: z.worldMapAreaId,
      1: 0,
      2: z.areaId,
      3: z.areaName,
      4: f32(z.locLeft),
      5: f32(z.locRight),
      6: f32(z.locTop),
      7: f32(z.locBottom),
    });
  }

  // Row 7: Continent row for MapID = 1 (in case continent index 2 or Map 1 is queried)
  wmaDbc.addRow({
    0: 7,
    1: 1,
    2: 0,
    3: 'Celandia',
    4: f32(CONTINENT_BOUNDS.locLeft),
    5: f32(CONTINENT_BOUNDS.locRight),
    6: f32(CONTINENT_BOUNDS.locTop),
    7: f32(CONTINENT_BOUNDS.locBottom),
  });

  // Direct-area instance rows (401, 443, 461) for WorldMap direct-area projection compatibility
  for (const [id, mapId, areaId, name] of [
    [401, 30, 2597, 'AlteracValley'],
    [443, 489, 3277, 'WarsongGulch'],
    [461, 529, 3358, 'ArathiBasin'],
  ]) {
    wmaDbc.addRow({
      0: id,
      1: mapId,
      2: areaId,
      3: name,
      4: f32(CONTINENT_BOUNDS.locLeft),
      5: f32(CONTINENT_BOUNDS.locRight),
      6: f32(CONTINENT_BOUNDS.locTop),
      7: f32(CONTINENT_BOUNDS.locBottom),
    });
  }

  writeFile('DBFilesClient/WorldMapArea.dbc', wmaDbc.toBuffer());

  // 2. WorldMapContinent.dbc (13 cols, no string cols)
  // Schema: 0:ID, 1:MapID, 2:LeftBoundary, 3:RightBoundary, 4:TopBoundary, 5:BottomBoundary,
  //         6:OffsetX(f32), 7:OffsetY(f32), 8:Scale(f32), 9:TaxiMinX(f32), 10:TaxiMinY(f32), 11:TaxiMaxX(f32), 12:TaxiMaxY(f32)
  const wmcDbc = new WdbcBuilder(13);
  wmcDbc.addRow({
    0: 1,
    1: 0,
    2: 30,
    3: 33,
    4: 30,
    5: 33,
    6: f32(0.0),
    7: f32(0.0),
    8: f32(0.75),
    9: f32(-1066.6666),
    10: f32(-1066.6666),
    11: f32(1066.6666),
    12: f32(1066.6666),
  });
  wmcDbc.addRow({
    0: 2,
    1: 1,
    2: 30,
    3: 33,
    4: 30,
    5: 33,
    6: f32(0.0),
    7: f32(0.0),
    8: f32(0.75),
    9: f32(-1066.6666),
    10: f32(-1066.6666),
    11: f32(1066.6666),
    12: f32(1066.6666),
  });
  writeFile('DBFilesClient/WorldMapContinent.dbc', wmcDbc.toBuffer());

  // 3. WorldMapOverlay.dbc (17 cols, string col [8])
  // Schema: 0:ID, 1:WorldMapAreaID, 2..5:AreaID[0..3], 6:MapPointX, 7:MapPointY,
  //         8:TextureName (basename under Interface\WorldMap\<AreaName>\),
  //         9:TextureWidth, 10:TextureHeight, 11:OffsetX, 12:OffsetY,
  //         13:HitRectTop, 14:HitRectLeft, 15:HitRectBottom, 16:HitRectRight
  const wmoDbc = new WdbcBuilder(17, [8]);
  let ovId = 1;
  for (const z of CELANDIA_WORLD_MAP_ZONES) {
    wmoDbc.addRow({
      0: ovId++,
      1: z.worldMapAreaId,
      2: z.areaId,
      3: 0,
      4: 0,
      5: 0,
      6: 0,
      7: 0,
      8: z.areaName,
      9: 1002,
      10: 668,
      11: 0,
      12: 0,
      13: 0,
      14: 0,
      15: 668,
      16: 1002,
    });
  }
  for (let k = 0; k < 3; k++) {
    wmoDbc.addRow({
      0: ovId++,
      1: 401,
      2: 2597,
      3: 0,
      4: 0,
      5: 0,
      6: 0,
      7: 0,
      8: 'PorcelainWake',
      9: 256,
      10: 256,
      11: 0,
      12: 0,
      13: 0,
      14: 0,
      15: 256,
      16: 256,
    });
  }
  writeFile('DBFilesClient/WorldMapOverlay.dbc', wmoDbc.toBuffer());

  // 4. LoadingScreens.dbc (3 cols, string cols [1, 2])
  // Schema: 0:ID, 1:Name, 2:FileName
  const lsDbc = new WdbcBuilder(3, [1, 2]);
  lsDbc.addRow({
    0: 1,
    1: 'Celandia',
    2: 'Interface\\Glues\\LoadingScreens\\LoadScreenCelandia.blp',
  });
  lsDbc.addRow({
    0: 2,
    1: 'PorcelainWake',
    2: 'Interface\\Glues\\LoadingScreens\\LoadScreenCelandia.blp',
  });
  lsDbc.addRow({
    0: 3,
    1: 'Kalimdor',
    2: 'Interface\\Glues\\LoadingScreens\\LoadScreenKalimdor.blp',
  });
  lsDbc.addRow({
    0: 4,
    1: 'EasternKingdoms',
    2: 'Interface\\Glues\\LoadingScreens\\LoadScreenEasternKingdom.blp',
  });
  writeFile('DBFilesClient/LoadingScreens.dbc', lsDbc.toBuffer());

  // 5. ItemClass.dbc (12 cols, string cols [3..10])
  // Schema: 0:ClassID, 1:SubClassMapID, 2:Flags, 3..10:Name_enUS..Name_ptBR, 11:NameFlags
  const icDbc = new WdbcBuilder(12, [3, 4, 5, 6, 7, 8, 9, 10]);
  const itemClasses = [
    [0, 0, 0, 'Consumable'],
    [1, 0, 0, 'Container'],
    [2, 0, 1, 'Weapon'],
    [3, 0, 0, 'Jewelry(OBSOLETE)'],
    [4, 0, 0, 'Armor'],
    [5, 0, 0, 'Reagent'],
    [6, 0, 0, 'Projectile'],
    [7, 0, 0, 'Trade Goods'],
    [8, 0, 0, 'Generic(OBSOLETE)'],
    [9, 0, 0, 'Recipe'],
    [10, 0, 0, 'Money(OBSOLETE)'],
    [11, 0, 0, 'Quiver'],
    [12, 0, 0, 'Quest'],
    [13, 0, 0, 'Key'],
    [14, 0, 0, 'Permanent(OBSOLETE)'],
    [15, 0, 0, 'Miscellaneous'],
  ];
  for (const [cid, subMap, flags, name] of itemClasses) {
    icDbc.addRow({ 0: cid, 1: subMap, 2: flags, 3: name, 11: 0 });
  }
  writeFile('DBFilesClient/ItemClass.dbc', icDbc.toBuffer());

  // 6. AuctionHouse.dbc (13 cols, string cols [4..11])
  // Schema: 0:ID, 1:FactionID, 2:DepositPercent, 3:CutPercent, 4..11:Name_enUS..Name_ptBR, 12:NameFlags
  const ahDbc = new WdbcBuilder(13, [4, 5, 6, 7, 8, 9, 10, 11]);
  const auctionHouses = [
    [1, 1, 5, 5, 'Stormwind Auction House'],
    [2, 1, 5, 5, 'Alliance Auction House'],
    [3, 1, 5, 5, 'Darnassus Auction House'],
    [4, 2, 5, 5, 'Undercity Auction House'],
    [5, 2, 5, 5, 'Thunder Bluff Auction House'],
    [6, 2, 5, 5, 'Horde Auction House'],
    [7, 369, 25, 15, 'Blackwater Auction House'],
  ];
  for (const [id, fac, dep, cut, name] of auctionHouses) {
    ahDbc.addRow({ 0: id, 1: fac, 2: dep, 3: cut, 4: name, 12: 0 });
  }
  writeFile('DBFilesClient/AuctionHouse.dbc', ahDbc.toBuffer());
}

// ============================================================================
// 3. Celandia Porcelain-and-Rose-Gold RPG UI Chrome & Loading Screen BLP2 Art
// ============================================================================

function buildLoadingScreensAndUiChrome(writeFile, createBlp2) {
  // 1. 512x512 Painted Loading Screen (`LoadScreenCelandia.blp`)
  const loadScreenBlp = createBlp2(512, 512, (x, y, w, h) => {
    const u = x / w;
    const v = y / h;
    const nx = (u - 0.5) * 2.0;
    const ny = (v - 0.5) * 2.0;

    // Ornate rose-gold and dark-indigo outer frame
    const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (edge < 12) {
      if (edge < 3 || (edge >= 8 && edge <= 10)) return [236, 196, 118, 255];
      return [32, 24, 50, 255];
    }

    // Twin-ringed Celandia celestial twilight sky above horizon (v = 0.62)
    const horizon = 0.62;
    let r = 0;
    let g = 0;
    let b = 0;

    if (v < horizon) {
      const t = v / horizon;
      // Top: starry porcelain-violet -> Mid: rose-lavender -> Horizon: warm apricot-gold
      r = lerp(42, 248, Math.pow(t, 1.35));
      g = lerp(36, 198, Math.pow(t, 1.45));
      b = lerp(84, 212, Math.pow(t, 1.1));

      // Celestial Aureate Halo / Twin Ring behind the central spire
      const sunD = Math.hypot(nx, (v - 0.36) * 2.2);
      if (sunD < 0.58) {
        const sunCore = Math.pow(1.0 - sunD / 0.58, 2.2);
        const haloRing = Math.abs(sunD - 0.42) < 0.022 || Math.abs(sunD - 0.52) < 0.014 ? 0.85 : 0.0;
        const glow = clamp(sunCore * 0.85 + haloRing, 0.0, 1.0);
        r = lerp(r, 255, glow);
        g = lerp(g, 238, glow);
        b = lerp(b, 178, glow);
      }

      // Distant floating Glasswake & Frostbell archipelago silhouettes
      const archH =
        horizon -
        0.04 -
        Math.max(0, 0.09 - Math.abs(u - 0.22) * 0.65) -
        Math.max(0, 0.08 - Math.abs(u - 0.78) * 0.60);
      if (v > archH) {
        r = lerp(r, 78, 0.65);
        g = lerp(g, 64, 0.65);
        b = lerp(b, 118, 0.65);
      }

      // Central Porcelain Citadel Spire silhouette rising toward the halo
      const spireHalfW = 0.018 + Math.pow(Math.max(0, v - 0.18), 1.65) * 0.28;
      if (v > 0.18 && Math.abs(nx) < spireHalfW) {
        const edgeRim = Math.abs(Math.abs(nx) - spireHalfW) < 0.012 ? 1.0 : 0.0;
        r = edgeRim ? 255 : lerp(228, 152, (v - 0.18) / 0.44);
        g = edgeRim ? 226 : lerp(214, 134, (v - 0.18) / 0.44);
        b = edgeRim ? 156 : lerp(236, 174, (v - 0.18) / 0.44);
      }
    } else {
      // Shimmering Elsewhere Tide below horizon with golden sun-path reflection
      const wt = (v - horizon) / (1.0 - horizon);
      const ripple = Math.sin(v * 140.0 + Math.sin(u * 28.0) * 2.5) * 0.5 + 0.5;
      r = lerp(96, 26, wt) + ripple * 14;
      g = lerp(198, 68, wt) + ripple * 22;
      b = lerp(220, 118, wt) + ripple * 24;

      const reflW = 0.08 + wt * 0.22;
      if (Math.abs(nx) < reflW) {
        const refl = (1.0 - Math.abs(nx) / reflW) * (0.45 + ripple * 0.55) * (1.0 - wt * 0.5);
        r = lerp(r, 255, refl);
        g = lerp(g, 224, refl);
        b = lerp(b, 148, refl);
      }
    }

    return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255), 255];
  });

  writeFile('Interface/Glues/LoadingScreens/LoadScreenCelandia.blp', loadScreenBlp);
  writeFile('Interface/Glues/LoadingScreens/LoadScreenKalimdor.blp', loadScreenBlp);
  writeFile('Interface/Glues/LoadingScreens/LoadScreenEasternKingdom.blp', loadScreenBlp);

  // Loading bar fill & border
  const barFillBlp = createBlp2(128, 32, (x, y, w, h) => {
    const v = y / h;
    const sheen = Math.exp(-Math.pow((v - 0.35) * 4.0, 2.0));
    return [
      clamp(Math.round(218 + sheen * 37), 0, 255),
      clamp(Math.round(168 + sheen * 64), 0, 255),
      clamp(Math.round(88 + sheen * 72), 0, 255),
      255,
    ];
  });
  writeFile('Interface/Glues/LoadingBar/Loading-BarFill.blp', barFillBlp);
  writeFile('Interface/TargetingFrame/UI-StatusBar.blp', barFillBlp);
  writeFile('Interface/TargetingFrame/UI-TargetingFrame-BarFill.blp', barFillBlp);
  writeFile('Interface/MainMenuBar/UI-XP-Bar.blp', barFillBlp);

  const barBorderBlp = createBlp2(256, 64, (x, y, w, h) => {
    const border = x < 4 || x >= w - 4 || y < 4 || y >= h - 4;
    if (border) return [232, 192, 114, 255];
    if (x < 7 || x >= w - 7 || y < 7 || y >= h - 7) return [64, 48, 86, 220];
    return [0, 0, 0, 0];
  });
  writeFile('Interface/Glues/LoadingBar/Loading-BarBorder.blp', barBorderBlp);
  writeFile('Interface/CastingBar/UI-CastingBar-Border.blp', barBorderBlp);
  writeFile('Interface/Tooltips/Nameplate-Border.blp', barBorderBlp);

  writeFile(
    'Interface/CastingBar/UI-CastingBar-Spark.blp',
    createBlp2(32, 64, (x, y, w, h) => {
      const dx = (x - w * 0.5) / (w * 0.5);
      const dy = (y - h * 0.5) / (h * 0.5);
      const a = clamp(Math.round(Math.exp(-(dx * dx * 6.0 + dy * dy * 2.5)) * 255), 0, 255);
      return [255, 240, 188, a];
    })
  );

  // 2. Unit & Target Frames (`Interface/TargetingFrame/*`)
  const targetFrameBlp = createBlp2(256, 128, (x, y, w, h) => {
    // Portrait ring centered on the right/left plus porcelain-and-gilt nameplate & bar housing
    const pCx = 192;
    const pCy = 52;
    const pr = Math.hypot(x - pCx, y - pCy);
    if (pr >= 28 && pr <= 35) {
      return [236, 194, 118, 255]; // Gilt portrait bezel
    }
    if (pr < 28) {
      return [34, 28, 52, 180]; // Portrait backing
    }
    // Name/health/mana bar housing (`x` in `14..166`, `y` in `22..78`)
    if (x >= 14 && x <= 166 && y >= 22 && y <= 78) {
      const edge = x < 17 || x > 163 || y < 25 || y > 75 || Math.abs(y - 42) < 2 || Math.abs(y - 60) < 2;
      if (edge) return [224, 182, 108, 255];
      return [42, 34, 64, 215];
    }
    return [0, 0, 0, 0];
  });
  writeFile('Interface/TargetingFrame/UI-TargetingFrame.blp', targetFrameBlp);
  writeFile('Interface/TargetingFrame/UI-TargetingFrame-Elite.blp', targetFrameBlp);
  writeFile('Interface/TargetingFrame/UI-TargetingFrame-Rare.blp', targetFrameBlp);

  const smallTargetBlp = createBlp2(128, 64, (x, y, w, h) => {
    const pr = Math.hypot(x - 28, y - 30);
    if (pr >= 16 && pr <= 20) return [236, 194, 118, 255];
    if (pr < 16) return [34, 28, 52, 180];
    if (x >= 44 && x <= 118 && y >= 14 && y <= 46) {
      const edge = x < 46 || x > 116 || y < 16 || y > 44 || Math.abs(y - 30) < 2;
      return edge ? [224, 182, 108, 255] : [42, 34, 64, 215];
    }
    return [0, 0, 0, 0];
  });
  writeFile('Interface/TargetingFrame/UI-TargetofTargetFrame.blp', smallTargetBlp);
  writeFile('Interface/TargetingFrame/UI-SmallTargetingFrame.blp', smallTargetBlp);
  writeFile('Interface/TargetingFrame/UI-PartyFrame.blp', smallTargetBlp);

  const circleBadgeBlp = createBlp2(32, 32, (x, y) => {
    const r = Math.hypot(x - 15.5, y - 15.5);
    if (r > 15.0) return [0, 0, 0, 0];
    if (r > 12.0) return [236, 194, 118, 255];
    return [46, 36, 68, 235];
  });
  writeFile('Interface/TargetingFrame/UI-TargetingFrame-LevelBackground.blp', circleBadgeBlp);
  writeFile('Interface/TargetingFrame/UI-TargetingFrame-AttackBackground.blp', circleBadgeBlp);
  writeFile('Interface/TargetingFrame/UI-TargetingFrame-Seal.blp', circleBadgeBlp);

  writeFile(
    'Interface/TargetingFrame/UI-RaidTargetingIcons.blp',
    createBlp2(128, 128, (x, y) => {
      const lx = (x % 32) - 15.5;
      const ly = (y % 32) - 15.5;
      const r = Math.hypot(lx, ly);
      if (r > 13.5) return [0, 0, 0, 0];
      return r > 10.5 ? [255, 224, 132, 255] : [245, 154, 184, 240];
    })
  );

  // 3. Nine-Slice Tooltip & Dialog Backgrounds + 8-Tile Border Strips
  const tooltipBgBlp = createBlp2(32, 32, (x, y) => {
    const n = hash2(x, y) * 6;
    return [34 + n, 28 + n, 54 + n, 238];
  });
  writeFile('Interface/Tooltips/UI-Tooltip-Background.blp', tooltipBgBlp);
  writeFile('Interface/Glues/Common/Glue-Tooltip-Background.blp', tooltipBgBlp);
  writeFile('Interface/DialogFrame/UI-DialogBox-Background.blp', tooltipBgBlp);
  writeFile('Interface/ChatFrame/ChatFrameBackground.blp', tooltipBgBlp);

  // 8-tile border strip (width = 8 * tileSize, height = tileSize)
  // Cell layout expected by backdrop::split_backdrop_edges:
  //   0: LEFT (upright, left edge lx < t)
  //   1: RIGHT (upright, right edge lx >= e - t)
  //   2: TOP (rotated 90 deg: screen_y = lx, so top edge is lx < t)
  //   3: BOTTOM (rotated 90 deg: screen_y = lx, so bottom edge is lx >= e - t)
  //   4: TOPLEFT (upright corner: lx < t || ly < t)
  //   5: TOPRIGHT (upright corner: lx >= e - t || ly < t)
  //   6: BOTTOMLEFT (upright corner: lx < t || ly >= e - t)
  //   7: BOTTOMRIGHT (upright corner: lx >= e - t || ly >= e - t)
  function createBorderStripBlp(tileSize) {
    const t = Math.max(3, Math.round(tileSize * 0.22));
    return createBlp2(tileSize * 8, tileSize, (x, y) => {
      const cell = Math.floor(x / tileSize);
      const lx = x % tileSize;
      const ly = y;
      let dist = 999;
      if (cell === 0) {
        if (lx < t) dist = lx;
      } else if (cell === 1) {
        if (lx >= tileSize - t) dist = tileSize - 1 - lx;
      } else if (cell === 2) {
        if (lx < t) dist = lx;
      } else if (cell === 3) {
        if (lx >= tileSize - t) dist = tileSize - 1 - lx;
      } else if (cell === 4) {
        if (lx < t || ly < t) dist = Math.min(lx, ly);
      } else if (cell === 5) {
        if (lx >= tileSize - t || ly < t) dist = Math.min(tileSize - 1 - lx, ly);
      } else if (cell === 6) {
        if (lx < t || ly >= tileSize - t) dist = Math.min(lx, tileSize - 1 - ly);
      } else if (cell === 7) {
        if (lx >= tileSize - t || ly >= tileSize - t) {
          dist = Math.min(tileSize - 1 - lx, tileSize - 1 - ly);
        }
      }
      if (dist >= t) return [0, 0, 0, 0];
      if (dist === 0 || dist === t - 1) return [245, 184, 214, 255];
      return [168, 118, 186, 245];
    });
  }
  const tooltipBorderBlp = createBorderStripBlp(16);
  writeFile('Interface/Tooltips/UI-Tooltip-Border.blp', tooltipBorderBlp);
  writeFile('Interface/Glues/Common/Glue-Tooltip-Border.blp', tooltipBorderBlp);
  writeFile('Interface/DialogFrame/UI-DialogBox-Border.blp', createBorderStripBlp(32));

  const headerBannerBlp = createBlp2(256, 64, (x, y, w, h) => {
    if (x < 24 || x >= w - 24 || y < 8 || y >= h - 16) return [0, 0, 0, 0];
    const edge = x < 28 || x >= w - 28 || y < 12 || y >= h - 20;
    if (edge) return [238, 198, 122, 255];
    return [52, 40, 78, 245];
  });
  writeFile('Interface/DialogFrame/UI-DialogBox-Header.blp', headerBannerBlp);

  // 4. Porcelain & Rose-Gold Panel Buttons, Action Slots, Checkboxes (`Interface/Buttons/*`, `Interface/Glues/*`)
  function createButtonBlp(bgTop, bgBot, borderCol) {
    return createBlp2(128, 32, (x, y, w, h) => {
      // Note: WoW UI-Panel-Button textures use the left 0..79 pixels x 0..22 pixels
      const edge = x < 2 || x === 78 || x === 79 || x >= w - 2 || y < 2 || y === 21 || y >= h - 2;
      if (edge) return [...borderCol, 255];
      const t = y / h;
      return [
        Math.round(lerp(bgTop[0], bgBot[0], t)),
        Math.round(lerp(bgTop[1], bgBot[1], t)),
        Math.round(lerp(bgTop[2], bgBot[2], t)),
        255,
      ];
    });
  }

  const btnUp = createButtonBlp([118, 76, 134], [58, 38, 78], [236, 196, 118]);
  const btnDown = createButtonBlp([52, 34, 70], [98, 64, 114], [212, 168, 94]);
  const btnDis = createButtonBlp([74, 68, 84], [48, 44, 56], [138, 128, 146]);
  const btnHi = createBlp2(128, 32, (x, y, w, h) => {
    const cx = (x - w * 0.35) / (w * 0.45);
    const cy = (y - h * 0.4) / (h * 0.45);
    const a = clamp(Math.round(Math.max(0, 1.0 - Math.hypot(cx, cy)) * 165), 0, 165);
    return [255, 224, 152, a];
  });

  writeFile('Interface/Buttons/UI-Panel-Button-Up.blp', btnUp);
  writeFile('Interface/Buttons/UI-Panel-Button-Down.blp', btnDown);
  writeFile('Interface/Buttons/UI-Panel-Button-Disabled.blp', btnDis);
  writeFile('Interface/Buttons/UI-Panel-Button-Highlight.blp', btnHi);
  writeFile('Interface/Glues/Common/Glue-Panel-Button-Up.blp', btnUp);
  writeFile('Interface/Glues/Common/Glue-Panel-Button-Down.blp', btnDown);
  writeFile('Interface/Glues/Common/Glue-Panel-Button-Disabled.blp', btnDis);
  writeFile('Interface/Glues/Common/Glue-Panel-Button-Highlight.blp', btnHi);
  writeFile('Interface/Glues/Common/Glue-Panel-Button-Up-Blue.blp', btnUp);
  writeFile('Interface/Glues/Common/Glue-Panel-Button-Down-Blue.blp', btnDown);
  writeFile('Interface/Glues/Common/Glue-Panel-Button-Highlight-Blue.blp', btnHi);

  // TextPanel-Border & CharacterSelect/CharacterCreate chrome
  writeFile('Interface/Glues/Common/TextPanel-Border.blp', tooltipBorderBlp);

  const charSelectHiBlp = createBlp2(256, 64, (x, y, w, h) => {
    if (x < 4 || x >= w - 4 || y < 4 || y >= h - 4) return [0, 0, 0, 0];
    const edge = x < 7 || x >= w - 7 || y < 7 || y >= h - 7;
    if (edge) return [245, 174, 206, 235];
    const glow = 1.0 - Math.abs((y - h * 0.5) / (h * 0.5));
    return [184, 108, 255, Math.round(glow * 135)];
  });
  writeFile('Interface/Glues/CharacterSelect/Glue-CharacterSelect-Highlight.blp', charSelectHiBlp);

  const charCreateBgBlp = createBlp2(256, 256, (x, y, w, h) => {
    const u = x / w;
    const v = y / h;
    const radial = Math.hypot(u - 0.5, v - 0.42);
    const glow = Math.max(0, 1.0 - radial * 1.45);
    return [
      Math.round(lerp(18, 92, glow)),
      Math.round(lerp(14, 58, glow)),
      Math.round(lerp(36, 134, glow)),
      255,
    ];
  });
  writeFile('Interface/Glues/CharacterCreate/UI-CharacterCreate-Background.blp', charCreateBgBlp);

  const charCreateOuterBorderBlp = createBlp2(256, 256, (x, y, w, h) => {
    const edge = x < 8 || x >= w - 8 || y < 8 || y >= h - 8;
    const inner = x >= 12 && x < w - 12 && y >= 12 && y < h - 12;
    if (inner) return [0, 0, 0, 0];
    if (edge) return [245, 178, 208, 255];
    return [82, 54, 118, 235];
  });
  writeFile('Interface/Glues/CharacterCreate/UI-CharacterCreate-OuterBorder.blp', charCreateOuterBorderBlp);

  const closeBtnBlp = createBlp2(32, 32, (x, y) => {
    if (x < 4 || x >= 28 || y < 4 || y >= 28) return [0, 0, 0, 0];
    const border = x < 6 || x >= 26 || y < 6 || y >= 26;
    if (border) return [236, 194, 118, 255];
    const cross = Math.abs(x - y) <= 2 || Math.abs(x + y - 31) <= 2;
    if (cross && x >= 9 && x <= 22 && y >= 9 && y <= 22) return [255, 232, 168, 255];
    return [96, 44, 72, 245];
  });
  writeFile('Interface/Buttons/UI-Panel-MinimizeButton-Up.blp', closeBtnBlp);
  writeFile('Interface/Buttons/UI-Panel-MinimizeButton-Down.blp', closeBtnBlp);
  writeFile('Interface/Buttons/UI-Panel-MinimizeButton-Highlight.blp', btnHi);

  const quickslotBlp = createBlp2(64, 64, (x, y, w, h) => {
    const pad = 8;
    if (x < pad || x >= w - pad || y < pad || y >= h - pad) return [0, 0, 0, 0];
    const rim = x < pad + 3 || x >= w - pad - 3 || y < pad + 3 || y >= h - pad - 3;
    if (rim) return [228, 188, 114, 255];
    return [36, 28, 54, 210];
  });
  writeFile('Interface/Buttons/UI-Quickslot.blp', quickslotBlp);
  writeFile('Interface/Buttons/UI-Quickslot2.blp', quickslotBlp);
  writeFile('Interface/Buttons/UI-Quickslot-Depress.blp', quickslotBlp);
  writeFile('Interface/Buttons/UI-EmptySlot.blp', quickslotBlp);
  writeFile('Interface/Buttons/UI-EmptySlot-Disabled.blp', quickslotBlp);

  const squareHiBlp = createBlp2(64, 64, (x, y, w, h) => {
    const d = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (d < 4 || d > 12) return [0, 0, 0, 0];
    return [255, 228, 148, 190];
  });
  writeFile('Interface/Buttons/ButtonHilight-Square.blp', squareHiBlp);
  writeFile('Interface/Buttons/CheckButtonHilight.blp', squareHiBlp);

  const checkUpBlp = createBlp2(32, 32, (x, y) => {
    if (x < 4 || x >= 28 || y < 4 || y >= 28) return [0, 0, 0, 0];
    const rim = x < 6 || x >= 26 || y < 6 || y >= 26;
    return rim ? [228, 188, 114, 255] : [36, 28, 54, 235];
  });
  const checkMarkBlp = createBlp2(32, 32, (x, y) => {
    const d = Math.hypot(x - 15.5, y - 15.5);
    return d < 7.5 ? [255, 224, 128, 255] : [0, 0, 0, 0];
  });
  writeFile('Interface/Buttons/UI-CheckBox-Up.blp', checkUpBlp);
  writeFile('Interface/Buttons/UI-CheckBox-Down.blp', checkUpBlp);
  writeFile('Interface/Buttons/UI-CheckBox-Check.blp', checkMarkBlp);

  // 5. MainMenuBar, Minimap Chrome, Character Create & WorldMap Frame Chrome
  const mainBarBlp = createBlp2(256, 64, (x, y, w, h) => {
    if (y < 6) return [236, 196, 118, 255];
    return [44, 34, 66, 245];
  });
  writeFile('Interface/MainMenuBar/UI-MainMenuBar-Dwarf.blp', mainBarBlp);

  const endCapBlp = createBlp2(128, 128, (x, y, w, h) => {
    // Stylized Porcelain Gryphon / Sky-Manta filigree wing cap
    const nx = (x - w * 0.5) / (w * 0.5);
    const ny = (y - h * 0.55) / (h * 0.45);
    const wing = Math.hypot(nx * 0.85, ny + nx * 0.35);
    if (wing > 0.92) return [0, 0, 0, 0];
    if (wing > 0.78) return [238, 198, 122, 255];
    return [218, 206, 228, 255];
  });
  writeFile('Interface/MainMenuBar/UI-MainMenuBar-EndCap-Dwarf.blp', endCapBlp);

  const minimapBorderBlp = createBlp2(128, 128, (x, y) => {
    const r = Math.hypot(x - 63.5, y - 63.5);
    if (r >= 54 && r <= 62) return [236, 196, 118, 255];
    if (r > 51 && r < 54) return [54, 42, 82, 235];
    return [0, 0, 0, 0];
  });
  writeFile('Interface/Minimap/UI-Minimap-Border.blp', minimapBorderBlp);
  writeFile('Interface/Minimap/MiniMap-TrackingBorder.blp', circleBadgeBlp);
  writeFile(
    'Interface/Minimap/UI-Minimap-Background.blp',
    createBlp2(128, 128, (x, y) => {
      const r = Math.hypot(x - 63.5, y - 63.5);
      return r <= 58 ? [24, 20, 38, 220] : [0, 0, 0, 0];
    })
  );
  writeFile('Interface/Minimap/UI-Minimap-ZoomInButton-Up.blp', circleBadgeBlp);
  writeFile('Interface/Minimap/UI-Minimap-ZoomInButton-Disabled.blp', circleBadgeBlp);
  writeFile('Interface/Minimap/UI-Minimap-ZoomOutButton-Up.blp', circleBadgeBlp);
  writeFile('Interface/Minimap/UI-Minimap-ZoomOutButton-Disabled.blp', circleBadgeBlp);
  writeFile('Interface/Minimap/UI-TOD-Indicator.blp', circleBadgeBlp);

  // WorldMap outer frame tiles (`UI-WorldMap-Top1..4`, `Middle1..4`, `Bottom1..4`) & player/party icons
  const wmFrameTile = createBlp2(256, 256, (x, y, w, h) => {
    const border = x < 6 || x >= w - 6 || y < 6 || y >= h - 6;
    if (border) return [228, 188, 112, 255];
    return [36, 28, 54, 240];
  });
  for (let i = 1; i <= 4; i++) {
    writeFile(`Interface/WorldMap/UI-WorldMap-Top${i}.blp`, wmFrameTile);
    writeFile(`Interface/WorldMap/UI-WorldMap-Middle${i}.blp`, wmFrameTile);
    writeFile(`Interface/WorldMap/UI-WorldMap-Bottom${i}.blp`, wmFrameTile);
  }
  writeFile('Interface/WorldMap/WorldMap-MagnifyingGlass.blp', circleBadgeBlp);

  const wmPlayerIcon = createBlp2(16, 16, (x, y) => {
    const r = Math.hypot(x - 7.5, y - 7.5);
    if (r > 6.5) return [0, 0, 0, 0];
    return r > 4.5 ? [48, 32, 68, 255] : [255, 232, 124, 255];
  });
  writeFile('Interface/WorldMap/WorldMapPlayerIcon.blp', wmPlayerIcon);
  writeFile('Interface/WorldMap/WorldMapPartyIcon.blp', wmPlayerIcon);

  // 5×7 pixel bitmap glyph table for crisp procedural logo text in BLP textures
  const PIXEL_FONT_5X7 = {
    W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
    O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
    E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
    C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
    R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
    A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
    T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
    N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
    o: [0b00000, 0b00000, 0b01110, 0b10001, 0b10001, 0b10001, 0b01110],
    L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
    D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
    I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    ' ': [0, 0, 0, 0, 0, 0, 0],
  };

  function samplePixelText(x, y, text, x0, y0, scale, spacing = 1) {
    const charStep = (5 + spacing) * scale;
    const rx = x - x0;
    const ry = y - y0;
    if (rx < 0 || ry < 0 || ry >= 7 * scale) return false;
    const charIdx = Math.floor(rx / charStep);
    if (charIdx < 0 || charIdx >= text.length) return false;
    const lx = Math.floor((rx - charIdx * charStep) / scale);
    const ly = Math.floor(ry / scale);
    if (lx < 0 || lx >= 5 || ly < 0 || ly >= 7) return false;
    const rows = PIXEL_FONT_5X7[text[charIdx]];
    if (!rows) return false;
    return ((rows[ly] >> (4 - lx)) & 1) !== 0;
  }

  // Wokecraft NoW Main Title Logo (`Interface/Glues/Common/Glues-WoW-Logo.blp`, 256×128)
  const wokecraftLogoBlp = createBlp2(256, 128, (x, y, w, h) => {
    const nx = (x - w * 0.5) / (w * 0.48);
    const ny = (y - h * 0.5) / (h * 0.44);
    const ellipse = Math.hypot(nx, ny);

    // 8-point Celandia Prism Star behind the cartouche
    const angle = Math.atan2(ny, nx);
    const starRay = (Math.cos(angle * 8.0) * 0.5 + 0.5) * 0.14;
    if (ellipse > 0.96 + starRay) return [0, 0, 0, 0];

    // Text layers: "WOKECRAFT" (scale 3), "NoW" (scale 3), and "CELANDIA" (scale 1)
    const isMainText = samplePixelText(x, y, 'WOKECRAFT', 48, 30, 3, 1);
    const isNowText = samplePixelText(x, y, 'NoW', 103, 60, 3, 1);
    const isSubText = samplePixelText(x, y, 'CELANDIA', 89, 92, 2, 1);
    const isShadow =
      samplePixelText(x - 2, y - 2, 'WOKECRAFT', 48, 30, 3, 1) ||
      samplePixelText(x - 2, y - 2, 'NoW', 103, 60, 3, 1) ||
      samplePixelText(x - 1, y - 1, 'CELANDIA', 89, 92, 2, 1);

    if (isMainText) {
      const sheen = 1.0 - (y - 30) / 21.0;
      return [
        255,
        Math.round(lerp(182, 244, clamp(sheen, 0, 1))),
        Math.round(lerp(218, 250, clamp(sheen, 0, 1))),
        255,
      ];
    }
    if (isNowText) {
      return [143, 214, 240, 255]; // Frostbell Cyan highlight
    }
    if (isSubText) {
      return [245, 198, 224, 255];
    }
    if (isShadow) {
      return [14, 8, 28, 255];
    }

    // Ornate Rose-Gold & Frostbell double-bezel cartouche rim
    if (ellipse > 0.85) {
      const rimGlow = Math.sin(angle * 4.0) * 0.5 + 0.5;
      return [
        Math.round(lerp(245, 143, rimGlow * 0.35)),
        Math.round(lerp(154, 214, rimGlow * 0.35)),
        Math.round(lerp(184, 240, rimGlow * 0.35)),
        255,
      ];
    }
    if (ellipse > 0.79) {
      return [255, 232, 244, 255];
    }

    // Inner Twilight Plum & Nocturnum Violaceous enamel field
    const radialGlow = clamp(1.0 - ellipse / 0.79, 0.0, 1.0);
    return [
      Math.round(lerp(24, 78, radialGlow)),
      Math.round(lerp(16, 44, radialGlow)),
      Math.round(lerp(48, 118, radialGlow)),
      246,
    ];
  });
  writeFile('Interface/Glues/Common/Glues-WoW-Logo.blp', wokecraftLogoBlp);

  // Glues & Character Create emblems + cursors + fallback icons
  const crestBlp = createBlp2(128, 128, (x, y) => {
    const nx = (x - 63.5) / 63.5;
    const ny = (y - 63.5) / 63.5;
    const d = Math.hypot(nx, ny);
    if (d > 0.92) return [0, 0, 0, 0];
    if (samplePixelText(x, y, 'XIRTUS', 22, 54, 2, 1)) {
      return [255, 242, 248, 255];
    }
    if (d > 0.78) return [245, 174, 206, 255];
    const petals = Math.sin(Math.atan2(ny, nx) * 8.0) * 0.5 + 0.5;
    return [
      Math.round(lerp(68, 245, petals * (1.0 - d * 0.45))),
      Math.round(lerp(48, 154, petals * (1.0 - d * 0.45))),
      Math.round(lerp(118, 214, petals * (1.0 - d * 0.45))),
      255,
    ];
  });
  writeFile('Interface/Glues/MainMenu/Glues-XirtusLogo.blp', crestBlp);
  writeFile('Interface/Glues/CharacterCreate/UI-CharacterCreate-Factions.blp', crestBlp);
  writeFile('Interface/Glues/CharacterCreate/UI-CharacterCreate-Classes.blp', crestBlp);
  writeFile('Interface/Glues/CharacterCreate/UI-CharacterCreate-Races.blp', crestBlp);
  writeFile('Interface/Glues/CharacterCreate/UI-CharacterCreate-Gender.blp', createBlp2(64, 32, () => [245, 174, 206, 255]));

  // PaperDoll, Container, Quest, and Chat frame backgrounds
  const panelQuarterBlp = createBlp2(128, 128, (x, y, w, h) => {
    const edge = x < 4 || x >= w - 4 || y < 4 || y >= h - 4;
    return edge ? [228, 188, 112, 255] : [38, 30, 58, 238];
  });
  for (const suffix of ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']) {
    writeFile(`Interface/PaperDollInfoFrame/UI-Character-General-${suffix}.blp`, panelQuarterBlp);
  }
  writeFile('Interface/PaperDollInfoFrame/UI-Character-ActiveTab.blp', btnUp);
  writeFile('Interface/PaperDollInfoFrame/UI-Character-InActiveTab.blp', btnDown);
  writeFile('Interface/ContainerFrame/UI-BackpackBackground.blp', panelQuarterBlp);
  for (const suffix of ['TopLeft', 'TopRight', 'BotLeft', 'BotRight']) {
    writeFile(`Interface/QuestFrame/UI-QuestGreeting-${suffix}.blp`, panelQuarterBlp);
  }
  writeFile('Interface/ChatFrame/UI-ChatInputBorder-Left.blp', btnUp);
  writeFile('Interface/ChatFrame/UI-ChatInputBorder-Right.blp', btnUp);

  // Cursors (`Interface/Cursor/*.blp`)
  const cursorBlp = createBlp2(32, 32, (x, y) => {
    if (x >= 2 && y >= 2 && x + y < 24 && Math.abs(x - y) < 8) {
      const rim = x === 2 || y === 2 || x + y === 23;
      return rim ? [56, 38, 74, 255] : [255, 228, 148, 255];
    }
    return [0, 0, 0, 0];
  });
  for (const cName of [
    'Point', 'Attack', 'Buy', 'Speak', 'Pickup', 'Interact',
    'Inspect', 'LootAll', 'Repair', 'Taxi', 'Trainer', 'Quest', 'QuestRepeatable',
  ]) {
    writeFile(`Interface/Cursor/${cName}.blp`, cursorBlp);
  }

  // Fallback question-mark & temp icons
  const qIconBlp = createBlp2(32, 32, (x, y, w, h) => {
    if (x < 2 || x >= w - 2 || y < 2 || y >= h - 2) return [228, 188, 112, 255];
    const d = Math.hypot(x - 15.5, y - 15.5);
    return d < 8 ? [245, 154, 184, 255] : [48, 36, 72, 255];
  });
  writeFile('Interface/InventoryItems/WoWUnknownItem01.blp', qIconBlp);
  writeFile('Interface/Icons/INV_Misc_QuestionMark.blp', qIconBlp);
  writeFile('Interface/Icons/Temp.blp', qIconBlp);
}

// ============================================================================
// 4. Default Keybindings (`WoW/Data/WTF/DefaultBindings.wtf`)
// ============================================================================

/**
 * Generates `WoW/Data/WTF/DefaultBindings.wtf` with >115 canonical 1.12 keybindings.
 * Every key token strictly satisfies `normalize_binding_key(k) == Some(k)` and `Chord::parse(k).is_some()`.
 */
function buildDefaultBindingsWtf(writeFile) {
  const bindings = [
    // Movement & Camera Steering
    ['W', 'MOVEFORWARD'],
    ['UP', 'MOVEFORWARD'],
    ['S', 'MOVEBACKWARD'],
    ['DOWN', 'MOVEBACKWARD'],
    ['A', 'TURNLEFT'],
    ['LEFT', 'TURNLEFT'],
    ['D', 'TURNRIGHT'],
    ['RIGHT', 'TURNRIGHT'],
    ['Q', 'STRAFELEFT'],
    ['E', 'STRAFERIGHT'],
    ['SPACE', 'JUMP'],
    ['X', 'SITORSTAND'],
    ['Z', 'TOGGLESHEATH'],
    ['NUMLOCK', 'TOGGLEAUTORUN'],
    ['BUTTON4', 'TOGGLEAUTORUN'],
    ['BUTTON3', 'MOVEANDSTEER'],
    ['INSERT', 'PITCHUP'],
    ['DELETE', 'PITCHDOWN'],
    ['/', 'OPENCHATSLASH'],
    ['ENTER', 'OPENCHAT'],
    ['ESCAPE', 'TOGGLEGAMEMENU'],

    // Primary Action Bar (Slots 1..12 + Pages)
    ['1', 'ACTIONBUTTON1'],
    ['2', 'ACTIONBUTTON2'],
    ['3', 'ACTIONBUTTON3'],
    ['4', 'ACTIONBUTTON4'],
    ['5', 'ACTIONBUTTON5'],
    ['6', 'ACTIONBUTTON6'],
    ['7', 'ACTIONBUTTON7'],
    ['8', 'ACTIONBUTTON8'],
    ['9', 'ACTIONBUTTON9'],
    ['0', 'ACTIONBUTTON10'],
    ['-', 'ACTIONBUTTON11'],
    ['=', 'ACTIONBUTTON12'],
    ['SHIFT-1', 'ACTIONPAGE1'],
    ['SHIFT-2', 'ACTIONPAGE2'],
    ['SHIFT-3', 'ACTIONPAGE3'],
    ['SHIFT-4', 'ACTIONPAGE4'],
    ['SHIFT-5', 'ACTIONPAGE5'],
    ['SHIFT-6', 'ACTIONPAGE6'],
    ['SHIFT-UP', 'PREVIOUSACTIONPAGE'],
    ['SHIFT-DOWN', 'NEXTACTIONPAGE'],
    ['SHIFT-MOUSEWHEELUP', 'PREVIOUSACTIONPAGE'],
    ['SHIFT-MOUSEWHEELDOWN', 'NEXTACTIONPAGE'],

    // Bonus / Pet / Shapeshift Action Buttons
    ['CTRL-1', 'BONUSACTIONBUTTON1'],
    ['CTRL-2', 'BONUSACTIONBUTTON2'],
    ['CTRL-3', 'BONUSACTIONBUTTON3'],
    ['CTRL-4', 'BONUSACTIONBUTTON4'],
    ['CTRL-5', 'BONUSACTIONBUTTON5'],
    ['CTRL-6', 'BONUSACTIONBUTTON6'],
    ['CTRL-7', 'BONUSACTIONBUTTON7'],
    ['CTRL-8', 'BONUSACTIONBUTTON8'],
    ['CTRL-9', 'BONUSACTIONBUTTON9'],
    ['CTRL-0', 'BONUSACTIONBUTTON10'],
    ['CTRL-F1', 'SHAPESHIFTBUTTON1'],
    ['CTRL-F2', 'SHAPESHIFTBUTTON2'],
    ['CTRL-F3', 'SHAPESHIFTBUTTON3'],
    ['CTRL-F4', 'SHAPESHIFTBUTTON4'],
    ['CTRL-F5', 'SHAPESHIFTBUTTON5'],
    ['CTRL-F6', 'SHAPESHIFTBUTTON6'],
    ['CTRL-F7', 'SHAPESHIFTBUTTON7'],
    ['CTRL-F8', 'SHAPESHIFTBUTTON8'],
    ['CTRL-F9', 'SHAPESHIFTBUTTON9'],
    ['CTRL-F10', 'SHAPESHIFTBUTTON10'],

    // Targeting & Assist
    ['TAB', 'TARGETNEARESTENEMY'],
    ['SHIFT-TAB', 'TARGETPREVIOUSENEMY'],
    ['CTRL-TAB', 'TARGETNEARESTFRIEND'],
    ['CTRL-SHIFT-TAB', 'TARGETPREVIOUSFRIEND'],
    ['F1', 'TARGETSELF'],
    ['F2', 'TARGETPARTYMEMBER1'],
    ['F3', 'TARGETPARTYMEMBER2'],
    ['F4', 'TARGETPARTYMEMBER3'],
    ['F5', 'TARGETPARTYMEMBER4'],
    ['SHIFT-F1', 'TARGETPET'],
    ['SHIFT-F2', 'TARGETPARTYPET1'],
    ['SHIFT-F3', 'TARGETPARTYPET2'],
    ['SHIFT-F4', 'TARGETPARTYPET3'],
    ['SHIFT-F5', 'TARGETPARTYPET4'],
    ['F', 'ASSISTTARGET'],
    ['G', 'TARGETLASTHOSTILE'],
    ['V', 'NAMEPLATES'],
    ['SHIFT-V', 'FRIENDNAMEPLATES'],
    ['CTRL-V', 'ALLNAMEPLATES'],
    ['T', 'ATTACKTARGET'],
    ['SHIFT-T', 'PETATTACK'],

    // RPG Mode Panels, World Map (`M`), Bags (`B`), Character (`C`), Spellbook (`P`), Talents (`N`), QuestLog (`L`)
    ['M', 'TOGGLEWORLDMAP'],
    ['B', 'TOGGLEBACKPACK'],
    ['SHIFT-B', 'OPENALLBAGS'],
    ['F8', 'TOGGLEBAG1'],
    ['F9', 'TOGGLEBAG2'],
    ['F10', 'TOGGLEBAG3'],
    ['F11', 'TOGGLEBAG4'],
    ['C', 'TOGGLECHARACTER0'],
    ['SHIFT-C', 'TOGGLECHARACTER1'],
    ['K', 'TOGGLECHARACTER2'],
    ['SHIFT-P', 'TOGGLECHARACTER3'],
    ['U', 'TOGGLECHARACTER4'],
    ['H', 'TOGGLECHARACTER4'],
    ['P', 'TOGGLESPELLBOOK'],
    ['SHIFT-I', 'TOGGLEPETBOOK'],
    ['N', 'TOGGLETALENTS'],
    ['L', 'TOGGLEQUESTLOG'],
    ['O', 'TOGGLESOCIAL'],
    ['SHIFT-O', 'TOGGLECHANNELPULLOUT'],
    ['J', 'TOGGLEGUILDTAB'],
    ['I', 'TOGGLERAIDTAB'],
    ['SHIFT-M', 'TOGGLEBATTLEFIELDMINIMAP'],
    ['=', 'MINIMAPZOOMIN'],
    ['-', 'MINIMAPZOOMOUT'],

    // Camera Zoom & View Presets
    ['MOUSEWHEELUP', 'CAMERAZOOMIN'],
    ['MOUSEWHEELDOWN', 'CAMERAZOOMOUT'],
    ['END', 'NEXTVIEW'],
    ['HOME', 'PREVVIEW'],
    ['*', 'FLIPCAMERAYAW'],

    // Chat, Combat Log, Sound, UI Visibility & System Shortcuts
    ['PAGEUP', 'CHATPAGEUP'],
    ['PAGEDOWN', 'CHATPAGEDOWN'],
    ['SHIFT-PAGEDOWN', 'CHATBOTTOM'],
    ['R', 'REPLY'],
    ['SHIFT-R', 'REPLY2'],
    ['CTRL-R', 'TOGGLEFPS'],
    ['CTRL-S', 'TOGGLESOUND'],
    ['CTRL-M', 'TOGGLEMUSIC'],
    ['ALT-Z', 'TOGGLEUI'],
    ['F12', 'SCREENSHOT'],
    ['NUMPAD0', 'RAIDTARGETNONE'],
    ['NUMPAD1', 'RAIDTARGET8'],
    ['NUMPAD2', 'RAIDTARGET7'],
    ['NUMPAD3', 'RAIDTARGET6'],
    ['NUMPAD4', 'RAIDTARGET5'],
    ['NUMPAD5', 'RAIDTARGET4'],
    ['NUMPAD6', 'RAIDTARGET3'],
    ['NUMPAD7', 'RAIDTARGET2'],
    ['NUMPAD8', 'RAIDTARGET1'],
  ];

  // Deduplicate by key token while preserving order (e.g. `=` and `-` stay bound to ACTIONBUTTON11/12)
  const seenKeys = new Set();
  const lines = [];
  for (const [key, action] of bindings) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    lines.push(`bind ${key} ${action}`);
  }

  writeFile('WTF/DefaultBindings.wtf', Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'));
}

// ============================================================================
// Main Entrypoint: `buildCelandiaUi`
// ============================================================================

export function buildCelandiaUi(writeFile, WdbcBuilder, f32, createBlp2, sampleHeight, BIOMES) {
  console.log('[UI] Building painted Celandia World Map tiles, Loading Screens, RPG UI Chrome & DefaultBindings.wtf...');

  // 1. Render painted 1002x668 cartographic maps sliced into 4x3 256x256 BLP2 tiles
  // Cosmic / World overview (`Interface/WorldMap/World/World1..12.blp`)
  renderAndSliceWorldMapTiles(writeFile, createBlp2, 'World', 'World', CONTINENT_BOUNDS, 0);

  // Continent overview (`Interface/WorldMap/Celandia/Celandia1..12.blp`)
  renderAndSliceWorldMapTiles(writeFile, createBlp2, 'Celandia', 'Celandia', CONTINENT_BOUNDS, 0);

  // Alias continent tiles under `Azeroth` and `Kalimdor` for compatibility
  renderAndSliceWorldMapTiles(writeFile, createBlp2, 'Azeroth', 'Azeroth', CONTINENT_BOUNDS, 0);
  renderAndSliceWorldMapTiles(writeFile, createBlp2, 'Kalimdor', 'Kalimdor', CONTINENT_BOUNDS, 0);

  // 5 Celandia Island Kingdom detail maps (`PorcelainWake`, `FrostbellLagoon`, `GlasswakeMesas`, `AureateReach`, `NocturnumIsle`)
  for (const z of CELANDIA_WORLD_MAP_ZONES) {
    renderAndSliceWorldMapTiles(
      writeFile,
      createBlp2,
      z.areaName,
      z.areaName,
      {
        locLeft: z.locLeft,
        locRight: z.locRight,
        locTop: z.locTop,
        locBottom: z.locBottom,
      },
      z.areaId
    );
  }

  // 2. Build 128x128 u32 Zone Map (`Interface/WorldMap/Celandia.zmp`)
  buildCelandiaZmp(writeFile);

  // 3. Build WorldMapArea.dbc, WorldMapContinent.dbc, WorldMapOverlay.dbc, LoadingScreens.dbc, ItemClass.dbc, AuctionHouse.dbc
  buildWorldMapAndUiDbcs(writeFile, WdbcBuilder, f32);

  // 4. Build Loading Screens & Porcelain-and-Rose-Gold RPG UI Chrome BLP2 textures
  buildLoadingScreensAndUiChrome(writeFile, createBlp2);

  // 5. Build WTF/DefaultBindings.wtf
  buildDefaultBindingsWtf(writeFile);
}
