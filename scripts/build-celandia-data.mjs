#!/usr/bin/env node
/**
 * Build Celandia + Sister-Project Loose Asset Corpus (`WoW/Data/`) for Xirtoth (`benilla` / `warcraft-survivors`).
 *
 * Generates:
 * 1. Fonts (`WoW/Data/Fonts/FRIZQT__.TTF`, `ARIALN.ttf`)
 * 2. BLP2 Raw3 BGRA8 Textures (`Textures/CelandiaWhite.blp`, `Textures/BakedNpcTextures/CelandiaHero.blp`,
 *    5 Celandia terrain biome tilesets under `Tileset/Celandia/*.blp`, and 36 ability/weapon icons under `Interface/Icons/*.blp`)
 * 3. Rigged & Animated Binary glTF 2.0 (`.glb`) Models written to `.m2` paths:
 *    - All 14 Celandia cast characters (`rook`, `serein`, `ilex`, `mora`, `fizz`, `latch`, `moss`,
 *      `riff`, `daze`, `elowen`, `solenne`, `avelune`, `oriel`, `wren`) with 21-bone skeletons and
 *      10 baked procedural animations (`Stand`, `Death`, `Walk`, `Run`, `AttackUnarmed`,
 *      `ParryUnarmed`, `Jump`, `Swim`, `SpellCastDirected`, `SpellCastOmni`)
 *    - Celandia fauna & bosses (`PorcelainHopper`, `WoollyDrifter`, `GlassSkimmer`, `SkyManta`, `ObsidianColossus`)
 *    - Celandia & sister-project weapons, shields, spell visuals, and biome trees/spires
 *    - Curated SFW-filtered `.glb` models from `reincarnation`, `valleygirlofdeath`, and `tekkajem game`
 * 4. Monolithic WoW 1.12 `.wdt` + `.adt` terrain tiles (`World/Maps/{Azeroth,Kalimdor,Celandia}/`)
 *    sampled directly from Celandia's `atlas.js` (`height`, `surface`, `biomeWeights`, `ISLANDS`, `NOCTURNUM_ISLE`)
 *    with `MCVT` heights, `MCNR` smooth normals, `MCLY` biome textures, `MCLQ` water/ocean surfaces, and `MDDF` tree/spire doodads.
 * 5. Complete `DBFilesClient/*.dbc` (`WDBC`) tables matching `benilla-formats`'s exact schemas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'WoW', 'Data');

const CELANDIA_DIR = '/Users/xmacbookm5/Projects/j3games/Celandia';
const REINCARNATION_DIR = '/Users/xmacbookm5/Projects/j3games/reincarnation';
const VALLEYGIRL_DIR = '/Users/xmacbookm5/Projects/j3games/valleygirlofdeath';
const TEKKAJEM_DIR = '/Users/xmacbookm5/Projects/jem+tekkaman movie/tekkajem game';

// Dynamically import Three.js and Celandia ES modules from the Celandia project
const THREE = await import(pathToFileURL(path.join(CELANDIA_DIR, 'node_modules/three/build/three.module.js')).href);
const atlas = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/world/atlas.js')).href);
const cast = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/cast/cast.js')).href);
const rigMod = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/cast/rig.js')).href);
const geoMod = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/cast/geo.js')).href);

import { buildHumanoidAnimations, buildCreatureAnimations, buildAnimationDataDbc } from './build-celandia-anims.mjs';
import { buildCelandiaWmosAndElsewhere } from './build-celandia-wmo.mjs';
import { buildCelandiaAudio } from './build-celandia-audio.mjs';
import { buildCelandiaUi } from './build-celandia-ui.mjs';

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeFile(relPath, buffer) {
  const full = path.join(DATA_DIR, ...relPath.split(/[\\/]/));
  ensureDir(full);
  fs.writeFileSync(full, buffer);
}

// ============================================================================
// 1. BLP2 (Raw3 Uncompressed BGRA8) Writer
// ============================================================================
function createBlp2(width, height, pixelFn) {
  const headerSize = 148;
  const paletteSize = 1024;
  const pixelBytes = width * height * 4;
  const buf = Buffer.alloc(headerSize + paletteSize + pixelBytes, 0);

  buf.write('BLP2', 0, 4, 'ascii');
  buf.writeUInt32LE(1, 4); // content = Direct (1)
  buf.writeUInt8(3, 8);    // compression = Raw3 (3)
  buf.writeUInt8(8, 9);    // alpha_bits = 8
  buf.writeUInt8(0, 10);   // alpha_type = 0
  buf.writeUInt8(0, 11);   // has_mipmaps = 0
  buf.writeUInt32LE(width, 12);
  buf.writeUInt32LE(height, 16);
  buf.writeUInt32LE(headerSize + paletteSize, 20); // offsets[0]
  buf.writeUInt32LE(pixelBytes, 20 + 64);          // sizes[0]

  const pixOffset = headerSize + paletteSize;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const idx = pixOffset + (y * width + x) * 4;
      buf[idx + 0] = Math.max(0, Math.min(255, b | 0));
      buf[idx + 1] = Math.max(0, Math.min(255, g | 0));
      buf[idx + 2] = Math.max(0, Math.min(255, r | 0));
      buf[idx + 3] = Math.max(0, Math.min(255, (a ?? 255) | 0));
    }
  }
  return buf;
}

function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function buildTextures() {
  console.log('[1/5] Generating BLP2 textures, tilesets, and spell icons...');

  // White 16x16 texture for vertex-colored .glb models & BakedNpcTextures
  const whiteBlp = createBlp2(16, 16, () => [255, 255, 255, 255]);
  writeFile('Textures/CelandiaWhite.blp', whiteBlp);
  writeFile('Textures/BakedNpcTextures/CelandiaHero.blp', whiteBlp);

  // 5 Celandia Kingdom terrain textures
  const tilesets = [
    { path: 'Tileset/Celandia/PorcelainGrass.blp', base: [126, 164, 96], hi: [232, 224, 214], speck: [188, 152, 174] },
    { path: 'Tileset/Celandia/FrostbellSnow.blp', base: [212, 224, 248], hi: [246, 250, 255], speck: [148, 198, 240] },
    { path: 'Tileset/Celandia/GlasswakeSand.blp', base: [228, 176, 132], hi: [248, 218, 176], speck: [96, 212, 208] },
    { path: 'Tileset/Celandia/AureateTerrace.blp', base: [218, 184, 112], hi: [248, 232, 182], speck: [164, 132, 74] },
    { path: 'Tileset/Celandia/NocturnumBasalt.blp', base: [64, 52, 84], hi: [108, 88, 142], speck: [168, 96, 212] },
  ];

  for (const t of tilesets) {
    const blp = createBlp2(64, 64, (x, y, w, h) => {
      const n1 = Math.sin((x / w) * Math.PI * 4) * Math.cos((y / h) * Math.PI * 4) * 0.5 + 0.5;
      const n2 = hash2(x, y);
      const r = t.base[0] * (1 - n1 * 0.25) + t.hi[0] * (n1 * 0.25) + (n2 > 0.85 ? (t.speck[0] - t.base[0]) * 0.4 : 0);
      const g = t.base[1] * (1 - n1 * 0.25) + t.hi[1] * (n1 * 0.25) + (n2 > 0.85 ? (t.speck[1] - t.base[1]) * 0.4 : 0);
      const b = t.base[2] * (1 - n1 * 0.25) + t.hi[2] * (n1 * 0.25) + (n2 > 0.85 ? (t.speck[2] - t.base[2]) * 0.4 : 0);
      return [r, g, b, 255];
    });
    writeFile(t.path, blp);
  }

  // Stylized 32x32 Spell & Weapon Icons
  for (const ic of SPELL_ICONS) {
    const blp = createBlp2(32, 32, (x, y, w, h) => {
      const u = (x - w / 2) / (w / 2);
      const v = (y - h / 2) / (h / 2);
      const d = Math.hypot(u, v);
      const border = x < 2 || x >= w - 2 || y < 2 || y >= h - 2;
      if (border) return [214, 184, 118, 255];
      const ang = Math.atan2(v, u);
      const rays = Math.sin(ang * ic.petals + d * 6.0) * 0.5 + 0.5;
      const core = Math.max(0, 1 - d * 1.15);
      const r = ic.bg[0] * (1 - core) + ic.fg[0] * core + rays * 28;
      const g = ic.bg[1] * (1 - core) + ic.fg[1] * core + rays * 28;
      const b = ic.bg[2] * (1 - core) + ic.fg[2] * core + rays * 28;
      return [r, g, b, 255];
    });
    writeFile(`Interface/Icons/${ic.name}.blp`, blp);
  }

  // Footprint & UI helper textures
  writeFile('Textures/ShaneCube.blp', whiteBlp);
  writeFile('Textures/MinimapMask.blp', whiteBlp);
}

// ============================================================================
// 2. Binary glTF 2.0 (`.glb`) Writer for Rigged + Animated & Static Models
// ============================================================================
function buildGlbFromRiggedData({ positions, normals, colors, indices, joints, weights, bones, animations }) {
  const binChunks = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;

  function pushBuffer(typedArray, target) {
    const buf = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    const viewIdx = bufferViews.length;
    const bv = { buffer: 0, byteOffset, byteLength: buf.length };
    if (target) bv.target = target;
    bufferViews.push(bv);
    binChunks.push(buf);
    if (pad > 0) binChunks.push(Buffer.alloc(pad, 0));
    byteOffset += buf.length + pad;
    return viewIdx;
  }

  const vcount = positions.length / 3;
  const minPos = [Infinity, Infinity, Infinity];
  const maxPos = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vcount; i++) {
    const x = positions[i * 3 + 0];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minPos[0]) minPos[0] = x;
    if (y < minPos[1]) minPos[1] = y;
    if (z < minPos[2]) minPos[2] = z;
    if (x > maxPos[0]) maxPos[0] = x;
    if (y > maxPos[1]) maxPos[1] = y;
    if (z > maxPos[2]) maxPos[2] = z;
  }

  const posBv = pushBuffer(positions, 34962);
  const posAcc = accessors.length;
  accessors.push({ bufferView: posBv, componentType: 5126, count: vcount, type: 'VEC3', min: minPos, max: maxPos });

  const normBv = pushBuffer(normals, 34962);
  const normAcc = accessors.length;
  accessors.push({ bufferView: normBv, componentType: 5126, count: vcount, type: 'VEC3' });

  const colBv = pushBuffer(colors, 34962);
  const colAcc = accessors.length;
  accessors.push({ bufferView: colBv, componentType: 5126, count: vcount, type: 'VEC4' });

  const idxBv = pushBuffer(indices, 34963);
  const idxAcc = accessors.length;
  accessors.push({ bufferView: idxBv, componentType: 5125, count: indices.length, type: 'SCALAR' });

  const attrs = { POSITION: posAcc, NORMAL: normAcc, COLOR_0: colAcc };

  let skins = undefined;
  const nodes = [];

  if (bones && bones.length > 0 && joints && weights) {
    const jBv = pushBuffer(joints, 34962);
    const jAcc = accessors.length;
    accessors.push({ bufferView: jBv, componentType: 5123, count: vcount, type: 'VEC4' });

    const wBv = pushBuffer(weights, 34962);
    const wAcc = accessors.length;
    accessors.push({ bufferView: wBv, componentType: 5126, count: vcount, type: 'VEC4' });

    attrs.JOINTS_0 = jAcc;
    attrs.WEIGHTS_0 = wAcc;

    // Create bone nodes 0..bones.length-1
    const childrenMap = new Map();
    for (let i = 0; i < bones.length; i++) {
      const p = bones[i].parent;
      if (p >= 0) {
        if (!childrenMap.has(p)) childrenMap.set(p, []);
        childrenMap.get(p).push(i);
      }
    }
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      const node = {
        name: b.name,
        translation: b.translation,
        rotation: b.rotation || [0, 0, 0, 1],
      };
      const ch = childrenMap.get(i);
      if (ch && ch.length > 0) node.children = ch;
      nodes.push(node);
    }

    // Mesh node at index `bones.length`
    nodes.push({ name: 'CharacterMesh', mesh: 0, skin: 0 });
    skins = [{ joints: bones.map((_, i) => i), skeleton: 0 }];
  } else {
    nodes.push({ name: 'StaticMesh', mesh: 0 });
  }

  const gltfAnims = [];
  if (animations && animations.length > 0) {
    for (const anim of animations) {
      const samplers = [];
      const channels = [];
      const timeBv = pushBuffer(anim.times);
      const timeAcc = accessors.length;
      accessors.push({
        bufferView: timeBv,
        componentType: 5126,
        count: anim.times.length,
        type: 'SCALAR',
        min: [anim.times[0]],
        max: [anim.times[anim.times.length - 1]],
      });

      for (const track of anim.tracks) {
        const outBv = pushBuffer(track.values);
        const outAcc = accessors.length;
        accessors.push({
          bufferView: outBv,
          componentType: 5126,
          count: anim.times.length,
          type: track.path === 'rotation' ? 'VEC4' : 'VEC3',
        });
        const samplerIdx = samplers.length;
        samplers.push({ input: timeAcc, output: outAcc, interpolation: 'LINEAR' });
        channels.push({ sampler: samplerIdx, target: { node: track.bone, path: track.path } });
      }
      if (channels.length > 0) {
        gltfAnims.push({ name: anim.name, samplers, channels });
      }
    }
  }

  const jsonObj = {
    asset: { version: '2.0', generator: 'Xirtoth-Celandia-Builder' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i).filter(i => i === 0 || i === nodes.length - 1) }],
    nodes,
    meshes: [
      {
        name: 'Mesh',
        primitives: [{ attributes: attrs, indices: idxAcc, material: 0, mode: 4 }],
      },
    ],
    materials: [
      {
        name: 'CelandiaToon',
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
      },
    ],
    buffers: [{ byteLength: byteOffset }],
    bufferViews,
    accessors,
  };
  if (skins) jsonObj.skins = skins;
  if (gltfAnims.length > 0) jsonObj.animations = gltfAnims;

  const jsonStr = JSON.stringify(jsonObj);
  const jsonPad = (4 - (Buffer.byteLength(jsonStr, 'utf8') % 4)) % 4;
  const jsonBuf = Buffer.from(jsonStr + ' '.repeat(jsonPad), 'utf8');
  const binBuf = Buffer.concat(binChunks);

  const totalLen = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const glb = Buffer.alloc(totalLen);
  glb.write('glTF', 0, 4, 'ascii');
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLen, 8);

  glb.writeUInt32LE(jsonBuf.length, 12);
  glb.write('JSON', 16, 4, 'ascii');
  jsonBuf.copy(glb, 20);

  const binHeaderOff = 20 + jsonBuf.length;
  glb.writeUInt32LE(binBuf.length, binHeaderOff);
  glb.write('BIN\0', binHeaderOff + 4, 4, 'ascii');
  binBuf.copy(glb, binHeaderOff + 8);

  return glb;
}

/**
 * Convert a Celandia `createCharacter` / `createVillager` member into a unified 21-bone
 * `.glb` with 10 baked procedural animations.
 */
function exportCelandiaCharacterGlb(member, charScale = 0.62) {
  const R = member.rig;
  const boneNames = [...rigMod.BONE_NAMES]; // 19 standard bones
  const boneIndexMap = new Map(boneNames.map((n, i) => [n, i]));

  // Reset rig to exact rest pose before capturing bind-pose geometry
  for (const b of boneNames) {
    R.bones[b].position.copy(R.rest[b]);
    R.bones[b].rotation.set(0, 0, 0);
    R.bones[b].scale.set(1, 1, 1);
  }
  for (const g of R.eyes) g.scale.set(1, 1, 1);
  for (const w of R.wings) w.g.rotation.copy(w.base);
  for (const s of R.sway) s.g.rotation[s.axis] = s.base;
  R.body.position.set(0, 0, 0);
  R.body.rotation.set(0, 0, 0);
  R.body.scale.set(1, 1, 1);
  R.body.updateMatrixWorld(true);

  const bodyInv = R.body.matrixWorld.clone().invert();

  // Build bone list (19 standard bones + optional wingL/wingR bones)
  const bones = boneNames.map((b, i) => {
    const parentName = b === 'pelvis' ? null : R.bones[b].parent?.isBone ? R.bones[b].parent.name.split(':')[1] : null;
    const parentIdx = parentName != null ? boneIndexMap.get(parentName) : -1;
    const restPos = R.rest[b];
    return {
      name: b,
      parent: parentIdx,
      translation: [restPos.x * charScale, restPos.y * charScale, restPos.z * charScale],
      rotation: [0, 0, 0, 1],
    };
  });

  // Add wing bones as children of chest if wings exist
  const wingBoneIndices = [];
  const chestIdx = boneIndexMap.get('chest') ?? 2;
  for (let wi = 0; wi < R.wings.length; wi++) {
    const w = R.wings[wi];
    const wWorld = new THREE.Vector3();
    w.g.getWorldPosition(wWorld);
    wWorld.applyMatrix4(bodyInv);
    const chestWorld = R.jointsW.chest;
    const bIdx = bones.length;
    const q = new THREE.Quaternion().setFromEuler(w.base);
    bones.push({
      name: wi === 0 ? 'wingL' : `wingR${wi}`,
      parent: chestIdx,
      translation: [
        (wWorld.x - chestWorld.x) * charScale,
        (wWorld.y - chestWorld.y) * charScale,
        (wWorld.z - chestWorld.z) * charScale,
      ],
      rotation: [q.x, q.y, q.z, q.w],
    });
    wingBoneIndices.push(bIdx);
  }

  // Helper to find which bone a rigid mesh rides on
  function findOwnerBoneIndex(obj) {
    for (let wi = 0; wi < R.wings.length; wi++) {
      let cur = obj;
      while (cur) {
        if (cur === R.wings[wi].g) return wingBoneIndices[wi];
        cur = cur.parent;
      }
    }
    let cur = obj;
    while (cur) {
      if (cur.isBone && cur.name) {
        const shortName = cur.name.includes(':') ? cur.name.split(':')[1] : cur.name;
        if (boneIndexMap.has(shortName)) return boneIndexMap.get(shortName);
      }
      cur = cur.parent;
    }
    return 0;
  }

  const allPos = [];
  const allNorm = [];
  const allCol = [];
  const allJoints = [];
  const allWeights = [];
  const allIndices = [];
  let vertOffset = 0;

  const tmpPos = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();
  const matRel = new THREE.Matrix4();
  const normMat = new THREE.Matrix3();

  R.body.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const kind = obj.userData?.kind;
    if (kind === 'ink' || kind === 'ink2') return; // Skip back-face outline shells

    const g = obj.geometry;
    const posAttr = g.attributes.position;
    if (!posAttr) return;
    const normAttr = g.attributes.normal;
    const colAttr = g.attributes.color;
    const siAttr = g.attributes.skinIndex;
    const swAttr = g.attributes.skinWeight;
    const isSkinned = obj.isSkinnedMesh && siAttr && swAttr;

    matRel.multiplyMatrices(bodyInv, obj.matrixWorld);
    normMat.getNormalMatrix(matRel);
    const rigidBone = isSkinned ? 0 : findOwnerBoneIndex(obj);

    const n = posAttr.count;
    for (let i = 0; i < n; i++) {
      tmpPos.fromBufferAttribute(posAttr, i);
      if (!isSkinned) tmpPos.applyMatrix4(matRel);
      allPos.push(tmpPos.x * charScale, tmpPos.y * charScale, tmpPos.z * charScale);

      if (normAttr) {
        tmpNorm.fromBufferAttribute(normAttr, i);
        if (!isSkinned) tmpNorm.applyMatrix3(normMat).normalize();
        allNorm.push(tmpNorm.x, tmpNorm.y, tmpNorm.z);
      } else {
        allNorm.push(0, 1, 0);
      }

      if (colAttr) {
        allCol.push(colAttr.getX(i), colAttr.getY(i), colAttr.getZ(i), 1.0);
      } else {
        allCol.push(0.95, 0.92, 0.9, 1.0);
      }

      if (isSkinned) {
        allJoints.push(siAttr.getX(i), siAttr.getY(i), siAttr.getZ(i), siAttr.getW(i));
        allWeights.push(swAttr.getX(i), swAttr.getY(i), swAttr.getZ(i), swAttr.getW(i));
      } else {
        allJoints.push(rigidBone, 0, 0, 0);
        allWeights.push(1, 0, 0, 0);
      }
    }

    if (g.index) {
      const idxArr = g.index.array;
      for (let i = 0; i < idxArr.length; i++) {
        allIndices.push(vertOffset + idxArr[i]);
      }
    } else {
      for (let i = 0; i < n; i++) {
        allIndices.push(vertOffset + i);
      }
    }
    vertOffset += n;
  });

  // Sample procedural animations from `R.step(elapsed, dt, false)`
  const clipsToBake = [
    { name: '0:Stand', state: 'idle', speed: 0, duration: 2.0, fps: 20 },
    { name: '4:Walk', state: 'walk', speed: 2.2, duration: 1.2, fps: 24 },
    { name: '5:Run', state: 'run', speed: 5.8, duration: 0.9, fps: 24 },
    { name: '16:AttackUnarmed', state: 'hook', speed: 0, duration: 0.75, fps: 24 },
    { name: '20:ParryUnarmed', state: 'parry', duration: 0.7, speed: 0, fps: 20 },
    { name: '38:Jump', state: 'jump', speed: 3.0, duration: 0.85, fps: 20 },
    { name: '42:Swim', state: 'swim', speed: 3.0, duration: 1.4, fps: 20 },
    { name: '51:SpellCastDirected', state: 'throw', speed: 0, duration: 0.8, fps: 24 },
    { name: '53:SpellCastOmni', state: 'plunge', speed: 0, duration: 0.9, fps: 24 },
    { name: '1:Death', state: 'death', speed: 0, duration: 1.0, fps: 20 },
  ];

  const animations = [];
  const qTmp = new THREE.Quaternion();

  for (const clip of clipsToBake) {
    const frames = Math.max(2, Math.round(clip.duration * clip.fps) + 1);
    const dt = clip.duration / (frames - 1);
    const times = new Float32Array(frames);
    const pelvisTrans = new Float32Array(frames * 3);
    const boneRots = bones.map(() => new Float32Array(frames * 4));

    R.anim.cur = null;
    R.anim.state = clip.state === 'death' ? 'idle' : clip.state;
    R.anim.speed = clip.speed;
    // Warm up blend state for cyclic animations
    if (clip.state !== 'death') {
      for (let w = 0; w < 15; w++) R.step(w * 0.03, 0.03, false);
    }

    for (let f = 0; f < frames; f++) {
      const t = f * dt;
      times[f] = t;

      if (clip.state === 'death') {
        const p = Math.min(1, t / (clip.duration * 0.82));
        const ease = p * p * (3 - 2 * p);
        pelvisTrans[f * 3 + 0] = R.rest.pelvis.x * charScale;
        pelvisTrans[f * 3 + 1] = (R.rest.pelvis.y * (1 - ease * 0.82)) * charScale;
        pelvisTrans[f * 3 + 2] = (R.rest.pelvis.z - ease * 0.95) * charScale;
        for (let bi = 0; bi < boneNames.length; bi++) {
          const bName = boneNames[bi];
          if (bName === 'pelvis') {
            qTmp.setFromEuler(new THREE.Euler(-ease * 1.48, 0, ease * 0.12, 'YXZ'));
          } else if (bName === 'head' || bName === 'neck') {
            qTmp.setFromEuler(new THREE.Euler(-ease * 0.35, ease * 0.25, 0, 'YXZ'));
          } else if (bName.startsWith('uarm')) {
            const s = bName.endsWith('L') ? 1 : -1;
            qTmp.setFromEuler(new THREE.Euler(-ease * 0.4, 0, s * ease * 0.65, 'YXZ'));
          } else {
            qTmp.set(0, 0, 0, 1);
          }
          boneRots[bi].set([qTmp.x, qTmp.y, qTmp.z, qTmp.w], f * 4);
        }
        for (let wi = 0; wi < wingBoneIndices.length; wi++) {
          const bi = wingBoneIndices[wi];
          boneRots[bi].set(bones[bi].rotation, f * 4);
        }
      } else {
        R.step(t, dt, false);
        pelvisTrans[f * 3 + 0] = R.bones.pelvis.position.x * charScale;
        pelvisTrans[f * 3 + 1] = R.bones.pelvis.position.y * charScale;
        pelvisTrans[f * 3 + 2] = R.bones.pelvis.position.z * charScale;
        for (let bi = 0; bi < boneNames.length; bi++) {
          const q = R.bones[boneNames[bi]].quaternion;
          boneRots[bi].set([q.x, q.y, q.z, q.w], f * 4);
        }
        for (let wi = 0; wi < wingBoneIndices.length; wi++) {
          const bi = wingBoneIndices[wi];
          const q = R.wings[wi].g.quaternion;
          boneRots[bi].set([q.x, q.y, q.z, q.w], f * 4);
        }
      }
    }

    const tracks = [{ bone: 0, path: 'translation', values: pelvisTrans }];
    for (let bi = 0; bi < bones.length; bi++) {
      tracks.push({ bone: bi, path: 'rotation', values: boneRots[bi] });
    }
    animations.push({ name: clip.name, times, tracks });
  }

  // Augment with Mixamo + reverse-engineered weapon, bow, lance, whirlwind, strafe & emote sequences
  const existingPrefixes = new Set(animations.map(a => a.name.split(':')[0]));
  const augmentedClips = buildHumanoidAnimations(bones, 'duelist');
  for (const extra of augmentedClips) {
    const prefix = extra.name.split(':')[0];
    if (!existingPrefixes.has(prefix)) {
      existingPrefixes.add(prefix);
      animations.push(extra);
    }
  }

  return buildGlbFromRiggedData({
    positions: new Float32Array(allPos),
    normals: new Float32Array(allNorm),
    colors: new Float32Array(allCol),
    indices: new Uint32Array(allIndices),
    joints: new Uint16Array(allJoints),
    weights: new Float32Array(allWeights),
    bones,
    animations,
  });
}

/**
 * Helper to build a procedural Three.js BufferGeometry/Group into a static or 1-bone animated `.glb`.
 */
function buildProceduralPartsGlb(parts, animStyle = 'idle', creatureType = 'PorcelainHopper') {
  const allPos = [];
  const allNorm = [];
  const allCol = [];
  const allJoints = [];
  const allWeights = [];
  const allIndices = [];
  let vertOffset = 0;

  const tmpPos = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();
  const color = new THREE.Color();
  const mat = new THREE.Matrix4();
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const scaleV = new THREE.Vector3();
  const posV = new THREE.Vector3();
  const normMat = new THREE.Matrix3();

  for (const part of parts) {
    const g = part.geo;
    posV.set(...(part.pos || [0, 0, 0]));
    euler.set(...(part.rot || [0, 0, 0]));
    quat.setFromEuler(euler);
    scaleV.set(...(part.scale || [1, 1, 1]));
    mat.compose(posV, quat, scaleV);
    normMat.getNormalMatrix(mat);
    color.set(part.color || '#ffffff');

    const posAttr = g.attributes.position;
    const normAttr = g.attributes.normal;
    const n = posAttr.count;
    for (let i = 0; i < n; i++) {
      tmpPos.fromBufferAttribute(posAttr, i).applyMatrix4(mat);
      allPos.push(tmpPos.x, tmpPos.y, tmpPos.z);
      if (normAttr) {
        tmpNorm.fromBufferAttribute(normAttr, i).applyMatrix3(normMat).normalize();
        allNorm.push(tmpNorm.x, tmpNorm.y, tmpNorm.z);
      } else {
        allNorm.push(0, 1, 0);
      }
      allCol.push(color.r, color.g, color.b, 1.0);
      allJoints.push(0, 0, 0, 0);
      allWeights.push(1, 0, 0, 0);
    }
    if (g.index) {
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i++) allIndices.push(vertOffset + idx[i]);
    } else {
      for (let i = 0; i < n; i++) allIndices.push(vertOffset + i);
    }
    vertOffset += n;
  }

  const bones = [{ name: 'root', parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1] }];
  const animations = animStyle === 'creature' ? buildCreatureAnimations(bones, creatureType) : [];

  return buildGlbFromRiggedData({
    positions: new Float32Array(allPos),
    normals: new Float32Array(allNorm),
    colors: new Float32Array(allCol),
    indices: new Uint32Array(allIndices),
    joints: new Uint16Array(allJoints),
    weights: new Float32Array(allWeights),
    bones,
    animations,
  });
}

function buildModels() {
  console.log('[2/5] Building Celandia 14 rigged characters, fauna, bosses, weapons, trees & sister-project GLBs...');

  const charScale = 0.62;
  const charGlbs = new Map();

  for (const name of cast.CHARACTERS) {
    const member = geoMod.withDetail(0.65, () => cast.createCharacter(name, { scale: 0.5 }));
    const glb = exportCelandiaCharacterGlb(member, charScale);
    charGlbs.set(name, glb);
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    writeFile(`Creature/Celandia/${cap}/${cap}.m2`, glb);
  }

  // Wren the Postwoman (Villager 0)
  const wrenMember = cast.createVillager(0, { scale: 0.5 });
  const wrenGlb = exportCelandiaCharacterGlb(wrenMember, charScale);
  charGlbs.set('wren', wrenGlb);
  writeFile('Creature/Celandia/Wren/Wren.m2', wrenGlb);

  // Also map the 14 Celandia cast characters onto the 8 playable race Male/Female character paths
  // so any standard Character\<Race>\<Sex>\<Race><Sex>.m2 lookup loads a Celandia hero model!
  const raceGenderMap = [
    ['Human', 'Male', 'rook'],
    ['Human', 'Female', 'serein'],
    ['Orc', 'Male', 'latch'],
    ['Orc', 'Female', 'mora'],
    ['Dwarf', 'Male', 'moss'],
    ['Dwarf', 'Female', 'fizz'],
    ['NightElf', 'Male', 'ilex'],
    ['NightElf', 'Female', 'elowen'],
    ['Scourge', 'Male', 'oriel'],
    ['Scourge', 'Female', 'avelune'],
    ['Tauren', 'Male', 'riff'],
    ['Tauren', 'Female', 'solenne'],
    ['Gnome', 'Male', 'daze'],
    ['Gnome', 'Female', 'wren'],
    ['Troll', 'Male', 'rook'],
    ['Troll', 'Female', 'serein'],
  ];
  for (const [race, gender, cname] of raceGenderMap) {
    writeFile(`Character/${race}/${gender}/${race}${gender}.m2`, charGlbs.get(cname));
  }

  // Procedural Celandia Fauna & Bosses (from fauna.js geometry recipes)
  const sphere = new THREE.SphereGeometry(1, 14, 10);
  const lowBall = new THREE.IcosahedronGeometry(1, 1);
  const cone = new THREE.ConeGeometry(1, 1, 8);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 8);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const octa = new THREE.OctahedronGeometry(1, 1);

  // 1. Porcelain Hopper
  const hopperGlb = buildProceduralPartsGlb([
    { geo: sphere, color: '#f59ab8', pos: [0, 0.5, 0], scale: [0.55, 0.5, 0.6] },
    { geo: sphere, color: '#fff4e0', pos: [0, 0.38, 0.22], scale: [0.42, 0.3, 0.42] },
    { geo: sphere, color: '#1a1020', pos: [-0.2, 0.74, 0.5], scale: [0.07, 0.09, 0.05] },
    { geo: sphere, color: '#1a1020', pos: [0.2, 0.74, 0.5], scale: [0.07, 0.09, 0.05] },
    { geo: cone, color: '#ffffff', pos: [-0.2, 1.05, -0.05], scale: [0.09, 0.35, 0.09], rot: [0, 0, -0.35] },
    { geo: cone, color: '#ffffff', pos: [0.2, 1.05, -0.05], scale: [0.09, 0.35, 0.09], rot: [0, 0, 0.35] },
  ], 'creature');
  writeFile('Creature/Celandia/PorcelainHopper/PorcelainHopper.m2', hopperGlb);

  // 2. Frostbell Woolly Drifter
  const drifterGlb = buildProceduralPartsGlb([
    { geo: lowBall, color: '#f4f0ff', pos: [0, 1.0, 0], scale: [1.0, 0.85, 1.25] },
    { geo: lowBall, color: '#e2dcf6', pos: [0.5, 1.25, 0.3], scale: [0.55, 0.5, 0.55] },
    { geo: lowBall, color: '#ffffff', pos: [-0.5, 1.25, -0.2], scale: [0.55, 0.5, 0.55] },
    { geo: sphere, color: '#5a4a6a', pos: [0, 1.05, 1.15], scale: [0.35, 0.3, 0.25] },
    { geo: cone, color: '#9fe8ff', pos: [-0.32, 1.55, 0.9], scale: [0.09, 0.45, 0.09], rot: [0.4, 0, -0.6] },
    { geo: cone, color: '#9fe8ff', pos: [0.32, 1.55, 0.9], scale: [0.09, 0.45, 0.09], rot: [0.4, 0, 0.6] },
    { geo: cyl, color: '#5a4a6a', pos: [-0.45, 0.3, -0.45], scale: [0.12, 0.6, 0.12] },
    { geo: cyl, color: '#5a4a6a', pos: [0.45, 0.3, -0.45], scale: [0.12, 0.6, 0.12] },
    { geo: cyl, color: '#5a4a6a', pos: [-0.45, 0.3, 0.45], scale: [0.12, 0.6, 0.12] },
    { geo: cyl, color: '#5a4a6a', pos: [0.45, 0.3, 0.45], scale: [0.12, 0.6, 0.12] },
  ], 'creature');
  writeFile('Creature/Celandia/WoollyDrifter/WoollyDrifter.m2', drifterGlb);

  // 3. Glasswake Skimmer
  const skimmerGlb = buildProceduralPartsGlb([
    { geo: sphere, color: '#e8865a', pos: [0, 0.45, 0], scale: [0.38, 0.25, 0.95] },
    { geo: sphere, color: '#f0b878', pos: [0, 0.52, 0.85], scale: [0.28, 0.22, 0.38] },
    { geo: cone, color: '#5ad8d0', pos: [0, 0.75, -0.1], scale: [0.14, 0.55, 0.45] },
    { geo: cone, color: '#e8865a', pos: [0, 0.42, -1.35], scale: [0.14, 1.1, 0.14], rot: [-Math.PI / 2, 0, 0] },
  ], 'creature');
  writeFile('Creature/Celandia/GlassSkimmer/GlassSkimmer.m2', skimmerGlb);

  // 4. Porcelain Sky Manta
  const mantaGlb = buildProceduralPartsGlb([
    { geo: sphere, color: '#8f7ad6', pos: [0, 1.4, 0], scale: [1.45, 0.18, 0.85] },
    { geo: sphere, color: '#ffdcea', pos: [0, 1.32, 0.1], scale: [0.95, 0.14, 0.65] },
    { geo: cone, color: '#8ff5e8', pos: [0, 1.4, -1.2], scale: [0.12, 1.2, 0.12], rot: [-Math.PI / 2, 0, 0] },
  ], 'creature');
  writeFile('Creature/Celandia/SkyManta/SkyManta.m2', mantaGlb);

  // 5. Nocturnum Obsidian Colossus (World Boss)
  const colossusGlb = buildProceduralPartsGlb([
    { geo: octa, color: '#2b1d3d', pos: [0, 2.2, 0], scale: [1.3, 1.6, 0.95] },
    { geo: octa, color: '#a84ef0', pos: [0, 2.35, 0.25], scale: [0.55, 0.65, 0.55] },
    { geo: octa, color: '#3d2858', pos: [-1.45, 2.7, 0], scale: [0.55, 0.85, 0.55], rot: [0, 0, 0.3] },
    { geo: octa, color: '#3d2858', pos: [1.45, 2.7, 0], scale: [0.55, 0.85, 0.55], rot: [0, 0, -0.3] },
    { geo: cone, color: '#ff5ad8', pos: [0, 3.85, 0], scale: [0.45, 0.95, 0.45] },
    { geo: cyl, color: '#241634', pos: [-0.55, 0.75, 0], scale: [0.35, 1.5, 0.35] },
    { geo: cyl, color: '#241634', pos: [0.55, 0.75, 0], scale: [0.35, 1.5, 0.35] },
  ], 'creature');
  writeFile('Creature/Celandia/ObsidianColossus/ObsidianColossus.m2', colossusGlb);

  // Copy curated sister-project .glb models into WoW/Data/Creature/Sister/
  const sisterModels = [
    { src: path.join(REINCARNATION_DIR, 'public/models/meshy-hollow.glb'), dst: 'Creature/Sister/Hollow/Hollow.m2' },
    { src: path.join(REINCARNATION_DIR, 'public/models/meshy-knight.glb'), dst: 'Creature/Sister/AshenKnight/AshenKnight.m2' },
    { src: path.join(REINCARNATION_DIR, 'public/models/meshy-iron-colossus.glb'), dst: 'Creature/Sister/IronColossus/IronColossus.m2' },
    { src: path.join(REINCARNATION_DIR, 'public/models/meshy-bone-lord.glb'), dst: 'Creature/Sister/BoneLord/BoneLord.m2' },
    { src: path.join(REINCARNATION_DIR, 'public/models/meshy-wraith.glb'), dst: 'Creature/Sister/Wraith/Wraith.m2' },
    { src: path.join(REINCARNATION_DIR, 'public/models/meshy-hound.glb'), dst: 'Creature/Sister/BlightHound/BlightHound.m2' },
    { src: path.join(TEKKAJEM_DIR, 'assets/models/characters/jem_glitter_hero.glb'), dst: 'Creature/Sister/Jem/Jem.m2' },
    { src: path.join(TEKKAJEM_DIR, 'assets/models/characters/tekkaman_armored.glb'), dst: 'Creature/Sister/Tekkaman/Tekkaman.m2' },
  ];
  for (const sm of sisterModels) {
    if (fs.existsSync(sm.src)) {
      writeFile(sm.dst, fs.readFileSync(sm.src));
    } else {
      writeFile(sm.dst, colossusGlb);
    }
  }

  // Weapons & Shields (`Item/ObjectComponents/Weapon/*.m2` & `Shield/*.m2`)
  const weapons = [
    {
      name: 'PorcelainRapier',
      parts: [
        { geo: cyl, color: '#6b442a', pos: [0, 0, -0.18], scale: [0.025, 0.28, 0.025], rot: [Math.PI / 2, 0, 0] },
        { geo: sphere, color: '#f2c864', pos: [0, 0, 0], scale: [0.09, 0.09, 0.04] },
        { geo: cone, color: '#f4f0ff', pos: [0, 0, 0.58], scale: [0.028, 1.15, 0.015], rot: [Math.PI / 2, 0, 0] },
      ],
    },
    {
      name: 'FrostbellChimeStaff',
      parts: [
        { geo: cyl, color: '#4a5d7a', pos: [0, 0, 0.15], scale: [0.028, 1.65, 0.028], rot: [Math.PI / 2, 0, 0] },
        { geo: octa, color: '#8fe8ff', pos: [0, 0, 1.05], scale: [0.16, 0.16, 0.24] },
      ],
    },
    {
      name: 'GlasswakePrismBow',
      parts: [
        { geo: cyl, color: '#5ad8d0', pos: [0, 0, 0.1], scale: [0.025, 1.15, 0.04], rot: [0, 0, 0] },
        { geo: octa, color: '#ff8ad8', pos: [0, 0.55, 0.05], scale: [0.06, 0.14, 0.06] },
        { geo: octa, color: '#ff8ad8', pos: [0, -0.55, 0.05], scale: [0.06, 0.14, 0.06] },
      ],
    },
    {
      name: 'AureateSunblade',
      parts: [
        { geo: cyl, color: '#5c381c', pos: [0, 0, -0.22], scale: [0.032, 0.34, 0.032], rot: [Math.PI / 2, 0, 0] },
        { geo: box, color: '#ffd45a', pos: [0, 0, 0], scale: [0.24, 0.05, 0.05] },
        { geo: cone, color: '#ffe89a', pos: [0, 0, 0.65], scale: [0.075, 1.28, 0.022], rot: [Math.PI / 2, 0, 0] },
      ],
    },
    {
      name: 'NocturnumLanternHook',
      parts: [
        { geo: cyl, color: '#2b1d3d', pos: [0, 0, 0.2], scale: [0.03, 1.35, 0.03], rot: [Math.PI / 2, 0, 0] },
        { geo: octa, color: '#c468ff', pos: [0, -0.14, 0.88], scale: [0.14, 0.18, 0.14] },
      ],
    },
    {
      name: 'TekkaCrystalLance',
      parts: [
        { geo: cyl, color: '#d8e4f0', pos: [0, 0, -0.2], scale: [0.035, 0.5, 0.035], rot: [Math.PI / 2, 0, 0] },
        { geo: cone, color: '#ff3a54', pos: [0, 0, 0.1], scale: [0.14, 0.22, 0.14], rot: [Math.PI / 2, 0, 0] },
        { geo: cone, color: '#eef6ff', pos: [0, 0, 0.78], scale: [0.08, 1.45, 0.08], rot: [Math.PI / 2, 0, 0] },
      ],
    },
  ];
  for (const w of weapons) {
    writeFile(`Item/ObjectComponents/Weapon/${w.name}.m2`, buildProceduralPartsGlb(w.parts, 'static'));
  }

  const shieldGlb = buildProceduralPartsGlb([
    { geo: cyl, color: '#f4e8f8', pos: [0, 0, 0], scale: [0.42, 0.05, 0.52], rot: [0, 0, Math.PI / 2] },
    { geo: octa, color: '#ffd45a', pos: [0.04, 0, 0], scale: [0.06, 0.16, 0.16] },
  ], 'static');
  writeFile('Item/ObjectComponents/Shield/PorcelainAegis.m2', shieldGlb);

  // Biome Trees & Spires (`World/Celandia/Doodads/*.m2`)
  const doodads = [
    {
      name: 'PorcelainGiantTree',
      parts: [
        { geo: cyl, color: '#6e5246', pos: [0, 4.5, 0], scale: [0.65, 9.0, 0.65] },
        { geo: lowBall, color: '#7fa858', pos: [0, 9.5, 0], scale: [4.2, 2.6, 4.2] },
        { geo: lowBall, color: '#98c26e', pos: [1.4, 10.6, 0.8], scale: [2.8, 2.0, 2.8] },
        { geo: octa, color: '#7ee8fa', pos: [0.6, 2.2, 0.5], scale: [0.35, 1.2, 0.35], rot: [0.2, 0, -0.3] },
      ],
    },
    {
      name: 'FrostbellSnowFir',
      parts: [
        { geo: cyl, color: '#483a38', pos: [0, 4.0, 0], scale: [0.4, 8.0, 0.4] },
        { geo: cone, color: '#2f5868', pos: [0, 3.8, 0], scale: [2.8, 3.6, 2.8] },
        { geo: cone, color: '#5888a0', pos: [0, 6.2, 0], scale: [2.1, 3.2, 2.1] },
        { geo: cone, color: '#e4f0ff', pos: [0, 8.4, 0], scale: [1.4, 2.6, 1.4] },
      ],
    },
    {
      name: 'GlasswakeCrystalTree',
      parts: [
        { geo: cone, color: '#5ab8c8', pos: [0, 3.2, 0], scale: [0.85, 6.4, 0.85] },
        { geo: cone, color: '#ffb0e0', pos: [0.9, 2.4, 0.4], scale: [0.55, 4.8, 0.55], rot: [0.15, 0, -0.35] },
        { geo: cone, color: '#c8fff4', pos: [-0.8, 2.1, -0.3], scale: [0.5, 4.2, 0.5], rot: [-0.15, 0, 0.35] },
      ],
    },
    {
      name: 'AureateCypress',
      parts: [
        { geo: cyl, color: '#6b4c35', pos: [0, 3.5, 0], scale: [0.38, 7.0, 0.38] },
        { geo: cone, color: '#d89b38', pos: [0, 6.0, 0], scale: [1.65, 7.5, 1.65] },
        { geo: cone, color: '#f2c45a', pos: [0, 8.5, 0], scale: [1.1, 4.5, 1.1] },
      ],
    },
    {
      name: 'NocturnumObsidianSpire',
      parts: [
        { geo: cone, color: '#2a1e3f', pos: [0, 4.5, 0], scale: [1.3, 9.0, 1.3] },
        { geo: octa, color: '#b45aff', pos: [0, 6.5, 0], scale: [0.65, 1.8, 0.65] },
      ],
    },
  ];
  for (const d of doodads) {
    writeFile(`World/Celandia/Doodads/${d.name}.m2`, buildProceduralPartsGlb(d.parts, 'static'));
  }

  // Spell Visual FX Models (`Spells/*.m2`)
  const fxSpecs = [
    ['Spells/PorcelainBurst.m2', '#f59ab8'],
    ['Spells/FrostbellNova.m2', '#7fd0ff'],
    ['Spells/GlasswakeBeam.m2', '#5ad8d0'],
    ['Spells/AureateSanctuary.m2', '#ffd45a'],
    ['Spells/NocturnumVortex.m2', '#b45aff'],
    ['Spells/ErrorCube.m2', '#ff5a8a'],
    ['Spells/LevelUp.m2', '#ffe884'],
    ['Spells/LootArt.m2', '#ffd86b'],
  ];
  for (const [fxPath, hex] of fxSpecs) {
    const fxGlb = buildProceduralPartsGlb([
      { geo: octa, color: hex, pos: [0, 0.6, 0], scale: [0.45, 0.65, 0.45] },
    ], 'static');
    writeFile(fxPath, fxGlb);
  }
}

// ============================================================================
// 3. WDT & ADT Terrain Builder from Celandia `atlas.js`
// ============================================================================
const TILE_SIZE = 533.3333333;
const CHUNK_SIZE = TILE_SIZE / 16.0;
const UNIT_SIZE = CHUNK_SIZE / 8.0;
const MAP_CENTER = 32.0 * TILE_SIZE;

// Map WoW world (wx, wy) -> Celandia atlas (cx = -wy, cz = -wx)
function sampleCelandiaHeight(wx, wy) {
  const cx = -wy;
  const cz = -wx;
  return atlas.height(cx, cz);
}

function sampleCelandiaAreaAndTex(wx, wy) {
  const cx = -wy;
  const cz = -wx;
  // Check Nocturnum Isle first
  const dNoc = Math.hypot(cx - atlas.NOCTURNUM_ISLE.x, cz - atlas.NOCTURNUM_ISLE.z);
  if (dNoc < atlas.NOCTURNUM_ISLE.rx * 1.25) {
    return { areaId: 5, texId: 4 }; // Nocturnum Basalt
  }
  const bw = atlas.biomeWeights(cx, cz);
  if (bw.frost >= bw.wake && bw.frost >= bw.glass && bw.frost >= bw.aureate && bw.frost > 0.25) {
    return { areaId: 2, texId: 1 }; // Frostbell Lagoon
  }
  if (bw.glass >= bw.wake && bw.glass >= bw.aureate && bw.glass > 0.25) {
    return { areaId: 3, texId: 2 }; // Glasswake Mesas
  }
  if (bw.aureate >= bw.wake && bw.aureate > 0.25) {
    return { areaId: 4, texId: 3 }; // The Aureate Reach
  }
  return { areaId: 1, texId: 0 }; // The Porcelain Wake
}

function makeIffChunk(magic4, payloadBuf) {
  const hdr = Buffer.alloc(8);
  hdr.write(magic4, 0, 4, 'ascii');
  hdr.writeUInt32LE(payloadBuf.length, 4);
  return Buffer.concat([hdr, payloadBuf]);
}

function buildWdtFile(activeTiles) {
  const mver = Buffer.alloc(4);
  mver.writeUInt32LE(18, 0);

  const mphd = Buffer.alloc(32, 0); // flags = 0 (terrain map)
  const main = Buffer.alloc(64 * 64 * 8, 0);

  for (const [tx, ty] of activeTiles) {
    const idx = (ty * 64 + tx) * 8;
    main.writeUInt32LE(1, idx); // flags bit 0 = has_adt
  }

  return Buffer.concat([
    makeIffChunk('REVM', mver),
    makeIffChunk('DHPM', mphd),
    makeIffChunk('NIAM', main),
  ]);
}

function buildAdtTile(tx, ty, wmoInfo = null) {
  const tileNwX = (32 - ty) * TILE_SIZE;
  const tileNwY = (32 - tx) * TILE_SIZE;

  const texPaths = [
    'Tileset\\Celandia\\PorcelainGrass.blp',
    'Tileset\\Celandia\\FrostbellSnow.blp',
    'Tileset\\Celandia\\GlasswakeSand.blp',
    'Tileset\\Celandia\\AureateTerrace.blp',
    'Tileset\\Celandia\\NocturnumBasalt.blp',
  ];
  const mtexBuf = Buffer.from(texPaths.join('\0') + '\0', 'utf8');

  const doodadPaths = [
    'World\\Celandia\\Doodads\\PorcelainGiantTree.mdx',
    'World\\Celandia\\Doodads\\FrostbellSnowFir.mdx',
    'World\\Celandia\\Doodads\\GlasswakeCrystalTree.mdx',
    'World\\Celandia\\Doodads\\AureateCypress.mdx',
    'World\\Celandia\\Doodads\\NocturnumObsidianSpire.mdx',
  ];
  const mmidOffsets = [];
  let mmdxStr = '';
  for (const dp of doodadPaths) {
    mmidOffsets.push(Buffer.byteLength(mmdxStr, 'utf8'));
    mmdxStr += dp + '\0';
  }
  const mmdxBuf = Buffer.from(mmdxStr, 'utf8');
  const mmidBuf = Buffer.alloc(mmidOffsets.length * 4);
  mmidOffsets.forEach((off, i) => mmidBuf.writeUInt32LE(off, i * 4));

  // Scatter biome trees/spires across dry land (leaving a clear 38-yard arena heart at each island center)
  const mddfEntries = [];
  let uniqueIdBase = (ty * 64 + tx) * 1000 + 1;
  for (let r = 1; r < 15; r += 2) {
    for (let c = 1; c < 15; c += 2) {
      const wx = tileNwX - (r + 0.5) * CHUNK_SIZE;
      const wy = tileNwY - (c + 0.5) * CHUNK_SIZE;
      const wz = sampleCelandiaHeight(wx, wy);
      if (wz < atlas.SEA + 1.8) continue; // Skip underwater/shoreline

      // Keep island arena hearts open for combat
      const cx = -wy;
      const cz = -wx;
      let nearHeart = Math.hypot(cx, cz) < 42;
      for (const isl of [...atlas.ISLANDS, atlas.NOCTURNUM_ISLE]) {
        if (Math.hypot(cx - isl.x, cz - isl.z) < 42) nearHeart = true;
      }
      if (nearHeart) continue;

      const { texId } = sampleCelandiaAreaAndTex(wx, wy);
      const h = hash2(wx * 0.13, wy * 0.17);
      if (h < 0.42) continue;

      const mddf = Buffer.alloc(36);
      mddf.writeUInt32LE(texId, 0);               // name_id matches biome tree
      mddf.writeUInt32LE(uniqueIdBase++, 4);      // unique_id
      mddf.writeFloatLE(MAP_CENTER - wy, 8);      // pos[0] = MAP_CENTER - wow_y
      mddf.writeFloatLE(wz, 12);                  // pos[1] = wow_z
      mddf.writeFloatLE(MAP_CENTER - wx, 16);     // pos[2] = MAP_CENTER - wow_x
      mddf.writeFloatLE(0, 20);
      mddf.writeFloatLE(h * 360.0, 24);
      mddf.writeFloatLE(0, 28);
      mddf.writeUInt16LE(Math.round((0.85 + (h - 0.42) * 0.9) * 1024), 32); // scale
      mddf.writeUInt16LE(0, 34);
      mddfEntries.push(mddf);
    }
  }
  const mddfBuf = mddfEntries.length > 0 ? Buffer.concat(mddfEntries) : Buffer.alloc(0);

  const mcnkChunks = [];
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 16; col++) {
      const chunkNwX = tileNwX - row * CHUNK_SIZE;
      const chunkNwY = tileNwY - col * CHUNK_SIZE;
      const centerWx = chunkNwX - 0.5 * CHUNK_SIZE;
      const centerWy = chunkNwY - 0.5 * CHUNK_SIZE;
      const { areaId, texId } = sampleCelandiaAreaAndTex(centerWx, centerWy);

      const mcvtPayload = Buffer.alloc(145 * 4);
      const mcnrPayload = Buffer.alloc(145 * 3 + 13, 0); // 435 + 13 pad = 448 bytes

      let minGroundZ = Infinity;
      let vi = 0;
      const eps = 1.5;

      const writeVert = (vx, vy) => {
        const vz = sampleCelandiaHeight(vx, vy);
        if (vz < minGroundZ) minGroundZ = vz;
        mcvtPayload.writeFloatLE(vz, vi * 4);

        const dzdx = (sampleCelandiaHeight(vx + eps, vy) - sampleCelandiaHeight(vx - eps, vy)) / (2 * eps);
        const dzdy = (sampleCelandiaHeight(vx, vy + eps) - sampleCelandiaHeight(vx, vy - eps)) / (2 * eps);
        let nx = -dzdx;
        let ny = -dzdy;
        let nz = 1.0;
        const len = Math.hypot(nx, ny, nz) || 1.0;
        nx /= len;
        ny /= len;
        nz /= len;
        // Disk MCNR order is [x, z, y] where to_normalized() returns [x, y, z] and terrain.rs swaps back
        mcnrPayload.writeInt8(Math.max(-127, Math.min(127, Math.round(nx * 127))), vi * 3 + 0);
        mcnrPayload.writeInt8(Math.max(-127, Math.min(127, Math.round(ny * 127))), vi * 3 + 1);
        mcnrPayload.writeInt8(Math.max(-127, Math.min(127, Math.round(nz * 127))), vi * 3 + 2);
        vi++;
      };

      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          writeVert(chunkNwX - r * UNIT_SIZE, chunkNwY - c * UNIT_SIZE);
        }
        if (r < 8) {
          for (let c = 0; c < 8; c++) {
            writeVert(chunkNwX - (r + 0.5) * UNIT_SIZE, chunkNwY - (c + 0.5) * UNIT_SIZE);
          }
        }
      }

      const mclyPayload = Buffer.alloc(16);
      mclyPayload.writeUInt32LE(texId, 0);        // texture_id
      mclyPayload.writeUInt32LE(0, 4);            // flags
      mclyPayload.writeUInt32LE(0, 8);            // offset_in_mcal
      mclyPayload.writeUInt32LE(0xFFFFFFFF, 12);  // effect_id (none)

      const mcvtChunk = makeIffChunk('TVCM', mcvtPayload); // 588 bytes
      const mcnrChunk = makeIffChunk('RNCM', mcnrPayload); // 456 bytes
      const mclyChunk = makeIffChunk('YLCM', mclyPayload); // 24 bytes

      const hasOcean = minGroundZ < atlas.SEA + 0.25;
      let mclqChunk = Buffer.alloc(0);
      let ofsMclq = 0;
      let sizeLiquid = 0;
      let flags = 0;

      if (hasOcean) {
        flags = 0x08; // MCNK_LIQUID_OCEAN bit
        ofsMclq = 128 + mcvtChunk.length + mcnrChunk.length + mclyChunk.length;
        sizeLiquid = 0x324; // 804 bytes
        const mclqPayload = Buffer.alloc(0x324, 0);
        mclqPayload.writeFloatLE(atlas.SEA, 0); // min_height
        mclqPayload.writeFloatLE(atlas.SEA, 4); // max_height
        for (let i = 0; i < 81; i++) {
          const o = 8 + i * 8;
          mclqPayload[o] = 128; // depth byte
          mclqPayload.writeFloatLE(atlas.SEA, o + 4);
        }
        // 8x8 tile_flags at offset 8 + 648 = 656: 0x01 = ocean
        for (let i = 0; i < 64; i++) {
          mclqPayload[656 + i] = 0x01;
        }
        const mclqHdr = Buffer.alloc(8, 0);
        mclqHdr.write('QLCM', 0, 4, 'ascii');
        mclqChunk = Buffer.concat([mclqHdr, mclqPayload]);
      }

      const hdr = Buffer.alloc(128, 0);
      hdr.writeUInt32LE(flags, 0x00);
      hdr.writeUInt32LE(col, 0x04); // index_x
      hdr.writeUInt32LE(row, 0x08); // index_y
      hdr.writeUInt32LE(1, 0x0C);   // n_layers = 1
      hdr.writeUInt32LE(128, 0x14); // ofs_mcvt
      hdr.writeUInt32LE(128 + mcvtChunk.length, 0x18); // ofs_mcnr
      hdr.writeUInt32LE(128 + mcvtChunk.length + mcnrChunk.length, 0x1C); // ofs_mcly
      hdr.writeUInt32LE(areaId, 0x34); // area_id
      hdr.writeUInt16LE(0, 0x3C);      // holes_low_res
      hdr.writeUInt32LE(ofsMclq, 0x60);
      hdr.writeUInt32LE(sizeLiquid, 0x64);
      hdr.writeFloatLE(chunkNwX, 0x68);
      hdr.writeFloatLE(chunkNwY, 0x6C);
      hdr.writeFloatLE(0.0, 0x70);

      const mcnkPayload = Buffer.concat([hdr, mcvtChunk, mcnrChunk, mclyChunk, mclqChunk]);
      mcnkChunks.push(makeIffChunk('KNCM', mcnkPayload));
    }
  }

  return Buffer.concat([
    makeIffChunk('XETM', mtexBuf),
    makeIffChunk('XDMM', mmdxBuf),
    makeIffChunk('DIMM', mmidBuf),
    makeIffChunk('OMWM', wmoInfo?.mwmoBuf ?? Buffer.alloc(0)),
    makeIffChunk('DIWM', wmoInfo?.mwidBuf ?? Buffer.alloc(0)),
    makeIffChunk('FDDM', mddfBuf),
    makeIffChunk('FDOM', wmoInfo?.modfBuf ?? Buffer.alloc(0)),
    ...mcnkChunks,
  ]);
}

async function buildTerrain() {
  console.log('[3/5] Building 5 Enterable Celandia WMO Interiors, Map 1 (Elsewhere), & 4x4 WDT/ADT tiles...');
  const wmoInfo = await buildCelandiaWmosAndElsewhere({
    writeFile,
    WdbcBuilder,
    f32,
    createBlp2,
    buildProceduralPartsGlb,
    THREE,
  });

  const activeTiles = [];
  for (let ty = 30; ty <= 33; ty++) {
    for (let tx = 30; tx <= 33; tx++) {
      activeTiles.push([tx, ty]);
    }
  }
  const wdtBuf = buildWdtFile(activeTiles);
  // Write under Celandia, Azeroth (map 0), and Kalimdor (map 1) so all map IDs resolve cleanly
  for (const mapDir of ['Celandia', 'Azeroth', 'Kalimdor']) {
    writeFile(`World/Maps/${mapDir}/${mapDir}.wdt`, wdtBuf);
  }

  let trsLines = ['dir: Celandia', 'dir: Azeroth', 'dir: Kalimdor', 'dir: Elsewhere'];
  const biomeMinimapRgb = [
    [138, 178, 102], // 0: Porcelain Grass
    [224, 238, 252], // 1: Frostbell Snow
    [94, 210, 204],  // 2: Glasswake Sand
    [232, 184, 88],  // 3: Aureate Terrace
    [76, 52, 108],   // 4: Nocturnum Basalt
  ];

  for (const [tx, ty] of activeTiles) {
    const adtBuf = buildAdtTile(tx, ty, wmoInfo);
    for (const mapDir of ['Celandia', 'Azeroth', 'Kalimdor']) {
      writeFile(`World/Maps/${mapDir}/${mapDir}_${tx}_${ty}.adt`, adtBuf);
    }

    // Build 256x256 top-down minimap tile BLP for (tx, ty)
    const tileNwX = (32 - ty) * TILE_SIZE;
    const tileNwY = (32 - tx) * TILE_SIZE;
    const hashName = `celandia_${tx}_${ty}.blp`;
    const mmBlp = createBlp2(256, 256, (px, py) => {
      // x grows east (-wy), y grows south (-wx)
      const wx = tileNwX - ((py + 0.5) / 256.0) * TILE_SIZE;
      const wy = tileNwY - ((px + 0.5) / 256.0) * TILE_SIZE;
      const wz = sampleCelandiaHeight(wx, wy);
      if (wz < atlas.SEA) {
        const depth = Math.min(1.0, (atlas.SEA - wz) / 6.0);
        return [
          Math.round(90 * (1 - depth) + 32 * depth),
          Math.round(205 * (1 - depth) + 92 * depth),
          Math.round(220 * (1 - depth) + 138 * depth),
          255,
        ];
      }
      const { texId } = sampleCelandiaAreaAndTex(wx, wy);
      const base = biomeMinimapRgb[texId] || biomeMinimapRgb[0];
      const shade = Math.max(0.75, Math.min(1.25, 0.88 + wz * 0.015));
      return [
        Math.min(255, Math.round(base[0] * shade)),
        Math.min(255, Math.round(base[1] * shade)),
        Math.min(255, Math.round(base[2] * shade)),
        255,
      ];
    });
    writeFile(`textures/Minimap/${hashName}`, mmBlp);
    for (const mapDir of ['Celandia', 'Azeroth', 'Kalimdor']) {
      trsLines.push(`${mapDir}\\map${tx}_${ty}.blp\t${hashName}`);
    }
    trsLines.push(`Elsewhere\\map${tx}_${ty}.blp\telsewhere_${tx}_${ty}.blp`);
  }
  writeFile('textures/Minimap/md5translate.trs', Buffer.from(trsLines.join('\r\n') + '\r\n', 'utf8'));

  // Player arrow & object radar icons for minimap
  writeFile('Interface/Minimap/MinimapArrow.blp', createBlp2(32, 32, (x, y) => {
    const nx = (x - 15.5) / 15.5;
    const ny = (y - 15.5) / 15.5;
    // Upward-pointing golden-white arrow
    if (ny > -0.75 && ny < 0.65 && Math.abs(nx) < (ny + 0.8) * 0.45) {
      return [255, 232, 128, 255];
    }
    return [0, 0, 0, 0];
  }));
  writeFile('Interface/Minimap/ObjectIcons.blp', createBlp2(64, 64, (x, y) => {
    const cx = (x % 16) - 7.5;
    const cy = (y % 16) - 7.5;
    const r = Math.hypot(cx, cy);
    if (r <= 5.5) {
      return r <= 4.0 ? [255, 72, 72, 255] : [40, 10, 10, 255];
    }
    return [0, 0, 0, 0];
  }));

  return wmoInfo;
}

// ============================================================================
// 4. WDBC Builder for `WoW/Data/DBFilesClient/*.dbc`
// ============================================================================
class WdbcBuilder {
  constructor(fieldCount, stringCols = []) {
    this.fieldCount = fieldCount;
    this.stringCols = new Set(stringCols);
    this.rows = [];
    this.strings = [Buffer.from([0])]; // offset 0 is empty string ""
    this.stringLen = 1;
    this.strCache = new Map([['', 0]]);
  }

  addString(s) {
    const str = String(s ?? '');
    if (this.strCache.has(str)) return this.strCache.get(str);
    const off = this.stringLen;
    const b = Buffer.from(str + '\0', 'utf8');
    this.strings.push(b);
    this.stringLen += b.length;
    this.strCache.set(str, off);
    return off;
  }

  addRow(valuesObjOrArr) {
    const rec = Buffer.alloc(this.fieldCount * 4, 0);
    for (let c = 0; c < this.fieldCount; c++) {
      const val = Array.isArray(valuesObjOrArr) ? valuesObjOrArr[c] : valuesObjOrArr[c];
      if (this.stringCols.has(c)) {
        const strOff = this.addString(val ?? '');
        rec.writeUInt32LE(strOff, c * 4);
      } else if (val !== undefined && val !== null) {
        if (typeof val === 'object' && val.f32 !== undefined) {
          rec.writeFloatLE(val.f32, c * 4);
        } else if (typeof val === 'number' && !Number.isInteger(val)) {
          rec.writeFloatLE(val, c * 4);
        } else if (typeof val === 'number' && val < 0) {
          rec.writeInt32LE(val, c * 4);
        } else {
          rec.writeUInt32LE(val >>> 0, c * 4);
        }
      }
    }
    this.rows.push(rec);
  }

  toBuffer() {
    const hdr = Buffer.alloc(20);
    hdr.write('WDBC', 0, 4, 'ascii');
    hdr.writeUInt32LE(this.rows.length, 4);
    hdr.writeUInt32LE(this.fieldCount, 8);
    hdr.writeUInt32LE(this.fieldCount * 4, 12);
    hdr.writeUInt32LE(this.stringLen, 16);
    return Buffer.concat([hdr, ...this.rows, ...this.strings]);
  }

  build() {
    return this.toBuffer();
  }
}

const f32 = v => ({ f32: v });

const SPELL_ICONS = [
  { id: 1, name: 'Ability_Porcelain_Slash', bg: [54, 34, 68], fg: [245, 154, 184], petals: 4 },
  { id: 2, name: 'Ability_Porcelain_Whirl', bg: [48, 62, 88], fg: [143, 214, 240], petals: 6 },
  { id: 3, name: 'Ability_Porcelain_RoguishHook', bg: [68, 42, 34], fg: [246, 163, 94], petals: 3 },
  { id: 4, name: 'Spell_Frostbell_Chime', bg: [28, 54, 82], fg: [159, 232, 255], petals: 8 },
  { id: 5, name: 'Spell_Frostbell_Nova', bg: [24, 44, 76], fg: [220, 244, 255], petals: 6 },
  { id: 6, name: 'Spell_Frostbell_Squall', bg: [32, 48, 92], fg: [120, 210, 255], petals: 5 },
  { id: 7, name: 'Spell_Glasswake_Prism', bg: [28, 72, 74], fg: [90, 216, 208], petals: 7 },
  { id: 8, name: 'Spell_Glasswake_Refract', bg: [74, 36, 68], fg: [255, 140, 216], petals: 5 },
  { id: 9, name: 'Spell_Aureate_Sunburst', bg: [82, 54, 22], fg: [255, 218, 96], petals: 8 },
  { id: 10, name: 'Spell_Aureate_Sanctuary', bg: [72, 62, 28], fg: [255, 238, 154], petals: 4 },
  { id: 11, name: 'Spell_Nocturnum_Lantern', bg: [42, 24, 64], fg: [184, 108, 255], petals: 6 },
  { id: 12, name: 'Spell_Nocturnum_Eclipse', bg: [28, 18, 48], fg: [232, 92, 212], petals: 9 },
  { id: 13, name: 'Spell_Tekka_Voltekka', bg: [78, 18, 28], fg: [140, 255, 220], petals: 10 },
  { id: 14, name: 'Spell_Jem_Starlight', bg: [84, 28, 72], fg: [255, 168, 236], petals: 5 },
  { id: 15, name: 'Ability_Sister_SoulRend', bg: [52, 24, 24], fg: [238, 88, 68], petals: 4 },
];

function buildDbcs(wmoInfo) {
  console.log('[4/5] Building WDBC tables in WoW/Data/DBFilesClient/*.dbc...');

  // 1. Map.dbc (42 cols)
  const mapDbc = new WdbcBuilder(42, [1, 4, 20, 29]);
  for (const [id, dir, instType, name, desc] of [
    [0, 'Celandia', 0, 'Celandia: The Elsewhere Tide', 'Five fairy-punk island kingdoms joined across the Elsewhere Tide.'],
    [1, 'Elsewhere', 1, 'The Elsewhere & Reincarnation Sanctum', 'Instanced obsidian soulslike sanctum beneath Nocturnum Isle.'],
    [30, 'Celandia', 0, 'The Porcelain Wake', 'Heart of the Porcelain Court and Celandia Archipelago.'],
  ]) {
    mapDbc.addRow({
      0: id,
      1: dir,
      2: instType,
      4: name,
      13: 1,
      14: 60,
      15: 40,
      16: 0,
      17: f32(0.0),
      18: f32(0.0),
      20: desc,
      29: 'Defend the Porcelain Court and conquer the outer archipelagos.',
      38: 1, // LoadingScreenID -> LoadingScreens.dbc row 1
      41: f32(1.0),
    });
  }
  writeFile('DBFilesClient/Map.dbc', mapDbc.toBuffer());

  // 2. AreaTable.dbc (25 cols, col 11 is AreaName)
  const areaDbc = new WdbcBuilder(25, [11]);
  const areas = [
    [1, 0, 0, 1, 0x00, 'The Porcelain Wake', 101, 101, 1],
    [2, 0, 0, 2, 0x01, 'Frostbell Lagoon', 102, 102, 2],
    [3, 0, 0, 3, 0x00, 'Glasswake Mesas', 103, 103, 3],
    [4, 0, 0, 4, 0x00, 'The Aureate Reach', 104, 104, 4],
    [5, 0, 0, 5, 0x00, 'Nocturnum Obsidian Isle', 105, 105, 5],
    [6, 1, 0, 6, 0x00, 'The Elsewhere Sanctum', 105, 105, 5],
  ];
  for (const [id, mapId, zoneId, exploreFlag, flags, name, ambId, musicId, introId] of areas) {
    areaDbc.addRow({
      0: id,
      1: mapId,
      2: zoneId,
      3: exploreFlag,
      4: flags,
      8: 1,  // SoundProviderPref
      9: 11, // SoundProviderPrefUnderwater
      10: -1,
      11: name,
      19: ambId,   // AmbienceID
      20: musicId, // ZoneMusic
      21: introId, // IntroSound
    });
  }
  writeFile('DBFilesClient/AreaTable.dbc', areaDbc.toBuffer());

  // 3. CreatureModelData.dbc (16 cols) & CreatureDisplayInfo.dbc (12 cols) & CreatureDisplayInfoExtra.dbc (19 cols)
  const cmdDbc = new WdbcBuilder(16, [2]);
  const cdiDbc = new WdbcBuilder(12, [6, 7, 8]);
  const cdieDbc = new WdbcBuilder(19, [18]);

  const modelDefs = [
    // 1..14: Celandia Cast Heroes
    [1, 'Creature\\Celandia\\Rook\\Rook.mdx', 1.0, 2.0],
    [2, 'Creature\\Celandia\\Serein\\Serein.mdx', 1.0, 2.0],
    [3, 'Creature\\Celandia\\Ilex\\Ilex.mdx', 1.0, 2.0],
    [4, 'Creature\\Celandia\\Mora\\Mora.mdx', 1.0, 2.0],
    [5, 'Creature\\Celandia\\Fizz\\Fizz.mdx', 1.0, 1.8],
    [6, 'Creature\\Celandia\\Latch\\Latch.mdx', 1.0, 2.1],
    [7, 'Creature\\Celandia\\Moss\\Moss.mdx', 1.0, 2.1],
    [8, 'Creature\\Celandia\\Riff\\Riff.mdx', 1.0, 2.0],
    [9, 'Creature\\Celandia\\Daze\\Daze.mdx', 1.0, 1.9],
    [10, 'Creature\\Celandia\\Elowen\\Elowen.mdx', 1.0, 2.0],
    [11, 'Creature\\Celandia\\Solenne\\Solenne.mdx', 1.0, 2.0],
    [12, 'Creature\\Celandia\\Avelune\\Avelune.mdx', 1.0, 2.0],
    [13, 'Creature\\Celandia\\Oriel\\Oriel.mdx', 1.0, 2.0],
    [14, 'Creature\\Celandia\\Wren\\Wren.mdx', 1.0, 1.9],
    // 15..20: Sister Heroes & Celandia Fauna/Bosses
    [15, 'Creature\\Sister\\Tekkaman\\Tekkaman.mdx', 1.0, 2.2],
    [16, 'Creature\\Sister\\Jem\\Jem.mdx', 1.0, 2.0],
    [20, 'Creature\\Celandia\\PorcelainHopper\\PorcelainHopper.mdx', 1.0, 1.2],
    [21, 'Creature\\Celandia\\WoollyDrifter\\WoollyDrifter.mdx', 1.0, 1.6],
    [22, 'Creature\\Celandia\\GlassSkimmer\\GlassSkimmer.mdx', 1.0, 1.1],
    [23, 'Creature\\Celandia\\SkyManta\\SkyManta.mdx', 1.0, 1.8],
    [24, 'Creature\\Celandia\\ObsidianColossus\\ObsidianColossus.mdx', 1.15, 3.8],
    // 25..30: Reincarnation Enemies & Bosses
    [25, 'Creature\\Sister\\Hollow\\Hollow.mdx', 1.0, 2.0],
    [26, 'Creature\\Sister\\AshenKnight\\AshenKnight.mdx', 1.1, 2.4],
    [27, 'Creature\\Sister\\IronColossus\\IronColossus.mdx', 1.25, 3.6],
    [28, 'Creature\\Sister\\BoneLord\\BoneLord.mdx', 1.2, 3.2],
    [29, 'Creature\\Sister\\Wraith\\Wraith.mdx', 1.05, 2.2],
    [30, 'Creature\\Sister\\BlightHound\\BlightHound.mdx', 1.0, 1.4],
  ];

  for (const [id, modelPath, scale, colH] of modelDefs) {
    cmdDbc.addRow({
      0: id,
      1: 0,
      2: modelPath,
      3: 1,
      4: f32(scale),
      5: 1,
      6: 7, // FootstepShakeSize / FootstepId
      7: f32(18.0),
      8: f32(12.0),
      9: f32(1.0),
      13: id, // SoundID -> CreatureSoundData.dbc
      14: f32(0.8),
      15: f32(colH),
    });
  }

  // Direct creature displays (displayId 1..30 -> modelId 1..30)
  for (const [id, , scale] of modelDefs) {
    cdiDbc.addRow({
      0: id,
      1: id,
      2: id, // SoundID
      3: 0, // ExtendedDisplayInfoID = 0 (direct creature display)
      4: f32(scale),
      5: 255,
      6: '',
      7: '',
      8: '',
      9: 1,
      10: 1,
      11: 0,
    });
  }

  // Also register race body displays (50..65) for ChrRaces.dbc
  for (let race = 1; race <= 8; race++) {
    for (let sex = 0; sex <= 1; sex++) {
      const dispId = 48 + race * 2 + sex;
      const modelId = ((race - 1) * 2 + sex) % 14 + 1;
      cdiDbc.addRow({ 0: dispId, 1: modelId, 2: modelId, 3: 0, 4: f32(1.0), 5: 255, 9: 1 });
    }
  }

  const classHeroModels = [
    [1, 2, 6, 4, 7, 5, 15, 14],   // Class group A (Male/Female pairs across races)
    [2, 10, 11, 12, 16, 2, 10, 11], // Class group B
    [3, 4, 5, 14, 8, 9, 3, 4],     // Class group C
    [13, 12, 8, 9, 1, 2, 13, 12],  // Class group D
  ];

  for (let cg = 0; cg < 4; cg++) {
    const baseId = (cg + 1) * 100; // 100..115, 200..215, 300..315, 400..415
    for (let race = 1; race <= 8; race++) {
      for (let sex = 0; sex <= 1; sex++) {
        const slot = (race - 1) * 2 + sex; // 0..15
        const dispId = baseId + slot;
        const modelId = classHeroModels[cg][slot % classHeroModels[cg].length];
        cdieDbc.addRow({
          0: dispId,
          1: race,
          2: sex,
          3: 0,
          4: 0,
          5: 0,
          6: 0,
          7: 0,
          18: 'CelandiaHero.blp',
        });
        cdiDbc.addRow({
          0: dispId,
          1: modelId,
          2: modelId,
          3: dispId, // ExtendedDisplayInfoID -> matches cdieDbc row
          4: f32(1.0),
          5: 255,
          6: '',
          7: '',
          8: '',
          9: 1,
          10: 1,
          11: 0,
        });
      }
    }
  }

  writeFile('DBFilesClient/CreatureModelData.dbc', cmdDbc.toBuffer());
  writeFile('DBFilesClient/CreatureDisplayInfo.dbc', cdiDbc.toBuffer());
  writeFile('DBFilesClient/CreatureDisplayInfoExtra.dbc', cdieDbc.toBuffer());

  // 4. ItemDisplayInfo.dbc (23 cols)
  const idiDbc = new WdbcBuilder(23, [1, 2, 3, 4, 5, 14, 15, 16, 17, 18, 19, 20, 21]);
  const weaponRows = [
    // Celandia weapons (IDs 50001..50007)
    [50001, 'PorcelainRapier.mdx', '', 'CelandiaWhite', '', 'Ability_Porcelain_Slash'],
    [50002, 'FrostbellChimeStaff.mdx', '', 'CelandiaWhite', '', 'Spell_Frostbell_Chime'],
    [50003, 'GlasswakePrismBow.mdx', '', 'CelandiaWhite', '', 'Spell_Glasswake_Prism'],
    [50004, 'AureateSunblade.mdx', '', 'CelandiaWhite', '', 'Spell_Aureate_Sunburst'],
    [50005, 'NocturnumLanternHook.mdx', '', 'CelandiaWhite', '', 'Spell_Nocturnum_Lantern'],
    [50006, 'TekkaCrystalLance.mdx', '', 'CelandiaWhite', '', 'Spell_Tekka_Voltekka'],
    [50007, 'PorcelainAegis.mdx', '', 'CelandiaWhite', '', 'Spell_Aureate_Sanctuary'],
    // Also alias the classic starting weapon display IDs and CharStartOutfit guard IDs
    [9891, '', '', '', '', 'Ability_Porcelain_Slash'],
    [9892, '', '', '', '', 'Ability_Porcelain_Slash'],
    [10141, '', '', '', '', 'Ability_Porcelain_Slash'],
    [1542, 'PorcelainRapier.mdx', '', 'CelandiaWhite', '', 'Ability_Porcelain_Slash'],
    [18730, 'PorcelainAegis.mdx', '', 'CelandiaWhite', '', 'Spell_Aureate_Sanctuary'],
  ];
  for (const [id, mL, mR, tL, tR, icon] of weaponRows) {
    idiDbc.addRow({ 0: id, 1: mL, 2: mR, 3: tL, 4: tR, 5: icon, 12: 1 });
  }
  writeFile('DBFilesClient/ItemDisplayInfo.dbc', idiDbc.toBuffer());

  // 5. ChrClasses.dbc (17 cols, col 4 is PET_NAME_TOKEN)
  const classesDbc = new WdbcBuilder(17, [4]);
  for (const [id, stat, token, family, relic] of [
    [1, 0, 'PET', 4, 0],     // Warrior / Porcelain Duelist
    [2, 0, 'PET', 10, 1],    // Paladin / Aureate Sun-Knight
    [3, 1, 'PET', 9, 0],     // Hunter / Glasswake Ranger
    [4, 1, 'PET', 8, 0],     // Rogue / Nocturnum Shade
    [5, 0, 'PET', 6, 0],     // Priest / Frostbell Cantor
    [7, 0, 'PET', 11, 1],    // Shaman / Tidecaller
    [8, 0, 'PET', 3, 0],     // Mage / Elsewhere Arcanist
    [9, 0, 'DEMON', 5, 0],   // Warlock / Voidweaver
    [11, 0, 'PET', 7, 1],    // Druid / Grovekeeper
  ]) {
    classesDbc.addRow({ 0: id, 2: stat, 4: token, 15: family, 16: relic });
  }
  writeFile('DBFilesClient/ChrClasses.dbc', classesDbc.toBuffer());

  // 6. ChrRaces.dbc (29 cols: 15 fileString, 26/27 facial, 28 hair)
  const racesDbc = new WdbcBuilder(29, [15, 26, 27, 28]);
  const raceFiles = [
    [1, 'Human'], [2, 'Orc'], [3, 'Dwarf'], [4, 'NightElf'],
    [5, 'Scourge'], [6, 'Tauren'], [7, 'Gnome'], [8, 'Troll'],
  ];
  for (const [race, file] of raceFiles) {
    const mDisp = 48 + race * 2;
    const fDisp = 48 + race * 2 + 1;
    racesDbc.addRow({
      0: race,
      1: 0,
      2: race, // FactionID -> FactionTemplate 1..8
      4: mDisp,
      5: fDisp,
      7: 7,
      11: 1,
      15: file,
      26: 'NORMAL',
      27: 'NORMAL',
      28: 'NORMAL',
    });
  }
  writeFile('DBFilesClient/ChrRaces.dbc', racesDbc.toBuffer());

  // 7. CharBaseInfo.dbc (special 2-byte records: field_count=2, record_size=2)
  const knownCombos = [
    [1, [1, 2, 4, 5, 8, 9]],
    [2, [1, 3, 4, 7, 9]],
    [3, [1, 2, 3, 4, 5, 8]],
    [4, [1, 3, 4, 5, 11]],
    [5, [1, 4, 5, 8, 9]],
    [6, [1, 3, 7, 11]],
    [7, [1, 4, 8, 9]],
    [8, [1, 3, 4, 5, 7, 8]],
  ];
  const comboPairs = [];
  for (const [r, cs] of knownCombos) {
    for (const c of cs) comboPairs.push([r, c]);
  }
  const cbiHdr = Buffer.alloc(20, 0);
  cbiHdr.write('WDBC', 0, 4, 'ascii');
  cbiHdr.writeUInt32LE(comboPairs.length, 4);
  cbiHdr.writeUInt32LE(2, 8);
  cbiHdr.writeUInt32LE(2, 12);
  cbiHdr.writeUInt32LE(1, 16);
  const cbiBody = Buffer.alloc(comboPairs.length * 2 + 1, 0);
  comboPairs.forEach(([r, c], i) => {
    cbiBody[i * 2] = r;
    cbiBody[i * 2 + 1] = c;
  });
  writeFile('DBFilesClient/CharBaseInfo.dbc', Buffer.concat([cbiHdr, cbiBody]));

  // 8. CharStartOutfit.dbc (special 41 fields, 152-byte records)
  const csoHdr = Buffer.alloc(20, 0);
  csoHdr.write('WDBC', 0, 4, 'ascii');
  csoHdr.writeUInt32LE(1, 4);
  csoHdr.writeUInt32LE(41, 8);
  csoHdr.writeUInt32LE(152, 12);
  csoHdr.writeUInt32LE(1, 16);
  const csoRec = Buffer.alloc(152 + 1, 0);
  csoRec.writeUInt32LE(1, 0);
  csoRec[4] = 1; // race 1
  csoRec[5] = 1; // class 1
  csoRec[6] = 0; // sex 0
  const hwGuard = [[9891, 4], [9892, 7], [10141, 8], [1542, 21], [18730, 14]];
  hwGuard.forEach(([disp, inv], slot) => {
    csoRec.writeInt32LE(slot + 1, 8 + slot * 4);
    csoRec.writeInt32LE(disp, 56 + slot * 4);
    csoRec.writeInt32LE(inv, 104 + slot * 4);
  });
  writeFile('DBFilesClient/CharStartOutfit.dbc', Buffer.concat([csoHdr, csoRec]));

  // 9. CharSections.dbc (10 cols), CharHairGeosets.dbc (6 cols), CharacterFacialHairStyles.dbc (9 cols), HelmetGeosetVisData.dbc (6 cols)
  const csDbc = new WdbcBuilder(10, [6, 7, 8]);
  const chgDbc = new WdbcBuilder(6);
  const cfhDbc = new WdbcBuilder(9);
  let csId = 1;
  for (let race = 1; race <= 8; race++) {
    for (let sex = 0; sex <= 1; sex++) {
      for (const secType of [0, 1, 2, 3, 4]) {
        csDbc.addRow({
          0: csId++,
          1: race,
          2: sex,
          3: secType,
          4: 0,
          5: 0,
          6: 'Textures\\CelandiaWhite.blp',
          7: '',
          8: '',
          9: 0,
        });
      }
      chgDbc.addRow({ 0: race * 2 + sex, 1: race, 2: sex, 3: 0, 4: 1, 5: 0 });
      cfhDbc.addRow({ 0: race, 1: sex, 2: 0, 6: 1, 7: 1, 8: 1 });
    }
  }
  writeFile('DBFilesClient/CharSections.dbc', csDbc.toBuffer());
  writeFile('DBFilesClient/CharHairGeosets.dbc', chgDbc.toBuffer());
  writeFile('DBFilesClient/CharacterFacialHairStyles.dbc', cfhDbc.toBuffer());
  writeFile('DBFilesClient/HelmetGeosetVisData.dbc', new WdbcBuilder(6).toBuffer());

  // 10. AnimationData.dbc (populated by build-celandia-anims.mjs with all 208 sequence rows)
  buildAnimationDataDbc(writeFile, WdbcBuilder);

  // 11. SpellIcon.dbc (2 cols) & Spell.dbc (173 cols) & SpellVisual* DBCs
  const spellIconDbc = new WdbcBuilder(2, [1]);
  for (const ic of SPELL_ICONS) {
    spellIconDbc.addRow({ 0: ic.id, 1: `Interface\\Icons\\${ic.name}` });
  }
  writeFile('DBFilesClient/SpellIcon.dbc', spellIconDbc.toBuffer());

  const svfxDbc = new WdbcBuilder(5, [1, 2]);
  const fxRows = [
    [1, 'PorcelainBurst', 'Spells\\PorcelainBurst.mdx'],
    [2, 'FrostbellNova', 'Spells\\FrostbellNova.mdx'],
    [3, 'GlasswakeBeam', 'Spells\\GlasswakeBeam.mdx'],
    [4, 'AureateSanctuary', 'Spells\\AureateSanctuary.mdx'],
    [5, 'NocturnumVortex', 'Spells\\NocturnumVortex.mdx'],
    [6, 'HARDCODED Level Up', 'Spells\\LevelUp.mdx'],
    [7, 'HARDCODED Loot Art', 'Spells\\LootArt.mdx'],
  ];
  for (const [id, name, p] of fxRows) {
    svfxDbc.addRow({ 0: id, 1: name, 2: p });
  }
  writeFile('DBFilesClient/SpellVisualEffectName.dbc', svfxDbc.toBuffer());

  const svkDbc = new WdbcBuilder(35);
  for (let k = 1; k <= 5; k++) {
    // 1..5: Cast Kits (with Cast SoundID 6201, 6203, 6205, 6207, 6209)
    svkDbc.addRow({
      0: k,
      2: 51, // SpellCastDirected anim
      4: k,  // chest/base effect slot -> effect_id k
      12: k, // world_effect -> effect_id k
      13: 6200 + (k - 1) * 2 + 1, // SoundID -> Celandia spell cast entry
      15: -1, 16: -1, 17: -1, 18: -1,
    });
    // 6..10: Impact Kits (with Impact SoundID 6202, 6204, 6206, 6208, 6210)
    svkDbc.addRow({
      0: k + 5,
      2: 9,  // CombatWound anim
      4: k,
      12: k,
      13: 6200 + (k - 1) * 2 + 2, // SoundID -> Celandia spell impact entry
      15: -1, 16: -1, 17: -1, 18: -1,
    });
    // 11..15: Silent Visual Kits for precast / state / channel (SoundID = 0 so sounds don't double-trigger)
    svkDbc.addRow({
      0: k + 10,
      2: 51,
      4: k,
      12: k,
      13: 0,
      15: -1, 16: -1, 17: -1, 18: -1,
    });
  }
  writeFile('DBFilesClient/SpellVisualKit.dbc', svkDbc.toBuffer());

  const svDbc = new WdbcBuilder(16);
  for (let v = 1; v <= 5; v++) {
    svDbc.addRow({
      0: v,
      1: v + 10, // precast kit (silent visual)
      2: v,      // cast kit (plays cast sound)
      3: v + 5,  // impact kit (plays impact sound)
      4: v + 10, // state kit (silent visual)
      5: v + 10, // channel kit (silent visual)
      7: v,      // missile_model
      12: v,     // area_effect
    });
  }
  writeFile('DBFilesClient/SpellVisual.dbc', svDbc.toBuffer());
  writeFile('DBFilesClient/SpellChainEffects.dbc', new WdbcBuilder(0).toBuffer());

  const spellDbc = new WdbcBuilder(173, [120, 129, 138, 147]);
  const celandiaSpells = [
    [60001, 'Porcelain Riposte', 'Rank 1', 'Strikes nearby foes with a razor-edged porcelain cadence.', 1, 1],
    [60002, 'Whirling Cadence', 'Rank 1', 'Spins in a porcelain tempest, slicing all surrounding enemies.', 2, 1],
    [60003, 'Grappling Hook', 'Rank 1', 'Flings Rook\'s brass grapple to pierce and stagger distant targets.', 3, 1],
    [60004, 'Frostbell Chime', 'Rank 1', 'Rings a resonant ice bell that shatters around the target.', 4, 2],
    [60005, 'Lagoon Frost Nova', 'Rank 1', 'Freezes the tide around the caster in a ring of Frostbell rime.', 5, 2],
    [60006, 'Elsewhere Squall', 'Rank 1', 'Calls down crystalline shards from the Frostbell membrane.', 6, 2],
    [60007, 'Prism Volley', 'Rank 1', 'Fires refracted turquoise glass arrows across the mesa.', 7, 3],
    [60008, 'Mirage Scatter', 'Rank 1', 'Splits light through Glasswake reeds into a blinding cone.', 8, 3],
    [60009, 'Aureate Sunburst', 'Rank 1', 'Calls a golden flare from the Aureate Reach.', 9, 4],
    [60010, 'Sovereign Sanctuary', 'Rank 1', 'Consecrates the ground in gilded travertine light.', 10, 4],
    [60011, 'Nocturnum Lantern', 'Rank 1', 'Projects a violet shadow-flame bolt from Nocturnum Isle.', 11, 5],
    [60012, 'Obsidian Eclipse', 'Rank 1', 'Pulses dark fairy energy around the caster.', 12, 5],
    [60013, 'Voltekka Lance', 'Rank 1', 'Unleashes Tekkaman\'s antimatter crystal beam.', 13, 3],
    [60014, 'Starlight Resonance', 'Rank 1', 'Projects Jem\'s holographic starlight shockwave.', 14, 4],
    [60015, 'Ashen Soul Rend', 'Rank 1', 'Cleaves foes with Reincarnation soul-fire.', 15, 5],
    // Passive & Mobility spell rows so all HUD cards, buffs, and F-key escapes resolve icons & visuals
    [19740, 'Porcelain Might', 'Passive', 'Increases all damage you deal.', 1, 1],
    [1243, 'Porcelain Fortitude', 'Passive', 'Increases your maximum health.', 10, 4],
    [13159, 'Tidewalker Stride', 'Passive', 'Increases your movement speed.', 7, 3],
    [139, 'Elsewhere Mending', 'Passive', 'Restores health every second.', 4, 2],
    [1459, 'Frostbell Resonance', 'Passive', 'Your abilities recharge faster.', 5, 2],
    [1008, 'Prism Amplification', 'Passive', 'Increases the size of your areas of effect.', 8, 3],
    [132, 'Lantern Magnetism', 'Passive', 'Increases your crystal pickup range.', 11, 5],
    [19742, 'Aureate Wisdom', 'Passive', 'Increases the experience you gain.', 9, 4],
    [1126, 'Obsidian Carapace', 'Passive', 'Reduces the damage of every hit you take.', 12, 5],
    [20217, 'Sovereign Grace', 'Passive', 'Increases your critical strike chance.', 14, 4],
    [100, 'Grapple Lunge', 'Mobility', 'Lunge toward the nearest enemy within 25 yards, stunning it.', 3, 1],
    [1044, 'Aureate Freedom', 'Mobility', 'Nothing can hold you: run 60% faster for 5 sec.', 9, 4],
    [5118, 'Glasswake Dash', 'Mobility', 'Run 70% faster for 5 sec.', 7, 3],
    [2983, 'Nocturnum Sprint', 'Mobility', 'Run 80% faster for 4 sec.', 11, 5],
    [586, 'Elsewhere Fade', 'Mobility', 'Fade into the mist: enemies lose you and you run 40% faster.', 4, 2],
    [2645, 'Sky Manta Glide', 'Mobility', 'Glide on the tide-wind, running 60% faster for 6 sec.', 6, 2],
    [1953, 'Phase Blink', 'Mobility', 'Teleport 18 yards forward through the Elsewhere.', 5, 2],
    [5484, 'Obsidian Howl', 'Mobility', 'Send every nearby enemy fleeing in terror for 4 sec.', 12, 5],
    [1850, 'Porcelain Gale', 'Mobility', 'Run 80% faster for 4 sec.', 2, 1],
  ];
  for (const [id, name, sub, desc, iconId, visId] of celandiaSpells) {
    spellDbc.addRow({
      0: id,
      1: 0,
      37: f32(24.0), // Speed
      115: visId,
      117: iconId,
      120: name,
      129: sub,
      138: desc,
      147: desc,
    });
  }
  writeFile('DBFilesClient/Spell.dbc', spellDbc.toBuffer());

  // 12. Lighting DBCs: Light.dbc (12 cols), LightParams.dbc (9 cols), LightIntBand.dbc (34 cols), LightFloatBand.dbc (34 cols), LightSkybox.dbc (3 cols)
  const lightDbc = new WdbcBuilder(12);
  // Global light row 1 (Celandia warm porcelain daylight)
  lightDbc.addRow({
    0: 1,
    1: 0,
    2: f32(0.0), 3: f32(0.0), 4: f32(0.0),
    5: f32(0.0), 6: f32(100000.0),
    7: 1, 8: 1, 9: 1, 10: 1, 11: 1,
  });
  writeFile('DBFilesClient/Light.dbc', lightDbc.toBuffer());

  const lpDbc = new WdbcBuilder(9);
  for (let p = 1; p <= 7; p++) {
    lpDbc.addRow({
      0: p,
      1: 1,
      2: 0,
      3: 0,
      4: f32(0.35), // bloom glow
      5: f32(0.55),
      6: f32(0.85),
      7: f32(0.65),
      8: f32(0.92),
    });
  }
  writeFile('DBFilesClient/LightParams.dbc', lpDbc.toBuffer());

  const libDbc = new WdbcBuilder(34);
  // 18 bands per LightParam
  const bandColors = [
    0xffe8d8, // 0: diffuse sun
    0x8a7fa0, // 1: ambient
    0xb8d4f8, // 2: sky top
    0xd8e8ff, // 3: sky mid
    0xf4e4f0, // 4: sky horizon
    0xffe8e0, // 5: sky above horizon
    0xfff0e4, // 6: sky glow
    0xe8dff4, // 7: fog color
    0xffffff, // 8: sun color
    0xfff4ea, // 9: cloud sun
    0xd8d0e8, // 10: cloud slope
    0xc4bcd8, // 11: cloud base
    0x5ad8d0, // 12: river shallow
    0x2c7a8c, // 13: river deep
    0x6ad8e8, // 14: ocean shallow
    0x1e4868, // 15: ocean deep
    0xffffff,
    0xffffff,
  ];
  for (let p = 1; p <= 7; p++) {
    for (let b = 0; b < 18; b++) {
      const id = (p - 1) * 18 + b + 1;
      libDbc.addRow({
        0: id,
        1: 2,
        2: 0,
        3: 1440,
        18: bandColors[b],
        19: bandColors[b],
      });
    }
  }
  writeFile('DBFilesClient/LightIntBand.dbc', libDbc.toBuffer());

  const lfbDbc = new WdbcBuilder(34);
  const floatDefaults = [4200.0, 0.25, 0.2, 0.5, 1.0, 0.0]; // fogEnd (inches = yards*36), fogStartMult, cloudDensity...
  for (let p = 1; p <= 7; p++) {
    for (let b = 0; b < 6; b++) {
      const id = (p - 1) * 6 + b + 1;
      lfbDbc.addRow({
        0: id,
        1: 2,
        2: 0,
        3: 1440,
        18: f32(floatDefaults[b]),
        19: f32(floatDefaults[b]),
      });
    }
  }
  writeFile('DBFilesClient/LightFloatBand.dbc', lfbDbc.toBuffer());
  writeFile('DBFilesClient/LightSkybox.dbc', new WdbcBuilder(0).toBuffer());

  // 13. Faction.dbc (37 cols) & FactionTemplate.dbc (14 cols) & FactionGroup.dbc (11 cols)
  const facDbc = new WdbcBuilder(37, [19, 28]);
  facDbc.addRow({ 0: 1, 1: 0, 2: 0xFF, 6: 0xFFF, 10: 3000, 19: 'Celandia Court', 28: 'Guardians of the Porcelain Wake.' });
  facDbc.addRow({ 0: 2, 1: 1, 2: 0xFF, 6: 0xFFF, 10: -6000, 19: 'Nocturnum Legion', 28: 'Dark fairy forces of Nocturnum Isle.' });
  writeFile('DBFilesClient/Faction.dbc', facDbc.toBuffer());

  const ftDbc = new WdbcBuilder(14);
  for (let r = 1; r <= 8; r++) {
    ftDbc.addRow({ 0: r, 1: 1, 3: 3, 4: 3, 5: 8 }); // Friendly player templates
  }
  ftDbc.addRow({ 0: 35, 1: 1, 3: 3, 4: 3, 5: 8 }); // FACTION_FRIENDLY = 35
  ftDbc.addRow({ 0: 14, 1: 2, 3: 8, 4: 8, 5: 7 }); // FACTION_MONSTER = 14
  writeFile('DBFilesClient/FactionTemplate.dbc', ftDbc.toBuffer());
  writeFile('DBFilesClient/FactionGroup.dbc', new WdbcBuilder(0).toBuffer());

  // 14. GameObjectDisplayInfo.dbc (12 cols: 0=ID, 1=ModelName, 2..11=Sound[10])
  const godiDbc = new WdbcBuilder(12, [1]);
  for (const [id, model] of [
    [1, 'World\\Celandia\\Doodads\\PorcelainGiantTree.mdx'],
    [2, 'World\\Celandia\\Doodads\\FrostbellSnowFir.mdx'],
    [3, 'World\\Celandia\\Doodads\\GlasswakeCrystalTree.mdx'],
    [4, 'World\\Celandia\\Doodads\\AureateCypress.mdx'],
    [114, 'Spells\\AureateSanctuary.mdx'],   // Heal crystal pickup
    [426, 'Spells\\PorcelainBurst.mdx'],     // Small XP crystal
    [1267, 'Spells\\GlasswakeBeam.mdx'],     // Medium XP crystal
    [1307, 'Spells\\NocturnumVortex.mdx'],   // Large XP crystal
  ]) {
    godiDbc.addRow({ 0: id, 1: model });
  }
  writeFile('DBFilesClient/GameObjectDisplayInfo.dbc', godiDbc.toBuffer());

  // 14b. TalentTab.dbc (15 cols: 1=Name, 11=RaceMask, 12=ClassMask, 14=Background) & Talent.dbc (21 cols)
  const talentTabDbc = new WdbcBuilder(15, [1, 14]);
  const talentDbc = new WdbcBuilder(21);
  const classTalentTabs = [
    [1, [['Arms', 'WarriorArms'], ['Fury', 'WarriorFury'], ['Protection', 'WarriorProtection']]],
    [2, [['Holy', 'PaladinHoly'], ['Protection', 'PaladinProtection'], ['Retribution', 'PaladinCombat']]],
    [3, [['Beast Mastery', 'HunterBeastMastery'], ['Marksmanship', 'HunterMarksmanship'], ['Survival', 'HunterSurvival']]],
    [4, [['Assassination', 'RogueAssassination'], ['Combat', 'RogueCombat'], ['Subtlety', 'RogueSubtlety']]],
    [5, [['Discipline', 'PriestDiscipline'], ['Holy', 'PriestHoly'], ['Shadow', 'PriestShadow']]],
    [7, [['Elemental', 'ShamanElementalCombat'], ['Enhancement', 'ShamanEnhancement'], ['Restoration', 'ShamanRestoration']]],
    [8, [['Arcane', 'MageArcane'], ['Fire', 'MageFire'], ['Frost', 'MageFrost']]],
    [9, [['Affliction', 'WarlockCurses'], ['Demonology', 'WarlockSummoning'], ['Destruction', 'WarlockDestruction']]],
    [11, [['Balance', 'DruidBalance'], ['Feral Combat', 'DruidFeralCombat'], ['Restoration', 'DruidRestoration']]],
  ];
  let tabId = 1;
  let talentId = 1;
  for (const [cls, tabs] of classTalentTabs) {
    const classMask = 1 << (cls - 1);
    tabs.forEach(([tabName, bg], orderIdx) => {
      const tid = tabId++;
      talentTabDbc.addRow({
        0: tid,
        1: tabName,
        10: 1, // SpellIconID
        11: 511, // RaceMask (bits 0..8)
        12: classMask,
        13: orderIdx,
        14: bg,
      });
      // 16 talents per tab (4 tiers x 4 columns = 432 total talents across 27 tabs)
      for (let slot = 0; slot < 16; slot++) {
        const r = Math.floor(slot / 4);
        const c = slot % 4;
        const spellId = 60001 + (slot % 15);
        talentDbc.addRow({
          0: talentId++,
          1: tid,
          2: r,
          3: c,
          4: spellId, // Rank 1 spell
        });
      }
    });
  }
  writeFile('DBFilesClient/TalentTab.dbc', talentTabDbc.toBuffer());
  writeFile('DBFilesClient/Talent.dbc', talentDbc.toBuffer());

  // 15. Empty valid 0-row WDBC stubs for remaining auxiliary DBCs
  const emptyDbcs = [
    'AreaPOI.dbc', 'AreaTrigger.dbc', 'BankBagSlotPrices.dbc',
    'CameraShakes.dbc', 'Cfg_Categories.dbc', 'ChatChannels.dbc', 'ChatProfanity.dbc',
    'CinematicCamera.dbc', 'CinematicSequences.dbc', 'CreatureFamily.dbc',
    'CreatureType.dbc', 'DurabilityCosts.dbc', 'DurabilityQuality.dbc',
    'Emotes.dbc', 'EmotesText.dbc', 'EmotesTextData.dbc', 'EmotesTextSound.dbc',
    'EnvironmentalDamage.dbc', 'Exhaustion.dbc',
    'GameTips.dbc', 'GMTicketCategory.dbc', 'GroundEffectDoodad.dbc',
    'ItemBagFamily.dbc', 'ItemPetFood.dbc', 'ItemRandomProperties.dbc', 'ItemSet.dbc',
    'ItemVisualEffects.dbc', 'ItemVisuals.dbc', 'Languages.dbc',
    'LanguageWords.dbc', 'LiquidType.dbc', 'Lock.dbc', 'LockType.dbc',
    'Package.dbc', 'PageTextMaterial.dbc', 'PetLoyalty.dbc',
    'PetPersonality.dbc', 'QuestInfo.dbc', 'QuestSort.dbc', 'ServerMessages.dbc',
    'SkillLine.dbc', 'SkillLineAbility.dbc', 'SkillLineCategory.dbc',
    'SkillRaceClassInfo.dbc', 'SpamMessages.dbc', 'SpellCastTimes.dbc', 'SpellCategory.dbc',
    'SpellDispelType.dbc', 'SpellDuration.dbc', 'SpellEffectCameraShakes.dbc', 'SpellFocusObject.dbc',
    'SpellItemEnchantment.dbc', 'SpellMechanic.dbc', 'SpellRadius.dbc', 'SpellRange.dbc',
    'SpellShapeshiftForm.dbc', 'StableSlotPrices.dbc', 'Stationery.dbc',
    'TaxiNodes.dbc', 'TaxiPath.dbc', 'TaxiPathNode.dbc',
    'TransportAnimation.dbc', 'UnitBlood.dbc', 'UnitBloodLevels.dbc',
    'WorldStateUI.dbc',
  ];
  const zeroWdbc = new WdbcBuilder(0).toBuffer();
  for (const name of emptyDbcs) {
    writeFile(`DBFilesClient/${name}`, zeroWdbc);
  }

  // 16. Build Celandia Audio & Sound Pipeline (Sound/* + 22 Audio DBCs)
  console.log('  - Building Celandia Audio & Sound Pipeline (Sound/* + 22 Audio DBCs)...');
  buildCelandiaAudio(writeFile, WdbcBuilder, f32);

  // 17. Build Celandia RPG UI Chrome, World Maps & DefaultBindings.wtf
  console.log('  - Building Celandia RPG UI Chrome, World Maps & DefaultBindings.wtf...');
  buildCelandiaUi(writeFile, WdbcBuilder, f32, createBlp2, sampleCelandiaHeight, atlas.BIOMES);

  // 18. Ensure WMOAreaTable.dbc from build-celandia-wmo.mjs is preserved
  if (wmoInfo?.wmoAreaTableBuffer) {
    writeFile('DBFilesClient/WMOAreaTable.dbc', wmoInfo.wmoAreaTableBuffer);
  }
}

// ============================================================================
// 5. Fonts (`FRIZQT__.TTF`, `ARIALN.TTF`, `MORPHEUS.TTF`, `SKURRI.TTF`) — Geist Sans + Bricolage
// ============================================================================
function patchTtfForClient(srcBuffer) {
  const buf = Buffer.from(srcBuffer);
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const recOffset = 12 + i * 16;
    const tag = buf.toString('ascii', recOffset, recOffset + 4);
    // Disable GSUB (ligatures) & STAT so per-character and whole-string glyph shaping match
    if (tag === 'GSUB') {
      buf.write('GSU_', recOffset, 4, 'ascii');
    } else if (tag === 'STAT') {
      buf.write('STA_', recOffset, 4, 'ascii');
    }
  }
  return buf;
}

function buildFonts() {
  console.log('[5/5] Installing Geist Sans & Celandia Display fonts in WoW/Data/Fonts/...');
  const geistDir = '/Users/xmacbookm5/Projects/curricula/open_notebook/curriculum/assets';
  const bricolagePath = path.join(CELANDIA_DIR, 'docs/elsewhere-tide/fonts/bricolage-grotesque-variable.ttf');
  const fallbackRegular = path.join(REINCARNATION_DIR, 'output/pdf/source/fonts/Barlow-Regular.ttf');
  const fontMap = [
    ['Fonts/FRIZQT__.TTF', path.join(geistDir, 'Geist-SemiBold.ttf'), fallbackRegular],
    ['Fonts/ARIALN.TTF', path.join(geistDir, 'Geist-Medium.ttf'), fallbackRegular],
    ['Fonts/MORPHEUS.TTF', path.join(geistDir, 'Geist-Bold.ttf'), fallbackRegular],
    ['Fonts/SKURRI.TTF', path.join(geistDir, 'Geist-Bold.ttf'), fallbackRegular],
    ['Fonts/BricolageGrotesque.ttf', bricolagePath, fallbackRegular],
  ];
  for (const [destRel, primaryPath, fallbackPath] of fontMap) {
    const chosen = fs.existsSync(primaryPath) ? primaryPath : fallbackPath;
    if (fs.existsSync(chosen)) {
      writeFile(destRel, patchTtfForClient(fs.readFileSync(chosen)));
    }
  }
}

const t0 = Date.now();
buildTextures();
buildModels();
const wmoInfo = await buildTerrain();
buildDbcs(wmoInfo);
buildFonts();
const { execFileSync } = await import('node:child_process');
execFileSync('python3', [path.join(__dirname, 'render-celandia-art.py')], { stdio: 'inherit' });
console.log(`Done! Built Celandia: Wokecraft NoW — The Elsewhere Tide Expansion WoW/Data corpus in ${((Date.now() - t0) / 1000).toFixed(2)}s.`);


