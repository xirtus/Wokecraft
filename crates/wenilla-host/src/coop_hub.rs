//! `GET /ws/survivors/{room}` — real-time Multiplayer Co-Op WebSocket room relay for Survivors Mode
//! (`warcraft-survivors`).
//!
//! Up to [`MAX_ROOM_PEERS`] (8) players can join a named room (`/ws/survivors/{room}`, or
//! `/ws/survivors` for the `"default"` room). Every binary `CoopPacket` sent by a peer is fanned
//! out with zero framing overhead to all other peers in the same room. The room also caches each
//! connected peer's latest `Hello` and `HeroState` packets (plus the room's active `StartRun`
//! seed/map packet) so newcomers joining a lobby or an in-progress run immediately synchronize with
//! the party.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast;

/// Maximum co-op party size in a single Survivors room.
pub const MAX_ROOM_PEERS: usize = 8;

/// Wire magic prefix for Survivors Co-Op packets (`"CXCP"`).
pub const PACKET_MAGIC: [u8; 4] = *b"CXCP";
/// Wire protocol version.
pub const PACKET_VERSION: u8 = 1;

pub const TAG_HELLO: u8 = 1;
pub const TAG_START_RUN: u8 = 2;
pub const TAG_HERO_STATE: u8 = 3;
pub const TAG_CAST_VISUAL: u8 = 4;
pub const TAG_SHARED_XP: u8 = 5;
pub const TAG_REVIVE: u8 = 6;

#[derive(Default, Clone)]
struct PeerSnapshot {
    peer_id: Option<u32>,
    hello: Option<Vec<u8>>,
    hero_state: Option<Vec<u8>>,
}

#[derive(Default)]
struct RoomInner {
    peers: HashMap<u64, PeerSnapshot>,
    start_run: Option<Vec<u8>>,
}

struct Room {
    tx: broadcast::Sender<(u64, Vec<u8>)>,
    inner: Mutex<RoomInner>,
}

impl Room {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            tx,
            inner: Mutex::new(RoomInner::default()),
        }
    }
}

/// Shared state for all active Survivors Co-Op rooms on this `wenilla-host`.
#[derive(Clone, Default)]
pub struct CoopHub {
    rooms: Arc<Mutex<HashMap<String, Arc<Room>>>>,
    next_conn_id: Arc<AtomicU64>,
}

/// Handle held by an active peer connection in a room; removes the peer on drop.
pub struct RoomLease {
    hub: CoopHub,
    room_name: String,
    room: Arc<Room>,
    pub conn_id: u64,
    pub rx: broadcast::Receiver<(u64, Vec<u8>)>,
    /// Cached packets (`Hello`, `HeroState`, `StartRun`) from peers already in the room.
    pub initial_packets: Vec<Vec<u8>>,
}

impl CoopHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of currently active connections in `room_name`.
    pub fn room_peer_count(&self, room_name: &str) -> usize {
        let rooms = self.rooms.lock().expect("coop hub lock");
        rooms
            .get(room_name)
            .map(|r| r.inner.lock().expect("room lock").peers.len())
            .unwrap_or(0)
    }

    /// Attempt to join `room_name`. Fails with `None` if the room name is invalid or the room is
    /// already at [`MAX_ROOM_PEERS`].
    pub fn join_room(&self, room_name: &str) -> Option<RoomLease> {
        let room_name = sanitize_room_name(room_name)?;
        let room = {
            let mut rooms = self.rooms.lock().expect("coop hub lock");
            Arc::clone(rooms.entry(room_name.clone()).or_insert_with(|| Arc::new(Room::new())))
        };

        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed) + 1;
        let rx = room.tx.subscribe();
        let initial_packets = {
            let mut inner = room.inner.lock().expect("room lock");
            if inner.peers.len() >= MAX_ROOM_PEERS {
                return None;
            }
            let mut snapshot = Vec::new();
            for peer in inner.peers.values() {
                if let Some(hello) = &peer.hello {
                    snapshot.push(hello.clone());
                }
                if let Some(state) = &peer.hero_state {
                    snapshot.push(state.clone());
                }
            }
            if let Some(start) = &inner.start_run {
                snapshot.push(start.clone());
            }
            inner.peers.insert(conn_id, PeerSnapshot::default());
            snapshot
        };

        Some(RoomLease {
            hub: self.clone(),
            room_name,
            room,
            conn_id,
            rx,
            initial_packets,
        })
    }

    fn leave_room(&self, room_name: &str, conn_id: u64) {
        let mut rooms = self.rooms.lock().expect("coop hub lock");
        let empty = if let Some(room) = rooms.get(room_name) {
            let mut inner = room.inner.lock().expect("room lock");
            inner.peers.remove(&conn_id);
            inner.peers.is_empty()
        } else {
            false
        };
        if empty {
            rooms.remove(room_name);
        }
    }
}

impl RoomLease {
    /// Process an inbound packet from this connection: update room snapshot caches if it is a
    /// valid `CoopPacket` (`Hello`, `HeroState`, or `StartRun`) and broadcast to all other peers
    /// in the room.
    pub fn broadcast(&self, data: Vec<u8>) {
        if data.len() >= 6 && data[0..4] == PACKET_MAGIC && data[4] == PACKET_VERSION {
            let tag = data[5];
            let mut inner = self.room.inner.lock().expect("room lock");
            match tag {
                TAG_HELLO if data.len() >= 10 => {
                    let peer_id = u32::from_le_bytes([data[6], data[7], data[8], data[9]]);
                    if let Some(slot) = inner.peers.get_mut(&self.conn_id) {
                        slot.peer_id = Some(peer_id);
                        slot.hello = Some(data.clone());
                    }
                }
                TAG_HERO_STATE if data.len() >= 10 => {
                    let peer_id = u32::from_le_bytes([data[6], data[7], data[8], data[9]]);
                    if let Some(slot) = inner.peers.get_mut(&self.conn_id) {
                        slot.peer_id = Some(peer_id);
                        slot.hero_state = Some(data.clone());
                    }
                }
                TAG_START_RUN => {
                    inner.start_run = Some(data.clone());
                }
                _ => {}
            }
        }
        let _ = self.room.tx.send((self.conn_id, data));
    }
}

impl Drop for RoomLease {
    fn drop(&mut self) {
        self.hub.leave_room(&self.room_name, self.conn_id);
    }
}

fn sanitize_room_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return None;
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.'))
    {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

/// Build the `/ws/survivors/{room}` and `/ws/survivors` router with a fresh [`CoopHub`].
pub fn router() -> Router {
    router_with_hub(CoopHub::new())
}

/// Build the `/ws/survivors/{room}` router backed by the given [`CoopHub`].
pub fn router_with_hub(hub: CoopHub) -> Router {
    Router::new()
        .route("/ws/survivors/{room}", get(upgrade_room))
        .route("/ws/survivors", get(upgrade_default_room))
        .with_state(hub)
}

async fn upgrade_default_room(State(hub): State<CoopHub>, ws: WebSocketUpgrade) -> Response {
    upgrade_room(State(hub), Path("default".to_string()), ws).await
}

async fn upgrade_room(
    State(hub): State<CoopHub>,
    Path(room): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(lease) = hub.join_room(&room) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    ws.on_upgrade(move |socket| handle_socket(socket, lease))
}

async fn handle_socket(ws: WebSocket, mut lease: RoomLease) {
    let (mut ws_tx, mut ws_rx) = ws.split();

    for pkt in lease.initial_packets.drain(..) {
        if ws_tx.send(Message::Binary(pkt.into())).await.is_err() {
            return;
        }
    }

    let my_conn_id = lease.conn_id;
    loop {
        tokio::select! {
            inbound = ws_rx.next() => {
                match inbound {
                    Some(Ok(Message::Binary(bytes))) => {
                        lease.broadcast(bytes.to_vec());
                    }
                    Some(Ok(Message::Text(text))) => {
                        lease.broadcast(text.as_bytes().to_vec());
                    }
                    Some(Ok(Message::Ping(p))) => {
                        if ws_tx.send(Message::Pong(p)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        let _ = ws_tx.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            outbound = lease.rx.recv() => {
                match outbound {
                    Ok((sender_id, data)) if sender_id != my_conn_id => {
                        if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::Message as WsMsg;

    fn make_hello(peer_id: u32, class_id: u8) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&PACKET_MAGIC);
        v.push(PACKET_VERSION);
        v.push(TAG_HELLO);
        v.extend_from_slice(&peer_id.to_le_bytes());
        v.push(class_id);
        v
    }

    fn make_start_run(map_idx: u8, seed: u64) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&PACKET_MAGIC);
        v.push(PACKET_VERSION);
        v.push(TAG_START_RUN);
        v.push(map_idx);
        v.extend_from_slice(&seed.to_le_bytes());
        v
    }

    #[test]
    fn room_state_tracks_peers_enforces_cap_and_replays_cached_packets() {
        let hub = CoopHub::new();
        assert_eq!(hub.room_peer_count("celandia"), 0);

        let peer1 = hub.join_room("Celandia").expect("join peer 1");
        assert_eq!(hub.room_peer_count("celandia"), 1);

        let hello1 = make_hello(101, 1);
        let start = make_start_run(2, 0xCAFE_BABE_1234_5678);
        peer1.broadcast(hello1.clone());
        peer1.broadcast(start.clone());

        // Peer 2 joining the same room (case-insensitive) receives cached Hello and StartRun.
        let mut peer2 = hub.join_room("celandia").expect("join peer 2");
        assert_eq!(hub.room_peer_count("celandia"), 2);
        assert_eq!(peer2.initial_packets, vec![hello1.clone(), start.clone()]);

        // Live broadcast from peer 2 reaches peer 1, not echoed back as sender's own ID.
        let hello2 = make_hello(202, 5);
        peer2.broadcast(hello2.clone());
        let (sender_id, payload) = peer2.rx.try_recv().expect("broadcast queued");
        assert_eq!(sender_id, peer2.conn_id);
        assert_eq!(payload, hello2);

        // Fill up to MAX_ROOM_PEERS (8).
        let mut extras = Vec::new();
        for _ in 2..MAX_ROOM_PEERS {
            extras.push(hub.join_room("celandia").expect("join up to cap"));
        }
        assert_eq!(hub.room_peer_count("celandia"), MAX_ROOM_PEERS);
        assert!(
            hub.join_room("celandia").is_none(),
            "9th peer must be rejected"
        );

        // Dropping peers cleans up the room.
        drop(extras);
        drop(peer1);
        drop(peer2);
        assert_eq!(hub.room_peer_count("celandia"), 0);
    }

    #[tokio::test]
    async fn websocket_room_relays_packets_between_peers_and_isolates_rooms() {
        let hub = CoopHub::new();
        let app = router_with_hub(hub.clone());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let url_a1 = format!("ws://{addr}/ws/survivors/wake-1");
        let url_a2 = format!("ws://{addr}/ws/survivors/wake-1");
        let url_b = format!("ws://{addr}/ws/survivors/other-room");

        let (ws_a1, _) = tokio_tungstenite::connect_async(&url_a1).await.expect("a1");
        let (mut tx_a1, mut rx_a1) = ws_a1.split();

        let hello_a1 = make_hello(11, 2);
        tx_a1
            .send(WsMsg::Binary(hello_a1.clone().into()))
            .await
            .expect("send hello a1");

        // Give the server task a moment to process hello_a1 before a2 joins.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let (ws_a2, _) = tokio_tungstenite::connect_async(&url_a2).await.expect("a2");
        let (mut tx_a2, mut rx_a2) = ws_a2.split();

        let (ws_b, _) = tokio_tungstenite::connect_async(&url_b).await.expect("b");
        let (mut tx_b, _rx_b) = ws_b.split();

        // a2 should immediately receive a1's cached Hello packet.
        let cached = rx_a2.next().await.expect("frame").expect("ok");
        assert_eq!(cached.into_data().as_ref(), hello_a1.as_slice());

        // a2 sends a CastVisual packet; a1 receives it.
        let cast_pkt = vec![b'C', b'X', b'C', b'P', 1, TAG_CAST_VISUAL, 22, 0, 0, 0];
        tx_a2
            .send(WsMsg::Binary(cast_pkt.clone().into()))
            .await
            .expect("send cast");

        // b in another room sends a packet; a1 must NOT receive b's packet.
        tx_b.send(WsMsg::Binary(vec![9, 9, 9].into()))
            .await
            .expect("send b");

        let from_a2 = rx_a1.next().await.expect("frame").expect("ok");
        assert_eq!(from_a2.into_data().as_ref(), cast_pkt.as_slice());

        tx_a1.close().await.ok();
        tx_a2.close().await.ok();
        tx_b.close().await.ok();
    }
}
