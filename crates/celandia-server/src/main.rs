//! `celandia-server` — Authoritative Native Rust 1.12.1 (build 5875) Realm + World Server
//! for Celandia: Xirtoth (Survivors & Client-Server RPG/MMO).
//!
//! Runs both:
//! - SRP6 Authentication & Realm List server (`:3724`)
//! - Authoritative World Server (`:8085`) with 6 Celandia Kingdoms, 1 Instance (`The Elsewhere Sanctum`),
//!   16 Cast/Envoy NPCs, 11 hostile Fauna & Boss templates, 8 Quests, 12 Items, 15 Spells,
//!   100ms AI tick loop, combat/loot/XP progression, and persistent JSON database.

pub mod auth;
pub mod combat;
pub mod crypto;
pub mod db;
pub mod opcodes;
pub mod quests;
pub mod spawns;
pub mod world;

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tokio::net::TcpListener;
use tracing::info;

use crate::auth::{AuthConfig, run_auth_listener};
use crate::db::CelandiaDb;
use crate::world::run_world_listener;

#[derive(Parser, Debug)]
#[command(
    name = "celandia-server",
    about = "Celandia: Xirtoth Authoritative 1.12.1 (5875) Realm & World Server"
)]
struct Cli {
    /// TCP bind address for the SRP6 Auth / Realmlist server (default: 0.0.0.0:3724)
    #[arg(long, default_value = "0.0.0.0:3724")]
    auth_bind: SocketAddr,

    /// TCP bind address for the World server (default: 0.0.0.0:8085)
    #[arg(long, default_value = "0.0.0.0:8085")]
    world_bind: SocketAddr,

    /// Public address advertised in CMD_REALM_LIST for the World server
    #[arg(long, default_value = "127.0.0.1:8085")]
    public_world_addr: String,

    /// Realm name advertised to clients
    #[arg(long, default_value = "Wokecraft NoW — Celandia")]
    realm_name: String,

    /// Path to the persistent JSON database file
    #[arg(long, default_value = "celandia-db.json")]
    db_path: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().init();

    let mut cli = Cli::parse();
    if let Ok(env_pub) = std::env::var("CELANDIA_PUBLIC_WORLD_ADDR") {
        if !env_pub.trim().is_empty() {
            cli.public_world_addr = env_pub;
        }
    }
    if let Ok(env_realm) = std::env::var("CELANDIA_REALM_NAME") {
        if !env_realm.trim().is_empty() {
            cli.realm_name = env_realm;
        }
    }

    info!(
        "Starting Celandia Authoritative Server (Realm='{}', Auth={}, World={}, PublicWorld={})",
        cli.realm_name, cli.auth_bind, cli.world_bind, cli.public_world_addr
    );

    let db = CelandiaDb::open(Some(cli.db_path.clone()));
    let auth_cfg = AuthConfig {
        realm_name: cli.realm_name.clone(),
        public_world_addr: cli.public_world_addr.clone(),
    };

    let auth_listener = TcpListener::bind(cli.auth_bind).await?;
    let world_listener = TcpListener::bind(cli.world_bind).await?;

    let db_auth = db.clone();
    let auth_task = tokio::spawn(async move {
        if let Err(err) = run_auth_listener(auth_listener, db_auth, auth_cfg).await {
            tracing::error!("Auth server terminated with error: {err:#}");
        }
    });

    let db_world = db.clone();
    let world_task = tokio::spawn(async move {
        if let Err(err) = run_world_listener(world_listener, db_world).await {
            tracing::error!("World server terminated with error: {err:#}");
        }
    });

    tokio::select! {
        _ = auth_task => {},
        _ = world_task => {},
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combat::*;
    use crate::opcodes::*;
    use crate::quests::*;
    use crate::spawns::*;
    use crate::world::{
        ActivePlayer, WorldState, build_login_update_object_packet, encode_char_enum,
        encode_creature_query_response,
    };
    use benilla_protocol::messages::{ServerPacket, parse_server_with_tail};
    use tokio::sync::mpsc;

    #[test]
    fn all_celandia_packets_decode_cleanly_in_benilla_protocol() {
        let db = CelandiaDb::in_memory();
        let chars = db.characters_for_account("CELANDIA");
        assert!(!chars.is_empty());

        // 1. SMSG_CHAR_ENUM
        let char_enum_bytes = encode_char_enum(&chars);
        let (msg, tail) =
            parse_server_with_tail(SMSG_CHAR_ENUM, &char_enum_bytes).expect("SMSG_CHAR_ENUM must parse");
        assert_eq!(tail, 0, "SMSG_CHAR_ENUM must have 0 trailing bytes");
        if let ServerPacket::CharEnum { characters } = msg {
            assert_eq!(characters.len(), chars.len());
            assert_eq!(characters[0].name, "Rook");
        } else {
            panic!("Expected ServerPacket::CharEnum");
        }

        // 2. SMSG_UPDATE_OBJECT (full login packet with self player + items + 50+ creatures)
        let mut ws = WorldState::new(db.clone());
        let (tx, _rx) = mpsc::unbounded_channel();
        let rook = chars[0].clone();
        let rook_guid = rook.guid();
        ws.players.insert(
            rook_guid,
            ActivePlayer {
                session_id: 1,
                character: rook.clone(),
                selected_target: 0,
                auto_attacking: false,
                last_melee_tick: 0,
                move_flags: 0,
                move_time: 0,
                speed_counter: 1,
                teleport_counter: 1,
                tx,
            },
        );
        let update_bytes = build_login_update_object_packet(&ws, rook_guid);
        let (msg, tail) = parse_server_with_tail(SMSG_UPDATE_OBJECT, &update_bytes)
            .expect("SMSG_UPDATE_OBJECT must parse");
        assert_eq!(tail, 0, "SMSG_UPDATE_OBJECT must have 0 trailing bytes");
        if let ServerPacket::UpdateObject { objects } = msg {
            assert!(
                objects.len() > 40,
                "Expected player + items + Map 0 creatures in UpdateObject batch"
            );
        } else {
            panic!("Expected ServerPacket::UpdateObject");
        }

        // 3. SMSG_CREATURE_QUERY_RESPONSE for every Celandia creature template
        for tpl in CREATURE_TEMPLATES {
            let pkt = encode_creature_query_response(tpl.entry);
            let (msg, tail) = parse_server_with_tail(SMSG_CREATURE_QUERY_RESPONSE, &pkt)
                .expect("SMSG_CREATURE_QUERY_RESPONSE must parse");
            assert_eq!(tail, 0);
            if let ServerPacket::CreatureQueryResponse {
                entry,
                info: Some(info),
            } = msg
            {
                assert_eq!(entry, tpl.entry);
                assert_eq!(info.name, tpl.name);
                assert_eq!(info.display_id, tpl.display_id);
            } else {
                panic!("Expected CreatureQueryResponse");
            }
        }

        // 4. SMSG_ITEM_QUERY_SINGLE_RESPONSE for every Celandia item template
        for item in ITEM_TEMPLATES {
            let pkt = encode_item_query_response(item.entry, Some(item));
            let (msg, tail) = parse_server_with_tail(SMSG_ITEM_QUERY_SINGLE_RESPONSE, &pkt)
                .expect("SMSG_ITEM_QUERY_SINGLE_RESPONSE must parse");
            assert_eq!(tail, 0);
            if let ServerPacket::ItemQueryResponse {
                entry,
                info: Some(info),
            } = msg
            {
                assert_eq!(entry, item.entry);
                assert_eq!(info.name, item.name);
                assert_eq!(info.display_info_id, item.display_id);
            } else {
                panic!("Expected ItemQueryResponse");
            }
        }

        // 5. SMSG_QUEST_QUERY_RESPONSE, SMSG_QUESTGIVER_QUEST_DETAILS, OFFER_REWARD, COMPLETE
        let npc_guid = make_unit_guid(1001, 1);
        for q in QUEST_TEMPLATES {
            let q_pkt = encode_quest_query_response(q);
            let (_, tail) = parse_server_with_tail(SMSG_QUEST_QUERY_RESPONSE, &q_pkt)
                .expect("SMSG_QUEST_QUERY_RESPONSE must parse");
            assert_eq!(tail, 0);

            let det_pkt = encode_questgiver_quest_details(npc_guid, q);
            let (_, tail) = parse_server_with_tail(SMSG_QUESTGIVER_QUEST_DETAILS, &det_pkt)
                .expect("SMSG_QUESTGIVER_QUEST_DETAILS must parse");
            assert_eq!(tail, 0);

            let rew_pkt = encode_questgiver_offer_reward(npc_guid, q);
            let (_, tail) = parse_server_with_tail(SMSG_QUESTGIVER_OFFER_REWARD, &rew_pkt)
                .expect("SMSG_QUESTGIVER_OFFER_REWARD must parse");
            assert_eq!(tail, 0);

            let cmp_pkt = encode_questgiver_quest_complete(q, 0);
            let (_, tail) = parse_server_with_tail(SMSG_QUESTGIVER_QUEST_COMPLETE, &cmp_pkt)
                .expect("SMSG_QUESTGIVER_QUEST_COMPLETE must parse");
            assert_eq!(tail, 0);
        }

        // 6. SMSG_NPC_TEXT_UPDATE & SMSG_GOSSIP_MESSAGE
        let text_pkt = encode_npc_text_update(1001);
        let (_, tail) = parse_server_with_tail(SMSG_NPC_TEXT_UPDATE, &text_pkt)
            .expect("SMSG_NPC_TEXT_UPDATE must parse");
        assert_eq!(tail, 0);

        let options = get_npc_gossip_options(1007);
        let gossip_pkt =
            encode_gossip_message(npc_guid, 1007, &options, &[(&QUEST_TEMPLATES[0], 5)]);
        let (_, tail) = parse_server_with_tail(SMSG_GOSSIP_MESSAGE, &gossip_pkt)
            .expect("SMSG_GOSSIP_MESSAGE must parse");
        assert_eq!(tail, 0);

        // 7. Combat & Spell & Loot & XP packets
        let mob_guid = make_unit_guid(2001, 20);
        let atk_pkt = encode_attacker_state_update(rook_guid, mob_guid, 42, true);
        let (_, tail) = parse_server_with_tail(SMSG_ATTACKERSTATEUPDATE, &atk_pkt)
            .expect("SMSG_ATTACKERSTATEUPDATE must parse");
        assert_eq!(tail, 0);

        let sp_start = encode_spell_start(rook_guid, mob_guid, 60001);
        let (_, tail) =
            parse_server_with_tail(SMSG_SPELL_START, &sp_start).expect("SMSG_SPELL_START must parse");
        assert_eq!(tail, 0);

        let sp_go = encode_spell_go(rook_guid, mob_guid, &[mob_guid], 60001);
        let (_, tail) =
            parse_server_with_tail(SMSG_SPELL_GO, &sp_go).expect("SMSG_SPELL_GO must parse");
        assert_eq!(tail, 0);

        let sp_dmg = encode_spell_non_melee_damage_log(mob_guid, rook_guid, 60001, 95, 2, false);
        let (_, tail) = parse_server_with_tail(SMSG_SPELLNONMELEEDAMAGELOG, &sp_dmg)
            .expect("SMSG_SPELLNONMELEEDAMAGELOG must parse");
        assert_eq!(tail, 0);

        let mmove = encode_monster_move(mob_guid, (0.0, 0.0, 10.0), (5.0, 5.0, 10.0), 42, 600);
        let (_, tail) =
            parse_server_with_tail(SMSG_MONSTER_MOVE, &mmove).expect("SMSG_MONSTER_MOVE must parse");
        assert_eq!(tail, 0);

        let loot_pkt = encode_loot_response(mob_guid, 25, &[50008]);
        let (_, tail) = parse_server_with_tail(SMSG_LOOT_RESPONSE, &loot_pkt)
            .expect("SMSG_LOOT_RESPONSE must parse");
        assert_eq!(tail, 0);

        let xp_pkt = encode_log_xp_gain(mob_guid, 120, true);
        let (_, tail) =
            parse_server_with_tail(SMSG_LOG_XPGAIN, &xp_pkt).expect("SMSG_LOG_XPGAIN must parse");
        assert_eq!(tail, 0);

        let lvl_pkt = encode_levelup_info(2, 40, 20);
        let (_, tail) =
            parse_server_with_tail(SMSG_LEVELUP_INFO, &lvl_pkt).expect("SMSG_LEVELUP_INFO must parse");
        assert_eq!(tail, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn end_to_end_auth_and_world_session_with_benilla_protocol() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let db = CelandiaDb::in_memory();

            // Bind ephemeral ports for auth & world
            let auth_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let auth_addr = auth_listener.local_addr().unwrap();

            let world_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let world_addr = world_listener.local_addr().unwrap();

            let auth_cfg = AuthConfig {
                realm_name: "Wokecraft NoW — Celandia".to_string(),
                public_world_addr: world_addr.to_string(),
            };

            let db_auth = db.clone();
            let auth_handle = tokio::spawn(async move {
                let _ = run_auth_listener(auth_listener, db_auth, auth_cfg).await;
            });

            let db_world = db.clone();
            let world_handle = tokio::spawn(async move {
                let _ = run_world_listener(world_listener, db_world).await;
            });

            // 1. Connect to Auth Server with benilla_protocol::logon_async
            let logon =
                benilla_protocol::logon_async(&auth_addr.to_string(), "CELANDIA", "CELANDIA")
                    .await
                    .expect("SRP6 logon_async must succeed");

            assert_eq!(logon.realms.len(), 1);
            assert_eq!(logon.realms[0].name, "Wokecraft NoW — Celandia");
            assert_eq!(logon.realms[0].address, world_addr.to_string());

            // 2. Connect to World Server with benilla_protocol::WorldSession::connect_async
            let mut world_session = benilla_protocol::WorldSession::connect_async(
                &world_addr.to_string(),
                "CELANDIA",
                logon.session_key,
            )
            .await
            .expect("WorldSession::connect_async must succeed");

            // 3. Request character list (char_enum_async)
            let chars = world_session
                .char_enum_async()
                .await
                .expect("char_enum_async must succeed");
            assert!(!chars.is_empty());
            assert_eq!(chars[0].name, "Rook");
            let rook_guid = chars[0].guid;

            // 4. Enter world as Rook (player_login)
            world_session
                .player_login(rook_guid)
                .expect("player_login must succeed");

            // Receive login sequence including SMSG_UPDATE_OBJECT
            let mut got_update_object = false;
            for _ in 0..16 {
                let pkt = world_session.recv_async().await.unwrap();
                if let ServerPacket::UpdateObject { objects } = pkt {
                    assert!(objects.len() > 40);
                    got_update_object = true;
                    break;
                }
            }
            assert!(
                got_update_object,
                "Must receive SMSG_UPDATE_OBJECT upon login"
            );

            auth_handle.abort();
            world_handle.abort();
        })
        .await
        .expect("end-to-end auth and world session test timed out");
    }
}
