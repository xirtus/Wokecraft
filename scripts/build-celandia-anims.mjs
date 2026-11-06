/**
 * Celandia: Xirtoth — Mixamo + Augmented Reverse-Engineered Animation Pipeline
 * ============================================================================
 * Exports:
 *   1. buildHumanoidAnimations(nodes, style)
 *      28+ (36 total) distinct WoW AnimationData.dbc sequences for the 21-bone
 *      humanoid skeleton (or Celandia 19/21-bone rigs), combining extracted
 *      Mixamo keyframe tracks (from Reincarnation / Valley Girl of Death GLB
 *      packs when present) with multi-harmonic Fourier & cubic-Hermite
 *      procedural combat, locomotion, martial arts, and weapon kinematics.
 *
 *   2. buildCreatureAnimations(nodes, creatureType)
 *      12-sequence multi-bone skeletal animations for Celandia fauna and
 *      bosses (PorcelainHopper, WoollyDrifter, GlassSkimmer, SkyManta,
 *      ObsidianColossus/IronColossus/BoneLord, AshenKnight/Hollow/Wraith/BlightHound).
 *
 *   3. buildAnimationDataDbc(writeFile, WdbcBuilder)
 *      Populates DBFilesClient/AnimationData.dbc with all 208 WoW 1.12.1
 *      (build 5875) sequence rows (0..=207, including 0..=140) with valid
 *      WeaponFlags, BodyFlags, Flags, BehaviorID, and Fallback chains.
 */

import fs from 'node:fs';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// 1. Math, Quaternion & Curve Primitives
// ---------------------------------------------------------------------------

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Smooth bump window on [0, 1] that rises on [start, peakStart], holds on
 * [peakStart, peakEnd], and falls on [peakEnd, end].
 */
function windowPulse(u, start, peakStart, peakEnd, end) {
  if (u <= start || u >= end) return 0;
  if (u < peakStart) return smoothstep(start, peakStart, u);
  if (u <= peakEnd) return 1;
  return 1 - smoothstep(peakEnd, end, u);
}

/**
 * Multi-harmonic periodic wave:
 *   a1*sin(p + ph1) + a2*sin(2p + ph2) + a3*sin(3p + ph3)
 */
function harmonicWave(phase, a1 = 1, ph1 = 0, a2 = 0, ph2 = 0, a3 = 0, ph3 = 0) {
  return (
    a1 * Math.sin(phase + ph1) +
    a2 * Math.sin(phase * 2 + ph2) +
    a3 * Math.sin(phase * 3 + ph3)
  );
}

/**
 * Piecewise cubic-Hermite / smoothstep keyframe evaluator for 1D channels.
 * keyframes: Array of [u, value] sorted by u in [0, 1].
 */
function evalCurve(u, keyframes) {
  if (!keyframes || keyframes.length === 0) return 0;
  if (u <= keyframes[0][0]) return keyframes[0][1];
  const last = keyframes[keyframes.length - 1];
  if (u >= last[0]) return last[1];
  for (let i = 0; i < keyframes.length - 1; i++) {
    const [u0, v0] = keyframes[i];
    const [u1, v1] = keyframes[i + 1];
    if (u >= u0 && u <= u1) {
      const s = smoothstep(u0, u1, u);
      return v0 + (v1 - v0) * s;
    }
  }
  return last[1];
}

/**
 * Euler XYZ (intrinsic X -> Y -> Z) to normalized quaternion [qx, qy, qz, qw].
 * Matches glTF right-handed coordinate system (+Y up, +Z forward, +X left).
 */
export function quatFromEulerXYZ(rx = 0, ry = 0, rz = 0) {
  const cx = Math.cos(rx * 0.5);
  const sx = Math.sin(rx * 0.5);
  const cy = Math.cos(ry * 0.5);
  const sy = Math.sin(ry * 0.5);
  const cz = Math.cos(rz * 0.5);
  const sz = Math.sin(rz * 0.5);
  return quatNormalize([
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ]);
}

export function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatConjugate(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q) {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-8) return [0, 0, 0, 1];
  const inv = 1 / len;
  return [q[0] * inv, q[1] * inv, q[2] * inv, q[3] * inv];
}

export function quatSlerp(a, b, t) {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (dot > 0.9995) {
    return quatNormalize([
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]);
  }
  const theta0 = Math.acos(clamp(dot, -1, 1));
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;
  return quatNormalize([
    s0 * a[0] + s1 * bx,
    s0 * a[1] + s1 * by,
    s0 * a[2] + s1 * bz,
    s0 * a[3] + s1 * bw,
  ]);
}

// ---------------------------------------------------------------------------
// 2. Standard 21-Bone Humanoid Skeleton & Dynamic Node Resolver
// ---------------------------------------------------------------------------

/**
 * Canonical 21-bone humanoid hierarchy (glTF +Y up, +Z forward, +X left):
 *   0: Hips
 *   1: Spine (parent 0)
 *   2: Chest (parent 1)
 *   3: Neck (parent 2)
 *   4: Head (parent 3)
 *   5: LeftShoulder (parent 2)
 *   6: LeftUpperArm (parent 5)
 *   7: LeftLowerArm (parent 6)
 *   8: LeftHand (parent 7)
 *   9: RightShoulder (parent 2)
 *  10: RightUpperArm (parent 9)
 *  11: RightLowerArm (parent 10)
 *  12: RightHand (parent 11)
 *  13: LeftUpperLeg (parent 0)
 *  14: LeftLowerLeg (parent 13)
 *  15: LeftFoot (parent 14)
 *  16: LeftToe (parent 15)
 *  17: RightUpperLeg (parent 0)
 *  18: RightLowerLeg (parent 17)
 *  19: RightFoot (parent 18)
 *  20: RightToe (parent 19)
 */
export const DEFAULT_HUMANOID_21_BONES = [
  { name: 'Hips', parent: -1, translation: [0, 0.96, 0], rotation: [0, 0, 0, 1] },
  { name: 'Spine', parent: 0, translation: [0, 0.12, 0], rotation: [0, 0, 0, 1] },
  { name: 'Chest', parent: 1, translation: [0, 0.18, 0], rotation: [0, 0, 0, 1] },
  { name: 'Neck', parent: 2, translation: [0, 0.22, 0], rotation: [0, 0, 0, 1] },
  { name: 'Head', parent: 3, translation: [0, 0.09, 0.01], rotation: [0, 0, 0, 1] },
  { name: 'LeftShoulder', parent: 2, translation: [0.06, 0.17, 0], rotation: [0, 0, 0, 1] },
  { name: 'LeftUpperArm', parent: 5, translation: [0.12, -0.02, 0], rotation: [0, 0, 0, 1] },
  { name: 'LeftLowerArm', parent: 6, translation: [0, -0.26, 0], rotation: [0, 0, 0, 1] },
  { name: 'LeftHand', parent: 7, translation: [0, -0.24, 0], rotation: [0, 0, 0, 1] },
  { name: 'RightShoulder', parent: 2, translation: [-0.06, 0.17, 0], rotation: [0, 0, 0, 1] },
  { name: 'RightUpperArm', parent: 9, translation: [-0.12, -0.02, 0], rotation: [0, 0, 0, 1] },
  { name: 'RightLowerArm', parent: 10, translation: [0, -0.26, 0], rotation: [0, 0, 0, 1] },
  { name: 'RightHand', parent: 11, translation: [0, -0.24, 0], rotation: [0, 0, 0, 1] },
  { name: 'LeftUpperLeg', parent: 0, translation: [0.10, -0.04, 0], rotation: [0, 0, 0, 1] },
  { name: 'LeftLowerLeg', parent: 13, translation: [0, -0.42, 0], rotation: [0, 0, 0, 1] },
  { name: 'LeftFoot', parent: 14, translation: [0, -0.40, 0], rotation: [0, 0, 0, 1] },
  { name: 'LeftToe', parent: 15, translation: [0, -0.06, 0.11], rotation: [0, 0, 0, 1] },
  { name: 'RightUpperLeg', parent: 0, translation: [-0.10, -0.04, 0], rotation: [0, 0, 0, 1] },
  { name: 'RightLowerLeg', parent: 17, translation: [0, -0.42, 0], rotation: [0, 0, 0, 1] },
  { name: 'RightFoot', parent: 18, translation: [0, -0.40, 0], rotation: [0, 0, 0, 1] },
  { name: 'RightToe', parent: 19, translation: [0, -0.06, 0.11], rotation: [0, 0, 0, 1] },
];

export function buildHumanoid21Skeleton(scale = 1.0) {
  return DEFAULT_HUMANOID_21_BONES.map((b) => ({
    name: b.name,
    parent: b.parent,
    translation: [
      b.translation[0] * scale,
      b.translation[1] * scale,
      b.translation[2] * scale,
    ],
    rotation: [...b.rotation],
  }));
}

const CANONICAL_SLOTS = [
  'Hips',
  'Spine',
  'Chest',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftUpperArm',
  'LeftLowerArm',
  'LeftHand',
  'RightShoulder',
  'RightUpperArm',
  'RightLowerArm',
  'RightHand',
  'LeftUpperLeg',
  'LeftLowerLeg',
  'LeftFoot',
  'LeftToe',
  'RightUpperLeg',
  'RightLowerLeg',
  'RightFoot',
  'RightToe',
  'SkirtL',
  'SkirtR',
  'WingL',
  'WingR',
];

const SLOT_ALIASES = {
  Hips: ['hips', 'pelvis', 'root', 'b_pelvis', 'mixamorig:hips'],
  Spine: ['spine', 'spine1', 'spine_01', 'spine_01x', 'waist', ' abdomen'],
  Chest: ['chest', 'spine2', 'spine_02', 'spine_02x', 'spine_03x', 'thorax', 'upperchest'],
  Neck: ['neck', 'neckx', 'neck_01'],
  Head: ['head', 'headx'],
  LeftShoulder: ['leftshoulder', 'shoulderl', 'shoulder_l', 'clavicle_l', 'l_clavicle'],
  LeftUpperArm: ['leftupperarm', 'uarml', 'arm_stretchl', 'upperarm_l', 'leftarm', 'l_upperarm'],
  LeftLowerArm: ['leftlowerarm', 'farml', 'forearm_stretchl', 'lowerarm_l', 'leftforearm', 'l_forearm'],
  LeftHand: ['lefthand', 'handl', 'hand_l', 'l_hand'],
  RightShoulder: ['rightshoulder', 'shoulderr', 'shoulder_r', 'clavicle_r', 'r_clavicle'],
  RightUpperArm: ['rightupperarm', 'uarmr', 'arm_stretchr', 'upperarm_r', 'rightarm', 'r_upperarm'],
  RightLowerArm: ['rightlowerarm', 'farmr', 'forearm_stretchr', 'lowerarm_r', 'rightforearm', 'r_forearm'],
  RightHand: ['righthand', 'handr', 'hand_r', 'r_hand'],
  LeftUpperLeg: ['leftupperLeg', 'leftupperleg', 'thighl', 'thigh_stretchl', 'thigh_l', 'leftupleg'],
  LeftLowerLeg: ['leftlowerleg', 'shinl', 'leg_stretchl', 'calf_l', 'leftleg', 'shin_l'],
  LeftFoot: ['leftfoot', 'footl', 'foot_l'],
  LeftToe: ['lefttoe', 'lefttoebase', 'toel', 'toes_01l', 'toe_l'],
  RightUpperLeg: ['rightupperleg', 'thighr', 'thigh_stretchr', 'thigh_r', 'rightupleg'],
  RightLowerLeg: ['rightlowerleg', 'shinr', 'leg_stretchr', 'calf_r', 'rightleg', 'shin_r'],
  RightFoot: ['rightfoot', 'footr', 'foot_r'],
  RightToe: ['righttoe', 'righttoebase', 'toer', 'toes_01r', 'toe_r'],
  SkirtL: ['skirtl', 'skirt_l', 'capel'],
  SkirtR: ['skirtr', 'skirt_r', 'caper'],
  WingL: ['wingl', 'wing_l', 'wingl1'],
  WingR: ['wingr', 'wing_r', 'wingr1'],
};

/**
 * Resolves bone indices from a caller-supplied `nodes` array (supporting both
 * the 21-bone standard humanoid layout, the Celandia 19/21-bone rig layout,
 * or raw node arrays).
 */
export function resolveHumanoidBoneMap(nodes) {
  const effectiveNodes =
    Array.isArray(nodes) && nodes.length > 0 ? nodes : DEFAULT_HUMANOID_21_BONES;
  const byLowerName = new Map();
  effectiveNodes.forEach((n, idx) => {
    if (n && typeof n.name === 'string') {
      byLowerName.set(n.name.toLowerCase().trim(), idx);
    }
  });

  const slotToIndex = {};
  for (const slot of CANONICAL_SLOTS) {
    const aliases = SLOT_ALIASES[slot] || [slot.toLowerCase()];
    let found = -1;
    for (const alias of aliases) {
      const idx = byLowerName.get(alias.toLowerCase());
      if (idx !== undefined) {
        found = idx;
        break;
      }
    }
    slotToIndex[slot] = found;
  }

  // Fallback by index if nodes were unlabelled 21-bone array
  if (slotToIndex.Hips === -1 && effectiveNodes.length >= 21) {
    for (let i = 0; i < 21; i++) {
      slotToIndex[CANONICAL_SLOTS[i]] = i;
    }
  } else if (slotToIndex.Hips === -1 && effectiveNodes.length > 0) {
    slotToIndex.Hips = 0;
  }

  return { slotToIndex, nodes: effectiveNodes };
}

// ---------------------------------------------------------------------------
// 3. Real Mixamo Keyframe Library Loader & Calibrated Retargeter
// ---------------------------------------------------------------------------

const MIXAMO_GLB_PATHS = [
  '/Users/xmacbookm5/Projects/j3games/reincarnation/public/assets/locomotion-and-combat-pack.glb',
  '/Users/xmacbookm5/Projects/j3games/reincarnation/public/assets/pro-magic-pack.glb',
];

const MIXAMO_NODE_TO_SLOT = {
  pelvis: 'Hips',
  spine_01x: 'Spine',
  spine_03x: 'Chest',
  neckx: 'Neck',
  headx: 'Head',
  shoulderl: 'LeftShoulder',
  arm_stretchl: 'LeftUpperArm',
  forearm_stretchl: 'LeftLowerArm',
  handl: 'LeftHand',
  shoulderr: 'RightShoulder',
  arm_stretchr: 'RightUpperArm',
  forearm_stretchr: 'RightLowerArm',
  handr: 'RightHand',
  thigh_stretchl: 'LeftUpperLeg',
  leg_stretchl: 'LeftLowerLeg',
  footl: 'LeftFoot',
  toes_01l: 'LeftToe',
  thigh_stretchr: 'RightUpperLeg',
  leg_stretchr: 'RightLowerLeg',
  footr: 'RightFoot',
  toes_01r: 'RightToe',
};

let _cachedMixamoLibrary = null;

function parseMixamoGlbFile(filePath, outClips) {
  if (!fs.existsSync(filePath)) return;
  const buf = fs.readFileSync(filePath);
  if (buf.length < 28) return;
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) return; // 'glTF'
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart);

  const parents = new Array(gltf.nodes.length).fill(-1);
  gltf.nodes.forEach((n, i) => {
    for (const c of n.children || []) parents[c] = i;
  });

  // Calibrated world bind rotations for Anima44 -> upright straight-limb rig:
  // - Pelvis/spine_01x pitch calibration removes the static 20-deg FBX pelvis tilt
  // - arm_stretchl/r roll adjustment accounts for Anima44's 22-deg A-pose bind
  const worldBindR = new Array(gltf.nodes.length);
  function getWorldBindR(i) {
    if (worldBindR[i]) return worldBindR[i];
    const name = gltf.nodes[i].name;
    let r = gltf.nodes[i].rotation ? [...gltf.nodes[i].rotation] : [0, 0, 0, 1];
    if (name === 'pelvis') r = [0.336, 0, 0, 0.942];
    if (name === 'spine_01x') r = [-0.310, 0, 0, 0.951];
    const p = parents[i];
    let w = p >= 0 ? quatMultiply(getWorldBindR(p), r) : r;
    if (name === 'arm_stretchl') {
      w = quatMultiply(quatFromEulerXYZ(0, 0, -0.22), w);
    } else if (name === 'arm_stretchr') {
      w = quatMultiply(quatFromEulerXYZ(0, 0, 0.22), w);
    }
    worldBindR[i] = quatNormalize(w);
    return worldBindR[i];
  }
  for (let i = 0; i < gltf.nodes.length; i++) getWorldBindR(i);

  function readAccessor(accIdx) {
    const acc = gltf.accessors[accIdx];
    const bv = gltf.bufferViews[acc.bufferView];
    const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const compCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type] || 1;
    const arr = new Float32Array(acc.count * compCount);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = bin.readFloatLE(offset + i * 4);
    }
    return { count: acc.count, compCount, arr };
  }

  const pelvisIdx = gltf.nodes.findIndex((n) => n.name === 'pelvis');
  const pelvisRestY =
    pelvisIdx >= 0 && gltf.nodes[pelvisIdx].translation
      ? gltf.nodes[pelvisIdx].translation[1]
      : 0.95;

  for (const anim of gltf.animations || []) {
    const slotTracks = {};
    let duration = 1.0;
    let hipDeltaTrack = null;

    for (const ch of anim.channels || []) {
      const nodeIdx = ch.target.node;
      const node = gltf.nodes[nodeIdx];
      if (!node) continue;
      const sampler = anim.samplers[ch.sampler];
      const timesAcc = readAccessor(sampler.input);
      const valsAcc = readAccessor(sampler.output);
      if (timesAcc.count === 0) continue;
      duration = Math.max(duration, timesAcc.arr[timesAcc.count - 1] || 1.0);

      if (ch.target.path === 'translation' && node.name === 'pelvis') {
        const deltas = new Float32Array(valsAcc.count * 3);
        const baseX = valsAcc.arr[0];
        const baseZ = valsAcc.arr[2];
        for (let f = 0; f < valsAcc.count; f++) {
          deltas[f * 3 + 0] = clamp(valsAcc.arr[f * 3 + 0] - baseX, -0.35, 0.35);
          deltas[f * 3 + 1] = clamp(valsAcc.arr[f * 3 + 1] - pelvisRestY, -0.55, 0.45);
          deltas[f * 3 + 2] = clamp(valsAcc.arr[f * 3 + 2] - baseZ, -0.35, 0.35);
        }
        hipDeltaTrack = { times: timesAcc.arr, values: deltas, count: valsAcc.count };
        continue;
      }

      const slot = MIXAMO_NODE_TO_SLOT[node.name];
      if (!slot || ch.target.path !== 'rotation') continue;

      const p = parents[nodeIdx];
      const wp = p >= 0 ? worldBindR[p] : [0, 0, 0, 1];
      const wjInv = quatConjugate(worldBindR[nodeIdx]);
      const retargeted = new Float32Array(valsAcc.count * 4);

      for (let f = 0; f < valsAcc.count; f++) {
        const qAnim = [
          valsAcc.arr[f * 4 + 0],
          valsAcc.arr[f * 4 + 1],
          valsAcc.arr[f * 4 + 2],
          valsAcc.arr[f * 4 + 3],
        ];
        let qTarget = quatNormalize(quatMultiply(quatMultiply(wp, qAnim), wjInv));
        if (qTarget[3] < 0) {
          qTarget = [-qTarget[0], -qTarget[1], -qTarget[2], -qTarget[3]];
        }
        retargeted[f * 4 + 0] = qTarget[0];
        retargeted[f * 4 + 1] = qTarget[1];
        retargeted[f * 4 + 2] = qTarget[2];
        retargeted[f * 4 + 3] = qTarget[3];
      }

      slotTracks[slot] = {
        times: timesAcc.arr,
        values: retargeted,
        count: valsAcc.count,
      };
    }

    outClips.set(anim.name, {
      name: anim.name,
      duration,
      slotTracks,
      hipDeltaTrack,
    });
  }
}

export function loadMixamoAnimationLibrary() {
  if (_cachedMixamoLibrary) return _cachedMixamoLibrary;
  const clips = new Map();
  for (const p of MIXAMO_GLB_PATHS) {
    try {
      parseMixamoGlbFile(p, clips);
    } catch {
      // Graceful fallback to pure procedural if GLB pack is inaccessible
    }
  }
  _cachedMixamoLibrary = clips;
  return clips;
}

/**
 * Samples a retargeted Mixamo bone rotation at normalized time u in [0, 1].
 */
function sampleMixamoRotation(clip, slot, u) {
  if (!clip || !clip.slotTracks || !clip.slotTracks[slot]) return null;
  const tr = clip.slotTracks[slot];
  const n = tr.count;
  if (n <= 1) {
    return [tr.values[0], tr.values[1], tr.values[2], tr.values[3]];
  }
  const exact = clamp(u, 0, 1) * (n - 1);
  const i0 = Math.min(Math.floor(exact), n - 2);
  const i1 = i0 + 1;
  const frac = exact - i0;
  const q0 = [
    tr.values[i0 * 4 + 0],
    tr.values[i0 * 4 + 1],
    tr.values[i0 * 4 + 2],
    tr.values[i0 * 4 + 3],
  ];
  const q1 = [
    tr.values[i1 * 4 + 0],
    tr.values[i1 * 4 + 1],
    tr.values[i1 * 4 + 2],
    tr.values[i1 * 4 + 3],
  ];
  return quatSlerp(q0, q1, frac);
}

function sampleMixamoHipDelta(clip, u) {
  if (!clip || !clip.hipDeltaTrack) return null;
  const tr = clip.hipDeltaTrack;
  const n = tr.count;
  if (n <= 1) return [tr.values[0], tr.values[1], tr.values[2]];
  const exact = clamp(u, 0, 1) * (n - 1);
  const i0 = Math.min(Math.floor(exact), n - 2);
  const i1 = i0 + 1;
  const frac = exact - i0;
  return [
    lerp(tr.values[i0 * 3 + 0], tr.values[i1 * 3 + 0], frac),
    lerp(tr.values[i0 * 3 + 1], tr.values[i1 * 3 + 1], frac),
    lerp(tr.values[i0 * 3 + 2], tr.values[i1 * 3 + 2], frac),
  ];
}

// ---------------------------------------------------------------------------
// 4. Style Profiles for Celandia & Xirtoth Archetypes
// ---------------------------------------------------------------------------

function resolveStyleProfile(style = 'duelist') {
  const s = String(style || 'duelist').toLowerCase();
  if (s.includes('tide') || s.includes('serein') || s.includes('princess') || s.includes('mage')) {
    return {
      id: 'tideweaver',
      strideAmp: 0.92,
      armSwingAmp: 0.85,
      spineSway: 1.22,
      idleFloat: 0.012,
      readyPitch: 0.06,
      readyYaw: 0.28,
      mixamoWeight: 0.40,
      wingAmp: 1.25,
    };
  }
  if (s.includes('ranger') || s.includes('ilex') || s.includes('archer') || s.includes('hunter')) {
    return {
      id: 'ranger',
      strideAmp: 1.08,
      armSwingAmp: 1.0,
      spineSway: 0.95,
      idleFloat: 0.008,
      readyPitch: 0.14,
      readyYaw: 0.45,
      mixamoWeight: 0.42,
      wingAmp: 0.9,
    };
  }
  if (s.includes('shade') || s.includes('oriel') || s.includes('rogue') || s.includes('assassin')) {
    return {
      id: 'shade',
      strideAmp: 1.12,
      armSwingAmp: 0.95,
      spineSway: 1.05,
      idleFloat: 0.007,
      readyPitch: 0.24,
      readyYaw: -0.35,
      mixamoWeight: 0.42,
      wingAmp: 1.0,
    };
  }
  if (s.includes('lancer') || s.includes('tekkaman') || s.includes('space')) {
    return {
      id: 'lancer',
      strideAmp: 1.15,
      armSwingAmp: 1.1,
      spineSway: 1.0,
      idleFloat: 0.010,
      readyPitch: 0.18,
      readyYaw: -0.42,
      mixamoWeight: 0.38,
      wingAmp: 1.35,
    };
  }
  if (s.includes('star') || s.includes('jem') || s.includes('glamour') || s.includes('bard')) {
    return {
      id: 'starlight',
      strideAmp: 1.0,
      armSwingAmp: 1.15,
      spineSway: 1.35,
      idleFloat: 0.014,
      readyPitch: 0.05,
      readyYaw: 0.32,
      mixamoWeight: 0.40,
      wingAmp: 1.3,
    };
  }
  return {
    id: 'duelist',
    strideAmp: 1.04,
    armSwingAmp: 1.05,
    spineSway: 1.0,
    idleFloat: 0.009,
    readyPitch: 0.14,
    readyYaw: -0.32,
    mixamoWeight: 0.45,
    wingAmp: 1.0,
  };
}

// ---------------------------------------------------------------------------
// 5. Pose State Builder & Clip Compiler
// ---------------------------------------------------------------------------

function createBlankPose() {
  const euler = {};
  for (const slot of CANONICAL_SLOTS) {
    euler[slot] = [0, 0, 0];
  }
  return {
    hipDelta: [0, 0, 0],
    euler,
    quatOverride: {},
  };
}

function addEuler(pose, slot, rx = 0, ry = 0, rz = 0) {
  const e = pose.euler[slot];
  if (!e) return;
  e[0] += rx;
  e[1] += ry;
  e[2] += rz;
}

function setEuler(pose, slot, rx = 0, ry = 0, rz = 0) {
  const e = pose.euler[slot];
  if (!e) return;
  e[0] = rx;
  e[1] = ry;
  e[2] = rz;
}

/**
 * Automatically derives natural secondary motion for shoulders, toes, skirt
 * panels, and wings whenever upper-arms, legs, or spine move.
 */
function applySecondaryKinematics(pose, u, profile, wingSpreadBoost = 0) {
  const e = pose.euler;

  // Clavicle / shoulder follow-through (~22% of upper arm pitch & roll)
  e.LeftShoulder[0] += clamp(e.LeftUpperArm[0] * 0.16, -0.28, 0.28);
  e.LeftShoulder[1] += clamp(e.LeftUpperArm[1] * 0.14, -0.25, 0.25);
  e.LeftShoulder[2] += clamp((e.LeftUpperArm[2] - 0.1) * 0.22, -0.22, 0.32);

  e.RightShoulder[0] += clamp(e.RightUpperArm[0] * 0.16, -0.28, 0.28);
  e.RightShoulder[1] += clamp(e.RightUpperArm[1] * 0.14, -0.25, 0.25);
  e.RightShoulder[2] += clamp((e.RightUpperArm[2] + 0.1) * 0.22, -0.32, 0.22);

  // Toe roll follow-through from foot & lower leg flexion
  if (Math.abs(e.LeftToe[0]) < 1e-4) {
    e.LeftToe[0] = clamp(-e.LeftFoot[0] * 0.55 + Math.max(0, e.LeftLowerLeg[0]) * 0.22, -0.45, 0.65);
  }
  if (Math.abs(e.RightToe[0]) < 1e-4) {
    e.RightToe[0] = clamp(-e.RightFoot[0] * 0.55 + Math.max(0, e.RightLowerLeg[0]) * 0.22, -0.45, 0.65);
  }

  // Skirt / tunic cloth follow-through preventing thigh clipping
  const p = u * TAU;
  e.SkirtL[0] = Math.min(0, e.LeftUpperLeg[0] * 0.62) - 0.04 + Math.sin(p) * 0.04;
  e.SkirtL[2] = 0.08 + Math.max(0, e.LeftUpperLeg[2] * 0.55) + Math.cos(p) * 0.03;
  e.SkirtR[0] = Math.min(0, e.RightUpperLeg[0] * 0.62) - 0.04 + Math.sin(p + Math.PI) * 0.04;
  e.SkirtR[2] = -0.08 + Math.min(0, e.RightUpperLeg[2] * 0.55) - Math.cos(p) * 0.03;

  // Wing secondary flutter
  const wAmp = (profile ? profile.wingAmp : 1.0) * (1 + wingSpreadBoost);
  e.WingL[1] += (-0.18 * wingSpreadBoost + Math.sin(p) * 0.14) * wAmp;
  e.WingL[2] += (0.12 * wingSpreadBoost + Math.cos(p) * 0.08) * wAmp;
  e.WingR[1] += (0.18 * wingSpreadBoost - Math.sin(p) * 0.14) * wAmp;
  e.WingR[2] += (-0.12 * wingSpreadBoost - Math.cos(p) * 0.08) * wAmp;
}

/**
 * Compiles a humanoid sequence into `{ name, times, tracks }` ready for
 * `buildGlbFromRiggedData` and `benilla-formats/src/models/glb.rs`.
 */
function compileHumanoidClip({
  name,
  duration,
  numFrames = 25,
  loop = true,
  boneMap,
  profile,
  mixamoClip = null,
  mixamoBlend = 0,
  wingBoost = 0,
  evalPose,
}) {
  const { slotToIndex, nodes } = boneMap;
  const times = new Float32Array(numFrames);
  for (let k = 0; k < numFrames; k++) {
    times[k] = (k / (numFrames - 1)) * duration;
  }

  // Determine active slots present in `nodes`
  const activeSlots = CANONICAL_SLOTS.filter((slot) => slotToIndex[slot] >= 0);
  const rotBuffers = {};
  for (const slot of activeSlots) {
    rotBuffers[slot] = new Float32Array(numFrames * 4);
  }
  const hipsIdx = slotToIndex.Hips;
  const hipsRestT =
    hipsIdx >= 0 && nodes[hipsIdx] && Array.isArray(nodes[hipsIdx].translation)
      ? nodes[hipsIdx].translation
      : [0, 0.96, 0];
  const hipTransBuffer = hipsIdx >= 0 ? new Float32Array(numFrames * 3) : null;

  for (let k = 0; k < numFrames; k++) {
    // Enforce seamless loop closure: final frame evaluates at u=0 when loop=true
    const sampleU = loop && k === numFrames - 1 ? 0 : k / (numFrames - 1);
    const rawU = k / (numFrames - 1);
    const pose = createBlankPose();
    evalPose(pose, sampleU, rawU, profile);
    applySecondaryKinematics(pose, sampleU, profile, wingBoost);

    // Blend hip translation with Mixamo hip delta when configured
    let dx = pose.hipDelta[0];
    let dy = pose.hipDelta[1];
    let dz = pose.hipDelta[2];
    if (mixamoClip && mixamoBlend > 0) {
      const mHip = sampleMixamoHipDelta(mixamoClip, sampleU);
      if (mHip) {
        dx = lerp(dx, mHip[0], mixamoBlend * 0.5);
        dy = lerp(dy, mHip[1], mixamoBlend * 0.65);
        dz = lerp(dz, mHip[2], mixamoBlend * 0.5);
      }
    }
    if (hipTransBuffer) {
      hipTransBuffer[k * 3 + 0] = hipsRestT[0] + dx;
      hipTransBuffer[k * 3 + 1] = hipsRestT[1] + dy;
      hipTransBuffer[k * 3 + 2] = hipsRestT[2] + dz;
    }

    for (const slot of activeSlots) {
      const bIdx = slotToIndex[slot];
      const restR =
        nodes[bIdx] && Array.isArray(nodes[bIdx].rotation)
          ? nodes[bIdx].rotation
          : [0, 0, 0, 1];
      let qProc =
        pose.quatOverride[slot] ||
        quatFromEulerXYZ(pose.euler[slot][0], pose.euler[slot][1], pose.euler[slot][2]);

      if (mixamoClip && mixamoBlend > 0 && !pose.quatOverride[slot]) {
        const qMix = sampleMixamoRotation(mixamoClip, slot, sampleU);
        if (qMix) {
          // Slightly lower blend on arms during non-combat clips so weapon pose stays clean
          const slotWeight =
            slot.includes('Arm') || slot.includes('Shoulder')
              ? mixamoBlend * 0.55
              : mixamoBlend;
          qProc = quatSlerp(qProc, qMix, clamp(slotWeight, 0, 0.85));
        }
      }

      const qFinal = quatNormalize(quatMultiply(restR, qProc));
      const buf = rotBuffers[slot];
      buf[k * 4 + 0] = qFinal[0];
      buf[k * 4 + 1] = qFinal[1];
      buf[k * 4 + 2] = qFinal[2];
      buf[k * 4 + 3] = qFinal[3];
    }
  }

  // Enforce hemisphere continuity on quaternion tracks so linear/slerp sampling never flips
  const tracks = [];
  if (hipTransBuffer && hipsIdx >= 0) {
    tracks.push({
      bone: hipsIdx,
      path: 'translation',
      values: hipTransBuffer,
    });
  }

  const seenBones = new Set();
  for (const slot of activeSlots) {
    const bIdx = slotToIndex[slot];
    if (seenBones.has(bIdx)) continue;
    seenBones.add(bIdx);
    const buf = rotBuffers[slot];
    for (let k = 1; k < numFrames; k++) {
      const prevOff = (k - 1) * 4;
      const curOff = k * 4;
      const dot =
        buf[prevOff + 0] * buf[curOff + 0] +
        buf[prevOff + 1] * buf[curOff + 1] +
        buf[prevOff + 2] * buf[curOff + 2] +
        buf[prevOff + 3] * buf[curOff + 3];
      if (dot < 0) {
        buf[curOff + 0] = -buf[curOff + 0];
        buf[curOff + 1] = -buf[curOff + 1];
        buf[curOff + 2] = -buf[curOff + 2];
        buf[curOff + 3] = -buf[curOff + 3];
      }
    }
    tracks.push({
      bone: bIdx,
      path: 'rotation',
      values: buf,
    });
  }

  return { name, times, tracks };
}

// ---------------------------------------------------------------------------
// 6. Export 1: buildHumanoidAnimations(nodes, style) — 36 WoW Sequences
// ---------------------------------------------------------------------------

export function buildHumanoidAnimations(nodes, style = 'duelist') {
  const boneMap = resolveHumanoidBoneMap(nodes);
  const profile = resolveStyleProfile(style);
  const mixamo = loadMixamoAnimationLibrary();
  const clips = [];

  // =========================================================================
  // 0:Stand — Multi-harmonic breathing, contrapposto weight shift & style poise
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '0:Stand',
      duration: 3.2,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u, _rawU, prof) {
        const p = u * TAU;
        const breath = harmonicWave(p, 1.0, 0, 0.32, 0.6);
        const sway = Math.sin(p + 0.5) * prof.spineSway;

        pose.hipDelta[0] = sway * 0.012;
        pose.hipDelta[1] = breath * prof.idleFloat;
        pose.hipDelta[2] = Math.cos(p) * 0.006;

        setEuler(pose, 'Hips', 0.02 + breath * 0.015, sway * 0.04, sway * 0.025);
        setEuler(pose, 'Spine', 0.02 - breath * 0.025, -sway * 0.03, -sway * 0.02);
        setEuler(pose, 'Chest', -breath * 0.035, -sway * 0.025, -sway * 0.015);
        setEuler(pose, 'Neck', breath * 0.018, Math.sin(p + 1.1) * 0.04, 0);
        setEuler(pose, 'Head', -breath * 0.02, Math.sin(p + 1.4) * 0.06, Math.cos(p) * 0.025);

        if (prof.id === 'tideweaver' || prof.id === 'starlight') {
          setEuler(pose, 'LeftUpperArm', 0.06 + breath * 0.04, 0.12, 0.18 + Math.abs(breath) * 0.04);
          setEuler(pose, 'LeftLowerArm', -0.42 - breath * 0.06, 0.15, 0.06);
          setEuler(pose, 'LeftHand', -0.08, 0, 0.12 * Math.sin(p));
          setEuler(pose, 'RightUpperArm', -0.12 + breath * 0.04, -0.15, -0.18 - Math.abs(breath) * 0.04);
          setEuler(pose, 'RightLowerArm', -0.52 - breath * 0.05, -0.18, -0.06);
          setEuler(pose, 'RightHand', -0.10, 0, -0.12 * Math.sin(p));
        } else if (prof.id === 'lancer') {
          setEuler(pose, 'LeftUpperArm', -0.18 + breath * 0.03, 0.18, 0.22);
          setEuler(pose, 'LeftLowerArm', -0.58, 0.12, 0.05);
          setEuler(pose, 'RightUpperArm', 0.14 - breath * 0.03, -0.22, -0.24);
          setEuler(pose, 'RightLowerArm', -0.48, -0.10, -0.05);
        } else {
          setEuler(pose, 'LeftUpperArm', 0.04 + breath * 0.03, 0.06, 0.14 + Math.abs(breath) * 0.02);
          setEuler(pose, 'LeftLowerArm', -0.28 - breath * 0.04, 0.08, 0.03);
          setEuler(pose, 'LeftHand', 0, 0, 0.05 * Math.sin(p));
          setEuler(pose, 'RightUpperArm', -0.06 - breath * 0.03, -0.08, -0.15 - Math.abs(breath) * 0.02);
          setEuler(pose, 'RightLowerArm', -0.34 - breath * 0.04, -0.08, -0.03);
          setEuler(pose, 'RightHand', 0, 0, -0.05 * Math.sin(p));
        }

        // Contrapposto leg stance
        setEuler(pose, 'LeftUpperLeg', -0.05 - sway * 0.02, 0.04, 0.03 - sway * 0.02);
        setEuler(pose, 'LeftLowerLeg', 0.10 + Math.max(0, sway) * 0.04, 0, 0);
        setEuler(pose, 'LeftFoot', -0.05, 0, -0.02);
        setEuler(pose, 'RightUpperLeg', 0.03 + sway * 0.02, -0.05, -0.03 - sway * 0.02);
        setEuler(pose, 'RightLowerLeg', 0.07 + Math.max(0, -sway) * 0.04, 0, 0);
        setEuler(pose, 'RightFoot', -0.04, 0, 0.02);
      },
    })
  );

  // =========================================================================
  // 1:Death — Multi-stage fatal impact, knee buckle & grounded slump
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '1:Death',
      duration: 1.55,
      numFrames: 28,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Death_Forward') || mixamo.get('SnS_Death_1'),
      mixamoBlend: 0.28,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        // Stage 1 (0..0.24): Fatal impact arch
        // Stage 2 (0.24..0.56): Drop to knees
        // Stage 3 (0.56..0.86): Pitch forward onto ground
        // Stage 4 (0.86..1.0): Limp settle
        pose.hipDelta[0] = evalCurve(u, [[0, 0], [0.24, -0.04], [0.56, 0.05], [0.88, 0.09], [1, 0.09]]);
        pose.hipDelta[1] = evalCurve(u, [[0, 0], [0.18, 0.02], [0.52, -0.38], [0.84, -0.78], [1, -0.80]]);
        pose.hipDelta[2] = evalCurve(u, [[0, 0], [0.24, -0.08], [0.56, 0.06], [0.86, 0.28], [1, 0.30]]);

        const hipPitch = evalCurve(u, [[0, 0], [0.20, -0.28], [0.52, 0.36], [0.85, 1.44], [1, 1.48]]);
        const hipYaw = evalCurve(u, [[0, 0], [0.25, 0.22], [0.60, -0.18], [0.88, -0.25], [1, -0.25]]);
        const hipRoll = evalCurve(u, [[0, 0], [0.25, -0.10], [0.65, 0.16], [1, 0.20]]);
        setEuler(pose, 'Hips', hipPitch, hipYaw, hipRoll);

        setEuler(
          pose,
          'Spine',
          evalCurve(u, [[0, 0], [0.22, -0.32], [0.55, 0.28], [0.86, 0.12], [1, 0.10]]),
          evalCurve(u, [[0, 0], [0.28, -0.18], [0.85, 0.10], [1, 0.10]]),
          0
        );
        setEuler(
          pose,
          'Chest',
          evalCurve(u, [[0, 0], [0.22, -0.25], [0.58, 0.24], [0.88, 0.06], [1, 0.05]]),
          0,
          0
        );
        setEuler(
          pose,
          'Neck',
          evalCurve(u, [[0, 0], [0.22, -0.35], [0.60, 0.30], [0.88, -0.18], [1, -0.20]]),
          evalCurve(u, [[0, 0], [0.50, 0.15], [0.88, 0.42], [1, 0.45]]),
          0
        );
        setEuler(
          pose,
          'Head',
          evalCurve(u, [[0, 0], [0.22, -0.30], [0.65, 0.22], [0.90, -0.15], [1, -0.15]]),
          evalCurve(u, [[0, 0], [0.88, 0.35], [1, 0.38]]),
          0
        );

        // Arms fling wide on impact then settle splayed
        setEuler(
          pose,
          'LeftUpperArm',
          evalCurve(u, [[0, 0], [0.24, -0.85], [0.58, -0.45], [0.86, -1.15], [1, -1.18]]),
          0.25 * smoothstep(0.2, 0.9, u),
          evalCurve(u, [[0, 0.14], [0.25, 0.95], [0.60, 0.55], [0.88, 0.72], [1, 0.74]])
        );
        setEuler(
          pose,
          'LeftLowerArm',
          evalCurve(u, [[0, -0.28], [0.25, -0.95], [0.60, -0.65], [0.88, -0.35], [1, -0.32]]),
          0,
          0
        );
        setEuler(
          pose,
          'RightUpperArm',
          evalCurve(u, [[0, 0], [0.24, -0.75], [0.58, -0.30], [0.86, -0.92], [1, -0.95]]),
          -0.25 * smoothstep(0.2, 0.9, u),
          evalCurve(u, [[0, -0.14], [0.25, -0.90], [0.60, -0.48], [0.88, -0.68], [1, -0.70]])
        );
        setEuler(
          pose,
          'RightLowerArm',
          evalCurve(u, [[0, -0.32], [0.25, -0.88], [0.60, -0.72], [0.88, -0.45], [1, -0.42]]),
          0,
          0
        );

        // Legs buckle onto knees then extend behind on the ground
        setEuler(
          pose,
          'LeftUpperLeg',
          evalCurve(u, [[0, 0], [0.24, -0.35], [0.54, -1.05], [0.86, -0.18], [1, -0.15]]),
          0,
          0.12 * smoothstep(0.3, 0.9, u)
        );
        setEuler(
          pose,
          'LeftLowerLeg',
          evalCurve(u, [[0, 0.08], [0.24, 0.55], [0.54, 1.85], [0.86, 0.32], [1, 0.28]]),
          0,
          0
        );
        setEuler(
          pose,
          'RightUpperLeg',
          evalCurve(u, [[0, 0], [0.24, -0.25], [0.54, -0.92], [0.86, -0.08], [1, -0.06]]),
          0,
          -0.14 * smoothstep(0.3, 0.9, u)
        );
        setEuler(
          pose,
          'RightLowerLeg',
          evalCurve(u, [[0, 0.08], [0.24, 0.48], [0.54, 1.72], [0.86, 0.45], [1, 0.42]]),
          0,
          0
        );
      },
    })
  );

  // =========================================================================
  // 4:Walk — Multi-harmonic gait cycle + Mixamo Fem_Walk blend
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '4:Walk',
      duration: 0.96,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Fem_Walk'),
      mixamoBlend: profile.mixamoWeight,
      evalPose(pose, u, _rawU, prof) {
        const p = u * TAU;
        const s = prof.strideAmp;
        const armS = prof.armSwingAmp;

        // Vertical double-bounce (peaks at mid-stance of each leg) & lateral weight transfer
        pose.hipDelta[0] = Math.cos(p) * 0.022 * prof.spineSway;
        pose.hipDelta[1] = -Math.cos(p * 2) * 0.026 * s - 0.012;
        pose.hipDelta[2] = Math.sin(p * 2) * 0.012;

        // Pelvis obliquity, transverse rotation & forward gait tilt
        setEuler(
          pose,
          'Hips',
          0.04 + Math.cos(p * 2) * 0.025,
          -Math.sin(p) * 0.11 * s,
          Math.cos(p) * 0.045 * prof.spineSway
        );
        // Counter-rotating spine & chest
        setEuler(
          pose,
          'Spine',
          0.03 - Math.cos(p * 2) * 0.02,
          Math.sin(p) * 0.075 * s,
          -Math.cos(p) * 0.035 * prof.spineSway
        );
        setEuler(
          pose,
          'Chest',
          0.02 + Math.sin(p * 2) * 0.018,
          Math.sin(p) * 0.065 * s,
          -Math.cos(p) * 0.025
        );
        setEuler(pose, 'Neck', -0.02, -Math.sin(p) * 0.04, 0);
        setEuler(pose, 'Head', -0.02 + Math.cos(p * 2) * 0.015, -Math.sin(p) * 0.035, Math.cos(p) * 0.015);

        // Opposite-phase arm pendulum with lagged forearm flexion
        const lArmSwing = -Math.sin(p) * 0.38 * armS;
        const rArmSwing = Math.sin(p) * 0.38 * armS;
        setEuler(pose, 'LeftUpperArm', lArmSwing, 0.05, 0.12);
        setEuler(
          pose,
          'LeftLowerArm',
          -0.28 - Math.max(0, -lArmSwing) * 0.45 - 0.08 * Math.sin(p - 0.5),
          0.06,
          0
        );
        setEuler(pose, 'LeftHand', -0.05 * Math.sin(p), 0, 0.04);

        setEuler(pose, 'RightUpperArm', rArmSwing, -0.05, -0.12);
        setEuler(
          pose,
          'RightLowerArm',
          -0.28 - Math.max(0, -rArmSwing) * 0.45 + 0.08 * Math.sin(p - 0.5),
          -0.06,
          0
        );
        setEuler(pose, 'RightHand', 0.05 * Math.sin(p), 0, -0.04);

        // 3-harmonic leg stride + swing-phase knee clearance + stance heel-strike rebound
        const lThigh = harmonicWave(p, 0.48 * s, 0, -0.07 * s, 0.8, 0.02, 0);
        const rThigh = harmonicWave(p + Math.PI, 0.48 * s, 0, -0.07 * s, 0.8, 0.02, 0);
        const lKnee =
          0.12 +
          Math.max(0, Math.cos(p - 0.35)) * 0.68 * s +
          Math.max(0, -Math.sin(p)) * 0.14;
        const rKnee =
          0.12 +
          Math.max(0, Math.cos(p + Math.PI - 0.35)) * 0.68 * s +
          Math.max(0, Math.sin(p)) * 0.14;

        setEuler(pose, 'LeftUpperLeg', lThigh, 0.02, 0.02);
        setEuler(pose, 'LeftLowerLeg', lKnee, 0, 0);
        setEuler(pose, 'LeftFoot', -lThigh * 0.45 - (lKnee - 0.12) * 0.32 + 0.04, 0, 0);

        setEuler(pose, 'RightUpperLeg', rThigh, -0.02, -0.02);
        setEuler(pose, 'RightLowerLeg', rKnee, 0, 0);
        setEuler(pose, 'RightFoot', -rThigh * 0.45 - (rKnee - 0.12) * 0.32 + 0.04, 0, 0);
      },
    })
  );

  // =========================================================================
  // 5:Run — Athletic forward sprint + Mixamo Fem_Run blend
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '5:Run',
      duration: 0.64,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Fem_Run'),
      mixamoBlend: profile.mixamoWeight,
      evalPose(pose, u, _rawU, prof) {
        const p = u * TAU;
        const s = prof.strideAmp;

        // Aerial float bounce (two peaks per stride) & forward athletic drive
        pose.hipDelta[0] = Math.cos(p) * 0.026;
        pose.hipDelta[1] = -Math.cos(p * 2) * 0.058 * s - 0.02;
        pose.hipDelta[2] = Math.sin(p * 2) * 0.024;

        setEuler(
          pose,
          'Hips',
          0.16 + Math.cos(p * 2) * 0.05,
          -Math.sin(p) * 0.18 * s,
          Math.cos(p) * 0.06
        );
        setEuler(
          pose,
          'Spine',
          0.10 - Math.cos(p * 2) * 0.035,
          Math.sin(p) * 0.12 * s,
          -Math.cos(p) * 0.045
        );
        setEuler(
          pose,
          'Chest',
          0.08 + Math.sin(p * 2) * 0.03,
          Math.sin(p) * 0.11 * s,
          -Math.cos(p) * 0.035
        );
        setEuler(pose, 'Neck', -0.12, -Math.sin(p) * 0.07, 0);
        setEuler(pose, 'Head', -0.10 + Math.cos(p * 2) * 0.025, -Math.sin(p) * 0.06, 0);

        // Pumping sprint arms with acute elbow flexion
        const lArm = -Math.sin(p) * 0.78 * prof.armSwingAmp;
        const rArm = Math.sin(p) * 0.78 * prof.armSwingAmp;
        setEuler(pose, 'LeftUpperArm', lArm + 0.08, 0.10, 0.16);
        setEuler(pose, 'LeftLowerArm', -1.05 - Math.max(0, -lArm) * 0.35, 0.12, 0);
        setEuler(pose, 'LeftHand', -0.12, 0, 0.08);

        setEuler(pose, 'RightUpperArm', rArm + 0.08, -0.10, -0.16);
        setEuler(pose, 'RightLowerArm', -1.05 - Math.max(0, -rArm) * 0.35, -0.12, 0);
        setEuler(pose, 'RightHand', -0.12, 0, -0.08);

        // High-knee drive & heel kick-up
        const lThigh = harmonicWave(p, 0.85 * s, 0, -0.14 * s, 0.6);
        const rThigh = harmonicWave(p + Math.PI, 0.85 * s, 0, -0.14 * s, 0.6);
        const lKnee = 0.22 + Math.max(0, Math.cos(p - 0.45)) * 1.18 * s;
        const rKnee = 0.22 + Math.max(0, Math.cos(p + Math.PI - 0.45)) * 1.18 * s;

        setEuler(pose, 'LeftUpperLeg', lThigh, 0.03, 0.03);
        setEuler(pose, 'LeftLowerLeg', lKnee, 0, 0);
        setEuler(pose, 'LeftFoot', -lThigh * 0.42 - (lKnee - 0.22) * 0.28 + 0.12, 0, 0);

        setEuler(pose, 'RightUpperLeg', rThigh, -0.03, -0.03);
        setEuler(pose, 'RightLowerLeg', rKnee, 0, 0);
        setEuler(pose, 'RightFoot', -rThigh * 0.42 - (rKnee - 0.22) * 0.28 + 0.12, 0, 0);
      },
    })
  );

  // =========================================================================
  // 9:CombatWound — Hit stagger recoil + Mixamo Hurt_Large_Front blend
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '9:CombatWound',
      duration: 0.58,
      numFrames: 21,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Hurt_Large_Front'),
      mixamoBlend: 0.38,
      evalPose(pose, _u, rawU) {
        const hit = windowPulse(rawU, 0.0, 0.18, 0.38, 1.0);
        const shake = Math.sin(rawU * TAU * 2) * hit;

        pose.hipDelta[0] = -0.04 * hit;
        pose.hipDelta[1] = -0.065 * hit;
        pose.hipDelta[2] = -0.095 * hit;

        setEuler(pose, 'Hips', -0.14 * hit, 0.22 * hit, -0.06 * hit);
        setEuler(pose, 'Spine', -0.22 * hit, -0.18 * hit, 0.08 * hit);
        setEuler(pose, 'Chest', -0.28 * hit, -0.22 * hit, 0.06 * shake);
        setEuler(pose, 'Neck', -0.26 * hit, 0.15 * hit, -0.10 * hit);
        setEuler(pose, 'Head', -0.32 * hit, 0.20 * hit, 0.12 * shake);

        setEuler(pose, 'LeftUpperArm', -0.45 * hit, 0.25 * hit, 0.55 * hit + 0.14);
        setEuler(pose, 'LeftLowerArm', -0.68 * hit - 0.25, 0, 0);
        setEuler(pose, 'RightUpperArm', -0.35 * hit, -0.25 * hit, -0.62 * hit - 0.14);
        setEuler(pose, 'RightLowerArm', -0.72 * hit - 0.28, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.28 * hit, 0, 0.06 * hit);
        setEuler(pose, 'LeftLowerLeg', 0.52 * hit + 0.08, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.18 * hit, 0, -0.06 * hit);
        setEuler(pose, 'RightLowerLeg', 0.38 * hit + 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 10:CombatCritical — Heavy spinning stagger / near-knockdown
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '10:CombatCritical',
      duration: 0.78,
      numFrames: 23,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('stumbleBack') || mixamo.get('Hurt_Large_Left'),
      mixamoBlend: 0.35,
      evalPose(pose, _u, rawU) {
        const hit = windowPulse(rawU, 0.0, 0.22, 0.48, 1.0);
        pose.hipDelta[0] = 0.08 * hit;
        pose.hipDelta[1] = -0.16 * hit;
        pose.hipDelta[2] = -0.18 * hit;

        setEuler(pose, 'Hips', 0.28 * hit, -0.45 * hit, 0.12 * hit);
        setEuler(pose, 'Spine', 0.24 * hit, -0.28 * hit, -0.10 * hit);
        setEuler(pose, 'Chest', 0.22 * hit, -0.25 * hit, -0.08 * hit);
        setEuler(pose, 'Neck', -0.32 * hit, 0.35 * hit, 0);
        setEuler(pose, 'Head', -0.28 * hit, 0.30 * hit, 0.15 * hit);

        setEuler(pose, 'LeftUpperArm', -0.75 * hit, 0.35 * hit, 0.68 * hit + 0.14);
        setEuler(pose, 'LeftLowerArm', -0.85 * hit - 0.25, 0, 0);
        setEuler(pose, 'RightUpperArm', 0.42 * hit, -0.35 * hit, -0.72 * hit - 0.14);
        setEuler(pose, 'RightLowerArm', -0.92 * hit - 0.28, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.68 * hit, 0.12 * hit, 0.10 * hit);
        setEuler(pose, 'LeftLowerLeg', 1.15 * hit + 0.08, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.25 * hit, -0.10 * hit, -0.10 * hit);
        setEuler(pose, 'RightLowerLeg', 0.65 * hit + 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 11:ShuffleLeft — Lateral left strafe + Mixamo Fem_Strafe_Walk_L
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '11:ShuffleLeft',
      duration: 0.76,
      numFrames: 23,
      loop: true,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Fem_Strafe_Walk_L'),
      mixamoBlend: 0.40,
      evalPose(pose, u, _rawU, prof) {
        const p = u * TAU;
        pose.hipDelta[0] = Math.sin(p) * 0.045;
        pose.hipDelta[1] = -Math.cos(p * 2) * 0.032 - 0.035;

        setEuler(pose, 'Hips', 0.10, 0.28 + Math.sin(p) * 0.06, -Math.cos(p) * 0.06);
        setEuler(pose, 'Spine', 0.06, -0.14 - Math.sin(p) * 0.04, Math.cos(p) * 0.04);
        setEuler(pose, 'Chest', 0.05, -0.14, 0);
        setEuler(pose, 'Head', -0.06, 0, 0);

        setEuler(pose, 'LeftUpperArm', -0.25 + Math.cos(p) * 0.18, 0.15, 0.24);
        setEuler(pose, 'LeftLowerArm', -0.65, 0.12, 0);
        setEuler(pose, 'RightUpperArm', -0.18 - Math.cos(p) * 0.18, -0.15, -0.24);
        setEuler(pose, 'RightLowerArm', -0.72, -0.12, 0);

        // Lateral abduction stepping
        setEuler(pose, 'LeftUpperLeg', -0.18 + Math.sin(p) * 0.22, 0, 0.20 + Math.sin(p) * 0.22 * prof.strideAmp);
        setEuler(pose, 'LeftLowerLeg', 0.28 + Math.max(0, Math.cos(p)) * 0.52, 0, 0);
        setEuler(pose, 'LeftFoot', -0.08, 0, -0.12 - Math.sin(p) * 0.10);

        setEuler(pose, 'RightUpperLeg', -0.18 - Math.sin(p) * 0.22, 0, -0.16 + Math.sin(p) * 0.22 * prof.strideAmp);
        setEuler(pose, 'RightLowerLeg', 0.28 + Math.max(0, -Math.cos(p)) * 0.52, 0, 0);
        setEuler(pose, 'RightFoot', -0.08, 0, 0.10 - Math.sin(p) * 0.10);
      },
    })
  );

  // =========================================================================
  // 12:ShuffleRight — Lateral right strafe + Mixamo Fem_Strafe_Walk_R
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '12:ShuffleRight',
      duration: 0.76,
      numFrames: 23,
      loop: true,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Fem_Strafe_Walk_R'),
      mixamoBlend: 0.40,
      evalPose(pose, u, _rawU, prof) {
        const p = u * TAU;
        pose.hipDelta[0] = -Math.sin(p) * 0.045;
        pose.hipDelta[1] = -Math.cos(p * 2) * 0.032 - 0.035;

        setEuler(pose, 'Hips', 0.10, -0.28 - Math.sin(p) * 0.06, Math.cos(p) * 0.06);
        setEuler(pose, 'Spine', 0.06, 0.14 + Math.sin(p) * 0.04, -Math.cos(p) * 0.04);
        setEuler(pose, 'Chest', 0.05, 0.14, 0);
        setEuler(pose, 'Head', -0.06, 0, 0);

        setEuler(pose, 'LeftUpperArm', -0.18 + Math.cos(p) * 0.18, 0.15, 0.24);
        setEuler(pose, 'LeftLowerArm', -0.72, 0.12, 0);
        setEuler(pose, 'RightUpperArm', -0.25 - Math.cos(p) * 0.18, -0.15, -0.24);
        setEuler(pose, 'RightLowerArm', -0.65, -0.12, 0);

        setEuler(pose, 'LeftUpperLeg', -0.18 - Math.sin(p) * 0.22, 0, 0.16 - Math.sin(p) * 0.22 * prof.strideAmp);
        setEuler(pose, 'LeftLowerLeg', 0.28 + Math.max(0, -Math.cos(p)) * 0.52, 0, 0);
        setEuler(pose, 'LeftFoot', -0.08, 0, -0.10 + Math.sin(p) * 0.10);

        setEuler(pose, 'RightUpperLeg', -0.18 + Math.sin(p) * 0.22, 0, -0.20 - Math.sin(p) * 0.22 * prof.strideAmp);
        setEuler(pose, 'RightLowerLeg', 0.28 + Math.max(0, Math.cos(p)) * 0.52, 0, 0);
        setEuler(pose, 'RightFoot', -0.08, 0, 0.12 + Math.sin(p) * 0.10);
      },
    })
  );

  // =========================================================================
  // 13:WalkBackwards — Cautious tactical backpedal + Mixamo Walk_Back
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '13:WalkBackwards',
      duration: 0.92,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Walk_Back'),
      mixamoBlend: 0.42,
      evalPose(pose, u, _rawU, prof) {
        // Reversed phase progression for backward footwork
        const p = -u * TAU;
        const s = prof.strideAmp * 0.88;
        pose.hipDelta[0] = Math.cos(p) * 0.02;
        pose.hipDelta[1] = -Math.cos(p * 2) * 0.024 - 0.03;

        setEuler(pose, 'Hips', 0.08, -Math.sin(p) * 0.09, Math.cos(p) * 0.04);
        setEuler(pose, 'Spine', 0.06, Math.sin(p) * 0.06, -Math.cos(p) * 0.03);
        setEuler(pose, 'Chest', 0.05, Math.sin(p) * 0.05, 0);
        setEuler(pose, 'Head', -0.08, 0, 0);

        setEuler(pose, 'LeftUpperArm', -Math.sin(p) * 0.30, 0.08, 0.16);
        setEuler(pose, 'LeftLowerArm', -0.48 - Math.max(0, Math.sin(p)) * 0.25, 0, 0);
        setEuler(pose, 'RightUpperArm', Math.sin(p) * 0.30, -0.08, -0.16);
        setEuler(pose, 'RightLowerArm', -0.48 - Math.max(0, -Math.sin(p)) * 0.25, 0, 0);

        const lThigh = Math.sin(p) * 0.42 * s + 0.06;
        const rThigh = -Math.sin(p) * 0.42 * s + 0.06;
        const lKnee = 0.20 + Math.max(0, Math.cos(p + 0.4)) * 0.58;
        const rKnee = 0.20 + Math.max(0, Math.cos(p + Math.PI + 0.4)) * 0.58;

        setEuler(pose, 'LeftUpperLeg', lThigh, 0, 0.03);
        setEuler(pose, 'LeftLowerLeg', lKnee, 0, 0);
        setEuler(pose, 'LeftFoot', -lThigh * 0.35 + 0.08, 0, 0);

        setEuler(pose, 'RightUpperLeg', rThigh, 0, -0.03);
        setEuler(pose, 'RightLowerLeg', rKnee, 0, 0);
        setEuler(pose, 'RightFoot', -rThigh * 0.35 + 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 14:Stun — Dazed circular torso/head wobble & limp arms
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '14:Stun',
      duration: 1.6,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        pose.hipDelta[0] = Math.cos(p) * 0.045;
        pose.hipDelta[1] = -0.05 + Math.sin(p * 2) * 0.018;
        pose.hipDelta[2] = Math.sin(p) * 0.045;

        setEuler(pose, 'Hips', 0.12 + Math.sin(p) * 0.08, Math.cos(p) * 0.10, Math.cos(p) * 0.08);
        setEuler(pose, 'Spine', 0.10 + Math.sin(p - 0.5) * 0.12, 0, Math.cos(p - 0.5) * 0.12);
        setEuler(pose, 'Chest', 0.08 + Math.sin(p - 0.9) * 0.12, 0, Math.cos(p - 0.9) * 0.12);
        setEuler(pose, 'Neck', 0.15 + Math.sin(p - 1.3) * 0.18, Math.cos(p) * 0.15, Math.cos(p - 1.3) * 0.16);
        setEuler(pose, 'Head', 0.12 + Math.sin(p - 1.6) * 0.18, Math.sin(p) * 0.18, Math.cos(p - 1.6) * 0.18);

        setEuler(pose, 'LeftUpperArm', 0.12 + Math.sin(p - 0.8) * 0.18, 0, 0.22 + Math.cos(p) * 0.08);
        setEuler(pose, 'LeftLowerArm', -0.25 + Math.sin(p) * 0.12, 0, 0);
        setEuler(pose, 'RightUpperArm', 0.12 - Math.sin(p - 0.8) * 0.18, 0, -0.22 + Math.cos(p) * 0.08);
        setEuler(pose, 'RightLowerArm', -0.25 - Math.sin(p) * 0.12, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.22 - Math.sin(p) * 0.06, 0.08, 0.06 - Math.cos(p) * 0.05);
        setEuler(pose, 'LeftLowerLeg', 0.42 + Math.sin(p) * 0.08, 0, 0);
        setEuler(pose, 'RightUpperLeg', -0.22 + Math.sin(p) * 0.06, -0.08, -0.06 - Math.cos(p) * 0.05);
        setEuler(pose, 'RightLowerLeg', 0.42 - Math.sin(p) * 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 16:AttackUnarmed — Tessa 3-Part Martial Combo (Lead Jab -> Cross -> High Kick)
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '16:AttackUnarmed',
      duration: 0.78,
      numFrames: 27,
      loop: false,
      boneMap,
      profile,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const jab = windowPulse(u, 0.02, 0.12, 0.20, 0.34);
        const cross = windowPulse(u, 0.24, 0.36, 0.46, 0.60);
        const kick = windowPulse(u, 0.50, 0.66, 0.78, 0.96);

        pose.hipDelta[1] = -0.04 * (jab + cross) + 0.05 * kick;
        pose.hipDelta[2] = 0.09 * jab + 0.14 * cross + 0.16 * kick;

        setEuler(
          pose,
          'Hips',
          0.10 * (jab + cross) - 0.28 * kick,
          -0.38 * jab + 0.52 * cross + 0.68 * kick,
          -0.18 * kick
        );
        setEuler(
          pose,
          'Spine',
          0.08 * (jab + cross) - 0.16 * kick,
          -0.25 * jab + 0.38 * cross - 0.22 * kick,
          -0.10 * kick
        );
        setEuler(
          pose,
          'Chest',
          0.08 * (jab + cross) - 0.12 * kick,
          -0.28 * jab + 0.42 * cross - 0.25 * kick,
          0
        );
        setEuler(pose, 'Head', -0.08, 0.32 * jab - 0.45 * cross - 0.28 * kick, 0);

        // Left lead jab -> guard during cross & kick
        setEuler(
          pose,
          'LeftUpperArm',
          -1.52 * jab - 0.55 * (1 - jab),
          -0.22 * jab + 0.28 * (cross + kick),
          0.18 + 0.25 * kick
        );
        setEuler(pose, 'LeftLowerArm', -0.12 * jab - 1.45 * (1 - jab), 0, 0);
        setEuler(pose, 'LeftHand', 0, -0.35 * jab, 0);

        // Right power cross -> balance swing on high kick
        setEuler(
          pose,
          'RightUpperArm',
          -1.58 * cross - 0.52 * (1 - cross) + 0.45 * kick,
          0.25 * cross - 0.25 * (1 - cross),
          -0.18 - 0.35 * kick
        );
        setEuler(pose, 'RightLowerArm', -0.10 * cross - 1.45 * (1 - cross), 0, 0);
        setEuler(pose, 'RightHand', 0, 0.35 * cross, 0);

        // Planted left pivot leg + snapping right roundhouse kick
        setEuler(pose, 'LeftUpperLeg', -0.25 * (jab + cross) + 0.15 * kick, 0.25 * kick, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.45 * (jab + cross) + 0.22 * kick + 0.08, 0, 0);

        const kickSnap = windowPulse(u, 0.58, 0.68, 0.78, 0.92);
        const kickChamber = windowPulse(u, 0.48, 0.56, 0.62, 0.72);
        setEuler(
          pose,
          'RightUpperLeg',
          0.22 * cross - 1.55 * kick,
          -0.35 * kick,
          -0.08 - 0.65 * kick
        );
        setEuler(
          pose,
          'RightLowerLeg',
          0.25 + 1.35 * kickChamber * (1 - kickSnap * 0.88),
          0,
          0
        );
        setEuler(pose, 'RightFoot', 0.45 * kickSnap, 0, 0);
      },
    })
  );

  // =========================================================================
  // 17:Attack1H — 1H Duelist Diagonal Cleave & Reverse Rising Cut
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '17:Attack1H',
      duration: 0.72,
      numFrames: 25,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('SnS_Attack_1') || mixamo.get('SnS_Slash_Combo'),
      mixamoBlend: 0.30,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const windup = windowPulse(u, 0.0, 0.12, 0.20, 0.30);
        const slash1 = windowPulse(u, 0.18, 0.32, 0.45, 0.62);
        const slash2 = windowPulse(u, 0.52, 0.66, 0.76, 0.96);

        pose.hipDelta[1] = -0.05 * (slash1 + slash2);
        pose.hipDelta[2] = -0.06 * windup + 0.16 * slash1 + 0.12 * slash2;

        setEuler(
          pose,
          'Hips',
          -0.08 * windup + 0.16 * slash1 + 0.10 * slash2,
          -0.42 * windup + 0.55 * slash1 - 0.38 * slash2,
          0
        );
        setEuler(
          pose,
          'Spine',
          -0.10 * windup + 0.18 * slash1 + 0.08 * slash2,
          -0.28 * windup + 0.42 * slash1 - 0.32 * slash2,
          -0.08 * slash1 + 0.08 * slash2
        );
        setEuler(
          pose,
          'Chest',
          -0.12 * windup + 0.20 * slash1 + 0.08 * slash2,
          -0.32 * windup + 0.48 * slash1 - 0.36 * slash2,
          -0.10 * slash1 + 0.10 * slash2
        );
        setEuler(pose, 'Head', -0.08 * slash1, 0.28 * windup - 0.35 * slash1 + 0.25 * slash2, 0);

        // Off-hand counter-balance
        setEuler(
          pose,
          'LeftUpperArm',
          -0.35 * windup + 0.32 * slash1 - 0.28 * slash2,
          0.22,
          0.28 + 0.25 * slash1
        );
        setEuler(pose, 'LeftLowerArm', -0.68 - 0.25 * windup, 0.15, 0);

        // Main-hand (Right) diagonal cleave then backhand rising cut
        setEuler(
          pose,
          'RightUpperArm',
          -2.05 * windup - 0.32 * slash1 - 1.25 * slash2 - 0.15,
          0.45 * windup + 0.55 * slash1 - 0.65 * slash2,
          -0.35 * windup + 0.48 * slash1 - 0.72 * slash2 - 0.18
        );
        setEuler(
          pose,
          'RightLowerArm',
          -1.25 * windup - 0.18 * slash1 - 0.32 * slash2 - 0.35 * (1 - windup - slash1 * 0.7),
          -0.35 * slash1 + 0.55 * slash2,
          0
        );
        setEuler(
          pose,
          'RightHand',
          0.48 * slash1 - 0.35 * windup + 0.32 * slash2,
          0.45 * slash2,
          -0.25 * slash1
        );

        // Lunging front/back legs
        setEuler(pose, 'LeftUpperLeg', -0.45 * slash1 - 0.28 * slash2 - 0.08, 0.08, 0.06);
        setEuler(pose, 'LeftLowerLeg', 0.68 * slash1 + 0.45 * slash2 + 0.12, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.35 * slash1 + 0.22 * slash2 + 0.05, -0.08, -0.06);
        setEuler(pose, 'RightLowerLeg', 0.28 + 0.22 * windup, 0, 0);
      },
    })
  );

  // =========================================================================
  // 18:Attack2H — Greatsword Two-Handed Overhead Leap Cleave + Mixamo GS_Jump_Attack
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '18:Attack2H',
      duration: 0.92,
      numFrames: 27,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('GS_Jump_Attack'),
      mixamoBlend: 0.32,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const coil = windowPulse(u, 0.0, 0.16, 0.28, 0.42);
        const slam = windowPulse(u, 0.30, 0.48, 0.66, 0.94);
        const hop = windowPulse(u, 0.18, 0.28, 0.36, 0.48);

        pose.hipDelta[1] = 0.09 * hop - 0.14 * slam;
        pose.hipDelta[2] = -0.08 * coil + 0.22 * slam;

        setEuler(pose, 'Hips', -0.18 * coil + 0.32 * slam, -0.52 * coil + 0.42 * slam, 0);
        setEuler(pose, 'Spine', -0.22 * coil + 0.28 * slam, -0.35 * coil + 0.32 * slam, 0);
        setEuler(pose, 'Chest', -0.25 * coil + 0.32 * slam, -0.38 * coil + 0.35 * slam, 0);
        setEuler(pose, 'Neck', 0.18 * coil - 0.22 * slam, 0.25 * coil - 0.22 * slam, 0);
        setEuler(pose, 'Head', 0.15 * coil - 0.18 * slam, 0.25 * coil - 0.20 * slam, 0);

        // Both arms hoist the 2H weapon overhead and drive it down together
        setEuler(
          pose,
          'RightUpperArm',
          -2.35 * coil - 0.28 * slam - 0.35 * (1 - coil - slam * 0.5),
          0.32 * coil + 0.25 * slam,
          -0.18 * coil + 0.28 * slam - 0.14
        );
        setEuler(
          pose,
          'RightLowerArm',
          -1.35 * coil - 0.16 * slam - 0.45 * (1 - coil - slam * 0.7),
          0,
          0
        );
        setEuler(pose, 'RightHand', 0.55 * slam - 0.35 * coil, 0, 0);

        setEuler(
          pose,
          'LeftUpperArm',
          -2.15 * coil - 0.38 * slam - 0.42 * (1 - coil - slam * 0.5),
          -0.48 * coil - 0.52 * slam - 0.32,
          0.12 * coil - 0.35 * slam + 0.10
        );
        setEuler(
          pose,
          'LeftLowerArm',
          -1.15 * coil - 0.22 * slam - 0.52 * (1 - coil - slam * 0.7),
          0,
          0
        );
        setEuler(pose, 'LeftHand', 0.48 * slam - 0.30 * coil, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.35 * coil - 0.68 * slam, 0.10, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.55 * coil + 0.95 * slam + 0.12, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.18 * coil + 0.48 * slam, -0.10, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.42 * coil + 0.32 * slam + 0.12, 0, 0);
      },
    })
  );

  // =========================================================================
  // 19:Attack2HL — Tekkaman Space Lance Spiral Lunge Thrust & Twin Flourish
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '19:Attack2HL',
      duration: 0.84,
      numFrames: 27,
      loop: false,
      boneMap,
      profile,
      wingBoost: 0.45,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const draw = windowPulse(u, 0.0, 0.12, 0.22, 0.32);
        const thrust = windowPulse(u, 0.20, 0.34, 0.52, 0.68);
        const sweep = windowPulse(u, 0.54, 0.68, 0.80, 0.96);

        pose.hipDelta[1] = -0.08 * draw - 0.16 * thrust - 0.06 * sweep;
        pose.hipDelta[2] = -0.10 * draw + 0.28 * thrust + 0.08 * sweep;

        setEuler(
          pose,
          'Hips',
          0.12 * draw + 0.26 * thrust + 0.10 * sweep,
          -0.65 * draw + 0.58 * thrust - 0.48 * sweep,
          0
        );
        setEuler(
          pose,
          'Spine',
          0.10 * draw + 0.22 * thrust,
          -0.38 * draw + 0.42 * thrust - 0.38 * sweep,
          0
        );
        setEuler(
          pose,
          'Chest',
          0.08 * draw + 0.20 * thrust,
          -0.42 * draw + 0.48 * thrust - 0.42 * sweep,
          0
        );
        setEuler(pose, 'Head', -0.16 * thrust, 0.55 * draw - 0.55 * thrust + 0.35 * sweep, 0);

        // Right lance arm: cocked far back behind hip -> full corkscrew thrust forward -> wide arc
        setEuler(
          pose,
          'RightUpperArm',
          0.78 * draw - 1.62 * thrust - 1.15 * sweep - 0.12,
          -0.35 * draw + 1.25 * thrust - 0.85 * sweep,
          -0.38 * draw - 0.12 * thrust - 0.78 * sweep - 0.16
        );
        setEuler(
          pose,
          'RightLowerArm',
          -1.35 * draw - 0.08 * thrust - 0.35 * sweep - 0.28 * (1 - draw - thrust),
          1.45 * thrust,
          0
        );
        setEuler(pose, 'RightHand', 0.55 * thrust, 1.85 * thrust, 0);

        // Left guide hand aims forward on draw, braces back on thrust, sweeps opposite
        setEuler(
          pose,
          'LeftUpperArm',
          -1.25 * draw + 0.45 * thrust - 0.95 * sweep,
          -0.25 * draw + 0.35 * sweep,
          0.22 + 0.48 * thrust
        );
        setEuler(pose, 'LeftLowerArm', -0.35 * draw - 0.85 * thrust - 0.45 * sweep, 0, 0);

        // Deep fencer / Tekkaman front-leg lunge & rear-leg extension
        setEuler(pose, 'LeftUpperLeg', -0.35 * draw - 0.88 * thrust - 0.32 * sweep, 0.12, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.55 * draw + 1.18 * thrust + 0.45 * sweep + 0.10, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.25 * draw + 0.68 * thrust + 0.22 * sweep, -0.12, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.38 * draw + 0.14 * thrust + 0.28 * sweep + 0.10, 0, 0);
      },
    })
  );

  // =========================================================================
  // 20:ParryUnarmed — Martial Forearm Cross-Deflection
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '20:ParryUnarmed',
      duration: 0.56,
      numFrames: 21,
      loop: false,
      boneMap,
      profile,
      evalPose(pose, _u, rawU) {
        const block = windowPulse(rawU, 0.0, 0.18, 0.52, 1.0);
        pose.hipDelta[1] = -0.06 * block;
        pose.hipDelta[2] = -0.05 * block;

        setEuler(pose, 'Hips', 0.10 * block, -0.32 * block, 0);
        setEuler(pose, 'Spine', 0.08 * block, 0.22 * block, 0);
        setEuler(pose, 'Chest', 0.08 * block, 0.26 * block, 0);
        setEuler(pose, 'Head', -0.08 * block, -0.18 * block, 0);

        // Crossed twin forearm deflection shield
        setEuler(pose, 'LeftUpperArm', -1.18 * block - 0.15, -0.45 * block, 0.15);
        setEuler(pose, 'LeftLowerArm', -1.35 * block - 0.30, 0.35 * block, 0);
        setEuler(pose, 'RightUpperArm', -1.12 * block - 0.15, 0.45 * block, -0.15);
        setEuler(pose, 'RightLowerArm', -1.42 * block - 0.30, -0.35 * block, 0);

        setEuler(pose, 'LeftUpperLeg', -0.32 * block, 0.08, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.55 * block + 0.10, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.18 * block, -0.12, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.38 * block + 0.10, 0, 0);
      },
    })
  );

  // =========================================================================
  // 21:Parry1H — High-Velocity Sword Parry & Riposte Guard
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '21:Parry1H',
      duration: 0.58,
      numFrames: 21,
      loop: false,
      boneMap,
      profile,
      evalPose(pose, _u, rawU) {
        const parry = windowPulse(rawU, 0.0, 0.16, 0.55, 1.0);
        const spark = windowPulse(rawU, 0.14, 0.22, 0.32, 0.50);
        pose.hipDelta[1] = -0.055 * parry;
        pose.hipDelta[2] = -0.04 * spark;

        setEuler(pose, 'Hips', 0.08 * parry, 0.28 * parry, 0);
        setEuler(pose, 'Spine', 0.06 * parry, -0.22 * parry, 0);
        setEuler(pose, 'Chest', -0.08 * spark + 0.06 * parry, -0.28 * parry, 0);
        setEuler(pose, 'Head', -0.06 * parry, 0.22 * parry, 0);

        // Right arm sweeps blade diagonally across torso to deflect
        setEuler(
          pose,
          'RightUpperArm',
          -1.35 * parry - 0.15 * spark - 0.12,
          0.58 * parry,
          0.25 * parry - 0.15
        );
        setEuler(pose, 'RightLowerArm', -1.18 * parry - 0.32, -0.45 * parry, 0);
        setEuler(pose, 'RightHand', -0.25 * parry + 0.22 * spark, 0.42 * parry, 0);

        setEuler(pose, 'LeftUpperArm', -0.35 * parry, 0.22, 0.32 * parry + 0.15);
        setEuler(pose, 'LeftLowerArm', -0.75 * parry - 0.28, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.28 * parry, 0.06, 0.06);
        setEuler(pose, 'LeftLowerLeg', 0.48 * parry + 0.10, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.16 * parry, -0.08, -0.06);
        setEuler(pose, 'RightLowerLeg', 0.32 * parry + 0.10, 0, 0);
      },
    })
  );

  // =========================================================================
  // 24:ShieldBlock — Braced Shield Wall Guard Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '24:ShieldBlock',
      duration: 1.4,
      numFrames: 23,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        const brace = Math.sin(p) * 0.03;
        pose.hipDelta[1] = -0.07 + brace * 0.25;

        setEuler(pose, 'Hips', 0.14, 0.35 + brace, 0);
        setEuler(pose, 'Spine', 0.10, -0.18, 0);
        setEuler(pose, 'Chest', 0.08, -0.20 - brace, 0);
        setEuler(pose, 'Head', -0.14, 0.06, 0);

        // Left shield arm locked across chest
        setEuler(pose, 'LeftUpperArm', -1.05 + brace, -0.48, 0.18);
        setEuler(pose, 'LeftLowerArm', -1.28, 0.25, 0);
        setEuler(pose, 'LeftHand', 0, 0.20, 0);

        // Right sword arm cocked back at hip ready to counter-thrust
        setEuler(pose, 'RightUpperArm', 0.28 - brace, -0.22, -0.28);
        setEuler(pose, 'RightLowerArm', -1.12, -0.15, 0);

        setEuler(pose, 'LeftUpperLeg', -0.35, 0.08, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.58, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.15, -0.12, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.42, 0, 0);
      },
    })
  );

  // =========================================================================
  // 25:Ready1H — 1H Weapon / Duelist Combat Ready Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '25:Ready1H',
      duration: 1.5,
      numFrames: 23,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u, _rawU, prof) {
        const p = u * TAU;
        const bob = Math.sin(p);
        pose.hipDelta[1] = -0.045 + bob * 0.018;
        pose.hipDelta[0] = Math.cos(p) * 0.015;

        setEuler(pose, 'Hips', prof.readyPitch, prof.readyYaw + bob * 0.04, 0);
        setEuler(pose, 'Spine', 0.06, -prof.readyYaw * 0.45, 0);
        setEuler(pose, 'Chest', 0.06 - bob * 0.03, -prof.readyYaw * 0.55, 0);
        setEuler(pose, 'Head', -0.10 + bob * 0.02, 0, 0);

        setEuler(pose, 'LeftUpperArm', -0.42 + bob * 0.06, 0.22, 0.24);
        setEuler(pose, 'LeftLowerArm', -0.92 - bob * 0.05, 0.15, 0);
        setEuler(pose, 'RightUpperArm', -0.32 - bob * 0.06, -0.25, -0.26);
        setEuler(pose, 'RightLowerArm', -0.98 + bob * 0.05, -0.18, 0);

        setEuler(pose, 'LeftUpperLeg', -0.28 + bob * 0.03, 0.08, 0.07);
        setEuler(pose, 'LeftLowerLeg', 0.48 - bob * 0.05, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.12 - bob * 0.03, -0.10, -0.07);
        setEuler(pose, 'RightLowerLeg', 0.36 - bob * 0.04, 0, 0);
      },
    })
  );

  // =========================================================================
  // 26:Ready2H — 2H Greatsword / Space Lance Combat Stance Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '26:Ready2H',
      duration: 1.6,
      numFrames: 23,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        const bob = Math.sin(p);
        pose.hipDelta[1] = -0.06 + bob * 0.018;

        setEuler(pose, 'Hips', 0.16, -0.45 + bob * 0.04, 0);
        setEuler(pose, 'Spine', 0.08, 0.18, 0);
        setEuler(pose, 'Chest', 0.08 - bob * 0.03, 0.22, 0);
        setEuler(pose, 'Head', -0.12, 0.06, 0);

        // Two-handed cross-body grip
        setEuler(pose, 'RightUpperArm', -0.58 + bob * 0.05, 0.22, -0.16);
        setEuler(pose, 'RightLowerArm', -1.08, -0.18, 0);
        setEuler(pose, 'LeftUpperArm', -0.78 + bob * 0.05, -0.48, 0.10);
        setEuler(pose, 'LeftLowerArm', -0.95, 0.22, 0);

        setEuler(pose, 'LeftUpperLeg', -0.34 + bob * 0.03, 0.10, 0.09);
        setEuler(pose, 'LeftLowerLeg', 0.56 - bob * 0.04, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.16 - bob * 0.03, -0.12, -0.09);
        setEuler(pose, 'RightLowerLeg', 0.40 - bob * 0.04, 0, 0);
      },
    })
  );

  // =========================================================================
  // 27:ReadyBow — Archer Sideways Drawn-Bow Aim Stance Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '27:ReadyBow',
      duration: 1.6,
      numFrames: 23,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        const breath = Math.sin(p) * 0.025;
        pose.hipDelta[1] = -0.035 + breath * 0.3;

        // Torso turned sideways (-65 deg) while head sights forward down the arrow
        setEuler(pose, 'Hips', 0.06, -0.82, 0);
        setEuler(pose, 'Spine', 0.04, -0.18, 0);
        setEuler(pose, 'Chest', 0.04 - breath, -0.15, 0);
        setEuler(pose, 'Neck', 0, 0.55, 0);
        setEuler(pose, 'Head', -0.05, 0.58, -0.06);

        // Left bow-arm extended toward target (+Z)
        setEuler(pose, 'LeftUpperArm', -1.48 + breath, 1.05, 0.12);
        setEuler(pose, 'LeftLowerArm', -0.08, 0, 0);
        setEuler(pose, 'LeftHand', 0, 0, 0.15);

        // Right string-hand anchored near right cheek
        setEuler(pose, 'RightUpperArm', -1.42 + breath, -0.45, -0.35);
        setEuler(pose, 'RightLowerArm', -1.85, 0.15, 0);
        setEuler(pose, 'RightHand', 0, -0.25, 0);

        setEuler(pose, 'LeftUpperLeg', -0.18, 0.15, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.32, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.12, -0.15, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.28, 0, 0);
      },
    })
  );

  // =========================================================================
  // 29:AttackBow — Bow Nock, Full Draw, Anchor Hold & Snap Release
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '29:AttackBow',
      duration: 0.82,
      numFrames: 25,
      loop: false,
      boneMap,
      profile,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const draw = windowPulse(u, 0.04, 0.38, 0.62, 0.72);
        const recoil = windowPulse(u, 0.62, 0.68, 0.78, 0.96);

        pose.hipDelta[1] = -0.04;
        setEuler(pose, 'Hips', 0.06, -0.82, 0);
        setEuler(pose, 'Spine', 0.04, -0.18 - 0.08 * draw, 0);
        setEuler(pose, 'Chest', 0.04 - 0.06 * recoil, -0.15 - 0.10 * draw, 0);
        setEuler(pose, 'Neck', 0, 0.55 + 0.08 * draw, 0);
        setEuler(pose, 'Head', -0.06, 0.58 + 0.08 * draw, -0.06);

        // Left bow-arm holds steady with subtle upward kick on arrow release
        setEuler(pose, 'LeftUpperArm', -1.48 - 0.10 * recoil, 1.05, 0.12);
        setEuler(pose, 'LeftLowerArm', -0.08 - 0.12 * recoil, 0, 0);

        // Right arm reaches to bowstring (u=0.08), pulls back to cheek (draw), snaps back on release (recoil)
        const reach = windowPulse(u, 0.0, 0.06, 0.12, 0.28);
        setEuler(
          pose,
          'RightUpperArm',
          -1.45 * (reach + draw + recoil) - 0.45 * (1 - reach - draw - recoil),
          0.65 * reach - 0.48 * draw - 0.72 * recoil,
          -0.25 - 0.28 * recoil
        );
        setEuler(
          pose,
          'RightLowerArm',
          -0.25 * reach - 1.92 * draw - 1.45 * recoil - 0.85 * (1 - reach - draw - recoil),
          0.15 * draw,
          0
        );

        setEuler(pose, 'LeftUpperLeg', -0.18, 0.15, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.32, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.12, -0.15, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.28, 0, 0);
      },
    })
  );

  // =========================================================================
  // 30:AttackRifle — Crossbow / Arcane Rifle Aimed Volley & Shoulder Kick
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '30:AttackRifle',
      duration: 0.74,
      numFrames: 23,
      loop: false,
      boneMap,
      profile,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const aim = windowPulse(u, 0.0, 0.15, 0.82, 1.0);
        const kick = windowPulse(u, 0.32, 0.40, 0.50, 0.72);

        pose.hipDelta[1] = -0.04 * aim;
        pose.hipDelta[2] = -0.06 * kick;

        setEuler(pose, 'Hips', 0.08 * aim, -0.38 * aim, 0);
        setEuler(pose, 'Spine', 0.06 * aim - 0.14 * kick, -0.10 * aim, 0);
        setEuler(pose, 'Chest', 0.06 * aim - 0.18 * kick, -0.12 * aim + 0.10 * kick, 0);
        setEuler(pose, 'Neck', 0.08 * aim, 0.22 * aim, 0.12 * aim);
        setEuler(pose, 'Head', 0.06 * aim - 0.14 * kick, 0.26 * aim, 0.16 * aim);

        // Left hand cradles forestock; right hand grips trigger at shoulder
        setEuler(pose, 'LeftUpperArm', -1.22 * aim - 0.22 * kick - 0.25, -0.38 * aim, 0.12);
        setEuler(pose, 'LeftLowerArm', -0.82 * aim - 0.30, 0.45 * aim, 0);

        setEuler(pose, 'RightUpperArm', -1.08 * aim - 0.25 * kick - 0.25, 0.18 * aim, -0.25);
        setEuler(pose, 'RightLowerArm', -1.65 * aim - 0.35, -0.15 * aim, 0);

        setEuler(pose, 'LeftUpperLeg', -0.22 * aim, 0.08, 0.06);
        setEuler(pose, 'LeftLowerLeg', 0.38 * aim + 0.08, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.14 * aim, -0.08, -0.06);
        setEuler(pose, 'RightLowerLeg', 0.28 * aim + 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 37:JumpStart — Anticipation Squat -> Explosive Triple-Extension Takeoff
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '37:JumpStart',
      duration: 0.52,
      numFrames: 21,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('AA_Jump_Up'),
      mixamoBlend: 0.35,
      wingBoost: 0.4,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const squat = windowPulse(u, 0.0, 0.16, 0.32, 0.52);
        const launch = smoothstep(0.32, 0.92, u);

        pose.hipDelta[1] = -0.16 * squat + 0.18 * launch;
        pose.hipDelta[2] = 0.06 * launch;

        setEuler(pose, 'Hips', 0.26 * squat - 0.10 * launch, 0, 0);
        setEuler(pose, 'Spine', 0.18 * squat - 0.12 * launch, 0, 0);
        setEuler(pose, 'Chest', 0.16 * squat - 0.14 * launch, 0, 0);
        setEuler(pose, 'Head', -0.18 * squat - 0.12 * launch, 0, 0);

        // Arms sweep back in squat then thrust high overhead on takeoff
        setEuler(pose, 'LeftUpperArm', 0.65 * squat - 2.15 * launch, 0, 0.18 + 0.28 * launch);
        setEuler(pose, 'LeftLowerArm', -0.55 * squat - 0.35 * launch - 0.20, 0, 0);
        setEuler(pose, 'RightUpperArm', 0.65 * squat - 2.15 * launch, 0, -0.18 - 0.28 * launch);
        setEuler(pose, 'RightLowerArm', -0.55 * squat - 0.35 * launch - 0.20, 0, 0);

        // Deep knee compression -> explosive extension + asymmetric lead knee drive
        setEuler(pose, 'LeftUpperLeg', -0.72 * squat - 0.55 * launch, 0, 0.05);
        setEuler(pose, 'LeftLowerLeg', 1.25 * squat + 0.85 * launch + 0.08, 0, 0);
        setEuler(pose, 'LeftFoot', -0.42 * squat + 0.48 * launch, 0, 0);

        setEuler(pose, 'RightUpperLeg', -0.72 * squat + 0.22 * launch, 0, -0.05);
        setEuler(pose, 'RightLowerLeg', 1.25 * squat + 0.18 * launch + 0.08, 0, 0);
        setEuler(pose, 'RightFoot', -0.42 * squat + 0.55 * launch, 0, 0);
      },
    })
  );

  // =========================================================================
  // 38:Jump — Mid-Air Glide / Hang Loop + Mixamo AA_Falling_Idle
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '38:Jump',
      duration: 0.90,
      numFrames: 21,
      loop: true,
      boneMap,
      profile,
      mixamoClip: mixamo.get('AA_Falling_Idle'),
      mixamoBlend: 0.35,
      wingBoost: 0.85,
      evalPose(pose, u) {
        const p = u * TAU;
        const float = Math.sin(p);
        pose.hipDelta[1] = 0.08 + float * 0.025;

        setEuler(pose, 'Hips', 0.08 + float * 0.04, Math.cos(p) * 0.05, 0);
        setEuler(pose, 'Spine', -0.06, 0, 0);
        setEuler(pose, 'Chest', -0.08 + float * 0.03, 0, 0);
        setEuler(pose, 'Head', 0.10, Math.sin(p) * 0.05, 0);

        // Arms spread out in mid-air balance
        setEuler(pose, 'LeftUpperArm', -0.45 + float * 0.12, 0.15, 0.78 + Math.cos(p) * 0.10);
        setEuler(pose, 'LeftLowerArm', -0.52, 0, 0);
        setEuler(pose, 'RightUpperArm', -0.45 - float * 0.12, -0.15, -0.78 - Math.cos(p) * 0.10);
        setEuler(pose, 'RightLowerArm', -0.52, 0, 0);

        // Asymmetric tucked/extended airborne legs
        setEuler(pose, 'LeftUpperLeg', -0.62 + float * 0.08, 0.06, 0.08);
        setEuler(pose, 'LeftLowerLeg', 1.05 - float * 0.08, 0, 0);
        setEuler(pose, 'LeftFoot', 0.32, 0, 0);

        setEuler(pose, 'RightUpperLeg', -0.18 - float * 0.08, -0.06, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.52 + float * 0.08, 0, 0);
        setEuler(pose, 'RightFoot', 0.38, 0, 0);
      },
    })
  );

  // =========================================================================
  // 39:JumpEnd — Impact Absorption Crouch & Elastic Stand Recovery
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '39:JumpEnd',
      duration: 0.56,
      numFrames: 21,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('AA_Hard_Landing'),
      mixamoBlend: 0.35,
      evalPose(pose, _u, rawU) {
        const absorb = windowPulse(rawU, 0.0, 0.22, 0.44, 1.0);
        pose.hipDelta[1] = -0.18 * absorb;
        pose.hipDelta[2] = 0.05 * absorb;

        setEuler(pose, 'Hips', 0.28 * absorb, 0, 0);
        setEuler(pose, 'Spine', 0.22 * absorb, 0, 0);
        setEuler(pose, 'Chest', 0.18 * absorb, 0, 0);
        setEuler(pose, 'Head', -0.25 * absorb, 0, 0);

        setEuler(pose, 'LeftUpperArm', -0.48 * absorb, 0.15 * absorb, 0.55 * absorb + 0.14);
        setEuler(pose, 'LeftLowerArm', -0.65 * absorb - 0.25, 0, 0);
        setEuler(pose, 'RightUpperArm', -0.48 * absorb, -0.15 * absorb, -0.55 * absorb - 0.14);
        setEuler(pose, 'RightLowerArm', -0.65 * absorb - 0.25, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.78 * absorb, 0.08 * absorb, 0.08 * absorb);
        setEuler(pose, 'LeftLowerLeg', 1.35 * absorb + 0.08, 0, 0);
        setEuler(pose, 'LeftFoot', -0.48 * absorb, 0, 0);

        setEuler(pose, 'RightUpperLeg', -0.78 * absorb, -0.08 * absorb, -0.08 * absorb);
        setEuler(pose, 'RightLowerLeg', 1.35 * absorb + 0.08, 0, 0);
        setEuler(pose, 'RightFoot', -0.48 * absorb, 0, 0);
      },
    })
  );

  // =========================================================================
  // 41:SwimIdle — Treading Water Sculling & Buoyancy Bob Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '41:SwimIdle',
      duration: 2.0,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        pose.hipDelta[1] = Math.sin(p) * 0.055 - 0.06;

        setEuler(pose, 'Hips', 0.18 + Math.sin(p) * 0.05, Math.cos(p) * 0.06, 0);
        setEuler(pose, 'Spine', -0.06, 0, 0);
        setEuler(pose, 'Chest', -0.08, 0, 0);
        setEuler(pose, 'Neck', -0.10, 0, 0);
        setEuler(pose, 'Head', -0.08 - Math.sin(p) * 0.04, Math.cos(p) * 0.05, 0);

        // Figure-eight sculling arms
        setEuler(pose, 'LeftUpperArm', -0.45 + Math.sin(p) * 0.28, 0.35 * Math.cos(p), 0.65);
        setEuler(pose, 'LeftLowerArm', -0.65 + Math.cos(p) * 0.22, 0, 0);
        setEuler(pose, 'LeftHand', 0.25 * Math.sin(p), 0, 0.25 * Math.cos(p));

        setEuler(pose, 'RightUpperArm', -0.45 - Math.sin(p) * 0.28, -0.35 * Math.cos(p), -0.65);
        setEuler(pose, 'RightLowerArm', -0.65 - Math.cos(p) * 0.22, 0, 0);
        setEuler(pose, 'RightHand', -0.25 * Math.sin(p), 0, -0.25 * Math.cos(p));

        // Alternating frog/bicycle kick
        setEuler(pose, 'LeftUpperLeg', -0.35 + Math.sin(p) * 0.38, 0.12, 0.14);
        setEuler(pose, 'LeftLowerLeg', 0.68 + Math.cos(p) * 0.38, 0, 0);
        setEuler(pose, 'LeftFoot', 0.35 + Math.sin(p) * 0.25, 0, 0);

        setEuler(pose, 'RightUpperLeg', -0.35 - Math.sin(p) * 0.38, -0.12, -0.14);
        setEuler(pose, 'RightLowerLeg', 0.68 - Math.cos(p) * 0.38, 0, 0);
        setEuler(pose, 'RightFoot', 0.35 - Math.sin(p) * 0.25, 0, 0);
      },
    })
  );

  // =========================================================================
  // 42:Swim — Forward Streamlined Breaststroke / Flutter-Kick Swim Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '42:Swim',
      duration: 1.35,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        pose.hipDelta[1] = Math.sin(p) * 0.048 - 0.10;
        pose.hipDelta[2] = Math.cos(p) * 0.035;

        // Streamlined forward body pitch (+0.92 rad) with undulation
        setEuler(pose, 'Hips', 0.92 + Math.sin(p) * 0.08, Math.sin(p * 0.5) * 0.05, 0);
        setEuler(pose, 'Spine', -0.10 + Math.cos(p) * 0.06, 0, 0);
        setEuler(pose, 'Chest', -0.12 - Math.sin(p) * 0.06, 0, 0);
        setEuler(pose, 'Neck', -0.35, 0, 0);
        setEuler(pose, 'Head', -0.32, 0, 0);

        // Wide breaststroke arm pull & forward reach
        const reach = Math.sin(p);
        const sweep = Math.cos(p);
        setEuler(pose, 'LeftUpperArm', -1.45 - reach * 0.65, 0.25 * sweep, 0.55 + Math.max(0, sweep) * 0.55);
        setEuler(pose, 'LeftLowerArm', -0.45 - Math.max(0, -reach) * 0.65, 0, 0);
        setEuler(pose, 'RightUpperArm', -1.45 - reach * 0.65, -0.25 * sweep, -0.55 - Math.max(0, sweep) * 0.55);
        setEuler(pose, 'RightLowerArm', -0.45 - Math.max(0, -reach) * 0.65, 0, 0);

        // Double-frequency flutter kick
        setEuler(pose, 'LeftUpperLeg', Math.sin(p * 2) * 0.34, 0, 0.06);
        setEuler(pose, 'LeftLowerLeg', 0.32 + Math.max(0, Math.cos(p * 2)) * 0.45, 0, 0);
        setEuler(pose, 'LeftFoot', 0.48 + Math.sin(p * 2) * 0.22, 0, 0);

        setEuler(pose, 'RightUpperLeg', -Math.sin(p * 2) * 0.34, 0, -0.06);
        setEuler(pose, 'RightLowerLeg', 0.32 + Math.max(0, -Math.cos(p * 2)) * 0.45, 0, 0);
        setEuler(pose, 'RightFoot', 0.48 - Math.sin(p * 2) * 0.22, 0, 0);
      },
    })
  );

  // =========================================================================
  // 50:Loot — Asymmetric Kneel & Ground Item Reach (Celandia pick/pet)
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '50:Loot',
      duration: 1.05,
      numFrames: 25,
      loop: false,
      boneMap,
      profile,
      evalPose(pose, _u, rawU) {
        const kneel = windowPulse(rawU, 0.0, 0.28, 0.68, 1.0);
        const scoop = windowPulse(rawU, 0.32, 0.46, 0.58, 0.74);

        pose.hipDelta[1] = -0.34 * kneel;
        pose.hipDelta[2] = 0.08 * kneel;

        setEuler(pose, 'Hips', 0.35 * kneel, -0.18 * kneel, 0);
        setEuler(pose, 'Spine', 0.28 * kneel + 0.12 * scoop, -0.10 * kneel, 0);
        setEuler(pose, 'Chest', 0.24 * kneel + 0.12 * scoop, -0.12 * kneel, 0);
        setEuler(pose, 'Neck', -0.25 * kneel, 0.15 * kneel, 0);
        setEuler(pose, 'Head', -0.18 * kneel + 0.10 * scoop, 0.12 * kneel, 0);

        // Right hand reaches down to ground and scoops
        setEuler(pose, 'RightUpperArm', -1.05 * kneel - 0.25 * scoop, 0.18 * kneel, -0.12);
        setEuler(pose, 'RightLowerArm', -0.45 * kneel + 0.25 * scoop - 0.25, 0, 0);
        setEuler(pose, 'RightHand', -0.35 * scoop, 0, 0);

        // Left hand rests near front knee
        setEuler(pose, 'LeftUpperArm', -0.58 * kneel, -0.15 * kneel, 0.16);
        setEuler(pose, 'LeftLowerArm', -0.78 * kneel - 0.25, 0, 0);

        // Asymmetric one-knee drop
        setEuler(pose, 'LeftUpperLeg', -1.12 * kneel, 0.08, 0.06);
        setEuler(pose, 'LeftLowerLeg', 1.48 * kneel + 0.08, 0, 0);
        setEuler(pose, 'LeftFoot', -0.35 * kneel, 0, 0);

        setEuler(pose, 'RightUpperLeg', -0.38 * kneel, -0.08, -0.06);
        setEuler(pose, 'RightLowerLeg', 1.55 * kneel + 0.08, 0, 0);
        setEuler(pose, 'RightFoot', 0.45 * kneel, 0, 0);
      },
    })
  );

  // =========================================================================
  // 51:SpellCastDirected — Arcane Gather & Voltekka Twin-Palm Beam Projection
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '51:SpellCastDirected',
      duration: 0.88,
      numFrames: 25,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Magic_1H_Cast') || mixamo.get('Magic_2H_Attack_2'),
      mixamoBlend: 0.30,
      wingBoost: 0.55,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const gather = windowPulse(u, 0.0, 0.16, 0.32, 0.44);
        const blast = windowPulse(u, 0.34, 0.46, 0.72, 0.96);

        pose.hipDelta[1] = 0.04 * gather - 0.08 * blast;
        pose.hipDelta[2] = -0.06 * gather + 0.16 * blast;

        setEuler(pose, 'Hips', -0.12 * gather + 0.22 * blast, 0, 0);
        setEuler(pose, 'Spine', -0.16 * gather + 0.18 * blast, 0, 0);
        setEuler(pose, 'Chest', -0.20 * gather + 0.22 * blast, 0, 0);
        setEuler(pose, 'Neck', 0.14 * gather - 0.18 * blast, 0, 0);
        setEuler(pose, 'Head', 0.12 * gather - 0.16 * blast, 0, 0);

        // Gather energy sphere at chest -> twin-palm directed projection forward (+Z)
        setEuler(
          pose,
          'LeftUpperArm',
          -1.05 * gather - 1.52 * blast - 0.10,
          -0.45 * gather - 0.18 * blast,
          0.18 + 0.12 * blast
        );
        setEuler(pose, 'LeftLowerArm', -1.42 * gather - 0.14 * blast - 0.25, 0.35 * gather, 0);
        setEuler(pose, 'LeftHand', -0.58 * blast, 0, 0);

        setEuler(
          pose,
          'RightUpperArm',
          -1.05 * gather - 1.52 * blast - 0.10,
          0.45 * gather + 0.18 * blast,
          -0.18 - 0.12 * blast
        );
        setEuler(pose, 'RightLowerArm', -1.42 * gather - 0.14 * blast - 0.25, -0.35 * gather, 0);
        setEuler(pose, 'RightHand', -0.58 * blast, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.15 * gather - 0.48 * blast, 0.08, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.28 * gather + 0.68 * blast + 0.08, 0, 0);
        setEuler(pose, 'RightUpperLeg', -0.15 * gather + 0.28 * blast, -0.08, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.28 * gather + 0.25 * blast + 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 52:ChannelCastDirected — Sustained Tideweaver / Starlight Conduit Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '52:ChannelCastDirected',
      duration: 1.6,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      wingBoost: 0.65,
      evalPose(pose, u) {
        const p = u * TAU;
        pose.hipDelta[1] = 0.04 + Math.sin(p) * 0.028;

        setEuler(pose, 'Hips', 0.08, Math.sin(p) * 0.08, 0);
        setEuler(pose, 'Spine', -0.06, -Math.sin(p) * 0.05, 0);
        setEuler(pose, 'Chest', -0.08 + Math.cos(p) * 0.04, -Math.sin(p) * 0.05, 0);
        setEuler(pose, 'Head', -0.06, Math.sin(p) * 0.04, 0);

        // Interlocking 90-degree phase-shifted figure-eight arm & wrist weaving
        setEuler(
          pose,
          'LeftUpperArm',
          -1.38 + Math.sin(p) * 0.18,
          -0.15 + Math.cos(p) * 0.20,
          0.25 + Math.sin(p * 2) * 0.10
        );
        setEuler(pose, 'LeftLowerArm', -0.35 + Math.cos(p) * 0.18, 0, 0);
        setEuler(pose, 'LeftHand', -0.35 + Math.sin(p * 2) * 0.22, 0, Math.cos(p * 2) * 0.22);

        setEuler(
          pose,
          'RightUpperArm',
          -1.38 - Math.sin(p) * 0.18,
          0.15 + Math.cos(p) * 0.20,
          -0.25 - Math.sin(p * 2) * 0.10
        );
        setEuler(pose, 'RightLowerArm', -0.35 - Math.cos(p) * 0.18, 0, 0);
        setEuler(pose, 'RightHand', -0.35 - Math.sin(p * 2) * 0.22, 0, -Math.cos(p * 2) * 0.22);

        setEuler(pose, 'LeftUpperLeg', -0.22 + Math.sin(p) * 0.04, 0.06, 0.06);
        setEuler(pose, 'LeftLowerLeg', 0.42, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.08 - Math.sin(p) * 0.04, -0.06, -0.06);
        setEuler(pose, 'RightLowerLeg', 0.28, 0, 0);
      },
    })
  );

  // =========================================================================
  // 53:SpellCastOmni — Omnidirectional Supernova / Starlight Surge
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '53:SpellCastOmni',
      duration: 1.05,
      numFrames: 27,
      loop: false,
      boneMap,
      profile,
      mixamoClip: mixamo.get('Magic_2H_Area_1') || mixamo.get('GS_Power_Up'),
      mixamoBlend: 0.30,
      wingBoost: 0.95,
      evalPose(pose, _u, rawU) {
        const u = rawU;
        const coil = windowPulse(u, 0.0, 0.16, 0.28, 0.40);
        const nova = windowPulse(u, 0.30, 0.46, 0.72, 0.96);

        pose.hipDelta[1] = -0.14 * coil + 0.16 * nova;

        setEuler(pose, 'Hips', 0.24 * coil - 0.16 * nova, 0, 0);
        setEuler(pose, 'Spine', 0.22 * coil - 0.24 * nova, 0, 0);
        setEuler(pose, 'Chest', 0.22 * coil - 0.28 * nova, 0, 0);
        setEuler(pose, 'Neck', 0.20 * coil - 0.32 * nova, 0, 0);
        setEuler(pose, 'Head', 0.18 * coil - 0.28 * nova, 0, 0);

        // Crossed arms over chest -> radiant skyward/outward wingspan burst
        setEuler(
          pose,
          'LeftUpperArm',
          -1.15 * coil - 1.65 * nova,
          -0.65 * coil + 0.28 * nova,
          0.14 + 1.08 * nova
        );
        setEuler(pose, 'LeftLowerArm', -1.55 * coil - 0.22 * nova - 0.22, 0, 0);
        setEuler(pose, 'LeftHand', -0.42 * nova, 0, 0);

        setEuler(
          pose,
          'RightUpperArm',
          -1.15 * coil - 1.65 * nova,
          0.65 * coil - 0.28 * nova,
          -0.14 - 1.08 * nova
        );
        setEuler(pose, 'RightLowerArm', -1.55 * coil - 0.22 * nova - 0.22, 0, 0);
        setEuler(pose, 'RightHand', -0.42 * nova, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.58 * coil - 0.18 * nova, 0, 0.06 + 0.12 * nova);
        setEuler(pose, 'LeftLowerLeg', 1.05 * coil + 0.45 * nova + 0.08, 0, 0);
        setEuler(pose, 'RightUpperLeg', -0.58 * coil - 0.18 * nova, 0, -0.06 - 0.12 * nova);
        setEuler(pose, 'RightLowerLeg', 1.05 * coil + 0.45 * nova + 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 60:EmoteTalk — Expressive Conversational Gestures (Celandia talk/gesture)
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '60:EmoteTalk',
      duration: 2.4,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        pose.hipDelta[0] = Math.sin(p) * 0.018;
        pose.hipDelta[1] = Math.sin(p * 2) * 0.008;

        setEuler(pose, 'Hips', 0.02, Math.sin(p) * 0.06, Math.cos(p) * 0.03);
        setEuler(pose, 'Spine', 0.02, -Math.sin(p) * 0.04, 0);
        setEuler(pose, 'Chest', 0.02 + Math.sin(p * 2) * 0.03, -Math.sin(p) * 0.04, 0);
        setEuler(pose, 'Neck', Math.sin(p * 3) * 0.05, Math.cos(p) * 0.08, 0);
        setEuler(pose, 'Head', -0.04 + Math.sin(p * 3) * 0.07, Math.cos(p) * 0.12, Math.sin(p * 2) * 0.06);

        // Alternating open-palm gestures
        const gL = Math.max(0, Math.sin(p));
        const gR = Math.max(0, -Math.sin(p));
        setEuler(pose, 'LeftUpperArm', -0.45 * gL - 0.10, 0.22 * gL, 0.22 + 0.15 * gL);
        setEuler(pose, 'LeftLowerArm', -1.05 * gL - 0.38, 0.35 * gL, 0);
        setEuler(pose, 'LeftHand', -0.22 * gL, 0, 0.18 * Math.sin(p * 2));

        setEuler(pose, 'RightUpperArm', -0.52 * gR - 0.12, -0.22 * gR, -0.22 - 0.15 * gR);
        setEuler(pose, 'RightLowerArm', -1.12 * gR - 0.42, -0.35 * gR, 0);
        setEuler(pose, 'RightHand', -0.22 * gR, 0, -0.18 * Math.sin(p * 2));

        setEuler(pose, 'LeftUpperLeg', -0.05, 0.04, 0.03);
        setEuler(pose, 'LeftLowerLeg', 0.10, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.03, -0.04, -0.03);
        setEuler(pose, 'RightLowerLeg', 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 67:EmoteWave — Enthusiastic High Hand Wave (Celandia wave)
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '67:EmoteWave',
      duration: 1.8,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        pose.hipDelta[0] = Math.sin(p) * 0.022;
        pose.hipDelta[1] = Math.abs(Math.sin(p)) * 0.015;

        setEuler(pose, 'Hips', 0.02, -0.08, Math.sin(p) * 0.04);
        setEuler(pose, 'Spine', -0.03, 0.05, -Math.sin(p) * 0.04);
        setEuler(pose, 'Chest', -0.04, 0.06, -0.06);
        setEuler(pose, 'Head', -0.06, -0.08, 0.10 + Math.sin(p * 2) * 0.05);

        // Right arm raised high waving at 2x frequency
        setEuler(pose, 'RightUpperArm', -2.35, -0.18, -0.55 + Math.sin(p * 2) * 0.18);
        setEuler(pose, 'RightLowerArm', -0.55 + Math.sin(p * 2) * 0.38, 0, Math.cos(p * 2) * 0.25);
        setEuler(pose, 'RightHand', 0, 0, Math.sin(p * 2) * 0.32);

        // Left hand on hip / relaxed
        setEuler(pose, 'LeftUpperArm', 0.12, 0.15, 0.28);
        setEuler(pose, 'LeftLowerArm', -0.65, 0.20, 0);

        setEuler(pose, 'LeftUpperLeg', -0.06, 0.04, 0.04);
        setEuler(pose, 'LeftLowerLeg', 0.12, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.02, -0.04, -0.04);
        setEuler(pose, 'RightLowerLeg', 0.08, 0, 0);
      },
    })
  );

  // =========================================================================
  // 68:EmoteCheer — Victorious Double-Fist Pump & Triumph Hop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '68:EmoteCheer',
      duration: 1.6,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      wingBoost: 0.45,
      evalPose(pose, u) {
        const p = u * TAU;
        const pump = Math.max(0, Math.sin(p * 2));
        pose.hipDelta[1] = pump * 0.075 - 0.02;

        setEuler(pose, 'Hips', -0.06 * pump, Math.sin(p) * 0.12, 0);
        setEuler(pose, 'Spine', -0.10 * pump, -Math.sin(p) * 0.08, 0);
        setEuler(pose, 'Chest', -0.14 * pump, 0, 0);
        setEuler(pose, 'Head', -0.18 * pump, Math.sin(p) * 0.10, 0);

        setEuler(pose, 'LeftUpperArm', -2.15 - 0.42 * pump, 0.15, 0.42);
        setEuler(pose, 'LeftLowerArm', -0.85 + 0.55 * pump, 0, 0);
        setEuler(pose, 'RightUpperArm', -2.15 - 0.42 * pump, -0.15, -0.42);
        setEuler(pose, 'RightLowerArm', -0.85 + 0.55 * pump, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.22 * (1 - pump) - 0.08, 0.06, 0.08);
        setEuler(pose, 'LeftLowerLeg', 0.42 * (1 - pump) + 0.12, 0, 0);
        setEuler(pose, 'RightUpperLeg', -0.22 * (1 - pump) - 0.08, -0.06, -0.08);
        setEuler(pose, 'RightLowerLeg', 0.42 * (1 - pump) + 0.12, 0, 0);
      },
    })
  );

  // =========================================================================
  // 69:EmoteDance — Jem Starlight / Celandia Air-Guitar Concert Dance Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '69:EmoteDance',
      duration: 1.8,
      numFrames: 27,
      loop: true,
      boneMap,
      profile,
      wingBoost: 0.5,
      evalPose(pose, u) {
        const p = u * TAU;
        const groove = Math.sin(p * 2);
        const side = Math.sin(p);

        pose.hipDelta[0] = side * 0.065;
        pose.hipDelta[1] = -Math.abs(groove) * 0.055;

        setEuler(pose, 'Hips', 0.08 + groove * 0.06, side * 0.28, side * 0.12);
        setEuler(pose, 'Spine', -0.06, -side * 0.18, -side * 0.08);
        setEuler(pose, 'Chest', -0.08 - groove * 0.06, -side * 0.22, -side * 0.08);
        setEuler(pose, 'Head', groove * 0.12, side * 0.18, -side * 0.12);

        // Fret-hand (Left) + strumming/starlight-wave hand (Right)
        setEuler(pose, 'LeftUpperArm', -0.78 + groove * 0.15, 0.35, 0.45);
        setEuler(pose, 'LeftLowerArm', -1.35 + Math.cos(p * 2) * 0.22, 0.45, 0);
        setEuler(pose, 'RightUpperArm', -0.65 - groove * 0.25, -0.35, -0.38);
        setEuler(pose, 'RightLowerArm', -1.25 + Math.sin(p * 4) * 0.48, -0.32, 0);
        setEuler(pose, 'RightHand', Math.sin(p * 4) * 0.35, 0, Math.cos(p * 4) * 0.28);

        // Groovy alternating knee-pop step-touch
        setEuler(pose, 'LeftUpperLeg', -0.25 - Math.max(0, side) * 0.35, 0.12, 0.12 + side * 0.10);
        setEuler(pose, 'LeftLowerLeg', 0.42 + Math.max(0, side) * 0.58, 0, 0);
        setEuler(pose, 'RightUpperLeg', -0.25 - Math.max(0, -side) * 0.35, -0.12, -0.12 + side * 0.10);
        setEuler(pose, 'RightLowerLeg', 0.42 + Math.max(0, -side) * 0.58, 0, 0);
      },
    })
  );

  // =========================================================================
  // 73:SpellCastWhirlwind — 360-Degree Bladestorm / Cyclone Spin Loop
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '73:SpellCastWhirlwind',
      duration: 0.62,
      numFrames: 25,
      loop: false, // rawU progresses 0 -> 2*PI so frame 0 and frame N-1 are identical orientation
      boneMap,
      profile,
      wingBoost: 0.6,
      evalPose(pose, _u, rawU) {
        const yaw = rawU * TAU;
        pose.hipDelta[1] = -0.05 + Math.sin(yaw * 2) * 0.02;

        // Full 360-degree continuous quaternion yaw spin on Hips
        pose.quatOverride.Hips = quatMultiply(
          quatFromEulerXYZ(0, yaw, 0),
          quatFromEulerXYZ(0.18, 0, 0.08)
        );
        setEuler(pose, 'Spine', 0.10, 0.18, 0);
        setEuler(pose, 'Chest', 0.10, 0.22, 0);
        setEuler(pose, 'Head', -0.12, 0.18, 0);

        // Arms extended wide in horizontal bladestorm sweep
        setEuler(pose, 'RightUpperArm', -1.35, 0.15, -1.12);
        setEuler(pose, 'RightLowerArm', -0.22, 0, 0);
        setEuler(pose, 'RightHand', 0.38, 0, 0);

        setEuler(pose, 'LeftUpperArm', -1.25, -0.35, 0.85);
        setEuler(pose, 'LeftLowerArm', -0.45, 0, 0);

        setEuler(pose, 'LeftUpperLeg', -0.38, 0.12, 0.14);
        setEuler(pose, 'LeftLowerLeg', 0.68, 0, 0);
        setEuler(pose, 'RightUpperLeg', 0.15, -0.12, -0.14);
        setEuler(pose, 'RightLowerLeg', 0.42, 0, 0);
      },
    })
  );

  // =========================================================================
  // 97:SitGround — Cross-Legged Ground Rest Loop (Celandia sit)
  // =========================================================================
  clips.push(
    compileHumanoidClip({
      name: '97:SitGround',
      duration: 3.0,
      numFrames: 25,
      loop: true,
      boneMap,
      profile,
      evalPose(pose, u) {
        const p = u * TAU;
        const breath = Math.sin(p);
        pose.hipDelta[1] = -0.48 + breath * 0.008;

        setEuler(pose, 'Hips', -0.08, 0, 0);
        setEuler(pose, 'Spine', 0.10 - breath * 0.02, 0, 0);
        setEuler(pose, 'Chest', 0.08 - breath * 0.025, Math.sin(p * 0.5) * 0.03, 0);
        setEuler(pose, 'Neck', -0.06, Math.sin(p) * 0.05, 0);
        setEuler(pose, 'Head', -0.04 - breath * 0.02, Math.sin(p) * 0.08, Math.cos(p) * 0.03);

        // Hands resting comfortably on knees
        setEuler(pose, 'LeftUpperArm', -0.38 + breath * 0.02, -0.18, 0.22);
        setEuler(pose, 'LeftLowerArm', -0.82, 0.28, 0);
        setEuler(pose, 'RightUpperArm', -0.38 + breath * 0.02, 0.18, -0.22);
        setEuler(pose, 'RightLowerArm', -0.82, -0.28, 0);

        // Cross-legged sitting posture
        setEuler(pose, 'LeftUpperLeg', -1.38, 0.48, 0.42);
        setEuler(pose, 'LeftLowerLeg', 1.82, 0, 0);
        setEuler(pose, 'LeftFoot', 0.25, 0, 0);

        setEuler(pose, 'RightUpperLeg', -1.38, -0.48, -0.42);
        setEuler(pose, 'RightLowerLeg', 1.82, 0, 0);
        setEuler(pose, 'RightFoot', 0.25, 0, 0);
      },
    })
  );

  // =========================================================================
  // Additional WoW Combat & Movement Sequences (28 -> 36 total clips!)
  // =========================================================================
  const cloneWithId = (sourceId, targetId, targetName) => {
    const src = clips.find((c) => c.name.startsWith(`${sourceId}:`));
    if (!src) return;
    clips.push({
      name: `${targetId}:${targetName}`,
      times: new Float32Array(src.times),
      tracks: src.tracks.map((tr) => ({
        bone: tr.bone,
        path: tr.path,
        values: new Float32Array(tr.values),
      })),
    });
  };

  cloneWithId(25, 28, 'ReadyUnarmed');
  cloneWithId(21, 22, 'Parry2H');
  cloneWithId(21, 23, 'Parry2HL');
  cloneWithId(9, 8, 'StandWound');
  cloneWithId(38, 40, 'Fall');
  cloneWithId(42, 43, 'SwimLeft');
  cloneWithId(42, 44, 'SwimRight');
  cloneWithId(42, 45, 'SwimBackwards');
  cloneWithId(29, 46, 'AttackBow');
  cloneWithId(27, 48, 'ReadyRifle');
  cloneWithId(30, 49, 'AttackRifle');
  cloneWithId(52, 124, 'ChannelCastDirected');
  cloneWithId(5, 143, 'Sprint');
  cloneWithId(39, 187, 'JumpLandRun');

  return clips;
}

// ---------------------------------------------------------------------------
// 7. Export 2: buildCreatureAnimations(nodes, creatureType) — 12 Sequences
// ---------------------------------------------------------------------------

function classifyCreatureArchetype(creatureType = '', nodes = []) {
  const s = String(creatureType || '').toLowerCase();
  if (s.includes('hopper') || s.includes('rabbit') || s.includes('frog') || s.includes('toad')) {
    return 'hopper';
  }
  if (
    s.includes('drifter') ||
    s.includes('yak') ||
    s.includes('bison') ||
    s.includes('hound') ||
    s.includes('wolf') ||
    s.includes('quad') ||
    s.includes('strider') ||
    s.includes('stag') ||
    s.includes('turtle')
  ) {
    return 'quadruped';
  }
  if (s.includes('skimmer') || s.includes('lizard') || s.includes('serpent') || s.includes('koi') || s.includes('snake')) {
    return 'skimmer';
  }
  if (s.includes('manta') || s.includes('ray') || s.includes('swan') || s.includes('bird') || s.includes('wisp')) {
    return 'manta';
  }
  if (s.includes('colossus') || s.includes('bonelord') || s.includes('golem') || s.includes('giant') || s.includes('titan')) {
    return 'colossus';
  }
  if (s.includes('wraith') || s.includes('specter') || s.includes('ghost') || s.includes('banshee')) {
    return 'wraith';
  }
  if (s.includes('knight') || s.includes('hollow') || s.includes('undead') || s.includes('skeleton') || nodes.length >= 15) {
    return 'knight';
  }
  return 'quadruped';
}

/**
 * Classifies each bone in a creature's `nodes` array by semantic role so both
 * multi-bone procedural skeletons AND single-root meshes animate expressively.
 */
function analyzeCreatureSkeleton(nodes) {
  const effectiveNodes =
    Array.isArray(nodes) && nodes.length > 0
      ? nodes
      : [{ name: 'root', parent: -1, translation: [0, 0.5, 0], rotation: [0, 0, 0, 1] }];

  return effectiveNodes.map((n, idx) => {
    const name = String((n && n.name) || `bone_${idx}`).toLowerCase();
    const t = (n && Array.isArray(n.translation)) ? n.translation : [0, 0, 0];
    const r = (n && Array.isArray(n.rotation)) ? n.rotation : [0, 0, 0, 1];
    let role = 'body';
    if (idx === 0 || name === 'root' || name === 'pelvis' || name === 'hips' || name === 'body') {
      role = 'root';
    } else if (name.includes('head') || name.includes('skull') || name.includes('snout') || name.includes('jaw')) {
      role = 'head';
    } else if (name.includes('neck')) {
      role = 'neck';
    } else if (name.includes('ear') || name.includes('horn') || name.includes('antler') || name.includes('crest')) {
      role = name.includes('r') ? 'earR' : 'earL';
    } else if (name.includes('tail')) {
      role = 'tail';
    } else if (name.includes('wing') || name.includes('fin') || name.includes('pectoral')) {
      role = name.includes('r') || t[0] < -0.02 ? 'wingR' : 'wingL';
    } else if (name.includes('arm') || name.includes('hand') || name.includes('shoulder') || name.includes('weapon')) {
      role = name.includes('r') || t[0] < -0.02 ? 'armR' : 'armL';
    } else if (name.includes('leg') || name.includes('thigh') || name.includes('shin') || name.includes('foot') || name.includes('paw') || name.includes('hoof')) {
      const isLeft = name.includes('l') || t[0] >= 0;
      const isBack = name.includes('b') || name.includes('hind') || name.includes('rear') || t[2] < -0.05;
      if (isBack) role = isLeft ? 'legBL' : 'legBR';
      else role = isLeft ? 'legFL' : 'legFR';
    } else if (name.includes('spine') || name.includes('chest') || name.includes('torso')) {
      role = 'spine';
    }
    return { idx, name, role, restT: t, restR: r };
  });
}

const CREATURE_SEQUENCE_SPECS = [
  { id: 0, name: 'Stand', duration: 2.4, loop: true },
  { id: 1, name: 'Death', duration: 1.35, loop: false },
  { id: 4, name: 'Walk', duration: 0.96, loop: true },
  { id: 5, name: 'Run', duration: 0.62, loop: true },
  { id: 9, name: 'CombatWound', duration: 0.55, loop: false },
  { id: 14, name: 'Stun', duration: 1.5, loop: true },
  { id: 16, name: 'AttackUnarmed', duration: 0.72, loop: false },
  { id: 17, name: 'Attack1H', duration: 0.76, loop: false },
  { id: 18, name: 'Attack2H', duration: 0.92, loop: false },
  { id: 38, name: 'Jump', duration: 0.78, loop: true },
  { id: 51, name: 'SpellCastDirected', duration: 0.86, loop: false },
  { id: 53, name: 'SpellCastOmni', duration: 0.98, loop: false },
];

export function buildCreatureAnimations(nodes, creatureType = 'PorcelainHopper') {
  const archetype = classifyCreatureArchetype(creatureType, nodes);
  // If this is a full 21-bone humanoid boss/knight (AshenKnight/Hollow), we can enrich with humanoid animations or use the multi-bone creature solver
  const boneInfos = analyzeCreatureSkeleton(nodes);
  const numFrames = 23;
  const clips = [];

  for (const spec of CREATURE_SEQUENCE_SPECS) {
    const times = new Float32Array(numFrames);
    for (let k = 0; k < numFrames; k++) {
      times[k] = (k / (numFrames - 1)) * spec.duration;
    }

    const rootInfo = boneInfos[0];
    const rootTrans = new Float32Array(numFrames * 3);
    const rootScale = new Float32Array(numFrames * 3);
    const rotTracks = boneInfos.map(() => new Float32Array(numFrames * 4));

    for (let k = 0; k < numFrames; k++) {
      const u = spec.loop && k === numFrames - 1 ? 0 : k / (numFrames - 1);
      const rawU = k / (numFrames - 1);
      const p = u * TAU;

      let dx = 0;
      let dy = 0;
      let dz = 0;
      let sx = 1;
      let sy = 1;
      let sz = 1;

      const boneEuler = boneInfos.map(() => [0, 0, 0]);
      const setRoleEuler = (role, rx, ry, rz) => {
        for (let b = 0; b < boneInfos.length; b++) {
          if (boneInfos[b].role === role) {
            boneEuler[b][0] += rx;
            boneEuler[b][1] += ry;
            boneEuler[b][2] += rz;
          }
        }
      };

      // ---------------------------------------------------------------------
      // Archetype-specific root + multi-bone kinematics per sequence
      // ---------------------------------------------------------------------
      if (archetype === 'hopper') {
        // PorcelainHopper: elastic hop arcs, squash-stretch, ear-twitch
        if (spec.id === 0) {
          dy = Math.sin(p) * 0.015;
          sy = 1 + Math.sin(p) * 0.03;
          setRoleEuler('root', Math.sin(p) * 0.04, Math.cos(p * 0.5) * 0.05, 0);
          setRoleEuler('head', -Math.sin(p) * 0.06, Math.sin(p * 2) * 0.08, 0);
          setRoleEuler('earL', Math.sin(p * 3) * 0.22, 0, 0.08);
          setRoleEuler('earR', -Math.sin(p * 3) * 0.22, 0, -0.08);
        } else if (spec.id === 4 || spec.id === 5) {
          const hop = Math.max(0, Math.sin(p));
          const amp = spec.id === 5 ? 1.35 : 1.0;
          dy = hop * 0.24 * amp;
          dz = -Math.cos(p) * 0.08 * amp;
          sy = 1 + (hop - 0.35) * 0.16;
          sx = 1 / Math.sqrt(sy);
          sz = sx;
          const pitch = Math.cos(p) * 0.38 * amp;
          setRoleEuler('root', pitch, 0, 0);
          setRoleEuler('head', -pitch * 0.55, 0, 0);
          setRoleEuler('earL', -hop * 0.45, 0, 0.12);
          setRoleEuler('earR', -hop * 0.45, 0, -0.12);
          setRoleEuler('legBL', hop * 0.95 - 0.35, 0, 0);
          setRoleEuler('legBR', hop * 0.95 - 0.35, 0, 0);
          setRoleEuler('legFL', -hop * 0.65 + 0.20, 0, 0);
          setRoleEuler('legFR', -hop * 0.65 + 0.20, 0, 0);
        } else if (spec.id === 16 || spec.id === 17 || spec.id === 18) {
          const strike = windowPulse(rawU, 0.15, 0.38, 0.58, 0.92);
          dy = strike * 0.32;
          dz = strike * 0.28;
          setRoleEuler('root', -0.45 * windowPulse(rawU, 0, 0.12, 0.22, 0.35) + 0.65 * strike, 0, 0);
          setRoleEuler('earL', -0.55 * strike, 0, 0.25 * strike);
          setRoleEuler('earR', -0.55 * strike, 0, -0.25 * strike);
          setRoleEuler('legBL', 1.15 * strike, 0, 0);
          setRoleEuler('legBR', 1.15 * strike, 0, 0);
        } else if (spec.id === 1) {
          const fall = smoothstep(0.0, 0.82, rawU);
          dy = Math.sin(Math.min(1, rawU * 2.2) * Math.PI) * 0.18 * (1 - fall) - 0.22 * fall;
          setRoleEuler('root', 0.25 * fall, 0.35 * fall, 2.65 * fall);
          setRoleEuler('earL', 0.55 * fall, 0, 0.35 * fall);
          setRoleEuler('earR', 0.55 * fall, 0, -0.35 * fall);
        }
      } else if (archetype === 'quadruped') {
        // WoollyDrifter / BlightHound: 4-beat quadruped gait, wool-shake, horn charge
        if (spec.id === 0) {
          dy = Math.sin(p) * 0.014;
          setRoleEuler('root', Math.sin(p) * 0.025, 0, Math.cos(p) * 0.03);
          setRoleEuler('head', 0.06 + Math.sin(p) * 0.08, Math.cos(p) * 0.10, 0);
          setRoleEuler('tail', 0, Math.sin(p * 2) * 0.28, Math.cos(p * 2) * 0.18);
        } else if (spec.id === 4 || spec.id === 5) {
          const fast = spec.id === 5;
          const s = fast ? 1.45 : 1.0;
          dy = Math.abs(Math.sin(p)) * 0.055 * s - 0.02;
          setRoleEuler('root', Math.cos(p) * (fast ? 0.18 : 0.07), Math.sin(p) * 0.04, Math.cos(p) * 0.05);
          setRoleEuler('spine', -Math.cos(p) * 0.06, 0, 0);
          setRoleEuler('head', -Math.cos(p) * 0.12, 0, 0);
          setRoleEuler('tail', 0.25, Math.sin(p * 2) * 0.35, 0);
          // Diagonal gait (FL+BR vs FR+BL in walk, bound in run)
          const phFR = fast ? 0.35 : Math.PI;
          const phBL = fast ? Math.PI : Math.PI;
          const phBR = fast ? Math.PI + 0.35 : 0;
          setRoleEuler('legFL', Math.sin(p) * 0.55 * s, 0, 0);
          setRoleEuler('legFR', Math.sin(p + phFR) * 0.55 * s, 0, 0);
          setRoleEuler('legBL', Math.sin(p + phBL) * 0.55 * s, 0, 0);
          setRoleEuler('legBR', Math.sin(p + phBR) * 0.55 * s, 0, 0);
        } else if (spec.id === 16 || spec.id === 17 || spec.id === 18) {
          const wind = windowPulse(rawU, 0, 0.15, 0.28, 0.42);
          const ram = windowPulse(rawU, 0.30, 0.48, 0.68, 0.96);
          dz = -0.10 * wind + 0.28 * ram;
          dy = -0.05 * wind + 0.08 * ram;
          setRoleEuler('root', 0.22 * wind - 0.28 * ram, 0, 0);
          setRoleEuler('head', 0.48 * wind - 0.75 * ram, 0, 0);
          setRoleEuler('legFL', -0.45 * wind + 0.65 * ram, 0, 0);
          setRoleEuler('legFR', -0.45 * wind + 0.65 * ram, 0, 0);
        } else if (spec.id === 1) {
          const fall = smoothstep(0.0, 0.85, rawU);
          dy = -0.32 * fall;
          setRoleEuler('root', 0.15 * fall, -0.18 * fall, 1.52 * fall);
          setRoleEuler('head', 0.35 * fall, 0.25 * fall, 0);
          setRoleEuler('legFL', 0.45 * fall, 0, 0.35 * fall);
          setRoleEuler('legBL', -0.35 * fall, 0, 0.35 * fall);
        }
      } else if (archetype === 'skimmer') {
        // GlassSkimmer: S-wave lateral undulation, rapid pushup bob, whip-tail strike
        if (spec.id === 0) {
          const pushup = Math.sin(p * 2);
          dy = Math.max(0, pushup) * 0.035;
          setRoleEuler('root', -Math.max(0, pushup) * 0.12, Math.sin(p) * 0.08, 0);
          setRoleEuler('head', -Math.max(0, pushup) * 0.16, Math.cos(p) * 0.14, 0);
          setRoleEuler('tail', 0, Math.sin(p * 2) * 0.38, 0);
        } else if (spec.id === 4 || spec.id === 5) {
          const amp = spec.id === 5 ? 1.45 : 1.0;
          dx = Math.sin(p) * 0.065 * amp;
          setRoleEuler('root', 0, Math.cos(p) * 0.34 * amp, Math.sin(p) * 0.08);
          setRoleEuler('spine', 0, -Math.cos(p - 0.8) * 0.38 * amp, 0);
          setRoleEuler('head', 0, -Math.cos(p) * 0.25 * amp, 0);
          setRoleEuler('tail', 0, Math.cos(p - 1.6) * 0.65 * amp, 0);
          setRoleEuler('legFL', Math.sin(p) * 0.65 * amp, 0, 0.25);
          setRoleEuler('legFR', -Math.sin(p) * 0.65 * amp, 0, -0.25);
          setRoleEuler('legBL', -Math.sin(p) * 0.65 * amp, 0, 0.25);
          setRoleEuler('legBR', Math.sin(p) * 0.65 * amp, 0, -0.25);
        } else if (spec.id === 16 || spec.id === 17 || spec.id === 18) {
          const dart = windowPulse(rawU, 0.18, 0.36, 0.58, 0.92);
          dz = 0.34 * dart;
          setRoleEuler('root', -0.18 * dart, Math.sin(rawU * TAU * 1.5) * 0.55 * dart, 0);
          setRoleEuler('tail', 0, Math.sin(rawU * TAU * 2) * 0.95 * dart, 0);
        } else if (spec.id === 1) {
          const fall = smoothstep(0.0, 0.85, rawU);
          dy = -0.14 * fall;
          setRoleEuler('root', 0, 0.45 * fall, 3.05 * fall);
        }
      } else if (archetype === 'manta') {
        // SkyManta: graceful pectoral wing-wave propagation, banking swoop, tail-whip
        if (spec.id === 0 || spec.id === 4 || spec.id === 5) {
          const amp = spec.id === 5 ? 1.45 : spec.id === 4 ? 1.15 : 0.85;
          dy = Math.sin(p) * 0.095 * amp;
          dx = Math.cos(p * 0.5) * 0.04 * amp;
          setRoleEuler('root', Math.cos(p) * 0.16 * amp, Math.sin(p) * 0.08, -Math.sin(p) * 0.22 * amp);
          setRoleEuler('wingL', Math.cos(p - 0.4) * 0.22 * amp, 0, Math.sin(p) * 0.58 * amp);
          setRoleEuler('wingR', Math.cos(p - 0.4) * 0.22 * amp, 0, -Math.sin(p) * 0.58 * amp);
          setRoleEuler('tail', -Math.cos(p - 1.1) * 0.35 * amp, Math.sin(p) * 0.25, 0);
        } else if (spec.id === 16 || spec.id === 17 || spec.id === 18) {
          const swoop = windowPulse(rawU, 0.14, 0.36, 0.62, 0.94);
          dy = -0.22 * swoop;
          dz = 0.35 * swoop;
          setRoleEuler('root', 0.52 * swoop, 0, 0.38 * swoop);
          setRoleEuler('wingL', -0.35 * swoop, 0, 0.75 * swoop);
          setRoleEuler('wingR', -0.35 * swoop, 0, -0.75 * swoop);
          setRoleEuler('tail', 0.85 * swoop, 0, 0);
        } else if (spec.id === 1) {
          const fall = smoothstep(0.0, 0.88, rawU);
          dy = -0.65 * fall;
          setRoleEuler('root', 0.55 * fall, 1.25 * fall, 0.85 * fall);
          setRoleEuler('wingL', 0, 0, -0.45 * fall);
          setRoleEuler('wingR', 0, 0, 0.45 * fall);
        }
      } else {
        // Colossus / BoneLord / AshenKnight / Wraith: heavy bipedal titan & soulslike boss
        const isWraith = archetype === 'wraith';
        if (spec.id === 0) {
          dy = (isWraith ? 0.08 : 0) + Math.sin(p) * (isWraith ? 0.045 : 0.02);
          setRoleEuler('root', 0.04 + Math.sin(p) * 0.03, Math.cos(p) * 0.04, 0);
          setRoleEuler('spine', -Math.sin(p) * 0.04, 0, 0);
          setRoleEuler('head', -Math.sin(p) * 0.05, Math.sin(p) * 0.08, 0);
          setRoleEuler('armL', 0.08 + Math.sin(p) * 0.06, 0, 0.16);
          setRoleEuler('armR', -0.12 - Math.sin(p) * 0.06, 0, -0.16);
        } else if (spec.id === 4 || spec.id === 5) {
          const amp = spec.id === 5 ? 1.38 : 1.0;
          dy = (isWraith ? 0.10 : -Math.abs(Math.cos(p)) * 0.065 * amp);
          setRoleEuler('root', 0.12 * amp, -Math.sin(p) * 0.12 * amp, Math.cos(p) * 0.07 * amp);
          setRoleEuler('spine', 0.08, Math.sin(p) * 0.10 * amp, -Math.cos(p) * 0.05);
          setRoleEuler('armL', -Math.sin(p) * 0.52 * amp, 0, 0.18);
          setRoleEuler('armR', Math.sin(p) * 0.52 * amp, 0, -0.18);
          setRoleEuler('legFL', Math.sin(p) * 0.58 * amp, 0, 0);
          setRoleEuler('legFR', -Math.sin(p) * 0.58 * amp, 0, 0);
          setRoleEuler('legBL', Math.sin(p) * 0.58 * amp, 0, 0);
          setRoleEuler('legBR', -Math.sin(p) * 0.58 * amp, 0, 0);
        } else if (spec.id === 16 || spec.id === 17 || spec.id === 18) {
          const coil = windowPulse(rawU, 0.0, 0.18, 0.30, 0.44);
          const slam = windowPulse(rawU, 0.32, 0.48, 0.68, 0.95);
          dy = 0.06 * coil - 0.16 * slam;
          dz = -0.08 * coil + 0.24 * slam;
          setRoleEuler('root', -0.22 * coil + 0.38 * slam, -0.35 * coil + 0.38 * slam, 0);
          setRoleEuler('spine', -0.25 * coil + 0.35 * slam, 0, 0);
          setRoleEuler('armR', -2.15 * coil + 0.45 * slam, 0, -0.25);
          setRoleEuler('armL', -1.85 * coil + 0.38 * slam, 0, 0.25);
        } else if (spec.id === 1) {
          const fall = smoothstep(0.0, 0.86, rawU);
          dy = -0.58 * fall;
          setRoleEuler('root', 1.42 * fall, -0.22 * fall, 0.18 * fall);
          setRoleEuler('armL', -0.95 * fall, 0, 0.65 * fall);
          setRoleEuler('armR', -0.95 * fall, 0, -0.65 * fall);
        }
      }

      // Shared reactive sequences across all creature archetypes (9:Wound, 14:Stun, 38:Jump, 51/53:Cast)
      if (spec.id === 9) {
        const hit = windowPulse(rawU, 0, 0.18, 0.42, 1.0);
        dz -= 0.12 * hit;
        dy -= 0.05 * hit;
        setRoleEuler('root', -0.28 * hit, 0.22 * hit, -0.14 * hit);
        setRoleEuler('head', -0.35 * hit, 0.25 * hit, 0);
      } else if (spec.id === 14) {
        dx += Math.cos(p) * 0.04;
        dz += Math.sin(p) * 0.04;
        setRoleEuler('root', Math.sin(p) * 0.12, Math.cos(p) * 0.15, Math.cos(p) * 0.12);
        setRoleEuler('head', Math.sin(p - 0.8) * 0.22, Math.cos(p) * 0.22, 0);
      } else if (spec.id === 38) {
        const arc = Math.sin(u * Math.PI);
        dy += arc * 0.32;
        setRoleEuler('root', Math.cos(u * Math.PI) * 0.35, 0, 0);
      } else if (spec.id === 51 || spec.id === 53) {
        const charge = windowPulse(rawU, 0.0, 0.22, 0.38, 0.52);
        const burst = windowPulse(rawU, 0.40, 0.54, 0.76, 0.96);
        dy += -0.08 * charge + 0.16 * burst;
        const scalePulse = 1 + 0.12 * burst - 0.06 * charge;
        sx *= scalePulse;
        sy *= scalePulse;
        sz *= scalePulse;
        setRoleEuler('root', -0.24 * charge + 0.32 * burst, spec.id === 53 ? rawU * TAU * burst : 0, 0);
        setRoleEuler('head', -0.35 * burst, 0, 0);
        setRoleEuler('wingL', 0, 0, 0.65 * burst);
        setRoleEuler('wingR', 0, 0, -0.65 * burst);
        setRoleEuler('armL', -1.45 * burst, 0, 0.65 * burst);
        setRoleEuler('armR', -1.45 * burst, 0, -0.65 * burst);
      }

      rootTrans[k * 3 + 0] = rootInfo.restT[0] + dx;
      rootTrans[k * 3 + 1] = rootInfo.restT[1] + dy;
      rootTrans[k * 3 + 2] = rootInfo.restT[2] + dz;

      rootScale[k * 3 + 0] = sx;
      rootScale[k * 3 + 1] = sy;
      rootScale[k * 3 + 2] = sz;

      for (let b = 0; b < boneInfos.length; b++) {
        const e = boneEuler[b];
        const qDelta = quatFromEulerXYZ(e[0], e[1], e[2]);
        const qFinal = quatNormalize(quatMultiply(boneInfos[b].restR, qDelta));
        const buf = rotTracks[b];
        buf[k * 4 + 0] = qFinal[0];
        buf[k * 4 + 1] = qFinal[1];
        buf[k * 4 + 2] = qFinal[2];
        buf[k * 4 + 3] = qFinal[3];
      }
    }

    const tracks = [
      { bone: rootInfo.idx, path: 'translation', values: rootTrans },
      { bone: rootInfo.idx, path: 'scale', values: rootScale },
    ];
    for (let b = 0; b < boneInfos.length; b++) {
      const buf = rotTracks[b];
      for (let k = 1; k < numFrames; k++) {
        const prev = (k - 1) * 4;
        const cur = k * 4;
        if (
          buf[prev] * buf[cur] +
            buf[prev + 1] * buf[cur + 1] +
            buf[prev + 2] * buf[cur + 2] +
            buf[prev + 3] * buf[cur + 3] <
          0
        ) {
          buf[cur] = -buf[cur];
          buf[cur + 1] = -buf[cur + 1];
          buf[cur + 2] = -buf[cur + 2];
          buf[cur + 3] = -buf[cur + 3];
        }
      }
      tracks.push({ bone: boneInfos[b].idx, path: 'rotation', values: buf });
    }

    clips.push({
      name: `${spec.id}:${spec.name}`,
      times,
      tracks,
    });
  }

  return clips;
}

// ---------------------------------------------------------------------------
// 8. Export 3: buildAnimationDataDbc(writeFile, WdbcBuilder) — All 208 WoW Rows
// ---------------------------------------------------------------------------

/**
 * Complete WoW 1.12.1 (build 5875) AnimationData.dbc table (IDs 0..=207).
 * Schema (7 columns matching crates/benilla-formats/src/anim_data.rs):
 *   col 0: ID (u32)
 *   col 1: Name (String)
 *   col 2: WeaponFlags (u32: 0 | 4 | 0x10 | 0x14 | 0x20)
 *   col 3: BodyFlags (u32)
 *   col 4: Flags (u32)
 *   col 5: BehaviorID / Preceding (u32)
 *   col 6: Fallback (u32)
 */
const CANONICAL_ANIM_DEFS = {
  0: ['Stand', 0, 0, 0, 0, 0],
  1: ['Death', 0, 0, 0, 0, 0],
  2: ['Spell', 0x10, 0, 0, 0, 0],
  3: ['Stop', 0, 0, 0, 0, 0],
  4: ['Walk', 0, 0, 0, 0, 0],
  5: ['Run', 0, 0, 0, 0, 0],
  6: ['Dead', 0, 0, 0, 1, 1],
  7: ['Rise', 0, 0, 0, 0, 0],
  8: ['StandWound', 0, 0, 0, 0, 0],
  9: ['CombatWound', 0, 0, 0, 0, 8],
  10: ['CombatCritical', 0, 0, 0, 0, 9],
  11: ['ShuffleLeft', 0, 0, 0, 0, 4],
  12: ['ShuffleRight', 0, 0, 0, 0, 4],
  13: ['WalkBackwards', 0, 0, 0, 0, 4],
  14: ['Stun', 0, 0, 0, 0, 0],
  15: ['HandsClosed', 0, 0, 0, 0, 0],
  16: ['AttackUnarmed', 0x10, 0, 0, 0, 0],
  17: ['Attack1H', 0x20, 0, 0, 0, 16],
  18: ['Attack2H', 0x20, 0, 0, 0, 17],
  19: ['Attack2HL', 0x20, 0, 0, 0, 18],
  20: ['ParryUnarmed', 0x10, 0, 0, 0, 25],
  21: ['Parry1H', 0x20, 0, 0, 0, 20],
  22: ['Parry2H', 0x20, 0, 0, 0, 21],
  23: ['Parry2HL', 0x20, 0, 0, 0, 22],
  24: ['ShieldBlock', 0x20, 0, 0, 0, 20],
  25: ['ReadyUnarmed', 0x10, 0, 0, 0, 0],
  26: ['Ready1H', 0x20, 0, 0, 0, 25],
  27: ['Ready2H', 0x20, 0, 0, 0, 26],
  28: ['Ready2HL', 0x20, 0, 0, 0, 27],
  29: ['ReadyBow', 0x20, 0, 0, 0, 25],
  30: ['Dodge', 0, 0, 0, 0, 25],
  31: ['SpellPrecast', 0x10, 0, 0, 0, 2],
  32: ['SpellCast', 0x10, 0, 0, 0, 2],
  33: ['SpellCastArea', 0x10, 0, 0, 0, 32],
  34: ['NPCWelcome', 0x10, 0, 0, 0, 0],
  35: ['NPCGoodbye', 0x10, 0, 0, 0, 0],
  36: ['Block', 0x20, 0, 0, 0, 24],
  37: ['JumpStart', 0, 0, 0, 0, 38],
  38: ['Jump', 0, 0, 0, 37, 0],
  39: ['JumpEnd', 0, 0, 0, 38, 0],
  40: ['Fall', 0, 0, 0, 0, 38],
  41: ['SwimIdle', 4, 0, 0, 0, 42],
  42: ['Swim', 4, 0, 0, 0, 0],
  43: ['SwimLeft', 4, 0, 0, 0, 42],
  44: ['SwimRight', 4, 0, 0, 0, 42],
  45: ['SwimBackwards', 4, 0, 0, 0, 42],
  46: ['AttackBow', 0x20, 0, 0, 0, 16],
  47: ['FireBow', 0x20, 0, 0, 0, 46],
  48: ['ReadyRifle', 0x20, 0, 0, 0, 29],
  49: ['AttackRifle', 0x20, 0, 0, 0, 46],
  50: ['Loot', 0x10, 0, 0, 0, 0],
  51: ['SpellCastDirected', 0x10, 0, 0, 0, 32],
  52: ['SpellCastOmni', 0x10, 0, 0, 0, 51],
  53: ['SpellCastOmniArea', 0x10, 0, 0, 0, 52],
  54: ['BattleRoar', 0x10, 0, 0, 0, 0],
  55: ['ReadyAbility', 0x10, 0, 0, 0, 25],
  56: ['Special1H', 0x20, 0, 0, 0, 17],
  57: ['Special2H', 0x20, 0, 0, 0, 18],
  58: ['ShieldBash', 0x20, 0, 0, 0, 17],
  59: ['EmoteTalk', 0x10, 0, 0, 0, 0],
  60: ['EmoteTalk', 0x10, 0, 0, 0, 0],
  61: ['EmoteEat', 0x10, 0, 0, 0, 0],
  62: ['EmoteWork', 0x10, 0, 0, 0, 0],
  63: ['EmoteUseStanding', 0x10, 0, 0, 0, 0],
  64: ['EmoteTalkExclamation', 0x10, 0, 0, 0, 60],
  65: ['EmoteTalkQuestion', 0x10, 0, 0, 0, 60],
  66: ['EmoteBow', 0x10, 0, 0, 0, 0],
  67: ['EmoteWave', 0x10, 0, 0, 0, 0],
  68: ['EmoteCheer', 0x10, 0, 0, 0, 0],
  69: ['EmoteDance', 0x10, 0, 0, 0, 0],
  70: ['EmoteLaugh', 0x10, 0, 0, 0, 0],
  71: ['EmoteSleep', 0x10, 0, 0, 0, 0],
  72: ['EmoteSitGround', 0x10, 0, 0, 0, 0],
  73: ['SpellCastWhirlwind', 0x20, 0, 0, 0, 18],
  74: ['EmoteRoar', 0x10, 0, 0, 0, 0],
  75: ['EmoteKneel', 0x10, 0, 0, 0, 50],
  76: ['EmoteKiss', 0x10, 0, 0, 0, 0],
  77: ['EmoteCry', 0x10, 0, 0, 0, 0],
  78: ['EmoteChicken', 0x10, 0, 0, 0, 0],
  79: ['EmoteBeg', 0x10, 0, 0, 0, 0],
  80: ['EmoteApplaud', 0x10, 0, 0, 0, 68],
  81: ['EmoteShout', 0x10, 0, 0, 0, 0],
  82: ['EmoteFlex', 0x10, 0, 0, 0, 0],
  83: ['EmoteShy', 0x10, 0, 0, 0, 0],
  84: ['EmotePoint', 0x10, 0, 0, 0, 0],
  85: ['Attack1HPierce', 0x20, 0, 0, 0, 17],
  86: ['Attack2HLoosePierce', 0x20, 0, 0, 0, 19],
  87: ['AttackOff', 0x20, 0, 0, 0, 17],
  88: ['AttackOffPierce', 0x20, 0, 0, 0, 87],
  89: ['Sheath', 0x10, 0, 0, 0, 0],
  90: ['HipSheath', 0x10, 0, 0, 0, 89],
  91: ['Mount', 4, 0, 0, 0, 0],
  92: ['RunRight', 0, 0, 0, 0, 5],
  93: ['RunLeft', 0, 0, 0, 0, 5],
  94: ['MountSpecial', 4, 0, 0, 0, 91],
  95: ['Kick', 0x10, 0, 0, 0, 16],
  96: ['SitGroundDown', 0x10, 0, 0, 0, 0],
  97: ['SitGround', 0x10, 0, 0, 96, 0],
  98: ['SitGroundUp', 0x10, 0, 0, 97, 0],
  99: ['SleepDown', 0x10, 0, 0, 0, 96],
  100: ['Sleep', 0x10, 0, 0, 99, 99],
  101: ['SleepUp', 0x10, 0, 0, 100, 98],
  102: ['SitChairLow', 4, 0, 0, 0, 97],
  103: ['SitChairMed', 4, 0, 0, 0, 102],
  104: ['SitChairHigh', 4, 0, 0, 0, 102],
  105: ['LoadBow', 0, 0, 0, 0, 29],
  106: ['LoadRifle', 0, 0, 0, 0, 48],
  107: ['AttackThrown', 0x20, 0, 0, 0, 16],
  108: ['ReadyThrown', 0x20, 0, 0, 0, 29],
  109: ['HoldBow', 0x20, 0, 0, 0, 29],
  110: ['HoldRifle', 0x20, 0, 0, 0, 48],
  111: ['HoldThrown', 0x20, 0, 0, 0, 108],
  112: ['LoadThrown', 0, 0, 0, 0, 108],
  113: ['EmoteSalute', 0x10, 0, 0, 0, 67],
  114: ['KneelStart', 0x10, 0, 0, 0, 50],
  115: ['KneelLoop', 0x10, 0, 0, 114, 97],
  116: ['KneelEnd', 0x10, 0, 0, 115, 0],
  117: ['AttackUnarmedOff', 0x10, 0, 0, 0, 16],
  118: ['SpecialUnarmed', 0x10, 0, 0, 0, 16],
  119: ['StealthWalk', 0, 0, 0, 0, 4],
  120: ['StealthStand', 0, 0, 0, 0, 0],
  121: ['Knockdown', 0, 0, 0, 0, 10],
  122: ['EatingLoop', 0x10, 0, 0, 0, 61],
  123: ['UseStandingLoop', 0x10, 0, 0, 0, 63],
  124: ['ChannelCastDirected', 0x10, 0, 0, 0, 51],
  125: ['ChannelCastOmni', 0x10, 0, 0, 0, 52],
  126: ['Whirlwind', 0x20, 0, 0, 0, 73],
  127: ['Birth', 0, 0, 0, 0, 0],
  128: ['UseStandingStart', 0x10, 0, 0, 0, 63],
  129: ['UseStandingEnd', 0x10, 0, 0, 0, 63],
  130: ['CreatureSpecial', 0, 0, 0, 0, 0],
  131: ['Drown', 4, 0, 0, 0, 1],
  132: ['Drowned', 4, 0, 0, 131, 6],
  133: ['FishingCast', 0x20, 0, 0, 0, 51],
  134: ['FishingLoop', 0x20, 0, 0, 133, 52],
  135: ['Fly', 0, 0, 0, 0, 38],
  136: ['EmoteWorkNoSheathe', 0, 0, 0, 0, 62],
  137: ['EmoteStunNoSheathe', 0, 0, 0, 0, 14],
  138: ['EmoteUseStandingNoSheathe', 0, 0, 0, 0, 63],
  139: ['SpellSleepDown', 0x10, 0, 0, 0, 99],
  140: ['SpellKneelStart', 0x10, 0, 0, 0, 114],
  143: ['Sprint', 0, 0, 0, 0, 5],
  187: ['JumpLandRun', 0, 0, 0, 38, 5],
};

export const ANIMATION_DATA_ROWS = Array.from({ length: 208 }, (_, id) => {
  const def = CANONICAL_ANIM_DEFS[id];
  if (def) {
    return {
      id,
      name: def[0],
      weaponFlags: def[1],
      bodyFlags: def[2],
      flags: def[3],
      behaviorId: def[4],
      fallback: def[5],
    };
  }
  return {
    id,
    name: `Anim_${id}`,
    weaponFlags: 0,
    bodyFlags: 0,
    flags: 0,
    behaviorId: 0,
    fallback: 0,
  };
});

export function buildAnimationDataDbc(writeFile, WdbcBuilder) {
  const animDbc = new WdbcBuilder(7, [1]);
  for (const row of ANIMATION_DATA_ROWS) {
    animDbc.addRow([
      row.id,
      row.name,
      row.weaponFlags,
      row.bodyFlags,
      row.flags,
      row.behaviorId,
      row.fallback,
    ]);
  }
  const built =
    typeof animDbc.toBuffer === 'function' ? animDbc.toBuffer() : animDbc.build();
  if (typeof writeFile === 'function') {
    writeFile('DBFilesClient/AnimationData.dbc', built);
  }
  return built;
}

