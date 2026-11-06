//! Multiplayer Co-Op for Survivors Mode (`warcraft-survivors`): real-time 2–8 player shared runs
//! over both direct non-blocking UDP (`0.0.0.0:8091` / `127.0.0.1:8091` / `WOW_COOP_ADDR`) and
//! `wenilla-host` WebSocket rooms (`/ws/survivors/{room}`).
//!
//! Peers exchange a compact binary wire protocol ([`CoopPacket`]):
//! - [`CoopPacket::Hello`]: lobby presence, chosen class, race, sex, map, and display name.
//! - [`CoopPacket::StartRun`]: synchronizes the battleground map index and deterministic [`Rng`]
//!   seed so enemy waves and boss spawns match across all party members.
//! - [`CoopPacket::HeroState`]: 20 Hz transform, movement, health, level, animation, and downed
//!   state replication.
//! - [`CoopPacket::CastVisual`]: replicates every co-op ally's ability casts, missiles, novae,
//!   ground effects, and rank-scaled damage against local enemies.
//! - [`CoopPacket::SharedXp`]: shares collected XP crystal gems with the entire party.
//! - [`CoopPacket::Revive`]: revives a downed ally at 50% HP after standing within 4 yards for
//!   2.5 seconds.

use std::collections::HashMap;
#[cfg(not(target_arch = "wasm32"))]
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};

use benilla_world::world_point::WorldPoint;
use bevy::prelude::*;
use crossbeam_channel::{Receiver, Sender};

use super::abilities::{self, Hit, PendingHits};
use super::data::{self, ClassDef};
use super::enemies::Enemy;
use super::hero::{self, Hero};
use super::hud;
use super::units::{self, flat, wow_to_bevy, Fx, Marks, UnitSpec, COLOR_HEAL};
use super::{Phase, Rng, Run, Selection};
use crate::creature_anim::{move_flags, MovementState};
use crate::net::{FieldChanged, Guid, ObjectStore};

/// Default UDP port for desktop / LAN / VPS Co-Op hosting and joining.
pub(crate) const DEFAULT_COOP_PORT: u16 = 8091;
/// Maximum players in a Co-Op party (host + up to 7 allies).
pub(crate) const MAX_PARTY_SIZE: usize = 8;
/// Broadcast rate for [`CoopPacket::HeroState`] (20 Hz = every 50 ms).
pub(crate) const HERO_SYNC_INTERVAL: f32 = 0.05;
/// Broadcast rate for [`CoopPacket::Hello`] heartbeats (1 Hz).
pub(crate) const HELLO_INTERVAL: f32 = 1.0;
/// Seconds without any packet before a remote peer is considered disconnected.
pub(crate) const PEER_TIMEOUT_SECS: f32 = 12.0;

/// Distance in yards within which a living player revives a downed ally.
pub(crate) const REVIVE_RADIUS: f32 = 4.0;
/// Seconds a living player must stand near a downed ally to complete a revive.
pub(crate) const REVIVE_DURATION: f32 = 2.5;
/// Fraction of maximum HP restored upon revival.
pub(crate) const REVIVE_HP_FRACTION: f32 = 0.5;

/// Wire magic bytes (`"CXCP"`).
pub(crate) const PACKET_MAGIC: [u8; 4] = *b"CXCP";
/// Wire protocol version.
pub(crate) const PACKET_VERSION: u8 = 1;

const TAG_HELLO: u8 = 1;
const TAG_START_RUN: u8 = 2;
const TAG_HERO_STATE: u8 = 3;
const TAG_CAST_VISUAL: u8 = 4;
const TAG_SHARED_XP: u8 = 5;
const TAG_REVIVE: u8 = 6;

/// `AnimationData.dbc` animation IDs replicated in [`CoopPacket::HeroState::anim`].
pub(crate) const ANIM_STAND: u16 = 0;
pub(crate) const ANIM_DEATH: u16 = 1;
pub(crate) const ANIM_RUN: u16 = 5;
pub(crate) const ANIM_ATTACK_UNARMED: u16 = 16;
pub(crate) const ANIM_SPELL_CAST_DIRECTED: u16 = 53;

impl ClassDef {
    /// Resolve the hero `CreatureDisplayInfo` ID for `(race, sex)` from this class's trainer looks.
    pub fn hero_display(&self, race: u8, sex: u8) -> u32 {
        if self.looks.is_empty() {
            return 100;
        }
        let r = race.clamp(1, 8).saturating_sub(1) as usize;
        let s = (sex & 1) as usize;
        let idx = (r * 2 + s).min(self.looks.len() - 1);
        self.looks[idx]
    }

    /// Primary starting weapon `ItemDisplayInfo` ID for this class.
    pub fn weapon_display(&self) -> u32 {
        self.weapons.first().map_or(0, |w| w.1)
    }
}

/// Active Co-Op networking mode selectable from the Survivors Menu (`C` or click).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum CoopMode {
    #[default]
    Solo,
    Host,
    Join,
}

impl CoopMode {
    pub fn next(self) -> Self {
        match self {
            Self::Solo => Self::Host,
            Self::Host => Self::Join,
            Self::Join => Self::Solo,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Solo => "SOLO",
            Self::Host => "HOST CO-OP :8091",
            Self::Join => "JOIN CO-OP",
        }
    }
}

/// Compact deterministic wire packet exchanged between Survivors Co-Op peers over UDP or WebSocket.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CoopPacket {
    Hello {
        peer_id: u32,
        class_id: u8,
        race: u8,
        sex: u8,
        map_idx: u8,
        name: String,
    },
    StartRun {
        map_idx: u8,
        seed: u64,
        host_time: f32,
    },
    HeroState {
        peer_id: u32,
        class_id: u8,
        race: u8,
        sex: u8,
        pos: [f32; 3],
        yaw: f32,
        moving: bool,
        hp: f32,
        max_hp: f32,
        level: u32,
        anim: u16,
        downed: bool,
    },
    CastVisual {
        peer_id: u32,
        ability_idx: u8,
        origin: [f32; 3],
        target: [f32; 3],
        rank: u8,
    },
    SharedXp {
        peer_id: u32,
        amount: f32,
    },
    Revive {
        target_peer_id: u32,
        reviver_peer_id: u32,
    },
}

impl CoopPacket {
    pub fn peer_id(&self) -> Option<u32> {
        match *self {
            Self::Hello { peer_id, .. }
            | Self::HeroState { peer_id, .. }
            | Self::CastVisual { peer_id, .. }
            | Self::SharedXp { peer_id, .. } => Some(peer_id),
            Self::Revive {
                reviver_peer_id, ..
            } => Some(reviver_peer_id),
            Self::StartRun { .. } => None,
        }
    }

    /// Serialize into a compact little-endian binary frame.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64);
        out.extend_from_slice(&PACKET_MAGIC);
        out.push(PACKET_VERSION);
        match self {
            Self::Hello {
                peer_id,
                class_id,
                race,
                sex,
                map_idx,
                name,
            } => {
                out.push(TAG_HELLO);
                out.extend_from_slice(&peer_id.to_le_bytes());
                out.push(*class_id);
                out.push(*race);
                out.push(*sex);
                out.push(*map_idx);
                let name_bytes = name.as_bytes();
                let len = name_bytes.len().min(32);
                out.push(len as u8);
                out.extend_from_slice(&name_bytes[..len]);
            }
            Self::StartRun {
                map_idx,
                seed,
                host_time,
            } => {
                out.push(TAG_START_RUN);
                out.push(*map_idx);
                out.extend_from_slice(&seed.to_le_bytes());
                out.extend_from_slice(&host_time.to_le_bytes());
            }
            Self::HeroState {
                peer_id,
                class_id,
                race,
                sex,
                pos,
                yaw,
                moving,
                hp,
                max_hp,
                level,
                anim,
                downed,
            } => {
                out.push(TAG_HERO_STATE);
                out.extend_from_slice(&peer_id.to_le_bytes());
                out.push(*class_id);
                out.push(*race);
                out.push(*sex);
                for c in pos {
                    out.extend_from_slice(&c.to_le_bytes());
                }
                out.extend_from_slice(&yaw.to_le_bytes());
                out.push(u8::from(*moving));
                out.extend_from_slice(&hp.to_le_bytes());
                out.extend_from_slice(&max_hp.to_le_bytes());
                out.extend_from_slice(&level.to_le_bytes());
                out.extend_from_slice(&anim.to_le_bytes());
                out.push(u8::from(*downed));
            }
            Self::CastVisual {
                peer_id,
                ability_idx,
                origin,
                target,
                rank,
            } => {
                out.push(TAG_CAST_VISUAL);
                out.extend_from_slice(&peer_id.to_le_bytes());
                out.push(*ability_idx);
                for c in origin {
                    out.extend_from_slice(&c.to_le_bytes());
                }
                for c in target {
                    out.extend_from_slice(&c.to_le_bytes());
                }
                out.push(*rank);
            }
            Self::SharedXp { peer_id, amount } => {
                out.push(TAG_SHARED_XP);
                out.extend_from_slice(&peer_id.to_le_bytes());
                out.extend_from_slice(&amount.to_le_bytes());
            }
            Self::Revive {
                target_peer_id,
                reviver_peer_id,
            } => {
                out.push(TAG_REVIVE);
                out.extend_from_slice(&target_peer_id.to_le_bytes());
                out.extend_from_slice(&reviver_peer_id.to_le_bytes());
            }
        }
        out
    }

    /// Decode a binary frame back into a [`CoopPacket`].
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 6 || bytes[0..4] != PACKET_MAGIC || bytes[4] != PACKET_VERSION {
            return None;
        }
        let tag = bytes[5];
        let body = &bytes[6..];
        let u32_at = |b: &[u8], i: usize| -> Option<u32> {
            Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
        };
        let u64_at = |b: &[u8], i: usize| -> Option<u64> {
            Some(u64::from_le_bytes(b.get(i..i + 8)?.try_into().ok()?))
        };
        let u16_at = |b: &[u8], i: usize| -> Option<u16> {
            Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?))
        };
        let f32_at = |b: &[u8], i: usize| -> Option<f32> {
            Some(f32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
        };

        match tag {
            TAG_HELLO => {
                let peer_id = u32_at(body, 0)?;
                let class_id = *body.get(4)?;
                let race = *body.get(5)?;
                let sex = *body.get(6)?;
                let map_idx = *body.get(7)?;
                let len = *body.get(8)? as usize;
                let name_slice = body.get(9..9 + len)?;
                let name = String::from_utf8_lossy(name_slice).into_owned();
                Some(Self::Hello {
                    peer_id,
                    class_id,
                    race,
                    sex,
                    map_idx,
                    name,
                })
            }
            TAG_START_RUN => {
                let map_idx = *body.first()?;
                let seed = u64_at(body, 1)?;
                let host_time = f32_at(body, 9)?;
                Some(Self::StartRun {
                    map_idx,
                    seed,
                    host_time,
                })
            }
            TAG_HERO_STATE => {
                if body.len() < 39 {
                    return None;
                }
                let peer_id = u32_at(body, 0)?;
                let class_id = body[4];
                let race = body[5];
                let sex = body[6];
                let pos = [f32_at(body, 7)?, f32_at(body, 11)?, f32_at(body, 15)?];
                let yaw = f32_at(body, 19)?;
                let moving = body[23] != 0;
                let hp = f32_at(body, 24)?;
                let max_hp = f32_at(body, 28)?;
                let level = u32_at(body, 32)?;
                let anim = u16_at(body, 36)?;
                let downed = body[38] != 0;
                Some(Self::HeroState {
                    peer_id,
                    class_id,
                    race,
                    sex,
                    pos,
                    yaw,
                    moving,
                    hp,
                    max_hp,
                    level,
                    anim,
                    downed,
                })
            }
            TAG_CAST_VISUAL => {
                if body.len() < 30 {
                    return None;
                }
                let peer_id = u32_at(body, 0)?;
                let ability_idx = body[4];
                let origin = [f32_at(body, 5)?, f32_at(body, 9)?, f32_at(body, 13)?];
                let target = [f32_at(body, 17)?, f32_at(body, 21)?, f32_at(body, 25)?];
                let rank = body[29];
                Some(Self::CastVisual {
                    peer_id,
                    ability_idx,
                    origin,
                    target,
                    rank,
                })
            }
            TAG_SHARED_XP => {
                let peer_id = u32_at(body, 0)?;
                let amount = f32_at(body, 4)?;
                Some(Self::SharedXp { peer_id, amount })
            }
            TAG_REVIVE => {
                let target_peer_id = u32_at(body, 0)?;
                let reviver_peer_id = u32_at(body, 4)?;
                Some(Self::Revive {
                    target_peer_id,
                    reviver_peer_id,
                })
            }
            _ => None,
        }
    }
}

/// Marker component on a remote Co-Op ally's 3D unit entity in the Celandia arena.
#[derive(Component, Clone, Copy, Debug)]
pub(crate) struct CoopAlly {
    pub peer_id: u32,
}

/// Marker component on the 3D downed-revive ring spawned under a downed ally or hero.
#[derive(Component, Clone, Copy, Debug)]
pub(crate) struct DownedReviveRing;

/// Tracked state of one remote Co-Op ally in the party.
#[derive(Clone, Debug)]
pub(crate) struct CoopPeer {
    pub peer_id: u32,
    pub name: String,
    pub class_id: u8,
    pub race: u8,
    pub sex: u8,
    pub map_idx: u8,
    pub pos: Vec3,
    pub target_pos: Vec3,
    pub yaw: f32,
    pub target_yaw: f32,
    pub moving: bool,
    pub hp: f32,
    pub max_hp: f32,
    pub level: u32,
    pub anim: u16,
    pub downed: bool,
    /// Seconds the local hero has stood within [`REVIVE_RADIUS`] of this downed ally.
    pub revive_timer: f32,
    /// Seconds since the last packet was received from this peer.
    pub last_seen: f32,
    /// The 3D unit entity spawned for this ally in the current run/arena.
    pub entity: Option<Entity>,
    /// The 3D ground ring spawned under this ally while downed.
    pub downed_ring: Option<Entity>,
    /// `(class_id, race, sex)` of the currently spawned 3D entity.
    pub spawned_look: Option<(u8, u8, u8)>,
}

impl CoopPeer {
    pub fn new(peer_id: u32, class_id: u8, race: u8, sex: u8, map_idx: u8, name: String) -> Self {
        let default_pos = wow_to_bevy(data::MAPS[0].center);
        let class = class_by_id(class_id);
        let name = if name.is_empty() {
            format!("{} #{:04x}", class.name, peer_id as u16)
        } else {
            name
        };
        Self {
            peer_id,
            name,
            class_id,
            race: race.max(1),
            sex: sex & 1,
            map_idx,
            pos: default_pos,
            target_pos: default_pos,
            yaw: 0.0,
            target_yaw: 0.0,
            moving: false,
            hp: super::BASE_HP,
            max_hp: super::BASE_HP,
            level: 1,
            anim: ANIM_STAND,
            downed: false,
            revive_timer: 0.0,
            last_seen: 0.0,
            entity: None,
            downed_ring: None,
            spawned_look: None,
        }
    }

    pub fn class_def(&self) -> &'static ClassDef {
        class_by_id(self.class_id)
    }

    /// `[0.0, 1.0]` revive completion fraction while downed.
    pub fn revive_fraction(&self) -> f32 {
        (self.revive_timer / REVIVE_DURATION).clamp(0.0, 1.0)
    }
}

pub(crate) fn class_by_id(id: u8) -> &'static ClassDef {
    data::CLASSES
        .iter()
        .find(|c| c.id == id)
        .unwrap_or(&data::CLASSES[0])
}

/// Pure helper: should a player whose HP reaches 0 enter the `Downed` state instead of `GameOver`?
pub(crate) fn should_enter_downed(coop_active: bool, living_allies: usize) -> bool {
    coop_active && living_allies > 0
}

/// Pure helper: advance or decay a downed ally's revive timer given XZ distance `dist_xz`.
/// Returns `(new_timer, revive_completed)`.
pub(crate) fn tick_revive_proximity(dist_xz: f32, current_timer: f32, dt: f32) -> (f32, bool) {
    if dist_xz <= REVIVE_RADIUS {
        let next = current_timer + dt;
        if next >= REVIVE_DURATION {
            (0.0, true)
        } else {
            (next, false)
        }
    } else {
        ((current_timer - dt * 0.5).max(0.0), false)
    }
}

/// Pure helper: apply shared XP from a co-op ally and bank any resulting levels on [`Run`].
/// Returns the number of levels gained.
pub(crate) fn apply_shared_xp(run: &mut Run, amount: f32) -> u32 {
    if amount <= 0.0 {
        return 0;
    }
    run.xp += amount;
    let mut gained = 0;
    while run.xp >= data::xp_to_next(run.level) {
        run.xp -= data::xp_to_next(run.level);
        run.level += 1;
        run.pending_levels += 1;
        gained += 1;
        if run.level == super::mobility::LEARN_LEVEL {
            if let Some(m) = super::mobility::for_class(run.class.id) {
                run.banner = Some((format!("You have learned {}! Press F.", m.name), 4.0));
            }
        }
    }
    gained
}

enum TransportBackend {
    None,
    #[cfg(not(target_arch = "wasm32"))]
    Udp {
        socket: UdpSocket,
        is_host: bool,
        target: Option<SocketAddr>,
        clients: Vec<(SocketAddr, f32)>,
        ws_tx: Option<Sender<Vec<u8>>>,
        ws_rx: Option<Receiver<Vec<u8>>>,
    },
    #[allow(dead_code)]
    Channel {
        tx: Sender<Vec<u8>>,
        rx: Receiver<Vec<u8>>,
    },
}

/// Resource managing the local player's Co-Op session, transport socket/WebSocket, and remote peers.
#[derive(Resource)]
pub(crate) struct CoopSession {
    pub mode: CoopMode,
    pub local_peer_id: u32,
    pub join_addr: String,
    pub room_name: String,
    pub status_label: String,
    pub peers: HashMap<u32, CoopPeer>,
    pub peer_order: Vec<u32>,
    pub hero_sync_timer: f32,
    pub hello_timer: f32,
    pub local_cast_anim: Option<(u16, f32)>,
    pub local_downed_ring: Option<Entity>,
    backend: TransportBackend,
}

impl Default for CoopSession {
    fn default() -> Self {
        let seed = web_time::SystemTime::now()
            .duration_since(web_time::UNIX_EPOCH)
            .map(|d| (d.as_nanos() as u32) ^ ((d.as_nanos() >> 32) as u32))
            .unwrap_or(0xA53C_9E11)
            | 1;
        let (init_mode, join_addr, room_name) = config_from_env_and_args();
        let mut session = Self {
            mode: CoopMode::Solo,
            local_peer_id: seed,
            join_addr,
            room_name,
            status_label: "SOLO".to_string(),
            peers: HashMap::new(),
            peer_order: Vec::new(),
            hero_sync_timer: 0.0,
            hello_timer: 0.0,
            local_cast_anim: None,
            local_downed_ring: None,
            backend: TransportBackend::None,
        };
        if init_mode != CoopMode::Solo {
            session.set_mode(init_mode);
        }
        session
    }
}

fn config_from_env_and_args() -> (CoopMode, String, String) {
    let mut mode = CoopMode::Solo;
    let mut addr = crate::webenv::var("WOW_COOP_ADDR")
        .unwrap_or_else(|| format!("127.0.0.1:{DEFAULT_COOP_PORT}"));
    let mut room = crate::webenv::var("WOW_COOP_ROOM").unwrap_or_else(|| "celandia".to_string());

    if let Some(m) = crate::webenv::var("WOW_COOP") {
        match m.trim().to_ascii_lowercase().as_str() {
            "host" | "1" | "true" => mode = CoopMode::Host,
            "join" => mode = CoopMode::Join,
            _ => {}
        }
    } else if crate::webenv::var("WOW_COOP_ADDR").is_some()
        || crate::webenv::var("WOW_COOP_ROOM").is_some()
    {
        mode = CoopMode::Join;
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let args: Vec<String> = std::env::args().collect();
        let mut i = 1;
        while i < args.len() {
            match args[i].as_str() {
                "--coop-host" => mode = CoopMode::Host,
                "--coop-join" => {
                    mode = CoopMode::Join;
                    if let Some(next) = args.get(i + 1) {
                        if !next.starts_with("--") {
                            addr = next.clone();
                            i += 1;
                        }
                    }
                }
                "--coop-room" => {
                    if let Some(next) = args.get(i + 1) {
                        if !next.starts_with("--") {
                            room = next.clone();
                            i += 1;
                        }
                    }
                }
                _ => {
                    if let Some(rest) = args[i].strip_prefix("--coop-join=") {
                        mode = CoopMode::Join;
                        if !rest.is_empty() {
                            addr = rest.to_string();
                        }
                    } else if let Some(rest) = args[i].strip_prefix("--coop-room=") {
                        if !rest.is_empty() {
                            room = rest.to_string();
                        }
                    }
                }
            }
            i += 1;
        }
    }

    (mode, addr, room)
}

impl CoopSession {
    pub fn is_active(&self) -> bool {
        self.mode != CoopMode::Solo
    }

    /// Total players in the party (local player + connected remote peers, capped at 8).
    pub fn party_count(&self) -> usize {
        (1 + self.peers.len()).min(MAX_PARTY_SIZE)
    }

    /// Number of connected remote allies who are currently alive (`!downed`).
    pub fn living_allies_count(&self) -> usize {
        self.peers.values().filter(|p| !p.downed).count()
    }

    pub fn has_living_ally(&self) -> bool {
        self.living_allies_count() > 0
    }

    /// Cycle Solo -> Host Co-Op -> Join Co-Op -> Solo.
    pub fn cycle_mode(&mut self) {
        let next = self.mode.next();
        self.set_mode(next);
    }

    /// Switch to `mode` and open/close the underlying UDP or WebSocket transport.
    pub fn set_mode(&mut self, mode: CoopMode) {
        self.mode = mode;
        self.peers.clear();
        self.peer_order.clear();
        self.hero_sync_timer = 0.0;
        self.hello_timer = 0.0;

        match mode {
            CoopMode::Solo => {
                self.backend = TransportBackend::None;
                self.status_label = "SOLO".to_string();
            }
            CoopMode::Host => {
                self.open_transport(true);
            }
            CoopMode::Join => {
                self.open_transport(false);
            }
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn open_transport(&mut self, is_host: bool) {
        let ws_pair = if self.join_addr.starts_with("ws://")
            || self.join_addr.starts_with("http://")
            || crate::webenv::var("WOW_COOP_WS").is_some()
        {
            let url = crate::webenv::var("WOW_COOP_WS").unwrap_or_else(|| self.join_addr.clone());
            spawn_native_ws_relay(&url, &self.room_name)
        } else {
            None
        };

        let bind_addr = if is_host {
            format!("0.0.0.0:{DEFAULT_COOP_PORT}")
        } else {
            "0.0.0.0:0".to_string()
        };

        let socket = UdpSocket::bind(&bind_addr).or_else(|_| UdpSocket::bind("0.0.0.0:0"));
        match socket {
            Ok(sock) => {
                let _ = sock.set_nonblocking(true);
                let local_port = sock.local_addr().map(|a| a.port()).unwrap_or(DEFAULT_COOP_PORT);
                let target = if is_host {
                    None
                } else {
                    resolve_udp_target(&self.join_addr)
                };
                self.status_label = if is_host {
                    format!("HOST CO-OP :{local_port}")
                } else {
                    format!("JOIN CO-OP {}", self.join_addr)
                };
                let (ws_tx, ws_rx) = match ws_pair {
                    Some((tx, rx)) => (Some(tx), Some(rx)),
                    None => (None, None),
                };
                self.backend = TransportBackend::Udp {
                    socket: sock,
                    is_host,
                    target,
                    clients: Vec::new(),
                    ws_tx,
                    ws_rx,
                };
            }
            Err(e) => {
                warn!("survivors coop: UDP bind failed: {e}");
                if let Some((tx, rx)) = ws_pair {
                    self.status_label = format!("WS CO-OP [{}]", self.room_name);
                    self.backend = TransportBackend::Channel { tx, rx };
                } else {
                    self.status_label = "CO-OP OFFLINE".to_string();
                    self.backend = TransportBackend::None;
                }
            }
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn open_transport(&mut self, is_host: bool) {
        if let Some((tx, rx)) = spawn_wasm_ws_relay(&self.room_name) {
            let role = if is_host { "HOST" } else { "JOIN" };
            self.status_label = format!("{role} CO-OP [{}]", self.room_name);
            self.backend = TransportBackend::Channel { tx, rx };
        } else {
            self.status_label = "CO-OP WS ERROR".to_string();
            self.backend = TransportBackend::None;
        }
    }

    /// Construct an in-memory channel-backed session for deterministic unit testing.
    #[cfg(test)]
    pub fn with_channels(
        local_peer_id: u32,
        mode: CoopMode,
        tx: Sender<Vec<u8>>,
        rx: Receiver<Vec<u8>>,
    ) -> Self {
        Self {
            mode,
            local_peer_id,
            join_addr: format!("127.0.0.1:{DEFAULT_COOP_PORT}"),
            room_name: "test".to_string(),
            status_label: mode.label().to_string(),
            peers: HashMap::new(),
            peer_order: Vec::new(),
            hero_sync_timer: 0.0,
            hello_timer: 0.0,
            local_cast_anim: None,
            local_downed_ring: None,
            backend: TransportBackend::Channel { tx, rx },
        }
    }

    /// Send a [`CoopPacket`] to all connected peers.
    pub fn send(&mut self, pkt: &CoopPacket) {
        let bytes = pkt.encode();
        match &mut self.backend {
            TransportBackend::None => {}
            #[cfg(not(target_arch = "wasm32"))]
            TransportBackend::Udp {
                socket,
                is_host,
                target,
                clients,
                ws_tx,
                ..
            } => {
                if *is_host {
                    for (addr, _) in clients.iter() {
                        let _ = socket.send_to(&bytes, addr);
                    }
                } else if let Some(dst) = target {
                    let _ = socket.send_to(&bytes, *dst);
                }
                if let Some(tx) = ws_tx {
                    let _ = tx.try_send(bytes);
                }
            }
            TransportBackend::Channel { tx, .. } => {
                let _ = tx.try_send(bytes);
            }
        }
    }

    /// Drain all newly arrived [`CoopPacket`]s from the non-blocking socket or WebSocket relay.
    pub fn poll_packets(&mut self, dt: f32) -> Vec<CoopPacket> {
        let mut received = Vec::new();
        match &mut self.backend {
            TransportBackend::None => {}
            #[cfg(not(target_arch = "wasm32"))]
            TransportBackend::Udp {
                socket,
                is_host,
                clients,
                ws_rx,
                ..
            } => {
                for (_, age) in clients.iter_mut() {
                    *age += dt;
                }
                clients.retain(|(_, age)| *age <= PEER_TIMEOUT_SECS);

                let mut buf = [0u8; 512];
                while let Ok((n, src)) = socket.recv_from(&mut buf) {
                    let frame = &buf[..n];
                    if *is_host {
                        if let Some(entry) = clients.iter_mut().find(|(a, _)| *a == src) {
                            entry.1 = 0.0;
                        } else if clients.len() < MAX_PARTY_SIZE - 1 {
                            clients.push((src, 0.0));
                        }
                        // Host relays UDP datagrams to all other connected UDP clients so a 3–8
                        // player party forms a star mesh through port 8091.
                        for (other, _) in clients.iter() {
                            if *other != src {
                                let _ = socket.send_to(frame, other);
                            }
                        }
                    }
                    if let Some(pkt) = CoopPacket::decode(frame) {
                        if pkt.peer_id() != Some(self.local_peer_id) {
                            received.push(pkt);
                        }
                    }
                }

                if let Some(rx) = ws_rx {
                    while let Ok(frame) = rx.try_recv() {
                        if let Some(pkt) = CoopPacket::decode(&frame) {
                            if pkt.peer_id() != Some(self.local_peer_id) {
                                received.push(pkt);
                            }
                        }
                    }
                }
            }
            TransportBackend::Channel { rx, .. } => {
                while let Ok(frame) = rx.try_recv() {
                    if let Some(pkt) = CoopPacket::decode(&frame) {
                        if pkt.peer_id() != Some(self.local_peer_id) {
                            received.push(pkt);
                        }
                    }
                }
            }
        }
        received
    }

    /// Broadcast an ability cast visual & damage event to all co-op allies.
    pub fn send_cast_visual(&mut self, ability_idx: u8, origin: Vec3, target: Vec3, rank: u8) {
        if !self.is_active() {
            return;
        }
        let is_melee = data::ABILITIES
            .get(ability_idx as usize)
            .is_some_and(|a| a.kind == data::Kind::Melee);
        let anim = if is_melee {
            ANIM_ATTACK_UNARMED
        } else {
            ANIM_SPELL_CAST_DIRECTED
        };
        self.local_cast_anim = Some((anim, 0.35));
        let pkt = CoopPacket::CastVisual {
            peer_id: self.local_peer_id,
            ability_idx,
            origin: origin.to_array(),
            target: target.to_array(),
            rank,
        };
        self.send(&pkt);
    }

    /// Broadcast shared XP from a collected gem to all co-op allies.
    pub fn send_shared_xp(&mut self, amount: f32) {
        if !self.is_active() || amount <= 0.0 {
            return;
        }
        let pkt = CoopPacket::SharedXp {
            peer_id: self.local_peer_id,
            amount,
        };
        self.send(&pkt);
    }

    /// Broadcast a `StartRun` packet when entering the world in Co-Op mode.
    pub fn send_start_run(&mut self, map_idx: usize, seed: u64, host_time: f32) {
        if !self.is_active() {
            return;
        }
        let pkt = CoopPacket::StartRun {
            map_idx: map_idx as u8,
            seed,
            host_time,
        };
        self.send(&pkt);
    }

    pub fn upsert_peer(
        &mut self,
        peer_id: u32,
        class_id: u8,
        race: u8,
        sex: u8,
        map_idx: u8,
        name: Option<String>,
    ) -> Option<&mut CoopPeer> {
        if peer_id == self.local_peer_id {
            return None;
        }
        if !self.peers.contains_key(&peer_id) {
            if self.peers.len() >= MAX_PARTY_SIZE - 1 {
                return None;
            }
            let peer_name = name.clone().unwrap_or_default();
            self.peers.insert(
                peer_id,
                CoopPeer::new(peer_id, class_id, race, sex, map_idx, peer_name),
            );
            self.peer_order.push(peer_id);
        }
        let peer = self.peers.get_mut(&peer_id)?;
        peer.class_id = class_id;
        peer.race = race.max(1);
        peer.sex = sex & 1;
        peer.map_idx = map_idx;
        peer.last_seen = 0.0;
        if let Some(n) = name.filter(|s| !s.is_empty()) {
            peer.name = n;
        }
        Some(peer)
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn resolve_udp_target(addr: &str) -> Option<SocketAddr> {
    let trimmed = addr
        .trim()
        .strip_prefix("udp://")
        .unwrap_or(addr.trim());
    let with_port = if trimmed.contains(':') {
        trimmed.to_string()
    } else {
        format!("{trimmed}:{DEFAULT_COOP_PORT}")
    };
    with_port
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next())
}

/// Lightweight native WebSocket client thread for `/ws/survivors/{room}` on `wenilla-host`.
#[cfg(not(target_arch = "wasm32"))]
fn spawn_native_ws_relay(
    raw_url: &str,
    default_room: &str,
) -> Option<(Sender<Vec<u8>>, Receiver<Vec<u8>>)> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let stripped = raw_url
        .trim()
        .strip_prefix("ws://")
        .or_else(|| raw_url.trim().strip_prefix("http://"))
        .unwrap_or(raw_url.trim());
    let (host_port, path) = match stripped.split_once('/') {
        Some((hp, p)) => (hp.to_string(), format!("/{p}")),
        None => (
            stripped.to_string(),
            format!("/ws/survivors/{default_room}"),
        ),
    };
    let host_port = if host_port.contains(':') {
        host_port
    } else {
        format!("{host_port}:8090")
    };

    let (out_tx, out_rx) = crossbeam_channel::bounded::<Vec<u8>>(256);
    let (in_tx, in_rx) = crossbeam_channel::bounded::<Vec<u8>>(256);

    std::thread::Builder::new()
        .name("survivors-coop-ws".into())
        .spawn(move || {
            let Ok(mut stream) = TcpStream::connect(&host_port) else {
                return;
            };
            let _ = stream.set_nodelay(true);
            let req = format!(
                "GET {path} HTTP/1.1\r\n\
                 Host: {host_port}\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                 Sec-WebSocket-Version: 13\r\n\r\n"
            );
            if stream.write_all(req.as_bytes()).is_err() {
                return;
            }
            // Read HTTP 101 response header up to `\r\n\r\n`.
            let mut hdr = Vec::with_capacity(256);
            let mut byte = [0u8; 1];
            while !hdr.ends_with(b"\r\n\r\n") {
                if hdr.len() > 4096 || stream.read_exact(&mut byte).is_err() {
                    return;
                }
                hdr.push(byte[0]);
            }
            if !String::from_utf8_lossy(&hdr).contains("101") {
                return;
            }
            let _ = stream.set_nonblocking(true);
            let mut rx_buf = Vec::with_capacity(1024);
            let mut tmp = [0u8; 512];
            loop {
                while let Ok(pkt) = out_rx.try_recv() {
                    let frame = encode_ws_client_frame(&pkt);
                    let _ = stream.set_nonblocking(false);
                    if stream.write_all(&frame).is_err() {
                        return;
                    }
                    let _ = stream.set_nonblocking(true);
                }
                match stream.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        rx_buf.extend_from_slice(&tmp[..n]);
                        while let Some((opcode, payload, consumed)) = decode_ws_frame(&rx_buf) {
                            rx_buf.drain(..consumed);
                            if opcode == 0x2 || opcode == 0x1 {
                                let _ = in_tx.try_send(payload);
                            } else if opcode == 0x8 {
                                return;
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(4));
                    }
                    Err(_) => break,
                }
            }
        })
        .ok()?;

    Some((out_tx, in_rx))
}

#[cfg(not(target_arch = "wasm32"))]
fn encode_ws_client_frame(payload: &[u8]) -> Vec<u8> {
    let mask = [0x37u8, 0xFA, 0x21, 0x3D];
    let mut frame = Vec::with_capacity(10 + payload.len());
    frame.push(0x82); // FIN + Binary opcode
    if payload.len() < 126 {
        frame.push(0x80 | (payload.len() as u8));
    } else {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    for (i, &b) in payload.iter().enumerate() {
        frame.push(b ^ mask[i & 3]);
    }
    frame
}

#[cfg(not(target_arch = "wasm32"))]
fn decode_ws_frame(buf: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    if buf.len() < 2 {
        return None;
    }
    let opcode = buf[0] & 0x0F;
    let masked = (buf[1] & 0x80) != 0;
    let mut len = (buf[1] & 0x7F) as usize;
    let mut idx = 2;
    if len == 126 {
        if buf.len() < 4 {
            return None;
        }
        len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
        idx = 4;
    } else if len == 127 {
        if buf.len() < 10 {
            return None;
        }
        len = u64::from_be_bytes(buf[2..10].try_into().ok()?) as usize;
        idx = 10;
    }
    let mask = if masked {
        if buf.len() < idx + 4 {
            return None;
        }
        let m = [buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]];
        idx += 4;
        Some(m)
    } else {
        None
    };
    if buf.len() < idx + len {
        return None;
    }
    let mut payload = buf[idx..idx + len].to_vec();
    if let Some(m) = mask {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= m[i & 3];
        }
    }
    Some((opcode, payload, idx + len))
}

#[cfg(target_arch = "wasm32")]
fn spawn_wasm_ws_relay(room: &str) -> Option<(Sender<Vec<u8>>, Receiver<Vec<u8>>)> {
    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::JsCast;
    use web_sys::{BinaryType, MessageEvent, WebSocket};

    let window = web_sys::window()?;
    let loc = window.location();
    let proto = loc.protocol().ok()?;
    let host = loc.host().ok()?;
    let scheme = if proto == "https:" { "wss" } else { "ws" };
    let url = format!("{scheme}://{host}/ws/survivors/{room}");

    let ws = WebSocket::new(&url).ok()?;
    ws.set_binary_type(BinaryType::Arraybuffer);

    let (out_tx, out_rx) = crossbeam_channel::bounded::<Vec<u8>>(256);
    let (in_tx, in_rx) = crossbeam_channel::bounded::<Vec<u8>>(256);

    let on_msg = Closure::<dyn FnMut(MessageEvent)>::new(move |e: MessageEvent| {
        if let Ok(abuf) = e.data().dyn_into::<js_sys::ArrayBuffer>() {
            let bytes = js_sys::Uint8Array::new(&abuf).to_vec();
            let _ = in_tx.try_send(bytes);
        }
    });
    ws.set_onmessage(Some(on_msg.as_ref().unchecked_ref()));
    on_msg.forget();

    wasm_bindgen_futures::spawn_local(async move {
        loop {
            while let Ok(pkt) = out_rx.try_recv() {
                if ws.ready_state() == WebSocket::OPEN {
                    let _ = ws.send_with_u8_array(&pkt);
                }
            }
            let promise = js_sys::Promise::new(&mut |resolve, _| {
                if let Some(w) = web_sys::window() {
                    let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 16);
                }
            });
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
        }
    });

    Some((out_tx, in_rx))
}

/// Menu & in-run shortcut (`C` on the menu cycles Solo -> Host Co-Op -> Join Co-Op) and periodic
/// [`CoopPacket::Hello`] + [`CoopPacket::HeroState`] broadcasts.
#[allow(clippy::too_many_arguments)]
pub(super) fn drive_coop_network(
    mut commands: Commands,
    time: Res<Time<Real>>,
    keys: Res<ButtonInput<KeyCode>>,
    phase: Res<State<Phase>>,
    mut next_phase: ResMut<NextState<Phase>>,
    mut coop: ResMut<CoopSession>,
    mut selection: ResMut<Selection>,
    mut run: ResMut<Run>,
    mut rng: ResMut<Rng>,
    hero: Query<(Entity, &Transform, &MovementState, &Guid, &mut ObjectStore), With<Hero>>,
    enemies: Query<(Entity, &Transform, &Enemy), Without<Hero>>,
    spells: Option<Res<crate::ui_action::Spells>>,
    mut fx: Fx,
    mut pending: ResMut<PendingHits>,
    mut hits: MessageWriter<Hit>,
) {
    let dt = time.delta_secs().min(0.1);

    // On the Menu, pressing `C` cycles Solo -> Host Co-Op -> Join Co-Op.
    if *phase.get() == Phase::Menu && keys.just_pressed(KeyCode::KeyC) {
        coop.cycle_mode();
        selection.version += 1;
    }

    if !coop.is_active() {
        return;
    }

    if let Some((_, rem)) = coop.local_cast_anim.as_mut() {
        *rem -= dt;
        if *rem <= 0.0 {
            coop.local_cast_anim = None;
        }
    }

    // Age peers & prune stale disconnects.
    let mut expired = Vec::new();
    for (&pid, peer) in coop.peers.iter_mut() {
        peer.last_seen += dt;
        if peer.last_seen > PEER_TIMEOUT_SECS {
            expired.push(pid);
        }
    }
    for pid in expired {
        if let Some(peer) = coop.peers.remove(&pid) {
            if let Some(e) = peer.entity {
                commands.entity(e).despawn();
            }
            if let Some(r) = peer.downed_ring {
                commands.entity(r).despawn();
            }
        }
        coop.peer_order.retain(|&id| id != pid);
    }

    // Resolve local look & class.
    let class_id = selection
        .class_def()
        .map_or(run.class.id, |c| c.id);
    let (race, sex) = selection
        .look
        .and_then(|i| selection.looks.get(i))
        .map_or((run.race.max(1), 0), |&(_, r, s)| (r, s));

    // Broadcast `Hello` every 1.0s so new peers in UDP/WebSocket rooms discover us.
    coop.hello_timer -= dt;
    if coop.hello_timer <= 0.0 {
        coop.hello_timer = HELLO_INTERVAL;
        let class_name = class_by_id(class_id).name;
        let name = format!(
            "{} {}",
            crate::char_select::race_name(race),
            class_name
        );
        let pkt = CoopPacket::Hello {
            peer_id: coop.local_peer_id,
            class_id,
            race,
            sex,
            map_idx: selection.map as u8,
            name,
        };
        coop.send(&pkt);
    }

    // Broadcast `HeroState` at 20 Hz.
    coop.hero_sync_timer -= dt;
    if coop.hero_sync_timer <= 0.0 {
        coop.hero_sync_timer = HERO_SYNC_INTERVAL;
        let (pos, yaw, moving) = match hero.single() {
            Ok((_, tf, mv, _, _)) => {
                let (_, y_rot, _) = tf.rotation.to_euler(EulerRot::YXZ);
                (tf.translation.to_array(), y_rot, mv.speed > 0.1)
            }
            Err(_) => {
                let c = hero::arena(selection.stage_def());
                (c.to_array(), 0.0, false)
            }
        };
        let stats = run.stats();
        let anim = if run.downed || run.dead_t.is_some() {
            ANIM_DEATH
        } else if let Some((cast_anim, _)) = coop.local_cast_anim {
            cast_anim
        } else if moving {
            ANIM_RUN
        } else {
            ANIM_STAND
        };
        let pkt = CoopPacket::HeroState {
            peer_id: coop.local_peer_id,
            class_id,
            race,
            sex,
            pos,
            yaw,
            moving,
            hp: run.hp,
            max_hp: stats.max_hp,
            level: run.level,
            anim,
            downed: run.downed || run.dead_t.is_some(),
        };
        coop.send(&pkt);
    }

    // Process inbound packets from remote peers.
    let inbound = coop.poll_packets(dt);
    for pkt in inbound {
        match pkt {
            CoopPacket::Hello {
                peer_id,
                class_id,
                race,
                sex,
                map_idx,
                name,
            } => {
                let is_new = !coop.peers.contains_key(&peer_id);
                coop.upsert_peer(peer_id, class_id, race, sex, map_idx, Some(name));
                if is_new {
                    // Reply immediately with our own Hello so lobby count updates on both sides.
                    coop.hello_timer = 0.0;
                    selection.version += 1;
                }
            }
            CoopPacket::StartRun {
                map_idx,
                seed,
                host_time,
            } => {
                let idx = (map_idx as usize).min(data::MAPS.len() - 1);
                selection.map = idx;
                rng.0 = seed | 1;
                if *phase.get() == Phase::Menu {
                    if hud::start_run(&mut run, &mut selection) {
                        run.elapsed = host_time.max(0.0);
                        next_phase.set(Phase::Playing);
                    }
                }
            }
            CoopPacket::HeroState {
                peer_id,
                class_id,
                race,
                sex,
                pos,
                yaw,
                moving,
                hp,
                max_hp,
                level,
                anim,
                downed,
            } => {
                let map_idx = selection.map as u8;
                if let Some(peer) = coop.upsert_peer(peer_id, class_id, race, sex, map_idx, None) {
                    let new_pos = Vec3::from_array(pos);
                    if peer.entity.is_none() || peer.pos.distance(new_pos) > 35.0 {
                        peer.pos = new_pos;
                    }
                    peer.target_pos = new_pos;
                    peer.target_yaw = yaw;
                    peer.moving = moving;
                    peer.hp = hp;
                    peer.max_hp = max_hp.max(1.0);
                    peer.level = level.max(1);
                    peer.anim = anim;
                    peer.downed = downed;
                    if !downed {
                        peer.revive_timer = 0.0;
                    }
                }
            }
            CoopPacket::CastVisual {
                peer_id,
                ability_idx,
                origin,
                target,
                rank,
            } => {
                if *phase.get() == Phase::Playing {
                    let ally_entity = coop.peers.get(&peer_id).and_then(|p| p.entity);
                    abilities::replicate_ally_cast(
                        &mut commands,
                        &mut run,
                        &mut rng,
                        spells.as_deref(),
                        ally_entity,
                        ability_idx,
                        Vec3::from_array(origin),
                        Vec3::from_array(target),
                        rank,
                        &enemies,
                        &mut fx,
                        &mut pending,
                        &mut hits,
                    );
                }
            }
            CoopPacket::SharedXp { peer_id, amount } => {
                if peer_id != coop.local_peer_id && *phase.get() == Phase::Playing {
                    let gained = apply_shared_xp(&mut run, amount);
                    if gained > 0 && !run.incapacitated() {
                        next_phase.set(Phase::LevelUp);
                    }
                }
            }
            CoopPacket::Revive {
                target_peer_id,
                reviver_peer_id,
            } => {
                if target_peer_id == coop.local_peer_id && run.downed {
                    revive_local_hero(&mut run, &hero, &mut fx);
                    let reviver_name = coop
                        .peers
                        .get(&reviver_peer_id)
                        .map(|p| p.name.as_str())
                        .unwrap_or("an ally");
                    run.banner = Some((format!("Revived by {reviver_name}!"), 3.0));
                } else if let Some(peer) = coop.peers.get_mut(&target_peer_id) {
                    peer.downed = false;
                    peer.revive_timer = 0.0;
                    peer.hp = (peer.max_hp * REVIVE_HP_FRACTION).max(1.0);
                }
            }
        }
    }
}

/// Restore a unit's health field (`FIELD_HEALTH = 22`) in [`ObjectStore`] so the animation system
/// exits the corpse pose and resumes standing/running.
pub(crate) fn revive_unit(store: &mut ObjectStore) {
    if store.0.unit_health() == Some(0) {
        store.0.merge(benilla_protocol::messages::ObjectFields::from_pairs(&[(22, 100)]));
    }
}

fn revive_local_hero(
    run: &mut Run,
    hero: &Query<(Entity, &Transform, &MovementState, &Guid, &mut ObjectStore), With<Hero>>,
    fx: &mut Fx,
) {
    let max_hp = run.stats().max_hp;
    run.downed = false;
    run.revive_progress = 0.0;
    run.dead_t = None;
    run.hp = (max_hp * REVIVE_HP_FRACTION).max(1.0);
    run.immune_t = 2.5;
    if let Ok((e, _, _, _, _)) = hero.single() {
        fx.cast(e, 60014, &[e], None);
        fx.number(e, run.hp, false, COLOR_HEAL);
    }
}

/// Spawn, despawn, smoothly interpolate, animate, and handle downed/revive proximity for all
/// connected `CoopPeer` ally units in the 3D Celandia arena.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn sync_coop_allies(
    mut commands: Commands,
    time: Res<Time>,
    phase: Res<State<Phase>>,
    mut coop: ResMut<CoopSession>,
    mut run: ResMut<Run>,
    selection: Res<Selection>,
    creatures: Option<Res<crate::entities::Creatures>>,
    world: WorldPoint,
    mut hero_q: Query<(Entity, &Transform, &Guid, &mut ObjectStore), (With<Hero>, Without<CoopAlly>)>,
    mut allies_q: Query<
        (&mut Transform, &mut MovementState, &Guid, &mut ObjectStore, &mut Marks),
        (With<CoopAlly>, Without<Hero>),
    >,
    mut rings_q: Query<&mut Transform, (With<DownedReviveRing>, Without<Hero>, Without<CoopAlly>)>,
    mut fields: MessageWriter<FieldChanged>,
    mut fx: Fx,
) {
    let dt = time.delta_secs();
    if !coop.is_active() {
        if let Some(ring) = coop.local_downed_ring.take() {
            commands.entity(ring).despawn();
        }
        return;
    }

    let hero_pos = hero_q.single().ok().map(|(_, tf, _, _)| tf.translation);

    // Manage local hero's 3D downed ring and check if a living remote ally is reviving us.
    if run.downed {
        if let Some(hpos) = hero_pos {
            if coop.local_downed_ring.is_none() {
                let serial = run.guid();
                let ring = units::spawn_area_object(
                    &mut commands,
                    serial,
                    60010,
                    REVIVE_RADIUS,
                    hpos,
                );
                commands.entity(ring).insert(DownedReviveRing);
                coop.local_downed_ring = Some(ring);
            } else if let Some(ring) = coop.local_downed_ring {
                if let Ok(mut rtf) = rings_q.get_mut(ring) {
                    rtf.translation = hpos;
                }
            }
            // Check if any living remote ally is within REVIVE_RADIUS of our downed local hero.
            let nearest_ally_dist = coop
                .peers
                .values()
                .filter(|p| !p.downed)
                .map(|p| flat(p.pos - hpos).length())
                .min_by(f32::total_cmp)
                .unwrap_or(f32::INFINITY);
            let (next_prog, completed) =
                tick_revive_proximity(nearest_ally_dist, run.revive_progress, dt);
            run.revive_progress = next_prog;
            if completed {
                let max_hp = run.stats().max_hp;
                run.downed = false;
                run.revive_progress = 0.0;
                run.hp = (max_hp * REVIVE_HP_FRACTION).max(1.0);
                run.immune_t = 2.5;
                if let Ok((he, _, _, mut hstore)) = hero_q.single_mut() {
                    revive_unit(&mut hstore);
                    fx.cast(he, 60014, &[he], None);
                    fx.number(he, run.hp, false, COLOR_HEAL);
                }
                run.banner = Some(("Revived by Ally!".into(), 3.0));
            }
        }
    } else if let Some(ring) = coop.local_downed_ring.take() {
        commands.entity(ring).despawn();
        if let Ok((_, _, _, mut hstore)) = hero_q.single_mut() {
            revive_unit(&mut hstore);
        }
    }

    let local_peer_id = coop.local_peer_id;
    let mut revives_to_send: Vec<u32> = Vec::new();
    let mut revived_banner: Option<String> = None;

    for (&peer_id, peer) in coop.peers.iter_mut() {
        let want_look = (peer.class_id, peer.race, peer.sex);
        let entity_alive = peer
            .entity
            .is_some_and(|e| allies_q.contains(e));

        if !entity_alive || peer.spawned_look != Some(want_look) {
            if let Some(old_e) = peer.entity.take() {
                commands.entity(old_e).despawn();
            }
            let class = class_by_id(peer.class_id);
            let display = creatures
                .as_deref()
                .and_then(|c| {
                    hud::looks_for(class, c)
                        .into_iter()
                        .find(|&(_, r, s)| r == peer.race && s == peer.sex)
                        .map(|(d, _, _)| d)
                })
                .unwrap_or_else(|| class.hero_display(peer.race, peer.sex));
            let _weapon_display = class.weapon_display();
            let bytes0 = u32::from(peer.race)
                | u32::from(class.id) << 8
                | u32::from(peer.sex) << 16
                | u32::from(class.power) << 24;
            let serial = run.guid();
            let mut spawn_pos = if *phase.get() == Phase::Menu {
                // On the menu, stand beside the local preview hero in a neat arc.
                let idx = (peer_id as usize % 6) + 1;
                let side = if idx % 2 == 0 { 1.0 } else { -1.0 };
                let rank = ((idx + 1) / 2) as f32;
                hero::arena(selection.stage_def()) + Vec3::new(side * 2.2 * rank, 0.0, -1.2 * rank)
            } else {
                peer.target_pos
            };
            if let Some(h) = world.terrain_height_under(spawn_pos) {
                spawn_pos.y = h;
            }
            peer.pos = spawn_pos;
            let e = units::spawn_unit(
                &mut commands,
                &UnitSpec {
                    serial,
                    display,
                    scale: 1.0,
                    level: peer.level.max(1),
                    faction: units::FACTION_FRIENDLY,
                    bytes0,
                    weapons: class.weapons,
                    sheath: class.sheath,
                },
                spawn_pos,
                peer.target_yaw,
            );
            commands
                .entity(e)
                .insert((CoopAlly { peer_id }, Marks::buffs()));
            peer.entity = Some(e);
            peer.spawned_look = Some(want_look);
        }

        // Smoothly interpolate position & yaw and drive animations on the ally unit.
        if let Some(e) = peer.entity {
            if let Ok((mut tf, mut mv, guid, mut store, mut marks)) = allies_q.get_mut(e) {
                let desired_pos = if *phase.get() == Phase::Menu {
                    let idx = (peer_id as usize % 6) + 1;
                    let side = if idx % 2 == 0 { 1.0 } else { -1.0 };
                    let rank = ((idx + 1) / 2) as f32;
                    let mut p = hero::arena(selection.stage_def())
                        + Vec3::new(side * 2.2 * rank, 0.0, -1.2 * rank);
                    if let Some(h) = world.terrain_height_under(p) {
                        p.y = h;
                    }
                    p
                } else {
                    let mut p = peer.pos.lerp(peer.target_pos, (dt * 14.0).min(1.0));
                    if let Some(h) = world.terrain_height_under(p) {
                        p.y = h;
                    }
                    p
                };
                peer.pos = desired_pos;
                tf.translation = desired_pos;

                let target_rot = Quat::from_rotation_y(peer.target_yaw);
                tf.rotation = tf.rotation.slerp(target_rot, (dt * 16.0).min(1.0));
                let (_, new_yaw, _) = tf.rotation.to_euler(EulerRot::YXZ);
                peer.yaw = new_yaw;

                if peer.downed && *phase.get() == Phase::Playing {
                    mv.speed = 0.0;
                    mv.flags = 0;
                    units::kill_unit(&mut store);
                    marks.clear();
                    marks.flush(e, guid.0, &mut store, &mut fields);
                } else {
                    revive_unit(&mut store);
                    let moving = *phase.get() == Phase::Playing
                        && (peer.moving || peer.anim == ANIM_RUN);
                    if moving {
                        mv.speed = 7.5;
                        mv.flags = move_flags::FORWARD;
                    } else {
                        mv.speed = 0.0;
                        mv.flags = 0;
                    }
                }
            }
        }

        // Downed revive ring & standing within 4 yards for 2.5s revive check.
        if peer.downed && *phase.get() == Phase::Playing {
            if peer.downed_ring.is_none() {
                let serial = run.guid();
                let ring = units::spawn_area_object(
                    &mut commands,
                    serial,
                    60010,
                    REVIVE_RADIUS,
                    peer.pos,
                );
                commands.entity(ring).insert(DownedReviveRing);
                peer.downed_ring = Some(ring);
            } else if let Some(ring) = peer.downed_ring {
                if let Ok(mut rtf) = rings_q.get_mut(ring) {
                    rtf.translation = peer.pos;
                }
            }

            if !run.incapacitated() {
                if let Some(hpos) = hero_pos {
                    let dist = flat(hpos - peer.pos).length();
                    let (next_timer, completed) =
                        tick_revive_proximity(dist, peer.revive_timer, dt);
                    peer.revive_timer = next_timer;
                    if completed {
                        peer.downed = false;
                        peer.hp = (peer.max_hp * REVIVE_HP_FRACTION).max(1.0);
                        revives_to_send.push(peer_id);
                        revived_banner = Some(format!("Revived {}!", peer.name));
                        if let Some(e) = peer.entity {
                            fx.cast(e, 60014, &[e], None);
                            fx.number(e, peer.hp, false, COLOR_HEAL);
                        }
                    }
                }
            }
        } else if let Some(ring) = peer.downed_ring.take() {
            commands.entity(ring).despawn();
        }
    }

    if let Some(msg) = revived_banner {
        run.banner = Some((msg, 3.0));
    }
    for target_peer_id in revives_to_send {
        let pkt = CoopPacket::Revive {
            target_peer_id,
            reviver_peer_id: local_peer_id,
        };
        coop.send(&pkt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coop_packet_round_trips_all_variants() {
        let packets = vec![
            CoopPacket::Hello {
                peer_id: 0x1234_5678,
                class_id: 2,
                race: 4,
                sex: 1,
                map_idx: 3,
                name: "Night Elf Aureate Sun-Knight".to_string(),
            },
            CoopPacket::StartRun {
                map_idx: 2,
                seed: 0xDEAD_BEEF_CAFE_BABE,
                host_time: 12.5,
            },
            CoopPacket::HeroState {
                peer_id: 42,
                class_id: 7,
                race: 1,
                sex: 0,
                pos: [12.5, 3.25, -48.0],
                yaw: 1.57,
                moving: true,
                hp: 95.5,
                max_hp: 160.0,
                level: 9,
                anim: ANIM_RUN,
                downed: false,
            },
            CoopPacket::CastVisual {
                peer_id: 42,
                ability_idx: 5,
                origin: [1.0, 2.0, 3.0],
                target: [10.0, 2.0, -5.0],
                rank: 4,
            },
            CoopPacket::SharedXp {
                peer_id: 99,
                amount: 18.5,
            },
            CoopPacket::Revive {
                target_peer_id: 42,
                reviver_peer_id: 99,
            },
        ];

        for pkt in packets {
            let bytes = pkt.encode();
            let decoded = CoopPacket::decode(&bytes).expect("decode packet");
            assert_eq!(decoded, pkt);
        }
    }

    #[test]
    fn downed_and_revive_proximity_logic_requires_2_5_seconds_within_4_yards() {
        assert!(!should_enter_downed(false, 2), "solo never enters downed");
        assert!(
            !should_enter_downed(true, 0),
            "coop with 0 living allies wipes"
        );
        assert!(
            should_enter_downed(true, 1),
            "coop with living ally enters downed"
        );

        let mut timer = 0.0;
        // Standing at 3.5 yards (within 4.0 yd) for 2.0s builds progress without completing.
        for _ in 0..20 {
            let (next, done) = tick_revive_proximity(3.5, timer, 0.1);
            assert!(!done);
            timer = next;
        }
        assert!((timer - 2.0).abs() < 1e-4);

        // Stepping outside 4.0 yards decays the timer slowly instead of resetting to zero.
        let (decayed, done) = tick_revive_proximity(6.0, timer, 0.4);
        assert!(!done);
        assert!((decayed - 1.8).abs() < 1e-4);

        // Stepping back inside for the remaining 0.75s completes the 2.5s revive.
        let (final_t, done) = tick_revive_proximity(2.0, decayed, 0.75);
        assert!(done, "standing within 4 yards for 2.5s total must revive");
        assert_eq!(final_t, 0.0);
    }

    #[test]
    fn shared_xp_accumulates_and_grants_levels() {
        let mut run = Run::default();
        assert_eq!(run.level, 1);
        assert_eq!(run.pending_levels, 0);

        let need_lvl1 = data::xp_to_next(1);
        let gained = apply_shared_xp(&mut run, need_lvl1 + 2.0);
        assert_eq!(gained, 1);
        assert_eq!(run.level, 2);
        assert_eq!(run.pending_levels, 1);
        assert!((run.xp - 2.0).abs() < 1e-4);
    }

    #[test]
    fn class_def_hero_and_weapon_display_resolve_valid_ids() {
        for class in data::CLASSES {
            for race in 1..=8 {
                for sex in 0..=1 {
                    let hero_disp = class.hero_display(race, sex);
                    assert!(hero_disp >= 100, "invalid hero display {hero_disp}");
                }
            }
            assert!(
                class.weapon_display() >= 50000,
                "invalid weapon display for {}",
                class.name
            );
        }
    }

    #[test]
    fn session_channels_exchange_packets_and_track_peers() {
        let (a_tx, b_rx) = crossbeam_channel::bounded(16);
        let (b_tx, a_rx) = crossbeam_channel::bounded(16);
        let mut host = CoopSession::with_channels(100, CoopMode::Host, a_tx, a_rx);
        let mut client = CoopSession::with_channels(200, CoopMode::Join, b_tx, b_rx);

        host.send_start_run(1, 0xBEEF_1234, 0.0);
        client.send_shared_xp(25.0);

        let client_pkts = client.poll_packets(0.05);
        assert_eq!(
            client_pkts,
            vec![CoopPacket::StartRun {
                map_idx: 1,
                seed: 0xBEEF_1234,
                host_time: 0.0,
            }]
        );

        let host_pkts = host.poll_packets(0.05);
        assert_eq!(
            host_pkts,
            vec![CoopPacket::SharedXp {
                peer_id: 200,
                amount: 25.0,
            }]
        );

        host.upsert_peer(200, 1, 1, 0, 1, Some("Human Bastion".to_string()));
        assert_eq!(host.party_count(), 2);
        assert_eq!(host.living_allies_count(), 1);
    }
}
