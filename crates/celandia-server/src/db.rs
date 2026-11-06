//! Persistent & In-Memory Account and Character Database (`celandia-db.json`).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::crypto::{compute_verifier, generate_salt};
use crate::opcodes::{EQUIPMENT_SLOT_MAINHAND, EQUIPMENT_SLOT_OFFHAND, EQUIPMENT_SLOT_RANGED};
use crate::spawns::{
    default_celandia_spells, default_spawn_for_race, starting_equipment_for_class,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountRecord {
    pub username: String,
    pub salt: [u8; 32],
    pub verifier: [u8; 32],
    pub session_key: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestProgress {
    pub quest_id: u32,
    pub counts: [u8; 4],
    pub completed: bool,
    pub rewarded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterRecord {
    pub guid_low: u32,
    pub account: String,
    pub name: String,
    pub race: u8,
    pub class: u8,
    pub gender: u8,
    pub skin: u8,
    pub face: u8,
    pub hair_style: u8,
    pub hair_color: u8,
    pub facial_hair: u8,
    pub outfit_id: u8,
    pub level: u8,
    pub xp: u32,
    pub next_level_xp: u32,
    pub money: u32,
    pub map_id: u32,
    pub zone_id: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub orientation: f32,
    pub health: u32,
    pub max_health: u32,
    pub mana: u32,
    pub max_mana: u32,
    pub display_id: u32,
    pub equipment: Vec<(u8, u32)>,       // (equip_slot 0..18, item_entry)
    pub bag_items: Vec<(u8, u32, u32)>,  // (pack_slot 0..15, item_entry, count)
    pub spells: Vec<u16>,
    pub action_buttons: Vec<(u8, u32)>,  // (slot 0..119, packed_u32)
    pub quests: Vec<QuestProgress>,
    pub stand_state: u8,
    pub sheath_state: u8,
    pub player_flags: u32,
}

impl CharacterRecord {
    pub fn guid(&self) -> u64 {
        u64::from(self.guid_low)
    }

    pub fn new_character(
        guid_low: u32,
        account: &str,
        name: &str,
        race: u8,
        class: u8,
        gender: u8,
        skin: u8,
        face: u8,
        hair_style: u8,
        hair_color: u8,
        facial_hair: u8,
        outfit_id: u8,
    ) -> Self {
        let spawn = default_spawn_for_race(race);
        let safe_race = race.clamp(1, 9);
        let display_id = 48 + u32::from(safe_race) * 2 + u32::from(gender & 1);
        let (mh, oh, ranged) = starting_equipment_for_class(class);
        let mut equipment = Vec::new();
        if mh != 0 {
            equipment.push((EQUIPMENT_SLOT_MAINHAND, mh));
        }
        if oh != 0 {
            equipment.push((EQUIPMENT_SLOT_OFFHAND, oh));
        }
        if ranged != 0 {
            equipment.push((EQUIPMENT_SLOT_RANGED, ranged));
        }

        let spells = default_celandia_spells();
        let default_bar_spells: &[u16] = &[
            60001, // Slot 1: Porcelain Riposte
            60002, // Slot 2: Whirling Cadence
            60003, // Slot 3: Grappling Hook
            60004, // Slot 4: Frostbell Chime
            60005, // Slot 5: Lagoon Frost Nova
            60007, // Slot 6: Prism Volley
            60009, // Slot 7: Aureate Sunburst
            60011, // Slot 8: Nocturnum Lantern
            60013, // Slot 9: Voltekka Lance
            60014, // Slot 10: Starlight Resonance
            100,   // Slot 11: Grapple Lunge
            1953,  // Slot 12: Phase Blink
        ];
        let mut action_buttons = Vec::with_capacity(default_bar_spells.len());
        for (slot, &sp) in default_bar_spells.iter().enumerate() {
            action_buttons.push((slot as u8, u32::from(sp)));
        }

        Self {
            guid_low,
            account: account.trim().to_ascii_uppercase(),
            name: name.to_string(),
            race: safe_race,
            class: class.clamp(1, 11),
            gender: gender & 1,
            skin,
            face,
            hair_style,
            hair_color,
            facial_hair,
            outfit_id,
            level: 5,
            xp: 0,
            next_level_xp: 1400,
            money: 10_000, // 1 gold starter purse
            map_id: spawn.map_id,
            zone_id: spawn.zone_id,
            x: spawn.x,
            y: spawn.y,
            z: spawn.z,
            orientation: spawn.orientation,
            health: 480,
            max_health: 480,
            mana: 360,
            max_mana: 360,
            display_id,
            equipment,
            bag_items: vec![(0, 50008, 1)], // Starter Mere Route-Seal Letter in backpack slot 0
            spells,
            action_buttons,
            quests: Vec::new(),
            stand_state: 0,
            sheath_state: 1,
            player_flags: 0,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DbFileFormat {
    next_char_guid: u32,
    accounts: HashMap<String, AccountRecord>,
    characters: HashMap<u32, CharacterRecord>,
}

#[derive(Debug, Clone)]
pub struct CelandiaDb {
    path: Option<PathBuf>,
    inner: Arc<RwLock<DbFileFormat>>,
}

impl CelandiaDb {
    /// Load database from disk if present, or initialize with default Celandia accounts.
    pub fn open(path: Option<PathBuf>) -> Self {
        let mut data = if let Some(ref p) = path {
            if p.exists() {
                fs::read_to_string(p)
                    .ok()
                    .and_then(|s| serde_json::from_str::<DbFileFormat>(&s).ok())
                    .unwrap_or_default()
            } else {
                DbFileFormat::default()
            }
        } else {
            DbFileFormat::default()
        };

        if data.next_char_guid == 0 {
            data.next_char_guid = 1;
        }

        let db = Self {
            path,
            inner: Arc::new(RwLock::new(data)),
        };

        // Ensure standard Celandia accounts exist out of the box
        for &(user, pass) in &[
            ("ADMIN", "ADMIN"),
            ("PLAYER", "PLAYER"),
            ("ROOK", "ROOK"),
            ("CELANDIA", "CELANDIA"),
            ("TEST", "TEST"),
        ] {
            db.ensure_account_with_password(user, pass);
        }

        // Pre-seed a ready-to-play hero on the CELANDIA account if none exists
        if db.characters_for_account("CELANDIA").is_empty() {
            let _ = db.create_character(
                "CELANDIA",
                "Rook",
                1, // Human / Porcelain Fairy
                1, // Warrior / Route-Mender
                1, // Female
                0,
                0,
                0,
                0,
                0,
                0,
            );
        }

        db
    }

    pub fn in_memory() -> Self {
        Self::open(None)
    }

    fn save_locked(&self, data: &DbFileFormat) {
        if let Some(ref p) = self.path {
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(data) {
                let tmp = p.with_extension("json.tmp");
                if fs::write(&tmp, json).is_ok() {
                    let _ = fs::rename(&tmp, p);
                }
            }
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn get_or_autocreate_account(&self, username: &str) -> AccountRecord {
        let user_up = username.trim().to_ascii_uppercase();
        let acc = {
            let guard = self.inner.read().expect("db read lock");
            guard.accounts.get(&user_up).cloned()
        };
        let acc = acc.unwrap_or_else(|| self.ensure_account_with_password(&user_up, &user_up));
        if self.characters_for_account(&user_up).is_empty() {
            let mut hero_name: String = user_up
                .chars()
                .filter(|c| c.is_ascii_alphabetic())
                .take(12)
                .collect();
            if hero_name.is_empty() {
                hero_name = "Celandian".to_string();
            } else {
                let mut chars = hero_name.chars();
                if let Some(first) = chars.next() {
                    hero_name = format!(
                        "{}{}",
                        first.to_ascii_uppercase(),
                        chars.as_str().to_ascii_lowercase()
                    );
                }
            }
            if self.find_character_by_name(&hero_name).is_some() {
                hero_name = format!("{}x", &hero_name[..hero_name.len().min(11)]);
            }
            let _ = self.create_character(&user_up, &hero_name, 1, 1, 1, 0, 0, 0, 0, 0, 0);
        }
        acc
    }

    pub fn ensure_account_with_password(&self, username: &str, password: &str) -> AccountRecord {
        let user_up = username.trim().to_ascii_uppercase();
        let mut guard = self.inner.write().expect("db write lock");
        if let Some(acc) = guard.accounts.get(&user_up) {
            return acc.clone();
        }
        let salt = generate_salt();
        let verifier = compute_verifier(&user_up, password, &salt);
        let rec = AccountRecord {
            username: user_up.clone(),
            salt,
            verifier,
            session_key: None,
        };
        guard.accounts.insert(user_up, rec.clone());
        self.save_locked(&guard);
        rec
    }

    pub fn save_session_key(&self, username: &str, session_key: [u8; 40]) {
        let user_up = username.trim().to_ascii_uppercase();
        let mut guard = self.inner.write().expect("db write lock");
        if let Some(acc) = guard.accounts.get_mut(&user_up) {
            acc.session_key = Some(session_key.to_vec());
            self.save_locked(&guard);
        }
    }

    pub fn get_session_key(&self, username: &str) -> Option<[u8; 40]> {
        let user_up = username.trim().to_ascii_uppercase();
        let guard = self.inner.read().expect("db read lock");
        let acc = guard.accounts.get(&user_up)?;
        let sk = acc.session_key.as_ref()?;
        if sk.len() == 40 {
            let mut out = [0u8; 40];
            out.copy_from_slice(sk);
            Some(out)
        } else {
            None
        }
    }

    pub fn characters_for_account(&self, username: &str) -> Vec<CharacterRecord> {
        let user_up = username.trim().to_ascii_uppercase();
        let guard = self.inner.read().expect("db read lock");
        let mut list: Vec<CharacterRecord> = guard
            .characters
            .values()
            .filter(|c| c.account == user_up)
            .cloned()
            .collect();
        list.sort_by_key(|c| c.guid_low);
        list
    }

    pub fn get_character(&self, guid_low: u32) -> Option<CharacterRecord> {
        let guard = self.inner.read().expect("db read lock");
        guard.characters.get(&guid_low).cloned()
    }

    pub fn find_character_by_name(&self, name: &str) -> Option<CharacterRecord> {
        let guard = self.inner.read().expect("db read lock");
        guard
            .characters
            .values()
            .find(|c| c.name.eq_ignore_ascii_case(name))
            .cloned()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_character(
        &self,
        account: &str,
        name: &str,
        race: u8,
        class: u8,
        gender: u8,
        skin: u8,
        face: u8,
        hair_style: u8,
        hair_color: u8,
        facial_hair: u8,
        outfit_id: u8,
    ) -> Result<CharacterRecord, u8> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(crate::opcodes::CHAR_CREATE_ERROR);
        }
        let mut guard = self.inner.write().expect("db write lock");
        if guard
            .characters
            .values()
            .any(|c| c.name.eq_ignore_ascii_case(trimmed))
        {
            return Err(crate::opcodes::CHAR_CREATE_NAME_IN_USE);
        }
        let guid_low = guard.next_char_guid;
        guard.next_char_guid += 1;

        let rec = CharacterRecord::new_character(
            guid_low,
            account,
            trimmed,
            race,
            class,
            gender,
            skin,
            face,
            hair_style,
            hair_color,
            facial_hair,
            outfit_id,
        );
        guard.characters.insert(guid_low, rec.clone());
        self.save_locked(&guard);
        Ok(rec)
    }

    pub fn delete_character(&self, account: &str, guid_low: u32) -> bool {
        let user_up = account.trim().to_ascii_uppercase();
        let mut guard = self.inner.write().expect("db write lock");
        if let Some(existing) = guard.characters.get(&guid_low) {
            if existing.account == user_up {
                guard.characters.remove(&guid_low);
                self.save_locked(&guard);
                return true;
            }
        }
        false
    }

    pub fn update_character(&self, rec: CharacterRecord) {
        let mut guard = self.inner.write().expect("db write lock");
        guard.characters.insert(rec.guid_low, rec);
        self.save_locked(&guard);
    }
}
