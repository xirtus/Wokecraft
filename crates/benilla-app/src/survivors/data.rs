//! The mode's tables: classes, abilities, passives, enemies and the wave clock. Spell ids name
//! `Spell.dbc` rows only for their icon, name and visual chain; every number here is the mode's.

/// A weapon on the hero's virtual item slots: `(slot, display, class, subclass, material, inv,
/// sheath)`, the creature form of `UNIT_VIRTUAL_ITEM_SLOT_DISPLAY` and `_INFO`.
pub(crate) type Weapon = (u16, u32, u8, u8, u8, u8, u8);

pub(crate) struct ClassDef {
    pub id: u8,
    pub name: &'static str,
    /// `RAID_CLASS_COLORS`, 0xRRGGBB.
    pub color: u32,
    /// `UNIT_FIELD_BYTES_0` byte 3.
    pub power: u8,
    pub start: &'static str,
    pub pool: &'static [&'static str],
    /// Class-trainer `CreatureDisplayInfo` ids, deduped by race and sex at the menu.
    pub looks: &'static [u32],
    pub weapons: &'static [Weapon],
    /// The sheath state the hero fights in: 1 melee, 2 ranged.
    pub sheath: u8,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Kind {
    /// A missile at the nearest enemies (or instant if the spell has no speed).
    Bolt,
    /// An instant hit on the nearest enemies in range.
    Strike,
    /// A close hit on the nearest enemies in melee reach.
    Melee,
    /// Everything in a radius around the hero.
    Nova,
    /// Everything in a cone toward the nearest enemy.
    Cone,
    /// A ground area at the densest nearby enemy, ticking for `duration`.
    Ground,
    /// A ground area under the hero, ticking for `duration`.
    GroundSelf,
    /// Jumps from enemy to enemy.
    Chain,
    /// A damage-over-time on several enemies.
    Dot,
    /// Always on: pulses every `cooldown` around the hero, with the spell's state visual on him.
    Aura,
    /// Always on: zaps one enemy close to the hero every `cooldown`.
    Orbit,
    /// Absorbs `damage` for `duration`.
    Shield,
    /// Immune for `duration`.
    Immune,
    /// Returns `damage` to every attacker for `duration`.
    Thorns,
    /// Heals `damage` over `duration`.
    Heal,
    /// Drops a totem that casts `sub` for `duration`.
    Totem,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Effect {
    None,
    /// Speed multiplier for seconds.
    Slow(f32, f32),
    Root(f32),
    Stun(f32),
    Fear(f32),
    /// Outgoing damage multiplier for seconds.
    Weaken(f32, f32),
    /// Heal the hero by this fraction of damage dealt.
    Drain(f32),
    /// Kill outright below this health fraction.
    Execute(f32),
}

pub(crate) struct AbilityDef {
    pub key: &'static str,
    pub spell: u32,
    pub kind: Kind,
    /// Direct damage; per tick for areas and pulses; absorb, heal or reflect for the self kinds.
    pub damage: f32,
    /// Damage over time, per second, for `duration`.
    pub dot: f32,
    pub cooldown: f32,
    pub range: f32,
    /// Splash for single hits, area for the area kinds, the jump for a chain.
    pub radius: f32,
    pub count: u32,
    pub duration: f32,
    pub effect: Effect,
    /// The spell whose state kit marks an affected enemy, 0 for none.
    pub mark: u32,
    /// A totem's display, and the spell it casts.
    pub totem: (u32, u32),
    /// The area's own visual hangs overhead and would hide the field from the camera, so the
    /// area plays the spell's impact on whatever it hits instead.
    pub overhead: bool,
}

const fn ab(key: &'static str, spell: u32, kind: Kind) -> AbilityDef {
    AbilityDef {
        key,
        spell,
        kind,
        damage: 0.0,
        dot: 0.0,
        cooldown: 2.0,
        range: 20.0,
        radius: 0.0,
        count: 1,
        duration: 0.0,
        effect: Effect::None,
        mark: 0,
        totem: (0, 0),
        overhead: false,
    }
}

macro_rules! ability {
    ($key:literal, $spell:literal, $kind:ident { $($f:ident: $v:expr),* $(,)? }) => {
        AbilityDef { $($f: $v,)* ..ab($key, $spell, Kind::$kind) }
    };
}

pub(crate) static ABILITIES: &[AbilityDef] = &[
    // --- Porcelain Duelist / Tekka Lancer ---
    ability!(
        "porcelain_riposte",
        60001,
        Melee {
            damage: 16.0,
            cooldown: 1.0,
            range: 5.5,
            count: 3
        }
    ),
    ability!(
        "whirling_cadence",
        60002,
        Nova {
            damage: 18.0,
            cooldown: 3.5,
            radius: 7.5
        }
    ),
    ability!(
        "grappling_hook",
        60003,
        Strike {
            damage: 28.0,
            cooldown: 3.0,
            range: 18.0,
            count: 2,
            effect: Effect::Stun(1.8),
            mark: 60003
        }
    ),
    // --- Elsewhere Tideweaver / Frostbell Cantor ---
    ability!(
        "frostbell_chime",
        60004,
        Bolt {
            damage: 14.0,
            cooldown: 1.2,
            range: 24.0,
            radius: 3.0,
            effect: Effect::Slow(0.5, 2.5),
            mark: 60004
        }
    ),
    ability!(
        "lagoon_frost_nova",
        60005,
        Nova {
            damage: 12.0,
            cooldown: 6.0,
            radius: 9.0,
            effect: Effect::Root(2.5),
            mark: 60005
        }
    ),
    ability!(
        "elsewhere_squall",
        60006,
        Ground {
            damage: 9.0,
            cooldown: 8.5,
            range: 20.0,
            radius: 7.5,
            duration: 6.0,
            effect: Effect::Slow(0.6, 1.5)
        }
    ),
    // --- Glasswake Ranger / Grove Warden ---
    ability!(
        "prism_volley",
        60007,
        Bolt {
            damage: 13.0,
            cooldown: 1.3,
            range: 28.0,
            count: 3
        }
    ),
    ability!(
        "mirage_scatter",
        60008,
        Cone {
            damage: 16.0,
            cooldown: 4.0,
            radius: 11.0,
            effect: Effect::Slow(0.5, 3.0),
            mark: 60008
        }
    ),
    // --- Aureate Sun-Knight ---
    ability!(
        "aureate_sunburst",
        60009,
        Strike {
            damage: 34.0,
            dot: 4.0,
            duration: 6.0,
            cooldown: 3.2,
            range: 22.0
        }
    ),
    ability!(
        "sovereign_sanctuary",
        60010,
        GroundSelf {
            damage: 9.0,
            cooldown: 8.5,
            radius: 7.5,
            duration: 8.0
        }
    ),
    // --- Nocturnum Shade / Obsidian Hexer ---
    ability!(
        "nocturnum_lantern",
        60011,
        Chain {
            damage: 20.0,
            cooldown: 2.8,
            range: 22.0,
            radius: 9.0,
            count: 3,
            effect: Effect::Drain(0.15)
        }
    ),
    ability!(
        "obsidian_eclipse",
        60012,
        Aura {
            damage: 7.0,
            cooldown: 0.8,
            radius: 6.5
        }
    ),
    // --- Sister-Project Signature Abilities (Tekkaman, Jem, Reincarnation) ---
    ability!(
        "voltekka_lance",
        60013,
        Bolt {
            damage: 65.0,
            dot: 6.0,
            duration: 5.0,
            cooldown: 5.5,
            range: 30.0,
            radius: 4.5
        }
    ),
    ability!(
        "starlight_resonance",
        60014,
        Nova {
            damage: 15.0,
            cooldown: 3.2,
            radius: 9.5,
            effect: Effect::Drain(0.15)
        }
    ),
    ability!(
        "ashen_soul_rend",
        60015,
        Strike {
            damage: 42.0,
            cooldown: 2.2,
            range: 9.0,
            count: 2,
            effect: Effect::Execute(0.3)
        }
    ),
    ability!(
        "porcelain_aegis",
        60010,
        Shield {
            damage: 35.0,
            cooldown: 14.0,
            duration: 10.0
        }
    ),
    ability!(
        "elsewhere_mending",
        60014,
        Heal {
            damage: 32.0,
            cooldown: 15.0,
            duration: 10.0
        }
    ),
];

pub(crate) fn ability(key: &str) -> &'static AbilityDef {
    ABILITIES
        .iter()
        .find(|a| a.key == key)
        .unwrap_or_else(|| panic!("survivors: no ability {key:?}"))
}

pub(crate) const MAX_ABILITY_LEVEL: u8 = 8;
pub(crate) const MAX_PASSIVE_LEVEL: u8 = 5;
pub(crate) const MAX_ABILITIES: usize = 6;
pub(crate) const MAX_PASSIVES: usize = 6;

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Stat {
    Might,
    MaxHp,
    Speed,
    Regen,
    Haste,
    Area,
    Magnet,
    Growth,
    Armor,
    Crit,
}

pub(crate) struct PassiveDef {
    pub key: &'static str,
    pub name: &'static str,
    /// Icon source, and a state visual on the hero where the spell has one.
    pub spell: u32,
    pub stat: Stat,
    pub per_level: f32,
}

pub(crate) static PASSIVES: &[PassiveDef] = &[
    PassiveDef {
        key: "might",
        name: "Porcelain Might",
        spell: 19740,
        stat: Stat::Might,
        per_level: 0.10,
    },
    PassiveDef {
        key: "fortitude",
        name: "Porcelain Fortitude",
        spell: 1243,
        stat: Stat::MaxHp,
        per_level: 0.20,
    },
    PassiveDef {
        key: "pack",
        name: "Tidewalker Stride",
        spell: 13159,
        stat: Stat::Speed,
        per_level: 0.10,
    },
    PassiveDef {
        key: "renew",
        name: "Elsewhere Mending",
        spell: 139,
        stat: Stat::Regen,
        per_level: 0.5,
    },
    PassiveDef {
        key: "intellect",
        name: "Frostbell Resonance",
        spell: 1459,
        stat: Stat::Haste,
        per_level: 0.08,
    },
    PassiveDef {
        key: "amplify",
        name: "Prism Amplification",
        spell: 1008,
        stat: Stat::Area,
        per_level: 0.10,
    },
    PassiveDef {
        key: "detect",
        name: "Lantern Magnetism",
        spell: 132,
        stat: Stat::Magnet,
        per_level: 0.40,
    },
    PassiveDef {
        key: "wisdom",
        name: "Aureate Wisdom",
        spell: 19742,
        stat: Stat::Growth,
        per_level: 0.08,
    },
    PassiveDef {
        key: "wild",
        name: "Obsidian Carapace",
        spell: 1126,
        stat: Stat::Armor,
        per_level: 1.0,
    },
    PassiveDef {
        key: "kings",
        name: "Sovereign Grace",
        spell: 20217,
        stat: Stat::Crit,
        per_level: 0.05,
    },
];

pub(crate) static CLASSES: &[ClassDef] = &[
    ClassDef {
        id: 1,
        name: "Porcelain Duelist",
        color: 0xF59AB8,
        power: 1,
        start: "porcelain_riposte",
        pool: &[
            "porcelain_riposte",
            "whirling_cadence",
            "grappling_hook",
            "ashen_soul_rend",
            "voltekka_lance",
            "aureate_sunburst",
            "sovereign_sanctuary",
            "porcelain_aegis",
        ],
        looks: &[
            100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115,
        ],
        weapons: &[(0, 50001, 2, 7, 1, 13, 3), (1, 50007, 4, 6, 1, 14, 4)],
        sheath: 1,
    },
    ClassDef {
        id: 2,
        name: "Aureate Sun-Knight",
        color: 0xFFD45A,
        power: 0,
        start: "aureate_sunburst",
        pool: &[
            "aureate_sunburst",
            "sovereign_sanctuary",
            "porcelain_riposte",
            "whirling_cadence",
            "starlight_resonance",
            "voltekka_lance",
            "porcelain_aegis",
            "elsewhere_mending",
        ],
        looks: &[
            100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115,
        ],
        weapons: &[(0, 50004, 2, 7, 1, 13, 3), (1, 50007, 4, 6, 1, 14, 4)],
        sheath: 1,
    },
    ClassDef {
        id: 3,
        name: "Glasswake Ranger",
        color: 0x5AD8D0,
        power: 0,
        start: "prism_volley",
        pool: &[
            "prism_volley",
            "mirage_scatter",
            "grappling_hook",
            "frostbell_chime",
            "voltekka_lance",
            "starlight_resonance",
            "ashen_soul_rend",
        ],
        looks: &[
            300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315,
        ],
        weapons: &[(0, 50001, 2, 7, 1, 13, 3), (2, 50003, 2, 2, 2, 15, 0)],
        sheath: 2,
    },
    ClassDef {
        id: 4,
        name: "Nocturnum Shade",
        color: 0xB45AFF,
        power: 3,
        start: "nocturnum_lantern",
        pool: &[
            "nocturnum_lantern",
            "obsidian_eclipse",
            "porcelain_riposte",
            "grappling_hook",
            "ashen_soul_rend",
            "whirling_cadence",
            "mirage_scatter",
        ],
        looks: &[
            400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415,
        ],
        weapons: &[(0, 50005, 2, 7, 1, 13, 3), (1, 50001, 2, 15, 1, 13, 3)],
        sheath: 1,
    },
    ClassDef {
        id: 5,
        name: "Frostbell Cantor",
        color: 0x9FE8FF,
        power: 0,
        start: "frostbell_chime",
        pool: &[
            "frostbell_chime",
            "lagoon_frost_nova",
            "elsewhere_squall",
            "starlight_resonance",
            "aureate_sunburst",
            "porcelain_aegis",
            "elsewhere_mending",
        ],
        looks: &[
            200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215,
        ],
        weapons: &[(0, 50002, 2, 10, 2, 17, 2)],
        sheath: 1,
    },
    ClassDef {
        id: 7,
        name: "Tekka Lancer",
        color: 0x8CFFD8,
        power: 0,
        start: "voltekka_lance",
        pool: &[
            "voltekka_lance",
            "porcelain_riposte",
            "whirling_cadence",
            "nocturnum_lantern",
            "aureate_sunburst",
            "ashen_soul_rend",
            "porcelain_aegis",
        ],
        looks: &[
            100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115,
        ],
        weapons: &[(0, 50006, 2, 6, 1, 17, 2)],
        sheath: 1,
    },
    ClassDef {
        id: 8,
        name: "Elsewhere Tideweaver",
        color: 0x69CCF0,
        power: 0,
        start: "frostbell_chime",
        pool: &[
            "frostbell_chime",
            "lagoon_frost_nova",
            "elsewhere_squall",
            "prism_volley",
            "mirage_scatter",
            "starlight_resonance",
            "voltekka_lance",
            "nocturnum_lantern",
        ],
        looks: &[
            200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215,
        ],
        weapons: &[(0, 50002, 2, 10, 2, 17, 2)],
        sheath: 1,
    },
    ClassDef {
        id: 9,
        name: "Obsidian Hexer",
        color: 0xC468FF,
        power: 0,
        start: "nocturnum_lantern",
        pool: &[
            "nocturnum_lantern",
            "obsidian_eclipse",
            "ashen_soul_rend",
            "elsewhere_squall",
            "lagoon_frost_nova",
            "voltekka_lance",
            "porcelain_aegis",
        ],
        looks: &[
            400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415,
        ],
        weapons: &[(0, 50005, 2, 10, 2, 17, 2)],
        sheath: 1,
    },
    ClassDef {
        id: 11,
        name: "Grove Warden",
        color: 0x98C26E,
        power: 0,
        start: "starlight_resonance",
        pool: &[
            "starlight_resonance",
            "prism_volley",
            "elsewhere_squall",
            "sovereign_sanctuary",
            "lagoon_frost_nova",
            "aureate_sunburst",
            "elsewhere_mending",
        ],
        looks: &[
            300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315,
        ],
        weapons: &[(0, 50002, 2, 10, 2, 17, 2)],
        sheath: 1,
    },
];

#[derive(Clone, Copy)]
pub(crate) struct EnemyDef {
    pub name: &'static str,
    pub display: u32,
    pub hp: f32,
    pub speed: f32,
    pub damage: f32,
    pub scale: f32,
    pub xp: u32,
    pub level: u32,
    /// A great beast, which takes more room in the crowd.
    pub big: bool,
}

const fn en(
    name: &'static str,
    display: u32,
    hp: f32,
    speed: f32,
    damage: f32,
    xp: u32,
    level: u32,
) -> EnemyDef {
    EnemyDef {
        name,
        display,
        hp,
        speed,
        damage,
        scale: 1.0,
        xp,
        level,
        big: false,
    }
}

/// Celandia & Sister-Project Horde Ladder (30 progressive tiers).
pub(crate) static ENEMIES: &[EnemyDef] = &[
    en("Porcelain Hopper", 20, 8.0, 3.8, 2.0, 1, 10),
    en("Glasswake Skimmer", 22, 10.0, 4.5, 2.0, 1, 11),
    en("Frostbell Woolly Drifter", 21, 16.0, 3.4, 3.0, 2, 12),
    en("Blight Hound", 30, 18.0, 4.6, 4.0, 2, 12),
    en("Ashen Hollow", 25, 22.0, 4.2, 8.0, 2, 13),
    en("Porcelain Sky Manta", 23, 26.0, 4.8, 8.0, 3, 13),
    en("Elsewhere Wraith", 29, 36.0, 4.2, 10.0, 3, 14),
    en("Glasswake Stalker", 22, 40.0, 4.8, 11.0, 3, 14),
    en("Frostbell Grazing Drifter", 21, 34.0, 3.8, 10.0, 3, 15),
    en("Frenzied Blight Hound", 30, 44.0, 5.2, 12.0, 4, 15),
    en("Ashen Vanguard", 26, 70.0, 3.6, 14.0, 5, 16),
    en("Nocturnum Wraith", 29, 55.0, 4.2, 12.0, 4, 16),
    en("Aureate Sky Manta", 23, 60.0, 5.0, 13.0, 4, 17),
    en("Hollow Marauder", 25, 85.0, 4.4, 16.0, 5, 18),
    en("Porcelain Crest Hopper", 20, 75.0, 5.2, 15.0, 5, 18),
    en("Prism Skimmer", 22, 90.0, 4.8, 16.0, 6, 19),
    en("Shadow Wraith", 29, 95.0, 5.0, 18.0, 6, 20),
    en("Ashen Sentinel", 26, 120.0, 3.8, 20.0, 7, 21),
    huge(en("Elder Woolly Drifter", 21, 150.0, 3.8, 22.0, 8, 22)),
    huge(en("Iron Sentinel", 27, 220.0, 3.4, 28.0, 12, 23)),
    en("Abyssal Blight Hound", 30, 160.0, 5.6, 24.0, 8, 24),
    huge(en("Bone Vanguard", 28, 180.0, 4.0, 26.0, 10, 25)),
    en("Nocturnum Swarmer", 20, 90.0, 6.0, 18.0, 5, 25),
    huge(en("Sovereign Sky Manta", 23, 240.0, 4.4, 30.0, 12, 26)),
    en("Cursed Hollow", 25, 200.0, 5.4, 30.0, 10, 27),
    en("Ashen Executioner", 26, 280.0, 4.4, 34.0, 14, 28),
    en("Eclipse Wraith", 29, 300.0, 4.6, 36.0, 14, 29),
    huge(en("Obsidian Shard Golem", 24, 420.0, 3.4, 42.0, 24, 30)),
    huge(en("Iron Juggernaut", 27, 380.0, 4.2, 44.0, 22, 31)),
    huge(en("Bone Archon", 28, 360.0, 4.6, 40.0, 20, 32)),
];

/// The great beasts at three quarters size, so a crowd of them still leaves the field readable.
const fn huge(def: EnemyDef) -> EnemyDef {
    EnemyDef {
        scale: 0.75,
        big: true,
        ..def
    }
}

pub(crate) static BOSSES: &[EnemyDef] = &[
    EnemyDef {
        scale: 1.5,
        ..en("Ashen Knight Commander", 26, 700.0, 5.0, 20.0, 60, 16)
    },
    EnemyDef {
        scale: 1.5,
        ..en("Elder Frostbell Matriarch", 21, 1800.0, 5.0, 32.0, 120, 19)
    },
    EnemyDef {
        scale: 1.6,
        ..en("The Bone Lord", 28, 4200.0, 4.2, 45.0, 200, 22)
    },
    EnemyDef {
        scale: 1.6,
        ..en("The Iron Colossus", 27, 7000.0, 4.8, 55.0, 300, 26)
    },
    EnemyDef {
        scale: 1.7,
        ..en("Arch-Wraith of the Elsewhere", 29, 12000.0, 5.0, 70.0, 400, 30)
    },
    EnemyDef {
        scale: 1.8,
        ..en("Nocturnum Obsidian Colossus", 24, 20000.0, 4.6, 90.0, 500, 33)
    },
];

/// Survive this long to win.
pub(crate) const VICTORY_SECS: f32 = 900.0;
/// A boss every two and a quarter minutes, the last of six at 13:30, a fight before the bell.
pub(crate) const BOSS_EVERY_SECS: f32 = 135.0;
/// Experience per gem: every level of the curve comes at the run's pace.
pub(crate) const XP_RATE: f32 = 2.0;

/// How far through the run, 0 at the start and 1 at [`VICTORY_SECS`].
pub(crate) fn progress(elapsed: f32) -> f32 {
    (elapsed / VICTORY_SECS).max(0.0)
}

/// The pool of roster indices at a point in the run, from a roster `tiers` long.
pub(crate) fn wave_pool(elapsed: f32, tiers: usize) -> [usize; 3] {
    // The roster spread over thirty steps of the run, the last three from step 28: on The
    // Barrens' thirty tiers, one newer every step.
    let step = (progress(elapsed) * 30.0) as usize;
    let span = tiers.saturating_sub(3);
    let lo = (step.saturating_sub(1) * span / 27).min(span);
    [lo, lo + 1, lo + 2]
}

/// How many enemies the spawner keeps alive at a point in the run.
pub(crate) fn target_alive(elapsed: f32) -> usize {
    ((14.0 + progress(elapsed) * 225.0) as usize).min(220)
}

/// Enemy health grows on top of the tiers, so a late kill takes several spells.
pub(crate) fn hp_scale(elapsed: f32) -> f32 {
    1.0 + progress(elapsed) * 0.75
}

/// Enemy damage grows the same way.
pub(crate) fn damage_scale(elapsed: f32) -> f32 {
    1.0 + progress(elapsed) * 0.9
}

/// The experience to go from `level` to the next: Vampire Survivors' curve, cheap early.
pub(crate) fn xp_to_next(level: u32) -> f32 {
    let l = level as f32;
    if level < 20 {
        5.0 + (l - 1.0) * 10.0
    } else if level < 40 {
        195.0 + (l - 20.0) * 13.0
    } else {
        455.0 + (l - 40.0) * 16.0
    }
}

/// A creature on a battleground's roster: who it is, its pace and its size. Its health, damage
/// and experience come from its place on the roster, read off The Barrens' tuned ladder.
pub(crate) struct Foe {
    name: &'static str,
    display: u32,
    level: u32,
    speed: f32,
    /// The drawn scale, chosen against the model's Stand height so the field reads as The
    /// Barrens does: about 2-3.5 yd for the horde, 4-5 for the great beasts, 5-9 for a boss.
    scale: f32,
    big: bool,
}

const fn foe(name: &'static str, display: u32, level: u32, speed: f32, scale: f32) -> Foe {
    Foe {
        name,
        display,
        level,
        speed,
        scale,
        big: false,
    }
}

const fn giant(name: &'static str, display: u32, level: u32, speed: f32, scale: f32) -> Foe {
    Foe {
        big: true,
        ..foe(name, display, level, speed, scale)
    }
}

/// Where a run is fought.
pub(crate) struct MapDef {
    pub name: &'static str,
    /// The zone or continent under the name on the menu.
    pub zone: &'static str,
    /// The `Map.dbc` row.
    pub map: u32,
    /// Where the hero starts (WoW coordinates).
    pub center: [f32; 3],
    /// How far from the centre the hero may walk.
    pub leash: f32,
    /// The results screen's line on a win.
    pub victory: &'static str,
    /// Weakest first; empty for The Porcelain Wake, which keeps its hand-tuned [`ENEMIES`].
    foes: &'static [Foe],
    /// One every [`BOSS_EVERY_SECS`], in order; empty for The Porcelain Wake's [`BOSSES`].
    bosses: &'static [Foe],
}

pub(crate) static MAPS: &[MapDef] = &[
    MapDef {
        name: "The Porcelain Wake",
        zone: "Celandia Court",
        map: 0,
        center: [0.0, 0.0, 0.5],
        leash: 130.0,
        victory: "The Porcelain Court stands unbroken.",
        foes: &[],
        bosses: &[],
    },
    MapDef {
        name: "Frostbell Lagoon",
        zone: "Northern Shelf",
        map: 0,
        center: [430.0, 470.0, 1.3],
        leash: 110.0,
        victory: "The Frostbell chimes ring clear across the lagoon.",
        foes: &[
            foe("Frostbell Woolly Drifter", 21, 12, 3.6, 1.0),
            foe("Porcelain Hopper", 20, 13, 4.2, 1.0),
            foe("Lagoon Skimmer", 22, 14, 4.6, 1.0),
            foe("Rime Hound", 30, 15, 4.8, 1.0),
            foe("Frozen Hollow", 25, 16, 4.2, 1.0),
            foe("Frostbell Sky Manta", 23, 18, 5.0, 1.0),
            foe("Glacier Wraith", 29, 20, 4.4, 1.05),
            foe("Ashen Iceguard", 26, 22, 4.0, 1.1),
            giant("Elder Woolly Drifter", 21, 25, 3.8, 1.35),
            giant("Frostbound Colossus", 27, 28, 3.6, 1.25),
        ],
        bosses: &[
            foe("Ashen Frost-Knight", 26, 18, 4.8, 1.5),
            giant("Elder Lagoon Drifter", 21, 21, 4.6, 1.65),
            giant("Rime Bone Lord", 28, 24, 4.2, 1.6),
            giant("Glacier Iron Colossus", 27, 27, 4.6, 1.65),
            foe("Wraith of the Northern Shelf", 29, 30, 5.0, 1.75),
            giant("Nocturnum Ice-Colossus", 24, 33, 4.6, 1.8),
        ],
    },
    MapDef {
        name: "Glasswake Mesas",
        zone: "Turquoise Reeds",
        map: 0,
        center: [-40.0, -480.0, 1.6],
        leash: 110.0,
        victory: "The Glasswake prisms shine in your wake.",
        foes: &[
            foe("Glasswake Skimmer", 22, 20, 4.8, 1.0),
            foe("Turquoise Hopper", 20, 21, 4.4, 1.0),
            foe("Mesa Hound", 30, 22, 5.0, 1.0),
            foe("Prism Sky Manta", 23, 24, 5.2, 1.05),
            foe("Sun-Bleached Hollow", 25, 25, 4.4, 1.0),
            foe("Mirage Wraith", 29, 27, 4.8, 1.05),
            foe("Glasswake Blade-Knight", 26, 29, 4.2, 1.15),
            giant("Prism Bone Weaver", 28, 31, 4.0, 1.25),
            giant("Mesa Iron Strider", 27, 33, 3.8, 1.3),
        ],
        bosses: &[
            foe("Mirage Stalker", 22, 22, 5.2, 1.6),
            foe("Knight of the Turquoise Reeds", 26, 25, 4.8, 1.55),
            giant("Sovereign Sky Manta", 23, 28, 5.0, 1.7),
            giant("Glasswake Bone Lord", 28, 31, 4.4, 1.65),
            giant("Refracted Iron Colossus", 27, 34, 4.6, 1.7),
            giant("Prism Obsidian Colossus", 24, 36, 4.6, 1.8),
        ],
    },
    MapDef {
        name: "The Aureate Reach",
        zone: "Gilded Terraces",
        map: 0,
        center: [500.0, -330.0, 12.1],
        leash: 110.0,
        victory: "The Aureate Reach gleams under sovereign light.",
        foes: &[
            foe("Aureate Hopper", 20, 30, 4.4, 1.0),
            foe("Gilded Skimmer", 22, 32, 4.8, 1.0),
            foe("Terrace Woolly Drifter", 21, 34, 3.8, 1.1),
            foe("Sun-Hound", 30, 36, 5.2, 1.05),
            foe("Golden Sky Manta", 23, 38, 5.0, 1.1),
            foe("Tarnished Hollow", 25, 40, 4.4, 1.05),
            foe("Aureate Honor-Guard", 26, 42, 4.2, 1.15),
            giant("Sovereign Bone Lord", 28, 45, 4.0, 1.25),
            giant("Gilded Iron Colossus", 27, 48, 3.8, 1.3),
        ],
        bosses: &[
            foe("Fallen Sun-Knight", 26, 35, 4.8, 1.6),
            giant("Aureate Sky Sovereign", 23, 38, 5.2, 1.75),
            foe("Cantor Shade", 29, 41, 4.8, 1.7),
            giant("Archon of the Terraces", 28, 44, 4.4, 1.7),
            giant("The Gilded Colossus", 27, 47, 4.6, 1.75),
            giant("Eclipse Colossus", 24, 50, 4.6, 1.85),
        ],
    },
    MapDef {
        name: "Nocturnum Obsidian Isle",
        zone: "Obsidian Rift",
        map: 0,
        center: [-320.0, 360.0, 4.6],
        leash: 95.0,
        victory: "The Obsidian Colossus of Nocturnum has fallen.",
        foes: &[
            foe("Nocturnum Blight Hound", 30, 45, 5.2, 1.05),
            foe("Rift Hollow", 25, 47, 4.6, 1.05),
            foe("Obsidian Wraith", 29, 49, 4.8, 1.1),
            foe("Void Sky Manta", 23, 51, 5.2, 1.1),
            foe("Ashen Dread-Knight", 26, 53, 4.4, 1.2),
            giant("Nocturnum Bone Lord", 28, 56, 4.2, 1.3),
            giant("Abyssal Iron Colossus", 27, 58, 4.0, 1.35),
            giant("Obsidian Shard-Walker", 24, 60, 3.8, 1.25),
        ],
        bosses: &[
            foe("Dread-Knight of Nocturnum", 26, 52, 5.0, 1.65),
            foe("High Wraith Oriel's Echo", 29, 55, 5.0, 1.75),
            giant("Lord of the Bone Rift", 28, 57, 4.4, 1.75),
            giant("Iron Tyrant of the Abyss", 27, 59, 4.6, 1.8),
            giant("Avatar of the Elsewhere", 24, 61, 4.6, 1.85),
            giant("Nocturnum Obsidian Colossus", 24, 63, 4.8, 2.0),
        ],
    },
];

/// A battleground's horde and bosses with their numbers.
pub(crate) struct Roster {
    pub enemies: Vec<EnemyDef>,
    pub bosses: Vec<EnemyDef>,
}

static ROSTERS: std::sync::LazyLock<Vec<Roster>> = std::sync::LazyLock::new(|| {
    MAPS.iter()
        .map(|m| {
            if m.foes.is_empty() {
                Roster {
                    enemies: ENEMIES.to_vec(),
                    bosses: BOSSES.to_vec(),
                }
            } else {
                Roster {
                    enemies: ladder(m.foes, ENEMIES),
                    bosses: ladder(m.bosses, BOSSES),
                }
            }
        })
        .collect()
});

pub(crate) fn roster(map: usize) -> &'static Roster {
    &ROSTERS[map.min(ROSTERS.len() - 1)]
}

/// Number a roster off a tuned ladder: each creature takes the health, damage and experience at
/// its own place along it, from the ladder's running peak so no later tier comes out softer.
fn ladder(foes: &[Foe], tuned: &[EnemyDef]) -> Vec<EnemyDef> {
    let mut peak = (0.0f32, 0.0f32, 0.0f32);
    let rungs: Vec<(f32, f32, f32)> = tuned
        .iter()
        .map(|d| {
            peak = (
                peak.0.max(d.hp),
                peak.1.max(d.damage),
                peak.2.max(d.xp as f32),
            );
            peak
        })
        .collect();
    let top = (rungs.len() - 1) as f32;
    foes.iter()
        .enumerate()
        .map(|(i, f)| {
            let t = if foes.len() > 1 {
                i as f32 / (foes.len() - 1) as f32 * top
            } else {
                0.0
            };
            let (lo, hi) = (rungs[t.floor() as usize], rungs[t.ceil() as usize]);
            let k = t.fract();
            let mix = |a: f32, b: f32| (a + (b - a) * k).round();
            EnemyDef {
                name: f.name,
                display: f.display,
                hp: mix(lo.0, hi.0),
                speed: f.speed,
                damage: mix(lo.1, hi.1),
                scale: f.scale,
                xp: mix(lo.2, hi.2) as u32,
                level: f.level,
                big: f.big,
            }
        })
        .collect()
}
