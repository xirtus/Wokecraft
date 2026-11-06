#!/usr/bin/env node
/**
 * Build Celandia Multi-Room Enterable Binary `.wmo` Buildings, Architectural `.blp` Textures,
 * Interior `.glb` (`.m2`/`.mdx`) Furniture Doodads, `WMOAreaTable.dbc`, and Instanced Map 1
 * (`World/Maps/Elsewhere/Elsewhere.wdt` + `.adt`) for Xirtoth (`benilla`).
 *
 * Can be imported by `scripts/build-celandia-data.mjs`:
 *   import { buildCelandiaWmosAndElsewhere } from './build-celandia-wmo.mjs';
 * or executed standalone:
 *   node scripts/build-celandia-wmo.mjs [--test]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, 'WoW', 'Data');

const CELANDIA_DIR = '/Users/xmacbookm5/Projects/j3games/Celandia';
const REINCARNATION_DIR = '/Users/xmacbookm5/Projects/j3games/reincarnation';

const MAP_CENTER = 17066.666;
const TILE_SIZE = 533.33333;
const CHUNK_SIZE = TILE_SIZE / 16.0;

// ============================================================================
// 0. Fallback Helpers (used when invoked standalone or if omitted from `ctx`)
// ============================================================================

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function defaultWriteFile(dataDir, relPath, buffer) {
  const full = path.join(dataDir, ...relPath.split(/[\\/]/));
  ensureDir(full);
  fs.writeFileSync(full, buffer);
}

function defaultF32(v) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v, 0);
  return b.readUInt32LE(0);
}

function defaultCreateBlp2(width, height, pixelFn) {
  const headerSize = 148;
  const paletteSize = 1024;
  const pixelBytes = width * height * 4;
  const buf = Buffer.alloc(headerSize + paletteSize + pixelBytes, 0);

  buf.write('BLP2', 0, 4, 'ascii');
  buf.writeUInt32LE(1, 4); // version = 1
  buf.writeUInt8(3, 8); // compression = 3 (Raw3 BGRA8)
  buf.writeUInt8(8, 9); // alpha_depth = 8
  buf.writeUInt8(0, 10); // alpha_type = 0
  buf.writeUInt8(0, 11); // has_mips = 0
  buf.writeUInt32LE(width, 12);
  buf.writeUInt32LE(height, 16);
  buf.writeUInt32LE(headerSize + paletteSize, 20); // mip_offsets[0]
  buf.writeUInt32LE(pixelBytes, 84); // mip_sizes[0]

  const dataOffset = headerSize + paletteSize;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const idx = dataOffset + (y * width + x) * 4;
      buf[idx + 0] = Math.max(0, Math.min(255, b | 0));
      buf[idx + 1] = Math.max(0, Math.min(255, g | 0));
      buf[idx + 2] = Math.max(0, Math.min(255, r | 0));
      buf[idx + 3] = Math.max(0, Math.min(255, (a ?? 255) | 0));
    }
  }
  return buf;
}

class DefaultWdbcBuilder {
  constructor(fieldCount, stringCols = []) {
    this.fieldCount = fieldCount;
    this.stringCols = new Set(stringCols);
    this.rows = [];
    this.stringOffsets = new Map([['', 0]]);
    this.stringChunks = [Buffer.from([0])];
    this.stringLen = 1;
  }

  addString(s) {
    const str = String(s ?? '');
    if (this.stringOffsets.has(str)) return this.stringOffsets.get(str);
    const off = this.stringLen;
    const buf = Buffer.from(str + '\0', 'utf8');
    this.stringChunks.push(buf);
    this.stringLen += buf.length;
    this.stringOffsets.set(str, off);
    return off;
  }

  addRow(fieldsObjOrArr) {
    const rec = Buffer.alloc(this.fieldCount * 4, 0);
    for (let c = 0; c < this.fieldCount; c++) {
      const val = fieldsObjOrArr[c];
      if (this.stringCols.has(c)) {
        const off = this.addString(val ?? '');
        rec.writeUInt32LE(off, c * 4);
      } else if (val !== undefined && val !== null) {
        if (typeof val === 'number') {
          if (val < 0) rec.writeInt32LE(val | 0, c * 4);
          else rec.writeUInt32LE(val >>> 0, c * 4);
        }
      }
    }
    this.rows.push(rec);
  }

  toBuffer() {
    const recordSize = this.fieldCount * 4;
    const stringBlock = Buffer.concat(this.stringChunks);
    const hdr = Buffer.alloc(20);
    hdr.write('WDBC', 0, 4, 'ascii');
    hdr.writeUInt32LE(this.rows.length, 4);
    hdr.writeUInt32LE(this.fieldCount, 8);
    hdr.writeUInt32LE(recordSize, 12);
    hdr.writeUInt32LE(stringBlock.length, 16);
    return Buffer.concat([hdr, ...this.rows, stringBlock]);
  }
}

function defaultBuildProceduralPartsGlb(parts) {
  const posList = [];
  const normList = [];
  const uvList = [];
  const colList = [];
  const idxList = [];
  let vOffset = 0;

  for (const part of parts) {
    const { geo, color = [1, 1, 1], translate = [0, 0, 0], scale = [1, 1, 1], rotY = 0 } = part;
    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const cy = Math.cos(rotY);
    const sy = Math.sin(rotY);

    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i) * scale[0];
      const ly = pos.getY(i) * scale[1];
      const lz = pos.getZ(i) * scale[2];
      const rx = lx * cy + lz * sy + translate[0];
      const ry = ly + translate[1];
      const rz = -lx * sy + lz * cy + translate[2];
      posList.push(rx, ry, rz);

      const nx = norm ? norm.getX(i) : 0;
      const ny = norm ? norm.getY(i) : 1;
      const nz = norm ? norm.getZ(i) : 0;
      normList.push(nx * cy + nz * sy, ny, -nx * sy + nz * cy);

      uvList.push(uv ? uv.getX(i) : 0.5, uv ? uv.getY(i) : 0.5);
      colList.push(color[0], color[1], color[2], 1.0);
    }

    if (geo.index) {
      const idx = geo.index.array;
      for (let i = 0; i < idx.length; i++) idxList.push(vOffset + idx[i]);
    } else {
      for (let i = 0; i < pos.count; i++) idxList.push(vOffset + i);
    }
    vOffset += pos.count;
  }

  const vCount = vOffset;
  const posArr = new Float32Array(posList);
  const normArr = new Float32Array(normList);
  const uvArr = new Float32Array(uvList);
  const colArr = new Float32Array(colList);
  const idxArr = new Uint16Array(idxList);

  const minPos = [Infinity, Infinity, Infinity];
  const maxPos = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = posArr[i * 3 + k];
      if (v < minPos[k]) minPos[k] = v;
      if (v > maxPos[k]) maxPos[k] = v;
    }
  }

  const chunks = [];
  const views = [];
  const accessors = [];
  let byteOffset = 0;

  function addAccessor(typedArr, componentType, type, count, target, min, max) {
    const raw = Buffer.from(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength);
    const pad = (4 - (raw.length % 4)) % 4;
    chunks.push(raw);
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
    const viewIdx = views.length;
    views.push({ buffer: 0, byteOffset, byteLength: raw.length, ...(target ? { target } : {}) });
    byteOffset += raw.length + pad;
    const accIdx = accessors.length;
    accessors.push({
      bufferView: viewIdx,
      componentType,
      count,
      type,
      ...(min ? { min } : {}),
      ...(max ? { max } : {}),
    });
    return accIdx;
  }

  const posAcc = addAccessor(posArr, 5126, 'VEC3', vCount, 34962, minPos, maxPos);
  const normAcc = addAccessor(normArr, 5126, 'VEC3', vCount, 34962);
  const uvAcc = addAccessor(uvArr, 5126, 'VEC2', vCount, 34962);
  const colAcc = addAccessor(colArr, 5126, 'VEC4', vCount, 34962);
  const idxAcc = addAccessor(idxArr, 5123, 'SCALAR', idxArr.length, 34963);

  const gltf = {
    asset: { version: '2.0', generator: 'xirtoth-celandia-wmo-builder' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'InteriorPropRoot', mesh: 0 }],
    materials: [
      {
        name: 'CelandiaInteriorMat',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0.18,
          roughnessFactor: 0.55,
        },
        doubleSided: true,
      },
    ],
    meshes: [
      {
        name: 'PropMesh',
        primitives: [
          {
            attributes: {
              POSITION: posAcc,
              NORMAL: normAcc,
              TEXCOORD_0: uvAcc,
              COLOR_0: colAcc,
            },
            indices: idxAcc,
            material: 0,
          },
        ],
      },
    ],
    buffers: [{ byteLength: byteOffset }],
    bufferViews: views,
    accessors,
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonPad = (4 - (Buffer.byteLength(jsonStr, 'utf8') % 4)) % 4;
  const jsonBuf = Buffer.from(jsonStr + ' '.repeat(jsonPad), 'utf8');
  const binBuf = Buffer.concat(chunks);

  const totalLength = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = Buffer.alloc(totalLength);
  out.write('glTF', 0, 4, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.write('JSON', 16, 4, 'ascii');
  jsonBuf.copy(out, 20);
  const binHeaderOff = 20 + jsonBuf.length;
  out.writeUInt32LE(binBuf.length, binHeaderOff);
  out.write('BIN\0', binHeaderOff + 4, 4, 'ascii');
  binBuf.copy(out, binHeaderOff + 8);
  return out;
}

// ============================================================================
// 1. Metadata for the 5 Enterable Celandia Buildings & 8 Interior Furniture Props
// ============================================================================

export const CELANDIA_WMO_TEXTURES = [
  'Textures/Celandia/WmoPorcelainMarble.blp',
  'Textures/Celandia/WmoRoseGoldTrim.blp',
  'Textures/Celandia/WmoFrostbellGlass.blp',
  'Textures/Celandia/WmoGlasswakeSandstone.blp',
  'Textures/Celandia/WmoAureateGold.blp',
  'Textures/Celandia/WmoNocturnumObsidian.blp',
];

export const CELANDIA_INTERIOR_DOODADS = [
  'World/Celandia/Interiors/PorcelainThrone.m2',
  'World/Celandia/Interiors/CrystalChandelier.m2',
  'World/Celandia/Interiors/FrostbellAstrolabe.m2',
  'World/Celandia/Interiors/GlasswakePrismAltar.m2',
  'World/Celandia/Interiors/AureateSunBrazier.m2',
  'World/Celandia/Interiors/NocturnumRiftGate.m2',
  'World/Celandia/Interiors/SilkBanner.m2',
  'World/Celandia/Interiors/PorcelainPillar.m2',
];

export const CELANDIA_BUILDINGS = [
  {
    key: 'PorcelainPalace',
    wmoId: 1001,
    areaId: 1,
    elsewhereAreaId: 10,
    rootPath: 'World/wmo/Celandia/PorcelainPalace/PorcelainPalace.wmo',
    mdxRefPath: 'World\\wmo\\Celandia\\PorcelainPalace\\PorcelainPalace.wmo',
    rootAreaName: 'Grand Porcelain Palace',
    exteriorGroupName: 'Porcelain Colonnade & Terrace',
    interiorGroupName: 'The Porcelain Throne Room',
    elsewhereInteriorName: 'Sanctum of the Porcelain Wake',
    // Zone 1 center in Celandia (Map 0)
    wx: 0.0,
    wy: 0.0,
    // Placement in Map 1 (The Elsewhere & Reincarnation Sanctum)
    elsewhereWx: 0.0,
    elsewhereWy: 0.0,
    wallTex: 'Textures\\Celandia\\WmoPorcelainMarble.blp',
    trimTex: 'Textures\\Celandia\\WmoRoseGoldTrim.blp',
    floorTex: 'Textures\\Celandia\\WmoPorcelainMarble.blp',
    wallColor: [248, 241, 232],
    trimColor: [232, 184, 152],
    floorColor: [242, 234, 224],
    liquidColor: [110, 215, 235, 195], // BGRA formatting handled in MOMT
    fogColor: [235, 224, 214],
    lightColor: [255, 228, 192],
    centerpieceMdx: 'World\\Celandia\\Interiors\\PorcelainThrone.mdx',
    secondaryMdx: 'World\\Celandia\\Interiors\\PorcelainPillar.mdx',
  },
  {
    key: 'FrostbellConservatory',
    wmoId: 1002,
    areaId: 2,
    elsewhereAreaId: 10,
    rootPath: 'World/wmo/Celandia/FrostbellConservatory/FrostbellConservatory.wmo',
    mdxRefPath: 'World\\wmo\\Celandia\\FrostbellConservatory\\FrostbellConservatory.wmo',
    rootAreaName: 'Frostbell Resonance Conservatory',
    exteriorGroupName: 'Frostbell Ice-Glass Rotunda',
    interiorGroupName: 'Resonance Chime Gallery',
    elsewhereInteriorName: 'Sanctum of the Frostbell Choir',
    wx: 430.0,
    wy: 470.0,
    elsewhereWx: 110.0,
    elsewhereWy: 110.0,
    wallTex: 'Textures\\Celandia\\WmoFrostbellGlass.blp',
    trimTex: 'Textures\\Celandia\\WmoPorcelainMarble.blp',
    floorTex: 'Textures\\Celandia\\WmoFrostbellGlass.blp',
    wallColor: [216, 238, 252],
    trimColor: [170, 218, 248],
    floorColor: [204, 232, 248],
    liquidColor: [120, 225, 255, 200],
    fogColor: [198, 230, 250],
    lightColor: [190, 236, 255],
    centerpieceMdx: 'World\\Celandia\\Interiors\\FrostbellAstrolabe.mdx',
    secondaryMdx: 'World\\Celandia\\Interiors\\PorcelainPillar.mdx',
  },
  {
    key: 'GlasswakeSanctum',
    wmoId: 1003,
    areaId: 3,
    elsewhereAreaId: 10,
    rootPath: 'World/wmo/Celandia/GlasswakeSanctum/GlasswakeSanctum.wmo',
    mdxRefPath: 'World\\wmo\\Celandia\\GlasswakeSanctum\\GlasswakeSanctum.wmo',
    rootAreaName: 'Glasswake Prism Sanctum',
    exteriorGroupName: 'Glasswake Sandstone Cloister',
    interiorGroupName: 'Hall of Refracting Prisms',
    elsewhereInteriorName: 'Sanctum of the Glasswake Prism',
    wx: -40.0,
    wy: -480.0,
    elsewhereWx: -110.0,
    elsewhereWy: -110.0,
    wallTex: 'Textures\\Celandia\\WmoGlasswakeSandstone.blp',
    trimTex: 'Textures\\Celandia\\WmoFrostbellGlass.blp',
    floorTex: 'Textures\\Celandia\\WmoGlasswakeSandstone.blp',
    wallColor: [236, 206, 166],
    trimColor: [104, 224, 214],
    floorColor: [224, 194, 152],
    liquidColor: [72, 228, 212, 195],
    fogColor: [215, 198, 168],
    lightColor: [152, 246, 232],
    centerpieceMdx: 'World\\Celandia\\Interiors\\GlasswakePrismAltar.mdx',
    secondaryMdx: 'World\\Celandia\\Interiors\\AureateSunBrazier.mdx',
  },
  {
    key: 'AureateBasilica',
    wmoId: 1004,
    areaId: 4,
    elsewhereAreaId: 10,
    rootPath: 'World/wmo/Celandia/AureateBasilica/AureateBasilica.wmo',
    mdxRefPath: 'World\\wmo\\Celandia\\AureateBasilica\\AureateBasilica.wmo',
    rootAreaName: 'Aureate Solar Basilica',
    exteriorGroupName: 'Gilded Travertine Portico',
    interiorGroupName: 'Sovereign Reliquary Chamber',
    elsewhereInteriorName: 'Sanctum of the Aureate Sun',
    wx: 500.0,
    wy: -330.0,
    elsewhereWx: 110.0,
    elsewhereWy: -110.0,
    wallTex: 'Textures\\Celandia\\WmoAureateGold.blp',
    trimTex: 'Textures\\Celandia\\WmoRoseGoldTrim.blp',
    floorTex: 'Textures\\Celandia\\WmoPorcelainMarble.blp',
    wallColor: [248, 224, 158],
    trimColor: [255, 206, 102],
    floorColor: [244, 228, 186],
    liquidColor: [110, 214, 245, 195],
    fogColor: [244, 218, 156],
    lightColor: [255, 222, 136],
    centerpieceMdx: 'World\\Celandia\\Interiors\\AureateSunBrazier.mdx',
    secondaryMdx: 'World\\Celandia\\Interiors\\PorcelainThrone.mdx',
  },
  {
    key: 'NocturnumCitadel',
    wmoId: 1005,
    areaId: 5,
    elsewhereAreaId: 10,
    rootPath: 'World/wmo/Celandia/NocturnumCitadel/NocturnumCitadel.wmo',
    mdxRefPath: 'World\\wmo\\Celandia\\NocturnumCitadel\\NocturnumCitadel.wmo',
    rootAreaName: 'Nocturnum Obsidian Citadel',
    exteriorGroupName: 'Obsidian Rampart & Threshold',
    interiorGroupName: 'Throne of the Elsewhere Rift',
    elsewhereInteriorName: 'Heart of the Elsewhere Rift',
    wx: -320.0,
    wy: 360.0,
    elsewhereWx: -110.0,
    elsewhereWy: 110.0,
    wallTex: 'Textures\\Celandia\\WmoNocturnumObsidian.blp',
    trimTex: 'Textures\\Celandia\\WmoRoseGoldTrim.blp',
    floorTex: 'Textures\\Celandia\\WmoNocturnumObsidian.blp',
    wallColor: [148, 128, 188],
    trimColor: [216, 142, 244],
    floorColor: [132, 114, 168],
    liquidColor: [165, 110, 245, 205],
    fogColor: [118, 92, 164],
    lightColor: [218, 156, 255],
    centerpieceMdx: 'World\\Celandia\\Interiors\\NocturnumRiftGate.mdx',
    secondaryMdx: 'World\\Celandia\\Interiors\\PorcelainThrone.mdx',
  },
];

// ============================================================================
// 2. Architectural `.blp` Texture Generator (6 Custom 64x64 BLP2 Textures)
// ============================================================================

function buildArchitecturalBlpTextures(writeFile, createBlp2) {
  // 1. WmoPorcelainMarble.blp — warm ivory porcelain slabs with rose-gold veining & ashlar joints
  writeFile(
    'Textures/Celandia/WmoPorcelainMarble.blp',
    createBlp2(64, 64, (x, y) => {
      const mortar = x % 32 === 0 || y % 16 === 0;
      const vein = Math.sin(x * 0.22 + Math.sin(y * 0.18) * 2.5) * 0.5 + 0.5;
      const shimmer = Math.cos((x - y) * 0.15) * 4;
      if (mortar) return [212, 186, 168, 255];
      return [
        242 + vein * 10 + shimmer,
        233 + vein * 8 + shimmer,
        224 + vein * 6 + shimmer,
        255,
      ];
    }),
  );

  // 2. WmoRoseGoldTrim.blp — brushed metallic rose-gold & filigree bands
  writeFile(
    'Textures/Celandia/WmoRoseGoldTrim.blp',
    createBlp2(64, 64, (x, y) => {
      const band = y < 8 || y >= 56 || (y >= 28 && y < 36);
      const flute = Math.sin(x * (Math.PI / 4)) * 16;
      const spec = Math.cos(y * 0.2) * 10;
      if (band) {
        return [246 + spec, 204 + spec, 162 + spec * 0.5, 255];
      }
      return [226 + flute, 174 + flute * 0.8, 146 + flute * 0.6, 255];
    }),
  );

  // 3. WmoFrostbellGlass.blp — crystalline cyan-silver resonance glass panels with silver mullions
  writeFile(
    'Textures/Celandia/WmoFrostbellGlass.blp',
    createBlp2(64, 64, (x, y) => {
      const mullion = x % 16 === 0 || y % 16 === 0 || Math.abs((x % 16) - (y % 16)) === 0;
      const facet = Math.sin(x * 0.35) * Math.cos(y * 0.35) * 18;
      if (mullion) return [230, 244, 255, 255];
      return [178 + facet, 224 + facet, 248 + facet * 0.5, 255];
    }),
  );

  // 4. WmoGlasswakeSandstone.blp — warm desert sandstone blocks inlaid with turquoise glass veins
  writeFile(
    'Textures/Celandia/WmoGlasswakeSandstone.blp',
    createBlp2(64, 64, (x, y) => {
      const inlay = (y % 32 === 15 || y % 32 === 16) || (x % 32 === 0 && y % 16 < 12);
      const grain = Math.sin(y * 0.4 + Math.cos(x * 0.25) * 1.8) * 12;
      if (inlay) return [76, 226, 212, 255];
      return [230 + grain, 196 + grain * 0.8, 152 + grain * 0.6, 255];
    }),
  );

  // 5. WmoAureateGold.blp — sun-forged gilded travertine & radiant solar reliefs
  writeFile(
    'Textures/Celandia/WmoAureateGold.blp',
    createBlp2(64, 64, (x, y) => {
      const dx = x - 32;
      const dy = y - 32;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const sunray = Math.cos(angle * 12) * 14 * Math.exp(-dist * 0.04);
      const border = x < 4 || x >= 60 || y < 4 || y >= 60;
      if (border) return [255, 224, 132, 255];
      return [244 + sunray, 210 + sunray * 0.9, 128 + sunray * 0.5, 255];
    }),
  );

  // 6. WmoNocturnumObsidian.blp — polished volcanic obsidian with glowing amethyst-violet runes
  writeFile(
    'Textures/Celandia/WmoNocturnumObsidian.blp',
    createBlp2(64, 64, (x, y) => {
      const rune =
        (x % 32 === 16 && y % 16 > 3 && y % 16 < 13) ||
        (y % 32 === 16 && x % 16 > 3 && x % 16 < 13);
      const sheen = Math.sin((x + y) * 0.25) * 10;
      if (rune) return [214, 132, 255, 255];
      return [68 + sheen, 56 + sheen, 96 + sheen * 1.4, 255];
    }),
  );
}

// ============================================================================
// 3. Interior Furniture & Prop Doodad `.glb` Models (`.m2` files)
// ============================================================================

function buildInteriorFurnitureModels(writeFile, THREE, buildProceduralPartsGlb) {
  // 1. PorcelainThrone.m2 — High-backed royal porcelain & rose-gold sovereign throne on stepped plinth
  writeFile(
    'World/Celandia/Interiors/PorcelainThrone.m2',
    buildProceduralPartsGlb([
      { geo: new THREE.BoxGeometry(2.6, 0.35, 2.4), color: [0.95, 0.92, 0.88], translate: [0, 0.175, 0] },
      { geo: new THREE.BoxGeometry(2.0, 0.3, 1.9), color: [0.88, 0.68, 0.54], translate: [0, 0.5, 0] },
      { geo: new THREE.BoxGeometry(1.45, 0.75, 1.35), color: [0.96, 0.94, 0.9], translate: [0, 1.0, -0.05] },
      { geo: new THREE.BoxGeometry(1.3, 0.16, 1.2), color: [0.78, 0.24, 0.38], translate: [0, 1.42, 0.0] },
      { geo: new THREE.BoxGeometry(0.24, 0.7, 1.35), color: [0.9, 0.72, 0.56], translate: [-0.75, 1.65, -0.02] },
      { geo: new THREE.BoxGeometry(0.24, 0.7, 1.35), color: [0.9, 0.72, 0.56], translate: [0.75, 1.65, -0.02] },
      { geo: new THREE.BoxGeometry(1.5, 2.8, 0.28), color: [0.97, 0.95, 0.92], translate: [0, 2.65, -0.58] },
      { geo: new THREE.CylinderGeometry(0.85, 0.85, 0.22, 16), color: [0.92, 0.74, 0.58], translate: [0, 4.15, -0.58] },
      { geo: new THREE.ConeGeometry(0.32, 0.95, 8), color: [0.95, 0.8, 0.45], translate: [-0.68, 4.35, -0.58] },
      { geo: new THREE.ConeGeometry(0.32, 0.95, 8), color: [0.95, 0.8, 0.45], translate: [0.68, 4.35, -0.58] },
      { geo: new THREE.OctahedronGeometry(0.38, 1), color: [0.55, 0.92, 0.98], translate: [0, 4.75, -0.52] },
    ]),
  );

  // 2. CrystalChandelier.m2 — Multi-tier suspended rose-gold & luminous crystal chandelier
  writeFile(
    'World/Celandia/Interiors/CrystalChandelier.m2',
    buildProceduralPartsGlb([
      { geo: new THREE.CylinderGeometry(0.08, 0.08, 2.2, 8), color: [0.92, 0.76, 0.54], translate: [0, 1.9, 0] },
      { geo: new THREE.TorusGeometry(1.65, 0.11, 10, 24), color: [0.94, 0.78, 0.52], translate: [0, 1.1, 0] },
      { geo: new THREE.TorusGeometry(1.05, 0.09, 10, 20), color: [0.96, 0.82, 0.58], translate: [0, 0.55, 0] },
      { geo: new THREE.OctahedronGeometry(0.45, 1), color: [0.98, 0.95, 0.82], translate: [0, 0.1, 0] },
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const a = (i * Math.PI) / 4;
        return {
          geo: new THREE.OctahedronGeometry(0.24, 0),
          color: [0.78, 0.96, 1.0],
          translate: [Math.cos(a) * 1.65, 0.85, Math.sin(a) * 1.65],
        };
      }),
    ]),
  );

  // 3. FrostbellAstrolabe.m2 — Celestial armillary sphere & resonance chime pedestal
  writeFile(
    'World/Celandia/Interiors/FrostbellAstrolabe.m2',
    buildProceduralPartsGlb([
      { geo: new THREE.CylinderGeometry(1.35, 1.6, 0.45, 12), color: [0.85, 0.93, 0.98], translate: [0, 0.225, 0] },
      { geo: new THREE.CylinderGeometry(0.45, 0.65, 1.4, 12), color: [0.76, 0.88, 0.96], translate: [0, 1.15, 0] },
      { geo: new THREE.TorusGeometry(1.55, 0.1, 12, 28), color: [0.68, 0.9, 1.0], translate: [0, 3.1, 0], rotY: 0.3 },
      { geo: new THREE.TorusGeometry(1.25, 0.08, 12, 24), color: [0.92, 0.82, 0.62], translate: [0, 3.1, 0], rotY: 1.35 },
      { geo: new THREE.OctahedronGeometry(0.58, 1), color: [0.45, 0.95, 1.0], translate: [0, 3.1, 0] },
      { geo: new THREE.ConeGeometry(0.28, 1.1, 8), color: [0.85, 0.96, 1.0], translate: [0, 4.95, 0] },
    ]),
  );

  // 4. GlasswakePrismAltar.m2 — Stepped sandstone & turquoise refracting prism sanctuary altar
  writeFile(
    'World/Celandia/Interiors/GlasswakePrismAltar.m2',
    buildProceduralPartsGlb([
      { geo: new THREE.BoxGeometry(3.2, 0.4, 2.2), color: [0.88, 0.76, 0.6], translate: [0, 0.2, 0] },
      { geo: new THREE.BoxGeometry(2.5, 0.9, 1.6), color: [0.92, 0.82, 0.66], translate: [0, 0.85, 0] },
      { geo: new THREE.BoxGeometry(2.7, 0.18, 1.8), color: [0.32, 0.88, 0.82], translate: [0, 1.38, 0] },
      { geo: new THREE.OctahedronGeometry(0.75, 0), color: [0.28, 0.95, 0.88], translate: [0, 2.55, 0], scale: [0.8, 1.45, 0.8] },
      { geo: new THREE.OctahedronGeometry(0.38, 0), color: [0.98, 0.88, 0.52], translate: [-0.95, 2.05, 0], scale: [0.7, 1.3, 0.7] },
      { geo: new THREE.OctahedronGeometry(0.38, 0), color: [0.98, 0.88, 0.52], translate: [0.95, 2.05, 0], scale: [0.7, 1.3, 0.7] },
    ]),
  );

  // 5. AureateSunBrazier.m2 — Gilded solar tripod brazier with eternal golden flame
  writeFile(
    'World/Celandia/Interiors/AureateSunBrazier.m2',
    buildProceduralPartsGlb([
      { geo: new THREE.CylinderGeometry(0.95, 1.15, 0.35, 10), color: [0.94, 0.82, 0.52], translate: [0, 0.175, 0] },
      { geo: new THREE.CylinderGeometry(0.32, 0.48, 1.65, 10), color: [0.92, 0.74, 0.38], translate: [0, 1.15, 0] },
      { geo: new THREE.CylinderGeometry(1.1, 0.55, 0.55, 12), color: [0.96, 0.82, 0.42], translate: [0, 2.15, 0] },
      { geo: new THREE.ConeGeometry(0.68, 1.45, 10), color: [1.0, 0.86, 0.32], translate: [0, 3.05, 0] },
      { geo: new THREE.OctahedronGeometry(0.42, 1), color: [1.0, 0.96, 0.72], translate: [0, 2.75, 0] },
    ]),
  );

  // 6. NocturnumRiftGate.m2 — Twin obsidian spires & luminous violet Elsewhere portal ring
  writeFile(
    'World/Celandia/Interiors/NocturnumRiftGate.m2',
    buildProceduralPartsGlb([
      { geo: new THREE.BoxGeometry(4.4, 0.45, 1.8), color: [0.28, 0.22, 0.38], translate: [0, 0.225, 0] },
      { geo: new THREE.CylinderGeometry(0.35, 0.52, 4.6, 8), color: [0.24, 0.18, 0.34], translate: [-1.65, 2.5, 0] },
      { geo: new THREE.CylinderGeometry(0.35, 0.52, 4.6, 8), color: [0.24, 0.18, 0.34], translate: [1.65, 2.5, 0] },
      { geo: new THREE.ConeGeometry(0.45, 1.2, 8), color: [0.78, 0.45, 0.96], translate: [-1.65, 5.35, 0] },
      { geo: new THREE.ConeGeometry(0.45, 1.2, 8), color: [0.78, 0.45, 0.96], translate: [1.65, 5.35, 0] },
      { geo: new THREE.TorusGeometry(1.45, 0.16, 12, 28), color: [0.84, 0.48, 1.0], translate: [0, 2.85, 0] },
      { geo: new THREE.OctahedronGeometry(0.85, 1), color: [0.62, 0.88, 1.0], translate: [0, 2.85, 0], scale: [1.1, 1.4, 0.25] },
    ]),
  );

  // 7. SilkBanner.m2 — Hanging royal Celandia tapestry banner on gilded crossbar
  writeFile(
    'World/Celandia/Interiors/SilkBanner.m2',
    buildProceduralPartsGlb([
      { geo: new THREE.CylinderGeometry(0.08, 0.08, 4.8, 8), color: [0.9, 0.74, 0.48], translate: [0, 2.4, 0] },
      { geo: new THREE.BoxGeometry(1.6, 0.12, 0.12), color: [0.94, 0.78, 0.52], translate: [0, 4.55, 0] },
      { geo: new THREE.BoxGeometry(1.35, 3.2, 0.06), color: [0.86, 0.34, 0.48], translate: [0, 2.85, 0.08] },
      { geo: new THREE.BoxGeometry(0.95, 2.6, 0.08), color: [0.96, 0.84, 0.58], translate: [0, 2.9, 0.09] },
    ]),
  );

  // 8. PorcelainPillar.m2 — Fluted interior marble column with rose-gold base & capital
  writeFile(
    'World/Celandia/Interiors/PorcelainPillar.m2',
    buildProceduralPartsGlb([
      { geo: new THREE.BoxGeometry(1.5, 0.45, 1.5), color: [0.9, 0.72, 0.56], translate: [0, 0.225, 0] },
      { geo: new THREE.CylinderGeometry(0.52, 0.58, 6.2, 14), color: [0.96, 0.94, 0.9], translate: [0, 3.55, 0] },
      { geo: new THREE.CylinderGeometry(0.76, 0.54, 0.55, 14), color: [0.92, 0.75, 0.58], translate: [0, 6.9, 0] },
      { geo: new THREE.BoxGeometry(1.55, 0.35, 1.55), color: [0.95, 0.92, 0.88], translate: [0, 7.35, 0] },
    ]),
  );
}

// ============================================================================
// 4. Binary WMO v17 Compiler (`Root.wmo`, `_000.wmo` Exterior, `_001.wmo` Interior)
// ============================================================================

function wmoChunk(fourCC, payload) {
  const rev = fourCC.split('').reverse().join('');
  const hdr = Buffer.alloc(8);
  hdr.write(rev, 0, 4, 'ascii');
  hdr.writeUInt32LE(payload.length, 4);
  return Buffer.concat([hdr, payload]);
}

/**
 * Mesh builder for a single WMO group (`_000.wmo` or `_001.wmo`).
 * Coordinates in WMO files are WoW local coordinates:
 *   +X = North / Front entrance axis
 *   +Y = West / Left axis
 *   +Z = Up / Vertical height axis
 * Counter-clockwise winding when viewed from the front/visible side produces outward normals.
 */
class WmoGroupMeshBuilder {
  constructor() {
    this.positions = []; // [x, y, z]
    this.normals = []; // [nx, ny, nz]
    this.uvs = []; // [u, v]
    this.colors = []; // [b, g, r, a]
    // Keep triangles bucketed by material_id so MOBA batches are contiguous!
    this.matBuckets = new Map(); // materialId -> Array<{ i0, i1, i2, mopyFlags }>
  }

  addVertex(x, y, z, nx, ny, nz, u, v, rgba = [245, 238, 228, 255]) {
    const idx = this.positions.length;
    this.positions.push([x, y, z]);
    const len = Math.hypot(nx, ny, nz) || 1.0;
    this.normals.push([nx / len, ny / len, nz / len]);
    this.uvs.push([u, v]);
    this.colors.push([
      Math.max(0, Math.min(255, rgba[2] | 0)), // B
      Math.max(0, Math.min(255, rgba[1] | 0)), // G
      Math.max(0, Math.min(255, rgba[0] | 0)), // R
      Math.max(0, Math.min(255, (rgba[3] ?? 255) | 0)), // A
    ]);
    return idx;
  }

  addTri(i0, i1, i2, materialId = 0, mopyFlags = 0x00) {
    if (!this.matBuckets.has(materialId)) {
      this.matBuckets.set(materialId, []);
    }
    this.matBuckets.get(materialId).push({ i0, i1, i2, mopyFlags });
  }

  /**
   * Add a quad `p0 -> p1 -> p2 -> p3` with CCW winding when viewed from the side where
   * `(p1 - p0) x (p3 - p0)` points toward the viewer.
   */
  addQuad(p0, p1, p2, p3, materialId = 0, mopyFlags = 0x00, color = [245, 238, 228, 255], uvScale = 0.125) {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0];
    const vy = p3[1] - p0[1];
    const vz = p3[2] - p0[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const uLen = Math.hypot(ux, uy, uz) * uvScale;
    const vLen = Math.hypot(vx, vy, vz) * uvScale;

    const i0 = this.addVertex(p0[0], p0[1], p0[2], nx, ny, nz, 0, 0, color);
    const i1 = this.addVertex(p1[0], p1[1], p1[2], nx, ny, nz, uLen, 0, color);
    const i2 = this.addVertex(p2[0], p2[1], p2[2], nx, ny, nz, uLen, vLen, color);
    const i3 = this.addVertex(p3[0], p3[1], p3[2], nx, ny, nz, 0, vLen, color);
    this.addTri(i0, i1, i2, materialId, mopyFlags);
    this.addTri(i0, i2, i3, materialId, mopyFlags);
  }

  /**
   * Add a double-sided quad (both front and back faces) when a thin architectural element
   * is visible from both sides.
   */
  addDoubleSidedQuad(p0, p1, p2, p3, materialId = 0, mopyFlags = 0x00, color = [245, 238, 228, 255]) {
    this.addQuad(p0, p1, p2, p3, materialId, mopyFlags, color);
    this.addQuad(p0, p3, p2, p1, materialId, mopyFlags, color);
  }

  /**
   * Add an axis-aligned solid box `[x0..x1, y0..y1, z0..z1]` with outward-facing normals.
   */
  addBox(x0, y0, z0, x1, y1, z1, materialId = 0, mopyFlags = 0x00, color = [245, 238, 228, 255], includeBottom = false) {
    // Top (+Z)
    this.addQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], materialId, mopyFlags, color);
    if (includeBottom) {
      // Bottom (-Z)
      this.addQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], materialId, mopyFlags, color);
    }
    // Front (+X)
    this.addQuad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], materialId, mopyFlags, color);
    // Back (-X)
    this.addQuad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], materialId, mopyFlags, color);
    // Left (+Y)
    this.addQuad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], materialId, mopyFlags, color);
    // Right (-Y)
    this.addQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], materialId, mopyFlags, color);
  }

  /**
   * Add an octagonal/cylindrical column centered at `(cx, cy)` from `z0` to `z1`.
   */
  addColumn(cx, cy, z0, z1, rBot, rTop, segments = 8, materialId = 1, mopyFlags = 0x02, color = [242, 222, 198, 255]) {
    for (let s = 0; s < segments; s++) {
      const a0 = (s * 2 * Math.PI) / segments;
      const a1 = ((s + 1) * 2 * Math.PI) / segments;
      const p0 = [cx + Math.cos(a0) * rBot, cy + Math.sin(a0) * rBot, z0];
      const p1 = [cx + Math.cos(a1) * rBot, cy + Math.sin(a1) * rBot, z0];
      const p2 = [cx + Math.cos(a1) * rTop, cy + Math.sin(a1) * rTop, z1];
      const p3 = [cx + Math.cos(a0) * rTop, cy + Math.sin(a0) * rTop, z1];
      this.addQuad(p0, p1, p2, p3, materialId, mopyFlags, color);
    }
  }

  /**
   * Compile the group geometry into WMO subchunks (`MOPY`, `MOVI`, `MOVT`, `MONR`, `MOTV`,
   * `MOBA`, `MOLR`, `MODR`, `MOBN`, `MOBR`, `MOCV`, and optional `MLIQ`) wrapped in `MVER` + `MOGP`.
   */
  compileGroupFile(opts) {
    const {
      groupNameOffset,
      descriptiveNameOffset,
      flags,
      portalRefStart,
      portalRefCount,
      areaTableId,
      lightRefs = [],
      doodadRefs = [],
      liquid = null, // { xverts, yverts, base: [x,y,z], height, materialId }
      isInterior = false,
    } = opts;

    const sortedMats = [...this.matBuckets.keys()].sort((a, b) => a - b);
    const tris = [];
    const batches = [];

    for (const matId of sortedMats) {
      const bucket = this.matBuckets.get(matId);
      if (!bucket || bucket.length === 0) continue;
      const startIndex = tris.length * 3;
      let minVert = 0xffff;
      let maxVert = 0;
      const bMin = [Infinity, Infinity, Infinity];
      const bMax = [-Infinity, -Infinity, -Infinity];

      for (const t of bucket) {
        tris.push({ ...t, materialId: matId });
        for (const vi of [t.i0, t.i1, t.i2]) {
          if (vi < minVert) minVert = vi;
          if (vi > maxVert) maxVert = vi;
          const p = this.positions[vi];
          for (let k = 0; k < 3; k++) {
            if (p[k] < bMin[k]) bMin[k] = p[k];
            if (p[k] > bMax[k]) bMax[k] = p[k];
          }
        }
      }

      batches.push({
        bboxMin: bMin.map((v) => Math.max(-32768, Math.min(32767, Math.floor(v)))),
        bboxMax: bMax.map((v) => Math.max(-32768, Math.min(32767, Math.ceil(v)))),
        startIndex,
        count: bucket.length * 3,
        minVert,
        maxVert,
        materialId: matId,
      });
    }

    // Overall bounding box
    const bboxMin = [Infinity, Infinity, Infinity];
    const bboxMax = [-Infinity, -Infinity, -Infinity];
    for (const p of this.positions) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < bboxMin[k]) bboxMin[k] = p[k];
        if (p[k] > bboxMax[k]) bboxMax[k] = p[k];
      }
    }
    // Expand slightly for safety
    for (let k = 0; k < 3; k++) {
      bboxMin[k] -= 0.5;
      bboxMax[k] += 0.5;
    }

    // 1. MOPY (2 bytes per triangle: flags, material_id)
    const mopyBuf = Buffer.alloc(tris.length * 2);
    // 2. MOVI (6 bytes per triangle: 3 x u16 vertex indices)
    const moviBuf = Buffer.alloc(tris.length * 6);
    const bspTriIndices = [];
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      mopyBuf[ti * 2 + 0] = t.mopyFlags & 0xff;
      mopyBuf[ti * 2 + 1] = t.materialId & 0xff;
      moviBuf.writeUInt16LE(t.i0, ti * 6 + 0);
      moviBuf.writeUInt16LE(t.i1, ti * 6 + 2);
      moviBuf.writeUInt16LE(t.i2, ti * 6 + 4);
      // Include all non-detail triangles in the MOBN/MOBR BSP leaf
      if ((t.mopyFlags & 0x04) === 0) {
        bspTriIndices.push(ti);
      }
    }

    // 3. MOVT (12 bytes per vertex) & 4. MONR (12 bytes per vertex) & 5. MOTV (8 bytes per vertex) & 11. MOCV (4 bytes per vertex)
    const vCount = this.positions.length;
    const movtBuf = Buffer.alloc(vCount * 12);
    const monrBuf = Buffer.alloc(vCount * 12);
    const motvBuf = Buffer.alloc(vCount * 8);
    const mocvBuf = Buffer.alloc(vCount * 4);
    for (let i = 0; i < vCount; i++) {
      const p = this.positions[i];
      movtBuf.writeFloatLE(p[0], i * 12 + 0);
      movtBuf.writeFloatLE(p[1], i * 12 + 4);
      movtBuf.writeFloatLE(p[2], i * 12 + 8);
      const n = this.normals[i];
      monrBuf.writeFloatLE(n[0], i * 12 + 0);
      monrBuf.writeFloatLE(n[1], i * 12 + 4);
      monrBuf.writeFloatLE(n[2], i * 12 + 8);
      const uv = this.uvs[i];
      motvBuf.writeFloatLE(uv[0], i * 8 + 0);
      motvBuf.writeFloatLE(uv[1], i * 8 + 4);
      const c = this.colors[i];
      mocvBuf[i * 4 + 0] = c[0];
      mocvBuf[i * 4 + 1] = c[1];
      mocvBuf[i * 4 + 2] = c[2];
      mocvBuf[i * 4 + 3] = c[3];
    }

    // 6. MOBA (24 bytes per batch)
    const mobaBuf = Buffer.alloc(batches.length * 24);
    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi];
      const off = bi * 24;
      mobaBuf.writeInt16LE(b.bboxMin[0], off + 0);
      mobaBuf.writeInt16LE(b.bboxMin[1], off + 2);
      mobaBuf.writeInt16LE(b.bboxMin[2], off + 4);
      mobaBuf.writeInt16LE(b.bboxMax[0], off + 6);
      mobaBuf.writeInt16LE(b.bboxMax[1], off + 8);
      mobaBuf.writeInt16LE(b.bboxMax[2], off + 10);
      mobaBuf.writeUInt32LE(b.startIndex, off + 12);
      mobaBuf.writeUInt16LE(b.count, off + 16);
      mobaBuf.writeUInt16LE(b.minVert, off + 18);
      mobaBuf.writeUInt16LE(b.maxVert, off + 20);
      mobaBuf.writeUInt8(0, off + 22);
      mobaBuf.writeUInt8(b.materialId, off + 23);
    }

    // 7. MOLR (u16 light indices)
    const molrBuf = Buffer.alloc(lightRefs.length * 2);
    lightRefs.forEach((lIdx, i) => molrBuf.writeUInt16LE(lIdx, i * 2));

    // 8. MODR (u16 doodad indices)
    const modrBuf = Buffer.alloc(doodadRefs.length * 2);
    doodadRefs.forEach((dIdx, i) => modrBuf.writeUInt16LE(dIdx, i * 2));

    // 9. MOBN (16 bytes per BSP node: single leaf node `flags = 0x04`) & 10. MOBR (u16 triangle indices)
    const mobnBuf = Buffer.alloc(16, 0);
    mobnBuf.writeUInt16LE(0x0004, 0); // leaf flag
    mobnBuf.writeInt16LE(-1, 2); // neg_child = -1
    mobnBuf.writeInt16LE(-1, 4); // pos_child = -1
    mobnBuf.writeUInt16LE(bspTriIndices.length, 6); // n_faces
    mobnBuf.writeUInt32LE(0, 8); // face_start = 0
    mobnBuf.writeFloatLE(0.0, 12); // plane_dist = 0.0

    const mobrBuf = Buffer.alloc(bspTriIndices.length * 2);
    bspTriIndices.forEach((ti, i) => mobrBuf.writeUInt16LE(ti, i * 2));

    const subchunks = [
      wmoChunk('MOPY', mopyBuf),
      wmoChunk('MOVI', moviBuf),
      wmoChunk('MOVT', movtBuf),
      wmoChunk('MONR', monrBuf),
      wmoChunk('MOTV', motvBuf),
      wmoChunk('MOBA', mobaBuf),
    ];

    if (lightRefs.length > 0 && (flags & 0x0200) !== 0) {
      subchunks.push(wmoChunk('MOLR', molrBuf));
    }
    if (doodadRefs.length > 0 && (flags & 0x0800) !== 0) {
      subchunks.push(wmoChunk('MODR', modrBuf));
    }
    if ((flags & 0x0001) !== 0) {
      subchunks.push(wmoChunk('MOBN', mobnBuf));
      subchunks.push(wmoChunk('MOBR', mobrBuf));
    }
    if ((flags & 0x0004) !== 0) {
      subchunks.push(wmoChunk('MOCV', mocvBuf));
    }

    // 12. Optional MLIQ (reflection pool liquid surface)
    if (liquid && (flags & 0x1000) !== 0) {
      const { xverts, yverts, base, height, materialId } = liquid;
      const xtiles = xverts - 1;
      const ytiles = yverts - 1;
      const mliqBuf = Buffer.alloc(30 + xverts * yverts * 8 + xtiles * ytiles, 0);
      mliqBuf.writeUInt32LE(xverts, 0);
      mliqBuf.writeUInt32LE(yverts, 4);
      mliqBuf.writeUInt32LE(xtiles, 8);
      mliqBuf.writeUInt32LE(ytiles, 12);
      mliqBuf.writeFloatLE(base[0], 16);
      mliqBuf.writeFloatLE(base[1], 20);
      mliqBuf.writeFloatLE(base[2], 24);
      mliqBuf.writeUInt16LE(materialId ?? 2, 28);
      let vOff = 30;
      for (let i = 0; i < xverts * yverts; i++) {
        mliqBuf.writeUInt8(180, vOff + 0); // opacity
        mliqBuf.writeFloatLE(height, vOff + 4);
        vOff += 8;
      }
      for (let i = 0; i < xtiles * ytiles; i++) {
        mliqBuf.writeUInt8(0x04, vOff + i); // low nibble 4 => LiquidKind::Still water
      }
      subchunks.push(wmoChunk('MLIQ', mliqBuf));
    }

    // 68-byte MOGP header
    const mogpHdr = Buffer.alloc(68, 0);
    mogpHdr.writeUInt32LE(groupNameOffset, 0);
    mogpHdr.writeUInt32LE(descriptiveNameOffset, 4);
    mogpHdr.writeUInt32LE(flags >>> 0, 8);
    mogpHdr.writeFloatLE(bboxMin[0], 12);
    mogpHdr.writeFloatLE(bboxMin[1], 16);
    mogpHdr.writeFloatLE(bboxMin[2], 20);
    mogpHdr.writeFloatLE(bboxMax[0], 24);
    mogpHdr.writeFloatLE(bboxMax[1], 28);
    mogpHdr.writeFloatLE(bboxMax[2], 32);
    mogpHdr.writeUInt16LE(portalRefStart, 36);
    mogpHdr.writeUInt16LE(portalRefCount, 38);
    mogpHdr.writeUInt16LE(0, 40); // trans_batch_count = 0
    mogpHdr.writeUInt16LE(isInterior ? batches.length : 0, 42); // int_batch_count
    mogpHdr.writeUInt16LE(isInterior ? 0 : batches.length, 44); // ext_batch_count
    mogpHdr.writeUInt16LE(0, 46); // pad
    // fog_indices = [0, 0, 0, 0] at 48..51
    // CRITICAL: group_liquid @ 52 MUST be 0x0F (NO_GROUP_LIQUID = 15) so MLIQ uses pool bounds
    mogpHdr.writeUInt32LE(15, 52);
    mogpHdr.writeUInt32LE(areaTableId >>> 0, 56);

    const mverPayload = Buffer.alloc(4);
    mverPayload.writeUInt32LE(17, 0);
    const mogpPayload = Buffer.concat([mogpHdr, ...subchunks]);

    return {
      buffer: Buffer.concat([wmoChunk('MVER', mverPayload), wmoChunk('MOGP', mogpPayload)]),
      bboxMin,
      bboxMax,
    };
  }
}

/**
 * Construct Group 0 (`_000.wmo` exterior shell) and Group 1 (`_001.wmo` multi-room interior)
 * plus the `Root.wmo` file for one of Celandia's 5 landmark sanctuaries.
 */
function buildSingleWmoBuilding(b) {
  const cWall = [...b.wallColor, 255];
  const cTrim = [...b.trimColor, 255];
  const cFloor = [...b.floorColor, 255];

  // ==========================================================================
  // GROUP 0 (`_000.wmo`): Exterior Colonnade, Approach Steps, Portal Facades & Lantern Roof
  // ==========================================================================
  const ext = new WmoGroupMeshBuilder();

  // 1. Exterior foundation & porch apron (`x ∈ [-24, 24], y ∈ [-24, 24], z ∈ [-2.2, 0.0]`)
  // Leave the interior footprint `x ∈ [-18, 18], y ∈ [-18, 18]` open so Group 1 owns the interior floor!
  // Front (+X) porch & steps (`x ∈ [18, 25], y ∈ [-22, 22]`)
  ext.addBox(18.0, -22.0, -2.2, 22.5, 22.0, 0.0, 2, 0x00, cFloor);
  ext.addBox(22.5, -10.0, -2.2, 24.5, 10.0, -0.55, 1, 0x00, cTrim);
  ext.addBox(24.5, -9.0, -2.2, 26.2, 9.0, -1.15, 2, 0x00, cFloor);

  // Rear (-X) porch & steps (`x ∈ [-25, -18], y ∈ [-22, 22]`)
  ext.addBox(-22.5, -22.0, -2.2, -18.0, 22.0, 0.0, 2, 0x00, cFloor);
  ext.addBox(-24.5, -10.0, -2.2, -22.5, 10.0, -0.55, 1, 0x00, cTrim);
  ext.addBox(-26.2, -9.0, -2.2, -24.5, 9.0, -1.15, 2, 0x00, cFloor);

  // Left (+Y) and Right (-Y) colonnade stylobate terraces (`y ∈ [18, 22.5]` and `y ∈ [-22.5, -18]`)
  ext.addBox(-18.0, 18.0, -2.2, 18.0, 22.5, 0.0, 2, 0x00, cFloor);
  ext.addBox(-18.0, -22.5, -2.2, 18.0, -18.0, 0.0, 2, 0x00, cFloor);

  // 2. Exterior walls at `±18.5` with a grand 12-yard-wide × 10-yard-tall open portal archway
  // on both +X (`x ∈ [18.0, 19.0], y ∈ [-6, +6], z ∈ [0, 10]`) and -X (`x ∈ [-19.0, -18.0]`)
  // Front (+X) left & right wings + lintel above portal
  ext.addBox(18.0, -19.0, 0.0, 19.2, -6.0, 11.5, 0, 0x02, cWall);
  ext.addBox(18.0, 6.0, 0.0, 19.2, 19.0, 11.5, 0, 0x02, cWall);
  ext.addBox(17.8, -6.5, 10.0, 19.4, 6.5, 12.0, 1, 0x06, cTrim, true);
  // Portal jamb pilasters (+X)
  ext.addBox(17.8, -6.6, 0.0, 19.5, -5.8, 10.2, 1, 0x02, cTrim);
  ext.addBox(17.8, 5.8, 0.0, 19.5, 6.6, 10.2, 1, 0x02, cTrim);

  // Rear (-X) left & right wings + lintel above portal
  ext.addBox(-19.2, -19.0, 0.0, -18.0, -6.0, 11.5, 0, 0x02, cWall);
  ext.addBox(-19.2, 6.0, 0.0, -18.0, 19.0, 11.5, 0, 0x02, cWall);
  ext.addBox(-19.4, -6.5, 10.0, -17.8, 6.5, 12.0, 1, 0x06, cTrim, true);
  ext.addBox(-19.5, -6.6, 0.0, -17.8, -5.8, 10.2, 1, 0x02, cTrim);
  ext.addBox(-19.5, 5.8, 0.0, -17.8, 6.6, 10.2, 1, 0x02, cTrim);

  // Side (+Y and -Y) exterior walls (`y ∈ [18.0, 19.2]` and `y ∈ [-19.2, -18.0]`)
  ext.addBox(-19.0, 18.0, 0.0, 19.0, 19.2, 11.5, 0, 0x02, cWall);
  ext.addBox(-19.0, -19.2, 0.0, 19.0, -18.0, 11.5, 0, 0x02, cWall);

  // 3. Exterior peristyle colonnade (12 fluted columns around the porch perimeter)
  const extCols = [
    [21.2, -15.5], [21.2, -8.2], [21.2, 8.2], [21.2, 15.5],
    [-21.2, -15.5], [-21.2, -8.2], [-21.2, 8.2], [-21.2, 15.5],
    [-11.0, 21.0], [0.0, 21.0], [11.0, 21.0],
    [-11.0, -21.0], [0.0, -21.0], [11.0, -21.0],
  ];
  for (const [cx, cy] of extCols) {
    ext.addBox(cx - 1.0, cy - 1.0, 0.0, cx + 1.0, cy + 1.0, 0.6, 1, 0x02, cTrim);
    ext.addColumn(cx, cy, 0.6, 10.6, 0.72, 0.62, 8, 0, 0x02, cWall);
    ext.addBox(cx - 1.05, cy - 1.05, 10.6, cx + 1.05, cy + 1.05, 11.5, 1, 0x06, cTrim);
  }

  // 4. Upper entablature, stepped roof & central lantern spire (`z = 11.5..26.0`)
  // Marked with `MOPY_DETAIL | MOPY_NOCAMCOLLIDE` (`0x06`) so high camera down-rays pass cleanly
  // through the roof shell to hit Group 1's interior floor when the player is inside!
  ext.addBox(-22.2, -22.2, 11.5, 22.2, 22.2, 13.2, 1, 0x06, cTrim);
  ext.addBox(-17.5, -17.5, 13.2, 17.5, 17.5, 15.4, 0, 0x06, cWall);
  ext.addBox(-12.0, -12.0, 15.4, 12.0, 12.0, 18.2, 1, 0x06, cTrim);
  ext.addColumn(0.0, 0.0, 18.2, 23.0, 7.2, 3.8, 8, 0, 0x06, cWall);
  ext.addColumn(0.0, 0.0, 23.0, 27.5, 3.8, 0.25, 8, 1, 0x06, cTrim);

  // ==========================================================================
  // GROUP 1 (`_001.wmo`): Multi-Room Enterable Interior
  //   - Room 1: Entrance Vestibule (`x ∈ [6, 18], y ∈ [-18, 18]`)
  //   - Room 2: Colonnaded Grand Nave & Sunken Reflection Basin (`x ∈ [-6, 6], y ∈ [-18, 18]`)
  //   - Room 3: Raised Royal Sanctuary Dais & Sovereign Throne Platform (`x ∈ [-18, -6], y ∈ [-18, 18]`)
  // ==========================================================================
  const intr = new WmoGroupMeshBuilder();

  const warmFloor = [
    Math.min(255, cFloor[0] + 6),
    Math.min(255, cFloor[1] + 4),
    Math.min(255, cFloor[2] + 2),
    255,
  ];
  const warmWall = [
    Math.min(255, cWall[0] + 4),
    Math.min(255, cWall[1] + 2),
    Math.min(255, cWall[2]),
    255,
  ];
  const warmTrim = [
    Math.min(255, cTrim[0] + 8),
    Math.min(255, cTrim[1] + 6),
    Math.min(255, cTrim[2] + 4),
    255,
  ];

  // 1. Walkable Interior Floors (`mopyFlags = 0x00`)
  // Surround the central Sunken Reflection Basin (`x ∈ [-5, 5], y ∈ [-5, 5]`)
  // Front Vestibule floor (`x ∈ [5, 18.2], y ∈ [-18, 18], z = 0.0`)
  intr.addQuad([5.0, -18.0, 0.0], [18.2, -18.0, 0.0], [18.2, 18.0, 0.0], [5.0, 18.0, 0.0], 2, 0x00, warmFloor);
  // Rear Sanctuary base floor (`x ∈ [-18.2, -5], y ∈ [-18, 18], z = 0.0`)
  intr.addQuad([-18.2, -18.0, 0.0], [-5.0, -18.0, 0.0], [-5.0, 18.0, 0.0], [-18.2, 18.0, 0.0], 2, 0x00, warmFloor);
  // Left Nave aisle (`x ∈ [-5, 5], y ∈ [5, 18], z = 0.0`)
  intr.addQuad([-5.0, 5.0, 0.0], [5.0, 5.0, 0.0], [5.0, 18.0, 0.0], [-5.0, 18.0, 0.0], 2, 0x00, warmFloor);
  // Right Nave aisle (`x ∈ [-5, 5], y ∈ [-18, -5], z = 0.0`)
  intr.addQuad([-5.0, -18.0, 0.0], [5.0, -18.0, 0.0], [5.0, -5.0, 0.0], [-5.0, -5.0, 0.0], 2, 0x00, warmFloor);

  // 2. Sunken Reflection Basin (`x ∈ [-5, 5], y ∈ [-5, 5], z = -0.48`) + Rose-Gold Curb
  intr.addQuad([-5.0, -5.0, -0.48], [5.0, -5.0, -0.48], [5.0, 5.0, -0.48], [-5.0, 5.0, -0.48], 1, 0x00, warmTrim);
  // Basin inner walls facing inward
  intr.addQuad([-5.0, -5.0, -0.48], [-5.0, 5.0, -0.48], [-5.0, 5.0, 0.08], [-5.0, -5.0, 0.08], 1, 0x00, warmTrim);
  intr.addQuad([5.0, 5.0, -0.48], [5.0, -5.0, -0.48], [5.0, -5.0, 0.08], [5.0, 5.0, 0.08], 1, 0x00, warmTrim);
  intr.addQuad([-5.0, 5.0, -0.48], [5.0, 5.0, -0.48], [5.0, 5.0, 0.08], [-5.0, 5.0, 0.08], 1, 0x00, warmTrim);
  intr.addQuad([5.0, -5.0, -0.48], [-5.0, -5.0, -0.48], [-5.0, -5.0, 0.08], [5.0, -5.0, 0.08], 1, 0x00, warmTrim);

  // 3. Room 3: Raised Royal Sanctuary Dais (`x ∈ [-16.2, -7.2], y ∈ [-9.5, 9.5]`) & Steps (`mopyFlags = 0x00`)
  // Step 1 (`z = 0.0..0.4`)
  intr.addBox(-16.4, -10.2, 0.0, -6.6, 10.2, 0.4, 1, 0x00, warmTrim);
  // Step 2 / Main Sanctuary Dais (`z = 0.4..0.85`)
  intr.addBox(-16.0, -9.2, 0.4, -7.4, 9.2, 0.85, 2, 0x00, warmFloor);
  // Sovereign Throne / Altar Plinth (`z = 0.85..1.35`)
  intr.addBox(-15.0, -4.5, 0.85, -9.8, 4.5, 1.35, 1, 0x00, warmTrim);

  // 4. Interior Room-Dividing Archway Screens (`x = +6.5` between Vestibule & Nave, and `x = -6.5` between Nave & Sanctuary)
  // Leaves a wide 12-yard central opening (`y ∈ [-6, 6]`) and side colonnade passages
  for (const ax of [6.5, -6.5]) {
    intr.addBox(ax - 0.55, -18.0, 0.0, ax + 0.55, -11.5, 11.0, 0, 0x02, warmWall);
    intr.addBox(ax - 0.55, 11.5, 0.0, ax + 0.55, 18.0, 11.0, 0, 0x02, warmWall);
    // Overhead archway beam (`z = 8.8..11.2`, `mopyFlags = 0x06` so down-rays never catch high beams)
    intr.addBox(ax - 0.65, -18.0, 8.8, ax + 0.65, 18.0, 11.2, 1, 0x06, warmTrim, true);
  }

  // 5. Interior Sculpted Colonnade Columns (8 columns flanking the Nave & Reflection Basin)
  const intCols = [
    [6.5, -6.5], [6.5, 6.5],
    [0.0, -6.5], [0.0, 6.5],
    [-6.5, -6.5], [-6.5, 6.5],
    [-13.5, -6.5], [-13.5, 6.5],
  ];
  for (const [cx, cy] of intCols) {
    intr.addBox(cx - 0.85, cy - 0.85, 0.0, cx + 0.85, cy + 0.85, 0.5, 1, 0x02, warmTrim);
    intr.addColumn(cx, cy, 0.5, 9.8, 0.62, 0.54, 8, 0, 0x02, warmWall);
    intr.addBox(cx - 0.95, cy - 0.95, 9.8, cx + 0.95, cy + 0.95, 10.8, 1, 0x06, warmTrim);
  }

  // 6. Interior Perimeter Walls (inward-facing normals, `mopyFlags = 0x02`)
  // Left wall (`y = +18.0`, inward normal `-Y`)
  intr.addQuad([-18.0, 18.0, 0.0], [18.0, 18.0, 0.0], [18.0, 18.0, 11.2], [-18.0, 18.0, 11.2], 0, 0x02, warmWall);
  // Right wall (`y = -18.0`, inward normal `+Y`)
  intr.addQuad([18.0, -18.0, 0.0], [-18.0, -18.0, 0.0], [-18.0, -18.0, 11.2], [18.0, -18.0, 11.2], 0, 0x02, warmWall);
  // Front wall (`x = +18.0`, inward normal `-X`) with `y ∈ [-6, +6], z ∈ [0, 10]` open for Portal 0!
  intr.addQuad([18.0, -18.0, 0.0], [18.0, -6.0, 0.0], [18.0, -6.0, 11.2], [18.0, -18.0, 11.2], 0, 0x02, warmWall);
  intr.addQuad([18.0, 6.0, 0.0], [18.0, 18.0, 0.0], [18.0, 18.0, 11.2], [18.0, 6.0, 11.2], 0, 0x02, warmWall);
  intr.addQuad([18.0, -6.0, 10.0], [18.0, 6.0, 10.0], [18.0, 6.0, 11.2], [18.0, -6.0, 11.2], 1, 0x06, warmTrim);
  // Rear wall (`x = -18.0`, inward normal `+X`) with `y ∈ [-6, +6], z ∈ [0, 10]` open for Portal 1!
  intr.addQuad([-18.0, 18.0, 0.0], [-18.0, 6.0, 0.0], [-18.0, 6.0, 11.2], [-18.0, 18.0, 11.2], 0, 0x02, warmWall);
  intr.addQuad([-18.0, -6.0, 0.0], [-18.0, -18.0, 0.0], [-18.0, -18.0, 11.2], [-18.0, -6.0, 11.2], 0, 0x02, warmWall);
  intr.addQuad([-18.0, 6.0, 10.0], [-18.0, -6.0, 10.0], [-18.0, -6.0, 11.2], [-18.0, 6.0, 11.2], 1, 0x06, warmTrim);

  // Decorative Dado Wainscoting band along interior walls (`z = 0.0..1.6`)
  intr.addQuad([-17.92, 17.92, 0.0], [17.92, 17.92, 0.0], [17.92, 17.92, 1.6], [-17.92, 17.92, 1.6], 1, 0x02, warmTrim);
  intr.addQuad([17.92, -17.92, 0.0], [-17.92, -17.92, 0.0], [-17.92, -17.92, 1.6], [17.92, -17.92, 1.6], 1, 0x02, warmTrim);

  // 7. Vaulted Coffered Interior Ceiling (`z = 11.2..13.8`, inward-downward normals `-Z`, `mopyFlags = 0x06`)
  // Marked `0x06` (`MOPY_DETAIL | MOPY_NOCAMCOLLIDE`) so high third-person camera down-rays pass
  // straight through the ceiling and hit Group 1's walkable floor (`z = 0.0`).
  intr.addQuad([-18.0, 18.0, 11.2], [18.0, 18.0, 11.2], [10.0, 10.0, 13.6], [-10.0, 10.0, 13.6], 0, 0x06, warmWall);
  intr.addQuad([18.0, -18.0, 0.0 + 11.2], [-18.0, -18.0, 11.2], [-10.0, -10.0, 13.6], [10.0, -10.0, 13.6], 0, 0x06, warmWall);
  intr.addQuad([18.0, 18.0, 11.2], [18.0, -18.0, 11.2], [10.0, -10.0, 13.6], [10.0, 10.0, 13.6], 0, 0x06, warmWall);
  intr.addQuad([-18.0, -18.0, 11.2], [-18.0, 18.0, 11.2], [-10.0, 10.0, 13.6], [-10.0, -10.0, 13.6], 0, 0x06, warmWall);
  // Central coffered lantern dome (`x ∈ [-10, 10], y ∈ [-10, 10], z = 13.6`)
  intr.addQuad([-10.0, -10.0, 13.6], [10.0, -10.0, 13.6], [10.0, 10.0, 13.6], [-10.0, 10.0, 13.6], 1, 0x06, warmTrim);

  // ==========================================================================
  // Compile Group 0 (`_000.wmo`) & Group 1 (`_001.wmo`)
  // ==========================================================================
  // MOGN group name table: "\0" + exteriorGroupName + "\0" + interiorGroupName + "\0"
  const mognParts = [Buffer.from([0])];
  const extNameOff = 1;
  const extNameBuf = Buffer.from(b.exteriorGroupName + '\0', 'utf8');
  mognParts.push(extNameBuf);
  const intNameOff = extNameOff + extNameBuf.length;
  const intNameBuf = Buffer.from(b.interiorGroupName + '\0', 'utf8');
  mognParts.push(intNameBuf);
  const mognRaw = Buffer.concat(mognParts);
  const mognPad = (4 - (mognRaw.length % 4)) % 4;
  const mognBuf = mognPad > 0 ? Buffer.concat([mognRaw, Buffer.alloc(mognPad, 0)]) : mognRaw;

  const group0AreaId = b.wmoId * 10 + 0;
  const group1AreaId = b.wmoId * 10 + 1;

  // Group 0 (`_000.wmo` exterior): flags = 0x000D (`0x08` EXTERIOR | `0x04` MOCV | `0x01` MOBN/MOBR)
  // Portal refs 0..4 belong to Group 0 (referencing Portal 0 and Portal 1)
  const g0 = ext.compileGroupFile({
    groupNameOffset: extNameOff,
    descriptiveNameOffset: extNameOff,
    flags: 0x000d,
    portalRefStart: 0,
    portalRefCount: 4,
    areaTableId: group0AreaId,
    lightRefs: [],
    doodadRefs: [],
    liquid: null,
    isInterior: false,
  });

  // Group 1 (`_001.wmo` interior): flags = 0x3A05
  // (`0x2000` INDOOR | `0x1000` MLIQ | `0x0800` MODR | `0x0200` MOLR | `0x0004` MOCV | `0x0001` MOBN/MOBR)
  // Note: `(0x3A05 & 0x48) == 0`, so `benilla` classifies Group 1 as a true interior!
  const g1 = intr.compileGroupFile({
    groupNameOffset: intNameOff,
    descriptiveNameOffset: intNameOff,
    flags: 0x3a05,
    portalRefStart: 4,
    portalRefCount: 2,
    areaTableId: group1AreaId,
    lightRefs: [0, 1, 2, 3],
    doodadRefs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    liquid: {
      xverts: 3,
      yverts: 3,
      base: [-5.0, -5.0, -0.08],
      height: -0.08,
      materialId: 2,
    },
    isInterior: true,
  });

  // ==========================================================================
  // Compile Root `.wmo` (`MVER`, `MOHD`, `MOTX`, `MOMT`, `MOGN`, `MOGI`, `MOSB`,
  //   `MOPV`, `MOPT`, `MOPR`, `MOVV`, `MOVB`, `MOLT`, `MODS`, `MODN`, `MODD`, `MFOG`)
  // ==========================================================================

  // 1. MOTX (NUL-terminated `.blp` strings, padded to 4 bytes)
  const texPaths = [b.wallTex, b.trimTex, b.floorTex];
  const texOffsets = [];
  const motxParts = [];
  let motxLen = 0;
  for (const tp of texPaths) {
    texOffsets.push(motxLen);
    const tb = Buffer.from(tp + '\0', 'utf8');
    motxParts.push(tb);
    motxLen += tb.length;
  }
  const motxPad = (4 - (motxLen % 4)) % 4;
  if (motxPad > 0) motxParts.push(Buffer.alloc(motxPad, 0));
  const motxBuf = Buffer.concat(motxParts);

  // 2. MOMT (3 materials x 64 bytes)
  // Note: `MOMT[2].diff_color` (at offset 0x1c = 28) is used by `benilla` for the interior `MLIQ` water color!
  const momtBuf = Buffer.alloc(3 * 64, 0);
  const matConfigs = [
    { texOff: texOffsets[0], diffRgba: [...b.wallColor, 255], groundType: 5 },
    { texOff: texOffsets[1], diffRgba: [...b.trimColor, 255], groundType: 5 },
    { texOff: texOffsets[2], diffRgba: b.liquidColor, groundType: 5 },
  ];
  matConfigs.forEach((mc, mi) => {
    const off = mi * 64;
    momtBuf.writeUInt32LE(0, off + 0); // flags
    momtBuf.writeUInt32LE(0, off + 4); // shader
    momtBuf.writeUInt32LE(0, off + 8); // blend_mode = opaque
    momtBuf.writeUInt32LE(mc.texOff, off + 12); // texture_1 (MOTX byte offset)
    momtBuf.writeUInt8(40, off + 16); // sidn B
    momtBuf.writeUInt8(36, off + 17); // sidn G
    momtBuf.writeUInt8(32, off + 18); // sidn R
    momtBuf.writeUInt8(255, off + 19); // sidn A
    momtBuf.writeUInt8(mc.diffRgba[2], off + 28); // diff B
    momtBuf.writeUInt8(mc.diffRgba[1], off + 29); // diff G
    momtBuf.writeUInt8(mc.diffRgba[0], off + 30); // diff R
    momtBuf.writeUInt8(mc.diffRgba[3] ?? 255, off + 31); // diff A
    momtBuf.writeUInt32LE(mc.groundType, off + 32); // ground_type = 5 (stone/marble)
  });

  // 3. MOGI (2 groups x 32 bytes)
  const mogiBuf = Buffer.alloc(2 * 32, 0);
  // Group 0 (`_000.wmo` exterior)
  mogiBuf.writeUInt32LE(0x000d, 0);
  mogiBuf.writeFloatLE(g0.bboxMin[0], 4);
  mogiBuf.writeFloatLE(g0.bboxMin[1], 8);
  mogiBuf.writeFloatLE(g0.bboxMin[2], 12);
  mogiBuf.writeFloatLE(g0.bboxMax[0], 16);
  mogiBuf.writeFloatLE(g0.bboxMax[1], 20);
  mogiBuf.writeFloatLE(g0.bboxMax[2], 24);
  mogiBuf.writeInt32LE(extNameOff, 28);
  // Group 1 (`_001.wmo` interior)
  mogiBuf.writeUInt32LE(0x3a05, 32 + 0);
  mogiBuf.writeFloatLE(g1.bboxMin[0], 32 + 4);
  mogiBuf.writeFloatLE(g1.bboxMin[1], 32 + 8);
  mogiBuf.writeFloatLE(g1.bboxMin[2], 32 + 12);
  mogiBuf.writeFloatLE(g1.bboxMax[0], 32 + 16);
  mogiBuf.writeFloatLE(g1.bboxMax[1], 32 + 20);
  mogiBuf.writeFloatLE(g1.bboxMax[2], 32 + 24);
  mogiBuf.writeInt32LE(intNameOff, 32 + 28);

  // 4. Portals: `MOPV` (8 vertices x 12 bytes), `MOPT` (2 portals x 20 bytes), `MOPR` (6 refs x 8 bytes)
  // Portal 0: Front Entrance Archway at `x = +18.0, y ∈ [-6.5, +6.5], z ∈ [0.0, 10.5]`
  // Plane: `(+1, 0, 0) · p - 18.0 = 0`
  // Portal 1: Rear Entrance Archway at `x = -18.0, y ∈ [-6.5, +6.5], z ∈ [0.0, 10.5]`
  // Plane: `(-1, 0, 0) · p - 18.0 = 0`
  const portalVerts = [
    // Portal 0 (+X archway)
    [18.0, -6.5, 0.0],
    [18.0, 6.5, 0.0],
    [18.0, 6.5, 10.5],
    [18.0, -6.5, 10.5],
    // Portal 1 (-X archway)
    [-18.0, 6.5, 0.0],
    [-18.0, -6.5, 0.0],
    [-18.0, -6.5, 10.5],
    [-18.0, 6.5, 10.5],
  ];
  const mopvBuf = Buffer.alloc(portalVerts.length * 12);
  portalVerts.forEach((pv, i) => {
    mopvBuf.writeFloatLE(pv[0], i * 12 + 0);
    mopvBuf.writeFloatLE(pv[1], i * 12 + 4);
    mopvBuf.writeFloatLE(pv[2], i * 12 + 8);
  });

  const moptBuf = Buffer.alloc(2 * 20, 0);
  // Portal 0
  moptBuf.writeUInt16LE(0, 0); // start_vertex = 0
  moptBuf.writeUInt16LE(4, 2); // count = 4
  moptBuf.writeFloatLE(1.0, 4); // nx = +1
  moptBuf.writeFloatLE(0.0, 8); // ny = 0
  moptBuf.writeFloatLE(0.0, 12); // nz = 0
  moptBuf.writeFloatLE(-18.0, 16); // d = -18.0
  // Portal 1
  moptBuf.writeUInt16LE(4, 20 + 0); // start_vertex = 4
  moptBuf.writeUInt16LE(4, 20 + 2); // count = 4
  moptBuf.writeFloatLE(-1.0, 20 + 4); // nx = -1
  moptBuf.writeFloatLE(0.0, 20 + 8); // ny = 0
  moptBuf.writeFloatLE(0.0, 20 + 12); // nz = 0
  moptBuf.writeFloatLE(-18.0, 20 + 16); // d = -18.0

  // MOPR:
  // Refs 0..4 belong to Group 0 (`target = 1`), covering both sides so viewing the doorway from
  // anywhere on the exterior porch or steps always floods into Group 1.
  // Refs 4..6 belong to Group 1 (`target = 0`, `side = -1`), where `x ∈ [-18, +18]` satisfies
  // `-(x - 18) >= 0` for Portal 0 and `-(-x - 18) >= 0` for Portal 1!
  const portalRefs = [
    { portal: 0, group: 1, side: 1 },
    { portal: 0, group: 1, side: -1 },
    { portal: 1, group: 1, side: 1 },
    { portal: 1, group: 1, side: -1 },
    { portal: 0, group: 0, side: -1 },
    { portal: 1, group: 0, side: -1 },
  ];
  const moprBuf = Buffer.alloc(portalRefs.length * 8, 0);
  portalRefs.forEach((pr, i) => {
    moprBuf.writeUInt16LE(pr.portal, i * 8 + 0);
    moprBuf.writeUInt16LE(pr.group, i * 8 + 2);
    moprBuf.writeInt16LE(pr.side, i * 8 + 4);
    moprBuf.writeUInt16LE(0, i * 8 + 6);
  });

  // 5. MOLT (4 interior point lights x 48 bytes)
  const lights = [
    { pos: [10.0, 0.0, 8.5], intensity: 1.35, attenStart: 4.0, attenEnd: 28.0 },
    { pos: [0.0, 0.0, 9.5], intensity: 1.55, attenStart: 5.0, attenEnd: 32.0 },
    { pos: [-11.5, 0.0, 7.5], intensity: 1.45, attenStart: 4.0, attenEnd: 28.0 },
    { pos: [0.0, 0.0, 2.2], intensity: 1.15, attenStart: 3.0, attenEnd: 20.0 },
  ];
  const moltBuf = Buffer.alloc(lights.length * 48, 0);
  lights.forEach((lt, i) => {
    const off = i * 48;
    moltBuf.writeUInt8(0, off + 0); // omni light
    moltBuf.writeUInt8(1, off + 1); // use_atten = 1
    moltBuf.writeUInt16LE(1, off + 2);
    moltBuf.writeUInt8(b.lightColor[2], off + 4); // B
    moltBuf.writeUInt8(b.lightColor[1], off + 5); // G
    moltBuf.writeUInt8(b.lightColor[0], off + 6); // R
    moltBuf.writeUInt8(255, off + 7); // A
    moltBuf.writeFloatLE(lt.pos[0], off + 8);
    moltBuf.writeFloatLE(lt.pos[1], off + 12);
    moltBuf.writeFloatLE(lt.pos[2], off + 16);
    moltBuf.writeFloatLE(lt.intensity, off + 20);
    moltBuf.writeFloatLE(0.0, off + 24);
    moltBuf.writeFloatLE(0.0, off + 28);
    moltBuf.writeFloatLE(-1.0, off + 32);
    moltBuf.writeFloatLE(-0.5, off + 36);
    moltBuf.writeFloatLE(lt.attenStart, off + 40);
    moltBuf.writeFloatLE(lt.attenEnd, off + 44);
  });

  // 6. MODN, MODS, MODD (Interior furniture & prop doodads)
  const doodadNames = [
    b.centerpieceMdx,
    b.secondaryMdx,
    'World\\Celandia\\Interiors\\CrystalChandelier.mdx',
    'World\\Celandia\\Interiors\\AureateSunBrazier.mdx',
    'World\\Celandia\\Interiors\\SilkBanner.mdx',
    'World\\Celandia\\Interiors\\PorcelainPillar.mdx',
  ];
  const modnOffsets = [];
  const modnParts = [];
  let modnLen = 0;
  for (const dn of doodadNames) {
    modnOffsets.push(modnLen);
    const db = Buffer.from(dn + '\0', 'utf8');
    modnParts.push(db);
    modnLen += db.length;
  }
  const modnPad = (4 - (modnLen % 4)) % 4;
  if (modnPad > 0) modnParts.push(Buffer.alloc(modnPad, 0));
  const modnBuf = Buffer.concat(modnParts);

  // 12 interior doodad placements in Group 1 (`_001.wmo`)
  // Note: orientation is quaternion `[qx, qy, qz, qw]`. Rotating around Z (vertical in WMO space)
  // by angle `theta` is `[0, 0, sin(theta/2), cos(theta/2)]`.
  const s90 = Math.SQRT1_2;
  const doodadDefs = [
    // 0: Centerpiece on the raised Royal Sanctuary Dais (`x = -12.4, y = 0, z = 1.35`)
    { nameOff: modnOffsets[0], pos: [-12.4, 0.0, 1.35], rot: [0, 0, s90, s90], scale: 1.25 },
    // 1..2: Secondary ceremonial props flanking the Sanctuary Dais
    { nameOff: modnOffsets[1], pos: [-12.0, -5.8, 0.85], rot: [0, 0, s90, s90], scale: 1.0 },
    { nameOff: modnOffsets[1], pos: [-12.0, 5.8, 0.85], rot: [0, 0, s90, s90], scale: 1.0 },
    // 3..4: Suspended Crystal Chandeliers over the Nave & Vestibule
    { nameOff: modnOffsets[2], pos: [0.0, 0.0, 9.6], rot: [0, 0, 0, 1], scale: 1.2 },
    { nameOff: modnOffsets[2], pos: [11.5, 0.0, 9.2], rot: [0, 0, 0, 1], scale: 1.0 },
    // 5..8: Four Aureate Sun Braziers at the corners of the Reflection Basin & Vestibule
    { nameOff: modnOffsets[3], pos: [5.8, -5.8, 0.0], rot: [0, 0, 0, 1], scale: 0.95 },
    { nameOff: modnOffsets[3], pos: [5.8, 5.8, 0.0], rot: [0, 0, 0, 1], scale: 0.95 },
    { nameOff: modnOffsets[3], pos: [-5.8, -5.8, 0.0], rot: [0, 0, 0, 1], scale: 0.95 },
    { nameOff: modnOffsets[3], pos: [-5.8, 5.8, 0.0], rot: [0, 0, 0, 1], scale: 0.95 },
    // 9..10: Royal Silk Banners along the side nave walls
    { nameOff: modnOffsets[4], pos: [0.0, -16.8, 1.5], rot: [0, 0, 0, 1], scale: 1.15 },
    { nameOff: modnOffsets[4], pos: [0.0, 16.8, 1.5], rot: [0, 0, 1, 0], scale: 1.15 },
    // 11: Sanctuary rear axial column/reliquary
    { nameOff: modnOffsets[5], pos: [-15.8, 0.0, 0.85], rot: [0, 0, 0, 1], scale: 1.1 },
  ];

  // MODS (1 set x 32 bytes: "DefaultSet")
  const modsBuf = Buffer.alloc(32, 0);
  modsBuf.write('DefaultSet', 0, 10, 'ascii');
  modsBuf.writeUInt32LE(0, 20); // start index
  modsBuf.writeUInt32LE(doodadDefs.length, 24); // count

  // MODD (40 bytes per doodad placement)
  const moddBuf = Buffer.alloc(doodadDefs.length * 40, 0);
  doodadDefs.forEach((dd, i) => {
    const off = i * 40;
    moddBuf.writeUInt32LE(dd.nameOff, off + 0);
    moddBuf.writeFloatLE(dd.pos[0], off + 4);
    moddBuf.writeFloatLE(dd.pos[1], off + 8);
    moddBuf.writeFloatLE(dd.pos[2], off + 12);
    moddBuf.writeFloatLE(dd.rot[0], off + 16);
    moddBuf.writeFloatLE(dd.rot[1], off + 20);
    moddBuf.writeFloatLE(dd.rot[2], off + 24);
    moddBuf.writeFloatLE(dd.rot[3], off + 28);
    moddBuf.writeFloatLE(dd.scale, off + 32);
    moddBuf.writeUInt8(245, off + 36); // B
    moddBuf.writeUInt8(248, off + 37); // G
    moddBuf.writeUInt8(255, off + 38); // R
    moddBuf.writeUInt8(255, off + 39); // A
  });

  // 7. MFOG (1 fog definition x 48 bytes)
  const mfogBuf = Buffer.alloc(48, 0);
  mfogBuf.writeUInt32LE(0, 0); // flags
  mfogBuf.writeFloatLE(0.0, 4); // pos x
  mfogBuf.writeFloatLE(0.0, 8); // pos y
  mfogBuf.writeFloatLE(4.0, 12); // pos z
  mfogBuf.writeFloatLE(18.0, 16); // radius_inner
  mfogBuf.writeFloatLE(65.0, 20); // radius_outer
  mfogBuf.writeFloatLE(444.4445, 24); // fog_end
  mfogBuf.writeFloatLE(0.25, 28); // fog_start_scalar
  mfogBuf.writeUInt8(b.fogColor[2], 32); // B
  mfogBuf.writeUInt8(b.fogColor[1], 33); // G
  mfogBuf.writeUInt8(b.fogColor[0], 34); // R
  mfogBuf.writeUInt8(255, 35); // A
  mfogBuf.writeFloatLE(222.222, 36); // uw_fog_end
  mfogBuf.writeFloatLE(0.5, 40); // uw_fog_start_scalar
  mfogBuf.writeUInt8(b.liquidColor[2], 44);
  mfogBuf.writeUInt8(b.liquidColor[1], 45);
  mfogBuf.writeUInt8(b.liquidColor[0], 46);
  mfogBuf.writeUInt8(255, 47);

  // 8. Overall Root Bounding Box & MOHD (64 bytes)
  const rootMin = [
    Math.min(g0.bboxMin[0], g1.bboxMin[0]),
    Math.min(g0.bboxMin[1], g1.bboxMin[1]),
    Math.min(g0.bboxMin[2], g1.bboxMin[2]),
  ];
  const rootMax = [
    Math.max(g0.bboxMax[0], g1.bboxMax[0]),
    Math.max(g0.bboxMax[1], g1.bboxMax[1]),
    Math.max(g0.bboxMax[2], g1.bboxMax[2]),
  ];

  const mohdBuf = Buffer.alloc(64, 0);
  mohdBuf.writeUInt32LE(texPaths.length, 0); // nTextures = 3
  mohdBuf.writeUInt32LE(2, 4); // nGroups = 2 (_000 exterior + _001 interior)
  mohdBuf.writeUInt32LE(2, 8); // nPortals = 2
  mohdBuf.writeUInt32LE(lights.length, 12); // nLights = 4
  mohdBuf.writeUInt32LE(doodadNames.length, 16); // nDoodadNames
  mohdBuf.writeUInt32LE(doodadDefs.length, 20); // nDoodadDefs
  mohdBuf.writeUInt32LE(1, 24); // nDoodadSets = 1
  mohdBuf.writeUInt8(198, 28); // amb B
  mohdBuf.writeUInt8(206, 29); // amb G
  mohdBuf.writeUInt8(218, 30); // amb R
  mohdBuf.writeUInt8(255, 31); // amb A
  mohdBuf.writeUInt32LE(b.wmoId, 32); // wmoId at 0x20
  mohdBuf.writeFloatLE(rootMin[0], 36);
  mohdBuf.writeFloatLE(rootMin[1], 40);
  mohdBuf.writeFloatLE(rootMin[2], 44);
  mohdBuf.writeFloatLE(rootMax[0], 48);
  mohdBuf.writeFloatLE(rootMax[1], 52);
  mohdBuf.writeFloatLE(rootMax[2], 56);
  mohdBuf.writeUInt32LE(0, 60); // liquidType

  const mverPayload = Buffer.alloc(4);
  mverPayload.writeUInt32LE(17, 0);

  const rootBuffer = Buffer.concat([
    wmoChunk('MVER', mverPayload),
    wmoChunk('MOHD', mohdBuf),
    wmoChunk('MOTX', motxBuf),
    wmoChunk('MOMT', momtBuf),
    wmoChunk('MOGN', mognBuf),
    wmoChunk('MOGI', mogiBuf),
    wmoChunk('MOSB', Buffer.alloc(4, 0)),
    wmoChunk('MOPV', mopvBuf),
    wmoChunk('MOPT', moptBuf),
    wmoChunk('MOPR', moprBuf),
    wmoChunk('MOVV', Buffer.alloc(0)),
    wmoChunk('MOVB', Buffer.alloc(0)),
    wmoChunk('MOLT', moltBuf),
    wmoChunk('MODS', modsBuf),
    wmoChunk('MODN', modnBuf),
    wmoChunk('MODD', moddBuf),
    wmoChunk('MFOG', mfogBuf),
  ]);

  return {
    rootBuffer,
    group0Buffer: g0.buffer,
    group1Buffer: g1.buffer,
    bboxMin: rootMin,
    bboxMax: rootMax,
  };
}

// ============================================================================
// 5. `WMOAreaTable.dbc` Builder (20 columns, string col 11)
// ============================================================================

export function buildWmoAreaTableDbc(WdbcBuilderClass = DefaultWdbcBuilder) {
  const dbc = new WdbcBuilderClass(20, [11]);
  const rows = [];
  let rowId = 1;

  for (const b of CELANDIA_BUILDINGS) {
    const g0Id = b.wmoId * 10 + 0;
    const g1Id = b.wmoId * 10 + 1;

    // NameSet 0: Celandia (Map 0)
    const celandiaEntries = [
      { nameSet: 0, wmoGroupId: -1, areaId: b.areaId, name: b.rootAreaName, flags: 0 },
      { nameSet: 0, wmoGroupId: g0Id, areaId: b.areaId, name: b.exteriorGroupName, flags: 2 },
      { nameSet: 0, wmoGroupId: g1Id, areaId: b.areaId, name: b.interiorGroupName, flags: 4 },
      // Also include 0 and 1 group index aliases so any lookup convention resolves cleanly
      { nameSet: 0, wmoGroupId: 0, areaId: b.areaId, name: b.exteriorGroupName, flags: 2 },
      { nameSet: 0, wmoGroupId: 1, areaId: b.areaId, name: b.interiorGroupName, flags: 4 },
      // NameSet 1: The Elsewhere & Reincarnation Sanctum (Map 1)
      { nameSet: 1, wmoGroupId: -1, areaId: b.elsewhereAreaId, name: b.elsewhereInteriorName, flags: 0 },
      { nameSet: 1, wmoGroupId: g0Id, areaId: b.elsewhereAreaId, name: b.exteriorGroupName, flags: 2 },
      { nameSet: 1, wmoGroupId: g1Id, areaId: b.elsewhereAreaId, name: b.elsewhereInteriorName, flags: 4 },
      { nameSet: 1, wmoGroupId: 0, areaId: b.elsewhereAreaId, name: b.exteriorGroupName, flags: 2 },
      { nameSet: 1, wmoGroupId: 1, areaId: b.elsewhereAreaId, name: b.elsewhereInteriorName, flags: 4 },
    ];

    for (const e of celandiaEntries) {
      const r = {
        0: rowId++,
        1: b.wmoId, // WMOID
        2: e.nameSet, // NameSetID
        3: e.wmoGroupId, // WMOGroupID (-1 for root, or MOGP area_table_id)
        4: 0, // SoundProviderPref
        5: 0, // SoundProviderPrefUnderwater
        6: 0, // AmbienceID
        7: 0, // ZoneMusic
        8: 0, // IntroSound
        9: e.flags, // Flags
        10: e.areaId, // AreaTableID
        11: e.name, // AreaName
      };
      dbc.addRow(r);
      rows.push(r);
    }
  }

  return { buffer: dbc.toBuffer(), rows };
}

// ============================================================================
// 6. `MWMO` / `MWID` / `MODF` Binary Builders for ADT Terrain Tiles
// ============================================================================

/**
 * Build `MWMO` string block, `MWID` offset array, and 64-byte `MODF` records
 * from a list of WMO placement descriptors.
 *
 * Remember `benilla-assets/src/coords.rs`:
 *   `wx = MAP_CENTER - modf.pos[2]`  =>  `modf.pos[2] = MAP_CENTER - wx`
 *   `wy = MAP_CENTER - modf.pos[0]`  =>  `modf.pos[0] = MAP_CENTER - wy`
 *   `wz = modf.pos[1]`               =>  `modf.pos[1] = wz`
 *   `rot = [0, 180, 0]` gives identity rotation in `coords::placement_rotation`!
 */
export function encodeWmoAdtChunks(placements) {
  const pathToNameId = new Map();
  const mwmoParts = [];
  const mwidOffsets = [];
  let byteOff = 0;

  for (const p of placements) {
    const wmoPath = p.mdxRefPath || p.wmoPath || p.path;
    if (!pathToNameId.has(wmoPath)) {
      const nameId = mwidOffsets.length;
      pathToNameId.set(wmoPath, nameId);
      mwidOffsets.push(byteOff);
      const b = Buffer.from(wmoPath + '\0', 'utf8');
      mwmoParts.push(b);
      byteOff += b.length;
    }
  }

  const mwmoBuf = mwmoParts.length > 0 ? Buffer.concat(mwmoParts) : Buffer.from([0]);
  const mwidBuf = Buffer.alloc(Math.max(1, mwidOffsets.length) * 4, 0);
  mwidOffsets.forEach((off, i) => mwidBuf.writeUInt32LE(off, i * 4));

  const modfBuf = Buffer.alloc(placements.length * 64, 0);
  placements.forEach((p, i) => {
    const wmoPath = p.mdxRefPath || p.wmoPath || p.path;
    const nameId = pathToNameId.get(wmoPath) ?? 0;
    const off = i * 64;
    const pos0 = MAP_CENTER - p.wy;
    const pos1 = p.wz;
    const pos2 = MAP_CENTER - p.wx;
    const halfExt = p.halfExtent ?? 28.0;
    const heightExt = p.heightExtent ?? 28.0;

    modfBuf.writeUInt32LE(nameId, off + 0); // nameId
    modfBuf.writeUInt32LE(p.uniqueId >>> 0, off + 4); // uniqueId
    modfBuf.writeFloatLE(pos0, off + 8); // pos[0] (MAP_CENTER - wy)
    modfBuf.writeFloatLE(pos1, off + 12); // pos[1] (wz)
    modfBuf.writeFloatLE(pos2, off + 16); // pos[2] (MAP_CENTER - wx)
    modfBuf.writeFloatLE(p.rotX ?? 0.0, off + 20); // rot[0]
    modfBuf.writeFloatLE(p.rotY ?? 180.0, off + 24); // rot[1] = 180 deg => identity in Bevy
    modfBuf.writeFloatLE(p.rotZ ?? 0.0, off + 28); // rot[2]
    modfBuf.writeFloatLE(pos0 - halfExt, off + 32); // extents.min[0]
    modfBuf.writeFloatLE(pos1 - 4.0, off + 36); // extents.min[1]
    modfBuf.writeFloatLE(pos2 - halfExt, off + 40); // extents.min[2]
    modfBuf.writeFloatLE(pos0 + halfExt, off + 44); // extents.max[0]
    modfBuf.writeFloatLE(pos1 + heightExt, off + 48); // extents.max[1]
    modfBuf.writeFloatLE(pos2 + halfExt, off + 52); // extents.max[2]
    modfBuf.writeUInt16LE(p.flags ?? 0, off + 56); // flags
    modfBuf.writeUInt16LE(p.doodadSet ?? 0, off + 58); // doodadSet = 0 (DefaultSet)
    modfBuf.writeUInt16LE(p.nameSet ?? 0, off + 60); // nameSet (0 = Celandia, 1 = Elsewhere)
    modfBuf.writeUInt16LE(0, off + 62); // pad
  });

  return { mwmoBuf, mwidBuf, modfBuf, pathToNameId };
}

// ============================================================================
// 7. Instanced Map 1 (`World/Maps/Elsewhere/Elsewhere.wdt` + `Elsewhere_30_30..33_33.adt`)
// ============================================================================

function adtChunk(magic, data) {
  const rev = magic.split('').reverse().join('');
  const hdr = Buffer.alloc(8);
  hdr.write(rev, 0, 4, 'ascii');
  hdr.writeUInt32LE(data.length, 4);
  return Buffer.concat([hdr, data]);
}

function buildWdtBuffer(activeTiles) {
  const mver = Buffer.alloc(4);
  mver.writeUInt32LE(18, 0);
  const mphd = Buffer.alloc(32, 0);
  const main = Buffer.alloc(64 * 64 * 8, 0);
  for (const [tx, ty] of activeTiles) {
    const idx = (ty * 64 + tx) * 8;
    main.writeUInt32LE(1, idx);
  }
  return Buffer.concat([
    adtChunk('MVER', mver),
    adtChunk('MPHD', mphd),
    adtChunk('MAIN', main),
    adtChunk('MWMO', Buffer.alloc(0)),
  ]);
}

/**
 * Procedural heightfield for Map 1 (**The Elsewhere & Reincarnation Sanctum**):
 * - Central Reincarnation Sanctum Causeway & Sovereign Plaza around `(0, 0)` at `z = 6.0`
 * - Four radial starlight causeways linking `(0, 0)` to the 4 outer Sanctum plazas at `(±110, ±110)` (`z = 7.5`)
 * - Ringed by an ethereal obsidian & crystal amphitheater ridge and starlit void sea (`z = 0.0`).
 */
export function sampleElsewhereHeight(wx, wy) {
  const rCenter = Math.hypot(wx, wy);
  // Central Sovereign Sanctum Plaza (`r <= 34`)
  if (rCenter <= 28.0) return 6.0;

  // Four outer Sanctum Plazas at `(±110, ±110)`
  const outerCenters = [
    [110.0, 110.0],
    [-110.0, -110.0],
    [110.0, -110.0],
    [-110.0, 110.0],
  ];
  let plateauBlend = 0.0;
  let targetPlateauZ = 6.0;

  if (rCenter < 44.0) {
    plateauBlend = Math.max(plateauBlend, 1.0 - (rCenter - 28.0) / 16.0);
    targetPlateauZ = 6.0;
  }

  for (const [cx, cy] of outerCenters) {
    const d = Math.hypot(wx - cx, wy - cy);
    if (d <= 28.0) return 7.5;
    if (d < 44.0) {
      const b = 1.0 - (d - 28.0) / 16.0;
      if (b > plateauBlend) {
        plateauBlend = b;
        targetPlateauZ = 7.5;
      }
    }
  }

  // Diagonal starlight causeways (`|wx| ≈ |wy|` up to `r = 165`)
  const diagDist = Math.min(Math.abs(wx - wy), Math.abs(wx + wy)) / Math.SQRT2;
  if (rCenter <= 165.0 && diagDist <= 14.0) {
    const causewayT = Math.min(1.0, Math.max(0.0, (rCenter - 28.0) / (155.5 - 28.0)));
    const cz = 6.0 + causewayT * 1.5;
    const edge = diagDist <= 8.0 ? 1.0 : 1.0 - (diagDist - 8.0) / 6.0;
    if (edge > plateauBlend) {
      plateauBlend = edge;
      targetPlateauZ = cz;
    }
  }

  // Base ethereal island ring + gentle harmonic waves
  const ring = Math.exp(-Math.pow((rCenter - 195.0) / 48.0, 2)) * 14.0;
  const SanctuaryBowl = rCenter < 195.0 ? 2.8 + Math.cos(rCenter * 0.03) * 1.4 : -3.5;
  const ripples = Math.sin(wx * 0.045) * Math.cos(wy * 0.045) * 1.2;
  const baseZ = SanctuaryBowl + ring + ripples;

  if (plateauBlend > 0.0) {
    const s = plateauBlend * plateauBlend * (3.0 - 2.0 * plateauBlend);
    return baseZ * (1.0 - s) + targetPlateauZ * s;
  }
  return baseZ;
}

function sampleElsewhereNormal(wx, wy) {
  const eps = 1.25;
  const hL = sampleElsewhereHeight(wx - eps, wy);
  const hR = sampleElsewhereHeight(wx + eps, wy);
  const hD = sampleElsewhereHeight(wx, wy - eps);
  const hU = sampleElsewhereHeight(wx, wy + eps);
  const gx = (hR - hL) / (2 * eps);
  const gy = (hU - hD) / (2 * eps);
  let nx = -gx;
  let ny = -gy;
  let nz = 1.0;
  const len = Math.hypot(nx, ny, nz) || 1.0;
  nx /= len;
  ny /= len;
  nz /= len;
  return [
    Math.max(-127, Math.min(127, Math.round(ny * 127))),
    Math.max(-127, Math.min(127, Math.round(nx * 127))),
    Math.max(-127, Math.min(127, Math.round(nz * 127))),
  ];
}

function buildElsewhereAdtTile(tx, ty, wmoChunks, f32) {
  const tileMinX = (32 - (tx + 1)) * TILE_SIZE;
  const tileMaxX = (32 - tx) * TILE_SIZE;
  const tileMinY = (32 - (ty + 1)) * TILE_SIZE;
  const tileMaxY = (32 - ty) * TILE_SIZE;

  const mver = Buffer.alloc(4);
  mver.writeUInt32LE(18, 0);

  // MTEX: 5 Celandia & Elsewhere biome textures
  const texFiles = [
    'Tileset\\Celandia\\NocturnumObsidian.blp',
    'Tileset\\Celandia\\PorcelainShell.blp',
    'Tileset\\Celandia\\FrostbellSnow.blp',
    'Tileset\\Celandia\\GlasswakeSand.blp',
    'Tileset\\Celandia\\AureateGrass.blp',
  ];
  const mtexBuf = Buffer.from(texFiles.join('\0') + '\0', 'utf8');

  // MMDX / MMID / MDDF: Reincarnation & Nocturnum soulslike doodads around the Sanctum
  const doodadModels = [
    'World\\Celandia\\Doodads\\NocturnumSpire.mdx',
    'World\\Celandia\\Doodads\\PorcelainSpire.mdx',
    'World\\Celandia\\Doodads\\FrostbellPine.mdx',
    'World\\Celandia\\Doodads\\GlasswakeObelisk.mdx',
    'World\\Celandia\\Interiors\\NocturnumRiftGate.mdx',
    'World\\Celandia\\Interiors\\AureateSunBrazier.mdx',
  ];
  const mmdxParts = [];
  const mmidOffsets = [];
  let mmdxOff = 0;
  for (const dm of doodadModels) {
    mmidOffsets.push(mmdxOff);
    const b = Buffer.from(dm + '\0', 'utf8');
    mmdxParts.push(b);
    mmdxOff += b.length;
  }
  const mmdxBuf = Buffer.concat(mmdxParts);
  const mmidBuf = Buffer.alloc(mmidOffsets.length * 4);
  mmidOffsets.forEach((o, i) => mmidBuf.writeUInt32LE(o, i * 4));

  // Generate scenic doodad placements inside this tile (avoiding the 5 WMO footprints!)
  const wmoCenters = [
    [0.0, 0.0],
    [110.0, 110.0],
    [-110.0, -110.0],
    [110.0, -110.0],
    [-110.0, 110.0],
  ];
  const doodads = [];
  let uid = 50000 + (ty * 64 + tx) * 200;
  for (let gx = -260; gx <= 260; gx += 40) {
    for (let gy = -260; gy <= 260; gy += 40) {
      if (gx < tileMinX || gx >= tileMaxX || gy < tileMinY || gy >= tileMaxY) continue;
      let tooCloseToWmo = false;
      for (const [cx, cy] of wmoCenters) {
        if (Math.hypot(gx - cx, gy - cy) < 34.0) {
          tooCloseToWmo = true;
          break;
        }
      }
      if (tooCloseToWmo) continue;
      const r = Math.hypot(gx, gy);
      if (r > 235.0) continue;
      const wz = sampleElsewhereHeight(gx, gy);
      if (wz < 1.0) continue;
      const nameId = Math.abs(((gx * 7 + gy * 13) | 0)) % doodadModels.length;
      doodads.push({
        nameId,
        uniqueId: uid++,
        wx: gx,
        wy: gy,
        wz,
        rotY: ((gx * 31 + gy * 17) % 360 + 360) % 360,
        scale: nameId >= 4 ? 1152 : 960,
      });
    }
  }

  const mddfBuf = Buffer.alloc(doodads.length * 36);
  doodads.forEach((d, i) => {
    const off = i * 36;
    mddfBuf.writeUInt32LE(d.nameId, off + 0);
    mddfBuf.writeUInt32LE(d.uniqueId, off + 4);
    mddfBuf.writeFloatLE(MAP_CENTER - d.wy, off + 8);
    mddfBuf.writeFloatLE(d.wz, off + 12);
    mddfBuf.writeFloatLE(MAP_CENTER - d.wx, off + 16);
    mddfBuf.writeFloatLE(0, off + 20);
    mddfBuf.writeFloatLE(d.rotY, off + 24);
    mddfBuf.writeFloatLE(0, off + 28);
    mddfBuf.writeUInt16LE(d.scale, off + 32);
    mddfBuf.writeUInt16LE(0, off + 34);
  });

  // Build all 256 MCNK chunks
  const mcnkBuffers = [];
  for (let cy = 0; cy < 16; cy++) {
    for (let cx = 0; cx < 16; cx++) {
      const chunkPosX = MAP_CENTER - tx * TILE_SIZE - cx * CHUNK_SIZE;
      const chunkPosY = MAP_CENTER - ty * TILE_SIZE - cy * CHUNK_SIZE;
      const baseHeight = sampleElsewhereHeight(chunkPosX, chunkPosY);

      const mcvtData = Buffer.alloc(145 * 4);
      const mcnrData = Buffer.alloc(145 * 3 + 13, 0);
      const step = CHUNK_SIZE / 8.0;
      let vIdx = 0;
      for (let r = 0; r < 17; r++) {
        const isInner = r % 2 === 1;
        const count = isInner ? 8 : 9;
        const rowY = (r * 0.5) * step;
        for (let c = 0; c < count; c++) {
          const colX = (isInner ? c + 0.5 : c) * step;
          const wx = chunkPosX - rowY;
          const wy = chunkPosY - colX;
          const h = sampleElsewhereHeight(wx, wy);
          mcvtData.writeFloatLE(h - baseHeight, vIdx * 4);
          const [nb0, nb1, nb2] = sampleElsewhereNormal(wx, wy);
          mcnrData.writeInt8(nb0, vIdx * 3 + 0);
          mcnrData.writeInt8(nb1, vIdx * 3 + 1);
          mcnrData.writeInt8(nb2, vIdx * 3 + 2);
          vIdx++;
        }
      }

      // Choose primary biome texture based on quadrant in The Elsewhere
      const centerWx = chunkPosX - CHUNK_SIZE * 0.5;
      const centerWy = chunkPosY - CHUNK_SIZE * 0.5;
      let primaryTex = 0; // NocturnumObsidian
      if (Math.hypot(centerWx, centerWy) < 52.0) primaryTex = 1; // PorcelainShell plaza
      else if (centerWx > 40 && centerWy > 40) primaryTex = 2; // FrostbellSnow
      else if (centerWx < -40 && centerWy < -40) primaryTex = 3; // GlasswakeSand
      else if (centerWx > 40 && centerWy < -40) primaryTex = 4; // AureateGrass

      const mclyData = Buffer.alloc(16, 0);
      mclyData.writeUInt32LE(primaryTex, 0);

      const mcalData = Buffer.alloc(0);
      const mcshData = Buffer.alloc(512, 0);

      const mclqData = Buffer.alloc(8 + 81 * 8 + 64 + 84, 0);
      mclqData.writeFloatLE(0.0, 0);
      mclqData.writeFloatLE(0.0, 4);
      let lOff = 8;
      for (let lv = 0; lv < 81; lv++) {
        mclqData.writeUInt8(12, lOff + 0);
        mclqData.writeUInt8(4, lOff + 1);
        mclqData.writeFloatLE(0.0, lOff + 4);
        lOff += 8;
      }
      for (let lt = 0; lt < 64; lt++) {
        mclqData.writeUInt8(0x06, lOff + lt);
      }

      const subMcvt = adtChunk('MCVT', mcvtData);
      const subMcnr = adtChunk('MCNR', mcnrData);
      const subMcly = adtChunk('MCLY', mclyData);
      const subMcrf = adtChunk('MCRF', Buffer.alloc(0));
      const subMcsh = adtChunk('MCSH', mcshData);
      const subMcal = adtChunk('MCAL', mcalData);
      const subMclq = adtChunk('MCLQ', mclqData);

      const hdrSize = 128;
      const ofsHeight = 8 + hdrSize;
      const ofsNormal = ofsHeight + subMcvt.length;
      const ofsLayer = ofsNormal + subMcnr.length;
      const ofsRefs = ofsLayer + subMcly.length;
      const ofsShadow = ofsRefs + subMcrf.length;
      const ofsAlpha = ofsShadow + subMcsh.length;
      const ofsLiquid = ofsAlpha + subMcal.length;

      const hdr = Buffer.alloc(128, 0);
      const headerWords = [
        0x01 | 0x04, // flags: MCSH + ocean liquid
        cx,
        cy,
        1, // nLayers = 1
        0,
        ofsHeight,
        ofsNormal,
        ofsLayer,
        ofsRefs,
        ofsAlpha,
        subMcal.length,
        ofsShadow,
        subMcsh.length,
        10, // AreaID = 10 (The Elsewhere)
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ofsLiquid,
        subMclq.length,
        f32(chunkPosX),
        f32(chunkPosY),
        f32(baseHeight),
        0,
        0,
        0,
      ];
      for (let w = 0; w < 32; w++) {
        hdr.writeUInt32LE(headerWords[w] >>> 0, w * 4);
      }

      mcnkBuffers.push(
        adtChunk(
          'MCNK',
          Buffer.concat([hdr, subMcvt, subMcnr, subMcly, subMcrf, subMcsh, subMcal, subMclq]),
        ),
      );
    }
  }

  const mhdrData = Buffer.alloc(64, 0);
  const cMver = adtChunk('MVER', mver);
  const cMhdr = adtChunk('MHDR', mhdrData);
  const cMcin = adtChunk('MCIN', Buffer.alloc(256 * 16, 0));
  const cMtex = adtChunk('MTEX', mtexBuf);
  const cMmdx = adtChunk('MMDX', mmdxBuf);
  const cMmid = adtChunk('MMID', mmidBuf);
  const cMwmo = adtChunk('MWMO', wmoChunks.mwmoBuf);
  const cMwid = adtChunk('MWID', wmoChunks.mwidBuf);
  const cMddf = adtChunk('MDDF', mddfBuf);
  const cModf = adtChunk('MODF', wmoChunks.modfBuf);

  const mhdrBase = 20;
  let cursor = cMver.length + cMhdr.length;
  const ofsMcin = cursor - mhdrBase;
  cursor += cMcin.length;
  const ofsMtex = cursor - mhdrBase;
  cursor += cMtex.length;
  const ofsMmdx = cursor - mhdrBase;
  cursor += cMmdx.length;
  const ofsMmid = cursor - mhdrBase;
  cursor += cMmid.length;
  const ofsMwmo = cursor - mhdrBase;
  cursor += cMwmo.length;
  const ofsMwid = cursor - mhdrBase;
  cursor += cMwid.length;
  const ofsMddf = cursor - mhdrBase;
  cursor += cMddf.length;
  const ofsModf = cursor - mhdrBase;
  cursor += cModf.length;

  mhdrData.writeUInt32LE(ofsMcin, 4);
  mhdrData.writeUInt32LE(ofsMtex, 8);
  mhdrData.writeUInt32LE(ofsMmdx, 12);
  mhdrData.writeUInt32LE(ofsMmid, 16);
  mhdrData.writeUInt32LE(ofsMwmo, 20);
  mhdrData.writeUInt32LE(ofsMwid, 24);
  mhdrData.writeUInt32LE(ofsMddf, 28);
  mhdrData.writeUInt32LE(ofsModf, 32);

  const mcinPayload = cMcin.subarray(8);
  let mcnkOffset = cursor;
  for (let i = 0; i < 256; i++) {
    const len = mcnkBuffers[i].length;
    mcinPayload.writeUInt32LE(mcnkOffset, i * 16 + 0);
    mcinPayload.writeUInt32LE(len, i * 16 + 4);
    mcnkOffset += len;
  }

  return Buffer.concat([
    cMver,
    cMhdr,
    cMcin,
    cMtex,
    cMmdx,
    cMmid,
    cMwmo,
    cMwid,
    cMddf,
    cModf,
    ...mcnkBuffers,
  ]);
}

function buildElsewhereMinimapTile(tx, ty, createBlp2) {
  const tileMaxX = (32 - tx) * TILE_SIZE;
  const tileMaxY = (32 - ty) * TILE_SIZE;
  return createBlp2(64, 64, (px, py) => {
    const wx = tileMaxX - ((py + 0.5) / 64.0) * TILE_SIZE;
    const wy = tileMaxY - ((px + 0.5) / 64.0) * TILE_SIZE;
    const h = sampleElsewhereHeight(wx, wy);
    if (h <= 0.0) {
      return [24, 18, 44, 255];
    }
    const glow = Math.min(45, Math.max(0, h * 4.5));
    return [92 + glow * 2.2, 74 + glow * 1.8, 148 + glow * 2.0, 255];
  });
}

// ============================================================================
// 8. Main Export: `buildCelandiaWmosAndElsewhere(ctx)`
// ============================================================================

export async function buildCelandiaWmosAndElsewhere(ctx = {}) {
  const dataDir = ctx.dataDir || DEFAULT_DATA_DIR;
  const writeFile = ctx.writeFile || ((relPath, buf) => defaultWriteFile(dataDir, relPath, buf));
  const createBlp2 = ctx.createBlp2 || defaultCreateBlp2;
  const f32 = ctx.f32 || defaultF32;
  const WdbcBuilderClass = ctx.WdbcBuilder || DefaultWdbcBuilder;
  const buildProceduralPartsGlb = ctx.buildProceduralPartsGlb || defaultBuildProceduralPartsGlb;

  let THREE = ctx.THREE;
  if (!THREE) {
    THREE = await import(
      pathToFileURL(path.join(CELANDIA_DIR, 'node_modules/three/build/three.module.js')).href
    );
  }

  let sampleCelandiaHeight = ctx.sampleCelandiaHeight;
  if (!sampleCelandiaHeight) {
    const atlas = await import(
      pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/world/atlas.js')).href
    );
    sampleCelandiaHeight = (wx, wy) => atlas.height(wy, wx) * 1.35;
  }

  // 1. Generate 6 custom architectural `.blp` textures
  buildArchitecturalBlpTextures(writeFile, createBlp2);

  // 2. Generate 8 rich interior `.glb` furniture/prop doodads (`.m2` files)
  buildInteriorFurnitureModels(writeFile, THREE, buildProceduralPartsGlb);

  // 3. Build & write all 5 multi-room enterable `.wmo` buildings (`Root.wmo`, `_000.wmo`, `_001.wmo`)
  const compiledBuildings = [];
  for (const b of CELANDIA_BUILDINGS) {
    const compiled = buildSingleWmoBuilding(b);
    const baseNoExt = b.rootPath.replace(/\.wmo$/i, '');
    writeFile(b.rootPath, compiled.rootBuffer);
    writeFile(`${baseNoExt}_000.wmo`, compiled.group0Buffer);
    writeFile(`${baseNoExt}_001.wmo`, compiled.group1Buffer);
    compiledBuildings.push({ ...b, ...compiled });
  }

  // 4. Build & write `DBFilesClient/WMOAreaTable.dbc`
  const wmoAreaDbc = buildWmoAreaTableDbc(WdbcBuilderClass);
  writeFile('DBFilesClient/WMOAreaTable.dbc', wmoAreaDbc.buffer);

  // 5. Build Celandia (Map 0) WMO placement descriptors & encoded `MWMO`/`MWID`/`MODF` chunks
  const celandiaPlacements = CELANDIA_BUILDINGS.map((b, idx) => {
    const wz = sampleCelandiaHeight(b.wx, b.wy);
    return {
      key: b.key,
      wmoId: b.wmoId,
      areaId: b.areaId,
      nameId: idx,
      uniqueId: 9001 + idx,
      wmoPath: b.mdxRefPath,
      mdxRefPath: b.mdxRefPath,
      rootPath: b.rootPath,
      wx: b.wx,
      wy: b.wy,
      wz,
      // Pre-computed ADT placement coordinates (`MAP_CENTER - wy`, `wz`, `MAP_CENTER - wx`)
      pos: [MAP_CENTER - b.wy, wz, MAP_CENTER - b.wx],
      rot: [0.0, 180.0, 0.0],
      rotX: 0.0,
      rotY: 180.0,
      rotZ: 0.0,
      halfExtent: 28.0,
      heightExtent: 28.0,
      flags: 0,
      doodadSet: 0,
      nameSet: 0,
    };
  });
  const celandiaWmoChunks = encodeWmoAdtChunks(celandiaPlacements);

  // 6. Build & write Map 1 (`World/Maps/Elsewhere/Elsewhere.wdt` + `Elsewhere_30_30.adt`..`Elsewhere_33_33.adt`)
  const elsewherePlacements = CELANDIA_BUILDINGS.map((b, idx) => {
    const wz = sampleElsewhereHeight(b.elsewhereWx, b.elsewhereWy);
    return {
      key: b.key,
      wmoId: b.wmoId,
      areaId: b.elsewhereAreaId,
      nameId: idx,
      uniqueId: 19001 + idx,
      wmoPath: b.mdxRefPath,
      mdxRefPath: b.mdxRefPath,
      rootPath: b.rootPath,
      wx: b.elsewhereWx,
      wy: b.elsewhereWy,
      wz,
      pos: [MAP_CENTER - b.elsewhereWy, wz, MAP_CENTER - b.elsewhereWx],
      rot: [0.0, 180.0, 0.0],
      rotX: 0.0,
      rotY: 180.0,
      rotZ: 0.0,
      halfExtent: 28.0,
      heightExtent: 28.0,
      flags: 0,
      doodadSet: 0,
      nameSet: 1, // NameSet 1 -> Sanctum of the Elsewhere names in WMOAreaTable.dbc
    };
  });
  const elsewhereWmoChunks = encodeWmoAdtChunks(elsewherePlacements);

  const activeTiles = [];
  for (let ty = 30; ty <= 33; ty++) {
    for (let tx = 30; tx <= 33; tx++) {
      activeTiles.push([tx, ty]);
    }
  }

  const elsewhereWdt = buildWdtBuffer(activeTiles);
  writeFile('World/Maps/Elsewhere/Elsewhere.wdt', elsewhereWdt);

  const md5Lines = [];
  for (const [tx, ty] of activeTiles) {
    const adtBuf = buildElsewhereAdtTile(tx, ty, elsewhereWmoChunks, f32);
    writeFile(`World/Maps/Elsewhere/Elsewhere_${tx}_${ty}.adt`, adtBuf);
    const miniBuf = buildElsewhereMinimapTile(tx, ty, createBlp2);
    const miniName = `elsewhere_${tx}_${ty}.blp`;
    writeFile(`textures/Minimap/${miniName}`, miniBuf);
    md5Lines.push(`Elsewhere\\map${tx}_${ty}.blp\t${miniName}`);
  }

  // Append Elsewhere minimap entries to `textures/Minimap/md5translate.trs` if it already exists
  const trsFullPath = path.join(dataDir, 'textures', 'Minimap', 'md5translate.trs');
  if (fs.existsSync(trsFullPath)) {
    const existing = fs.readFileSync(trsFullPath, 'utf8');
    if (!existing.includes('Elsewhere\\map30_30.blp')) {
      fs.writeFileSync(trsFullPath, existing.trimEnd() + '\r\n' + md5Lines.join('\r\n') + '\r\n');
    }
  } else {
    writeFile('textures/Minimap/md5translate.trs', Buffer.from(md5Lines.join('\r\n') + '\r\n', 'utf8'));
  }

  // Return an Array of the 5 Celandia `MODF` placement records enriched with properties & helpers
  // so callers using either `const placements = await buildCelandiaWmosAndElsewhere(ctx)` or
  // `const { mwmoBuf, mwidBuf, modfBuf, placements } = await buildCelandiaWmosAndElsewhere(ctx)` work seamlessly!
  const result = [...celandiaPlacements];
  Object.assign(result, {
    placements: celandiaPlacements,
    wmoPlacements: celandiaPlacements,
    elsewherePlacements,
    wmoPaths: CELANDIA_BUILDINGS.map((b) => b.mdxRefPath),
    mwmoBuf: celandiaWmoChunks.mwmoBuf,
    mwidBuf: celandiaWmoChunks.mwidBuf,
    modfBuf: celandiaWmoChunks.modfBuf,
    elsewhereMwmoBuf: elsewhereWmoChunks.mwmoBuf,
    elsewhereMwidBuf: elsewhereWmoChunks.mwidBuf,
    elsewhereModfBuf: elsewhereWmoChunks.modfBuf,
    wmoAreaTableBuffer: wmoAreaDbc.buffer,
    wmoAreaRows: wmoAreaDbc.rows,
    buildings: compiledBuildings,
    textures: CELANDIA_WMO_TEXTURES,
    doodads: CELANDIA_INTERIOR_DOODADS,
    elsewhereTiles: activeTiles,
    encodeWmoAdtChunks,
  });

  return result;
}

// ============================================================================
// 9. Self-Test & CLI Runner (`node scripts/build-celandia-wmo.mjs --test`)
// ============================================================================

function verifyWmoChunks(buf, expectedMagics, label) {
  let off = 0;
  const seen = new Map();
  while (off + 8 <= buf.length) {
    const rev = buf.toString('ascii', off, off + 4);
    const magic = rev.split('').reverse().join('');
    const size = buf.readUInt32LE(off + 4);
    if (off + 8 + size > buf.length) {
      throw new Error(`${label}: chunk ${magic} at ${off} overflows buffer (${off + 8 + size} > ${buf.length})`);
    }
    seen.set(magic, { offset: off, size, payload: buf.subarray(off + 8, off + 8 + size) });
    off += 8 + size;
  }
  for (const m of expectedMagics) {
    if (!seen.has(m)) {
      throw new Error(`${label}: missing required chunk ${m} (found: ${[...seen.keys()].join(', ')})`);
    }
  }
  return seen;
}

async function runCli() {
  const isTest = process.argv.includes('--test');
  const t0 = Date.now();
  console.log('[build-celandia-wmo] Generating Celandia WMOs, Interior Doodads, WMOAreaTable.dbc & Elsewhere Map 1...');
  const res = await buildCelandiaWmosAndElsewhere();

  if (isTest) {
    console.log('[build-celandia-wmo] Running binary verification self-test...');
    // 1. Verify all 6 architectural BLP2 textures
    for (const rel of CELANDIA_WMO_TEXTURES) {
      const full = path.join(DEFAULT_DATA_DIR, ...rel.split('/'));
      const buf = fs.readFileSync(full);
      if (buf.toString('ascii', 0, 4) !== 'BLP2') throw new Error(`Invalid BLP2 header in ${rel}`);
    }

    // 2. Verify all 8 interior glTF 2.0 `.m2` furniture models
    for (const rel of CELANDIA_INTERIOR_DOODADS) {
      const full = path.join(DEFAULT_DATA_DIR, ...rel.split('/'));
      const buf = fs.readFileSync(full);
      if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error(`Invalid GLB header in ${rel}`);
    }

    // 3. Verify all 5 multi-room WMO buildings (`Root.wmo`, `_000.wmo`, `_001.wmo`)
    for (const b of CELANDIA_BUILDINGS) {
      const rootFull = path.join(DEFAULT_DATA_DIR, ...b.rootPath.split('/'));
      const g0Full = rootFull.replace(/\.wmo$/i, '_000.wmo');
      const g1Full = rootFull.replace(/\.wmo$/i, '_001.wmo');

      const rootChunks = verifyWmoChunks(
        fs.readFileSync(rootFull),
        ['MVER', 'MOHD', 'MOTX', 'MOMT', 'MOGN', 'MOGI', 'MOSB', 'MOPV', 'MOPT', 'MOPR', 'MOLT', 'MODS', 'MODN', 'MODD', 'MFOG'],
        b.rootPath,
      );
      const mohd = rootChunks.get('MOHD').payload;
      const nGroups = mohd.readUInt32LE(4);
      const nPortals = mohd.readUInt32LE(8);
      const wmoId = mohd.readUInt32LE(32);
      if (nGroups !== 2 || nPortals !== 2 || wmoId !== b.wmoId) {
        throw new Error(`${b.rootPath}: unexpected MOHD nGroups=${nGroups}, nPortals=${nPortals}, wmoId=${wmoId}`);
      }

      const g0Chunks = verifyWmoChunks(fs.readFileSync(g0Full), ['MVER', 'MOGP'], `${b.key}_000.wmo`);
      const g0Mogp = g0Chunks.get('MOGP').payload;
      const g0Flags = g0Mogp.readUInt32LE(8);
      if ((g0Flags & 0x08) === 0) {
        throw new Error(`${b.key}_000.wmo must have 0x08 EXTERIOR flag set (got 0x${g0Flags.toString(16)})`);
      }

      const g1Chunks = verifyWmoChunks(fs.readFileSync(g1Full), ['MVER', 'MOGP'], `${b.key}_001.wmo`);
      const g1Mogp = g1Chunks.get('MOGP').payload;
      const g1Flags = g1Mogp.readUInt32LE(8);
      const g1LiquidType = g1Mogp.readUInt32LE(52);
      if ((g1Flags & 0x2000) === 0 || (g1Flags & 0x48) !== 0) {
        throw new Error(`${b.key}_001.wmo must have 0x2000 INDOOR set and (flags & 0x48) == 0 (got 0x${g1Flags.toString(16)})`);
      }
      if (g1LiquidType !== 15) {
        throw new Error(`${b.key}_001.wmo group_liquid @ 52 must be 15 (NO_GROUP_LIQUID), got ${g1LiquidType}`);
      }
      verifyWmoChunks(
        g1Mogp.subarray(68),
        ['MOPY', 'MOVI', 'MOVT', 'MONR', 'MOTV', 'MOBA', 'MOLR', 'MODR', 'MOBN', 'MOBR', 'MOCV', 'MLIQ'],
        `${b.key}_001.wmo subchunks`,
      );
    }

    // 4. Verify `DBFilesClient/WMOAreaTable.dbc`
    const wmoDbcBuf = fs.readFileSync(path.join(DEFAULT_DATA_DIR, 'DBFilesClient', 'WMOAreaTable.dbc'));
    if (wmoDbcBuf.toString('ascii', 0, 4) !== 'WDBC') throw new Error('Invalid WMOAreaTable.dbc header');
    const recCount = wmoDbcBuf.readUInt32LE(4);
    const fieldCount = wmoDbcBuf.readUInt32LE(8);
    if (recCount < 25 || fieldCount !== 20) {
      throw new Error(`Unexpected WMOAreaTable.dbc shape: rows=${recCount}, fields=${fieldCount}`);
    }

    // 5. Verify Map 1 (`World/Maps/Elsewhere/Elsewhere.wdt` & 16 `.adt` tiles)
    const wdtBuf = fs.readFileSync(path.join(DEFAULT_DATA_DIR, 'World', 'Maps', 'Elsewhere', 'Elsewhere.wdt'));
    verifyWmoChunks(wdtBuf, ['MVER', 'MPHD', 'MAIN', 'MWMO'], 'Elsewhere.wdt');
    for (let ty = 30; ty <= 33; ty++) {
      for (let tx = 30; tx <= 33; tx++) {
        const adtPath = path.join(DEFAULT_DATA_DIR, 'World', 'Maps', 'Elsewhere', `Elsewhere_${tx}_${ty}.adt`);
        const adtBuf = fs.readFileSync(adtPath);
        const adtChunks = verifyWmoChunks(
          adtBuf,
          ['MVER', 'MHDR', 'MCIN', 'MTEX', 'MMDX', 'MMID', 'MWMO', 'MWID', 'MDDF', 'MODF', 'MCNK'],
          `Elsewhere_${tx}_${ty}.adt`,
        );
        if (adtChunks.get('MODF').size !== 5 * 64) {
          throw new Error(`Elsewhere_${tx}_${ty}.adt MODF size must be ${5 * 64}, got ${adtChunks.get('MODF').size}`);
        }
      }
    }

    console.log(
      `[build-celandia-wmo] Self-test PASSED! Verified 6 BLP2 textures, 8 GLB interior props, 5 multi-room WMOs (15 files), WMOAreaTable.dbc (${recCount} rows), and Elsewhere Map 1 (1 WDT + 16 ADTs) in ${((Date.now() - t0) / 1000).toFixed(2)}s.`,
    );
  } else {
    console.log(
      `[build-celandia-wmo] Done in ${((Date.now() - t0) / 1000).toFixed(2)}s (${res.length} WMO placements).`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await runCli();
}
