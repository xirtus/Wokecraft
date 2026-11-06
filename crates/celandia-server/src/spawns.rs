//! Celandia Atlas heightfield, Kingdom hubs, Creature templates, Item templates, and World spawns.

use crate::opcodes::{
    make_unit_guid, FACTION_FRIENDLY, FACTION_MONSTER, UNIT_NPC_FLAG_GOSSIP,
    UNIT_NPC_FLAG_QUESTGIVER, UNIT_NPC_FLAG_VENDOR,
};

pub const SEA_LEVEL: f32 = -20.0;

// ============================================================================
// 1. Celandia Atlas Heightfield & Biome Sampler (Ported from `build-celandia-data.mjs`)
// ============================================================================

fn hash2(ix: i32, iz: i32) -> f32 {
    let n = (ix.wrapping_mul(374_761_393)).wrapping_add(iz.wrapping_mul(668_265_263));
    let n = (n ^ (n >> 13)).wrapping_mul(1_274_126_177);
    let u = (n ^ (n >> 16)) as u32;
    (u & 0x00FF_FFFF) as f32 / 16_777_216.0
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn clamp01(t: f32) -> f32 {
    t.clamp(0.0, 1.0)
}

fn smooth(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp01((x - edge0) / (edge1 - edge0));
    t * t * (3.0 - 2.0 * t)
}

fn value_noise(x: f32, z: f32) -> f32 {
    let ix = x.floor() as i32;
    let iz = z.floor() as i32;
    let fx = x - ix as f32;
    let fz = z - iz as f32;
    let u = fx * fx * (3.0 - 2.0 * fx);
    let v = fz * fz * (3.0 - 2.0 * fz);
    let a = hash2(ix, iz);
    let b = hash2(ix + 1, iz);
    let c = hash2(ix, iz + 1);
    let d = hash2(ix + 1, iz + 1);
    lerp(lerp(a, b, u), lerp(c, d, u), v) * 2.0 - 1.0
}

fn fbm(mut x: f32, mut z: f32, octaves: usize) -> f32 {
    let mut sum = 0.0f32;
    let mut amp = 0.5f32;
    for _ in 0..octaves {
        sum += amp * value_noise(x, z);
        x = x * 2.02 + 17.3;
        z = z * 2.02 - 11.7;
        amp *= 0.5;
    }
    sum
}

struct IslandDef {
    x: f32,
    z: f32,
    rx: f32,
    rz: f32,
}

const ISLANDS: [IslandDef; 4] = [
    IslandDef {
        x: 0.0,
        z: -110.0,
        rx: 330.0,
        rz: 300.0,
    }, // wake
    IslandDef {
        x: -470.0,
        z: -430.0,
        rx: 205.0,
        rz: 205.0,
    }, // frost
    IslandDef {
        x: 480.0,
        z: 40.0,
        rx: 200.0,
        rz: 210.0,
    }, // glass
    IslandDef {
        x: 330.0,
        z: -500.0,
        rx: 185.0,
        rz: 175.0,
    }, // aureate
];

const NOCTURNUM_ISLE: IslandDef = IslandDef {
    x: -360.0,
    z: 320.0,
    rx: 145.0,
    rz: 145.0,
};

const CROSSINGS: [([f32; 2], [f32; 2], f32); 3] = [
    ([-215.0, -255.0], [-330.0, -345.0], 26.0),
    ([255.0, 10.0], [330.0, 30.0], 26.0),
    ([170.0, -330.0], [235.0, -405.0], 24.0),
];

fn island_dist(isle: &IslandDef, x: f32, z: f32, n: f32) -> f32 {
    let dx = (x - isle.x) / isle.rx;
    let dz = (z - isle.z) / isle.rz;
    let a = dz.atan2(dx);
    let coast = 1.0
        + 0.09 * (a * 3.0 + isle.x * 0.01).sin()
        + 0.06 * (a * 7.0 + isle.z * 0.02).sin()
        + 0.08 * n;
    dx.hypot(dz) / coast
}

fn biome_weights(x: f32, z: f32) -> ([f32; 4], [f32; 4]) {
    let n = fbm(x * 0.006, z * 0.006, 3);
    let mut dists = [0.0f32; 4];
    let mut w = [0.0f32; 4];
    let mut sum = 0.0f32;
    for i in 0..4 {
        let d = island_dist(&ISLANDS[i], x, z, n);
        dists[i] = d;
        let wi = if i == 0 {
            smooth(1.45, 0.55, d) + 0.02
        } else {
            smooth(1.18, 0.9, d) * 3.0
        };
        w[i] = wi;
        sum += wi;
    }
    if sum > 0.0 {
        for wi in &mut w {
            *wi /= sum;
        }
    }
    (w, dists)
}

fn wake_height(x: f32, z: f32) -> f32 {
    let folds =
        (x * 0.043 + z * 0.019).sin() * 1.6 + (z * 0.055).sin() * 1.1 + (x * 0.1 - z * 0.08).sin() * 0.4;
    let edge_z = -70.0 + (x * 0.021).sin() * 9.0 + (x * 0.053).sin() * 4.0;
    let scarp = smooth(edge_z + 2.0, edge_z - 10.0, z);
    let hills = 9.0 * (-((x + 92.0).powi(2) / 1600.0 + (z - 40.0).powi(2) / 1500.0)).exp()
        + 13.0 * (-((x - 96.0).powi(2) / 1300.0 + (z - 10.0).powi(2) / 900.0)).exp()
        + 6.0 * fbm(x * 0.012, z * 0.012, 3);
    let mut plateau = 1.8 + folds + hills.max(0.0);
    plateau = lerp(plateau, 0.2, 1.0 - smooth(9.0, 26.0, x.hypot(z)));
    let valley_base =
        -13.5 + 1.6 + folds * 0.6 + 4.0 * fbm(x * 0.01 + 4.0, z * 0.01, 3) + 9.0 * smooth(-200.0, -340.0, z);
    let mut h = lerp(plateau, valley_base, scarp);
    let md = (x - 70.0).hypot((z + 380.0) * 1.1);
    h += 70.0 * (-((md / 105.0).powi(2)) * 2.2).exp()
        + 26.0 * (-((md / (105.0 * 1.9)).powi(2))).exp();
    h += 22.0
        * smooth(0.25, 0.6, fbm(x * 0.008 - 3.0, z * 0.008 + 7.0, 2))
        * smooth(-120.0, -190.0, z)
        * smooth(-40.0, -200.0, x);
    h
}

fn frost_height(x: f32, z: f32) -> f32 {
    let d = (x + 470.0).hypot(z + 430.0);
    let mut h = 4.0 + 10.0 * fbm(x * 0.009, z * 0.009, 4) + 6.0 * smooth(160.0, 40.0, d);
    for &(px, pz, ph, pr) in &[
        (-560.0f32, -540.0f32, 72.0f32, 55.0f32),
        (-470.0, -585.0, 58.0, 46.0),
        (-600.0, -430.0, 50.0, 42.0),
        (-380.0, -560.0, 40.0, 38.0),
    ] {
        let r = (x - px).hypot(z - pz) / pr;
        h += ph * (-r * r * 1.4).exp() * (1.0 - 0.25 * (-r * r * 8.0).exp());
    }
    h
}

fn glass_height(x: f32, z: f32) -> f32 {
    let raw = 6.0
        + 30.0 * smooth(-0.05, 0.55, fbm(x * 0.007 + 11.0, z * 0.007 - 4.0, 4))
        + 3.0 * fbm(x * 0.03, z * 0.03, 2);
    let step = 6.5;
    let q = (raw / step).floor() * step;
    let f = raw - q;
    let terraced = q + step * smooth(0.72, 0.98, f / step);
    let dunes = 1.3 * (x * 0.09 + (z * 0.05).sin() * 2.0).sin() * (z * 0.02).sin();
    lerp(raw, terraced, 0.85) + dunes
}

fn aureate_height(x: f32, z: f32) -> f32 {
    let d = (x - 330.0).hypot(z + 500.0);
    let ring =
        smooth(150.0, 120.0, d) * 3.0 + smooth(95.0, 70.0, d) * 3.5 + smooth(45.0, 30.0, d) * 3.0;
    3.0 + ring + 0.7 * fbm(x * 0.02, z * 0.02, 2)
}

/// Sample the Celandia ground elevation `wz` at WoW coordinates `(wx, wy)` where `cx = -wy, cz = -wx`.
pub fn sample_celandia_height(wx: f32, wy: f32) -> f32 {
    let cx = -wy;
    let cz = -wx;
    let (w, dists) = biome_weights(cx, cz);
    let mut land = 0.0f32;
    if w[0] > 0.001 {
        land += w[0] * wake_height(cx, cz);
    }
    if w[1] > 0.001 {
        land += w[1] * frost_height(cx, cz);
    }
    if w[2] > 0.001 {
        land += w[2] * glass_height(cx, cz);
    }
    if w[3] > 0.001 {
        land += w[3] * aureate_height(cx, cz);
    }
    let mut mask = 0.0f32;
    for &d in &dists {
        mask = mask.max(smooth(1.02, 0.86, d));
    }
    for &(a, b, cw) in &CROSSINGS {
        let dx = b[0] - a[0];
        let dz = b[1] - a[1];
        let len2 = dx * dx + dz * dz;
        let t = clamp01(((cx - a[0]) * dx + (cz - a[1]) * dz) / len2);
        let d = (cx - a[0] - dx * t).hypot(cz - a[1] - dz * t);
        mask = mask.max(smooth(cw, cw * 0.45, d));
    }
    let seabed = SEA_LEVEL - 9.0 - 12.0 * smooth(0.0, 0.4, -fbm(cx * 0.004, cz * 0.004, 2));
    let mut h = lerp(seabed, land.max(SEA_LEVEL + 1.5 + 3.0 * mask), mask);

    if cx > -535.0 && cx < -180.0 && cz > 150.0 && cz < 495.0 {
        let ndx = (cx - NOCTURNUM_ISLE.x) / NOCTURNUM_ISLE.rx;
        let ndz = (cz - NOCTURNUM_ISLE.z) / NOCTURNUM_ISLE.rz;
        let nr = (cx - NOCTURNUM_ISLE.x).hypot(cz - NOCTURNUM_ISLE.z);
        let noct_dist = ndx.hypot(ndz);
        let noct_mask = smooth(1.02, 0.78, noct_dist);
        if noct_mask > 0.001 {
            let mut noct_h = 3.8 + 1.1 * fbm(cx * 0.018, cz * 0.018, 2);
            noct_h = lerp(noct_h, 4.6, smooth(36.0, 28.0, nr));
            h = lerp(h, noct_h, noct_mask);
        }
    }
    h
}

/// Sample the `AreaTable.dbc` ID (1..=5) at WoW world coordinates `(wx, wy)`.
pub fn sample_celandia_area(wx: f32, wy: f32) -> u32 {
    let cx = -wy;
    let cz = -wx;
    if (cx - NOCTURNUM_ISLE.x).hypot(cz - NOCTURNUM_ISLE.z) < NOCTURNUM_ISLE.rx * 1.25 {
        return 5; // Nocturnum Obsidian Isle
    }
    let (w, _) = biome_weights(cx, cz);
    if w[1] >= w[0] && w[1] >= w[2] && w[1] >= w[3] && w[1] > 0.25 {
        return 2; // Frostbell Lagoon
    }
    if w[2] >= w[0] && w[2] >= w[3] && w[2] > 0.25 {
        return 3; // Glasswake Mesas
    }
    if w[3] >= w[0] && w[3] > 0.25 {
        return 4; // The Aureate Reach
    }
    1 // The Porcelain Wake
}

/// Convert Celandia `(cx, cz)` coordinates into WoW `(wx, wy, wz)` on the terrain surface.
pub fn celandia_to_wow(cx: f32, cz: f32) -> (f32, f32, f32) {
    let wx = -cz;
    let wy = -cx;
    let wz = sample_celandia_height(wx, wy).max(-18.0) + 0.15;
    (wx, wy, wz)
}

// ============================================================================
// 2. Kingdom Hubs & Teleport Destinations
// ============================================================================

#[derive(Debug, Clone, Copy)]
pub struct TeleportLocation {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub map_id: u32,
    pub zone_id: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub orientation: f32,
}

pub fn kingdom_locations() -> Vec<TeleportLocation> {
    let (wake_x, wake_y, wake_z) = celandia_to_wow(0.0, 1.0);
    let (frost_x, frost_y, frost_z) = celandia_to_wow(-416.0, -336.5);
    let (glass_x, glass_y, glass_z) = celandia_to_wow(398.0, 64.0);
    let (aur_x, aur_y, aur_z) = celandia_to_wow(296.0, -496.0);
    let (noc_x, noc_y, noc_z) = celandia_to_wow(-360.0, 318.0);
    vec![
        TeleportLocation {
            name: "The Porcelain Wake (Lowbell Court)",
            aliases: &["porcelain", "wake", "lowbell", "court", "home", "start"],
            map_id: 0,
            zone_id: 1,
            x: wake_x,
            y: wake_y,
            z: wake_z,
            orientation: 0.0,
        },
        TeleportLocation {
            name: "Frostbell Lagoon (Bellmere Pavilion)",
            aliases: &["frostbell", "frost", "lagoon", "serein", "bellmere"],
            map_id: 0,
            zone_id: 2,
            x: frost_x,
            y: frost_y,
            z: frost_z,
            orientation: 0.8,
        },
        TeleportLocation {
            name: "Glasswake Mesas (Nightglass Court)",
            aliases: &["glasswake", "glass", "mesa", "mesas", "solenne"],
            map_id: 0,
            zone_id: 3,
            x: glass_x,
            y: glass_y,
            z: glass_z,
            orientation: 1.5,
        },
        TeleportLocation {
            name: "The Aureate Reach (Orrery Steps)",
            aliases: &["aureate", "reach", "orrery", "avelune", "oriel"],
            map_id: 0,
            zone_id: 4,
            x: aur_x,
            y: aur_y,
            z: aur_z,
            orientation: 3.14,
        },
        TeleportLocation {
            name: "Nocturnum Obsidian Isle (Shadow-Cinder Keep)",
            aliases: &["nocturnum", "obsidian", "isle", "caldera", "colossus"],
            map_id: 0,
            zone_id: 5,
            x: noc_x,
            y: noc_y,
            z: noc_z,
            orientation: 4.7,
        },
        TeleportLocation {
            name: "The Elsewhere Sanctum (Instance Map 1)",
            aliases: &["elsewhere", "sanctum", "instance", "dungeon", "archipelago"],
            map_id: 1,
            zone_id: 1,
            x: wake_x,
            y: wake_y,
            z: wake_z,
            orientation: 0.0,
        },
    ]
}

pub fn find_teleport_location(query: &str) -> Option<TeleportLocation> {
    let q = query.trim().to_ascii_lowercase();
    kingdom_locations().into_iter().find(|loc| {
        loc.aliases
            .iter()
            .any(|alias| *alias == q || q.contains(alias))
    })
}

/// Default spawn location for a newly created character based on race (1..=9).
pub fn default_spawn_for_race(race: u8) -> TeleportLocation {
    let locs = kingdom_locations();
    match race {
        // Frostbell races / Dwarf / Gnome start near Lowbell or Frostbell, but starting everyone
        // in Lowbell Bell Garden (Map 0) ensures all players and the Court Cast meet immediately!
        _ => locs[0],
    }
}

// ============================================================================
// 3. Item Templates (Celandia Weapons, Shields & Story Relics)
// ============================================================================

#[derive(Debug, Clone)]
pub struct ItemTemplate {
    pub entry: u32,
    pub class: u32,
    pub subclass: u32,
    pub name: &'static str,
    pub display_id: u32,
    pub quality: u32,
    pub buy_price: u32,
    pub sell_price: u32,
    pub inventory_type: u32,
    pub item_level: u32,
    pub required_level: u32,
    pub max_count: u32,
    pub stackable: u32,
    pub min_dmg: f32,
    pub max_dmg: f32,
    pub delay_ms: u32,
    pub armor: u32,
    pub bonus_stat_type: u32,
    pub bonus_stat_val: i32,
    pub description: &'static str,
    pub material: u32,
    pub sheath: u32,
}

pub static ITEM_TEMPLATES: &[ItemTemplate] = &[
    ItemTemplate {
        entry: 50001,
        class: 2,
        subclass: 7, // 1H Sword
        name: "Porcelain Rapier",
        display_id: 50001,
        quality: 3, // Rare
        buy_price: 1200,
        sell_price: 300,
        inventory_type: 21, // Main Hand
        item_level: 20,
        required_level: 1,
        max_count: 0,
        stackable: 1,
        min_dmg: 14.0,
        max_dmg: 26.0,
        delay_ms: 1800,
        armor: 0,
        bonus_stat_type: 3, // Agility
        bonus_stat_val: 7,
        description: "Forged in Moss Calder's Lowbell kiln, balanced for a route-mender's cadence.",
        material: 1,
        sheath: 3,
    },
    ItemTemplate {
        entry: 50002,
        class: 2,
        subclass: 10, // Staff
        name: "Frostbell Chime Staff",
        display_id: 50002,
        quality: 3,
        buy_price: 1500,
        sell_price: 375,
        inventory_type: 17, // Two-Hand
        item_level: 22,
        required_level: 1,
        max_count: 0,
        stackable: 1,
        min_dmg: 18.0,
        max_dmg: 34.0,
        delay_ms: 2400,
        armor: 0,
        bonus_stat_type: 5, // Intellect
        bonus_stat_val: 10,
        description: "Resonates with the last warm bell beneath Serein's frozen ribbon.",
        material: 2,
        sheath: 1,
    },
    ItemTemplate {
        entry: 50003,
        class: 2,
        subclass: 2, // Bow
        name: "Glasswake Prism Bow",
        display_id: 50003,
        quality: 3,
        buy_price: 1400,
        sell_price: 350,
        inventory_type: 15, // Ranged
        item_level: 22,
        required_level: 1,
        max_count: 0,
        stackable: 1,
        min_dmg: 15.0,
        max_dmg: 28.0,
        delay_ms: 2100,
        armor: 0,
        bonus_stat_type: 3, // Agility
        bonus_stat_val: 8,
        description: "Splits desert starlight into turquoise stormglass volleys.",
        material: 2,
        sheath: 1,
    },
    ItemTemplate {
        entry: 50004,
        class: 2,
        subclass: 7, // 1H Sword
        name: "Aureate Sunblade",
        display_id: 50004,
        quality: 4, // Epic
        buy_price: 2500,
        sell_price: 625,
        inventory_type: 21, // Main Hand
        item_level: 25,
        required_level: 1,
        max_count: 0,
        stackable: 1,
        min_dmg: 20.0,
        max_dmg: 38.0,
        delay_ms: 2000,
        armor: 0,
        bonus_stat_type: 4, // Strength
        bonus_stat_val: 11,
        description: "Gilded travertine blade of the Aureate Reach honor guard.",
        material: 1,
        sheath: 3,
    },
    ItemTemplate {
        entry: 50005,
        class: 2,
        subclass: 15, // Dagger / Hook
        name: "Nocturnum Lantern Hook",
        display_id: 50005,
        quality: 4,
        buy_price: 2400,
        sell_price: 600,
        inventory_type: 21, // Main Hand
        item_level: 25,
        required_level: 1,
        max_count: 0,
        stackable: 1,
        min_dmg: 17.0,
        max_dmg: 32.0,
        delay_ms: 1600,
        armor: 0,
        bonus_stat_type: 7, // Stamina
        bonus_stat_val: 10,
        description: "Latch's brass crossing-hook tempered in Nocturnum shadow-cinder.",
        material: 1,
        sheath: 3,
    },
    ItemTemplate {
        entry: 50006,
        class: 2,
        subclass: 6, // Polearm
        name: "Tekka Crystal Lance",
        display_id: 50006,
        quality: 4,
        buy_price: 3200,
        sell_price: 800,
        inventory_type: 17, // Two-Hand
        item_level: 30,
        required_level: 1,
        max_count: 0,
        stackable: 1,
        min_dmg: 26.0,
        max_dmg: 48.0,
        delay_ms: 2500,
        armor: 0,
        bonus_stat_type: 4, // Strength
        bonus_stat_val: 14,
        description: "Twin-crystal antimatter lance from across the Elsewhere Seam.",
        material: 1,
        sheath: 1,
    },
    ItemTemplate {
        entry: 50007,
        class: 4,
        subclass: 6, // Shield
        name: "Porcelain Aegis",
        display_id: 50007,
        quality: 3,
        buy_price: 1600,
        sell_price: 400,
        inventory_type: 14, // Shield (Off Hand)
        item_level: 22,
        required_level: 1,
        max_count: 0,
        stackable: 1,
        min_dmg: 0.0,
        max_dmg: 0.0,
        delay_ms: 0,
        armor: 420,
        bonus_stat_type: 7, // Stamina
        bonus_stat_val: 9,
        description: "Kiln-fired porcelain crest of the Lowbell Court.",
        material: 1,
        sheath: 4,
    },
    // Quest & Story Relics (50008..=50012)
    ItemTemplate {
        entry: 50008,
        class: 12, // Quest item
        subclass: 0,
        name: "Mere Route-Seal Letter",
        display_id: 50001,
        quality: 2,
        buy_price: 0,
        sell_price: 0,
        inventory_type: 0,
        item_level: 1,
        required_level: 1,
        max_count: 1,
        stackable: 1,
        min_dmg: 0.0,
        max_dmg: 0.0,
        delay_ms: 0,
        armor: 0,
        bonus_stat_type: 0,
        bonus_stat_val: 0,
        description: "A damp envelope from the drifting lighthouse addressed to the one who sealed Mere.",
        material: 4,
        sheath: 0,
    },
    ItemTemplate {
        entry: 50009,
        class: 12,
        subclass: 0,
        name: "Porcelain Resonator Coil",
        display_id: 50002,
        quality: 2,
        buy_price: 100,
        sell_price: 25,
        inventory_type: 0,
        item_level: 5,
        required_level: 1,
        max_count: 0,
        stackable: 5,
        min_dmg: 0.0,
        max_dmg: 0.0,
        delay_ms: 0,
        armor: 0,
        bonus_stat_type: 0,
        bonus_stat_val: 0,
        description: "Hums like a bee that went to music school. Property of The Almost Legends.",
        material: 1,
        sheath: 0,
    },
    ItemTemplate {
        entry: 50010,
        class: 12,
        subclass: 0,
        name: "Stormglass Shard",
        display_id: 50003,
        quality: 2,
        buy_price: 150,
        sell_price: 40,
        inventory_type: 0,
        item_level: 10,
        required_level: 1,
        max_count: 0,
        stackable: 10,
        min_dmg: 0.0,
        max_dmg: 0.0,
        delay_ms: 0,
        armor: 0,
        bonus_stat_type: 0,
        bonus_stat_val: 0,
        description: "A warm turquoise glass shard holding a miniature Glasswake squall.",
        material: 1,
        sheath: 0,
    },
    ItemTemplate {
        entry: 50011,
        class: 12,
        subclass: 0,
        name: "Aureate Evacuation Record",
        display_id: 50004,
        quality: 3,
        buy_price: 200,
        sell_price: 50,
        inventory_type: 0,
        item_level: 15,
        required_level: 1,
        max_count: 0,
        stackable: 5,
        min_dmg: 0.0,
        max_dmg: 0.0,
        delay_ms: 0,
        armor: 0,
        bonus_stat_type: 0,
        bonus_stat_val: 0,
        description: "Brass ledger plate from Lord Oriel's Great Orrery recording the closure of Mere.",
        material: 1,
        sheath: 0,
    },
    ItemTemplate {
        entry: 50012,
        class: 12,
        subclass: 0,
        name: "Nocturnum Cinder Core",
        display_id: 50005,
        quality: 4,
        buy_price: 500,
        sell_price: 125,
        inventory_type: 0,
        item_level: 20,
        required_level: 1,
        max_count: 0,
        stackable: 5,
        min_dmg: 0.0,
        max_dmg: 0.0,
        delay_ms: 0,
        armor: 0,
        bonus_stat_type: 0,
        bonus_stat_val: 0,
        description: "Molten violet heart recovered from the Obsidian Colossus.",
        material: 1,
        sheath: 0,
    },
];

pub fn get_item_template(entry: u32) -> Option<&'static ItemTemplate> {
    ITEM_TEMPLATES.iter().find(|it| it.entry == entry)
}

/// Default starting equipment (MainHand, OffHand, Ranged) for a class (1..=11).
pub fn starting_equipment_for_class(class: u8) -> (u32, u32, u32) {
    match class {
        1 => (50004, 50007, 50003), // Warrior: Aureate Sunblade + Porcelain Aegis + Prism Bow
        2 => (50004, 50007, 0),     // Paladin: Aureate Sunblade + Porcelain Aegis
        3 => (50001, 0, 50003),     // Hunter: Porcelain Rapier + Glasswake Prism Bow
        4 => (50005, 50001, 50003), // Rogue: Nocturnum Lantern Hook + Porcelain Rapier + Bow
        5 => (50002, 0, 0),         // Priest: Frostbell Chime Staff
        7 => (50005, 50007, 0),     // Shaman: Nocturnum Lantern Hook + Porcelain Aegis
        8 => (50002, 0, 0),         // Mage: Frostbell Chime Staff
        9 => (50005, 0, 0),         // Warlock: Nocturnum Lantern Hook
        11 => (50006, 0, 0),        // Druid: Tekka Crystal Lance
        _ => (50001, 50007, 50003),
    }
}

/// Default starting spells taught to every Celandia character on creation.
pub fn default_celandia_spells() -> Vec<u16> {
    vec![
        // 15 Active Celandia Kingdom & Sister Spells (from build-celandia-data.mjs)
        60001, // Porcelain Riposte
        60002, // Whirling Cadence
        60003, // Grappling Hook
        60004, // Frostbell Chime
        60005, // Lagoon Frost Nova
        60006, // Elsewhere Squall
        60007, // Prism Volley
        60008, // Mirage Scatter
        60009, // Aureate Sunburst
        60010, // Sovereign Sanctuary
        60011, // Nocturnum Lantern
        60012, // Obsidian Eclipse
        60013, // Voltekka Lance
        60014, // Starlight Resonance
        60015, // Ashen Soul Rend
        // 9 Mobility Spells
        100,  // Grapple Lunge
        1044, // Aureate Freedom
        5118, // Glasswake Dash
        2983, // Nocturnum Sprint
        586,  // Elsewhere Fade
        2645, // Sky Manta Glide
        1953, // Phase Blink
        5484, // Obsidian Howl
        1850, // Porcelain Gale
        // 10 Passive Spells
        19740, // Porcelain Might
        1243,  // Porcelain Fortitude
        13159, // Tidewalker Stride
        139,   // Elsewhere Mending
        1459,  // Frostbell Resonance
        1008,  // Prism Amplification
        132,   // Lantern Magnetism
        19742, // Aureate Wisdom
        1126,  // Obsidian Carapace
        20217, // Sovereign Grace
    ]
}

// ============================================================================
// 4. Creature Templates (16 Friendly Cast NPCs + 11 Hostile Fauna & Bosses)
// ============================================================================

#[derive(Debug, Clone)]
pub struct CreatureTemplate {
    pub entry: u32,
    pub name: &'static str,
    pub subname: &'static str,
    pub display_id: u32,
    pub creature_type: u32, // 7 = Humanoid, 1 = Beast, 4 = Elemental, 6 = Undead
    pub family: u32,
    pub rank: u32, // 0 = Normal, 1 = Elite, 2 = Rare Elite, 3 = World Boss
    pub level: u32,
    pub max_health: u32,
    pub max_mana: u32,
    pub faction: u32,
    pub npc_flags: u32,
    pub scale: f32,
    pub min_dmg: f32,
    pub max_dmg: f32,
    pub attack_time_ms: u32,
    pub weapon_display: u32,
    pub xp_reward: u32,
    pub money_min: u32,
    pub money_max: u32,
    pub loot_items: &'static [(u32, u8)], // (item_entry, drop_chance_percent)
    pub gossip_text_id: u32,
}

pub static CREATURE_TEMPLATES: &[CreatureTemplate] = &[
    // --- 14 Celandia Cast NPCs + 2 Sister Envoys (Entries 1001..=1016, Display IDs 1..=16) ---
    CreatureTemplate {
        entry: 1001,
        name: "Rook",
        subname: "Route-Mender of Lowbell",
        display_id: 1,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 25,
        max_health: 2400,
        max_mana: 1200,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.0,
        min_dmg: 25.0,
        max_dmg: 38.0,
        attack_time_ms: 1800,
        weapon_display: 50001,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1001,
    },
    CreatureTemplate {
        entry: 1002,
        name: "Princess Serein",
        subname: "Sovereign of Frostbell Lagoon",
        display_id: 2,
        creature_type: 7,
        family: 0,
        rank: 1,
        level: 30,
        max_health: 4500,
        max_mana: 3200,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.05,
        min_dmg: 35.0,
        max_dmg: 50.0,
        attack_time_ms: 2000,
        weapon_display: 50002,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1002,
    },
    CreatureTemplate {
        entry: 1003,
        name: "Ilex",
        subname: "Navigator of the Elsewhere",
        display_id: 3,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 25,
        max_health: 2200,
        max_mana: 1800,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.0,
        min_dmg: 22.0,
        max_dmg: 34.0,
        attack_time_ms: 2000,
        weapon_display: 50002,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1003,
    },
    CreatureTemplate {
        entry: 1004,
        name: "Mora",
        subname: "Keeper of the Hushwood Echoes",
        display_id: 4,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 24,
        max_health: 2100,
        max_mana: 1900,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.0,
        min_dmg: 20.0,
        max_dmg: 32.0,
        attack_time_ms: 2000,
        weapon_display: 50005,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1004,
    },
    CreatureTemplate {
        entry: 1005,
        name: "Fizz",
        subname: "Conservatory Botanist",
        display_id: 5,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 22,
        max_health: 1950,
        max_mana: 1600,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 0.95,
        min_dmg: 18.0,
        max_dmg: 28.0,
        attack_time_ms: 1900,
        weapon_display: 50002,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1005,
    },
    CreatureTemplate {
        entry: 1006,
        name: "Latch",
        subname: "Warden of the Crossing Gate",
        display_id: 6,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 26,
        max_health: 2600,
        max_mana: 1200,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.05,
        min_dmg: 26.0,
        max_dmg: 40.0,
        attack_time_ms: 2000,
        weapon_display: 50005,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1006,
    },
    CreatureTemplate {
        entry: 1007,
        name: "Moss Calder",
        subname: "Master of the Kiln & Galley",
        display_id: 7,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 28,
        max_health: 3200,
        max_mana: 1000,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER | UNIT_NPC_FLAG_VENDOR,
        scale: 1.1,
        min_dmg: 28.0,
        max_dmg: 42.0,
        attack_time_ms: 2200,
        weapon_display: 0,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1007,
    },
    CreatureTemplate {
        entry: 1008,
        name: "Riff",
        subname: "Lead Resonator · The Almost Legends",
        display_id: 8,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 20,
        max_health: 1800,
        max_mana: 1100,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.0,
        min_dmg: 18.0,
        max_dmg: 26.0,
        attack_time_ms: 1900,
        weapon_display: 0,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1008,
    },
    CreatureTemplate {
        entry: 1009,
        name: "Daze",
        subname: "Percussion · The Almost Legends",
        display_id: 9,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 20,
        max_health: 1850,
        max_mana: 1100,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.0,
        min_dmg: 18.0,
        max_dmg: 26.0,
        attack_time_ms: 1900,
        weapon_display: 0,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1009,
    },
    CreatureTemplate {
        entry: 1010,
        name: "Princess Elowen",
        subname: "Sovereign of the Porcelain Wake",
        display_id: 10,
        creature_type: 7,
        family: 0,
        rank: 1,
        level: 30,
        max_health: 4400,
        max_mana: 3400,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.05,
        min_dmg: 32.0,
        max_dmg: 48.0,
        attack_time_ms: 2000,
        weapon_display: 50002,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1010,
    },
    CreatureTemplate {
        entry: 1011,
        name: "Princess Solenne",
        subname: "Sovereign of Glasswake Mesas",
        display_id: 11,
        creature_type: 7,
        family: 0,
        rank: 1,
        level: 30,
        max_health: 4600,
        max_mana: 3200,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.05,
        min_dmg: 36.0,
        max_dmg: 52.0,
        attack_time_ms: 2000,
        weapon_display: 50003,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1011,
    },
    CreatureTemplate {
        entry: 1012,
        name: "Princess Avelune",
        subname: "Sovereign of the Aureate Reach",
        display_id: 12,
        creature_type: 7,
        family: 0,
        rank: 1,
        level: 30,
        max_health: 4800,
        max_mana: 3600,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.05,
        min_dmg: 38.0,
        max_dmg: 54.0,
        attack_time_ms: 2000,
        weapon_display: 50004,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1012,
    },
    CreatureTemplate {
        entry: 1013,
        name: "Lord Oriel",
        subname: "Keeper of the Great Orrery",
        display_id: 13,
        creature_type: 7,
        family: 0,
        rank: 1,
        level: 30,
        max_health: 4200,
        max_mana: 3800,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.08,
        min_dmg: 34.0,
        max_dmg: 50.0,
        attack_time_ms: 2000,
        weapon_display: 50004,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1013,
    },
    CreatureTemplate {
        entry: 1014,
        name: "Wren",
        subname: "Postwoman of the Archipelago Express",
        display_id: 14,
        creature_type: 7,
        family: 0,
        rank: 0,
        level: 20,
        max_health: 1900,
        max_mana: 1000,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.0,
        min_dmg: 16.0,
        max_dmg: 24.0,
        attack_time_ms: 1900,
        weapon_display: 0,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1014,
    },
    CreatureTemplate {
        entry: 1015,
        name: "Tekkaman",
        subname: "Space Lance Vanguard",
        display_id: 15,
        creature_type: 7,
        family: 0,
        rank: 1,
        level: 35,
        max_health: 6000,
        max_mana: 2500,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.15,
        min_dmg: 45.0,
        max_dmg: 68.0,
        attack_time_ms: 1800,
        weapon_display: 50006,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1015,
    },
    CreatureTemplate {
        entry: 1016,
        name: "Jem",
        subname: "Holographic Starlight Cantor",
        display_id: 16,
        creature_type: 7,
        family: 0,
        rank: 1,
        level: 35,
        max_health: 5500,
        max_mana: 4000,
        faction: FACTION_FRIENDLY,
        npc_flags: UNIT_NPC_FLAG_GOSSIP | UNIT_NPC_FLAG_QUESTGIVER,
        scale: 1.1,
        min_dmg: 40.0,
        max_dmg: 60.0,
        attack_time_ms: 1900,
        weapon_display: 50002,
        xp_reward: 0,
        money_min: 0,
        money_max: 0,
        loot_items: &[],
        gossip_text_id: 1016,
    },
    // --- 11 Hostile Celandia Fauna & Bosses (Entries 2001..=2011, Display IDs 20..=30) ---
    CreatureTemplate {
        entry: 2001,
        name: "Porcelain Hopper",
        subname: "Wildwood Berry-Hopper",
        display_id: 20,
        creature_type: 1, // Beast
        family: 0,
        rank: 0,
        level: 2,
        max_health: 95,
        max_mana: 0,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.0,
        min_dmg: 4.0,
        max_dmg: 7.0,
        attack_time_ms: 2000,
        weapon_display: 0,
        xp_reward: 70,
        money_min: 15,
        money_max: 45,
        loot_items: &[(50009, 80), (50001, 25)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2002,
        name: "Frostbell Woolly Drifter",
        subname: "Glacial Grazer",
        display_id: 21,
        creature_type: 1,
        family: 0,
        rank: 0,
        level: 5,
        max_health: 210,
        max_mana: 0,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.15,
        min_dmg: 9.0,
        max_dmg: 14.0,
        attack_time_ms: 2200,
        weapon_display: 0,
        xp_reward: 130,
        money_min: 40,
        money_max: 95,
        loot_items: &[(50002, 35)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2003,
        name: "Glasswake Skimmer",
        subname: "Prism Dune Strider",
        display_id: 22,
        creature_type: 1,
        family: 0,
        rank: 0,
        level: 7,
        max_health: 290,
        max_mana: 0,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.1,
        min_dmg: 13.0,
        max_dmg: 19.0,
        attack_time_ms: 1900,
        weapon_display: 0,
        xp_reward: 175,
        money_min: 60,
        money_max: 140,
        loot_items: &[(50010, 90), (50003, 35)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2004,
        name: "Porcelain Sky Manta",
        subname: "Tide-Wind Glider",
        display_id: 23,
        creature_type: 1,
        family: 0,
        rank: 0,
        level: 8,
        max_health: 340,
        max_mana: 150,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.25,
        min_dmg: 15.0,
        max_dmg: 22.0,
        attack_time_ms: 2100,
        weapon_display: 0,
        xp_reward: 200,
        money_min: 75,
        money_max: 165,
        loot_items: &[(50010, 75), (50007, 30)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2005,
        name: "Obsidian Colossus",
        subname: "Sovereign of the Caldera Seam",
        display_id: 24,
        creature_type: 4, // Elemental
        family: 0,
        rank: 3, // World Boss
        level: 15,
        max_health: 1850,
        max_mana: 1000,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.5,
        min_dmg: 38.0,
        max_dmg: 56.0,
        attack_time_ms: 2400,
        weapon_display: 0,
        xp_reward: 950,
        money_min: 500,
        money_max: 1200,
        loot_items: &[(50012, 100), (50005, 80), (50006, 65)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2006,
        name: "Seam Hollow",
        subname: "Drifting Husk",
        display_id: 25,
        creature_type: 6, // Undead
        family: 0,
        rank: 0,
        level: 3,
        max_health: 135,
        max_mana: 0,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.0,
        min_dmg: 6.0,
        max_dmg: 10.0,
        attack_time_ms: 2000,
        weapon_display: 0,
        xp_reward: 90,
        money_min: 20,
        money_max: 60,
        loot_items: &[(50009, 75), (50001, 25)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2007,
        name: "Ashen Knight",
        subname: "Oathbound Sentinel",
        display_id: 26,
        creature_type: 6,
        family: 0,
        rank: 1, // Elite
        level: 10,
        max_health: 520,
        max_mana: 200,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.15,
        min_dmg: 20.0,
        max_dmg: 30.0,
        attack_time_ms: 2000,
        weapon_display: 50004,
        xp_reward: 290,
        money_min: 120,
        money_max: 260,
        loot_items: &[(50011, 85), (50004, 45), (50007, 40)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2008,
        name: "Orrery Iron Colossus",
        subname: "Clockwork Automaton",
        display_id: 27,
        creature_type: 9, // Mechanical
        family: 0,
        rank: 1,
        level: 12,
        max_health: 780,
        max_mana: 0,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.3,
        min_dmg: 26.0,
        max_dmg: 38.0,
        attack_time_ms: 2300,
        weapon_display: 0,
        xp_reward: 390,
        money_min: 180,
        money_max: 380,
        loot_items: &[(50011, 100), (50004, 50)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2009,
        name: "Nocturnum Bone Lord",
        subname: "Warden of the Ash Moat",
        display_id: 28,
        creature_type: 6,
        family: 0,
        rank: 2, // Rare Elite
        level: 13,
        max_health: 960,
        max_mana: 500,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.25,
        min_dmg: 30.0,
        max_dmg: 44.0,
        attack_time_ms: 2100,
        weapon_display: 50005,
        xp_reward: 490,
        money_min: 220,
        money_max: 500,
        loot_items: &[(50012, 90), (50005, 55)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2010,
        name: "Echo Wraith",
        subname: "Unsettled Route-Song",
        display_id: 29,
        creature_type: 6,
        family: 0,
        rank: 0,
        level: 6,
        max_health: 250,
        max_mana: 300,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.1,
        min_dmg: 11.0,
        max_dmg: 17.0,
        attack_time_ms: 2000,
        weapon_display: 0,
        xp_reward: 150,
        money_min: 50,
        money_max: 110,
        loot_items: &[(50002, 35)],
        gossip_text_id: 0,
    },
    CreatureTemplate {
        entry: 2011,
        name: "Cinderveil Blight Hound",
        subname: "Pack Stalker",
        display_id: 30,
        creature_type: 1,
        family: 0,
        rank: 0,
        level: 4,
        max_health: 170,
        max_mana: 0,
        faction: FACTION_MONSTER,
        npc_flags: 0,
        scale: 1.0,
        min_dmg: 8.0,
        max_dmg: 12.0,
        attack_time_ms: 1800,
        weapon_display: 0,
        xp_reward: 110,
        money_min: 30,
        money_max: 75,
        loot_items: &[(50009, 70), (50001, 30)],
        gossip_text_id: 0,
    },
];

pub fn get_creature_template(entry: u32) -> Option<&'static CreatureTemplate> {
    CREATURE_TEMPLATES.iter().find(|ct| ct.entry == entry)
}

// ============================================================================
// 5. Live World Creature Instances & Initial Spawns
// ============================================================================

#[derive(Debug, Clone)]
pub struct CreatureInstance {
    pub spawn_id: u32,
    pub guid: u64,
    pub entry: u32,
    pub map_id: u32,
    pub home_x: f32,
    pub home_y: f32,
    pub home_z: f32,
    pub home_o: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub orientation: f32,
    pub health: u32,
    pub max_health: u32,
    pub target_guid: u64,
    pub last_attack_tick: u64,
    pub last_patrol_tick: u64,
    pub respawn_at_tick: Option<u64>,
    pub loot_money: u32,
    pub loot_items: Vec<u32>,
    pub tapped_by: u64,
}

impl CreatureInstance {
    pub fn is_alive(&self) -> bool {
        self.health > 0 && self.respawn_at_tick.is_none()
    }

    pub fn template(&self) -> &'static CreatureTemplate {
        get_creature_template(self.entry).expect("valid creature template")
    }
}

/// Build the complete initial world spawn list across Map 0 (Celandia: The Elsewhere Tide)
/// and Map 1 (The Elsewhere Sanctum).
pub fn build_initial_spawns() -> Vec<CreatureInstance> {
    // (entry, map_id, celandia_x, celandia_z, orientation)
    let raw_spawns: &[(u32, u32, f32, f32, f32)] = &[
        // --- 1. Lowbell Court & The Porcelain Wake (Friendly Cast NPCs) ---
        (1001, 0, -2.5, 3.0, 2.55),     // Rook at Lowbell Bell Garden
        (1007, 0, -6.5, 4.5, 0.4),      // Moss Calder welcoming at Lowbell Court
        (1003, 0, 5.5, 2.5, 3.8),       // Ilex at Lowbell Court
        (1008, 0, 3.2, 5.5, 4.5),       // Riff at Lowbell Bell Garden
        (1009, 0, -3.0, 6.0, 4.8),      // Daze at Lowbell Bell Garden
        (1014, 0, 0.0, -5.5, 1.57),     // Wren (Postwoman) at Lowbell Court
        (1010, 0, 4.0, 80.0, 1.5),      // Princess Elowen in the Wildwood Grove
        (1004, 0, -90.0, -186.0, 3.1),  // Mora in Hushwood
        (1007, 0, -43.5, 4.2, 0.2),     // Moss Calder at his Kiln House
        (1003, 0, 50.5, 19.5, 0.6),     // Ilex at the Creek Pavilion
        // --- 2. Frostbell Lagoon (Friendly Cast NPCs) ---
        (1002, 0, -416.0, -336.5, 0.8), // Princess Serein at Bellmere Pavilion
        // --- 3. Glasswake Mesas (Friendly Cast NPCs) ---
        (1011, 0, 398.0, 64.0, 1.5),    // Princess Solenne at Glasswake Court
        // --- 4. The Aureate Reach (Friendly Cast NPCs) ---
        (1012, 0, 296.0, -496.0, 3.14), // Princess Avelune at Aureate Palace Steps
        (1013, 0, 298.0, -470.0, 4.7),  // Lord Oriel at the Great Orrery
        (1005, 0, 401.0, -466.0, 2.2),  // Fizz in the Hanging Conservatory
        (1006, 0, 228.0, -394.0, 0.9),  // Latch at the Old Crossing Gate
        // --- 5. Nocturnum Obsidian Isle (Friendly Envoys) ---
        (1015, 0, -345.0, 305.0, 1.8),  // Tekkaman at Nocturnum Approach
        (1016, 0, -372.0, 305.0, 1.4),  // Jem at Nocturnum Approach
        // --- 6. The Porcelain Wake Fauna (Porcelain Hoppers, Seam Hollows, Blight Hounds, Sky Mantas) ---
        (2001, 0, 18.0, 18.0, 0.5),
        (2001, 0, -22.0, 20.0, 1.2),
        (2001, 0, 28.0, -16.0, 2.4),
        (2001, 0, -26.0, -22.0, 3.9),
        (2001, 0, 12.0, 56.0, 1.1),
        (2001, 0, -14.0, 64.0, 5.2),
        (2006, 0, -68.0, -135.0, 0.8),
        (2006, 0, -82.0, -155.0, 2.1),
        (2006, 0, -105.0, -170.0, 4.0),
        (2011, 0, 35.0, -95.0, 1.7),
        (2011, 0, -35.0, -110.0, 2.8),
        (2004, 0, -25.0, 145.0, 0.3),
        (2004, 0, 25.0, 150.0, 3.4),
        // --- 7. Frostbell Lagoon Fauna (Woolly Drifters & Echo Wraiths) ---
        (2002, 0, -395.0, -365.0, 0.7),
        (2002, 0, -435.0, -395.0, 1.9),
        (2002, 0, -465.0, -420.0, 3.1),
        (2002, 0, -490.0, -370.0, 4.4),
        (2010, 0, -445.0, -455.0, 2.5),
        (2010, 0, -505.0, -460.0, 0.9),
        // --- 8. Glasswake Mesas Fauna (Glasswake Skimmers & Sky Mantas) ---
        (2003, 0, 425.0, 45.0, 1.1),
        (2003, 0, 450.0, 75.0, 2.3),
        (2003, 0, 475.0, 25.0, 3.7),
        (2003, 0, 500.0, 55.0, 5.0),
        (2004, 0, 440.0, -25.0, 0.6),
        (2004, 0, 495.0, -40.0, 4.1),
        // --- 9. The Aureate Reach Fauna (Ashen Knights & Orrery Iron Colossi) ---
        (2007, 0, 275.0, -455.0, 1.2),
        (2007, 0, 325.0, -455.0, 2.9),
        (2007, 0, 345.0, -515.0, 4.2),
        (2008, 0, 310.0, -482.0, 0.4),
        (2008, 0, 285.0, -482.0, 2.7),
        (2008, 0, 330.0, -530.0, 5.1),
        // --- 10. Nocturnum Obsidian Isle (Bone Lords, Ashen Knights & World Boss Obsidian Colossus) ---
        (2009, 0, -340.0, 332.0, 3.8),
        (2009, 0, -380.0, 332.0, 5.4),
        (2007, 0, -345.0, 290.0, 1.5),
        (2007, 0, -375.0, 290.0, 1.6),
        (2005, 0, -360.0, 340.0, 4.71), // World Boss: Obsidian Colossus
        // --- 11. Map 1: The Elsewhere Sanctum (Instance Bosses & Envoys) ---
        (1001, 1, -3.0, 3.0, 2.5),      // Rook inside Elsewhere Sanctum
        (1002, 1, 3.0, 3.0, 3.8),       // Princess Serein inside Elsewhere Sanctum
        (1015, 1, -6.0, 0.0, 0.0),      // Tekkaman inside Elsewhere Sanctum
        (1016, 1, 6.0, 0.0, 3.14),      // Jem inside Elsewhere Sanctum
        (2006, 1, 16.0, 16.0, 3.9),
        (2007, 1, -18.0, 18.0, 5.4),
        (2008, 1, 22.0, -20.0, 2.2),
        (2009, 1, -22.0, -20.0, 0.8),
        (2005, 1, 0.0, -32.0, 1.57),    // Sanctum Obsidian Colossus
    ];

    let mut out = Vec::with_capacity(raw_spawns.len());
    for (idx, &(entry, map_id, cx, cz, orientation)) in raw_spawns.iter().enumerate() {
        let spawn_id = (idx + 1) as u32;
        let guid = make_unit_guid(entry, spawn_id);
        let tpl = get_creature_template(entry).expect("creature template exists");
        let (wx, wy, wz) = celandia_to_wow(cx, cz);
        out.push(CreatureInstance {
            spawn_id,
            guid,
            entry,
            map_id,
            home_x: wx,
            home_y: wy,
            home_z: wz,
            home_o: orientation,
            x: wx,
            y: wy,
            z: wz,
            orientation,
            health: tpl.max_health,
            max_health: tpl.max_health,
            target_guid: 0,
            last_attack_tick: 0,
            last_patrol_tick: 0,
            respawn_at_tick: None,
            loot_money: 0,
            loot_items: Vec::new(),
            tapped_by: 0,
        });
    }
    out
}
