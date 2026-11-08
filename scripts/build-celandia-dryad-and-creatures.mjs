/**
 * Celandia + Dryad (`owenyuwono/dryad`) Botanical Procedural Trees, Species Flora,
 * and Sculpted Celandia Creatures, Bad Guys & Bosses for Wokecraft NoW.
 *
 * Directly integrates:
 * - Dryad botanical tree generator (`/Users/xmacbookm5/Projects/j3games/reincarnation/src/world/dryad/`)
 *   + `buildSakuraTreeGeometry` / `buildDryadTreeGeometry` (`procedural-trees.js`)
 * - Celandia's `ui/world/flora.js` & `species.js` (`giantTree`, `firTier`, `pawFrond`,
 *   `fernClump`, `broadLeaf`, `leafBush`, `crownBlob`, `crystal`, blooming saguaro/barrel cacti,
 *   Frostbell bellflowers, Aureate lamp-trees)
 * - Celandia's `game/realms-art-wave8.js` (Moonlight Lava Dragon `Ignis-Nocturne`,
 *   `organicLobe`, `taperedTubeGeo`, `latheGeo`, `cuppedPetalGeo`), `ui/world/fauna.js`,
 *   and 21-bone rigged humanoid bad guys (`ui/cast/`).
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CELANDIA_DIR = '/Users/xmacbookm5/Projects/j3games/Celandia';
const REINCARNATION_DIR = '/Users/xmacbookm5/Projects/j3games/reincarnation';

const THREE = await import(pathToFileURL(path.join(CELANDIA_DIR, 'node_modules/three/build/three.module.js')).href);

// Import Dryad botanical tree pipeline from reincarnation
const { mulberry32 } = await import(pathToFileURL(path.join(REINCARNATION_DIR, 'src/world/dryad/rng.js')).href);
const {
  buildSakuraTreeGeometry,
  buildDryadTreeGeometry,
} = await import(pathToFileURL(path.join(REINCARNATION_DIR, 'src/world/procedural-trees.js')).href);

// Import Celandia flora & cast builders
const floraMod = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/world/flora.js')).href);
const geoMod = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/cast/geo.js')).href);
const anatomyMod = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/cast/anatomy.js')).href);
const rigMod = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/cast/rig.js')).href);
const kitMod = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/cast/kit.js')).href);
const castMod = await import(pathToFileURL(path.join(CELANDIA_DIR, 'docs/elsewhere-tide/ui/cast/cast.js')).href);

function rng(seed = 1) {
  const fn = mulberry32(seed);
  fn.next = () => fn();
  fn.range = (a, b) => a + fn() * (b - a);
  fn.int = (a, b) => Math.floor(a + fn() * (b - a + 1));
  fn.pm = a => (fn() * 2 - 1) * a;
  return fn;
}

const {
  BarkBuilder,
  LeafBuilder,
  sweep: floraSweep,
  firTier,
  pawFrond,
  crownBlob,
  leafBush,
  fernClump,
  broadLeaf,
  crystal: floraCrystal,
  giantTree,
} = floraMod;

const { ell, sweep, band, petal, mix, smooth, v3, TAU, C, withDetail } = geoMod;
const { cover, headCap, OUT } = anatomyMod;
const { makeRig } = rigMod;
const { faeBody, faeHead, hairCap, shoe, skirtShell, wingsDragonfly, wingsButterfly, capKeep } = kitMod;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const D2R = Math.PI / 180;

/**
 * Build a standalone hexagonal crystal BufferGeometry with vertical vertex-color gradient
 * using Celandia's `flora.crystal(arr, base, dir, len, rad, rot, fat)`.
 */
function crystal(rad = 0.2, len = 1.0, botHex = '#48b8f0', topHex = '#f0fcff') {
  const arr = [];
  floraCrystal(arr, V(0, 0, 0), V(0, 1, 0), len, rad, 0.25, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  g.computeVertexNormals();
  paintVerticalGradient(g, botHex, topHex);
  return g;
}

/**
 * Bake Celandia's `aBark` (`ridge, height, crownShade, crystalGlow`) attribute into RGB `color`.
 */
function bakeBarkGeo(barkGeo, darkHex = '#3a2a1e', midHex = '#5c432c', litHex = '#8c6b48', glowHex = '#ff72c8') {
  const pos = barkGeo.attributes.position;
  const aBark = barkGeo.attributes.aBark;
  const cDark = new THREE.Color(darkHex);
  const cMid = new THREE.Color(midHex);
  const cLit = new THREE.Color(litHex);
  const cGlow = new THREE.Color(glowHex);
  const cTmp = new THREE.Color();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ridge = aBark ? aBark.getX(i) : 0;
    const shade = aBark ? Math.max(0, -aBark.getZ(i)) : 0;
    const glow = aBark ? Math.max(0, aBark.getW(i)) : 0;
    cTmp.copy(cMid).lerp(ridge > 0 ? cLit : cDark, Math.min(1, Math.abs(ridge) * 0.75));
    if (shade > 0) cTmp.lerp(cDark, shade * 0.45);
    if (glow > 0) cTmp.lerp(cGlow, Math.min(1, glow * 0.85));
    colors[i * 3 + 0] = cTmp.r;
    colors[i * 3 + 1] = cTmp.g;
    colors[i * 3 + 2] = cTmp.b;
  }
  barkGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return barkGeo;
}

/**
 * Bake Celandia's `aLeaf` (`along, across, tone, phase`) attribute into RGB `color`.
 */
function bakeLeafGeo(leafGeo, baseHex = '#1e583e', tipHex = '#74d898', ribHex = '#c8f4a0', rimHex = null) {
  const pos = leafGeo.attributes.position;
  const aLeaf = leafGeo.attributes.aLeaf;
  const cBase = new THREE.Color(baseHex);
  const cTip = new THREE.Color(tipHex);
  const cRib = new THREE.Color(ribHex);
  const cRim = rimHex ? new THREE.Color(rimHex) : null;
  const cTmp = new THREE.Color();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const along = aLeaf ? Math.max(0, Math.min(1, aLeaf.getX(i))) : 0.5;
    const across = aLeaf ? Math.abs(aLeaf.getY(i)) : 0.5;
    const tone = aLeaf ? Math.max(0.7, Math.min(1.25, aLeaf.getZ(i))) : 1.0;
    cTmp.copy(cBase).lerp(cTip, Math.max(0, Math.min(1, along * 0.7 + across * 0.3)));
    if (across < 0.18) {
      cTmp.lerp(cRib, (1 - across / 0.18) * 0.55);
    }
    if (cRim && across > 0.82) {
      cTmp.lerp(cRim, ((across - 0.82) / 0.18) * 0.65);
    }
    cTmp.multiplyScalar(tone);
    colors[i * 3 + 0] = Math.min(1, cTmp.r);
    colors[i * 3 + 1] = Math.min(1, cTmp.g);
    colors[i * 3 + 2] = Math.min(1, cTmp.b);
  }
  leafGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return leafGeo;
}

// ============================================================================
// 1. Sculpting Primitives from Celandia `realms-art-wave8.js`
// ============================================================================

function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Smooth organic lobe (ellipsoid with optional taper, pinch, bend, and vertical gradient vertex colors).
 */
function organicLobe(rx, ry, rz, segs = 14, deformFn = null, topHex = null, botHex = null) {
  const g = new THREE.SphereGeometry(1, segs, Math.max(8, Math.floor(segs * 0.75)));
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const nx = v.x, ny = v.y, nz = v.z;
    v.x *= rx;
    v.y *= ry;
    v.z *= rz;
    if (deformFn) deformFn(v, nx, ny, nz);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  if (topHex && botHex) {
    paintVerticalGradient(g, botHex, topHex);
  }
  return g;
}

/**
 * Tapered tube along a 3D CatmullRomCurve3 with custom radius profile `radiusFn(t)` and elliptical cross-section.
 */
function taperedTubeGeo(points, tubularSegs = 20, radialSegs = 10, radiusFn = t => 0.2 * (1 - t * 0.7), scaleX = 1, scaleY = 1) {
  const vecs = points.map(p => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2])));
  const curve = new THREE.CatmullRomCurve3(vecs);
  const frames = curve.computeFrenetFrames(tubularSegs, false);
  const verts = [];
  const norms = [];
  const uvs = [];
  const indices = [];

  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const v = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let i = 0; i <= tubularSegs; i++) {
    const u = i / tubularSegs;
    curve.getPointAt(u, P);
    N.copy(frames.normals[i]);
    B.copy(frames.binormals[i]);
    const r = Math.max(0.003, radiusFn(u));

    for (let j = 0; j <= radialSegs; j++) {
      const theta = (j / radialSegs) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);

      normal.copy(N).multiplyScalar(cos * scaleX).addScaledVector(B, sin * scaleY).normalize();
      v.copy(P)
        .addScaledVector(N, r * cos * scaleX)
        .addScaledVector(B, r * sin * scaleY);

      verts.push(v.x, v.y, v.z);
      norms.push(normal.x, normal.y, normal.z);
      uvs.push(u, j / radialSegs);
    }
  }

  const stride = radialSegs + 1;
  for (let i = 0; i < tubularSegs; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + (j + 1);
      const d = i * stride + (j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 3D cupped petal/wing/leaf surface with midrib arch, longitudinal curl, and transverse cup.
 */
function cuppedPetalGeo(length = 1.0, width = 0.45, cupDepth = 0.08, curlTip = -0.1, thickness = 0.025, segsU = 8, segsV = 10) {
  const verts = [];
  const uvs = [];
  const indices = [];

  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let iv = 0; iv <= segsV; iv++) {
      const v = iv / segsV;
      const env = Math.sin(Math.pow(v, 0.72) * Math.PI);
      const halfW = width * 0.5 * env;
      const z = v * length;
      const archY = Math.sin(v * Math.PI) * cupDepth * 0.9 + Math.pow(v, 2.3) * curlTip;

      for (let iu = 0; iu <= segsU; iu++) {
        const u = (iu / segsU) * 2 - 1;
        const x = u * halfW;
        const cupY = (1 - u * u) * cupDepth * env;
        const edgeFade = Math.sin(v * Math.PI) * (1 - u * u * 0.85);
        const y = archY + cupY + sign * thickness * 0.5 * edgeFade;
        verts.push(x, y, z);
        uvs.push(iu / segsU, v);
      }
    }
  }

  const stride = segsU + 1;
  const sideVerts = (segsV + 1) * stride;
  for (let side = 0; side < 2; side++) {
    const base = side * sideVerts;
    for (let iv = 0; iv < segsV; iv++) {
      for (let iu = 0; iu < segsU; iu++) {
        const a = base + iv * stride + iu;
        const b = base + (iv + 1) * stride + iu;
        const c = base + (iv + 1) * stride + (iu + 1);
        const d = base + iv * stride + (iu + 1);
        if (side === 0) indices.push(a, b, d, b, c, d);
        else indices.push(a, d, b, b, d, c);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Revolved lathe geometry from `[radius, y]` profile pairs.
 */
function latheGeo(profilePairs, segs = 16) {
  const pts = profilePairs.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y));
  const g = new THREE.LatheGeometry(pts, segs);
  g.computeVertexNormals();
  return g;
}

/**
 * Paint a vertical vertex-color gradient onto any BufferGeometry.
 */
function paintVerticalGradient(geo, botHex, topHex) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const span = Math.max(0.001, bb.max.y - bb.min.y);
  const cBot = new THREE.Color(botHex);
  const cTop = new THREE.Color(topHex);
  const cTmp = new THREE.Color();
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, (pos.getY(i) - bb.min.y) / span));
    const ny = norm ? norm.getY(i) * 0.12 : 0;
    cTmp.copy(cBot).lerp(cTop, Math.max(0, Math.min(1, t + ny)));
    colors[i * 3 + 0] = cTmp.r;
    colors[i * 3 + 1] = cTmp.g;
    colors[i * 3 + 2] = cTmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// ============================================================================
// 2. Dryad Botanical Tree Builders (`owenyuwono/dryad` + `procedural-trees.js`)
// ============================================================================

function tintGeometryColors(geo, rgb) {
  const col = geo.attributes.color;
  if (!col || !rgb) return geo;
  for (let i = 0; i < col.count; i++) {
    col.setXYZ(
      i,
      Math.min(1, col.getX(i) * rgb[0]),
      Math.min(1, col.getY(i) * rgb[1]),
      Math.min(1, col.getZ(i) * rgb[2])
    );
  }
  return geo;
}

/**
 * Build a Dryad botanical tree (bark + roots + 3D cupped foliage/florets) using
 * `buildSakuraTreeGeometry` / `buildDryadTreeGeometry` from `procedural-trees.js`.
 */
function buildDryadSpeciesParts(speciesKey, seed, targetHeight, paletteOverrides = null) {
  if (speciesKey === 'sakura') {
    const { barkGeo, blossomGeo } = buildSakuraTreeGeometry(seed, targetHeight);
    if (paletteOverrides?.barkColor) tintGeometryColors(barkGeo, paletteOverrides.barkColor);
    return { barkGeo, foliageGeo: blossomGeo };
  }
  const { barkGeo, foliageGeo } = buildDryadTreeGeometry(speciesKey, seed, targetHeight);
  if (paletteOverrides?.barkColor) tintGeometryColors(barkGeo, paletteOverrides.barkColor);
  if (paletteOverrides?.foliageColor) tintGeometryColors(foliageGeo, paletteOverrides.foliageColor);
  return { barkGeo, foliageGeo };
}

/**
 * Convert Celandia's `giantTree` output (`{ bark, crown, crystals }`) into vertex-colored parts.
 */
function celandiaTreeToParts(treeOut, scale = 1.0) {
  const parts = [];
  if (treeOut.bark && treeOut.bark.attributes.position?.count > 0) {
    const bg = bakeBarkGeo(treeOut.bark.clone());
    if (scale !== 1.0) bg.scale(scale, scale, scale);
    parts.push({ geo: bg, color: '#ffffff' });
  }
  if (treeOut.crown && treeOut.crown.attributes.position?.count > 0) {
    const lg = bakeLeafGeo(treeOut.crown.clone(), '#1a4c32', '#52b882', '#a8e888', '#68d8ff');
    if (scale !== 1.0) lg.scale(scale, scale, scale);
    parts.push({ geo: lg, color: '#ffffff' });
  }
  if (treeOut.crystals && treeOut.crystals.attributes.position?.count > 0) {
    const cg = paintVerticalGradient(treeOut.crystals.clone(), '#ff58b8', '#ffe8f8');
    if (scale !== 1.0) cg.scale(scale, scale, scale);
    parts.push({ geo: cg, color: '#ffffff' });
  }
  return parts;
}

// ============================================================================
// 3. Build All 7 Kingdom Trees, Spire & 10 Ground Clutter Models
// ============================================================================

function buildAllDryadTreesAndFlora(buildProceduralPartsGlb, writeFile) {
  // 1. PorcelainGiantTree.m2 — Celandia `giantTree` (swept buttressed trunk, bark ridges,
  //    glowing base crystals & hanging fir tiers) + Dryad lush celadon/emerald sprig canopy!
  {
    const celTree = giantTree(rng(101), {
      style: 'grove',
      r: 0.95,
      top: 0.42,
      h: 11.5,
      lean: [0.35, 0.22],
      buttress: 1.4,
      crystals: 5,
      blue: 0.28,
      lod: 0,
    });
    const parts = celandiaTreeToParts(celTree, 1.0);
    // Add Dryad botanical canopy sprigs in Celandia emerald-jade & seafoam
    const dryad = buildDryadSpeciesParts('oak', 7711, 12.2, {
      barkColor: [0.38, 0.25, 0.20],
      foliageColor: [0.36, 0.72, 0.56],
      foliageColorVar: 0.14,
    });
    parts.push({ geo: dryad.foliageGeo, color: '#ffffff', pos: [0, 0.6, 0] });
    writeFile('World/Celandia/Doodads/PorcelainGiantTree.m2', buildProceduralPartsGlb(parts, 'static'));
  }

  // 2. PorcelainCherryTree.m2 — Full Dryad Botanical Sakura Tree (`sakura` preset:
  //    allometric pipe-model trunk/branches + geotropic roots + 3D cupped sakura blossom canopy)
  //    + Celandia glowing rose-quartz root crystals!
  {
    const dryadSakura = buildDryadSpeciesParts('sakura', 1007, 10.6, {
      barkColor: [0.36, 0.23, 0.21],
      foliageColor: [0.97, 0.68, 0.80],
      foliageColorVar: 0.12,
    });
    const parts = [
      { geo: dryadSakura.barkGeo, color: '#ffffff' },
      { geo: dryadSakura.foliageGeo, color: '#ffffff' },
    ];
    const r = rng(202);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.3;
      const d = 0.75 + r() * 0.45;
      const cr = crystal(0.18 + r() * 0.08, 0.85 + r() * 0.45, '#ff8ac8', '#ffe8f6');
      cr.rotateZ((r() - 0.5) * 0.45);
      cr.rotateY(a);
      cr.translate(Math.cos(a) * d, 0.25, Math.sin(a) * d);
      parts.push({ geo: cr, color: '#ffffff' });
    }
    writeFile('World/Celandia/Doodads/PorcelainCherryTree.m2', buildProceduralPartsGlb(parts, 'static'));
  }

  // 3. CelandiaPineGiant.m2 — Dryad Botanical Conifer (`pine` preset) + Celandia `firTier` scalloped tiers
  {
    const dryadPine = buildDryadSpeciesParts('pine', 3099, 13.5, {
      barkColor: [0.36, 0.24, 0.18],
      foliageColor: [0.22, 0.54, 0.42],
      foliageColorVar: 0.10,
    });
    const lb = new LeafBuilder();
    const r = rng(303);
    for (let t = 0; t < 6; t++) {
      const u = t / 5;
      const ty = 4.2 + u * 7.8;
      const reach = 3.0 * (1 - u * 0.68) + 0.55;
      firTier(lb, r, {
        center: V(0, ty, 0),
        r0: 0.22,
        reach,
        lobes: Math.round(7 - u * 2),
        drop: 0.52,
        sag: 1.5,
        fringe: 0.35 * (1 - u) + 0.15,
        spacing: 0.35,
        tone: r.range(0.88, 1.05),
        grid: 0.5,
        rings: 3,
        smooth: true,
      });
    }
    const tierGeo = bakeLeafGeo(lb.geometry(), '#1b4e38', '#48a878', '#8ae0a0', '#68f0c8');
    const parts = [
      { geo: dryadPine.barkGeo, color: '#ffffff' },
      { geo: dryadPine.foliageGeo, color: '#ffffff' },
      { geo: tierGeo, color: '#ffffff' },
    ];
    writeFile('World/Celandia/Doodads/CelandiaPineGiant.m2', buildProceduralPartsGlb(parts, 'static'));
  }

  // 4. FrostbellSnowFir.m2 — Celandia `species.js` `snowfir` (`floraSweep` trunk + 8 stacked
  //    `firTier` snow-draped tiers + glowing Frostbell ice crystals)
  {
    const r = rng(404);
    const bb = new BarkBuilder();
    const lb = new LeafBuilder();
    const h = 12.2;
    floraSweep(bb, {
      a: V(0, -0.4, 0),
      c: V(0.1, h * 0.5, 0.05),
      b: V(0.16, h, 0.08),
      rings: 10,
      seg: 12,
      ground: 0,
      cap: true,
      radius: (s, ang, out) => {
        out.v = Math.cos(ang * 6) * 0.08;
        return 0.44 * (1 - s * 0.85) + 0.06;
      },
    });
    const tiers = 8;
    for (let i = 0; i < tiers; i++) {
      const u = i / tiers;
      const y = h * (0.18 + 0.80 * u);
      firTier(lb, r, {
        center: V(0.16 * u, y, 0.08 * u),
        r0: 0.2,
        reach: (1 - u) * h * 0.30 + 0.55,
        lobes: Math.round(7 - u * 3),
        drop: 0.55,
        sag: 1.6,
        fringe: 0.45 * (1 - u) + 0.18,
        spacing: 0.32,
        tone: r.range(0.88, 1.04),
        grid: 0.45,
        rings: 3,
        smooth: true,
      });
    }
    const barkGeo = bakeBarkGeo(bb.geometry(), '#2a2232', '#4a3a48', '#7a6878', '#78d8ff');
    const snowGeo = bakeLeafGeo(lb.geometry(), '#2e5874', '#e8f6ff', '#ffffff', '#88ecff');
    const parts = [
      { geo: barkGeo, color: '#ffffff' },
      { geo: snowGeo, color: '#ffffff' },
    ];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.2;
      const cr = crystal(0.22, 1.1 + (i % 2) * 0.4, '#70d8ff', '#f0fcff');
      cr.rotateZ((i % 2 === 0 ? 1 : -1) * 0.28);
      cr.rotateY(a);
      cr.translate(Math.cos(a) * 0.85, 0.2, Math.sin(a) * 0.85);
      parts.push({ geo: cr, color: '#ffffff' });
    }
    writeFile('World/Celandia/Doodads/FrostbellSnowFir.m2', buildProceduralPartsGlb(parts, 'static'));
  }

  // 5. GlasswakeCrystalTree.m2 — Celandia `species.js` `glasstree` + fluted Blooming Saguaro (`cactus`)!
  {
    const r = rng(505);
    const parts = [];
    // Recursive Celandia crystal tree (`species.js` `glasstree`)
    const arr = [];
    const branch = (base, dir, len, rad, depth) => {
      floraCrystal(arr, base, dir, len, rad, r.next());
      if (depth <= 0) return;
      const tip = base.clone().addScaledVector(dir, len * 0.85);
      for (let k = 0; k < (depth > 1 ? 3 : 4); k++) {
        const d = dir.clone().add(V(r.range(-0.9, 0.9), r.range(-0.1, 0.6), r.range(-0.9, 0.9))).normalize();
        branch(tip, d, len * r.range(0.52, 0.72), rad * 0.62, depth - 1);
      }
    };
    branch(V(0, -0.2, 0), V(0, 1, 0), 4.2, 0.54, 2);
    const glassTreeGeo = new THREE.BufferGeometry();
    glassTreeGeo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    glassTreeGeo.computeVertexNormals();
    paintVerticalGradient(glassTreeGeo, '#36cfc2', '#ffd0f0');
    parts.push({ geo: glassTreeGeo, color: '#ffffff' });

    // Companion fluted Blooming Saguaro Cactus (`species.js` `cactus`)
    const bb = new BarkBuilder();
    const fb = new LeafBuilder();
    const cH = 4.8;
    const baseR = 0.36;
    const flutedRadius = r0 => (s, ang, out) => {
      const rib = Math.cos(ang * 10) * 0.12;
      out.v = rib;
      return r0 * (1 + rib) * Math.pow(Math.sin(Math.PI * Math.min(1, s * 0.85 + 0.15)), 0.35);
    };
    floraSweep(bb, {
      a: V(1.65, -0.15, 0.4),
      c: V(1.68, cH * 0.5, 0.4),
      b: V(1.65, cH, 0.4),
      rings: 12,
      seg: 18,
      ground: 0,
      cap: true,
      radius: flutedRadius(baseR),
    });
    for (const [dirX, dirZ, attachY, armTopY] of [[1, 0.2, 2.1, 3.9], [-0.8, -0.4, 2.5, 4.1]]) {
      const reach = 0.95;
      floraSweep(bb, {
        a: V(1.65 + dirX * baseR * 0.55, attachY, 0.4 + dirZ * baseR * 0.55),
        c: V(1.65 + dirX * reach * 1.15, attachY + 0.18, 0.4 + dirZ * reach * 1.15),
        b: V(1.65 + dirX * reach, armTopY, 0.4 + dirZ * reach),
        rings: 10,
        seg: 16,
        ground: 0,
        cap: true,
        radius: flutedRadius(baseR * 0.74),
      });
    }
    for (const tip of [V(1.65, cH - 0.04, 0.4), V(1.65 + 0.95, 3.86, 0.59), V(1.65 - 0.76, 4.06, 0.02)]) {
      for (let k = 0; k < 8; k++) {
        broadLeaf(fb, r, {
          base: tip,
          az: (k / 8) * TAU,
          elev: 32 * D2R,
          length: 0.38,
          width: 0.18,
          curl: -18 * D2R,
          fold: 0.42,
          cup: 1.2,
          stalk: 0.04,
          wave: 0.04,
          tone: 1.05,
        }, 7, 4);
      }
    }
    const cactusStemGeo = bakeBarkGeo(bb.geometry(), '#185438', '#287e56', '#62c47e', '#e8d084');
    const cactusBloomGeo = bakeLeafGeo(fb.geometry(), '#ff3d88', '#ffe27a', '#ffb8d8', '#ffffff');
    parts.push({ geo: cactusStemGeo, color: '#ffffff' }, { geo: cactusBloomGeo, color: '#ffffff' });
    writeFile('World/Celandia/Doodads/GlasswakeCrystalTree.m2', buildProceduralPartsGlb(parts, 'static'));
  }

  // 6. AureateCypress.m2 — Dryad Golden Maple/Oak (`maple` preset) + Celandia `species.js` `lamptree`
  //    with 6 hanging glowing golden lanterns!
  {
    const dryadGold = buildDryadSpeciesParts('maple', 6061, 11.4, {
      barkColor: [0.42, 0.30, 0.20],
      foliageColor: [0.96, 0.76, 0.24],
      foliageColorVar: 0.14,
    });
    const parts = [
      { geo: dryadGold.barkGeo, color: '#ffffff' },
      { geo: dryadGold.foliageGeo, color: '#ffffff' },
    ];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.4;
      const rad = 2.1 + (i % 2) * 0.55;
      const ly = 4.2 + (i % 3) * 0.85;
      const lx = Math.cos(a) * rad;
      const lz = Math.sin(a) * rad;
      const cap = latheGeo([[0.01, 0.24], [0.22, 0.14], [0.26, 0.08], [0.02, 0.06]], 8);
      paintVerticalGradient(cap, '#8c6228', '#ffd868');
      cap.translate(lx, ly + 0.22, lz);
      const globe = organicLobe(0.16, 0.22, 0.16, 10, null, '#fffce0', '#ffaa28');
      globe.translate(lx, ly, lz);
      parts.push({ geo: cap, color: '#ffffff' }, { geo: globe, color: '#ffffff' });
    }
    writeFile('World/Celandia/Doodads/AureateCypress.m2', buildProceduralPartsGlb(parts, 'static'));
  }

  // 7. NocturnumObsidianSpire.m2 — Dryad Gnarled Dark-Fae Deadwood Tree + Sculpted Obsidian Crystal Spires
  {
    const dryadDark = buildDryadSpeciesParts('willow', 9091, 10.5, {
      barkColor: [0.18, 0.12, 0.26],
      foliageColor: [0.68, 0.28, 0.88],
      foliageColorVar: 0.16,
    });
    const parts = [
      { geo: dryadDark.barkGeo, color: '#ffffff' },
      { geo: dryadDark.foliageGeo, color: '#ffffff' },
    ];
    const r = rng(707);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      const main = k === 0;
      const sh = main ? 9.6 : 3.6 + r() * 3.2;
      const sr = main ? 0.85 : 0.38 + r() * 0.25;
      const cr = crystal(sr, sh, '#1e1230', k % 2 === 0 ? '#b854ff' : '#ff4ca8');
      if (!main) {
        cr.rotateZ(0.24 + r() * 0.25);
        cr.rotateY(a);
        cr.translate(Math.cos(a) * 1.15, 0, Math.sin(a) * 1.15);
      }
      parts.push({ geo: cr, color: '#ffffff' });
    }
    writeFile('World/Celandia/Doodads/NocturnumObsidianSpire.m2', buildProceduralPartsGlb(parts, 'static'));
  }

  // 8. Upgrade the 10 Ground Clutter Models (`World/NoDXT/Detail/*.m2`) with Celandia `species.js` & Dryad 3D Cupped Flora!
  // 8a. PorcelainFern.m2 — Celandia `fernClump` (9 arching pinnate fronds)
  {
    const lb = new LeafBuilder();
    fernClump(lb, rng(801), V(0, -0.04, 0), 0, 9, 0.78, 180);
    const fg = bakeLeafGeo(lb.geometry(), '#1c5838', '#78dc98', '#c8f8a8', '#68f0ff');
    writeFile('World/NoDXT/Detail/PorcelainFern.m2', buildProceduralPartsGlb([{ geo: fg, color: '#ffffff' }], 'static'));
  }
  // 8b. PorcelainGrassTuft.m2 — Celandia `leafBush` + `broadLeaf` meadow tuft
  {
    const lb = new LeafBuilder();
    leafBush(lb, rng(802), V(0, -0.04, 0), 0.58, 9);
    const fg = bakeLeafGeo(lb.geometry(), '#286c48', '#8ae89c', '#d8f898', null);
    writeFile('World/NoDXT/Detail/PorcelainGrassTuft.m2', buildProceduralPartsGlb([{ geo: fg, color: '#ffffff' }], 'static'));
  }
  // 8c. PorcelainWildflower.m2 & AureateSunflower.m2 — Celandia `leafBush` + 3D 6-petal cupped blossoms
  for (const [fname, seedOff, pCol, tCol] of [
    ['PorcelainWildflower', 1, '#ff78b0', '#ffdef0'],
    ['AureateSunflower', 2, '#ffa828', '#fff4a8'],
  ]) {
    const r = rng(810 + seedOff);
    const lb = new LeafBuilder();
    leafBush(lb, r, V(0, -0.04, 0), 0.46, 8);
    const bush = bakeLeafGeo(lb.geometry(), '#246040', '#68c488', '#b8f098', null);
    const parts = [{ geo: bush, color: '#ffffff' }];
    for (let f = 0; f < 5; f++) {
      const a = (f / 5) * TAU + r() * 0.4;
      const rad = f === 0 ? 0.03 : 0.20 + r() * 0.14;
      const fx = Math.cos(a) * rad;
      const fz = Math.sin(a) * rad;
      const fy = 0.32 + (f === 0 ? 0.12 : r() * 0.10);
      for (let p = 0; p < 6; p++) {
        const pa = (p / 6) * TAU + f * 0.3;
        const pet = cuppedPetalGeo(0.16, 0.10, 0.03, -0.02, 0.010, 4, 5);
        paintVerticalGradient(pet, pCol, tCol);
        pet.rotateX(-0.45);
        pet.rotateY(pa);
        pet.translate(fx, fy, fz);
        parts.push({ geo: pet, color: '#ffffff' });
      }
      const center = organicLobe(0.045, 0.035, 0.045, 8, null, '#fff6a8', '#8a4818');
      center.translate(fx, fy + 0.02, fz);
      parts.push({ geo: center, color: '#ffffff' });
    }
    writeFile(`World/NoDXT/Detail/${fname}.m2`, buildProceduralPartsGlb(parts, 'static'));
  }
  // 8d. FrostbellSnowTuft.m2 — Celandia `species.js` `bell` (arching stem with hanging glowing cyan bellflower + snow basal leaves)
  {
    const r = rng(820);
    const bb = new BarkBuilder();
    const lb = new LeafBuilder();
    const h = 0.82;
    const top = V(0.24, h, 0);
    floraSweep(bb, {
      a: V(0, -0.05, 0),
      c: V(0.06, h * 1.15, 0),
      b: top,
      rings: 8,
      seg: 6,
      ground: 0,
      radius: s => 0.035 * (1 - s * 0.55),
    });
    for (let k = 0; k < 4; k++) {
      broadLeaf(lb, r, {
        base: V(0, -0.04, 0),
        az: (k / 4) * TAU + r.range(-0.2, 0.2),
        elev: 42 * D2R,
        length: 0.42,
        width: 0.16,
        curl: 55 * D2R,
        fold: 0.3,
        stalk: 0.1,
        tone: 1.0,
      }, 8, 4);
    }
    const stemGeo = bakeBarkGeo(bb.geometry(), '#284c5c', '#3e6878', '#88c8e0', '#88f0ff');
    const leafGeo = bakeLeafGeo(lb.geometry(), '#386480', '#dff4ff', '#ffffff', '#88ecff');
    const cup = latheGeo([[0.015, 0.20], [0.08, 0.15], [0.14, 0.05], [0.18, 0.0]], 10);
    paintVerticalGradient(cup, '#ffffff', '#68d4ff');
    cup.translate(0.24, h - 0.19, 0);
    const clapper = organicLobe(0.04, 0.05, 0.04, 8, null, '#fff8c0', '#ffc848');
    clapper.translate(0.24, h - 0.21, 0);
    writeFile('World/NoDXT/Detail/FrostbellSnowTuft.m2', buildProceduralPartsGlb([
      { geo: stemGeo, color: '#ffffff' },
      { geo: leafGeo, color: '#ffffff' },
      { geo: cup, color: '#ffffff' },
      { geo: clapper, color: '#ffffff' },
    ], 'static'));
  }
  // 8e. FrostbellIceCrystal.m2 — Multi-spire Frostbell ice crystal cluster
  {
    const r = rng(821);
    const parts = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      const cr = crystal(k === 0 ? 0.16 : 0.10, k === 0 ? 0.78 : 0.48 + r() * 0.22, '#48b8f0', '#f0fcff');
      if (k > 0) {
        cr.rotateZ(0.28);
        cr.rotateY(a);
        cr.translate(Math.cos(a) * 0.18, 0, Math.sin(a) * 0.18);
      }
      parts.push({ geo: cr, color: '#ffffff' });
    }
    writeFile('World/NoDXT/Detail/FrostbellIceCrystal.m2', buildProceduralPartsGlb(parts, 'static'));
  }
  // 8f. GlasswakeSucculent.m2 — Celandia `species.js` `barrelbloom` (ribbed barrel cactus with 10-petal desert flower)
  {
    const bb = new BarkBuilder();
    const rad = 0.30;
    const h = 0.52;
    floraSweep(bb, {
      a: V(0, -0.05, 0),
      c: V(0, h * 0.5, 0),
      b: V(0, h, 0),
      rings: 8,
      seg: 16,
      ground: 0,
      cap: true,
      radius: (s, ang, out) => {
        const rib = Math.cos(ang * 11) * 0.10;
        out.v = rib;
        return rad * (1 + rib) * Math.pow(Math.sin(Math.PI * Math.min(1, s * 0.88 + 0.12)), 0.42);
      },
    });
    const barrelGeo = bakeBarkGeo(bb.geometry(), '#1c583c', '#2a7a54', '#68c87c', '#e8d084');
    const parts = [{ geo: barrelGeo, color: '#ffffff' }];
    for (let p = 0; p < 10; p++) {
      const pa = (p / 10) * TAU;
      const pet = cuppedPetalGeo(0.20, 0.09, 0.03, 0.02, 0.012, 4, 5);
      paintVerticalGradient(pet, '#ff5488', '#ffeef6');
      pet.rotateX(-0.5);
      pet.rotateY(pa);
      pet.translate(0, h + 0.02, 0);
      parts.push({ geo: pet, color: '#ffffff' });
    }
    writeFile('World/NoDXT/Detail/GlasswakeSucculent.m2', buildProceduralPartsGlb(parts, 'static'));
  }
  // 8g. AureateGoldenWheat.m2 — Golden Aureate plume fern & sun-fronds
  {
    const lb = new LeafBuilder();
    fernClump(lb, rng(840), V(0, -0.04, 0), 0, 8, 0.72, 180);
    const g = bakeLeafGeo(lb.geometry(), '#a8741c', '#f4c848', '#fff4a8', '#ffffff');
    writeFile('World/NoDXT/Detail/AureateGoldenWheat.m2', buildProceduralPartsGlb([{ geo: g, color: '#ffffff' }], 'static'));
  }
  // 8h. NocturnumGlowShroom.m2 — Bioluminescent Nocturnum tiered mushroom cluster
  {
    const parts = [];
    const specs = [
      { x: 0, z: 0, h: 0.62, r: 0.28, top: '#df78ff', bot: '#4a1c78' },
      { x: 0.22, z: 0.14, h: 0.42, r: 0.20, top: '#68f0ff', bot: '#1c5878' },
      { x: -0.20, z: 0.12, h: 0.34, r: 0.16, top: '#ff68c8', bot: '#581c58' },
    ];
    for (const s of specs) {
      const stem = taperedTubeGeo(
        [[s.x, 0, s.z], [s.x * 1.1, s.h * 0.5, s.z * 1.1], [s.x * 1.15, s.h, s.z * 1.15]],
        8, 8,
        t => s.r * (0.28 - t * 0.10)
      );
      paintVerticalGradient(stem, '#241838', '#d8c8f0');
      const cap = latheGeo([
        [0.01, s.r * 0.52],
        [s.r * 0.55, s.r * 0.42],
        [s.r * 0.95, s.r * 0.15],
        [s.r * 1.05, 0.0],
        [s.r * 0.30, -0.04],
      ], 14);
      paintVerticalGradient(cap, s.bot, s.top);
      cap.translate(s.x * 1.15, s.h, s.z * 1.15);
      parts.push({ geo: stem, color: '#ffffff' }, { geo: cap, color: '#ffffff' });
    }
    writeFile('World/NoDXT/Detail/NocturnumGlowShroom.m2', buildProceduralPartsGlb(parts, 'static'));
  }
  // 8i. NocturnumVioletMoss.m2 — Nocturnum `broadLeaf` glowleaf rosette in twilight violet & bioluminescent magenta
  {
    const r = rng(850);
    const lb = new LeafBuilder();
    for (let k = 0; k < 6; k++) {
      broadLeaf(lb, r, {
        base: V(0, -0.04, 0),
        az: (k / 6) * TAU + r.range(-0.2, 0.2),
        elev: r.range(42, 68) * D2R,
        length: r.range(0.52, 0.72),
        width: r.range(0.24, 0.34),
        curl: 65 * D2R,
        fold: 0.28,
        stalk: 0.14,
        wave: 0.06,
        tone: 1.05,
      }, 12, 6);
    }
    const g = bakeLeafGeo(lb.geometry(), '#321456', '#c858ff', '#78f0ff', '#ff88e8');
    writeFile('World/NoDXT/Detail/NocturnumVioletMoss.m2', buildProceduralPartsGlb([{ geo: g, color: '#ffffff' }], 'static'));
  }
}

// ============================================================================
// 4. Sculpted Celandia Fauna (`display 20..23`)
// ============================================================================

function buildPorcelainHopperParts() {
  const parts = [];
  // Plump sculpted porcelain-rose body with slight pear taper
  const body = organicLobe(0.56, 0.50, 0.64, 16, (v, nx, ny, nz) => {
    v.x *= 1 - ny * 0.14;
    v.z += ny * 0.05;
  }, '#ffd0e4', '#e882a8');
  body.translate(0, 0.52, 0);
  parts.push({ geo: body, color: '#ffffff' });

  // Warm cream porcelain belly & inflated vocal throat sac
  const belly = organicLobe(0.44, 0.36, 0.48, 14, null, '#fffcf2', '#f4dec4');
  belly.translate(0, 0.40, 0.22);
  const sac = organicLobe(0.32, 0.24, 0.30, 12, null, '#fff8ee', '#ffd8e6');
  sac.translate(0, 0.58, 0.44);
  parts.push({ geo: belly, color: '#ffffff' }, { geo: sac, color: '#ffffff' });

  // Sculpted muscular hind haunches, calves, and 3-toed webbed feet
  for (const s of [-1, 1]) {
    const thigh = organicLobe(0.22, 0.32, 0.34, 12, null, '#f59ab8', '#c86488');
    thigh.rotateZ(s * -0.25);
    thigh.translate(s * 0.48, 0.34, -0.14);
    parts.push({ geo: thigh, color: '#ffffff' });

    for (let t = -1; t <= 1; t++) {
      const toe = taperedTubeGeo(
        [[s * 0.48 + t * 0.07, 0.10, -0.05], [s * 0.50 + t * 0.11, 0.04, 0.26], [s * 0.52 + t * 0.14, 0.02, 0.46]],
        6, 6,
        u => 0.055 * (1 - u * 0.55)
      );
      paintVerticalGradient(toe, '#e89868', '#ffd4a8');
      parts.push({ geo: toe, color: '#ffffff' });
    }
    // Forelegs
    const fore = taperedTubeGeo(
      [[s * 0.30, 0.42, 0.32], [s * 0.34, 0.20, 0.42], [s * 0.36, 0.03, 0.50]],
      6, 7,
      u => 0.085 * (1 - u * 0.35)
    );
    paintVerticalGradient(fore, '#e882a8', '#ffd0e4');
    parts.push({ geo: fore, color: '#ffffff' });
  }

  // Expressive glossy eyes with gold iris rings, dark pupils, white catchlights & rosy cheeks
  for (const s of [-1, 1]) {
    const socket = organicLobe(0.14, 0.15, 0.14, 12, null, '#ffd8ea', '#e888b0');
    socket.translate(s * 0.24, 0.86, 0.36);
    const iris = organicLobe(0.105, 0.115, 0.10, 10, null, '#ffd868', '#b87820');
    iris.translate(s * 0.25, 0.87, 0.42);
    const pupil = organicLobe(0.08, 0.09, 0.07, 10, null, '#241428', '#0e0812');
    pupil.translate(s * 0.26, 0.87, 0.46);
    const spec = organicLobe(0.032, 0.032, 0.025, 8, null, '#ffffff', '#ffffff');
    spec.translate(s * 0.28, 0.91, 0.51);
    const cheek = organicLobe(0.09, 0.06, 0.06, 8, null, '#ff6898', '#ff98b8');
    cheek.translate(s * 0.34, 0.68, 0.46);
    parts.push(
      { geo: socket, color: '#ffffff' },
      { geo: iris, color: '#ffffff' },
      { geo: pupil, color: '#ffffff' },
      { geo: spec, color: '#ffffff' },
      { geo: cheek, color: '#ffffff' }
    );

    // Long sculpted cupped porcelain-and-gilt bunny/fae ears
    const ear = cuppedPetalGeo(0.68, 0.24, 0.06, -0.08, 0.035, 6, 8);
    paintVerticalGradient(ear, '#f59ab8', '#ffffff');
    ear.rotateX(-1.15);
    ear.rotateZ(s * -0.32);
    ear.translate(s * 0.20, 0.92, 0.05);
    parts.push({ geo: ear, color: '#ffffff' });
  }

  // Puff tail & gilt crown crest
  const tail = organicLobe(0.18, 0.18, 0.20, 10, null, '#ffffff', '#ffd8ea');
  tail.translate(0, 0.48, -0.62);
  parts.push({ geo: tail, color: '#ffffff' });

  return parts;
}

function buildWoollyDrifterParts() {
  const parts = [];
  // Main settled cloud-fleece coat + 12 overlapping sculpted wool puffs (`fauna.js`)
  const core = organicLobe(1.05, 0.88, 1.32, 16, (v, nx, ny, nz) => {
    v.y += Math.sin(nx * 5) * 0.04 + Math.cos(nz * 5) * 0.04;
  }, '#ffffff', '#dcd4f0');
  core.translate(0, 1.08, 0);
  parts.push({ geo: core, color: '#ffffff' });

  const puffCoords = [
    [0, 1.52, 0.35, 0.58, 0.48, 0.58],
    [0, 1.48, -0.35, 0.62, 0.48, 0.62],
    [-0.62, 1.22, 0.28, 0.52, 0.46, 0.54],
    [0.62, 1.22, 0.28, 0.52, 0.46, 0.54],
    [-0.64, 1.18, -0.32, 0.54, 0.46, 0.54],
    [0.64, 1.18, -0.32, 0.54, 0.46, 0.54],
    [0, 1.32, 0.82, 0.52, 0.45, 0.48],
    [0, 1.16, -0.95, 0.48, 0.42, 0.46],
    [-0.42, 0.82, 0.65, 0.42, 0.36, 0.42],
    [0.42, 0.82, 0.65, 0.42, 0.36, 0.42],
  ];
  for (const [px, py, pz, rx, ry, rz] of puffCoords) {
    const puff = organicLobe(rx, ry, rz, 12, null, '#ffffff', '#e4dcf8');
    puff.translate(px, py, pz);
    parts.push({ geo: puff, color: '#ffffff' });
  }

  // Sculpted slate-plum head & muzzle
  const head = organicLobe(0.38, 0.34, 0.44, 14, (v, nx, ny, nz) => {
    if (nz > 0) { v.x *= 0.82; v.y *= 0.85; }
  }, '#6e5c82', '#463858');
  head.translate(0, 1.16, 1.22);
  parts.push({ geo: head, color: '#ffffff' });

  // Spiraled Frostbell crystalline ram horns + ears + glowing amber eyes
  for (const s of [-1, 1]) {
    const hornPts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const a = t * Math.PI * 1.65;
      hornPts.push([
        s * (0.24 + t * 0.42 + Math.sin(a) * 0.14),
        1.38 + Math.cos(a) * 0.26 * (1 - t * 0.3),
        1.08 - Math.sin(a) * 0.28,
      ]);
    }
    const horn = taperedTubeGeo(hornPts, 16, 8, t => 0.13 * (1 - t * 0.78));
    paintVerticalGradient(horn, '#68d4ff', '#f0fcff');
    parts.push({ geo: horn, color: '#ffffff' });

    const ear = cuppedPetalGeo(0.34, 0.16, 0.04, -0.05, 0.02, 5, 6);
    paintVerticalGradient(ear, '#584868', '#f2e8ff');
    ear.rotateZ(s * 1.15);
    ear.translate(s * 0.32, 1.18, 1.05);
    const eye = organicLobe(0.065, 0.065, 0.05, 8, null, '#ffe888', '#d88820');
    eye.translate(s * 0.26, 1.22, 1.42);
    parts.push({ geo: ear, color: '#ffffff' }, { geo: eye, color: '#ffffff' });
  }

  // 4 Articulated legs with wool cuffs & cloven hooves
  for (const sx of [-0.46, 0.46]) {
    for (const sz of [-0.52, 0.52]) {
      const leg = taperedTubeGeo([[sx, 0.75, sz], [sx, 0.38, sz + 0.03], [sx, 0.08, sz + 0.05]], 8, 8, t => 0.15 * (1 - t * 0.28));
      paintVerticalGradient(leg, '#3a2e4a', '#6e5c82');
      const hoof = latheGeo([[0.01, 0.14], [0.13, 0.12], [0.16, 0.0]], 10);
      paintVerticalGradient(hoof, '#241c30', '#4a3c5c');
      hoof.translate(sx, 0, sz + 0.05);
      parts.push({ geo: leg, color: '#ffffff' }, { geo: hoof, color: '#ffffff' });
    }
  }

  return parts;
}

function buildGlassSkimmerParts() {
  const parts = [];
  // Sinuous S-curved drake-lizard body & long whip tail (`taperedTubeGeo`)
  const spinePts = [
    [0, 0.58, 1.25],
    [0, 0.56, 0.85],
    [0.06, 0.52, 0.30],
    [-0.06, 0.48, -0.35],
    [0.08, 0.42, -1.05],
    [-0.05, 0.36, -1.75],
    [0, 0.32, -2.35],
  ];
  const body = taperedTubeGeo(
    spinePts,
    28, 12,
    t => {
      if (t < 0.12) return 0.16 + Math.sin((t / 0.12) * Math.PI) * 0.14;
      if (t < 0.45) return 0.34 * Math.sin(((t - 0.05) / 0.45) * Math.PI * 0.85);
      return 0.28 * Math.pow(1 - (t - 0.45) / 0.55, 1.35);
    },
    1.18, 0.82
  );
  paintVerticalGradient(body, '#fff0c8', '#e87848');
  parts.push({ geo: body, color: '#ffffff' });

  // Translucent turquoise-and-rose Glasswake dorsal sail fin spines + webbed fin
  for (let i = 0; i < 9; i++) {
    const u = i / 8;
    const z = 0.65 - u * 1.65;
    const h = Math.sin(u * Math.PI) * 0.62 + 0.18;
    const sail = cuppedPetalGeo(h, 0.22, 0.03, -0.06, 0.02, 4, 6);
    paintVerticalGradient(sail, '#e87848', i % 2 === 0 ? '#48f0e0' : '#ff78c8');
    sail.rotateX(-1.22 - u * 0.25);
    sail.translate(0, 0.58, z);
    parts.push({ geo: sail, color: '#ffffff' });
  }

  // Head crest & glowing turquoise eyes
  for (const s of [-1, 1]) {
    const frill = cuppedPetalGeo(0.45, 0.22, 0.04, 0.04, 0.02, 4, 6);
    paintVerticalGradient(frill, '#ff9858', '#48f0e0');
    frill.rotateX(-1.35);
    frill.rotateY(s * -0.42);
    frill.translate(s * 0.18, 0.64, 0.92);
    const eye = organicLobe(0.06, 0.06, 0.07, 8, null, '#68fff0', '#187878');
    eye.translate(s * 0.20, 0.64, 1.08);
    parts.push({ geo: frill, color: '#ffffff' }, { geo: eye, color: '#ffffff' });
  }

  // 4 Splayed agile lizard legs with 3 claws each
  for (const s of [-1, 1]) {
    for (const [zOff, spread] of [[0.48, 0.52], [-0.32, 0.58]]) {
      const leg = taperedTubeGeo(
        [[s * 0.22, 0.45, zOff], [s * spread, 0.28, zOff + 0.08], [s * (spread + 0.08), 0.04, zOff + 0.18]],
        8, 7,
        t => 0.10 * (1 - t * 0.45)
      );
      paintVerticalGradient(leg, '#c85830', '#f4a868');
      parts.push({ geo: leg, color: '#ffffff' });
    }
  }

  return parts;
}

function buildSkyMantaParts() {
  const parts = [];
  // Central streamlined disc body (dorsal twilight-violet, ventral porcelain-rose)
  const disc = organicLobe(0.75, 0.22, 0.95, 16, (v, nx, ny, nz) => {
    if (ny < 0) v.y *= 0.65;
  }, '#9a7cf0', '#ffe4f2');
  disc.translate(0, 1.45, 0.10);
  parts.push({ geo: disc, color: '#ffffff' });

  // Swept airfoil manta wings (`cuppedPetalGeo`) with graceful gull-wing camber
  for (const s of [-1, 1]) {
    const wing = cuppedPetalGeo(1.85, 1.35, 0.16, -0.18, 0.05, 8, 12);
    paintVerticalGradient(wing, '#ffd8ec', '#7c62d8');
    wing.rotateY(s * (Math.PI * 0.5 - 0.18));
    wing.rotateZ(s * 0.12);
    wing.translate(s * 0.35, 1.44, 0.05);
    parts.push({ geo: wing, color: '#ffffff' });

    // Cephalic horn-fins framing the mouth
    const horn = cuppedPetalGeo(0.52, 0.22, 0.06, 0.08, 0.025, 5, 6);
    paintVerticalGradient(horn, '#ffe4f2', '#78f4e8');
    horn.rotateZ(s * 0.65);
    horn.translate(s * 0.32, 1.42, 0.88);
    parts.push({ geo: horn, color: '#ffffff' });

    // Bioluminescent dorsal cyan/gold spots along each wing
    for (let k = 0; k < 4; k++) {
      const spot = organicLobe(0.11 - k * 0.015, 0.03, 0.09 - k * 0.01, 8, null, '#98fff4', '#58b8ff');
      spot.translate(s * (0.55 + k * 0.32), 1.54 - k * 0.02, 0.18 - k * 0.12);
      parts.push({ geo: spot, color: '#ffffff' });
    }
  }

  // Long ribbon whip tail with glowing star-diamond finial
  const tail = taperedTubeGeo(
    [[0, 1.44, -0.75], [0, 1.40, -1.45], [0, 1.46, -2.15], [0, 1.52, -2.75]],
    14, 8,
    t => 0.11 * (1 - t * 0.78)
  );
  paintVerticalGradient(tail, '#7c62d8', '#88fff0');
  const finial = crystal(0.16, 0.55, '#68e8ff', '#ffffff');
  finial.rotateX(Math.PI * 0.5);
  finial.translate(0, 1.52, -2.95);
  parts.push({ geo: tail, color: '#ffffff' }, { geo: finial, color: '#ffffff' });

  return parts;
}

// ============================================================================
// 5. Moonlight Lava Dragon (`ObsidianColossus.m2`, display 24)
//    Ported directly from `Celandia/docs/elsewhere-tide/game/realms-art-wave8.js`
//    (`ignis-nocturne` / `cinder-scale`, lines 1240–1690)
// ============================================================================

function buildMoonlightLavaDragonParts() {
  const parts = [];
  const scaleCol = '#1c1528';
  const scaleHi = '#3d2b56';
  const magmaCol = '#ff5824';
  const magmaHot = '#ffcf58';
  const moonCol = '#88d8ff';

  // 1. Serpentine S-curved muscular dragon body + chest + haunches
  const bodyPts = [
    [0, 1.55, -1.35],
    [0, 1.68, -0.70],
    [0, 1.88, 0.05],
    [0, 2.08, 0.78],
    [0, 2.28, 1.28],
  ];
  const bodyGeo = taperedTubeGeo(
    bodyPts, 24, 14,
    t => {
      const chest = Math.sin(Math.pow(t, 0.75) * Math.PI) * 0.66;
      const waist = (1 - Math.sin(t * Math.PI * 1.4) * 0.15);
      return Math.max(0.24, chest * waist + 0.16);
    },
    1.12, 0.95
  );
  paintVerticalGradient(bodyGeo, magmaCol, scaleHi);
  parts.push({ geo: bodyGeo, color: '#ffffff' });

  // 2. Arched serpentine neck
  const neckPts = [
    [0, 2.20, 1.15],
    [0, 2.58, 1.52],
    [0, 3.05, 1.72],
    [0, 3.45, 1.88],
    [0, 3.68, 2.12],
  ];
  const neckGeo = taperedTubeGeo(neckPts, 18, 12, t => 0.44 * (1 - t * 0.42), 0.95, 1.08);
  paintVerticalGradient(neckGeo, scaleCol, scaleHi);
  parts.push({ geo: neckGeo, color: '#ffffff' });

  // 3. Long whipping tail + 3-lobed tail spade
  const tailPts = [
    [0, 1.55, -1.25],
    [0.14, 1.30, -1.95],
    [0.24, 1.12, -2.70],
    [0.05, 1.04, -3.45],
    [-0.20, 1.16, -4.15],
    [-0.10, 1.38, -4.75],
    [0.08, 1.62, -5.20],
  ];
  const tailGeo = taperedTubeGeo(tailPts, 24, 10, t => Math.max(0.04, 0.40 * Math.pow(1 - t, 1.15)));
  paintVerticalGradient(tailGeo, scaleCol, magmaCol);
  parts.push({ geo: tailGeo, color: '#ffffff' });

  for (let p = -1; p <= 1; p++) {
    const spade = cuppedPetalGeo(p === 0 ? 0.72 : 0.50, p === 0 ? 0.34 : 0.24, 0.05, -0.06, 0.03, 5, 7);
    paintVerticalGradient(spade, magmaCol, magmaHot);
    spade.rotateX(Math.PI + 0.25);
    spade.rotateY(p * 0.52);
    spade.translate(0.08, 1.62, -5.12);
    parts.push({ geo: spade, color: '#ffffff' });
  }

  // 4. 10 Segmented glowing magma belly scutes along throat & chest
  const bellyArchive = [...bodyPts.slice(1), ...neckPts.slice(1, 4)];
  for (let i = 0; i < bellyArchive.length; i++) {
    const [bx, by, bz] = bellyArchive[i];
    const scute = cuppedPetalGeo(0.42, 0.54 - i * 0.03, 0.07, 0.03, 0.035, 5, 6);
    paintVerticalGradient(scute, magmaCol, magmaHot);
    scute.rotateX(Math.PI * 0.45);
    scute.translate(bx, by - 0.34, bz + 0.18);
    parts.push({ geo: scute, color: '#ffffff' });
  }

  // 5. 14 Dorsal moonlight-and-magma crystal spines along neck, back & tail
  const spinePtsAll = [...neckPts.slice(0, 4).reverse(), ...bodyPts.slice().reverse(), ...tailPts.slice(1, 5)];
  for (let i = 0; i < spinePtsAll.length; i++) {
    const [sx, sy, sz] = spinePtsAll[i];
    const h = (i < 8 ? 0.42 + Math.sin((i / 8) * Math.PI) * 0.36 : 0.26);
    const sp = crystal(0.11, h, i % 2 === 0 ? magmaCol : '#4a2878', i % 2 === 0 ? magmaHot : moonCol);
    sp.rotateX(-0.38);
    sp.translate(sx, sy + 0.32, sz);
    parts.push({ geo: sp, color: '#ffffff' });
  }

  // 6. 4 Muscular clawed dragon legs with shoulders, thighs, shins, paws & 12 curved talons
  for (const s of [-1, 1]) {
    // Hind leg
    const hLeg = taperedTubeGeo(
      [[s * 0.54, 1.62, -0.78], [s * 0.68, 1.05, -0.52], [s * 0.62, 0.55, -0.95], [s * 0.64, 0.14, -0.68]],
      12, 9,
      t => 0.32 * (1 - t * 0.45)
    );
    paintVerticalGradient(hLeg, scaleCol, scaleHi);
    // Fore leg
    const fLeg = taperedTubeGeo(
      [[s * 0.58, 1.96, 0.76], [s * 0.68, 1.25, 0.58], [s * 0.64, 0.65, 0.84], [s * 0.64, 0.14, 0.94]],
      12, 9,
      t => 0.28 * (1 - t * 0.42)
    );
    paintVerticalGradient(fLeg, scaleCol, scaleHi);
    parts.push({ geo: hLeg, color: '#ffffff' }, { geo: fLeg, color: '#ffffff' });

    for (const [px, pz] of [[s * 0.64, -0.68], [s * 0.64, 0.94]]) {
      for (let c = -1; c <= 1; c++) {
        const claw = taperedTubeGeo(
          [[px + c * 0.09, 0.14, pz + 0.06], [px + c * 0.12, 0.09, pz + 0.24], [px + c * 0.14, 0.02, pz + 0.38]],
          6, 6,
          t => 0.055 * (1 - t * 0.82)
        );
        paintVerticalGradient(claw, magmaCol, magmaHot);
        parts.push({ geo: claw, color: '#ffffff' });
      }
    }
  }

  // 7. Sculpted Dragon Head: cranium, snout, lower jaw, fangs, glowing eyes, S-curved obsidian horns & ear-frills
  const cranium = organicLobe(0.38, 0.32, 0.46, 14, (v, nx, ny, nz) => {
    if (ny > 0) v.x *= 1.14;
    if (nz > 0) v.x *= 0.84;
  }, scaleHi, scaleCol);
  cranium.translate(0, 3.68, 2.22);
  const snout = organicLobe(0.26, 0.20, 0.48, 14, (v, nx, ny, nz) => {
    v.x *= 1 - Math.max(0, nz) * 0.28;
  }, scaleHi, magmaCol);
  snout.translate(0, 3.62, 2.62);
  const jaw = organicLobe(0.23, 0.13, 0.44, 12, null, magmaCol, scaleCol);
  jaw.rotateX(0.24);
  jaw.translate(0, 3.42, 2.54);
  parts.push({ geo: cranium, color: '#ffffff' }, { geo: snout, color: '#ffffff' }, { geo: jaw, color: '#ffffff' });

  for (const s of [-1, 1]) {
    const eye = organicLobe(0.08, 0.06, 0.09, 8, null, '#ffffff', magmaHot);
    eye.translate(s * 0.28, 3.74, 2.42);
    // Swept S-curved grand obsidian-and-moonlight horns
    const horn = taperedTubeGeo(
      [
        [s * 0.24, 3.84, 2.08],
        [s * 0.42, 4.08, 1.72],
        [s * 0.56, 4.35, 1.28],
        [s * 0.48, 4.65, 0.88],
        [s * 0.36, 4.92, 0.62],
      ],
      14, 8,
      t => 0.14 * (1 - t * 0.82)
    );
    paintVerticalGradient(horn, scaleCol, moonCol);
    // Webbed ear-frill
    const frill = cuppedPetalGeo(0.58, 0.30, 0.05, 0.06, 0.02, 5, 6);
    paintVerticalGradient(frill, magmaCol, moonCol);
    frill.rotateX(-1.15);
    frill.rotateY(s * -0.52);
    frill.translate(s * 0.32, 3.68, 2.05);
    parts.push({ geo: eye, color: '#ffffff' }, { geo: horn, color: '#ffffff' }, { geo: frill, color: '#ffffff' });
  }

  // 8. Grand 4-Fingered Bat-Dragon Wings (`realms-art-wave8.js` lines 1583–1660)
  for (const s of [-1, 1]) {
    const shX = s * 0.52, shY = 2.28, shZ = 0.62;
    const elbX = s * 1.65, elbY = 3.05, elbZ = 0.85;
    const wrX = s * 2.85, wrY = 3.55, wrZ = 0.55;

    const spar = taperedTubeGeo(
      [[shX, shY, shZ], [elbX, elbY, elbZ], [wrX, wrY, wrZ], [s * 4.55, 3.72, -0.15]],
      16, 8,
      t => 0.14 * (1 - t * 0.65)
    );
    paintVerticalGradient(spar, scaleCol, scaleHi);
    parts.push({ geo: spar, color: '#ffffff' });

    const fingers = [
      { tip: [s * 4.65, 3.45, -0.55], len: 2.35, w: 0.95, rotY: s * 1.18, rotZ: s * -0.15, colTop: moonCol, colBot: '#382058' },
      { tip: [s * 3.95, 2.75, -1.05], len: 2.15, w: 0.95, rotY: s * 0.88, rotZ: s * -0.35, colTop: magmaHot, colBot: magmaCol },
      { tip: [s * 2.85, 2.15, -1.25], len: 1.85, w: 0.92, rotY: s * 0.52, rotZ: s * -0.52, colTop: moonCol, colBot: '#2a1844' },
      { tip: [s * 1.65, 1.78, -1.15], len: 1.55, w: 0.85, rotY: s * 0.22, rotZ: s * -0.62, colTop: magmaHot, colBot: '#4a1838' },
    ];
    for (const fg of fingers) {
      const fRod = taperedTubeGeo([[wrX, wrY, wrZ], fg.tip], 8, 6, t => 0.06 * (1 - t * 0.72));
      paintVerticalGradient(fRod, scaleHi, magmaHot);
      const web = cuppedPetalGeo(fg.len, fg.w, 0.14, -0.08, 0.025, 6, 8);
      paintVerticalGradient(web, fg.colBot, fg.colTop);
      web.rotateX(Math.PI * 0.62);
      web.rotateY(fg.rotY);
      web.rotateZ(fg.rotZ);
      web.translate(wrX * 0.55 + fg.tip[0] * 0.45, wrY * 0.55 + fg.tip[1] * 0.45, wrZ * 0.55 + fg.tip[2] * 0.45);
      parts.push({ geo: fRod, color: '#ffffff' }, { geo: web, color: '#ffffff' });
    }
  }

  return parts;
}

// ============================================================================
// 6. Sculpted & 21-Bone Rigged Celandia Bad Guys (`display 25..30`)
// ============================================================================

/**
 * Build a 21-bone rigged Celandia humanoid enemy (`Hollow`, `AshenKnight`, `BoneLord`, `Wraith`)
 * using Celandia's `ui/cast/` anatomy & garment pipeline (`makeRig`, `faeBody`, `faeHead`, `sweep`, `cover`, `skirtShell`, `wingsDragonfly`).
 */
function buildRiggedCelandiaBadGuy(archetype) {
  const mats = castMod.createMaterials(null);

  if (archetype === 'Hollow') {
    // Nocturnum Shade-Walker: Pale obsidian-violet skin, tattered crimson-and-shadow coat, curved shadow horns & dual daggers
    const R = makeRig('Hollow', mats, { proportions: 'long' });
    R.sizeK = 1.02;
    const B = R.skin;
    const skin = '#8c7ca8';
    const coatCol = '#1e142c';
    const trimCol = '#c83258';

    const { arms, legs } = faeBody(R, {
      skin,
      female: false,
      waist: 0.90,
      armK: 1.02,
      legK: 1.02,
      torsoColor: p => (p.y > 1.62 ? '#2c1e42' : '#181024'),
      handColor: '#584870',
      curl: 0.5,
    });
    for (const s of ['L', 'R']) {
      cover(B, arms[s], 0, 0.85, { grow: 0.018, color: coatCol, outline: 0.003, seg: 5 });
      cover(B, legs[s], 0, 0.92, { grow: 0.020, flare: 0.015, color: '#160e22', outline: 0.003, seg: 6 });
      shoe(R, s, { color: '#100a18', sole: '#2a1838', w: 1.08 });
    }
    // Tattered high-collared Nocturnum shadow coat
    B.add(
      sweep([[0, 2.48, -0.02], [0, 1.92, 0], [0, 0.95, -0.04]], {
        rx: [[0, 0.22], [0.2, 0.28], [0.6, 0.26], [1, 0.38]],
        rz: [[0, 0.15], [0.2, 0.18], [0.6, 0.18], [1, 0.26]],
        arc: [Math.PI / 2 + 0.42, Math.PI / 2 + TAU - 0.42],
        seg: 12,
        rad: 18,
      }),
      null,
      { kind: 'toon2', colorFn: p => mix(coatCol, trimCol, smooth(1.35, 0.95, p.y) * 0.65), bone: 'coat' }
    );
    B.add(band([0, 1.62, 0], { rx: 0.235, rz: 0.165, w: 0.028, d: 0.015 }), trimCol, { bone: 'pelvis' });

    const dims = [0.16, 0.23, 0.18];
    const hd = faeHead(R, {
      skin,
      dims,
      deform: { male: true, chin: 0.22, jaw: 0.95 },
      faceCfg: { eye: '#ff3878', eyeDark: '#12081c', brow: '#2a1838', lip: '#482848', lipLight: '#683868', skinShade: '#685882', smirk: 0.7 },
      ears: { tip: [0.32, 0.10, -0.12], w: 0.042 },
    });
    const H = hd.H;
    hairCap(H, dims, () => C('#181024'), { keep: capKeep(0.55, -0.55) });
    // Curved Nocturnum shadow horns on head
    for (const s of [-1, 1]) {
      H.add(
        sweep([[s * 0.08, 0.18, 0.02], [s * 0.18, 0.34, -0.04], [s * 0.14, 0.50, -0.12]], {
          r: [[0, 0.036], [0.6, 0.022], [1, 0.004]],
          seg: 8,
          rad: 6,
        }),
        trimCol
      );
    }
    // Dual crimson-obsidian daggers in both hands
    for (const s of ['L', 'R']) {
      const hand = R.part(`hand${s}`);
      const hp = R.joints[`hand${s}`].clone();
      hand.add(
        sweep([hp.clone().add(v3(0, -0.04, -0.10)), hp.clone().add(v3(0, -0.04, 0.08)), hp.clone().add(v3(0, -0.02, 0.52))], {
          rx: [[0, 0.018], [0.25, 0.038], [1, 0.003]],
          rz: [[0, 0.018], [0.25, 0.014], [1, 0.002]],
          seg: 8,
          rad: 6,
        }),
        '#ff4888'
      );
    }
    R.finish();
    return { rig: R };
  }

  if (archetype === 'AshenKnight') {
    // Nocturnum Dread-Knight: Heavy basalt-and-gilt plate armor, winged obsidian helm, crimson cape, greatsword & shield
    const R = makeRig('AshenKnight', mats, { proportions: 'long' });
    R.sizeK = 1.14;
    const B = R.skin;
    const armorDark = '#241c34';
    const armorSteel = '#4a3d62';
    const gilt = '#f0b858';
    const crimson = '#b82848';

    const { arms, legs } = faeBody(R, {
      skin: armorSteel,
      female: false,
      waist: 1.08,
      armK: 1.18,
      legK: 1.15,
      thigh: 1.15,
      torsoColor: p => (p.y > 1.65 ? armorSteel : armorDark),
      handColor: armorDark,
      curl: 0.6,
    });
    for (const s of ['L', 'R']) {
      cover(B, arms[s], 0, 0.90, { grow: 0.028, color: armorDark, outline: 0.004, seg: 6 });
      cover(B, legs[s], 0, 0.95, { grow: 0.032, flare: 0.02, color: armorDark, outline: 0.004, seg: 6 });
      shoe(R, s, { color: armorSteel, sole: gilt, w: 1.18 });
      // Sculpted Pauldrons on upper shoulders
      const shSign = s === 'L' ? 1 : -1;
      B.add(ell([shSign * 0.28, 2.34, 0], [0.16, 0.14, 0.16], { rot: [0, 0, shSign * -0.35] }), armorSteel, { bone: `uarm${s}` });
      B.add(band([shSign * 0.28, 2.30, 0], { rx: 0.165, rz: 0.165, w: 0.022, d: 0.014, tilt: [0, 0, shSign * -0.35] }), gilt, { bone: `uarm${s}` });
    }
    // Cuirass breastplate + gilt trim + sweeping crimson cape + armored tassets
    B.add(ell([0, 2.08, 0.03], [0.26, 0.28, 0.19]), armorSteel, { bone: 'chest' });
    B.add(band([0, 1.66, 0], { rx: 0.25, rz: 0.18, w: 0.035, d: 0.02 }), gilt, { bone: 'pelvis' });
    skirtShell(B, {
      y0: 1.66,
      y1: 0.92,
      r0: [0.24, 0.17],
      r1: [0.36, 0.28],
      colorFn: p => mix(crimson, '#180c24', smooth(1.6, 0.92, p.y) * 0.45),
      bone: 'gown',
      wav: 0.04,
    });
    // Full-length royal crimson-and-obsidian cape
    B.add(
      sweep([[0, 2.42, -0.14], [0, 1.65, -0.24], [0, 0.35, -0.32]], {
        rx: [[0, 0.22], [0.5, 0.38], [1, 0.52]],
        rz: 0.025,
        seg: 10,
        rad: 8,
      }),
      crimson,
      { kind: 'toon2', bone: 'coat' }
    );

    const dims = [0.17, 0.24, 0.19];
    const hd = faeHead(R, {
      skin: '#1a1226',
      dims,
      deform: { male: true, chin: 0.26, jaw: 1.08 },
      faceCfg: { eye: '#ffaa38', eyeDark: '#ff3820', brow: gilt, lip: '#1a1226', lipLight: '#2a1c38', skinShade: '#120c1c' },
      ears: { tip: [0.20, 0.05, -0.08], w: 0.03 },
    });
    const H = hd.H;
    // Winged Great-Helm
    H.add(headCap(dims, 1.12, () => true, {}), armorSteel);
    H.add(band([0, 0.04, 0.02], { rx: 0.185, rz: 0.20, w: 0.032, d: 0.018 }), gilt);
    for (const s of [-1, 1]) {
      H.add(
        sweep([[s * 0.16, 0.08, 0], [s * 0.28, 0.28, -0.08], [s * 0.34, 0.54, -0.18]], {
          rx: [[0, 0.025], [0.5, 0.06], [1, 0.01]],
          rz: [[0, 0.08], [0.5, 0.12], [1, 0.02]],
          seg: 8,
          rad: 6,
        }),
        gilt
      );
    }
    // Runed Greatsword in Right Hand + Tower Aegis in Left Hand
    const RH = R.part('handR');
    const rp = R.joints.handR.clone();
    RH.add(
      sweep([rp.clone().add(v3(0, -0.04, -0.22)), rp.clone().add(v3(0, -0.04, 0.08)), rp.clone().add(v3(0, -0.04, 1.18))], {
        rx: [[0, 0.022], [0.22, 0.065], [0.85, 0.048], [1, 0.004]],
        rz: [[0, 0.022], [0.22, 0.020], [1, 0.003]],
        seg: 10,
        rad: 6,
      }),
      gilt
    );
    const LH = R.part('handL');
    const lp = R.joints.handL.clone();
    LH.add(ell([lp.x - 0.06, lp.y, lp.z + 0.08], [0.04, 0.38, 0.26]), armorSteel);
    LH.add(band([lp.x - 0.06, lp.y, lp.z + 0.08], { rx: 0.045, rz: 0.27, w: 0.04, d: 0.02 }), gilt);

    R.finish();
    return { rig: R };
  }

  if (archetype === 'BoneLord') {
    // Nocturnum Eclipse Sovereign: Tall bone-and-obsidian lich king with floating Eclipse Blood-Moon Halo & soul staff
    const R = makeRig('BoneLord', mats, { proportions: 'long' });
    R.sizeK = 1.22;
    const B = R.skin;
    const boneIvory = '#f2ead8';
    const robeObsidian = '#160e24';
    const eclipseViolet = '#9838ff';
    const bloodGold = '#ffb848';

    const { arms } = faeBody(R, {
      skin: boneIvory,
      female: false,
      waist: 0.82,
      armK: 0.92,
      legK: 0.95,
      torsoColor: p => (p.y > 1.65 ? '#26183c' : robeObsidian),
      handColor: boneIvory,
      curl: 0.35,
    });
    for (const s of ['L', 'R']) {
      cover(B, arms[s], 0, 0.88, { grow: 0.024, flare: 0.045, color: robeObsidian, outline: 0.003, seg: 6 });
    }
    // Sculpted bone ribcage filigree over chest + floor-length sovereign robes
    for (let r = 0; r < 4; r++) {
      B.add(band([0, 2.24 - r * 0.11, 0.02], { rx: 0.22 - r * 0.012, rz: 0.16, w: 0.022, d: 0.015 }), boneIvory, { bone: 'chest' });
    }
    skirtShell(B, {
      y0: 1.68,
      y1: 0.08,
      r0: [0.23, 0.17],
      r1: [0.54, 0.46],
      colorFn: p => mix(robeObsidian, eclipseViolet, smooth(0.85, 0.08, p.y) * 0.55),
      bone: 'gown',
      wav: 0.08,
    });
    // Floating Eclipse Halo Ring behind the shoulders (`realms-art-wave8.js` style)
    B.add(band([0, 2.55, -0.22], { rx: 0.58, rz: 0.58, w: 0.045, d: 0.025, tilt: [Math.PI * 0.5, 0, 0] }), bloodGold, { bone: 'chest' });
    B.add(band([0, 2.55, -0.22], { rx: 0.48, rz: 0.48, w: 0.030, d: 0.018, tilt: [Math.PI * 0.5, 0, 0] }), eclipseViolet, { bone: 'chest' });

    const dims = [0.16, 0.24, 0.18];
    const hd = faeHead(R, {
      skin: boneIvory,
      dims,
      deform: { male: true, chin: 0.20, jaw: 0.88 },
      faceCfg: { eye: '#68f8ff', eyeDark: '#120824', brow: '#3a2848', lip: '#2a1c38', lipLight: '#4a3458', skinShade: '#cfc2ac' },
      ears: { tip: [0.30, 0.08, -0.10], w: 0.035 },
    });
    const H = hd.H;
    // 5-Spire Sovereign Bone & Gold Crown
    H.add(band([0, 0.16, 0], { rx: 0.175, rz: 0.19, w: 0.035, d: 0.018 }), bloodGold);
    for (let k = -2; k <= 2; k++) {
      const a = k * 0.42;
      const sx = Math.sin(a) * 0.16;
      const sz = Math.cos(a) * 0.17;
      H.add(
        sweep([[sx, 0.18, sz], [sx * 1.15, 0.44 + (2 - Math.abs(k)) * 0.08, sz * 1.05]], {
          r: [[0, 0.024], [1, 0.003]],
          seg: 6,
          rad: 5,
        }),
        k === 0 ? eclipseViolet : bloodGold
      );
    }
    // Sovereign Soul-Staff in Right Hand
    const RH = R.part('handR');
    const rp = R.joints.handR.clone();
    RH.add(
      sweep([rp.clone().add(v3(0, -0.04, -0.55)), rp.clone().add(v3(0, -0.04, 1.25))], { r: 0.024, seg: 8, rad: 6 }),
      boneIvory
    );
    RH.add(ell([rp.x, rp.y - 0.04, rp.z + 1.38], [0.14, 0.14, 0.18]), eclipseViolet);

    R.finish();
    return { rig: R };
  }

  // Wraith: Elsewhere Lantern Wraith — Spectral Banshee with luminous dragonfly wings, veiled gown & floating lantern
  const R = makeRig('Wraith', mats, { proportions: 'fashion' });
  R.sizeK = 1.06;
  const B = R.skin;
  const spectralSkin = '#d8f6ff';
  const veilCyan = '#58d8f0';
  const deepIndigo = '#241848';

  const { arms } = faeBody(R, {
    skin: spectralSkin,
    female: true,
    waist: 0.85,
    bust: 0.92,
    armK: 0.92,
    legK: 0.95,
    torsoColor: p => (p.y > 1.65 ? veilCyan : deepIndigo),
    handColor: spectralSkin,
    curl: 0.3,
  });
  for (const s of ['L', 'R']) {
    cover(B, arms[s], 0.1, 0.92, { grow: 0.022, flare: 0.065, color: veilCyan, outline: 0.003, seg: 6 });
  }
  skirtShell(B, {
    y0: 1.72,
    y1: 0.12,
    r0: [0.21, 0.15],
    r1: [0.58, 0.52],
    colorFn: p => mix(veilCyan, '#a858ff', smooth(1.65, 0.12, p.y) * 0.72),
    bone: 'gown',
    wav: 0.11,
  });
  wingsDragonfly(R, { color: '#88f8ff', vein: '#d878ff', span: 1.25 });

  const dims = [0.155, 0.225, 0.18];
  const hd = faeHead(R, {
    skin: spectralSkin,
    dims,
    deform: { male: false, chin: 0.28, jaw: 0.92 },
    faceCfg: { lashes: 2, eye: '#ff78e8', eyeDark: '#241038', brow: '#4888a8', lip: '#78c8e8', lipLight: '#c8f8ff', skinShade: '#a8d8e8' },
    ears: { tip: [0.34, 0.10, -0.10], w: 0.038 },
  });
  const H = hd.H;
  hairCap(H, dims, p => mix('#68f0ff', '#b868ff', smooth(-0.1, 0.25, p.y)), { keep: capKeep(0.45, -0.65) });
  // Floating Jelly-Bell Halo Canopy above head
  H.add(ell([0, 0.32, 0], [0.34, 0.16, 0.34]), '#78f4ff');
  // Spectral Lantern in Left Hand
  const LH = R.part('handL');
  const lp = R.joints.handL.clone();
  LH.add(ell([lp.x, lp.y - 0.18, lp.z + 0.18], [0.12, 0.16, 0.12]), '#ff88f0');

  R.finish();
  return { rig: R };
}

/**
 * Aureate Clockwork & Porcelain Golem (`IronColossus.m2`, display 27)
 */
function buildIronColossusParts() {
  const parts = [];
  const brass = '#d8a444';
  const brassHi = '#ffe28a';
  const porcelain = '#f6f0ff';
  const coreCyan = '#58f4ff';
  const darkBronze = '#4a3420';

  // Sculpted Lathe Torso Carapace (`latheGeo`)
  const torso = latheGeo([
    [0.12, 1.05],
    [0.52, 1.25],
    [0.64, 1.65],
    [0.98, 2.25],
    [1.08, 2.75],
    [0.82, 3.15],
    [0.35, 3.28],
  ], 18);
  paintVerticalGradient(torso, darkBronze, porcelain);
  parts.push({ geo: torso, color: '#ffffff' });

  // Glowing Astrolabe Reactor Core in Chest + 2 Interlocking Brass Gyro Rings
  const core = organicLobe(0.42, 0.42, 0.36, 14, null, '#ffffff', coreCyan);
  core.translate(0, 2.38, 0.72);
  parts.push({ geo: core, color: '#ffffff' });

  for (const [rx, ry, rz] of [[0.35, 0, 0.25], [-0.35, 0.2, -0.35]]) {
    const ring = new THREE.TorusGeometry(0.54, 0.055, 10, 24);
    paintVerticalGradient(ring, brass, brassHi);
    ring.rotateX(rx);
    ring.rotateY(ry);
    ring.rotateZ(rz);
    ring.translate(0, 2.38, 0.68);
    parts.push({ geo: ring, color: '#ffffff' });
  }

  // Crowned Porcelain-and-Brass Sentinel Head with Glowing Visor
  const head = latheGeo([
    [0.24, 3.25],
    [0.38, 3.45],
    [0.36, 3.85],
    [0.44, 4.02],
    [0.12, 4.25],
  ], 14);
  paintVerticalGradient(head, brass, brassHi);
  const visor = organicLobe(0.32, 0.09, 0.22, 10, null, '#ffffff', coreCyan);
  visor.translate(0, 3.68, 0.26);
  parts.push({ geo: head, color: '#ffffff' }, { geo: visor, color: '#ffffff' });

  // Fluted Dome Pauldrons, Hydraulic Piston Arms, Crusher Gauntlets & Pillar Legs
  for (const s of [-1, 1]) {
    const pauldron = latheGeo([
      [0.68, 0.0],
      [0.64, 0.28],
      [0.44, 0.56],
      [0.08, 0.72],
    ], 14);
    paintVerticalGradient(pauldron, brass, porcelain);
    pauldron.rotateZ(s * -0.42);
    pauldron.translate(s * 1.22, 2.65, 0);

    const arm = taperedTubeGeo(
      [[s * 1.25, 2.62, 0], [s * 1.48, 1.92, 0.18], [s * 1.38, 1.18, 0.48]],
      12, 10,
      t => 0.28 + Math.sin(t * Math.PI) * 0.12
    );
    paintVerticalGradient(arm, darkBronze, brassHi);

    const fist = latheGeo([
      [0.28, -0.35],
      [0.44, -0.10],
      [0.40, 0.28],
      [0.22, 0.38],
    ], 12);
    paintVerticalGradient(fist, darkBronze, brass);
    fist.translate(s * 1.38, 1.05, 0.52);

    const leg = latheGeo([
      [0.46, 0.0],
      [0.42, 0.35],
      [0.32, 0.75],
      [0.38, 1.25],
      [0.28, 1.45],
    ], 14);
    paintVerticalGradient(leg, darkBronze, porcelain);
    leg.translate(s * 0.52, 0, 0);

    parts.push(
      { geo: pauldron, color: '#ffffff' },
      { geo: arm, color: '#ffffff' },
      { geo: fist, color: '#ffffff' },
      { geo: leg, color: '#ffffff' }
    );
  }

  return parts;
}

/**
 * Nocturnum Cinder-Stalker / Blight Hound (`BlightHound.m2`, display 30)
 */
function buildBlightHoundParts() {
  const parts = [];
  const obsidian = '#1e142e';
  const plumCoat = '#3c2458';
  const ember = '#ff4878';
  const emberHot = '#ffb858';

  // Sculpted quadruped wolf-drake chest, waist & haunches
  const body = taperedTubeGeo(
    [[0, 0.86, -0.95], [0, 0.92, -0.35], [0, 1.04, 0.32], [0, 1.16, 0.85]],
    18, 12,
    t => 0.32 + Math.sin(Math.pow(t, 0.7) * Math.PI) * 0.22,
    0.95, 1.12
  );
  paintVerticalGradient(body, ember, plumCoat);
  parts.push({ geo: body, color: '#ffffff' });

  // Fierce wolf-drake head, fanged jaws, 4 glowing eyes & swept ears
  const head = organicLobe(0.32, 0.28, 0.46, 14, (v, nx, ny, nz) => {
    if (nz > 0) { v.x *= 0.72; v.y *= 0.78; }
  }, plumCoat, obsidian);
  head.translate(0, 1.32, 1.18);
  const jaw = organicLobe(0.22, 0.12, 0.38, 12, null, ember, obsidian);
  jaw.rotateX(0.28);
  jaw.translate(0, 1.14, 1.22);
  parts.push({ geo: head, color: '#ffffff' }, { geo: jaw, color: '#ffffff' });

  for (const s of [-1, 1]) {
    const eye1 = organicLobe(0.06, 0.05, 0.06, 8, null, '#ffffff', emberHot);
    eye1.translate(s * 0.20, 1.38, 1.34);
    const eye2 = organicLobe(0.045, 0.04, 0.05, 8, null, emberHot, ember);
    eye2.translate(s * 0.23, 1.44, 1.18);
    const ear = cuppedPetalGeo(0.46, 0.20, 0.05, -0.05, 0.025, 5, 6);
    paintVerticalGradient(ear, obsidian, ember);
    ear.rotateX(-1.05);
    ear.rotateZ(s * -0.38);
    ear.translate(s * 0.22, 1.48, 0.98);
    parts.push({ geo: eye1, color: '#ffffff' }, { geo: eye2, color: '#ffffff' }, { geo: ear, color: '#ffffff' });
  }

  // 7 Jagged dorsal crystal/ember spines along the spine
  for (let i = 0; i < 7; i++) {
    const u = i / 6;
    const z = 0.85 - u * 1.75;
    const sp = crystal(0.09, 0.45 * Math.sin(u * Math.PI) + 0.18, obsidian, i % 2 === 0 ? emberHot : '#b858ff');
    sp.rotateX(-0.42);
    sp.translate(0, 1.18 - u * 0.16, z);
    parts.push({ geo: sp, color: '#ffffff' });
  }

  // 4 Muscular clawed legs + Twin whip tails
  for (const s of [-1, 1]) {
    const fLeg = taperedTubeGeo(
      [[s * 0.34, 0.98, 0.65], [s * 0.38, 0.52, 0.58], [s * 0.36, 0.08, 0.72]],
      10, 8,
      t => 0.16 * (1 - t * 0.38)
    );
    paintVerticalGradient(fLeg, obsidian, plumCoat);
    const hLeg = taperedTubeGeo(
      [[s * 0.36, 0.92, -0.68], [s * 0.42, 0.54, -0.92], [s * 0.38, 0.08, -0.72]],
      10, 8,
      t => 0.18 * (1 - t * 0.42)
    );
    paintVerticalGradient(hLeg, obsidian, plumCoat);
    const tail = taperedTubeGeo(
      [[0, 0.86, -0.92], [s * 0.22, 0.96, -1.55], [s * 0.36, 1.18, -2.15]],
      10, 7,
      t => 0.10 * (1 - t * 0.75)
    );
    paintVerticalGradient(tail, plumCoat, emberHot);
    parts.push({ geo: fLeg, color: '#ffffff' }, { geo: hLeg, color: '#ffffff' }, { geo: tail, color: '#ffffff' });
  }

  return parts;
}

// ============================================================================
// 7. Main Entry Point Called from `scripts/build-celandia-data.mjs`
// ============================================================================

export function buildCelandiaDryadAndCreatures({
  writeFile,
  buildProceduralPartsGlb,
  exportCelandiaCharacterGlb,
  charScale = 0.62,
}) {
  console.log('  -> Generating Dryad (owenyuwono/dryad) + Celandia botanical trees & 10 species clutter models...');
  buildAllDryadTreesAndFlora(buildProceduralPartsGlb, writeFile);

  console.log('  -> Generating sculpted Celandia fauna, Moonlight Lava Dragon, and rigged bad guys...');
  // Fauna (display 20..23)
  writeFile(
    'Creature/Celandia/PorcelainHopper/PorcelainHopper.m2',
    buildProceduralPartsGlb(buildPorcelainHopperParts(), 'creature', 'PorcelainHopper')
  );
  writeFile(
    'Creature/Celandia/WoollyDrifter/WoollyDrifter.m2',
    buildProceduralPartsGlb(buildWoollyDrifterParts(), 'creature', 'WoollyDrifter')
  );
  writeFile(
    'Creature/Celandia/GlassSkimmer/GlassSkimmer.m2',
    buildProceduralPartsGlb(buildGlassSkimmerParts(), 'creature', 'GlassSkimmer')
  );
  writeFile(
    'Creature/Celandia/SkyManta/SkyManta.m2',
    buildProceduralPartsGlb(buildSkyMantaParts(), 'creature', 'SkyManta')
  );

  // World Boss: Moonlight Lava Dragon (`ObsidianColossus.m2`, display 24)
  writeFile(
    'Creature/Celandia/ObsidianColossus/ObsidianColossus.m2',
    buildProceduralPartsGlb(buildMoonlightLavaDragonParts(), 'creature', 'ObsidianColossus')
  );

  // Rigged 21-Bone Celandia Humanoid Bad Guys (`Hollow`, `AshenKnight`, `BoneLord`, `Wraith`)
  const hollowGlb = withDetail(0.65, () => exportCelandiaCharacterGlb(buildRiggedCelandiaBadGuy('Hollow'), charScale * 1.05));
  writeFile('Creature/Sister/Hollow/Hollow.m2', hollowGlb);

  const knightGlb = withDetail(0.65, () => exportCelandiaCharacterGlb(buildRiggedCelandiaBadGuy('AshenKnight'), charScale * 1.18));
  writeFile('Creature/Sister/AshenKnight/AshenKnight.m2', knightGlb);

  const boneLordGlb = withDetail(0.65, () => exportCelandiaCharacterGlb(buildRiggedCelandiaBadGuy('BoneLord'), charScale * 1.28));
  writeFile('Creature/Sister/BoneLord/BoneLord.m2', boneLordGlb);

  const wraithGlb = withDetail(0.65, () => exportCelandiaCharacterGlb(buildRiggedCelandiaBadGuy('Wraith'), charScale * 1.08));
  writeFile('Creature/Sister/Wraith/Wraith.m2', wraithGlb);

  // Sculpted Multi-Part Golem & Cinder-Stalker Hound (`IronColossus`, `BlightHound`)
  writeFile(
    'Creature/Sister/IronColossus/IronColossus.m2',
    buildProceduralPartsGlb(buildIronColossusParts(), 'creature', 'IronColossus')
  );
  writeFile(
    'Creature/Sister/BlightHound/BlightHound.m2',
    buildProceduralPartsGlb(buildBlightHoundParts(), 'creature', 'BlightHound')
  );
}
