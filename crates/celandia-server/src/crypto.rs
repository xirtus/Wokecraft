//! WoW 1.12.1 (build 5875) SRP6 Server Authentication and World Header Stream Cipher.

use benilla_srp::LARGE_SAFE_PRIME_LITTLE_ENDIAN;
use num_bigint::BigUint;
use rand::RngCore;
use sha1::{Digest, Sha1};

pub const GENERATOR: u8 = 7;
pub const K_VALUE: u8 = 3;
pub const SESSION_KEY_LEN: usize = 40;

fn sha1_bytes(parts: &[&[u8]]) -> [u8; 20] {
    let mut hasher = Sha1::new();
    for p in parts {
        hasher.update(p);
    }
    hasher.finalize().into()
}

fn xor_hash_prime_gen() -> [u8; 20] {
    let n_hash = sha1_bytes(&[&LARGE_SAFE_PRIME_LITTLE_ENDIAN]);
    let g_hash = sha1_bytes(&[&[GENERATOR]]);
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = n_hash[i] ^ g_hash[i];
    }
    out
}

fn bigint_to_32_le(n: &BigUint) -> [u8; 32] {
    let bytes = n.to_bytes_le();
    let mut out = [0u8; 32];
    let len = bytes.len().min(32);
    out[..len].copy_from_slice(&bytes[..len]);
    out
}

/// Generate a width-stable 32-byte salt (`salt[31] != 0`).
pub fn generate_salt() -> [u8; 32] {
    let mut salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);
    if salt[31] == 0 {
        salt[31] = 0x80;
    }
    salt
}

/// Compute the 32-byte little-endian SRP6 password verifier `v = g^x mod N`
/// where `x = SHA1(salt | SHA1(UPPER(username) ":" UPPER(password)))`.
pub fn compute_verifier(username: &str, password: &str, salt: &[u8; 32]) -> [u8; 32] {
    let user_up = username.trim().to_ascii_uppercase();
    let pass_up = password.trim().to_ascii_uppercase();
    let cred = format!("{user_up}:{pass_up}");
    let i_hash = sha1_bytes(&[cred.as_bytes()]);
    let x_hash = sha1_bytes(&[salt, &i_hash]);

    let n = BigUint::from_bytes_le(&LARGE_SAFE_PRIME_LITTLE_ENDIAN);
    let g = BigUint::from(GENERATOR);
    let x = BigUint::from_bytes_le(&x_hash);
    let v = g.modpow(&x, &n);
    bigint_to_32_le(&v)
}

/// Interleave the 32-byte shared secret `S` into a 40-byte session key `K` using WoW's `SHA_Interleave`.
pub fn interleave_session_key(s: &[u8; 32]) -> [u8; 40] {
    let mut even = [0u8; 16];
    let mut odd = [0u8; 16];
    for idx in 0..16 {
        even[idx] = s[idx * 2];
        odd[idx] = s[idx * 2 + 1];
    }
    let h_even = sha1_bytes(&[&even]);
    let h_odd = sha1_bytes(&[&odd]);
    let mut k = [0u8; 40];
    for idx in 0..20 {
        k[idx * 2] = h_even[idx];
        k[idx * 2 + 1] = h_odd[idx];
    }
    k
}

/// Active server-side SRP6 challenge state for a single `CMD_AUTH_LOGON_CHALLENGE` -> `CMD_AUTH_LOGON_PROOF`.
#[derive(Debug, Clone)]
pub struct SrpServerChallenge {
    pub username: String,
    pub salt: [u8; 32],
    pub verifier: [u8; 32],
    pub b_priv: [u8; 32],
    pub b_pub: [u8; 32],
}

impl SrpServerChallenge {
    /// Draw a private ephemeral secret `b` and public key `B = (3*v + g^b) mod N`, redrawing if
    /// `B[31] == 0` so `B` is guaranteed width-stable (`benilla_srp::PublicKey::is_width_stable`).
    pub fn new(username: &str, salt: [u8; 32], verifier: [u8; 32]) -> Self {
        let n = BigUint::from_bytes_le(&LARGE_SAFE_PRIME_LITTLE_ENDIAN);
        let g = BigUint::from(GENERATOR);
        let k = BigUint::from(K_VALUE);
        let v = BigUint::from_bytes_le(&verifier);
        let kv = (&k * &v) % &n;

        let mut rng = rand::thread_rng();
        loop {
            let mut b_priv = [0u8; 32];
            rng.fill_bytes(&mut b_priv);
            b_priv[31] |= 0x80;
            let b_int = BigUint::from_bytes_le(&b_priv);
            let gb = g.modpow(&b_int, &n);
            let b_pub_int = (&kv + &gb) % &n;
            let b_pub = bigint_to_32_le(&b_pub_int);
            if b_pub[31] != 0 {
                return Self {
                    username: username.trim().to_ascii_uppercase(),
                    salt,
                    verifier,
                    b_priv,
                    b_pub,
                };
            }
        }
    }

    /// Verify client's `(A, M1)` from `CMD_AUTH_LOGON_PROOF` and return `(session_key, M2)` on match.
    pub fn verify_client_proof(
        &self,
        client_a: &[u8; 32],
        client_m1: &[u8; 20],
    ) -> Option<([u8; 40], [u8; 20])> {
        let n = BigUint::from_bytes_le(&LARGE_SAFE_PRIME_LITTLE_ENDIAN);
        let a_int = BigUint::from_bytes_le(client_a);
        if (&a_int % &n) == BigUint::from(0u8) {
            return None;
        }

        let u_hash = sha1_bytes(&[client_a, &self.b_pub]);
        let u_int = BigUint::from_bytes_le(&u_hash);
        let v_int = BigUint::from_bytes_le(&self.verifier);
        let b_int = BigUint::from_bytes_le(&self.b_priv);

        // S = (A * (v^u mod N))^b mod N
        let vu = v_int.modpow(&u_int, &n);
        let base = (&a_int * &vu) % &n;
        let s_int = base.modpow(&b_int, &n);
        let s_bytes = bigint_to_32_le(&s_int);

        let session_key = interleave_session_key(&s_bytes);
        let user_hash = sha1_bytes(&[self.username.as_bytes()]);
        let xor_hash = xor_hash_prime_gen();

        let expected_m1 = sha1_bytes(&[
            &xor_hash,
            &user_hash,
            &self.salt,
            client_a,
            &self.b_pub,
            &session_key,
        ]);

        if &expected_m1 != client_m1 {
            return None;
        }

        let m2 = sha1_bytes(&[client_a, &expected_m1, &session_key]);
        Some((session_key, m2))
    }
}

/// Verify the client's `CMSG_AUTH_SESSION` digest:
/// `SHA1(UPPER(username) | 0u32_le | client_seed_le | server_seed_le | session_key)`.
pub fn verify_world_auth_session(
    username: &str,
    client_seed: u32,
    server_seed: u32,
    session_key: &[u8; 40],
    client_proof: &[u8; 20],
) -> bool {
    let user_up = username.trim().to_ascii_uppercase();
    let expected = sha1_bytes(&[
        user_up.as_bytes(),
        &0u32.to_le_bytes(),
        &client_seed.to_le_bytes(),
        &server_seed.to_le_bytes(),
        session_key,
    ]);
    &expected == client_proof
}

/// Server-side WoW 1.12.1 world packet header cipher (symmetric counterpart to `benilla_srp::HeaderCrypto`).
#[derive(Debug, Clone)]
pub struct ServerHeaderCipher {
    session_key: [u8; SESSION_KEY_LEN],
    send_i: usize,
    send_j: u8,
    recv_i: usize,
    recv_j: u8,
}

impl ServerHeaderCipher {
    pub fn new(session_key: [u8; SESSION_KEY_LEN]) -> Self {
        Self {
            session_key,
            send_i: 0,
            send_j: 0,
            recv_i: 0,
            recv_j: 0,
        }
    }

    /// Encrypt a 4-byte server-to-client header `[size_hi, size_lo, opcode_lo, opcode_hi]`.
    pub fn encrypt_server_header(&mut self, body_len: usize, opcode: u16) -> [u8; 4] {
        let size = (body_len + 2) as u16;
        let size_be = size.to_be_bytes();
        let op_le = opcode.to_le_bytes();
        let mut hdr = [size_be[0], size_be[1], op_le[0], op_le[1]];
        for b in &mut hdr {
            let enc = (*b ^ self.session_key[self.send_i]).wrapping_add(self.send_j);
            self.send_i = (self.send_i + 1) % SESSION_KEY_LEN;
            self.send_j = enc;
            *b = enc;
        }
        hdr
    }

    /// Decrypt a 6-byte client-to-server header `[size_hi, size_lo, op0, op1, op2, op3]`,
    /// returning `(size, opcode)`. Note: `size` includes the 4-byte opcode, so body length is `size - 4`.
    pub fn decrypt_client_header(&mut self, hdr: &mut [u8; 6]) -> (u16, u32) {
        for b in hdr.iter_mut() {
            let c = *b;
            let dec = c.wrapping_sub(self.recv_j) ^ self.session_key[self.recv_i];
            self.recv_i = (self.recv_i + 1) % SESSION_KEY_LEN;
            self.recv_j = c;
            *b = dec;
        }
        let size = u16::from_be_bytes([hdr[0], hdr[1]]);
        let opcode = u32::from_le_bytes([hdr[2], hdr[3], hdr[4], hdr[5]]);
        (size, opcode)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use benilla_srp::{HeaderCrypto, NormalizedString, ProofSeed, PublicKey, SrpClientChallenge};

    #[test]
    fn srp6_handshake_and_world_cipher_match_benilla_srp() {
        let salt = generate_salt();
        let verifier = compute_verifier("rook", "porcelain", &salt);
        let server_challenge = SrpServerChallenge::new("rook", salt, verifier);

        // Client side via benilla_srp::SrpClientChallenge
        let user_n = NormalizedString::new("rook").unwrap();
        let pass_n = NormalizedString::new("porcelain").unwrap();
        let server_pub = PublicKey::from_le_bytes(server_challenge.b_pub).unwrap();
        assert!(server_pub.is_width_stable());

        let client_challenge = SrpClientChallenge::new(
            user_n.clone(),
            pass_n,
            GENERATOR,
            LARGE_SAFE_PRIME_LITTLE_ENDIAN,
            server_pub,
            salt,
        );
        let a_pub = *client_challenge.client_public_key();
        let m1 = *client_challenge.client_proof();

        let (server_k, server_m2) = server_challenge
            .verify_client_proof(&a_pub, &m1)
            .expect("SRP6 proof must verify");

        let client_srp = client_challenge
            .verify_server_proof(server_m2)
            .expect("Client must accept server M2");
        assert_eq!(&server_k, client_srp.session_key());

        // World header cipher round-trip
        let server_seed = 0xCAFE_BABEu32;
        let client_seed_pair = ProofSeed::new();
        let client_seed = client_seed_pair.seed();
        let (client_world_proof, mut client_crypto): ([u8; 20], HeaderCrypto) =
            client_seed_pair.into_client_header_crypto(&user_n, server_k, server_seed);

        assert!(verify_world_auth_session(
            "rook",
            client_seed,
            server_seed,
            &server_k,
            &client_world_proof
        ));

        let mut server_cipher = ServerHeaderCipher::new(server_k);
        // Client encrypts a 6-byte header -> Server decrypts
        let mut c2s = client_crypto.encrypter().encrypt_client_header(4, 0x003D);
        let (dec_size, dec_op) = server_cipher.decrypt_client_header(&mut c2s);
        assert_eq!(dec_size, 4);
        assert_eq!(dec_op, 0x003D);

        // Server encrypts a 4-byte header -> Client decrypts
        let s2c = server_cipher.encrypt_server_header(10, 0x01EE);
        let hdr = client_crypto.decrypter().decrypt_server_header(s2c);
        assert_eq!(hdr.size, 12);
        assert_eq!(hdr.opcode, 0x01EE);
    }
}
