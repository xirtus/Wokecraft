//! Authoritative Combat, Spell Casting, Monster Movement, Progression, Loot & Item Encoders.

use crate::opcodes::write_packed_guid;
use crate::spawns::{get_item_template, ItemTemplate};

// ============================================================================
// 1. Celandia Spell Definitions (Active 60001..=60015 + Mobility Spells)
// ============================================================================

#[derive(Debug, Clone, Copy)]
pub struct CelandiaSpellInfo {
    pub spell_id: u32,
    pub school: u8, // 0=Physical, 1=Holy, 2=Fire, 3=Nature, 4=Frost, 5=Shadow, 6=Arcane
    pub min_damage: u32,
    pub max_damage: u32,
    pub heal_amount: u32,
    pub aoe_radius: f32,
    pub is_blink: bool,
    pub speed_multiplier: Option<f32>,
}

pub fn get_celandia_spell(spell_id: u32) -> CelandiaSpellInfo {
    match spell_id {
        60001 => CelandiaSpellInfo {
            // Porcelain Riposte
            spell_id,
            school: 0,
            min_damage: 38,
            max_damage: 54,
            heal_amount: 0,
            aoe_radius: 0.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60002 => CelandiaSpellInfo {
            // Whirling Cadence (AoE)
            spell_id,
            school: 0,
            min_damage: 32,
            max_damage: 48,
            heal_amount: 0,
            aoe_radius: 10.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60003 => CelandiaSpellInfo {
            // Grappling Hook
            spell_id,
            school: 0,
            min_damage: 42,
            max_damage: 60,
            heal_amount: 0,
            aoe_radius: 0.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60004 => CelandiaSpellInfo {
            // Frostbell Chime
            spell_id,
            school: 4,
            min_damage: 45,
            max_damage: 66,
            heal_amount: 25,
            aoe_radius: 8.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60005 => CelandiaSpellInfo {
            // Lagoon Frost Nova
            spell_id,
            school: 4,
            min_damage: 34,
            max_damage: 50,
            heal_amount: 0,
            aoe_radius: 12.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60006 => CelandiaSpellInfo {
            // Elsewhere Squall
            spell_id,
            school: 4,
            min_damage: 52,
            max_damage: 78,
            heal_amount: 0,
            aoe_radius: 14.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60007 => CelandiaSpellInfo {
            // Prism Volley
            spell_id,
            school: 6,
            min_damage: 46,
            max_damage: 68,
            heal_amount: 0,
            aoe_radius: 10.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60008 => CelandiaSpellInfo {
            // Mirage Scatter
            spell_id,
            school: 6,
            min_damage: 38,
            max_damage: 56,
            heal_amount: 0,
            aoe_radius: 10.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60009 => CelandiaSpellInfo {
            // Aureate Sunburst
            spell_id,
            school: 1,
            min_damage: 55,
            max_damage: 82,
            heal_amount: 40,
            aoe_radius: 8.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60010 => CelandiaSpellInfo {
            // Sovereign Sanctuary
            spell_id,
            school: 1,
            min_damage: 30,
            max_damage: 45,
            heal_amount: 95,
            aoe_radius: 12.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60011 => CelandiaSpellInfo {
            // Nocturnum Lantern
            spell_id,
            school: 5,
            min_damage: 54,
            max_damage: 80,
            heal_amount: 0,
            aoe_radius: 0.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60012 => CelandiaSpellInfo {
            // Obsidian Eclipse
            spell_id,
            school: 5,
            min_damage: 48,
            max_damage: 72,
            heal_amount: 30,
            aoe_radius: 12.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60013 => CelandiaSpellInfo {
            // Voltekka Lance
            spell_id,
            school: 2,
            min_damage: 75,
            max_damage: 110,
            heal_amount: 0,
            aoe_radius: 10.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60014 => CelandiaSpellInfo {
            // Starlight Resonance
            spell_id,
            school: 6,
            min_damage: 48,
            max_damage: 70,
            heal_amount: 80,
            aoe_radius: 12.0,
            is_blink: false,
            speed_multiplier: None,
        },
        60015 => CelandiaSpellInfo {
            // Ashen Soul Rend
            spell_id,
            school: 2,
            min_damage: 60,
            max_damage: 88,
            heal_amount: 25,
            aoe_radius: 8.0,
            is_blink: false,
            speed_multiplier: None,
        },
        1953 => CelandiaSpellInfo {
            // Phase Blink
            spell_id,
            school: 6,
            min_damage: 0,
            max_damage: 0,
            heal_amount: 35,
            aoe_radius: 0.0,
            is_blink: true,
            speed_multiplier: None,
        },
        1044 | 5118 | 2983 | 586 | 2645 | 1850 => CelandiaSpellInfo {
            // Mobility speed boosts
            spell_id,
            school: 3,
            min_damage: 0,
            max_damage: 0,
            heal_amount: 45,
            aoe_radius: 0.0,
            is_blink: false,
            speed_multiplier: Some(1.65),
        },
        _ => CelandiaSpellInfo {
            spell_id,
            school: 0,
            min_damage: 35,
            max_damage: 52,
            heal_amount: 0,
            aoe_radius: 0.0,
            is_blink: false,
            speed_multiplier: None,
        },
    }
}

// ============================================================================
// 2. Wire Packet Encoders for Combat, Spells, Movement, XP & Loot
// ============================================================================

/// `SMSG_ATTACKSTART` (`0x0143`): `u64 attacker`, `u64 victim`.
pub fn encode_attack_start(attacker_guid: u64, victim_guid: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(16);
    buf.extend_from_slice(&attacker_guid.to_le_bytes());
    buf.extend_from_slice(&victim_guid.to_le_bytes());
    buf
}

/// `SMSG_ATTACKSTOP` (`0x0144`): `packed attacker`, `packed victim`, `u32 is_dead`.
pub fn encode_attack_stop(attacker_guid: u64, victim_guid: u64, is_dead: bool) -> Vec<u8> {
    let mut buf = Vec::with_capacity(24);
    write_packed_guid(&mut buf, attacker_guid);
    write_packed_guid(&mut buf, victim_guid);
    buf.extend_from_slice(&u32::from(is_dead).to_le_bytes());
    buf
}

/// `SMSG_ATTACKERSTATEUPDATE` (`0x014A`): exact match with `AttackerStateUpdate::read`.
pub fn encode_attacker_state_update(
    attacker_guid: u64,
    victim_guid: u64,
    damage: u32,
    is_crit: bool,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(64);
    let hit_info: u32 = if is_crit { 0x0000_00EA } else { 0x0000_0002 };
    buf.extend_from_slice(&hit_info.to_le_bytes());
    write_packed_guid(&mut buf, attacker_guid);
    write_packed_guid(&mut buf, victim_guid);
    buf.extend_from_slice(&damage.to_le_bytes());
    buf.push(1); // sub_damage_count = 1
    buf.extend_from_slice(&1u32.to_le_bytes()); // school_mask = physical
    buf.extend_from_slice(&(damage as f32).to_le_bytes());
    buf.extend_from_slice(&damage.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // absorbed
    buf.extend_from_slice(&0i32.to_le_bytes()); // resisted
    buf.extend_from_slice(&1u32.to_le_bytes()); // target_state = VICTIMSTATE_NORMAL
    buf.extend_from_slice(&0u32.to_le_bytes()); // unknown1
    buf.extend_from_slice(&0u32.to_le_bytes()); // spell_id
    buf.extend_from_slice(&0u32.to_le_bytes()); // blocked_amount
    buf
}

/// `SMSG_AI_REACTION` (`0x013C`): `u64 guid`, `u32 reaction` (2 = hostile aggro).
pub fn encode_ai_reaction(creature_guid: u64, reaction: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12);
    buf.extend_from_slice(&creature_guid.to_le_bytes());
    buf.extend_from_slice(&reaction.to_le_bytes());
    buf
}

/// `SMSG_MONSTER_MOVE` (`0x00DD`): exact match with `MonsterMove::read`.
pub fn encode_monster_move(
    creature_guid: u64,
    start: (f32, f32, f32),
    dest: (f32, f32, f32),
    spline_id: u32,
    duration_ms: u32,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(48);
    write_packed_guid(&mut buf, creature_guid);
    buf.extend_from_slice(&start.0.to_le_bytes());
    buf.extend_from_slice(&start.1.to_le_bytes());
    buf.extend_from_slice(&start.2.to_le_bytes());
    buf.extend_from_slice(&spline_id.to_le_bytes());
    buf.push(0); // move_type = 0 (Normal)
    buf.extend_from_slice(&0u32.to_le_bytes()); // spline_flags = 0 (run)
    buf.extend_from_slice(&duration_ms.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes()); // 1 waypoint (destination)
    buf.extend_from_slice(&dest.0.to_le_bytes());
    buf.extend_from_slice(&dest.1.to_le_bytes());
    buf.extend_from_slice(&dest.2.to_le_bytes());
    buf
}

/// `SMSG_CAST_RESULT` (`0x0130`): `u32 spell_id`, `u8 status` (0 = OK).
pub fn encode_cast_result_ok(spell_id: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5);
    buf.extend_from_slice(&spell_id.to_le_bytes());
    buf.push(0); // 0 = SPELL_CAST_OK
    buf
}

/// `SMSG_SPELL_START` (`0x0131`): exact match with `SpellStart::read`.
pub fn encode_spell_start(caster_guid: u64, target_guid: u64, spell_id: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(36);
    write_packed_guid(&mut buf, caster_guid);
    write_packed_guid(&mut buf, caster_guid);
    buf.extend_from_slice(&spell_id.to_le_bytes());
    buf.extend_from_slice(&0x0002u16.to_le_bytes()); // cast_flags
    buf.extend_from_slice(&0u32.to_le_bytes()); // timer = 0 (instant)
    if target_guid != 0 {
        buf.extend_from_slice(&0x0002u16.to_le_bytes()); // TARGET_FLAG_UNIT
        write_packed_guid(&mut buf, target_guid);
    } else {
        buf.extend_from_slice(&0x0000u16.to_le_bytes()); // TARGET_FLAG_SELF
    }
    buf
}

/// `SMSG_SPELL_GO` (`0x0132`): exact match with `SpellGo::read`.
pub fn encode_spell_go(
    caster_guid: u64,
    primary_target: u64,
    hit_targets: &[u64],
    spell_id: u32,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(48 + hit_targets.len() * 8);
    write_packed_guid(&mut buf, caster_guid);
    write_packed_guid(&mut buf, caster_guid);
    buf.extend_from_slice(&spell_id.to_le_bytes());
    buf.extend_from_slice(&0x0100u16.to_le_bytes()); // cast_flags
    let count = hit_targets.len().min(255) as u8;
    buf.push(count);
    for &g in hit_targets.iter().take(usize::from(count)) {
        buf.extend_from_slice(&g.to_le_bytes());
    }
    buf.push(0); // miss_count = 0
    if primary_target != 0 {
        buf.extend_from_slice(&0x0002u16.to_le_bytes()); // TARGET_FLAG_UNIT
        write_packed_guid(&mut buf, primary_target);
    } else {
        buf.extend_from_slice(&0x0000u16.to_le_bytes());
    }
    buf
}

/// `SMSG_SPELLNONMELEEDAMAGELOG` (`0x0250`): exact match with `SpellNonMeleeDamageLog::read`.
pub fn encode_spell_non_melee_damage_log(
    target_guid: u64,
    attacker_guid: u64,
    spell_id: u32,
    damage: u32,
    school: u8,
    is_crit: bool,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(48);
    write_packed_guid(&mut buf, target_guid);
    write_packed_guid(&mut buf, attacker_guid);
    buf.extend_from_slice(&spell_id.to_le_bytes());
    buf.extend_from_slice(&damage.to_le_bytes());
    buf.push(school);
    buf.extend_from_slice(&0u32.to_le_bytes()); // absorbed
    buf.extend_from_slice(&0i32.to_le_bytes()); // resisted
    buf.push(0); // physical_log
    buf.push(0); // unused
    buf.extend_from_slice(&0u32.to_le_bytes()); // blocked
    let hit_info: u32 = if is_crit { 0x22 } else { 0x02 };
    buf.extend_from_slice(&hit_info.to_le_bytes());
    buf.push(0); // extend byte
    buf
}

/// `SMSG_SPELLHEALLOG` (`0x0150`): exact match with `SpellHealLog::read`.
pub fn encode_spell_heal_log(
    target_guid: u64,
    healer_guid: u64,
    spell_id: u32,
    heal: u32,
    is_crit: bool,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32);
    write_packed_guid(&mut buf, target_guid);
    write_packed_guid(&mut buf, healer_guid);
    buf.extend_from_slice(&spell_id.to_le_bytes());
    buf.extend_from_slice(&heal.to_le_bytes());
    buf.push(u8::from(is_crit));
    buf.push(0);
    buf
}

/// `SMSG_PARTYKILLLOG` (`0x01F5`): `u64 killer`, `u64 victim`.
pub fn encode_party_kill_log(killer_guid: u64, victim_guid: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(16);
    buf.extend_from_slice(&killer_guid.to_le_bytes());
    buf.extend_from_slice(&victim_guid.to_le_bytes());
    buf
}

/// `SMSG_LOG_XPGAIN` (`0x01D0`): exact match with `LogXpGain::read`.
pub fn encode_log_xp_gain(victim_guid: u64, xp: u32, is_kill: bool) -> Vec<u8> {
    let mut buf = Vec::with_capacity(21);
    buf.extend_from_slice(&victim_guid.to_le_bytes());
    buf.extend_from_slice(&xp.to_le_bytes());
    if is_kill {
        buf.push(0); // type 0 = kill
        buf.extend_from_slice(&xp.to_le_bytes()); // base_xp
        buf.extend_from_slice(&1.0f32.to_le_bytes()); // group_rate
    } else {
        buf.push(1); // type 1 = quest/non-kill
    }
    buf
}

/// `SMSG_LEVELUP_INFO` (`0x01D4`): exact match with `LevelUpInfo::read` (12 u32s = 48 bytes).
pub fn encode_levelup_info(new_level: u32, hp_gain: u32, mana_gain: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(48);
    buf.extend_from_slice(&new_level.to_le_bytes());
    buf.extend_from_slice(&hp_gain.to_le_bytes());
    buf.extend_from_slice(&mana_gain.to_le_bytes());
    for _ in 0..4 {
        buf.extend_from_slice(&0u32.to_le_bytes()); // rage/focus/energy/happiness
    }
    for &stat_gain in &[2u32, 2, 3, 2, 2] {
        buf.extend_from_slice(&stat_gain.to_le_bytes()); // Str, Agi, Sta, Int, Spi
    }
    buf
}

/// `SMSG_LOOT_RESPONSE` (`0x0160`): exact match with `LootResponse::read`.
pub fn encode_loot_response(source_guid: u64, money: u32, items: &[u32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 + items.len() * 22);
    buf.extend_from_slice(&source_guid.to_le_bytes());
    buf.push(1); // loot_type = 1 (LOOT_CORPSE)
    buf.extend_from_slice(&money.to_le_bytes());
    buf.push(items.len() as u8);
    for (slot_idx, &item_id) in items.iter().enumerate() {
        let disp = get_item_template(item_id).map_or(item_id, |t| t.display_id);
        buf.push(slot_idx as u8); // 0-based slot index
        buf.extend_from_slice(&item_id.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes()); // count = 1
        buf.extend_from_slice(&disp.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // random_suffix
        buf.extend_from_slice(&0u32.to_le_bytes()); // random_property_id
        buf.push(0); // slot_type = 0 (LOOT_SLOT_NORMAL)
    }
    buf
}

/// `SMSG_LOOT_RELEASE_RESPONSE` (`0x0161`): `u64 guid`, `u8(1)`.
pub fn encode_loot_release_response(source_guid: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(9);
    buf.extend_from_slice(&source_guid.to_le_bytes());
    buf.push(1);
    buf
}

/// `SMSG_ITEM_PUSH_RESULT` (`0x0166`): exact match with `ItemPushResult::read`.
pub fn encode_item_push_result(
    player_guid: u64,
    pack_slot: u8,
    item_id: u32,
    count: u32,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(41);
    buf.extend_from_slice(&player_guid.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes()); // received_source = 1 (looted)
    buf.extend_from_slice(&0u32.to_le_bytes()); // created = 0
    buf.extend_from_slice(&1u32.to_le_bytes()); // show_in_chat = 1
    buf.push(0xFF); // bag_slot = 0xFF (backpack)
    buf.extend_from_slice(&(23 + u32::from(pack_slot)).to_le_bytes()); // inventory slot
    buf.extend_from_slice(&item_id.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // suffix_factor
    buf.extend_from_slice(&0u32.to_le_bytes()); // item_random_prop_id
    buf.extend_from_slice(&count.to_le_bytes());
    buf
}

/// `SMSG_ITEM_QUERY_SINGLE_RESPONSE` (`0x0058`): exact match with `read_item_query_response`.
pub fn encode_item_query_response(entry: u32, tpl: Option<&ItemTemplate>) -> Vec<u8> {
    let Some(it) = tpl else {
        return (entry | 0x8000_0000).to_le_bytes().to_vec();
    };
    let mut buf = Vec::with_capacity(512);
    buf.extend_from_slice(&it.entry.to_le_bytes());
    buf.extend_from_slice(&it.class.to_le_bytes());
    buf.extend_from_slice(&it.subclass.to_le_bytes());
    // name + 3 empty names
    buf.extend_from_slice(it.name.as_bytes());
    buf.push(0);
    buf.extend_from_slice(&[0, 0, 0]);

    buf.extend_from_slice(&it.display_id.to_le_bytes());
    buf.extend_from_slice(&it.quality.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // flags
    buf.extend_from_slice(&it.buy_price.to_le_bytes());
    buf.extend_from_slice(&it.sell_price.to_le_bytes());
    buf.extend_from_slice(&it.inventory_type.to_le_bytes());
    buf.extend_from_slice(&(-1i32).to_le_bytes()); // allowable_class
    buf.extend_from_slice(&(-1i32).to_le_bytes()); // allowable_race
    buf.extend_from_slice(&it.item_level.to_le_bytes());
    buf.extend_from_slice(&it.required_level.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_skill
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_skill_rank
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_spell
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_honor_rank
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_city_rank
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_rep_faction
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_rep_rank
    buf.extend_from_slice(&it.max_count.to_le_bytes());
    buf.extend_from_slice(&it.stackable.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // container_slots

    // 10 ItemStat { type: u32, value: i32 }
    for i in 0..10 {
        if i == 0 && it.bonus_stat_val != 0 {
            buf.extend_from_slice(&it.bonus_stat_type.to_le_bytes());
            buf.extend_from_slice(&it.bonus_stat_val.to_le_bytes());
        } else if i == 1 && it.bonus_stat_val != 0 {
            // Also grant Stamina on every weapon
            buf.extend_from_slice(&7u32.to_le_bytes());
            buf.extend_from_slice(&it.bonus_stat_val.to_le_bytes());
        } else {
            buf.extend_from_slice(&0u32.to_le_bytes());
            buf.extend_from_slice(&0i32.to_le_bytes());
        }
    }

    // 5 Damage { min: f32, max: f32, school: u32 }
    for i in 0..5 {
        if i == 0 {
            buf.extend_from_slice(&it.min_dmg.to_le_bytes());
            buf.extend_from_slice(&it.max_dmg.to_le_bytes());
            buf.extend_from_slice(&0u32.to_le_bytes()); // physical
        } else {
            buf.extend_from_slice(&0.0f32.to_le_bytes());
            buf.extend_from_slice(&0.0f32.to_le_bytes());
            buf.extend_from_slice(&0u32.to_le_bytes());
        }
    }

    // armor + 6 resistances
    buf.extend_from_slice(&it.armor.to_le_bytes());
    for _ in 0..6 {
        buf.extend_from_slice(&0i32.to_le_bytes());
    }

    buf.extend_from_slice(&it.delay_ms.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // ammo_type
    let range_mod = if it.inventory_type == 15 { 100.0f32 } else { 0.0f32 };
    buf.extend_from_slice(&range_mod.to_le_bytes());

    // 5 spell blocks of 6 words: (spell_id, trigger, charges, cooldown_ms, category, category_cooldown_ms)
    for _ in 0..5 {
        buf.extend_from_slice(&0u32.to_le_bytes()); // spell_id
        buf.extend_from_slice(&0u32.to_le_bytes()); // trigger
        buf.extend_from_slice(&0i32.to_le_bytes()); // charges
        buf.extend_from_slice(&(-1i32).to_le_bytes()); // cooldown_ms
        buf.extend_from_slice(&0u32.to_le_bytes()); // category
        buf.extend_from_slice(&(-1i32).to_le_bytes()); // category_cooldown_ms
    }

    let bonding = if it.class == 12 { 4u32 } else { 1u32 };
    buf.extend_from_slice(&bonding.to_le_bytes());
    buf.extend_from_slice(it.description.as_bytes());
    buf.push(0);
    buf.extend_from_slice(&0u32.to_le_bytes()); // page_text
    buf.extend_from_slice(&0u32.to_le_bytes()); // language_id
    buf.extend_from_slice(&0u32.to_le_bytes()); // page_material
    buf.extend_from_slice(&0u32.to_le_bytes()); // start_quest
    buf.extend_from_slice(&0u32.to_le_bytes()); // lock_id
    buf.extend_from_slice(&it.material.to_le_bytes());
    buf.extend_from_slice(&it.sheath.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // random_property
    let block_val = if it.inventory_type == 14 { 22u32 } else { 0u32 };
    buf.extend_from_slice(&block_val.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // item_set
    let max_dur = if it.class == 2 || it.class == 4 { 75u32 } else { 0u32 };
    buf.extend_from_slice(&max_dur.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // area
    buf.extend_from_slice(&0u32.to_le_bytes()); // map
    buf.extend_from_slice(&0u32.to_le_bytes()); // bag_family
    buf
}
