//! Binary glTF 2.0 (`.glb`, magic `b"glTF"`) loader adapter for the `benilla` M2 pipeline.
//!
//! Converts any `.glb` model (static props/buildings, weapon meshes, or multi-bone skinned
//! characters with keyframe animations) into [`RenderSubmesh`], [`Skeleton`], [`ModelAnimation`],
//! [`M2Bounds`], [`M2Attachment`], and [`PlayableAnim`] in WoW model space (`+X` forward, `+Y`
//! left, `+Z` up).
//!
//! Because `benilla-assets` builds joint inverse-bind matrices as pure translations
//! (`translate(-pivot)`) with identity rest rotations, this module transforms every glTF skin
//! vertex into the model's bind-pose root frame and conjugates each bone's keyframe rotations and
//! translation deltas by its bind-pose world rotation:
//!
//! - `R_benilla_local[j](t) = R_bind_world[p] · R_gltf_local[j](t) · R_bind_world[j]⁻¹`
//! - `dT_benilla_local[j](t) = R_bind_world[p] · (T_gltf_local[j](t) − T_bind_local[j])`
//!
//! By induction from root to leaf, `M_benilla_world[j](t) · translate(−pivot[j])` equals
//! `M_gltf_world[j](t) · IBM[j]` for every bone and keyframe, allowing arbitrary glTF rigs
//! (Celandia, Three.js, Blender, Mixamo, Meshy) to skin natively on the GPU via `wow_model.wgsl`.

use std::collections::HashMap;

use anyhow::{anyhow, bail, Result};
use serde_json::Value;

use super::{
    BoneKeys, CollisionMesh, M2Attachment, M2Bounds, M2PaneCamera, M2PortraitCamera,
    ModelAnimation, ModelBlend, PlayableAnim, RenderSubmesh, Skeleton, SkeletonBone,
    DEGENERATE_RING_FOOTPRINT,
};

/// Whether `bytes` begins with the binary glTF 2.0 magic `b"glTF"`.
#[inline]
pub fn is_glb(bytes: &[u8]) -> bool {
    bytes.len() >= 20 && &bytes[0..4] == b"glTF"
}

/// Cyclic axis map from glTF (`+Y` up, `+Z` forward, `+X` left-of-facing) to WoW model space
/// (`+Z` up, `+X` forward, `+Y` left). Determinant is `+1` (proper rotation, preserves winding).
#[inline]
fn gltf_pos_to_wow(p: [f32; 3]) -> [f32; 3] {
    [p[2], p[0], p[1]]
}

/// Cyclic quaternion map matching [`gltf_pos_to_wow`]: `(x, y, z, w) -> (z, x, y, w)`.
#[inline]
fn gltf_quat_to_wow(q: [f32; 4]) -> [f32; 4] {
    [q[2], q[0], q[1], q[3]]
}

/// Cyclic scale map matching [`gltf_pos_to_wow`]: `(sx, sy, sz) -> (sz, sx, sy)`.
#[inline]
fn gltf_scale_to_wow(s: [f32; 3]) -> [f32; 3] {
    [s[2], s[0], s[1]]
}

#[inline]
fn quat_mul(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

#[inline]
fn quat_conj(q: [f32; 4]) -> [f32; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

#[inline]
fn quat_norm(q: [f32; 4]) -> [f32; 4] {
    let l = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if l > 1e-8 {
        [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
    } else {
        [0.0, 0.0, 0.0, 1.0]
    }
}

#[inline]
fn quat_rot_vec(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let [qx, qy, qz, qw] = q;
    let tx = 2.0 * (qy * v[2] - qz * v[1]);
    let ty = 2.0 * (qz * v[0] - qx * v[2]);
    let tz = 2.0 * (qx * v[1] - qy * v[0]);
    [
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
    ]
}

/// Column-major 4×4 matrix multiplication `a * b`.
fn mat4_mul(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for c in 0..4 {
        for r in 0..4 {
            out[c * 4 + r] = a[r] * b[c * 4]
                + a[4 + r] * b[c * 4 + 1]
                + a[8 + r] * b[c * 4 + 2]
                + a[12 + r] * b[c * 4 + 3];
        }
    }
    out
}

fn mat4_from_trs(t: [f32; 3], r: [f32; 4], s: [f32; 3]) -> [f32; 16] {
    let [x, y, z, w] = quat_norm(r);
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    [
        (1.0 - (yy + zz)) * s[0],
        (xy + wz) * s[0],
        (xz - wy) * s[0],
        0.0,
        (xy - wz) * s[1],
        (1.0 - (xx + zz)) * s[1],
        (yz + wx) * s[1],
        0.0,
        (xz + wy) * s[2],
        (yz - wx) * s[2],
        (1.0 - (xx + yy)) * s[2],
        0.0,
        t[0],
        t[1],
        t[2],
        1.0,
    ]
}

fn mat4_transform_point(m: &[f32; 16], p: [f32; 3]) -> [f32; 3] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}

fn mat4_transform_normal(m: &[f32; 16], n: [f32; 3]) -> [f32; 3] {
    let v = [
        m[0] * n[0] + m[4] * n[1] + m[8] * n[2],
        m[1] * n[0] + m[5] * n[1] + m[9] * n[2],
        m[2] * n[0] + m[6] * n[1] + m[10] * n[2],
    ];
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len > 1e-6 {
        [v[0] / len, v[1] / len, v[2] / len]
    } else {
        [0.0, 1.0, 0.0]
    }
}

/// Extract unit quaternion from the upper-left 3×3 of a column-major 4×4 matrix.
fn quat_from_mat4(m: &[f32; 16]) -> [f32; 4] {
    let norm_col = |c: usize| -> [f32; 3] {
        let (x, y, z) = (m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
        let l = (x * x + y * y + z * z).sqrt();
        if l > 1e-8 {
            [x / l, y / l, z / l]
        } else {
            let mut d = [0.0; 3];
            d[c] = 1.0;
            d
        }
    };
    let c0 = norm_col(0);
    let c1 = norm_col(1);
    let c2 = norm_col(2);
    let trace = c0[0] + c1[1] + c2[2];
    let q = if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        [(c1[2] - c2[1]) / s, (c2[0] - c0[2]) / s, (c0[1] - c1[0]) / s, 0.25 * s]
    } else if c0[0] > c1[1] && c0[0] > c2[2] {
        let s = (1.0 + c0[0] - c1[1] - c2[2]).sqrt() * 2.0;
        [0.25 * s, (c1[0] + c0[1]) / s, (c2[0] + c0[2]) / s, (c1[2] - c2[1]) / s]
    } else if c1[1] > c2[2] {
        let s = (1.0 + c1[1] - c0[0] - c2[2]).sqrt() * 2.0;
        [(c1[0] + c0[1]) / s, 0.25 * s, (c2[1] + c1[2]) / s, (c2[0] - c0[2]) / s]
    } else {
        let s = (1.0 + c2[2] - c0[0] - c1[1]).sqrt() * 2.0;
        [(c2[0] + c0[2]) / s, (c2[1] + c1[2]) / s, 0.25 * s, (c0[1] - c1[0]) / s]
    };
    quat_norm(q)
}

const MAT4_IDENTITY: [f32; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];

/// Split a `.glb` file into its JSON root and binary buffer slice.
fn parse_glb_chunks(bytes: &[u8]) -> Result<(Value, &[u8])> {
    if !is_glb(bytes) {
        bail!("not a binary glTF (.glb) file");
    }
    let version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    if version != 2 {
        bail!("unsupported glTF version {version}");
    }
    let mut offset = 12usize;
    let mut json_val: Option<Value> = None;
    let mut bin_slice: &[u8] = &[];
    while offset + 8 <= bytes.len() {
        let chunk_len = u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        let chunk_type = &bytes[offset + 4..offset + 8];
        let data_start = offset + 8;
        let data_end = data_start.saturating_add(chunk_len).min(bytes.len());
        let chunk_data = &bytes[data_start..data_end];
        if chunk_type == b"JSON" && json_val.is_none() {
            json_val = Some(
                serde_json::from_slice(chunk_data)
                    .map_err(|e| anyhow!("parsing glTF JSON chunk: {e}"))?,
            );
        } else if chunk_type == b"BIN\0" && bin_slice.is_empty() {
            bin_slice = chunk_data;
        }
        offset = data_end;
    }
    let json = json_val.ok_or_else(|| anyhow!("glTF missing JSON chunk"))?;
    Ok((json, bin_slice))
}

#[derive(Clone, Debug)]
struct NodeInfo {
    name: String,
    parent: Option<usize>,
    local_t: [f32; 3],
    local_r: [f32; 4],
    local_s: [f32; 3],
    world_mat: [f32; 16],
    world_r: [f32; 4],
    mesh: Option<usize>,
    skin: Option<usize>,
}

fn parse_nodes(json: &Value) -> Vec<NodeInfo> {
    let Some(nodes_arr) = json.get("nodes").and_then(Value::as_array) else {
        return Vec::new();
    };
    let n = nodes_arr.len();
    let mut parents = vec![None; n];
    for (i, node) in nodes_arr.iter().enumerate() {
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            for c in children.iter().filter_map(Value::as_u64) {
                let ci = c as usize;
                if ci < n {
                    parents[ci] = Some(i);
                }
            }
        }
    }
    let mut local_mats = vec![MAT4_IDENTITY; n];
    let mut infos: Vec<NodeInfo> = Vec::with_capacity(n);
    for (i, node) in nodes_arr.iter().enumerate() {
        let name = node
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut local_t = [0.0f32; 3];
        let mut local_r = [0.0, 0.0, 0.0, 1.0f32];
        let mut local_s = [1.0, 1.0, 1.0f32];
        if let Some(mat) = node.get("matrix").and_then(Value::as_array) {
            if mat.len() == 16 {
                let mut m = [0.0f32; 16];
                for (k, v) in mat.iter().enumerate() {
                    m[k] = v.as_f64().unwrap_or(0.0) as f32;
                }
                local_t = [m[12], m[13], m[14]];
                local_s = [
                    (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt().max(1e-6),
                    (m[4] * m[4] + m[5] * m[5] + m[6] * m[6]).sqrt().max(1e-6),
                    (m[8] * m[8] + m[9] * m[9] + m[10] * m[10]).sqrt().max(1e-6),
                ];
                local_r = quat_from_mat4(&m);
                local_mats[i] = m;
            }
        } else {
            if let Some(t) = node.get("translation").and_then(Value::as_array) {
                if t.len() >= 3 {
                    local_t = [
                        t[0].as_f64().unwrap_or(0.0) as f32,
                        t[1].as_f64().unwrap_or(0.0) as f32,
                        t[2].as_f64().unwrap_or(0.0) as f32,
                    ];
                }
            }
            if let Some(r) = node.get("rotation").and_then(Value::as_array) {
                if r.len() >= 4 {
                    local_r = quat_norm([
                        r[0].as_f64().unwrap_or(0.0) as f32,
                        r[1].as_f64().unwrap_or(0.0) as f32,
                        r[2].as_f64().unwrap_or(0.0) as f32,
                        r[3].as_f64().unwrap_or(1.0) as f32,
                    ]);
                }
            }
            if let Some(s) = node.get("scale").and_then(Value::as_array) {
                if s.len() >= 3 {
                    local_s = [
                        s[0].as_f64().unwrap_or(1.0) as f32,
                        s[1].as_f64().unwrap_or(1.0) as f32,
                        s[2].as_f64().unwrap_or(1.0) as f32,
                    ];
                }
            }
            local_mats[i] = mat4_from_trs(local_t, local_r, local_s);
        }
        let mesh = node.get("mesh").and_then(Value::as_u64).map(|v| v as usize);
        let skin = node.get("skin").and_then(Value::as_u64).map(|v| v as usize);
        infos.push(NodeInfo {
            name,
            parent: parents[i],
            local_t,
            local_r,
            local_s,
            world_mat: local_mats[i],
            world_r: local_r,
            mesh,
            skin,
        });
    }
    for i in 0..n {
        let mut chain = Vec::new();
        let mut cur = Some(i);
        let mut guard = 0;
        while let Some(c) = cur {
            if guard > n {
                break;
            }
            chain.push(c);
            cur = infos[c].parent;
            guard += 1;
        }
        let mut w_mat = MAT4_IDENTITY;
        let mut w_r = [0.0, 0.0, 0.0, 1.0f32];
        for &node_idx in chain.iter().rev() {
            w_mat = mat4_mul(&w_mat, &local_mats[node_idx]);
            w_r = quat_norm(quat_mul(w_r, infos[node_idx].local_r));
        }
        infos[i].world_mat = w_mat;
        infos[i].world_r = w_r;
    }
    infos
}

/// Resolve accessor metadata and return `(component_type, count, type_str, byte_offset, byte_stride, slice)`.
fn accessor_view<'a>(
    json: &'a Value,
    bin: &'a [u8],
    accessor_idx: usize,
) -> Option<(u32, usize, &'a str, usize, usize, &'a [u8])> {
    let acc = json.get("accessors")?.as_array()?.get(accessor_idx)?;
    let bv_idx = acc.get("bufferView")?.as_u64()? as usize;
    let bv = json.get("bufferViews")?.as_array()?.get(bv_idx)?;
    let comp_type = acc.get("componentType")?.as_u64()? as u32;
    let count = acc.get("count")?.as_u64()? as usize;
    let kind = acc.get("type")?.as_str()?;
    let acc_offset = acc.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let bv_offset = bv.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let bv_len = bv.get("byteLength")?.as_u64()? as usize;
    let comp_size = match comp_type {
        5120 | 5121 => 1usize,
        5122 | 5123 => 2usize,
        5125 | 5126 => 4usize,
        _ => return None,
    };
    let num_comp = match kind {
        "SCALAR" => 1usize,
        "VEC2" => 2usize,
        "VEC3" => 3usize,
        "VEC4" | "MAT2" => 4usize,
        "MAT3" => 9usize,
        "MAT4" => 16usize,
        _ => return None,
    };
    let elem_size = comp_size * num_comp;
    let stride = bv
        .get("byteStride")
        .and_then(Value::as_u64)
        .map(|s| s as usize)
        .unwrap_or(elem_size);
    let start = bv_offset.checked_add(acc_offset)?;
    let end = bv_offset.checked_add(bv_len)?.min(bin.len());
    if start > end {
        return None;
    }
    Some((comp_type, count, kind, 0, stride, &bin[start..end]))
}

fn read_f32_components(comp_type: u32, raw: &[u8], n: usize) -> [f32; 4] {
    let mut out = [0.0f32; 4];
    for i in 0..n.min(4) {
        out[i] = match comp_type {
            5126 => {
                let o = i * 4;
                if o + 4 <= raw.len() {
                    f32::from_le_bytes([raw[o], raw[o + 1], raw[o + 2], raw[o + 3]])
                } else {
                    0.0
                }
            }
            5121 => raw.get(i).copied().unwrap_or(0) as f32 / 255.0,
            5123 => {
                let o = i * 2;
                if o + 2 <= raw.len() {
                    u16::from_le_bytes([raw[o], raw[o + 1]]) as f32 / 65535.0
                } else {
                    0.0
                }
            }
            5120 => (raw.get(i).copied().unwrap_or(0) as i8 as f32 / 127.0).max(-1.0),
            5122 => {
                let o = i * 2;
                if o + 2 <= raw.len() {
                    (i16::from_le_bytes([raw[o], raw[o + 1]]) as f32 / 32767.0).max(-1.0)
                } else {
                    0.0
                }
            }
            _ => 0.0,
        };
    }
    out
}

fn read_vec3_accessor(json: &Value, bin: &[u8], idx: usize) -> Vec<[f32; 3]> {
    let Some((comp_type, count, _, _, stride, data)) = accessor_view(json, bin, idx) else {
        return Vec::new();
    };
    (0..count)
        .filter_map(|i| {
            let o = i.checked_mul(stride)?;
            let slice = data.get(o..)?;
            let c = read_f32_components(comp_type, slice, 3);
            Some([c[0], c[1], c[2]])
        })
        .collect()
}

fn read_vec2_accessor(json: &Value, bin: &[u8], idx: usize) -> Vec<[f32; 2]> {
    let Some((comp_type, count, _, _, stride, data)) = accessor_view(json, bin, idx) else {
        return Vec::new();
    };
    (0..count)
        .filter_map(|i| {
            let o = i.checked_mul(stride)?;
            let slice = data.get(o..)?;
            let c = read_f32_components(comp_type, slice, 2);
            Some([c[0], c[1]])
        })
        .collect()
}

fn read_vec4_accessor(json: &Value, bin: &[u8], idx: usize, default_w: f32) -> Vec<[f32; 4]> {
    let Some((comp_type, count, kind, _, stride, data)) = accessor_view(json, bin, idx) else {
        return Vec::new();
    };
    let n_comp = if kind == "VEC3" { 3 } else { 4 };
    (0..count)
        .filter_map(|i| {
            let o = i.checked_mul(stride)?;
            let slice = data.get(o..)?;
            let mut c = read_f32_components(comp_type, slice, n_comp);
            if n_comp == 3 {
                c[3] = default_w;
            }
            Some(c)
        })
        .collect()
}

fn read_scalar_f32_accessor(json: &Value, bin: &[u8], idx: usize) -> Vec<f32> {
    let Some((comp_type, count, _, _, stride, data)) = accessor_view(json, bin, idx) else {
        return Vec::new();
    };
    (0..count)
        .filter_map(|i| {
            let o = i.checked_mul(stride)?;
            let slice = data.get(o..)?;
            Some(read_f32_components(comp_type, slice, 1)[0])
        })
        .collect()
}

fn read_indices_accessor(json: &Value, bin: &[u8], idx: usize) -> Vec<u32> {
    let Some((comp_type, count, _, _, stride, data)) = accessor_view(json, bin, idx) else {
        return Vec::new();
    };
    (0..count)
        .filter_map(|i| {
            let o = i.checked_mul(stride)?;
            match comp_type {
                5121 => data.get(o).map(|&b| u32::from(b)),
                5123 => data
                    .get(o..o + 2)
                    .map(|b| u32::from(u16::from_le_bytes([b[0], b[1]]))),
                5125 => data
                    .get(o..o + 4)
                    .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                _ => None,
            }
        })
        .collect()
}

fn read_joints_accessor(json: &Value, bin: &[u8], idx: usize) -> Vec<[u16; 4]> {
    let Some((comp_type, count, _, _, stride, data)) = accessor_view(json, bin, idx) else {
        return Vec::new();
    };
    (0..count)
        .filter_map(|i| {
            let o = i.checked_mul(stride)?;
            let s = data.get(o..)?;
            match comp_type {
                5121 => {
                    if s.len() < 4 {
                        return None;
                    }
                    Some([
                        u16::from(s[0]),
                        u16::from(s[1]),
                        u16::from(s[2]),
                        u16::from(s[3]),
                    ])
                }
                5123 => {
                    if s.len() < 8 {
                        return None;
                    }
                    Some([
                        u16::from_le_bytes([s[0], s[1]]),
                        u16::from_le_bytes([s[2], s[3]]),
                        u16::from_le_bytes([s[4], s[5]]),
                        u16::from_le_bytes([s[6], s[7]]),
                    ])
                }
                _ => None,
            }
        })
        .collect()
}

/// Filter out unwanted / hidden Rosebud or debug nodes by name (`sanitizeCharacterModel` parity).
fn is_filtered_node_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    const BLOCKED: &[&str] = &[
        "penis",
        "genital",
        "phallus",
        "cock",
        "dick",
        "testicle",
        "scrotum",
        "erect",
        "flaccid",
        "nsfw",
        "collider_debug",
    ];
    BLOCKED.iter().any(|b| lower.contains(b))
}

/// Map a bone's name to WoW `KeyBoneID` (`2` LeftShoulder, `3` RightShoulder, `4` SpineLow, `6` Head).
fn infer_key_bone(name: &str) -> i16 {
    let lower = name.to_ascii_lowercase();
    let tail = lower.rsplit(':').next().unwrap_or(&lower);
    if tail == "spine" || tail == "spinelow" || tail == "spine1" || tail == "spine_01" {
        4
    } else if tail == "head" {
        6
    } else if tail == "uarml"
        || tail == "shoulderl"
        || tail == "leftarm"
        || tail == "leftshoulder"
        || tail == "upperarm_l"
    {
        2
    } else if tail == "uarmr"
        || tail == "shoulderr"
        || tail == "rightarm"
        || tail == "rightshoulder"
        || tail == "upperarm_r"
    {
        3
    } else {
        -1
    }
}

fn read_mat4_accessor(json: &Value, bin: &[u8], idx: usize) -> Vec<[f32; 16]> {
    let Some((comp_type, count, kind, _, stride, data)) = accessor_view(json, bin, idx) else {
        return Vec::new();
    };
    if comp_type != 5126 || kind != "MAT4" {
        return Vec::new();
    }
    (0..count)
        .filter_map(|i| {
            let o = i.checked_mul(stride)?;
            let slice = data.get(o..o + 64)?;
            let mut m = [0.0f32; 16];
            for k in 0..16 {
                let b = k * 4;
                m[k] = f32::from_le_bytes([slice[b], slice[b + 1], slice[b + 2], slice[b + 3]]);
            }
            Some(m)
        })
        .collect()
}

/// Skinning info extracted from the first skin (or node hierarchy if unskinned).
struct GlbSkinData {
    /// Node index for each bone in skeleton order.
    joint_nodes: Vec<usize>,
    /// Map from glTF node index → skeleton bone index (`0..joint_nodes.len()`).
    node_to_bone: HashMap<usize, u16>,
    /// Per-bone bind retarget matrix `M_bind_world[j] * IBM[j]` (`MAT4_IDENTITY` when `IBM == M_bind_world^-1`).
    bind_retarget: Vec<[f32; 16]>,
    /// Built `Skeleton` in WoW model space.
    skeleton: Skeleton,
}

fn extract_skin_data(json: &Value, bin: &[u8], nodes: &[NodeInfo]) -> GlbSkinData {
    let first_skin = json
        .get("skins")
        .and_then(Value::as_array)
        .and_then(|s| s.first());
    let joint_nodes: Vec<usize> = first_skin
        .and_then(|skin| skin.get("joints"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_u64)
                .map(|v| v as usize)
                .filter(|&ni| ni < nodes.len())
                .collect()
        })
        .unwrap_or_else(|| {
            if nodes.is_empty() {
                Vec::new()
            } else {
                vec![0]
            }
        });

    let ibms: Vec<[f32; 16]> = first_skin
        .and_then(|skin| skin.get("inverseBindMatrices"))
        .and_then(Value::as_u64)
        .map(|acc| read_mat4_accessor(json, bin, acc as usize))
        .unwrap_or_default();

    let mut node_to_bone = HashMap::with_capacity(joint_nodes.len());
    for (bi, &ni) in joint_nodes.iter().enumerate() {
        node_to_bone.insert(ni, bi as u16);
    }

    let mut bones = Vec::with_capacity(joint_nodes.len());
    let mut bind_retarget = Vec::with_capacity(joint_nodes.len());
    for (bi, &ni) in joint_nodes.iter().enumerate() {
        let node = &nodes[ni];
        let ibm = ibms.get(bi).copied();
        let retarget = ibm
            .map(|m| mat4_mul(&node.world_mat, &m))
            .unwrap_or(MAT4_IDENTITY);
        bind_retarget.push(retarget);

        // Walk up node parents until we find one that is also in `joint_nodes`.
        let mut p_cur = node.parent;
        let mut parent_bone: i16 = -1;
        while let Some(p_idx) = p_cur {
            if let Some(&p_bi) = node_to_bone.get(&p_idx) {
                parent_bone = p_bi as i16;
                break;
            }
            p_cur = nodes[p_idx].parent;
        }
        let pivot_gltf = [
            node.world_mat[12],
            node.world_mat[13],
            node.world_mat[14],
        ];
        bones.push(SkeletonBone {
            parent: parent_bone,
            pivot: gltf_pos_to_wow(pivot_gltf),
            key_bone: infer_key_bone(&node.name),
            billboard: None,
            parent_arm: None,
        });
    }

    if bones.is_empty() {
        bones.push(SkeletonBone {
            parent: -1,
            pivot: [0.0, 0.0, 0.0],
            key_bone: -1,
            billboard: None,
            parent_arm: None,
        });
        bind_retarget.push(MAT4_IDENTITY);
    }

    GlbSkinData {
        joint_nodes,
        node_to_bone,
        bind_retarget,
        skeleton: Skeleton { bones },
    }
}

/// Resolve material properties for a primitive: `(base_color, texture_path, skin_slot, blend, two_sided, emissive)`.
fn resolve_primitive_material(
    json: &Value,
    mat_idx: Option<usize>,
    dir: &str,
    skins: &[Option<String>],
) -> ([f32; 4], Option<String>, Option<u8>, ModelBlend, bool, bool) {
    let default_skin = skins.first().and_then(|o| o.clone()).map(|name| {
        if dir.is_empty() {
            format!("{name}.blp")
        } else {
            format!("{dir}\\{name}.blp")
        }
    });
    let fallback_tex = Some("Textures\\CelandiaWhite.blp".to_string());
    let Some(mat_i) = mat_idx else {
        return (
            [1.0, 1.0, 1.0, 1.0],
            default_skin.or(fallback_tex),
            Some(0),
            ModelBlend::Opaque,
            false,
            false,
        );
    };
    let Some(mat) = json
        .get("materials")
        .and_then(Value::as_array)
        .and_then(|m| m.get(mat_i))
    else {
        return (
            [1.0, 1.0, 1.0, 1.0],
            default_skin.or(fallback_tex),
            Some(0),
            ModelBlend::Opaque,
            false,
            false,
        );
    };
    let pbr = mat.get("pbrMetallicRoughness");
    let mut base_color = [1.0, 1.0, 1.0, 1.0f32];
    if let Some(bcf) = pbr
        .and_then(|p| p.get("baseColorFactor"))
        .and_then(Value::as_array)
    {
        if bcf.len() >= 4 {
            base_color = [
                bcf[0].as_f64().unwrap_or(1.0) as f32,
                bcf[1].as_f64().unwrap_or(1.0) as f32,
                bcf[2].as_f64().unwrap_or(1.0) as f32,
                bcf[3].as_f64().unwrap_or(1.0) as f32,
            ];
        }
    }
    let mut emissive = false;
    if let Some(ef) = mat.get("emissiveFactor").and_then(Value::as_array) {
        if ef.len() >= 3 {
            let er = ef[0].as_f64().unwrap_or(0.0) as f32;
            let eg = ef[1].as_f64().unwrap_or(0.0) as f32;
            let eb = ef[2].as_f64().unwrap_or(0.0) as f32;
            if er + eg + eb > 0.45 {
                emissive = true;
                base_color[0] = (base_color[0] + er * 0.5).min(1.0);
                base_color[1] = (base_color[1] + eg * 0.5).min(1.0);
                base_color[2] = (base_color[2] + eb * 0.5).min(1.0);
            }
        }
    }
    let two_sided = mat
        .get("doubleSided")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let alpha_mode = mat
        .get("alphaMode")
        .and_then(Value::as_str)
        .unwrap_or("OPAQUE");
    let blend = match alpha_mode {
        "MASK" => ModelBlend::AlphaTest,
        "BLEND" => ModelBlend::Blend,
        _ => ModelBlend::Opaque,
    };

    // Check if the material references an external `.blp` URI in `images`.
    let tex_uri = pbr
        .and_then(|p| p.get("baseColorTexture"))
        .and_then(|t| t.get("index"))
        .and_then(Value::as_u64)
        .and_then(|ti| {
            json.get("textures")?
                .as_array()?
                .get(ti as usize)?
                .get("source")?
                .as_u64()
        })
        .and_then(|si| {
            json.get("images")?
                .as_array()?
                .get(si as usize)?
                .get("uri")?
                .as_str()
        })
        .filter(|uri| !uri.starts_with("data:"))
        .map(|uri| {
            let clean = uri.replace('/', "\\");
            let stem = clean
                .strip_suffix(".png")
                .or_else(|| clean.strip_suffix(".jpg"))
                .or_else(|| clean.strip_suffix(".jpeg"))
                .or_else(|| clean.strip_suffix(".blp"))
                .unwrap_or(&clean);
            if stem.contains('\\') {
                format!("{stem}.blp")
            } else if dir.is_empty() {
                format!("{stem}.blp")
            } else {
                format!("{dir}\\{stem}.blp")
            }
        });

    let texture = tex_uri.or(default_skin).or(fallback_tex);
    (base_color, texture, Some(0), blend, two_sided, emissive)
}

/// Parse a `.glb` into `RenderSubmesh` batches in WoW model space.
pub fn parse_glb_render_submeshes(
    bytes: &[u8],
    dir: &str,
    skins: &[Option<String>],
) -> Result<Vec<RenderSubmesh>> {
    let (json, bin) = parse_glb_chunks(bytes)?;
    let nodes = parse_nodes(&json);
    let skin_data = extract_skin_data(&json, bin, &nodes);
    let Some(meshes_arr) = json.get("meshes").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    // Collect `(mesh_idx, node_idx, is_skinned)` instances from nodes, or all meshes if no nodes reference them.
    let mut mesh_instances: Vec<(usize, Option<usize>, bool)> = Vec::new();
    for (ni, node) in nodes.iter().enumerate() {
        if is_filtered_node_name(&node.name) {
            continue;
        }
        if let Some(mi) = node.mesh {
            if mi < meshes_arr.len() {
                mesh_instances.push((mi, Some(ni), node.skin.is_some()));
            }
        }
    }
    if mesh_instances.is_empty() {
        for mi in 0..meshes_arr.len() {
            mesh_instances.push((mi, None, !skin_data.joint_nodes.is_empty()));
        }
    }

    let mut out = Vec::new();
    for (mesh_idx, node_opt, is_skinned) in mesh_instances {
        let mesh_val = &meshes_arr[mesh_idx];
        if let Some(mname) = mesh_val.get("name").and_then(Value::as_str) {
            if is_filtered_node_name(mname) {
                continue;
            }
        }
        let Some(prims) = mesh_val.get("primitives").and_then(Value::as_array) else {
            continue;
        };
        let node_mat = node_opt
            .map(|ni| nodes[ni].world_mat)
            .unwrap_or(MAT4_IDENTITY);
        let rigid_bone = node_opt
            .and_then(|ni| {
                let mut cur = Some(ni);
                while let Some(c) = cur {
                    if let Some(&bi) = skin_data.node_to_bone.get(&c) {
                        return Some(bi);
                    }
                    cur = nodes[c].parent;
                }
                None
            })
            .unwrap_or(0);

        for prim in prims {
            let mode = prim.get("mode").and_then(Value::as_u64).unwrap_or(4);
            if mode != 4 {
                continue; // Only TRIANGLES (4)
            }
            let Some(attrs) = prim.get("attributes").and_then(Value::as_object) else {
                continue;
            };
            let Some(pos_acc) = attrs.get("POSITION").and_then(Value::as_u64) else {
                continue;
            };
            let raw_positions = read_vec3_accessor(&json, bin, pos_acc as usize);
            let vcount = raw_positions.len();
            if vcount == 0 {
                continue;
            }
            let raw_normals = attrs
                .get("NORMAL")
                .and_then(Value::as_u64)
                .map(|a| read_vec3_accessor(&json, bin, a as usize))
                .unwrap_or_default();
            let raw_uvs = attrs
                .get("TEXCOORD_0")
                .and_then(Value::as_u64)
                .map(|a| read_vec2_accessor(&json, bin, a as usize))
                .unwrap_or_default();
            let raw_colors = attrs
                .get("COLOR_0")
                .and_then(Value::as_u64)
                .map(|a| read_vec4_accessor(&json, bin, a as usize, 1.0))
                .unwrap_or_default();
            let raw_joints = attrs
                .get("JOINTS_0")
                .and_then(Value::as_u64)
                .map(|a| read_joints_accessor(&json, bin, a as usize))
                .unwrap_or_default();
            let raw_weights = attrs
                .get("WEIGHTS_0")
                .and_then(Value::as_u64)
                .map(|a| read_vec4_accessor(&json, bin, a as usize, 0.0))
                .unwrap_or_default();

            let indices: Vec<u32> = match prim.get("indices").and_then(Value::as_u64) {
                Some(idx_acc) => read_indices_accessor(&json, bin, idx_acc as usize),
                None => (0..vcount as u32).collect(),
            };
            if indices.len() < 3 {
                continue;
            }

            let mat_idx = prim
                .get("material")
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            let (base_color, texture, skin_slot, blend, two_sided, emissive) =
                resolve_primitive_material(&json, mat_idx, dir, skins);

            let nbones = skin_data.skeleton.bones.len().max(1) as u16;
            let (joints, weights) = if raw_joints.len() == vcount && raw_weights.len() == vcount {
                let j: Vec<[u16; 4]> = raw_joints
                    .into_iter()
                    .map(|jr| {
                        [
                            jr[0].min(nbones - 1),
                            jr[1].min(nbones - 1),
                            jr[2].min(nbones - 1),
                            jr[3].min(nbones - 1),
                        ]
                    })
                    .collect();
                let w: Vec<[f32; 4]> = raw_weights
                    .into_iter()
                    .map(|wr| {
                        let sum = wr[0] + wr[1] + wr[2] + wr[3];
                        if sum > 1e-6 {
                            [wr[0] / sum, wr[1] / sum, wr[2] / sum, wr[3] / sum]
                        } else {
                            [1.0, 0.0, 0.0, 0.0]
                        }
                    })
                    .collect();
                (j, w)
            } else {
                (
                    vec![[rigid_bone.min(nbones - 1), 0, 0, 0]; vcount],
                    vec![[1.0, 0.0, 0.0, 0.0]; vcount],
                )
            };

            let positions: Vec<[f32; 3]> = raw_positions
                .iter()
                .enumerate()
                .map(|(vi, &p)| {
                    let wp = if is_skinned {
                        let jr = joints[vi];
                        let wr = weights[vi];
                        let mut acc = [0.0f32; 3];
                        for k in 0..4 {
                            let wk = wr[k];
                            if wk > 1e-6 {
                                let m = skin_data
                                    .bind_retarget
                                    .get(jr[k] as usize)
                                    .unwrap_or(&MAT4_IDENTITY);
                                let tp = mat4_transform_point(m, p);
                                acc[0] += wk * tp[0];
                                acc[1] += wk * tp[1];
                                acc[2] += wk * tp[2];
                            }
                        }
                        acc
                    } else {
                        mat4_transform_point(&node_mat, p)
                    };
                    gltf_pos_to_wow(wp)
                })
                .collect();

            let normals: Vec<[f32; 3]> = if raw_normals.len() == vcount {
                raw_normals
                    .iter()
                    .enumerate()
                    .map(|(vi, &n)| {
                        let wn = if is_skinned {
                            let m = skin_data
                                .bind_retarget
                                .get(joints[vi][0] as usize)
                                .unwrap_or(&MAT4_IDENTITY);
                            mat4_transform_normal(m, n)
                        } else {
                            mat4_transform_normal(&node_mat, n)
                        };
                        gltf_pos_to_wow(wn)
                    })
                    .collect()
            } else {
                Vec::new()
            };

            let uvs: Vec<[f32; 2]> = if raw_uvs.len() == vcount {
                raw_uvs
            } else {
                vec![[0.5, 0.5]; vcount]
            };

            let vertex_colors: Vec<[f32; 4]> = if raw_colors.len() == vcount {
                raw_colors
                    .iter()
                    .map(|c| {
                        [
                            c[0] * base_color[0],
                            c[1] * base_color[1],
                            c[2] * base_color[2],
                            c[3] * base_color[3],
                        ]
                    })
                    .collect()
            } else if base_color != [1.0, 1.0, 1.0, 1.0] {
                vec![base_color; vcount]
            } else {
                Vec::new()
            };

            out.push(RenderSubmesh {
                positions,
                normals,
                uvs,
                indices,
                texture,
                skin_slot,
                geoset_id: 0,
                char_slot: None,
                blend,
                wrap_x: true,
                wrap_y: true,
                two_sided,
                joints,
                weights,
                vertex_colors,
                interior: false,
                emissive,
                icon_slot: false,
                sidn: None,
                window: false,
                additive: false,
                no_depth_write: false,
                no_depth_test: false,
                fog_policy: super::FogPolicy::Scene,
                billboard: None,
                welded_billboard: false,
                alpha_anim: None,
                uv_anim: None,
                uv_seq: None,
                uv_rot_seq: None,
                uv_scale_seq: None,
                rgb_anim: None,
                rgb_seq: None,
                wmo_batch: None,
                section: Some(out.len() as u16),
                env_map: false,
            });
        }
    }
    Ok(out)
}

/// Parse the `.glb` skeleton in WoW model space.
pub fn parse_glb_skeleton(bytes: &[u8]) -> Result<Skeleton> {
    let (json, bin) = parse_glb_chunks(bytes)?;
    let nodes = parse_nodes(&json);
    Ok(extract_skin_data(&json, bin, &nodes).skeleton)
}

/// Infer `(anim_id, looping, move_speed)` from a glTF animation clip name.
fn classify_clip_name(name: &str, idx: usize) -> (u16, bool, f32) {
    let lower = name.trim().to_ascii_lowercase();
    // Explicit prefix convention `<anim_id>:<name>` or `anim_<anim_id>` from our Celandia exporter.
    if let Some((prefix, _)) = lower.split_once(':') {
        if let Ok(id) = prefix.parse::<u16>() {
            let looping = !matches!(
                id,
                1 | 8
                    | 9
                    | 10
                    | 16
                    | 17
                    | 18
                    | 19
                    | 20
                    | 21
                    | 22
                    | 23
                    | 24
                    | 29
                    | 30
                    | 37
                    | 38
                    | 39
                    | 46
                    | 49
                    | 50
                    | 51
                    | 53
                    | 67
                    | 68
                    | 187
            );
            let move_speed = match id {
                4 | 11 | 12 | 13 => 2.5,
                5 => 7.0,
                42 | 43 | 44 | 45 => 4.5,
                143 => 9.5,
                _ => 0.0,
            };
            return (id, looping, move_speed);
        }
    }
    if lower.contains("death") || lower.contains("die") || lower.contains("dead") {
        (1, false, 0.0)
    } else if lower.contains("run") || lower.contains("sprint") || lower.contains("dash") {
        (5, true, 7.0)
    } else if lower.contains("walk") || lower.contains("move") || lower.contains("patrol") {
        (4, true, 2.5)
    } else if lower.contains("swim") {
        (42, true, 4.5)
    } else if lower.contains("jump") || lower.contains("leap") {
        (38, false, 0.0)
    } else if lower.contains("land") {
        (39, false, 0.0)
    } else if lower.contains("parry") || lower.contains("block") || lower.contains("guard") {
        (20, false, 0.0)
    } else if lower.contains("cast")
        || lower.contains("spell")
        || lower.contains("magic")
        || lower.contains("voltekka")
    {
        (51, false, 0.0)
    } else if lower.contains("omni")
        || lower.contains("airguitar")
        || lower.contains("summon")
        || lower.contains("song")
    {
        (53, false, 0.0)
    } else if lower.contains("whirlwind") || lower.contains("spin") {
        (73, true, 0.0)
    } else if lower.contains("attack")
        || lower.contains("slash")
        || lower.contains("strike")
        || lower.contains("hit")
        || lower.contains("hook")
        || lower.contains("plunge")
        || lower.contains("throw")
    {
        (16, false, 0.0)
    } else if lower.contains("talk") || lower.contains("chat") {
        (60, true, 0.0)
    } else if lower.contains("wave") || lower.contains("gesture") {
        (67, false, 0.0)
    } else if lower.contains("sit") {
        (97, true, 0.0)
    } else if lower.contains("idle") || lower.contains("stand") || idx == 0 {
        (0, true, 0.0)
    } else {
        // Map additional clips deterministically to combat/emote slots if unused.
        match idx {
            1 => (4, true, 2.5),
            2 => (5, true, 7.0),
            3 => (16, false, 0.0),
            4 => (1, false, 0.0),
            _ => (0, true, 0.0),
        }
    }
}

/// Compute overall bounding box `[min, max, radius]` in WoW model space from `RenderSubmesh` list.
fn compute_submesh_bounds(subs: &[RenderSubmesh]) -> ([f32; 3], [f32; 3], f32, f32) {
    let mut bmin = [f32::MAX; 3];
    let mut bmax = [f32::MIN; 3];
    let mut max_origin = 0.0f32;
    let mut any = false;
    for s in subs {
        for &p in &s.positions {
            any = true;
            for k in 0..3 {
                bmin[k] = bmin[k].min(p[k]);
                bmax[k] = bmax[k].max(p[k]);
            }
            let d = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            max_origin = max_origin.max(d);
        }
    }
    if !any {
        return ([-0.5, -0.5, 0.0], [0.5, 0.5, 2.0], 1.2, 2.0);
    }
    let dx = bmax[0] - bmin[0];
    let dy = bmax[1] - bmin[1];
    let dz = bmax[2] - bmin[2];
    let radius = 0.5 * (dx * dx + dy * dy + dz * dz).sqrt();
    (bmin, bmax, radius.max(0.5), max_origin.max(0.5))
}

/// Parse all keyframe animations from a `.glb` (or synthesize procedural clips if the `.glb` has
/// no animation tracks) in WoW model space.
pub fn parse_glb_animations(bytes: &[u8]) -> Vec<ModelAnimation> {
    let Ok((json, bin)) = parse_glb_chunks(bytes) else {
        return Vec::new();
    };
    let nodes = parse_nodes(&json);
    let skin_data = extract_skin_data(&json, bin, &nodes);
    let subs = parse_glb_render_submeshes(bytes, "", &[]).unwrap_or_default();
    let (bmin, bmax, bradius, _) = compute_submesh_bounds(&subs);
    let bounds_center = [
        0.5 * (bmin[0] + bmax[0]),
        0.5 * (bmin[1] + bmax[1]),
        0.5 * (bmin[2] + bmax[2]),
    ];

    let mut out: Vec<ModelAnimation> = Vec::new();
    let mut cursor_ms = 0u32;

    if let Some(anims_arr) = json.get("animations").and_then(Value::as_array) {
        for (idx, anim_val) in anims_arr.iter().enumerate() {
            let name = anim_val
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Stand");
            let (anim_id, looping, move_speed) = classify_clip_name(name, idx);
            let Some(samplers) = anim_val.get("samplers").and_then(Value::as_array) else {
                continue;
            };
            let Some(channels) = anim_val.get("channels").and_then(Value::as_array) else {
                continue;
            };

            let mut per_bone: HashMap<u16, BoneKeys> = HashMap::new();
            let mut max_time = 0.0f32;

            for ch in channels {
                let Some(sampler_idx) = ch.get("sampler").and_then(Value::as_u64) else {
                    continue;
                };
                let Some(target) = ch.get("target") else {
                    continue;
                };
                let Some(node_idx) = target
                    .get("node")
                    .and_then(Value::as_u64)
                    .map(|v| v as usize)
                else {
                    continue;
                };
                let Some(&bone_idx) = skin_data.node_to_bone.get(&node_idx) else {
                    continue;
                };
                let Some(path) = target.get("path").and_then(Value::as_str) else {
                    continue;
                };
                let Some(sampler) = samplers.get(sampler_idx as usize) else {
                    continue;
                };
                let Some(in_acc) = sampler.get("input").and_then(Value::as_u64) else {
                    continue;
                };
                let Some(out_acc) = sampler.get("output").and_then(Value::as_u64) else {
                    continue;
                };
                let times = read_scalar_f32_accessor(&json, bin, in_acc as usize);
                if times.is_empty() {
                    continue;
                }
                for &t in &times {
                    max_time = max_time.max(t);
                }

                let node = &nodes[node_idx];
                let parent_world_r = skin_data
                    .skeleton
                    .bones
                    .get(bone_idx as usize)
                    .and_then(|b| usize::try_from(b.parent).ok())
                    .and_then(|p_bi| skin_data.joint_nodes.get(p_bi).copied())
                    .map(|p_ni| nodes[p_ni].world_r)
                    .unwrap_or([0.0, 0.0, 0.0, 1.0]);
                let bind_world_r_inv = quat_conj(node.world_r);

                let entry = per_bone.entry(bone_idx).or_insert_with(|| BoneKeys {
                    bone: bone_idx,
                    translation: Vec::new(),
                    rotation: Vec::new(),
                    scale: Vec::new(),
                });

                match path {
                    "translation" => {
                        let vals = read_vec3_accessor(&json, bin, out_acc as usize);
                        // For cubic spline (3 values per key), pick the middle value at 3*k + 1.
                        let is_cubic = vals.len() == times.len() * 3;
                        for (k, &t) in times.iter().enumerate() {
                            let Some(&v) = vals.get(if is_cubic { k * 3 + 1 } else { k }) else {
                                break;
                            };
                            let delta_local = [
                                v[0] - node.local_t[0],
                                v[1] - node.local_t[1],
                                v[2] - node.local_t[2],
                            ];
                            let delta_world = quat_rot_vec(parent_world_r, delta_local);
                            entry.translation.push((t, gltf_pos_to_wow(delta_world)));
                        }
                    }
                    "rotation" => {
                        let vals = read_vec4_accessor(&json, bin, out_acc as usize, 1.0);
                        let is_cubic = vals.len() == times.len() * 3;
                        for (k, &t) in times.iter().enumerate() {
                            let Some(&q_raw) = vals.get(if is_cubic { k * 3 + 1 } else { k })
                            else {
                                break;
                            };
                            let q_local = quat_norm(q_raw);
                            // R_benilla_local = R_bind_world[p] * R_anim_local * R_bind_world[j]^-1
                            let q_benilla = quat_norm(quat_mul(
                                quat_mul(parent_world_r, q_local),
                                bind_world_r_inv,
                            ));
                            entry.rotation.push((t, gltf_quat_to_wow(q_benilla)));
                        }
                    }
                    "scale" => {
                        let vals = read_vec3_accessor(&json, bin, out_acc as usize);
                        let is_cubic = vals.len() == times.len() * 3;
                        for (k, &t) in times.iter().enumerate() {
                            let Some(&s) = vals.get(if is_cubic { k * 3 + 1 } else { k }) else {
                                break;
                            };
                            let rel_s = [
                                s[0] / node.local_s[0].max(1e-6),
                                s[1] / node.local_s[1].max(1e-6),
                                s[2] / node.local_s[2].max(1e-6),
                            ];
                            entry.scale.push((t, gltf_scale_to_wow(rel_s)));
                        }
                    }
                    _ => {}
                }
            }

            let duration = max_time.max(0.5);
            let dur_ms = (duration * 1000.0).round() as u32;
            let start_ms = cursor_ms;
            let end_ms = start_ms + dur_ms.max(100);
            cursor_ms = end_ms + 33;

            let mut bones: Vec<BoneKeys> = per_bone.into_values().collect();
            bones.sort_by_key(|b| b.bone);

            out.push(ModelAnimation {
                anim_id,
                seq_index: out.len(),
                start_ms,
                end_ms,
                duration,
                looping,
                move_speed,
                blend_time: 0.15,
                bounds_center,
                bounds_radius: bradius,
                bounds_min: bmin,
                bounds_max: bmax,
                frequency: 32767,
                min_replay: 1,
                max_replay: 1,
                bones,
                events: Vec::new(),
            });
        }
    }

    // Ensure every model has at least Stand (0) so the sequence clock and idle selection work.
    if !out.iter().any(|a| a.anim_id == 0) {
        let start_ms = cursor_ms;
        let end_ms = start_ms + 2000;
        out.insert(
            0,
            ModelAnimation {
                anim_id: 0,
                seq_index: 0,
                start_ms,
                end_ms,
                duration: 2.0,
                looping: true,
                move_speed: 0.0,
                blend_time: 0.15,
                bounds_center,
                bounds_radius: bradius,
                bounds_min: bmin,
                bounds_max: bmax,
                frequency: 32767,
                min_replay: 1,
                max_replay: 1,
                bones: Vec::new(),
                events: Vec::new(),
            },
        );
        for (i, a) in out.iter_mut().enumerate() {
            a.seq_index = i;
        }
    }

    // If a model has Stand/Walk/Run/Attack, alias Attack1H (17) and Attack2H (18) to AttackUnarmed (16)
    // so melee swings with equipped weapons play the attack animation seamlessly.
    if let Some(atk) = out.iter().find(|a| a.anim_id == 16).cloned() {
        for alias_id in [17u16, 18u16] {
            if !out.iter().any(|a| a.anim_id == alias_id) {
                let mut clone = atk.clone();
                clone.anim_id = alias_id;
                clone.seq_index = out.len();
                out.push(clone);
            }
        }
    }

    out
}

/// Build the `AnimationLookup` table (`AnimationData.dbc` id → sequence slot, `0xffff` if absent).
pub fn parse_glb_animation_lookup(bytes: &[u8]) -> Result<Vec<u16>> {
    let anims = parse_glb_animations(bytes);
    let max_id = anims
        .iter()
        .map(|a| a.anim_id as usize)
        .max()
        .unwrap_or(0)
        .max(150);
    let mut table = vec![0xffffu16; max_id + 1];
    for a in &anims {
        let slot = &mut table[a.anim_id as usize];
        if *slot == 0xffff {
            *slot = a.seq_index as u16;
        }
    }
    Ok(table)
}

/// Build the `PlayableAnimationLookup` table so any missing animation ID falls back gracefully
/// (e.g. combat attacks → `16`, movement → `5`/`4`, everything else → `0` Stand).
pub fn parse_glb_playable_animation_lookup(bytes: &[u8]) -> Result<Vec<PlayableAnim>> {
    let anims = parse_glb_animations(bytes);
    let has = |id: u16| anims.iter().any(|a| a.anim_id == id);
    let walk_fallback = if has(4) {
        4
    } else if has(5) {
        5
    } else {
        0
    };
    let run_fallback = if has(5) {
        5
    } else if has(4) {
        4
    } else {
        0
    };
    let atk_fallback = if has(16) { 16 } else { 0 };
    let spell_fallback = if has(51) {
        51
    } else if has(53) {
        53
    } else {
        atk_fallback
    };

    let mut table = Vec::with_capacity(150);
    for id in 0..150u16 {
        let resolved_id = if has(id) {
            id
        } else {
            match id {
                4 | 13 => walk_fallback,
                5 | 42 => run_fallback,
                16..=29 | 34 => atk_fallback,
                51..=57 | 73 | 124 => spell_fallback,
                _ => 0,
            }
        };
        table.push(PlayableAnim {
            resolved_id,
            dir_flags: 0,
        });
    }
    Ok(table)
}

/// Parse `.glb` bounds in WoW model space.
pub fn parse_glb_bounds(bytes: &[u8]) -> Result<M2Bounds> {
    let subs = parse_glb_render_submeshes(bytes, "", &[])?;
    let (bbox_min, bbox_max, sphere_radius, vert_max_from_origin) = compute_submesh_bounds(&subs);
    let rx = bbox_max[0] - bbox_min[0];
    let ry = bbox_max[1] - bbox_min[1];
    let rz = bbox_max[2] - bbox_min[2];
    let ring_footprint = if rx <= 1e-4 && ry <= 1e-4 {
        DEGENERATE_RING_FOOTPRINT
    } else {
        (0.5 * (rx * rx + ry * ry).sqrt()).sqrt()
    };
    Ok(M2Bounds {
        sphere_radius,
        bbox_min,
        bbox_max,
        vert_max_from_origin,
        ring_footprint,
        pivot_z: Some((bbox_min[2] + rz * 0.72).max(1.0)),
        stand_box_z: rz.max(1.0),
        swim_pivot_drop: 0.35,
    })
}

/// Extract standard WoW attachment points (`0` shield/left-forearm, `1` right hand, `2` left hand,
/// `11` helmet/head, `17` camera/neck, `18` name/top) from the `.glb` skeleton.
pub fn parse_glb_attachments(bytes: &[u8]) -> Result<Vec<M2Attachment>> {
    let (json, bin) = parse_glb_chunks(bytes)?;
    let nodes = parse_nodes(&json);
    let skin_data = extract_skin_data(&json, bin, &nodes);
    let skel = &skin_data.skeleton;

    let find_bone = |patterns: &[&str]| -> Option<u16> {
        for pat in patterns {
            for (bi, &ni) in skin_data.joint_nodes.iter().enumerate() {
                let lower = nodes[ni].name.to_ascii_lowercase();
                let tail = lower.rsplit(':').next().unwrap_or(&lower);
                if tail == *pat || lower.contains(pat) {
                    return Some(bi as u16);
                }
            }
        }
        None
    };

    let hand_r = find_bone(&["handr", "righthand", "hand_r", "r_hand"]).unwrap_or(0);
    let hand_l = find_bone(&["handl", "lefthand", "hand_l", "l_hand"]).unwrap_or(0);
    let farm_l = find_bone(&["farml", "leftforearm", "lowerarm_l"]).unwrap_or(hand_l);
    let head = find_bone(&["head"]).unwrap_or(0);
    let neck = find_bone(&["neck", "chest", "spine"]).unwrap_or(head);

    let pivot_of = |b: u16| -> [f32; 3] {
        skel.bones
            .get(b as usize)
            .map(|bone| bone.pivot)
            .unwrap_or([0.0, 0.0, 1.0])
    };

    let head_p = pivot_of(head);
    Ok(vec![
        M2Attachment {
            id: 0,
            bone: farm_l,
            position: pivot_of(farm_l),
        },
        M2Attachment {
            id: 1,
            bone: hand_r,
            position: pivot_of(hand_r),
        },
        M2Attachment {
            id: 2,
            bone: hand_l,
            position: pivot_of(hand_l),
        },
        M2Attachment {
            id: 11,
            bone: head,
            position: [head_p[0], head_p[1], head_p[2] + 0.15],
        },
        M2Attachment {
            id: 17,
            bone: neck,
            position: pivot_of(neck),
        },
        M2Attachment {
            id: 18,
            bone: head,
            position: [head_p[0], head_p[1], head_p[2] + 0.45],
        },
    ])
}

/// Default portrait and paperdoll cameras for `.glb` models in WoW model space.
pub fn parse_glb_portrait_camera(bytes: &[u8]) -> Option<M2PortraitCamera> {
    parse_glb_camera(bytes, 0)
}

pub fn parse_glb_camera(bytes: &[u8], index: usize) -> Option<M2PortraitCamera> {
    let bounds = parse_glb_bounds(bytes).ok()?;
    let min_z = bounds.bbox_min[2];
    let max_z = bounds.bbox_max[2];
    let height = (max_z - min_z).max(0.5);
    let cx = 0.5 * (bounds.bbox_min[0] + bounds.bbox_max[0]);
    let cy = 0.5 * (bounds.bbox_min[1] + bounds.bbox_max[1]);
    if index == 0 {
        // Portrait camera: framed around head/upper chest from front (+X in WoW model space).
        let target_z = min_z + height * 0.78;
        let dist = (height * 0.55).max(0.8);
        Some(M2PortraitCamera {
            fov: 0.75,
            far_clip: 100.0,
            near_clip: 0.05,
            position: [cx + dist, cy - dist * 0.18, target_z + height * 0.04],
            target: [cx, cy, target_z],
            roll: 0.0,
        })
    } else {
        // Full-body paperdoll / character-select camera (index 1).
        let target_z = min_z + height * 0.52;
        let dist = (height * 1.45).max(1.8);
        Some(M2PortraitCamera {
            fov: 0.85,
            far_clip: 100.0,
            near_clip: 0.05,
            position: [cx + dist, cy, target_z + height * 0.05],
            target: [cx, cy, target_z],
            roll: 0.0,
        })
    }
}

pub fn parse_glb_pane_cameras(bytes: &[u8]) -> Vec<M2PaneCamera> {
    let mut out = Vec::new();
    if let Some(c0) = parse_glb_camera(bytes, 0) {
        out.push(M2PaneCamera {
            camera_type: 0,
            still: c0,
            tracks: None,
        });
    }
    if let Some(c1) = parse_glb_camera(bytes, 1) {
        out.push(M2PaneCamera {
            camera_type: 1,
            still: c1,
            tracks: None,
        });
    }
    out
}

/// Build a collision mesh for `.glb` models when used as large architectural doodads / buildings.
pub fn parse_glb_collision_hull(bytes: &[u8]) -> Result<CollisionMesh> {
    let subs = parse_glb_render_submeshes(bytes, "", &[])?;
    let (bmin, bmax, radius, _) = compute_submesh_bounds(&subs);
    // Only collide architectural / large doodads (radius >= 2.2 yards) so small props/foliage don't block movement.
    if radius < 2.2 {
        return Ok(CollisionMesh::default());
    }
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for s in &subs {
        let base = positions.len() as u32;
        positions.extend_from_slice(&s.positions);
        indices.extend(s.indices.iter().map(|&i| base + i));
    }
    let _ = (bmin, bmax);
    Ok(CollisionMesh { positions, indices })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::Chain;
    use crate::install::wow_data;
    use crate::models::{
        load_wmo, parse_m2_animations, parse_m2_attachments, parse_m2_bounds,
        parse_m2_pane_cameras, parse_m2_render_submeshes, parse_m2_skeleton,
    };
    use crate::{
        load_anim_data_catalog, load_area_sound_catalog, load_area_table_catalog,
        load_auction_houses, load_chr_classes, load_creature_catalog, load_faction_catalog,
        load_gameobject_catalog, load_item_classes, load_item_display_catalog,
        load_loading_screens, load_map_catalog, load_minimap_translate, load_sound_kit_catalog,
        load_spell_catalog, load_spell_visual_catalog, load_tile_mesh, load_weapon_impact_catalog,
        load_weapon_swing_catalog, load_wmo_area_catalog, load_world_map_area_catalog,
        CharCreateCatalog, LightCatalog,
    };

    #[test]
    fn celandia_custom_world_and_glb_pipeline_loads() {
        let Some(data_dir) = wow_data() else {
            return;
        };
        if !data_dir.join("World/Maps/Celandia/Celandia.wdt").is_file() {
            return;
        }

        let mut chain = Chain::open(&data_dir).expect("Chain::open on Celandia WoW/Data");

        // 1. Verify DBC catalog loaders parse our generated WDBC tables cleanly
        let maps = load_map_catalog(&mut chain).expect("load_map_catalog");
        assert!(maps.directory(0).is_some());
        assert_eq!(maps.directory(1), Some("Elsewhere"));

        let creatures = load_creature_catalog(&mut chain).expect("load_creature_catalog");
        assert!(creatures.model(1).is_some());
        assert!(creatures.model(20).is_some());
        assert!(creatures.model(100).is_some());

        let gameobjects = load_gameobject_catalog(&mut chain).expect("load_gameobject_catalog");
        assert!(gameobjects.model_path(114).is_some());
        assert!(gameobjects.model_path(1267).is_some());

        let _spells = load_spell_catalog(&mut chain).expect("load_spell_catalog");
        let _items = load_item_display_catalog(&mut chain).expect("load_item_display_catalog");
        let _classes = load_chr_classes(&mut chain).expect("load_chr_classes");
        let _visuals = load_spell_visual_catalog(&mut chain).expect("load_spell_visual_catalog");
        let anims = load_anim_data_catalog(&mut chain).expect("load_anim_data_catalog");
        assert!(anims.name(17).is_some()); // Attack1H
        assert!(anims.name(19).is_some()); // Attack2HL
        let _areas = load_area_table_catalog(&mut chain).expect("load_area_table_catalog");
        let _factions = load_faction_catalog(&mut chain).expect("load_faction_catalog");
        let _lights = LightCatalog::load(&mut chain).expect("LightCatalog::load");
        let _char_create = CharCreateCatalog::load(&mut chain).expect("CharCreateCatalog::load");

        // Verify Audio, UI, WorldMap & WMOArea DBC catalogs
        let sound_kits = load_sound_kit_catalog(&mut chain).expect("load_sound_kit_catalog");
        assert!(sound_kits.get(233).is_some());
        let _area_sounds = load_area_sound_catalog(&mut chain).expect("load_area_sound_catalog");
        let _swings = load_weapon_swing_catalog(&mut chain).expect("load_weapon_swing_catalog");
        let _impacts = load_weapon_impact_catalog(&mut chain).expect("load_weapon_impact_catalog");
        let wmo_areas = load_wmo_area_catalog(&mut chain).expect("load_wmo_area_catalog");
        assert!(wmo_areas.default_row(1001, 0).is_some());
        let world_maps =
            load_world_map_area_catalog(&mut chain).expect("load_world_map_area_catalog");
        assert!(!world_maps.is_empty());
        let _loading = load_loading_screens(&mut chain).expect("load_loading_screens");
        let _auctions = load_auction_houses(&mut chain).expect("load_auction_houses");
        let _item_classes = load_item_classes(&mut chain).expect("load_item_classes");

        // 2. Verify Celandia (Map 0) & Elsewhere (Map 1) WDT + ADT tile mesh loading
        let tile =
            load_tile_mesh(&mut chain, "Celandia", 31, 31).expect("load_tile_mesh Celandia 31,31");
        assert_eq!(tile.chunks.len(), 256);
        assert!(!tile.wmos.is_empty());

        let elsewhere_tile = load_tile_mesh(&mut chain, "Elsewhere", 31, 31)
            .expect("load_tile_mesh Elsewhere 31,31");
        assert_eq!(elsewhere_tile.chunks.len(), 256);

        // 3. Verify Enterable Celandia WMO Building (PorcelainPalace.wmo)
        let palace_root_bytes = chain
            .read_file(r"World\wmo\Celandia\PorcelainPalace\PorcelainPalace.wmo")
            .expect("read PorcelainPalace.wmo root");
        let palace_root =
            crate::models::parse_wmo_root(&palace_root_bytes).expect("parse PorcelainPalace root");
        assert_eq!(palace_root.group_count(), 2); // _000 exterior + _001 interior
        assert!(!palace_root.doodads().is_empty());

        let palace_submeshes = load_wmo(
            &mut chain,
            r"World\wmo\Celandia\PorcelainPalace\PorcelainPalace.wmo",
        )
        .expect("load PorcelainPalace.wmo submeshes");
        assert!(!palace_submeshes.is_empty());
        assert!(palace_submeshes.iter().any(|s| s.interior));

        // 4. Verify Minimap TRS & BLP2 tile loading
        let trs = load_minimap_translate(&mut chain).expect("load_minimap_translate");
        assert!(trs.tile("Celandia", 31, 31).is_some());

        let blp_bytes = chain
            .read_file(r"textures\Minimap\celandia_31_31.blp")
            .expect("read celandia_31_31.blp");
        let (w, h, _rgba) = crate::blp_to_rgba(&blp_bytes).expect("decode celandia_31_31.blp");
        assert_eq!(w, 256);
        assert_eq!(h, 256);

        // 5. Verify rigged Celandia GLB character (Rook) via M2 entry points
        let rook_bytes = chain
            .read_file(r"Creature\Celandia\Rook\Rook.m2")
            .expect("read Rook.m2 (GLB)");
        assert!(is_glb(&rook_bytes));

        let submeshes = parse_m2_render_submeshes(&rook_bytes, "", &[]).expect("Rook submeshes");
        assert!(!submeshes.is_empty());
        assert!(submeshes[0].positions.len() > 100);

        let skel = parse_m2_skeleton(&rook_bytes).expect("Rook skeleton");
        assert!(skel.bones.len() >= 21);

        let anim = parse_m2_animations(&rook_bytes);
        assert!(anim.len() >= 28); // Full Mixamo + reverse-engineered combat & locomotion library

        let bounds = parse_m2_bounds(&rook_bytes).expect("Rook bounds");
        assert!(bounds.sphere_radius > 0.4);

        let attachments = parse_m2_attachments(&rook_bytes).expect("Rook attachments");
        assert!(attachments.len() >= 4);

        let cameras = parse_m2_pane_cameras(&rook_bytes);
        assert_eq!(cameras.len(), 2);
    }
}


