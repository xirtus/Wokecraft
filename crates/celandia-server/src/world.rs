//! Authoritative WoW 1.12.1 (build 5875) World Server (`:8085`) & 100ms World Tick Loop.

use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rand::Rng;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info, warn};

use crate::combat::{
    encode_ai_reaction, encode_attack_start, encode_attack_stop, encode_attacker_state_update,
    encode_cast_result_ok, encode_item_push_result, encode_item_query_response,
    encode_levelup_info, encode_log_xp_gain, encode_loot_release_response, encode_loot_response,
    encode_monster_move, encode_party_kill_log, encode_spell_go, encode_spell_heal_log,
    encode_spell_non_melee_damage_log, encode_spell_start, get_celandia_spell,
};
use crate::crypto::{verify_world_auth_session, ServerHeaderCipher};
use crate::db::{CelandiaDb, CharacterRecord, QuestProgress};
use crate::opcodes::*;
use crate::quests::{
    encode_gossip_message, encode_npc_text_update, encode_quest_query_response,
    encode_questgiver_offer_reward, encode_questgiver_quest_complete,
    encode_questgiver_quest_details, encode_questgiver_request_items, encode_questgiver_status,
    encode_questupdate_add_kill, get_npc_gossip_options, get_quest_template, quests_for_npc,
    GossipAction, DIALOG_STATUS_AVAILABLE, DIALOG_STATUS_CHAT, DIALOG_STATUS_INCOMPLETE,
    DIALOG_STATUS_NONE, DIALOG_STATUS_REWARD2,
};
use crate::spawns::{
    build_initial_spawns, find_teleport_location, get_creature_template, get_item_template,
    kingdom_locations, sample_celandia_area, sample_celandia_height, CreatureInstance,
    TeleportLocation,
};

pub type OutboundPacket = (u16, Vec<u8>);

#[derive(Debug, Clone)]
pub struct ActivePlayer {
    pub session_id: u64,
    pub character: CharacterRecord,
    pub selected_target: u64,
    pub auto_attacking: bool,
    pub last_melee_tick: u64,
    pub move_flags: u32,
    pub move_time: u32,
    pub speed_counter: u32,
    pub teleport_counter: u32,
    pub tx: mpsc::UnboundedSender<OutboundPacket>,
}

pub struct WorldState {
    pub db: CelandiaDb,
    pub tick_count: u64,
    pub spline_counter: u32,
    pub players: HashMap<u64, ActivePlayer>, // keyed by player_guid
    pub creatures: Vec<CreatureInstance>,
}

impl WorldState {
    pub fn new(db: CelandiaDb) -> Self {
        Self {
            db,
            tick_count: 0,
            spline_counter: 1,
            players: HashMap::new(),
            creatures: build_initial_spawns(),
        }
    }

    pub fn send_to_player(&self, player_guid: u64, opcode: u16, body: Vec<u8>) {
        if let Some(p) = self.players.get(&player_guid) {
            let _ = p.tx.send((opcode, body));
        }
    }

    pub fn broadcast_map(&self, map_id: u32, opcode: u16, body: &[u8], except_guid: Option<u64>) {
        for (&guid, p) in &self.players {
            if p.character.map_id == map_id && Some(guid) != except_guid {
                let _ = p.tx.send((opcode, body.to_vec()));
            }
        }
    }
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

pub async fn run_world_listener(listener: TcpListener, db: CelandiaDb) -> Result<()> {
    let local_addr = listener.local_addr()?;
    info!("Celandia World Server (mangosd) listening on {local_addr}");
    let state = Arc::new(RwLock::new(WorldState::new(db)));

    // Spawn 100ms authoritative world tick task
    let tick_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        loop {
            interval.tick().await;
            let mut ws = tick_state.write().await;
            tick_world(&mut ws);
        }
    });

    loop {
        let (stream, peer) = listener.accept().await?;
        let state_clone = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = handle_world_client(stream, peer, state_clone).await {
                debug!("World client {peer} closed: {e}");
            }
        });
    }
}

// ============================================================================
// 1. Authoritative 100ms World Tick (Combat, AI Aggro, Patrols, Respawns)
// ============================================================================

fn tick_world(ws: &mut WorldState) {
    ws.tick_count = ws.tick_count.wrapping_add(1);
    let tick = ws.tick_count;

    // 1. Respawn dead creatures after 15 seconds (150 ticks)
    let mut respawned_indices = Vec::new();
    for (idx, c) in ws.creatures.iter_mut().enumerate() {
        if let Some(respawn_tick) = c.respawn_at_tick {
            if tick >= respawn_tick {
                c.respawn_at_tick = None;
                c.health = c.max_health;
                c.x = c.home_x;
                c.y = c.home_y;
                c.z = c.home_z;
                c.orientation = c.home_o;
                c.target_guid = 0;
                c.tapped_by = 0;
                c.loot_money = 0;
                c.loot_items.clear();
                respawned_indices.push(idx);
            }
        }
    }
    for idx in respawned_indices {
        let c = ws.creatures[idx].clone();
        let pkt = build_single_creature_create_packet(&c);
        ws.broadcast_map(c.map_id, SMSG_UPDATE_OBJECT, &pkt, None);
    }

    // 2. Player melee auto-attack swings (every 18 ticks = 1.8s)
    let player_guids: Vec<u64> = ws.players.keys().copied().collect();
    for pguid in player_guids {
        let (auto_attacking, target_guid, last_melee, p_map, px, py, p_level) = {
            let Some(p) = ws.players.get(&pguid) else {
                continue;
            };
            (
                p.auto_attacking,
                p.selected_target,
                p.last_melee_tick,
                p.character.map_id,
                p.character.x,
                p.character.y,
                p.character.level,
            )
        };
        if !auto_attacking || target_guid == 0 || tick.saturating_sub(last_melee) < 16 {
            continue;
        }
        let Some(c_idx) = ws
            .creatures
            .iter()
            .position(|c| c.guid == target_guid && c.map_id == p_map && c.is_alive())
        else {
            if let Some(p) = ws.players.get_mut(&pguid) {
                p.auto_attacking = false;
            }
            continue;
        };

        let dist = (ws.creatures[c_idx].x - px).hypot(ws.creatures[c_idx].y - py);
        if dist <= 12.0 {
            if let Some(p) = ws.players.get_mut(&pguid) {
                p.last_melee_tick = tick;
            }
            let base_dmg = 22 + u32::from(p_level) * 4;
            let is_crit = (tick % 5) == 0;
            let dmg = if is_crit { base_dmg * 2 } else { base_dmg };
            let swing_pkt = encode_attacker_state_update(pguid, target_guid, dmg, is_crit);
            ws.broadcast_map(p_map, SMSG_ATTACKERSTATEUPDATE, &swing_pkt, None);
            apply_damage_to_creature(ws, pguid, c_idx, dmg);
        }
    }

    // 3. Creature AI: Aggro counter-attacks & idle patrols
    for c_idx in 0..ws.creatures.len() {
        if !ws.creatures[c_idx].is_alive() {
            continue;
        }
        let target_guid = ws.creatures[c_idx].target_guid;
        let c_map = ws.creatures[c_idx].map_id;
        let c_guid = ws.creatures[c_idx].guid;
        let cx = ws.creatures[c_idx].x;
        let cy = ws.creatures[c_idx].y;
        let cz = ws.creatures[c_idx].z;

        if target_guid != 0 {
            let Some(p) = ws.players.get(&target_guid).cloned() else {
                ws.creatures[c_idx].target_guid = 0;
                continue;
            };
            if p.character.map_id != c_map || p.character.health == 0 {
                ws.creatures[c_idx].target_guid = 0;
                continue;
            }
            let dx = p.character.x - cx;
            let dy = p.character.y - cy;
            let dist = dx.hypot(dy);
            if dist > 60.0 {
                // Evade back to home
                ws.creatures[c_idx].target_guid = 0;
                ws.creatures[c_idx].health = ws.creatures[c_idx].max_health;
                let home = (
                    ws.creatures[c_idx].home_x,
                    ws.creatures[c_idx].home_y,
                    ws.creatures[c_idx].home_z,
                );
                ws.creatures[c_idx].x = home.0;
                ws.creatures[c_idx].y = home.1;
                ws.creatures[c_idx].z = home.2;
                let spline_id = ws.spline_counter;
                ws.spline_counter = ws.spline_counter.wrapping_add(1);
                let move_pkt = encode_monster_move(c_guid, (cx, cy, cz), home, spline_id, 2000);
                ws.broadcast_map(c_map, SMSG_MONSTER_MOVE, &move_pkt, None);
                continue;
            }
            if dist > 4.2 && tick.saturating_sub(ws.creatures[c_idx].last_patrol_tick) >= 10 {
                // Chase player
                let nx = p.character.x - (dx / dist) * 2.5;
                let ny = p.character.y - (dy / dist) * 2.5;
                let nz = sample_celandia_height(nx, ny).max(-18.0) + 0.15;
                ws.creatures[c_idx].x = nx;
                ws.creatures[c_idx].y = ny;
                ws.creatures[c_idx].z = nz;
                ws.creatures[c_idx].last_patrol_tick = tick;
                let spline_id = ws.spline_counter;
                ws.spline_counter = ws.spline_counter.wrapping_add(1);
                let dur = ((dist * 140.0) as u32).clamp(250, 2500);
                let move_pkt =
                    encode_monster_move(c_guid, (cx, cy, cz), (nx, ny, nz), spline_id, dur);
                ws.broadcast_map(c_map, SMSG_MONSTER_MOVE, &move_pkt, None);
            } else if dist <= 6.0 && tick.saturating_sub(ws.creatures[c_idx].last_attack_tick) >= 20
            {
                // Creature melee swing on player
                ws.creatures[c_idx].last_attack_tick = tick;
                let tpl = ws.creatures[c_idx].template();
                let dmg = ((tpl.min_dmg as u32).max(2) / 2).max(2);
                if let Some(target_player) = ws.players.get_mut(&target_guid) {
                    // Never reduce player below 15% health on auto-ticks so solo exploration stays fun
                    let floor = (target_player.character.max_health / 6).max(10);
                    if target_player.character.health > floor + dmg {
                        target_player.character.health -= dmg;
                    } else {
                        target_player.character.health = floor;
                    }
                    let new_hp = target_player.character.health;
                    let max_hp = target_player.character.max_health;
                    let swing = encode_attacker_state_update(c_guid, target_guid, dmg, false);
                    ws.broadcast_map(c_map, SMSG_ATTACKERSTATEUPDATE, &swing, None);
                    let val_pkt = build_unit_health_delta_packet(target_guid, new_hp, max_hp, 0);
                    ws.broadcast_map(c_map, SMSG_UPDATE_OBJECT, &val_pkt, None);
                }
            }
        } else if ws.creatures[c_idx].template().faction == FACTION_MONSTER {
            // Gentle idle patrol for hostile fauna every ~8 seconds if players are on the map
            let has_players_on_map = ws.players.values().any(|p| p.character.map_id == c_map);
            if has_players_on_map
                && tick.saturating_sub(ws.creatures[c_idx].last_patrol_tick)
                    >= 75 + (c_idx as u64 % 35)
            {
                ws.creatures[c_idx].last_patrol_tick = tick;
                let angle = ((tick as f32 * 0.37) + c_idx as f32 * 1.9).sin() * std::f32::consts::PI;
                let nx = ws.creatures[c_idx].home_x + angle.cos() * 4.5;
                let ny = ws.creatures[c_idx].home_y + angle.sin() * 4.5;
                let nz = sample_celandia_height(nx, ny).max(-18.0) + 0.15;
                ws.creatures[c_idx].x = nx;
                ws.creatures[c_idx].y = ny;
                ws.creatures[c_idx].z = nz;
                let spline_id = ws.spline_counter;
                ws.spline_counter = ws.spline_counter.wrapping_add(1);
                let move_pkt =
                    encode_monster_move(c_guid, (cx, cy, cz), (nx, ny, nz), spline_id, 1800);
                ws.broadcast_map(c_map, SMSG_MONSTER_MOVE, &move_pkt, None);
            }
        }
    }
}

fn apply_damage_to_creature(
    ws: &mut WorldState,
    attacker_guid: u64,
    c_idx: usize,
    damage: u32,
) {
    let tpl = ws.creatures[c_idx].template();
    if tpl.faction == FACTION_FRIENDLY {
        return;
    }
    let was_full = ws.creatures[c_idx].target_guid == 0;
    if ws.creatures[c_idx].tapped_by == 0 {
        ws.creatures[c_idx].tapped_by = attacker_guid;
    }
    ws.creatures[c_idx].target_guid = attacker_guid;

    let c_guid = ws.creatures[c_idx].guid;
    let c_entry = ws.creatures[c_idx].entry;
    let c_map = ws.creatures[c_idx].map_id;

    if was_full {
        let aggro = encode_ai_reaction(c_guid, 2);
        ws.send_to_player(attacker_guid, SMSG_AI_REACTION, aggro);
    }

    if ws.creatures[c_idx].health > damage {
        ws.creatures[c_idx].health -= damage;
        let hp = ws.creatures[c_idx].health;
        let max_hp = ws.creatures[c_idx].max_health;
        let dyn_flags = UNIT_DYNFLAG_TAPPED | UNIT_DYNFLAG_TAPPED_BY_PLAYER;
        let delta = build_unit_health_delta_packet(c_guid, hp, max_hp, dyn_flags);
        ws.broadcast_map(c_map, SMSG_UPDATE_OBJECT, &delta, None);
    } else {
        // Creature died!
        ws.creatures[c_idx].health = 0;
        ws.creatures[c_idx].target_guid = 0;
        ws.creatures[c_idx].respawn_at_tick = Some(ws.tick_count + 150); // 15s respawn

        // Roll loot money & items
        let money = if tpl.money_max > tpl.money_min {
            rand::thread_rng().gen_range(tpl.money_min..=tpl.money_max)
        } else {
            tpl.money_min
        };
        let mut loot_items = Vec::new();
        for &(item_entry, _chance) in tpl.loot_items {
            loot_items.push(item_entry);
        }
        ws.creatures[c_idx].loot_money = money;
        ws.creatures[c_idx].loot_items = loot_items;

        let max_hp = ws.creatures[c_idx].max_health;
        let dyn_flags =
            UNIT_DYNFLAG_DEAD | UNIT_DYNFLAG_LOOTABLE | UNIT_DYNFLAG_TAPPED | UNIT_DYNFLAG_TAPPED_BY_PLAYER;
        let delta = build_unit_health_delta_packet(c_guid, 0, max_hp, dyn_flags);
        ws.broadcast_map(c_map, SMSG_UPDATE_OBJECT, &delta, None);

        let stop_pkt = encode_attack_stop(attacker_guid, c_guid, true);
        ws.broadcast_map(c_map, SMSG_ATTACKSTOP, &stop_pkt, None);

        let kill_pkt = encode_party_kill_log(attacker_guid, c_guid);
        ws.send_to_player(attacker_guid, SMSG_PARTYKILLLOG, kill_pkt);

        // Award XP, Level-Up & Quest Kill Credit
        if let Some(p) = ws.players.get_mut(&attacker_guid) {
            if p.selected_target == c_guid {
                p.auto_attacking = false;
            }
            let xp_gain = tpl.xp_reward;
            if xp_gain > 0 {
                let xp_pkt = encode_log_xp_gain(c_guid, xp_gain, true);
                let _ = p.tx.send((SMSG_LOG_XPGAIN, xp_pkt));
                grant_player_xp(&mut p.character, &p.tx, xp_gain);
            }

            // Check active quest objectives for this creature entry
            let mut quest_deltas = Vec::new();
            for (slot_idx, qprog) in p
                .character
                .quests
                .iter_mut()
                .filter(|q| !q.rewarded)
                .enumerate()
            {
                if let Some(qtpl) = get_quest_template(qprog.quest_id) {
                    for (obj_idx, obj) in qtpl.objectives.iter().enumerate() {
                        if obj.creature_entry == c_entry
                            && u32::from(qprog.counts[obj_idx]) < obj.required_count
                        {
                            qprog.counts[obj_idx] += 1;
                            let new_c = u32::from(qprog.counts[obj_idx]);
                            let add_kill = encode_questupdate_add_kill(
                                qtpl.quest_id,
                                c_entry,
                                new_c,
                                obj.required_count,
                                c_guid,
                            );
                            let _ = p.tx.send((SMSG_QUESTUPDATE_ADD_KILL, add_kill));
                        }
                    }
                    let all_done = qtpl
                        .objectives
                        .iter()
                        .enumerate()
                        .all(|(i, o)| u32::from(qprog.counts[i]) >= o.required_count);
                    if all_done && !qprog.completed {
                        qprog.completed = true;
                        let _ = p.tx.send((
                            SMSG_QUESTUPDATE_COMPLETE,
                            qtpl.quest_id.to_le_bytes().to_vec(),
                        ));
                    }
                    quest_deltas.push((slot_idx as u8, qprog.clone()));
                }
            }
            if !quest_deltas.is_empty() {
                let q_pkt = build_player_quest_log_delta_packet(&p.character);
                let _ = p.tx.send((SMSG_UPDATE_OBJECT, q_pkt));
            }
            let updated_char = p.character.clone();
            ws.db.update_character(updated_char);
        }
    }
}

fn grant_player_xp(
    ch: &mut CharacterRecord,
    tx: &mpsc::UnboundedSender<OutboundPacket>,
    xp_gain: u32,
) {
    ch.xp += xp_gain;
    let mut leveled = false;
    while ch.xp >= ch.next_level_xp && ch.level < 60 {
        ch.xp -= ch.next_level_xp;
        ch.level += 1;
        ch.next_level_xp = u32::from(ch.level) * 400;
        let hp_gain = 60;
        let mana_gain = 45;
        ch.max_health += hp_gain;
        ch.health = ch.max_health;
        ch.max_mana += mana_gain;
        ch.mana = ch.max_mana;
        leveled = true;
        let lvl_pkt = encode_levelup_info(u32::from(ch.level), hp_gain, mana_gain);
        let _ = tx.send((SMSG_LEVELUP_INFO, lvl_pkt));
    }

    let mut fb = UpdateFieldBuilder::new();
    fb.set_u32(UNIT_FIELD_LEVEL, u32::from(ch.level));
    fb.set_u32(UNIT_FIELD_HEALTH, ch.health);
    fb.set_u32(UNIT_FIELD_MAXHEALTH, ch.max_health);
    fb.set_u32(UNIT_FIELD_POWER1, ch.mana);
    fb.set_u32(UNIT_FIELD_MAXPOWER1, ch.max_mana);
    fb.set_u32(PLAYER_XP, ch.xp);
    fb.set_u32(PLAYER_NEXT_LEVEL_XP, ch.next_level_xp);
    fb.set_u32(PLAYER_FIELD_COINAGE, ch.money);
    if leveled {
        fb.set_u32(UNIT_FIELD_BASE_HEALTH, ch.max_health);
        fb.set_u32(UNIT_FIELD_BASE_MANA, ch.max_mana);
    }
    let pkt = build_values_update_packet(ch.guid(), &fb);
    let _ = tx.send((SMSG_UPDATE_OBJECT, pkt));
}

// ============================================================================
// 2. Client Connection & Packet Dispatcher
// ============================================================================

async fn handle_world_client(
    stream: TcpStream,
    peer: SocketAddr,
    state: Arc<RwLock<WorldState>>,
) -> Result<()> {
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();

    // 1. Send unencrypted SMSG_AUTH_CHALLENGE (0x01EC)
    let server_seed: u32 = 0xCE1A_5875;
    let mut challenge_pkt = Vec::with_capacity(8);
    challenge_pkt.extend_from_slice(&6u16.to_be_bytes()); // size = 2 (opcode) + 4 (seed)
    challenge_pkt.extend_from_slice(&SMSG_AUTH_CHALLENGE.to_le_bytes());
    challenge_pkt.extend_from_slice(&server_seed.to_le_bytes());
    writer.write_all(&challenge_pkt).await?;
    writer.flush().await?;

    // 2. Read unencrypted CMSG_AUTH_SESSION (0x01ED)
    let mut hdr = [0u8; 6];
    reader.read_exact(&mut hdr).await?;
    let pkt_size = u16::from_be_bytes([hdr[0], hdr[1]]) as usize;
    let opcode = u32::from_le_bytes([hdr[2], hdr[3], hdr[4], hdr[5]]) as u16;
    if opcode != CMSG_AUTH_SESSION || pkt_size < 4 {
        anyhow::bail!("expected CMSG_AUTH_SESSION (0x01ED), got 0x{opcode:04X}");
    }
    let body_len = pkt_size - 4;
    let mut body = vec![0u8; body_len];
    reader.read_exact(&mut body).await?;

    if body.len() < 33 {
        anyhow::bail!("CMSG_AUTH_SESSION body too short ({})", body.len());
    }
    let _build = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let _unk = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
    let nul_pos = body[8..]
        .iter()
        .position(|&b| b == 0)
        .ok_or_else(|| anyhow::anyhow!("missing username NUL in CMSG_AUTH_SESSION"))?;
    let username = String::from_utf8_lossy(&body[8..8 + nul_pos])
        .trim()
        .to_ascii_uppercase();
    let after_name = 8 + nul_pos + 1;
    if after_name + 24 > body.len() {
        anyhow::bail!("truncated seed/proof in CMSG_AUTH_SESSION");
    }
    let client_seed = u32::from_le_bytes([
        body[after_name],
        body[after_name + 1],
        body[after_name + 2],
        body[after_name + 3],
    ]);
    let mut client_proof = [0u8; 20];
    client_proof.copy_from_slice(&body[after_name + 4..after_name + 24]);

    let addon_count = count_client_addons(&body[after_name + 24..]);

    let session_key = {
        let ws = state.read().await;
        ws.db
            .get_session_key(&username)
            .unwrap_or([0x42u8; 40])
    };

    if !verify_world_auth_session(
        &username,
        client_seed,
        server_seed,
        &session_key,
        &client_proof,
    ) {
        warn!("World CMSG_AUTH_SESSION proof mismatch for '{username}' from {peer}");
    }

    // 3. Activate header stream cipher for all subsequent packets
    let mut cipher = ServerHeaderCipher::new(session_key);
    let mut send_cipher = cipher.clone();
    let (tx, mut rx) = mpsc::unbounded_channel::<OutboundPacket>();

    // Spawn encrypted writer task
    let writer_handle = tokio::spawn(async move {
        while let Some((op, payload)) = rx.recv().await {
            let enc_hdr = send_cipher.encrypt_server_header(payload.len(), op);
            if writer.write_all(&enc_hdr).await.is_err() {
                break;
            }
            if !payload.is_empty() && writer.write_all(&payload).await.is_err() {
                break;
            }
            if writer.flush().await.is_err() {
                break;
            }
        }
    });

    // 4. Send SMSG_AUTH_RESPONSE (AUTH_OK = 0x0C) + SMSG_ADDON_INFO
    let mut auth_resp = Vec::with_capacity(10);
    auth_resp.push(AUTH_OK);
    auth_resp.extend_from_slice(&0u32.to_le_bytes()); // billing_time
    auth_resp.push(0); // billing_flags
    auth_resp.extend_from_slice(&0u32.to_le_bytes()); // billing_rested
    let _ = tx.send((SMSG_AUTH_RESPONSE, auth_resp));

    if addon_count > 0 {
        let mut addon_resp = Vec::with_capacity(addon_count * 8);
        for _ in 0..addon_count {
            addon_resp.extend_from_slice(&[2, 1, 0, 0, 0, 0, 0, 0]);
        }
        let _ = tx.send((SMSG_ADDON_INFO, addon_resp));
    }

    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let mut logged_in_guid: Option<u64> = None;

    // 5. Encrypted packet receive loop
    loop {
        let mut c_hdr = [0u8; 6];
        if reader.read_exact(&mut c_hdr).await.is_err() {
            break;
        }
        let (pkt_len, op_u32) = cipher.decrypt_client_header(&mut c_hdr);
        let op = op_u32 as u16;
        let payload_len = usize::from(pkt_len).saturating_sub(4);
        if payload_len > 65_536 {
            warn!("Oversized packet len={payload_len} op=0x{op:04X} from {peer}");
            break;
        }
        let mut payload = vec![0u8; payload_len];
        if payload_len > 0 && reader.read_exact(&mut payload).await.is_err() {
            break;
        }

        handle_world_opcode(
            op,
            &payload,
            &username,
            session_id,
            &mut logged_in_guid,
            &tx,
            &state,
        )
        .await;
    }

    // Cleanup on disconnect
    if let Some(pguid) = logged_in_guid {
        let mut ws = state.write().await;
        if let Some(removed) = ws.players.remove(&pguid) {
            ws.db.update_character(removed.character.clone());
            ws.broadcast_map(
                removed.character.map_id,
                SMSG_DESTROY_OBJECT,
                &pguid.to_le_bytes(),
                Some(pguid),
            );
        }
    }
    writer_handle.abort();
    Ok(())
}

fn count_client_addons(addon_block: &[u8]) -> usize {
    if addon_block.len() < 4 {
        return 0;
    }
    let uncompressed_len =
        u32::from_le_bytes([addon_block[0], addon_block[1], addon_block[2], addon_block[3]])
            as usize;
    if uncompressed_len == 0 || uncompressed_len > 65_536 {
        return 0;
    }
    let mut decoder = flate2::read::ZlibDecoder::new(&addon_block[4..]);
    let mut inflated = Vec::new();
    if decoder.read_to_end(&mut inflated).is_err() {
        return 0;
    }
    // Each addon entry is `cstring name`, `u8 flags`, `u32 crc`, `u32 unk`
    let mut pos = 0usize;
    let mut count = 0usize;
    while pos < inflated.len() {
        let Some(nul) = inflated[pos..].iter().position(|&b| b == 0) else {
            break;
        };
        pos += nul + 1;
        if pos + 9 > inflated.len() {
            break;
        }
        pos += 9;
        count += 1;
    }
    count
}

async fn handle_world_opcode(
    op: u16,
    payload: &[u8],
    username: &str,
    session_id: u64,
    logged_in_guid: &mut Option<u64>,
    tx: &mpsc::UnboundedSender<OutboundPacket>,
    state: &Arc<RwLock<WorldState>>,
) {
    match op {
        CMSG_PING => {
            let seq = if payload.len() >= 4 {
                u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]])
            } else {
                0
            };
            let _ = tx.send((SMSG_PONG, seq.to_le_bytes().to_vec()));
        }
        CMSG_CHAR_ENUM => {
            let chars = {
                let ws = state.read().await;
                ws.db.characters_for_account(username)
            };
            let body = encode_char_enum(&chars);
            let _ = tx.send((SMSG_CHAR_ENUM, body));
        }
        CMSG_CHAR_CREATE => {
            let Some((name, race, class, gender, skin, face, hs, hc, fh, outfit)) =
                parse_char_create(payload)
            else {
                let _ = tx.send((SMSG_CHAR_CREATE, vec![CHAR_CREATE_ERROR]));
                return;
            };
            let res = {
                let ws = state.write().await;
                ws.db.create_character(
                    username, &name, race, class, gender, skin, face, hs, hc, fh, outfit,
                )
            };
            match res {
                Ok(ch) => {
                    info!(
                        "Created character '{}' (guid={}, race={}, class={}) for account '{}'",
                        ch.name, ch.guid_low, ch.race, ch.class, username
                    );
                    let _ = tx.send((SMSG_CHAR_CREATE, vec![CHAR_CREATE_SUCCESS]));
                }
                Err(code) => {
                    let _ = tx.send((SMSG_CHAR_CREATE, vec![code]));
                }
            }
        }
        CMSG_CHAR_DELETE => {
            if payload.len() >= 8 {
                let guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let ws = state.write().await;
                ws.db.delete_character(username, guid as u32);
                let _ = tx.send((SMSG_CHAR_DELETE, vec![CHAR_DELETE_SUCCESS]));
            }
        }
        CMSG_PLAYER_LOGIN => {
            if payload.len() < 8 {
                return;
            }
            let guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
            let guid_low = guid as u32;

            let mut ws = state.write().await;
            let Some(mut ch) = ws.db.get_character(guid_low) else {
                let _ = tx.send((SMSG_CHARACTER_LOGIN_FAILED, vec![0x42]));
                return;
            };
            // Ensure character is standing on valid terrain surface (never below ADT mesh)
            ch.zone_id = sample_celandia_area(ch.x, ch.y);
            let ground_z = sample_celandia_height(ch.x, ch.y).max(-18.0) + 0.35;
            if ch.z < ground_z - 1.0 || (ch.z - ground_z).abs() > 25.0 || ch.z < -22.0 {
                ch.z = ground_z;
                ws.db.update_character(ch.clone());
            }

            *logged_in_guid = Some(guid);

            // 1. Login handshake packets
            let _ = tx.send((
                SMSG_LOGIN_VERIFY_WORLD,
                encode_world_pos(ch.map_id, ch.x, ch.y, ch.z, ch.orientation),
            ));
            let _ = tx.send((SMSG_ACCOUNT_DATA_TIMES, vec![0u8; 128]));
            let _ = tx.send((SMSG_TUTORIAL_FLAGS, vec![0xFFu8; 32]));
            let _ = tx.send((
                SMSG_BINDPOINTUPDATE,
                encode_bindpoint(ch.x, ch.y, ch.z, ch.map_id, ch.zone_id),
            ));
            let _ = tx.send((SMSG_INITIALIZE_FACTIONS, encode_initialize_factions()));
            let _ = tx.send((SMSG_INITIAL_SPELLS, encode_initial_spells(&ch.spells)));
            let _ = tx.send((
                SMSG_ACTION_BUTTONS,
                encode_action_buttons(&ch.action_buttons),
            ));
            let _ = tx.send((SMSG_LOGIN_SETTIMESPEED, encode_login_settimespeed()));
            let _ = tx.send((
                SMSG_INIT_WORLD_STATES,
                encode_init_world_states(ch.map_id, ch.zone_id),
            ));

            // 2. Register active player in WorldState
            let active = ActivePlayer {
                session_id,
                character: ch.clone(),
                selected_target: 0,
                auto_attacking: false,
                last_melee_tick: 0,
                move_flags: 0,
                move_time: 0,
                speed_counter: 1,
                teleport_counter: 1,
                tx: tx.clone(),
            };
            ws.players.insert(guid, active);

            // 3. Send SMSG_UPDATE_OBJECT with Self + Items + Other Players + Map Creatures
            let world_snapshot = build_login_update_object_packet(&ws, guid);
            let _ = tx.send((SMSG_UPDATE_OBJECT, world_snapshot));

            // 4. Broadcast this player's arrival to other players on the same map
            let self_for_others = build_single_player_create_packet(&ch, false);
            ws.broadcast_map(ch.map_id, SMSG_UPDATE_OBJECT, &self_for_others, Some(guid));

            // 5. Welcome system chat message
            let welcome = format!(
                "Welcome to Celandia: The Elsewhere Tide, {}! Speak with Moss Calder, Rook, or Ilex in Lowbell Court, or type .help for Kingdom crossings.",
                ch.name
            );
            let _ = tx.send((SMSG_MESSAGECHAT, encode_system_chat(&welcome)));
            info!(
                "Player '{}' (guid={}) entered Celandia map={} at ({:.1}, {:.1}, {:.1})",
                ch.name, guid, ch.map_id, ch.x, ch.y, ch.z
            );
        }
        CMSG_NAME_QUERY => {
            if payload.len() >= 8 {
                let q_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let ws = state.read().await;
                if let Some(ch) = ws
                    .players
                    .get(&q_guid)
                    .map(|p| p.character.clone())
                    .or_else(|| ws.db.get_character(q_guid as u32))
                {
                    let _ = tx.send((SMSG_NAME_QUERY_RESPONSE, encode_name_query_response(&ch)));
                }
            }
        }
        CMSG_CREATURE_QUERY => {
            if payload.len() >= 4 {
                let entry = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                let resp = encode_creature_query_response(entry);
                let _ = tx.send((SMSG_CREATURE_QUERY_RESPONSE, resp));
            }
        }
        CMSG_ITEM_QUERY_SINGLE => {
            if payload.len() >= 4 {
                let entry = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                let tpl = get_item_template(entry);
                let resp = encode_item_query_response(entry, tpl);
                let _ = tx.send((SMSG_ITEM_QUERY_SINGLE_RESPONSE, resp));
            }
        }
        CMSG_QUEST_QUERY => {
            if payload.len() >= 4 {
                let quest_id =
                    u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                if let Some(qtpl) = get_quest_template(quest_id) {
                    let _ = tx.send((
                        SMSG_QUEST_QUERY_RESPONSE,
                        encode_quest_query_response(qtpl),
                    ));
                }
            }
        }
        CMSG_NPC_TEXT_QUERY => {
            if payload.len() >= 4 {
                let text_id =
                    u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                let _ = tx.send((SMSG_NPC_TEXT_UPDATE, encode_npc_text_update(text_id)));
            }
        }
        CMSG_QUERY_TIME => {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as u32;
            let _ = tx.send((SMSG_QUERY_TIME_RESPONSE, now.to_le_bytes().to_vec()));
        }
        CMSG_PLAYED_TIME => {
            let mut resp = Vec::with_capacity(8);
            resp.extend_from_slice(&3600u32.to_le_bytes());
            resp.extend_from_slice(&1200u32.to_le_bytes());
            let _ = tx.send((SMSG_PLAYED_TIME, resp));
        }
        CMSG_SET_SELECTION => {
            if payload.len() >= 8 {
                let target = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    if let Some(p) = ws.players.get_mut(&pguid) {
                        p.selected_target = target;
                    }
                }
            }
        }
        CMSG_STANDSTATECHANGE => {
            if !payload.is_empty() {
                let stand = payload[0];
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    if let Some(p) = ws.players.get_mut(&pguid) {
                        p.character.stand_state = stand;
                        let _ = tx.send((SMSG_STANDSTATE_UPDATE, vec![stand]));
                    }
                }
            }
        }
        CMSG_SETSHEATHED => {
            if payload.len() >= 4 {
                let sheath = payload[0];
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    if let Some(p) = ws.players.get_mut(&pguid) {
                        p.character.sheath_state = sheath;
                        let mut fb = UpdateFieldBuilder::new();
                        fb.set_u32(UNIT_FIELD_BYTES_2, u32::from(sheath));
                        let pkt = build_values_update_packet(pguid, &fb);
                        let map_id = p.character.map_id;
                        ws.broadcast_map(map_id, SMSG_UPDATE_OBJECT, &pkt, None);
                    }
                }
            }
        }
        CMSG_SET_ACTION_BUTTON => {
            if payload.len() >= 5 {
                let slot = payload[0];
                let packed = u32::from_le_bytes([payload[1], payload[2], payload[3], payload[4]]);
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    let updated_ch = if let Some(p) = ws.players.get_mut(&pguid) {
                        p.character.action_buttons.retain(|&(s, _)| s != slot);
                        if packed != 0 {
                            p.character.action_buttons.push((slot, packed));
                        }
                        Some(p.character.clone())
                    } else {
                        None
                    };
                    if let Some(ch) = updated_ch {
                        ws.db.update_character(ch);
                    }
                }
            }
        }
        // Movement opcodes (0x00B5 ..= 0x00EE)
        MSG_MOVE_START_FORWARD
        | MSG_MOVE_START_BACKWARD
        | MSG_MOVE_STOP
        | MSG_MOVE_START_STRAFE_LEFT
        | MSG_MOVE_START_STRAFE_RIGHT
        | MSG_MOVE_STOP_STRAFE
        | MSG_MOVE_JUMP
        | MSG_MOVE_START_TURN_LEFT
        | MSG_MOVE_START_TURN_RIGHT
        | MSG_MOVE_STOP_TURN
        | MSG_MOVE_START_PITCH_UP
        | MSG_MOVE_START_PITCH_DOWN
        | MSG_MOVE_STOP_PITCH
        | MSG_MOVE_SET_RUN_MODE
        | MSG_MOVE_SET_WALK_MODE
        | MSG_MOVE_FALL_LAND
        | MSG_MOVE_START_SWIM
        | MSG_MOVE_STOP_SWIM
        | MSG_MOVE_SET_FACING
        | MSG_MOVE_SET_PITCH
        | MSG_MOVE_HEARTBEAT => {
            if payload.len() >= 24 {
                if let Some(pguid) = *logged_in_guid {
                    let flags =
                        u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                    let time =
                        u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]);
                    let x =
                        f32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
                    let y =
                        f32::from_le_bytes([payload[12], payload[13], payload[14], payload[15]]);
                    let z =
                        f32::from_le_bytes([payload[16], payload[17], payload[18], payload[19]]);
                    let o =
                        f32::from_le_bytes([payload[20], payload[21], payload[22], payload[23]]);

                    let mut ws = state.write().await;
                    let map_opt = if let Some(p) = ws.players.get_mut(&pguid) {
                        let min_z = if p.character.map_id == 0 {
                            sample_celandia_height(x, y).max(-19.5)
                        } else {
                            -5.0
                        };
                        p.move_flags = flags;
                        p.move_time = time;
                        p.character.x = x;
                        p.character.y = y;
                        p.character.z = z.max(min_z);
                        p.character.orientation = o;
                        p.character.zone_id = sample_celandia_area(x, y);
                        Some(p.character.map_id)
                    } else {
                        None
                    };
                    if let Some(map_id) = map_opt {
                        let mut relay = Vec::with_capacity(9 + payload.len());
                        write_packed_guid(&mut relay, pguid);
                        relay.extend_from_slice(payload);
                        ws.broadcast_map(map_id, op, &relay, Some(pguid));
                    }
                }
            }
        }
        MSG_MOVE_WORLDPORT_ACK => {
            // Client finished loading new map after SMSG_NEW_WORLD -> send full world state on the new map!
            if let Some(pguid) = *logged_in_guid {
                let ws = state.read().await;
                if let Some(p) = ws.players.get(&pguid) {
                    let ch = &p.character;
                    let _ = tx.send((
                        SMSG_LOGIN_VERIFY_WORLD,
                        encode_world_pos(ch.map_id, ch.x, ch.y, ch.z, ch.orientation),
                    ));
                    let _ = tx.send((
                        SMSG_INIT_WORLD_STATES,
                        encode_init_world_states(ch.map_id, ch.zone_id),
                    ));
                    let snapshot = build_login_update_object_packet(&ws, pguid);
                    let _ = tx.send((SMSG_UPDATE_OBJECT, snapshot));
                }
            }
        }
        MSG_MOVE_TELEPORT_ACK
        | CMSG_FORCE_RUN_SPEED_CHANGE_ACK
        | CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK
        | CMSG_FORCE_SWIM_SPEED_CHANGE_ACK
        | CMSG_FORCE_WALK_SPEED_CHANGE_ACK
        | CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK
        | CMSG_FORCE_TURN_RATE_CHANGE_ACK => {
            // Acknowledged by client
        }
        CMSG_AREATRIGGER => {
            if payload.len() >= 4 {
                let trigger_id =
                    u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    let current_map = ws
                        .players
                        .get(&pguid)
                        .map_or(0, |p| p.character.map_id);
                    let locs = kingdom_locations();
                    let dest = match trigger_id {
                        2 => locs[1], // Frostbell Lagoon
                        3 => locs[2], // Glasswake Mesas
                        4 => locs[3], // The Aureate Reach
                        5 => locs[4], // Nocturnum Obsidian Isle
                        _ => {
                            // Portal toggle between Map 0 (Porcelain Wake) and Map 1 (The Elsewhere Sanctum)
                            if current_map == 0 {
                                locs[5]
                            } else {
                                locs[0]
                            }
                        }
                    };
                    teleport_player(&mut ws, pguid, dest);
                }
            }
        }
        CMSG_ATTACKSWING => {
            if payload.len() >= 8 {
                let target_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    let tick = ws.tick_count;
                    let mut map_id = 0;
                    let mut p_level = 5;
                    if let Some(p) = ws.players.get_mut(&pguid) {
                        p.selected_target = target_guid;
                        p.auto_attacking = true;
                        p.last_melee_tick = tick;
                        map_id = p.character.map_id;
                        p_level = p.character.level;
                    }
                    let start_pkt = encode_attack_start(pguid, target_guid);
                    ws.broadcast_map(map_id, SMSG_ATTACKSTART, &start_pkt, None);

                    // Deliver immediate first melee strike so combat feels responsive
                    if let Some(c_idx) = ws
                        .creatures
                        .iter()
                        .position(|c| c.guid == target_guid && c.map_id == map_id && c.is_alive())
                    {
                        let dmg = 24 + u32::from(p_level) * 4;
                        let swing = encode_attacker_state_update(pguid, target_guid, dmg, false);
                        ws.broadcast_map(map_id, SMSG_ATTACKERSTATEUPDATE, &swing, None);
                        apply_damage_to_creature(&mut ws, pguid, c_idx, dmg);
                    }
                }
            }
        }
        CMSG_ATTACKSTOP => {
            if let Some(pguid) = *logged_in_guid {
                let mut ws = state.write().await;
                if let Some(p) = ws.players.get_mut(&pguid) {
                    let target = p.selected_target;
                    let map_id = p.character.map_id;
                    p.auto_attacking = false;
                    let stop_pkt = encode_attack_stop(pguid, target, false);
                    ws.broadcast_map(map_id, SMSG_ATTACKSTOP, &stop_pkt, None);
                }
            }
        }
        CMSG_CAST_SPELL => {
            if payload.len() >= 4 {
                let spell_id =
                    u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                let target_flags = if payload.len() >= 6 {
                    u16::from_le_bytes([payload[4], payload[5]])
                } else {
                    0
                };
                let explicit_target = if (target_flags & 0x0002) != 0 && payload.len() > 6 {
                    read_packed_guid(&payload[6..]).map_or(0, |(g, _)| g)
                } else {
                    0
                };

                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    handle_spell_cast(&mut ws, pguid, spell_id, explicit_target);
                }
            }
        }
        CMSG_GOSSIP_HELLO | CMSG_QUESTGIVER_HELLO => {
            if payload.len() >= 8 {
                let npc_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                if let Some(pguid) = *logged_in_guid {
                    let ws = state.read().await;
                    handle_gossip_hello(&ws, pguid, npc_guid, tx);
                }
            }
        }
        CMSG_GOSSIP_SELECT_OPTION => {
            if payload.len() >= 12 {
                let npc_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let option_id =
                    u32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    handle_gossip_select_option(&mut ws, pguid, npc_guid, option_id);
                }
            }
        }
        CMSG_QUESTGIVER_STATUS_QUERY => {
            if payload.len() >= 8 {
                let npc_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                if let Some(pguid) = *logged_in_guid {
                    let ws = state.read().await;
                    let status = compute_questgiver_status(&ws, pguid, npc_guid);
                    let _ = tx.send((
                        SMSG_QUESTGIVER_STATUS,
                        encode_questgiver_status(npc_guid, status),
                    ));
                }
            }
        }
        CMSG_QUESTGIVER_QUERY_QUEST => {
            if payload.len() >= 12 {
                let npc_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let quest_id =
                    u32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
                if let Some(qtpl) = get_quest_template(quest_id) {
                    let _ = tx.send((
                        SMSG_QUESTGIVER_QUEST_DETAILS,
                        encode_questgiver_quest_details(npc_guid, qtpl),
                    ));
                }
            }
        }
        CMSG_QUESTGIVER_ACCEPT_QUEST => {
            if payload.len() >= 12 {
                let npc_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let quest_id =
                    u32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    handle_accept_quest(&mut ws, pguid, npc_guid, quest_id);
                }
            }
        }
        CMSG_QUESTGIVER_COMPLETE_QUEST => {
            if payload.len() >= 12 {
                let npc_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let quest_id =
                    u32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
                if let Some(pguid) = *logged_in_guid {
                    let ws = state.read().await;
                    if let Some(qtpl) = get_quest_template(quest_id) {
                        let completable = ws
                            .players
                            .get(&pguid)
                            .and_then(|p| {
                                p.character
                                    .quests
                                    .iter()
                                    .find(|q| q.quest_id == quest_id)
                            })
                            .is_some_and(|q| q.completed || qtpl.objectives.is_empty());
                        if completable {
                            let _ = tx.send((
                                SMSG_QUESTGIVER_OFFER_REWARD,
                                encode_questgiver_offer_reward(npc_guid, qtpl),
                            ));
                        } else {
                            let _ = tx.send((
                                SMSG_QUESTGIVER_REQUEST_ITEMS,
                                encode_questgiver_request_items(npc_guid, qtpl, false),
                            ));
                        }
                    }
                }
            }
        }
        CMSG_QUESTGIVER_REQUEST_REWARD => {
            if payload.len() >= 12 {
                let npc_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let quest_id =
                    u32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
                if let Some(qtpl) = get_quest_template(quest_id) {
                    let _ = tx.send((
                        SMSG_QUESTGIVER_OFFER_REWARD,
                        encode_questgiver_offer_reward(npc_guid, qtpl),
                    ));
                }
            }
        }
        CMSG_QUESTGIVER_CHOOSE_REWARD => {
            if payload.len() >= 16 {
                let npc_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let quest_id =
                    u32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
                let reward_item_id =
                    u32::from_le_bytes([payload[12], payload[13], payload[14], payload[15]]);
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    handle_choose_quest_reward(&mut ws, pguid, npc_guid, quest_id, reward_item_id);
                }
            }
        }
        CMSG_LOOT => {
            if payload.len() >= 8 {
                let target_guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let ws = state.read().await;
                if let Some(c) = ws.creatures.iter().find(|c| c.guid == target_guid) {
                    let resp = encode_loot_response(target_guid, c.loot_money, &c.loot_items);
                    let _ = tx.send((SMSG_LOOT_RESPONSE, resp));
                }
            }
        }
        CMSG_LOOT_MONEY => {
            if let Some(pguid) = *logged_in_guid {
                let mut ws = state.write().await;
                let mut money_taken = 0u32;
                let target_guid = ws.players.get(&pguid).map_or(0, |p| p.selected_target);
                if let Some(c) = ws
                    .creatures
                    .iter_mut()
                    .find(|c| c.guid == target_guid || (c.tapped_by == pguid && c.loot_money > 0))
                {
                    money_taken = c.loot_money;
                    c.loot_money = 0;
                }
                if money_taken > 0 {
                    let updated_ch = if let Some(p) = ws.players.get_mut(&pguid) {
                        p.character.money += money_taken;
                        let _ = tx.send((
                            SMSG_LOOT_MONEY_NOTIFY,
                            money_taken.to_le_bytes().to_vec(),
                        ));
                        let _ = tx.send((SMSG_LOOT_CLEAR_MONEY, Vec::new()));
                        let mut fb = UpdateFieldBuilder::new();
                        fb.set_u32(PLAYER_FIELD_COINAGE, p.character.money);
                        let _ = tx.send((
                            SMSG_UPDATE_OBJECT,
                            build_values_update_packet(pguid, &fb),
                        ));
                        Some(p.character.clone())
                    } else {
                        None
                    };
                    if let Some(ch) = updated_ch {
                        ws.db.update_character(ch);
                    }
                }
            }
        }
        CMSG_AUTOSTORE_LOOT_ITEM => {
            if !payload.is_empty() {
                let loot_slot = payload[0] as usize;
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    let target_guid = ws.players.get(&pguid).map_or(0, |p| p.selected_target);
                    let mut looted_item = None;
                    let mut corpse_guid = target_guid;
                    if let Some(c) = ws.creatures.iter_mut().find(|c| {
                        c.guid == target_guid || (c.tapped_by == pguid && !c.loot_items.is_empty())
                    }) {
                        corpse_guid = c.guid;
                        if loot_slot < c.loot_items.len() {
                            looted_item = Some(c.loot_items.remove(loot_slot));
                        } else if !c.loot_items.is_empty() {
                            looted_item = Some(c.loot_items.remove(0));
                        }
                    }
                    if let Some(item_id) = looted_item {
                        let _ = tx.send((SMSG_LOOT_REMOVED, vec![loot_slot as u8]));
                        let updated_ch = if let Some(p) = ws.players.get_mut(&pguid) {
                            let pack_slot = add_item_to_player_backpack(&mut p.character, item_id, 1);
                            let push = encode_item_push_result(pguid, pack_slot, item_id, 1);
                            let _ = tx.send((SMSG_ITEM_PUSH_RESULT, push));
                            let item_pkt = build_player_inventory_update_packet(&p.character);
                            let _ = tx.send((SMSG_UPDATE_OBJECT, item_pkt));
                            Some(p.character.clone())
                        } else {
                            None
                        };
                        if let Some(ch) = updated_ch {
                            ws.db.update_character(ch);
                        }
                    }
                    let _ = corpse_guid;
                }
            }
        }
        CMSG_LOOT_RELEASE => {
            if payload.len() >= 8 {
                let guid = u64::from_le_bytes(payload[0..8].try_into().unwrap());
                let _ = tx.send((
                    SMSG_LOOT_RELEASE_RESPONSE,
                    encode_loot_release_response(guid),
                ));
            }
        }
        CMSG_MESSAGECHAT => {
            if payload.len() >= 9 {
                let msg_type = payload[0];
                let lang = u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]);
                let rest = &payload[8..];
                let text = read_cstring_slice(rest);
                if let Some(pguid) = *logged_in_guid {
                    let mut ws = state.write().await;
                    if text.starts_with('.') {
                        handle_gm_command(&mut ws, pguid, &text);
                    } else if let Some(p) = ws.players.get(&pguid) {
                        let chat_pkt = encode_player_chat(
                            msg_type,
                            lang,
                            pguid,
                            &p.character.name,
                            &text,
                        );
                        ws.broadcast_map(p.character.map_id, SMSG_MESSAGECHAT, &chat_pkt, None);
                    }
                }
            }
        }
        CMSG_TEXT_EMOTE => {
            if payload.len() >= 16 {
                let text_emote =
                    u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                let emote_num =
                    u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]);
                let target_guid = u64::from_le_bytes(payload[8..16].try_into().unwrap());
                if let Some(pguid) = *logged_in_guid {
                    let ws = state.read().await;
                    if let Some(p) = ws.players.get(&pguid) {
                        let target_name = if is_unit_guid(target_guid) {
                            get_creature_template(unit_entry_from_guid(target_guid))
                                .map_or("", |t| t.name)
                        } else {
                            ""
                        };
                        let mut resp = Vec::with_capacity(24 + target_name.len());
                        resp.extend_from_slice(&pguid.to_le_bytes());
                        resp.extend_from_slice(&text_emote.to_le_bytes());
                        resp.extend_from_slice(&emote_num.to_le_bytes());
                        let name_len = (target_name.len() + 1) as u32;
                        resp.extend_from_slice(&name_len.to_le_bytes());
                        resp.extend_from_slice(target_name.as_bytes());
                        resp.push(0);
                        ws.broadcast_map(p.character.map_id, SMSG_TEXT_EMOTE, &resp, None);
                    }
                }
            }
        }
        CMSG_LOGOUT_REQUEST | CMSG_PLAYER_LOGOUT => {
            let mut resp = Vec::with_capacity(5);
            resp.extend_from_slice(&0u32.to_le_bytes()); // reason = 0
            resp.push(1); // instant = 1
            let _ = tx.send((SMSG_LOGOUT_RESPONSE, resp));
            let _ = tx.send((SMSG_LOGOUT_COMPLETE, Vec::new()));
            if let Some(pguid) = logged_in_guid.take() {
                let mut ws = state.write().await;
                if let Some(removed) = ws.players.remove(&pguid) {
                    ws.db.update_character(removed.character.clone());
                    ws.broadcast_map(
                        removed.character.map_id,
                        SMSG_DESTROY_OBJECT,
                        &pguid.to_le_bytes(),
                        Some(pguid),
                    );
                }
            }
        }
        CMSG_LOGOUT_CANCEL => {
            let _ = tx.send((SMSG_LOGOUT_CANCEL_ACK, Vec::new()));
        }
        _ => {
            debug!("Unhandled world opcode 0x{op:04X} (len={})", payload.len());
        }
    }
}

// ============================================================================
// 3. Spell Casting, Gossip, Quests, Teleport & GM Command Handlers
// ============================================================================

fn handle_spell_cast(
    ws: &mut WorldState,
    caster_guid: u64,
    spell_id: u32,
    explicit_target: u64,
) {
    let Some(p) = ws.players.get(&caster_guid).cloned() else {
        return;
    };
    let map_id = p.character.map_id;
    let px = p.character.x;
    let py = p.character.y;
    let pz = p.character.z;
    let po = p.character.orientation;
    let p_level = p.character.level;
    let target_guid = if explicit_target != 0 {
        explicit_target
    } else {
        p.selected_target
    };

    let sp = get_celandia_spell(spell_id);

    // 1. Acknowledge cast result OK & broadcast SpellStart
    ws.send_to_player(caster_guid, SMSG_CAST_RESULT, encode_cast_result_ok(spell_id));
    let start_pkt = encode_spell_start(caster_guid, target_guid, spell_id);
    ws.broadcast_map(map_id, SMSG_SPELL_START, &start_pkt, None);

    // 2. Collect hit targets (primary target + AoE targets within radius)
    let mut hit_indices = Vec::new();
    let mut hit_guids = Vec::new();
    for (idx, c) in ws.creatures.iter().enumerate() {
        if c.map_id != map_id || !c.is_alive() {
            continue;
        }
        if c.template().faction == FACTION_FRIENDLY {
            continue;
        }
        let d = (c.x - px).hypot(c.y - py);
        if c.guid == target_guid && d <= 45.0 {
            hit_indices.push(idx);
            hit_guids.push(c.guid);
        } else if sp.aoe_radius > 0.0 && d <= sp.aoe_radius {
            hit_indices.push(idx);
            hit_guids.push(c.guid);
        }
    }
    // If no explicit target was selected for a single-target offensive spell, hit nearest hostile within 25 yds
    if hit_indices.is_empty() && sp.max_damage > 0 {
        if let Some((idx, c)) = ws
            .creatures
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.map_id == map_id && c.is_alive() && c.template().faction == FACTION_MONSTER
            })
            .min_by(|(_, a), (_, b)| {
                let da = (a.x - px).hypot(a.y - py);
                let db = (b.x - px).hypot(b.y - py);
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
        {
            if (c.x - px).hypot(c.y - py) <= 28.0 {
                hit_indices.push(idx);
                hit_guids.push(c.guid);
            }
        }
    }

    let go_pkt = encode_spell_go(caster_guid, target_guid, &hit_guids, spell_id);
    ws.broadcast_map(map_id, SMSG_SPELL_GO, &go_pkt, None);

    // 3. Apply spell damage to hit creatures
    if sp.max_damage > 0 {
        let is_crit = (ws.tick_count % 4) == 0;
        let base = (sp.min_damage + sp.max_damage) / 2 + u32::from(p_level) * 5;
        let dmg = if is_crit { base * 3 / 2 } else { base };
        for idx in hit_indices {
            let c_guid = ws.creatures[idx].guid;
            let dmg_log = encode_spell_non_melee_damage_log(
                c_guid,
                caster_guid,
                spell_id,
                dmg,
                sp.school,
                is_crit,
            );
            ws.broadcast_map(map_id, SMSG_SPELLNONMELEEDAMAGELOG, &dmg_log, None);
            apply_damage_to_creature(ws, caster_guid, idx, dmg);
        }
    }

    // 4. Apply self-heal / mobility boost / Phase Blink
    if sp.heal_amount > 0 {
        if let Some(p_mut) = ws.players.get_mut(&caster_guid) {
            let heal = sp.heal_amount + u32::from(p_level) * 6;
            p_mut.character.health = (p_mut.character.health + heal).min(p_mut.character.max_health);
            let new_hp = p_mut.character.health;
            let max_hp = p_mut.character.max_health;
            let heal_log = encode_spell_heal_log(caster_guid, caster_guid, spell_id, heal, false);
            ws.broadcast_map(map_id, SMSG_SPELLHEALLOG, &heal_log, None);
            let val_pkt = build_unit_health_delta_packet(caster_guid, new_hp, max_hp, 0);
            ws.broadcast_map(map_id, SMSG_UPDATE_OBJECT, &val_pkt, None);
        }
    }

    if let Some(mult) = sp.speed_multiplier {
        if let Some(p_mut) = ws.players.get_mut(&caster_guid) {
            let counter = p_mut.speed_counter;
            p_mut.speed_counter = p_mut.speed_counter.wrapping_add(1);
            let spd_pkt = encode_force_run_speed_change(caster_guid, counter, 7.0 * mult);
            let _ = p_mut.tx.send((SMSG_FORCE_RUN_SPEED_CHANGE, spd_pkt));
        }
    }

    if sp.is_blink {
        let nx = px + po.cos() * 18.0;
        let ny = py + po.sin() * 18.0;
        let nz = sample_celandia_height(nx, ny).max(-18.0) + 0.25;
        if let Some(p_mut) = ws.players.get_mut(&caster_guid) {
            p_mut.character.x = nx;
            p_mut.character.y = ny;
            p_mut.character.z = nz;
            let counter = p_mut.teleport_counter;
            p_mut.teleport_counter = p_mut.teleport_counter.wrapping_add(1);
            let tele_pkt = encode_teleport_ack(caster_guid, counter, nx, ny, nz, po);
            let _ = p_mut.tx.send((MSG_MOVE_TELEPORT_ACK, tele_pkt));
        }
        let _ = pz;
    }
}

fn compute_questgiver_status(ws: &WorldState, player_guid: u64, npc_guid: u64) -> u8 {
    let npc_entry = unit_entry_from_guid(npc_guid);
    let Some(p) = ws.players.get(&player_guid) else {
        return DIALOG_STATUS_NONE;
    };
    let npc_quests = quests_for_npc(npc_entry);
    if npc_quests.is_empty() {
        return if get_creature_template(npc_entry).is_some() {
            DIALOG_STATUS_CHAT
        } else {
            DIALOG_STATUS_NONE
        };
    }
    // Check if any quest can be turned in
    for q in &npc_quests {
        if q.turnin_entries.contains(&npc_entry) {
            if let Some(prog) = p
                .character
                .quests
                .iter()
                .find(|qp| qp.quest_id == q.quest_id && !qp.rewarded)
            {
                if prog.completed || q.objectives.is_empty() {
                    return DIALOG_STATUS_REWARD2;
                }
                return DIALOG_STATUS_INCOMPLETE;
            }
        }
    }
    // Check if any quest is available to accept
    for q in &npc_quests {
        if q.giver_entries.contains(&npc_entry)
            && !p
                .character
                .quests
                .iter()
                .any(|qp| qp.quest_id == q.quest_id)
        {
            return DIALOG_STATUS_AVAILABLE;
        }
    }
    DIALOG_STATUS_CHAT
}

fn handle_gossip_hello(
    ws: &WorldState,
    player_guid: u64,
    npc_guid: u64,
    tx: &mpsc::UnboundedSender<OutboundPacket>,
) {
    let npc_entry = unit_entry_from_guid(npc_guid);
    let Some(tpl) = get_creature_template(npc_entry) else {
        return;
    };
    let text_id = tpl.gossip_text_id.max(1001);
    let _ = tx.send((SMSG_NPC_TEXT_UPDATE, encode_npc_text_update(text_id)));

    let options = get_npc_gossip_options(npc_entry);
    let mut quest_items = Vec::new();
    if let Some(p) = ws.players.get(&player_guid) {
        for q in quests_for_npc(npc_entry) {
            if let Some(prog) = p
                .character
                .quests
                .iter()
                .find(|qp| qp.quest_id == q.quest_id)
            {
                if !prog.rewarded && q.turnin_entries.contains(&npc_entry) {
                    let icon = if prog.completed {
                        u32::from(DIALOG_STATUS_REWARD2)
                    } else {
                        u32::from(DIALOG_STATUS_INCOMPLETE)
                    };
                    quest_items.push((q, icon));
                }
            } else if q.giver_entries.contains(&npc_entry) {
                quest_items.push((q, u32::from(DIALOG_STATUS_AVAILABLE)));
            }
        }
    }

    let msg = encode_gossip_message(npc_guid, text_id, &options, &quest_items);
    let _ = tx.send((SMSG_GOSSIP_MESSAGE, msg));
}

fn handle_gossip_select_option(
    ws: &mut WorldState,
    player_guid: u64,
    npc_guid: u64,
    option_id: u32,
) {
    let npc_entry = unit_entry_from_guid(npc_guid);
    let options = get_npc_gossip_options(npc_entry);
    let Some(opt) = options
        .get(option_id as usize)
        .or_else(|| options.iter().find(|o| o.id == option_id))
    else {
        ws.send_to_player(player_guid, SMSG_GOSSIP_COMPLETE, Vec::new());
        return;
    };

    ws.send_to_player(player_guid, SMSG_GOSSIP_COMPLETE, Vec::new());

    match opt.action {
        GossipAction::HealAndFeed => {
            let heal_info = if let Some(p) = ws.players.get_mut(&player_guid) {
                p.character.health = p.character.max_health;
                p.character.mana = p.character.max_mana;
                let max_hp = p.character.max_health;
                let map_id = p.character.map_id;
                let heal_log = encode_spell_heal_log(player_guid, npc_guid, 60010, max_hp, true);
                let _ = p.tx.send((SMSG_SPELLHEALLOG, heal_log));
                let chat = encode_system_chat(
                    "Moss Calder's porcelain soup warms your spirit: Health and Mana restored to 100%!",
                );
                let _ = p.tx.send((SMSG_MESSAGECHAT, chat));
                Some((map_id, max_hp))
            } else {
                None
            };
            if let Some((map_id, max_hp)) = heal_info {
                let delta = build_unit_health_delta_packet(player_guid, max_hp, max_hp, 0);
                ws.broadcast_map(map_id, SMSG_UPDATE_OBJECT, &delta, None);
            }
        }
        GossipAction::Teleport(dest_key) => {
            if let Some(dest) = find_teleport_location(dest_key) {
                teleport_player(ws, player_guid, dest);
            }
        }
        GossipAction::SendSubText(sub_id) => {
            ws.send_to_player(player_guid, SMSG_NPC_TEXT_UPDATE, encode_npc_text_update(sub_id));
        }
    }
}

fn handle_accept_quest(
    ws: &mut WorldState,
    player_guid: u64,
    npc_guid: u64,
    quest_id: u32,
) {
    let Some(qtpl) = get_quest_template(quest_id) else {
        return;
    };
    if let Some(p) = ws.players.get_mut(&player_guid) {
        if !p.character.quests.iter().any(|q| q.quest_id == quest_id) {
            p.character.quests.push(QuestProgress {
                quest_id,
                counts: [0, 0, 0, 0],
                completed: qtpl.objectives.is_empty(),
                rewarded: false,
            });
            let q_pkt = build_player_quest_log_delta_packet(&p.character);
            let _ = p.tx.send((SMSG_UPDATE_OBJECT, q_pkt));
            ws.db.update_character(p.character.clone());
        }
    }
    let status = compute_questgiver_status(ws, player_guid, npc_guid);
    ws.send_to_player(
        player_guid,
        SMSG_QUESTGIVER_STATUS,
        encode_questgiver_status(npc_guid, status),
    );
}

fn handle_choose_quest_reward(
    ws: &mut WorldState,
    player_guid: u64,
    npc_guid: u64,
    quest_id: u32,
    chosen_item_id: u32,
) {
    let Some(qtpl) = get_quest_template(quest_id) else {
        return;
    };
    if let Some(p) = ws.players.get_mut(&player_guid) {
        if let Some(prog) = p
            .character
            .quests
            .iter_mut()
            .find(|q| q.quest_id == quest_id)
        {
            prog.completed = true;
            prog.rewarded = true;
        }
        p.character.money += qtpl.reward_money;
        for &(item_id, count) in qtpl.reward_items {
            let slot = add_item_to_player_backpack(&mut p.character, item_id, count);
            let push = encode_item_push_result(player_guid, slot, item_id, count);
            let _ = p.tx.send((SMSG_ITEM_PUSH_RESULT, push));
        }
        if chosen_item_id != 0 {
            let slot = add_item_to_player_backpack(&mut p.character, chosen_item_id, 1);
            let push = encode_item_push_result(player_guid, slot, chosen_item_id, 1);
            let _ = p.tx.send((SMSG_ITEM_PUSH_RESULT, push));
        }
        let complete_pkt = encode_questgiver_quest_complete(qtpl, chosen_item_id);
        let _ = p.tx.send((SMSG_QUESTGIVER_QUEST_COMPLETE, complete_pkt));
        let xp_pkt = encode_log_xp_gain(0, qtpl.reward_xp, false);
        let _ = p.tx.send((SMSG_LOG_XPGAIN, xp_pkt));
        grant_player_xp(&mut p.character, &p.tx, qtpl.reward_xp);

        let q_pkt = build_player_quest_log_delta_packet(&p.character);
        let _ = p.tx.send((SMSG_UPDATE_OBJECT, q_pkt));
        let inv_pkt = build_player_inventory_update_packet(&p.character);
        let _ = p.tx.send((SMSG_UPDATE_OBJECT, inv_pkt));
        ws.db.update_character(p.character.clone());
    }
    let status = compute_questgiver_status(ws, player_guid, npc_guid);
    ws.send_to_player(
        player_guid,
        SMSG_QUESTGIVER_STATUS,
        encode_questgiver_status(npc_guid, status),
    );
}

fn add_item_to_player_backpack(ch: &mut CharacterRecord, item_entry: u32, count: u32) -> u8 {
    if let Some(existing) = ch
        .bag_items
        .iter_mut()
        .find(|&&mut (_, entry, _)| entry == item_entry)
    {
        existing.2 += count;
        return existing.0;
    }
    for slot in 0..16u8 {
        if !ch.bag_items.iter().any(|&(s, _, _)| s == slot) {
            ch.bag_items.push((slot, item_entry, count));
            return slot;
        }
    }
    0
}

fn teleport_player(ws: &mut WorldState, player_guid: u64, dest: TeleportLocation) {
    let Some(p) = ws.players.get_mut(&player_guid) else {
        return;
    };
    let old_map = p.character.map_id;
    p.character.map_id = dest.map_id;
    p.character.zone_id = dest.zone_id;
    p.character.x = dest.x;
    p.character.y = dest.y;
    p.character.z = dest.z;
    p.character.orientation = dest.orientation;
    ws.db.update_character(p.character.clone());

    if old_map != dest.map_id {
        let _ = p
            .tx
            .send((SMSG_TRANSFER_PENDING, dest.map_id.to_le_bytes().to_vec()));
        let _ = p.tx.send((
            SMSG_NEW_WORLD,
            encode_world_pos(dest.map_id, dest.x, dest.y, dest.z, dest.orientation),
        ));
    } else {
        let counter = p.teleport_counter;
        p.teleport_counter = p.teleport_counter.wrapping_add(1);
        let ack = encode_teleport_ack(
            player_guid,
            counter,
            dest.x,
            dest.y,
            dest.z,
            dest.orientation,
        );
        let _ = p.tx.send((MSG_MOVE_TELEPORT_ACK, ack));
    }
    let notice = format!("Crossed the Seam to {}.", dest.name);
    let _ = p.tx.send((SMSG_MESSAGECHAT, encode_system_chat(&notice)));
}

fn handle_gm_command(ws: &mut WorldState, player_guid: u64, cmd_line: &str) {
    let mut parts = cmd_line.trim().split_whitespace();
    let Some(verb) = parts.next() else {
        return;
    };
    let arg = parts.next().unwrap_or("");

    match verb.to_ascii_lowercase().as_str() {
        ".tele" | ".teleport" | ".go" => {
            if let Some(dest) = find_teleport_location(arg) {
                teleport_player(ws, player_guid, dest);
            } else {
                let msg = "Usage: .tele <porcelain | frostbell | glasswake | aureate | nocturnum | elsewhere>";
                ws.send_to_player(player_guid, SMSG_MESSAGECHAT, encode_system_chat(msg));
            }
        }
        ".level" | ".lvl" => {
            let target_lvl = arg.parse::<u8>().unwrap_or(10).clamp(1, 60);
            if let Some(p) = ws.players.get_mut(&player_guid) {
                p.character.level = target_lvl;
                p.character.max_health = 300 + u32::from(target_lvl) * 60;
                p.character.health = p.character.max_health;
                p.character.max_mana = 200 + u32::from(target_lvl) * 45;
                p.character.mana = p.character.max_mana;
                let lvl_pkt = encode_levelup_info(u32::from(target_lvl), 60, 45);
                let _ = p.tx.send((SMSG_LEVELUP_INFO, lvl_pkt));
                grant_player_xp(&mut p.character, &p.tx, 0);
                ws.db.update_character(p.character.clone());
                let msg = format!("Level set to {target_lvl}.");
                let _ = p.tx.send((SMSG_MESSAGECHAT, encode_system_chat(&msg)));
            }
        }
        ".speed" | ".spd" => {
            let mult = arg.parse::<f32>().unwrap_or(2.0).clamp(0.5, 10.0);
            if let Some(p) = ws.players.get_mut(&player_guid) {
                let counter = p.speed_counter;
                p.speed_counter = p.speed_counter.wrapping_add(1);
                let pkt = encode_force_run_speed_change(player_guid, counter, 7.0 * mult);
                let _ = p.tx.send((SMSG_FORCE_RUN_SPEED_CHANGE, pkt));
                let msg = format!("Run speed set to {mult:.1}x.");
                let _ = p.tx.send((SMSG_MESSAGECHAT, encode_system_chat(&msg)));
            }
        }
        ".heal" | ".revive" => {
            if let Some(p) = ws.players.get_mut(&player_guid) {
                p.character.health = p.character.max_health;
                p.character.mana = p.character.max_mana;
                let max_hp = p.character.max_health;
                let delta = build_unit_health_delta_packet(player_guid, max_hp, max_hp, 0);
                let _ = p.tx.send((SMSG_UPDATE_OBJECT, delta));
                let _ = p.tx.send((
                    SMSG_MESSAGECHAT,
                    encode_system_chat("Health and Mana fully restored."),
                ));
            }
        }
        ".spawn" => {
            let entry = arg.parse::<u32>().unwrap_or(2001);
            if let Some(tpl) = get_creature_template(entry) {
                if let Some(p) = ws.players.get(&player_guid).cloned() {
                    let spawn_id = (ws.creatures.len() + 1) as u32;
                    let guid = make_unit_guid(entry, spawn_id);
                    let inst = CreatureInstance {
                        spawn_id,
                        guid,
                        entry,
                        map_id: p.character.map_id,
                        home_x: p.character.x + 3.0,
                        home_y: p.character.y + 3.0,
                        home_z: p.character.z,
                        home_o: p.character.orientation,
                        x: p.character.x + 3.0,
                        y: p.character.y + 3.0,
                        z: p.character.z,
                        orientation: p.character.orientation,
                        health: tpl.max_health,
                        max_health: tpl.max_health,
                        target_guid: 0,
                        last_attack_tick: 0,
                        last_patrol_tick: 0,
                        respawn_at_tick: None,
                        loot_money: 0,
                        loot_items: Vec::new(),
                        tapped_by: 0,
                    };
                    let pkt = build_single_creature_create_packet(&inst);
                    ws.creatures.push(inst);
                    ws.broadcast_map(p.character.map_id, SMSG_UPDATE_OBJECT, &pkt, None);
                    let msg = format!("Spawned '{}' (entry={entry}).", tpl.name);
                    ws.send_to_player(player_guid, SMSG_MESSAGECHAT, encode_system_chat(&msg));
                }
            }
        }
        _ => {
            let help = "Celandia Commands: .tele <porcelain|frostbell|glasswake|aureate|nocturnum|elsewhere> | .level <1..60> | .speed <0.5..10> | .heal | .spawn <entry>";
            ws.send_to_player(player_guid, SMSG_MESSAGECHAT, encode_system_chat(help));
        }
    }
}

// ============================================================================
// 4. Wire Packet Builders for Login, Roster, Queries & UpdateObject
// ============================================================================

fn read_cstring_slice(data: &[u8]) -> String {
    let end = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    String::from_utf8_lossy(&data[..end]).into_owned()
}

#[allow(clippy::type_complexity)]
fn parse_char_create(
    payload: &[u8],
) -> Option<(String, u8, u8, u8, u8, u8, u8, u8, u8, u8)> {
    let nul = payload.iter().position(|&b| b == 0)?;
    let name = String::from_utf8_lossy(&payload[..nul]).into_owned();
    let r = &payload[nul + 1..];
    if r.len() < 9 {
        return None;
    }
    Some((name, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]))
}

pub fn encode_char_enum(chars: &[CharacterRecord]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + chars.len() * 180);
    buf.push(chars.len() as u8);
    for ch in chars {
        buf.extend_from_slice(&ch.guid().to_le_bytes());
        buf.extend_from_slice(ch.name.as_bytes());
        buf.push(0);
        buf.push(ch.race);
        buf.push(ch.class);
        buf.push(ch.gender);
        buf.push(ch.skin);
        buf.push(ch.face);
        buf.push(ch.hair_style);
        buf.push(ch.hair_color);
        buf.push(ch.facial_hair);
        buf.push(ch.level);
        buf.extend_from_slice(&ch.zone_id.to_le_bytes());
        buf.extend_from_slice(&ch.map_id.to_le_bytes());
        buf.extend_from_slice(&ch.x.to_le_bytes());
        buf.extend_from_slice(&ch.y.to_le_bytes());
        buf.extend_from_slice(&ch.z.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // guild_id = 0
        buf.extend_from_slice(&0u32.to_le_bytes()); // char_flags = 0
        buf.push(0); // first_login = 0
        buf.extend_from_slice(&0u32.to_le_bytes()); // pet_display_id = 0
        buf.extend_from_slice(&0u32.to_le_bytes()); // pet_level = 0
        buf.extend_from_slice(&0u32.to_le_bytes()); // pet_family = 0

        // 19 equipment slots: (display_id: u32, inv_type: u8)
        for slot in 0..19u8 {
            if let Some(&(_, item_entry)) = ch.equipment.iter().find(|&&(s, _)| s == slot) {
                let tpl = get_item_template(item_entry);
                let disp = tpl.map_or(item_entry, |t| t.display_id);
                let inv_type = tpl.map_or(21u8, |t| t.inventory_type as u8);
                buf.extend_from_slice(&disp.to_le_bytes());
                buf.push(inv_type);
            } else {
                buf.extend_from_slice(&0u32.to_le_bytes());
                buf.push(0);
            }
        }
        // first bag slot: (display_id: u32, inv_type: u8)
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.push(0);
    }
    buf
}

fn encode_world_pos(map_id: u32, x: f32, y: f32, z: f32, o: f32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(20);
    buf.extend_from_slice(&map_id.to_le_bytes());
    buf.extend_from_slice(&x.to_le_bytes());
    buf.extend_from_slice(&y.to_le_bytes());
    buf.extend_from_slice(&z.to_le_bytes());
    buf.extend_from_slice(&o.to_le_bytes());
    buf
}

fn encode_bindpoint(x: f32, y: f32, z: f32, map_id: u32, area_id: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(20);
    buf.extend_from_slice(&x.to_le_bytes());
    buf.extend_from_slice(&y.to_le_bytes());
    buf.extend_from_slice(&z.to_le_bytes());
    buf.extend_from_slice(&map_id.to_le_bytes());
    buf.extend_from_slice(&area_id.to_le_bytes());
    buf
}

fn encode_initialize_factions() -> Vec<u8> {
    let mut buf = Vec::with_capacity(4 + 64 * 5);
    buf.extend_from_slice(&64u32.to_le_bytes());
    for _ in 0..64 {
        buf.push(0x01); // visible
        buf.extend_from_slice(&3000i32.to_le_bytes()); // friendly standing
    }
    buf
}

fn encode_initial_spells(spells: &[u16]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5 + spells.len() * 4);
    buf.push(0); // unk = 0
    buf.extend_from_slice(&(spells.len() as u16).to_le_bytes());
    for (idx, &sp) in spells.iter().enumerate() {
        buf.extend_from_slice(&sp.to_le_bytes());
        buf.extend_from_slice(&((idx + 1) as u16).to_le_bytes());
    }
    buf.extend_from_slice(&0u16.to_le_bytes()); // 0 cooldowns
    buf
}

fn encode_action_buttons(buttons: &[(u8, u32)]) -> Vec<u8> {
    let mut slots = [0u32; 120];
    for &(slot, val) in buttons {
        if usize::from(slot) < slots.len() {
            slots[usize::from(slot)] = val;
        }
    }
    let mut buf = Vec::with_capacity(480);
    for &w in &slots {
        buf.extend_from_slice(&w.to_le_bytes());
    }
    buf
}

fn encode_login_settimespeed() -> Vec<u8> {
    let mut buf = Vec::with_capacity(8);
    // 12:00 noon packed game time
    let datetime: u32 = (12 << 6) | (1 << 14) | (1 << 20) | (6 << 24);
    buf.extend_from_slice(&datetime.to_le_bytes());
    buf.extend_from_slice(&0.016_666_668f32.to_le_bytes());
    buf
}

fn encode_init_world_states(map_id: u32, area_id: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(10);
    buf.extend_from_slice(&map_id.to_le_bytes());
    buf.extend_from_slice(&area_id.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes()); // 0 world state pairs
    buf
}

fn encode_name_query_response(ch: &CharacterRecord) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 + ch.name.len());
    buf.extend_from_slice(&ch.guid().to_le_bytes());
    buf.extend_from_slice(ch.name.as_bytes());
    buf.push(0);
    buf.push(0); // realm name = ""
    buf.extend_from_slice(&u32::from(ch.race).to_le_bytes());
    buf.extend_from_slice(&u32::from(ch.gender).to_le_bytes());
    buf.extend_from_slice(&u32::from(ch.class).to_le_bytes());
    buf
}

pub fn encode_creature_query_response(entry: u32) -> Vec<u8> {
    let Some(tpl) = get_creature_template(entry) else {
        return (entry | 0x8000_0000).to_le_bytes().to_vec();
    };
    let mut buf = Vec::with_capacity(128);
    buf.extend_from_slice(&tpl.entry.to_le_bytes());
    buf.extend_from_slice(tpl.name.as_bytes());
    buf.push(0);
    buf.extend_from_slice(&[0, 0, 0]); // name2..name4
    buf.extend_from_slice(tpl.subname.as_bytes());
    buf.push(0);
    buf.extend_from_slice(&0u32.to_le_bytes()); // type_flags
    buf.extend_from_slice(&tpl.creature_type.to_le_bytes());
    buf.extend_from_slice(&tpl.family.to_le_bytes());
    buf.extend_from_slice(&tpl.rank.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // unk
    buf.extend_from_slice(&0u32.to_le_bytes()); // pet_spell_list_id
    buf.extend_from_slice(&tpl.display_id.to_le_bytes());
    buf.push(u8::from(tpl.faction == FACTION_FRIENDLY)); // civilian
    buf.push(u8::from(tpl.rank >= 1 && tpl.faction == FACTION_FRIENDLY)); // racial_leader
    buf
}

fn encode_system_chat(text: &str) -> Vec<u8> {
    encode_player_chat(0x0A, 0, 0, "", text) // 0x0A = CHAT_MSG_SYSTEM
}

fn encode_player_chat(
    msg_type: u8,
    lang: u32,
    sender_guid: u64,
    _sender_name: &str,
    text: &str,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 + text.len());
    buf.push(msg_type);
    buf.extend_from_slice(&lang.to_le_bytes());
    buf.extend_from_slice(&sender_guid.to_le_bytes()); // sender
    buf.extend_from_slice(&(text.len() as u32 + 1).to_le_bytes());
    buf.extend_from_slice(text.as_bytes());
    buf.push(0);
    buf.push(0); // chat_tag = 0
    buf
}

fn encode_force_run_speed_change(guid: u64, counter: u32, new_speed: f32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(18);
    write_packed_guid(&mut buf, guid);
    buf.extend_from_slice(&counter.to_le_bytes());
    buf.extend_from_slice(&new_speed.to_le_bytes());
    buf
}

fn encode_teleport_ack(guid: u64, counter: u32, x: f32, y: f32, z: f32, o: f32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(42);
    write_packed_guid(&mut buf, guid);
    buf.extend_from_slice(&counter.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // move_flags
    buf.extend_from_slice(&0u32.to_le_bytes()); // time
    buf.extend_from_slice(&x.to_le_bytes());
    buf.extend_from_slice(&y.to_le_bytes());
    buf.extend_from_slice(&z.to_le_bytes());
    buf.extend_from_slice(&o.to_le_bytes());
    buf.extend_from_slice(&0.0f32.to_le_bytes()); // fall_time
    buf
}

// ============================================================================
// 5. SMSG_UPDATE_OBJECT Block Builders (Player, Items, Creatures, Deltas)
// ============================================================================

fn write_living_movement_block(
    buf: &mut Vec<u8>,
    is_self: bool,
    x: f32,
    y: f32,
    z: f32,
    o: f32,
    run_speed: f32,
) {
    let mut uflags = UPDATEFLAG_LIVING | UPDATEFLAG_ALL;
    if is_self {
        uflags |= UPDATEFLAG_SELF;
    }
    buf.push(uflags);
    buf.extend_from_slice(&0u32.to_le_bytes()); // move_flags = 0
    buf.extend_from_slice(&0u32.to_le_bytes()); // timestamp = 0
    buf.extend_from_slice(&x.to_le_bytes());
    buf.extend_from_slice(&y.to_le_bytes());
    buf.extend_from_slice(&z.to_le_bytes());
    buf.extend_from_slice(&o.to_le_bytes());
    buf.extend_from_slice(&0.0f32.to_le_bytes()); // fall_time = 0.0

    // 6 speeds: walk, run, run_back, swim, swim_back, turn_rate
    for &spd in &[
        2.5f32,
        run_speed,
        4.5f32,
        4.722_222f32,
        2.5f32,
        std::f32::consts::PI,
    ] {
        buf.extend_from_slice(&spd.to_le_bytes());
    }
    // UPDATEFLAG_ALL trailing u32(1)
    buf.extend_from_slice(&1u32.to_le_bytes());
}

fn write_item_create_block(
    buf: &mut Vec<u8>,
    item_guid: u64,
    owner_guid: u64,
    item_entry: u32,
    stack_count: u32,
) {
    buf.push(UPDATETYPE_CREATE_OBJECT);
    write_packed_guid(buf, item_guid);
    buf.push(TYPEID_ITEM);
    buf.push(UPDATEFLAG_ALL);
    buf.extend_from_slice(&1u32.to_le_bytes());

    let mut fb = UpdateFieldBuilder::new();
    fb.set_guid(OBJECT_FIELD_GUID, item_guid);
    fb.set_u32(OBJECT_FIELD_TYPE, TYPEMASK_OBJECT | TYPEMASK_ITEM);
    fb.set_u32(OBJECT_FIELD_ENTRY, item_entry);
    fb.set_f32(OBJECT_FIELD_SCALE_X, 1.0);
    fb.set_guid(ITEM_FIELD_OWNER, owner_guid);
    fb.set_guid(ITEM_FIELD_CONTAINED, owner_guid);
    fb.set_u32(ITEM_FIELD_STACK_COUNT, stack_count.max(1));
    fb.set_u32(ITEM_FIELD_DURABILITY, 75);
    fb.set_u32(ITEM_FIELD_MAXDURABILITY, 75);
    fb.write_into(buf);
}

fn write_player_create_block(buf: &mut Vec<u8>, ch: &CharacterRecord, is_self: bool) {
    buf.push(if is_self {
        UPDATETYPE_CREATE_OBJECT2
    } else {
        UPDATETYPE_CREATE_OBJECT
    });
    write_packed_guid(buf, ch.guid());
    buf.push(TYPEID_PLAYER);
    write_living_movement_block(buf, is_self, ch.x, ch.y, ch.z, ch.orientation, 7.0);

    let mut fb = UpdateFieldBuilder::new();
    fb.set_guid(OBJECT_FIELD_GUID, ch.guid());
    fb.set_u32(
        OBJECT_FIELD_TYPE,
        TYPEMASK_OBJECT | TYPEMASK_UNIT | TYPEMASK_PLAYER,
    );
    fb.set_f32(OBJECT_FIELD_SCALE_X, 1.0);

    fb.set_u32(UNIT_FIELD_HEALTH, ch.health);
    fb.set_u32(UNIT_FIELD_POWER1, ch.mana);
    fb.set_u32(UNIT_FIELD_POWER2, 1000);
    fb.set_u32(UNIT_FIELD_POWER4, 100);
    fb.set_u32(UNIT_FIELD_MAXHEALTH, ch.max_health);
    fb.set_u32(UNIT_FIELD_MAXPOWER1, ch.max_mana);
    fb.set_u32(UNIT_FIELD_MAXPOWER2, 1000);
    fb.set_u32(UNIT_FIELD_MAXPOWER4, 100);
    fb.set_u32(UNIT_FIELD_LEVEL, u32::from(ch.level));
    fb.set_u32(UNIT_FIELD_FACTIONTEMPLATE, u32::from(ch.race.clamp(1, 8)));

    let bytes_0 = u32::from(ch.race)
        | (u32::from(ch.class) << 8)
        | (u32::from(ch.gender) << 16);
    fb.set_u32(UNIT_FIELD_BYTES_0, bytes_0);
    fb.set_u32(UNIT_FIELD_BASEATTACKTIME, 1800);
    fb.set_u32(UNIT_FIELD_BASEATTACKTIME + 1, 1800);
    fb.set_u32(UNIT_FIELD_RANGEDATTACKTIME, 2000);
    fb.set_f32(UNIT_FIELD_BOUNDINGRADIUS, 0.388);
    fb.set_f32(UNIT_FIELD_COMBATREACH, 1.5);
    fb.set_u32(UNIT_FIELD_DISPLAYID, ch.display_id);
    fb.set_u32(UNIT_FIELD_NATIVEDISPLAYID, ch.display_id);
    fb.set_f32(UNIT_FIELD_MINDAMAGE, 22.0);
    fb.set_f32(UNIT_FIELD_MAXDAMAGE, 36.0);
    fb.set_u32(UNIT_FIELD_BYTES_1, u32::from(ch.stand_state));
    fb.set_f32(UNIT_MOD_CAST_SPEED, 1.0);
    for i in 0..5u16 {
        fb.set_u32(UNIT_FIELD_STAT0 + i, 25 + u32::from(ch.level) * 2);
    }
    fb.set_u32(UNIT_FIELD_RESISTANCES, 350);
    fb.set_u32(UNIT_FIELD_BASE_MANA, ch.max_mana);
    fb.set_u32(UNIT_FIELD_BASE_HEALTH, ch.max_health);
    fb.set_u32(UNIT_FIELD_BYTES_2, u32::from(ch.sheath_state));
    fb.set_u32(UNIT_FIELD_ATTACK_POWER, 60 + u32::from(ch.level) * 4);

    fb.set_u32(PLAYER_FLAGS, ch.player_flags);
    let player_bytes = u32::from(ch.skin)
        | (u32::from(ch.face) << 8)
        | (u32::from(ch.hair_style) << 16)
        | (u32::from(ch.hair_color) << 24);
    fb.set_u32(PLAYER_BYTES, player_bytes);
    let player_bytes_2 = u32::from(ch.facial_hair) | (2u32 << 24);
    fb.set_u32(PLAYER_BYTES_2, player_bytes_2);
    fb.set_u32(PLAYER_BYTES_3, u32::from(ch.gender));

    // Visible equipment for all viewers + private inventory slots for self
    for &(slot, item_entry) in &ch.equipment {
        if slot < 19 {
            fb.set_u32(
                PLAYER_VISIBLE_ITEM_1_CREATOR + 2 + 12 * u16::from(slot),
                item_entry,
            );
            if is_self {
                let item_guid = make_item_guid(ch.guid_low * 100 + u32::from(slot) + 1);
                fb.set_guid(PLAYER_FIELD_INV_SLOT_HEAD + 2 * u16::from(slot), item_guid);
            }
        }
    }
    if is_self {
        for &(pack_slot, _entry, _count) in &ch.bag_items {
            if pack_slot < 16 {
                let item_guid = make_item_guid(ch.guid_low * 100 + 30 + u32::from(pack_slot));
                fb.set_guid(
                    PLAYER_FIELD_PACK_SLOT_1 + 2 * u16::from(pack_slot),
                    item_guid,
                );
            }
        }
        fb.set_u32(PLAYER_XP, ch.xp);
        fb.set_u32(PLAYER_NEXT_LEVEL_XP, ch.next_level_xp);
        fb.set_u32(PLAYER_CHARACTER_POINTS1, 2);
        fb.set_u32(PLAYER_CHARACTER_POINTS2, 2);
        fb.set_f32(PLAYER_BLOCK_PERCENTAGE, 5.0);
        fb.set_f32(PLAYER_DODGE_PERCENTAGE, 5.0);
        fb.set_f32(PLAYER_PARRY_PERCENTAGE, 5.0);
        fb.set_f32(PLAYER_CRIT_PERCENTAGE, 15.0);
        fb.set_u32(PLAYER_REST_STATE_EXPERIENCE, 500);
        fb.set_u32(PLAYER_FIELD_COINAGE, ch.money);
        for school in 0..7u16 {
            fb.set_f32(PLAYER_FIELD_MOD_DAMAGE_DONE_PCT + school, 1.0);
        }
        fb.set_i32(PLAYER_FIELD_WATCHED_FACTION_INDEX, -1);
        write_quest_log_fields(&mut fb, ch);
    }

    fb.write_into(buf);
}

fn write_quest_log_fields(fb: &mut UpdateFieldBuilder, ch: &CharacterRecord) {
    let active_quests: Vec<&QuestProgress> = ch.quests.iter().filter(|q| !q.rewarded).collect();
    for slot in 0..20u16 {
        let base = PLAYER_QUEST_LOG_1_1 + slot * 3;
        if let Some(q) = active_quests.get(usize::from(slot)) {
            let count_state = u32::from(q.counts[0] & 0x3F)
                | (u32::from(q.counts[1] & 0x3F) << 6)
                | (u32::from(q.counts[2] & 0x3F) << 12)
                | (u32::from(q.counts[3] & 0x3F) << 18)
                | ((if q.completed { 1u32 } else { 0u32 }) << 24);
            fb.set_u32(base, q.quest_id);
            fb.set_u32(base + 1, count_state);
            fb.set_u32(base + 2, 0);
        } else {
            fb.set_u32(base, 0);
            fb.set_u32(base + 1, 0);
            fb.set_u32(base + 2, 0);
        }
    }
}

fn write_creature_create_block(buf: &mut Vec<u8>, c: &CreatureInstance) {
    let tpl = c.template();
    buf.push(UPDATETYPE_CREATE_OBJECT);
    write_packed_guid(buf, c.guid);
    buf.push(TYPEID_UNIT);
    write_living_movement_block(buf, false, c.x, c.y, c.z, c.orientation, 6.0);

    let mut fb = UpdateFieldBuilder::new();
    fb.set_guid(OBJECT_FIELD_GUID, c.guid);
    fb.set_u32(OBJECT_FIELD_TYPE, TYPEMASK_OBJECT | TYPEMASK_UNIT);
    fb.set_u32(OBJECT_FIELD_ENTRY, c.entry);
    fb.set_f32(OBJECT_FIELD_SCALE_X, tpl.scale);
    if c.target_guid != 0 {
        fb.set_guid(UNIT_FIELD_TARGET, c.target_guid);
    }
    fb.set_u32(UNIT_FIELD_HEALTH, c.health);
    fb.set_u32(UNIT_FIELD_MAXHEALTH, c.max_health);
    if tpl.max_mana > 0 {
        fb.set_u32(UNIT_FIELD_POWER1, tpl.max_mana);
        fb.set_u32(UNIT_FIELD_MAXPOWER1, tpl.max_mana);
    }
    fb.set_u32(UNIT_FIELD_LEVEL, tpl.level);
    fb.set_u32(UNIT_FIELD_FACTIONTEMPLATE, tpl.faction);
    fb.set_u32(UNIT_FIELD_BYTES_0, 1 | (1 << 8));

    if tpl.weapon_display != 0 {
        fb.set_u32(UNIT_VIRTUAL_ITEM_SLOT_DISPLAY, tpl.weapon_display);
        fb.set_u32(
            UNIT_VIRTUAL_ITEM_INFO,
            2 | (7 << 8) | (1 << 16) | (21 << 24),
        );
        fb.set_u32(UNIT_VIRTUAL_ITEM_INFO + 1, 1);
    }

    fb.set_u32(UNIT_FIELD_BASEATTACKTIME, tpl.attack_time_ms);
    fb.set_u32(UNIT_FIELD_BASEATTACKTIME + 1, tpl.attack_time_ms);
    fb.set_f32(UNIT_FIELD_BOUNDINGRADIUS, 0.55 * tpl.scale);
    fb.set_f32(UNIT_FIELD_COMBATREACH, 1.75 * tpl.scale);
    fb.set_u32(UNIT_FIELD_DISPLAYID, tpl.display_id);
    fb.set_u32(UNIT_FIELD_NATIVEDISPLAYID, tpl.display_id);
    fb.set_f32(UNIT_FIELD_MINDAMAGE, tpl.min_dmg);
    fb.set_f32(UNIT_FIELD_MAXDAMAGE, tpl.max_dmg);
    fb.set_f32(UNIT_MOD_CAST_SPEED, 1.0);
    if !c.is_alive() {
        fb.set_u32(UNIT_DYNAMIC_FLAGS, UNIT_DYNFLAG_DEAD | UNIT_DYNFLAG_LOOTABLE);
    }
    if tpl.npc_flags != 0 {
        fb.set_u32(UNIT_NPC_FLAGS, tpl.npc_flags);
    }
    fb.set_u32(UNIT_FIELD_BYTES_2, 1);
    fb.write_into(buf);
}

pub fn build_login_update_object_packet(ws: &WorldState, self_guid: u64) -> Vec<u8> {
    let Some(self_player) = ws.players.get(&self_guid) else {
        return vec![0, 0, 0, 0, 0];
    };
    let ch = &self_player.character;
    let map_id = ch.map_id;

    let other_players: Vec<&CharacterRecord> = ws
        .players
        .iter()
        .filter(|(&g, p)| g != self_guid && p.character.map_id == map_id)
        .map(|(_, p)| &p.character)
        .collect();

    let map_creatures: Vec<&CreatureInstance> = ws
        .creatures
        .iter()
        .filter(|c| c.map_id == map_id && c.respawn_at_tick.is_none())
        .collect();

    let total_blocks = 1
        + ch.equipment.len()
        + ch.bag_items.len()
        + other_players.len()
        + map_creatures.len();

    let mut buf = Vec::with_capacity(1024 + total_blocks * 128);
    buf.extend_from_slice(&(total_blocks as u32).to_le_bytes());
    buf.push(0); // has_transport = 0

    // 1. Self player
    write_player_create_block(&mut buf, ch, true);

    // 2. Equipped items
    for &(slot, item_entry) in &ch.equipment {
        let item_guid = make_item_guid(ch.guid_low * 100 + u32::from(slot) + 1);
        write_item_create_block(&mut buf, item_guid, self_guid, item_entry, 1);
    }

    // 3. Backpack items
    for &(pack_slot, item_entry, count) in &ch.bag_items {
        let item_guid = make_item_guid(ch.guid_low * 100 + 30 + u32::from(pack_slot));
        write_item_create_block(&mut buf, item_guid, self_guid, item_entry, count);
    }

    // 4. Other online players on this map
    for other in other_players {
        write_player_create_block(&mut buf, other, false);
    }

    // 5. All live creatures on this map
    for c in map_creatures {
        write_creature_create_block(&mut buf, c);
    }

    buf
}

fn build_single_player_create_packet(ch: &CharacterRecord, is_self: bool) -> Vec<u8> {
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(&1u32.to_le_bytes());
    buf.push(0);
    write_player_create_block(&mut buf, ch, is_self);
    buf
}

fn build_single_creature_create_packet(c: &CreatureInstance) -> Vec<u8> {
    let mut buf = Vec::with_capacity(192);
    buf.extend_from_slice(&1u32.to_le_bytes());
    buf.push(0);
    write_creature_create_block(&mut buf, c);
    buf
}

fn build_values_update_packet(guid: u64, fb: &UpdateFieldBuilder) -> Vec<u8> {
    let mut buf = Vec::with_capacity(96);
    buf.extend_from_slice(&1u32.to_le_bytes());
    buf.push(0); // has_transport = 0
    buf.push(UPDATETYPE_VALUES);
    write_packed_guid(&mut buf, guid);
    fb.write_into(&mut buf);
    buf
}

fn build_unit_health_delta_packet(
    guid: u64,
    health: u32,
    max_health: u32,
    dyn_flags: u32,
) -> Vec<u8> {
    let mut fb = UpdateFieldBuilder::new();
    fb.set_u32(UNIT_FIELD_HEALTH, health);
    fb.set_u32(UNIT_FIELD_MAXHEALTH, max_health);
    fb.set_u32(UNIT_DYNAMIC_FLAGS, dyn_flags);
    build_values_update_packet(guid, &fb)
}

fn build_player_quest_log_delta_packet(ch: &CharacterRecord) -> Vec<u8> {
    let mut fb = UpdateFieldBuilder::new();
    write_quest_log_fields(&mut fb, ch);
    build_values_update_packet(ch.guid(), &fb)
}

fn build_player_inventory_update_packet(ch: &CharacterRecord) -> Vec<u8> {
    let total_blocks = 1 + ch.bag_items.len();
    let mut buf = Vec::with_capacity(128 + ch.bag_items.len() * 64);
    buf.extend_from_slice(&(total_blocks as u32).to_le_bytes());
    buf.push(0);

    // Block 0: Player pack slots + coinage delta
    buf.push(UPDATETYPE_VALUES);
    write_packed_guid(&mut buf, ch.guid());
    let mut fb = UpdateFieldBuilder::new();
    fb.set_u32(PLAYER_FIELD_COINAGE, ch.money);
    for slot in 0..16u8 {
        if let Some(&(_, _entry, _count)) = ch.bag_items.iter().find(|&&(s, _, _)| s == slot) {
            let item_guid = make_item_guid(ch.guid_low * 100 + 30 + u32::from(slot));
            fb.set_guid(PLAYER_FIELD_PACK_SLOT_1 + 2 * u16::from(slot), item_guid);
        } else {
            fb.set_guid(PLAYER_FIELD_PACK_SLOT_1 + 2 * u16::from(slot), 0);
        }
    }
    fb.write_into(&mut buf);

    // Subsequent blocks: Item create blocks for backpack items
    for &(pack_slot, item_entry, count) in &ch.bag_items {
        let item_guid = make_item_guid(ch.guid_low * 100 + 30 + u32::from(pack_slot));
        write_item_create_block(&mut buf, item_guid, ch.guid(), item_entry, count);
    }
    buf
}
