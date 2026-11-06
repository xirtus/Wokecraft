//! WoW 1.12.1 (build 5875) Realm Authentication Server (`realmd` `:3724`).

use std::net::SocketAddr;

use anyhow::Result;
use benilla_srp::LARGE_SAFE_PRIME_LITTLE_ENDIAN;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, info, warn};

use crate::crypto::{SrpServerChallenge, GENERATOR};
use crate::db::CelandiaDb;
use crate::opcodes::{
    CMD_AUTH_LOGON_CHALLENGE, CMD_AUTH_LOGON_PROOF, CMD_AUTH_RECONNECT_CHALLENGE,
    CMD_AUTH_RECONNECT_PROOF, CMD_REALM_LIST, WOW_FAIL_INCORRECT_PASSWORD, WOW_SUCCESS,
};

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub realm_name: String,
    pub public_world_addr: String,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            realm_name: "Wokecraft NoW — Celandia".to_string(),
            public_world_addr: "127.0.0.1:8085".to_string(),
        }
    }
}

pub async fn run_auth_listener(
    listener: TcpListener,
    db: CelandiaDb,
    config: AuthConfig,
) -> Result<()> {
    let local_addr = listener.local_addr()?;
    info!("Celandia Auth Server (realmd) listening on {local_addr}");
    loop {
        let (stream, peer) = listener.accept().await?;
        let db_clone = db.clone();
        let cfg_clone = config.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_auth_client(stream, peer, db_clone, cfg_clone).await {
                debug!("Auth client {peer} closed: {e}");
            }
        });
    }
}

async fn handle_auth_client(
    mut stream: TcpStream,
    peer: SocketAddr,
    db: CelandiaDb,
    config: AuthConfig,
) -> Result<()> {
    let _ = stream.set_nodelay(true);
    let mut challenge_state: Option<SrpServerChallenge> = None;
    let mut authed_user: Option<String> = None;

    loop {
        let mut cmd_buf = [0u8; 1];
        match stream.read_exact(&mut cmd_buf).await {
            Ok(_) => {}
            Err(_) => return Ok(()),
        }
        let cmd = cmd_buf[0];

        match cmd {
            CMD_AUTH_LOGON_CHALLENGE | CMD_AUTH_RECONNECT_CHALLENGE => {
                let mut hdr = [0u8; 3];
                stream.read_exact(&mut hdr).await?;
                let body_size = u16::from_le_bytes([hdr[1], hdr[2]]) as usize;
                if body_size < 30 || body_size > 512 {
                    anyhow::bail!("invalid logon challenge body_size={body_size}");
                }
                let mut body = vec![0u8; body_size];
                stream.read_exact(&mut body).await?;

                let i_len = body[29] as usize;
                if 30 + i_len > body.len() {
                    anyhow::bail!("truncated username in logon challenge");
                }
                let username = String::from_utf8_lossy(&body[30..30 + i_len]).to_string();
                let acc = db.get_or_autocreate_account(&username);
                let challenge = SrpServerChallenge::new(&acc.username, acc.salt, acc.verifier);

                let mut resp = Vec::with_capacity(119);
                resp.push(CMD_AUTH_LOGON_CHALLENGE);
                resp.push(0x00); // protocol
                resp.push(WOW_SUCCESS);
                resp.extend_from_slice(&challenge.b_pub);
                resp.push(1); // g_len
                resp.push(GENERATOR);
                resp.push(32); // n_len
                resp.extend_from_slice(&LARGE_SAFE_PRIME_LITTLE_ENDIAN);
                resp.extend_from_slice(&challenge.salt);
                resp.extend_from_slice(b"CELANDIA_OPEN_V1"); // crc_salt signaling open Celandia registration
                resp.push(0); // security_flag = 0

                stream.write_all(&resp).await?;
                stream.flush().await?;
                debug!("Auth challenge sent to {} ({})", acc.username, peer);
                challenge_state = Some(challenge);
            }
            CMD_AUTH_LOGON_PROOF => {
                let mut body = [0u8; 74];
                stream.read_exact(&mut body).await?;
                let Some(ref chal) = challenge_state else {
                    stream
                        .write_all(&[CMD_AUTH_LOGON_PROOF, WOW_FAIL_INCORRECT_PASSWORD])
                        .await?;
                    stream.flush().await?;
                    continue;
                };

                let mut client_a = [0u8; 32];
                client_a.copy_from_slice(&body[0..32]);
                let mut client_m1 = [0u8; 20];
                client_m1.copy_from_slice(&body[32..52]);

                if let Some((session_key, m2)) = chal.verify_client_proof(&client_a, &client_m1) {
                    db.save_session_key(&chal.username, session_key);
                    authed_user = Some(chal.username.clone());

                    let mut resp = Vec::with_capacity(26);
                    resp.push(CMD_AUTH_LOGON_PROOF);
                    resp.push(WOW_SUCCESS);
                    resp.extend_from_slice(&m2);
                    resp.extend_from_slice(&0u32.to_le_bytes()); // survey_id = 0
                    stream.write_all(&resp).await?;
                    stream.flush().await?;
                    info!("Account '{}' authenticated via SRP6 from {peer}", chal.username);
                } else {
                    warn!("SRP6 proof mismatch for account '{}'", chal.username);
                    stream
                        .write_all(&[CMD_AUTH_LOGON_PROOF, WOW_FAIL_INCORRECT_PASSWORD])
                        .await?;
                    stream.flush().await?;
                }
            }
            CMD_AUTH_RECONNECT_PROOF => {
                let mut body = [0u8; 57];
                stream.read_exact(&mut body).await?;
                stream
                    .write_all(&[CMD_AUTH_RECONNECT_PROOF, WOW_SUCCESS])
                    .await?;
                stream.flush().await?;
            }
            CMD_REALM_LIST => {
                let mut pad = [0u8; 4];
                stream.read_exact(&mut pad).await?;

                let char_count = authed_user
                    .as_deref()
                    .map_or(1, |u| db.characters_for_account(u).len() as u8);

                let mut payload = Vec::with_capacity(96);
                payload.extend_from_slice(&0u32.to_le_bytes()); // header padding
                payload.push(1); // 1 realm

                // Realm entry
                payload.extend_from_slice(&0u32.to_le_bytes()); // realm_type = 0 (Normal)
                payload.push(0); // flags = 0 (Online)
                payload.extend_from_slice(config.realm_name.as_bytes());
                payload.push(0);
                payload.extend_from_slice(config.public_world_addr.as_bytes());
                payload.push(0);
                payload.extend_from_slice(&1.0f32.to_le_bytes()); // population
                payload.push(char_count.max(1)); // characters
                payload.push(1); // category = 1
                payload.push(1); // realm_id = 1

                payload.extend_from_slice(&0u16.to_le_bytes()); // footer padding

                let mut resp = Vec::with_capacity(3 + payload.len());
                resp.push(CMD_REALM_LIST);
                resp.extend_from_slice(&(payload.len() as u16).to_le_bytes());
                resp.extend_from_slice(&payload);

                stream.write_all(&resp).await?;
                stream.flush().await?;
                debug!(
                    "Sent realm list ('{}' -> {}) to {peer}",
                    config.realm_name, config.public_world_addr
                );
            }
            other => {
                debug!("Unknown realmd opcode 0x{other:02X} from {peer}");
                return Ok(());
            }
        }
    }
}
