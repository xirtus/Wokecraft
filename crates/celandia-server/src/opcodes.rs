//! WoW 1.12.1 (build 5875) Auth & World opcodes, GUID layout, and UpdateField indices.

// ============================================================================
// 1. Auth Server (realmd :3724) Commands & Results
// ============================================================================
pub const CMD_AUTH_LOGON_CHALLENGE: u8 = 0x00;
pub const CMD_AUTH_LOGON_PROOF: u8 = 0x01;
pub const CMD_AUTH_RECONNECT_CHALLENGE: u8 = 0x02;
pub const CMD_AUTH_RECONNECT_PROOF: u8 = 0x03;
pub const CMD_REALM_LIST: u8 = 0x10;

pub const WOW_SUCCESS: u8 = 0x00;
pub const WOW_FAIL_UNKNOWN_ACCOUNT: u8 = 0x04;
pub const WOW_FAIL_INCORRECT_PASSWORD: u8 = 0x04;

// ============================================================================
// 2. World Server (mangosd :8085) Opcodes (Build 5875)
// ============================================================================

// Auth & Session
pub const SMSG_AUTH_CHALLENGE: u16 = 0x01EC;
pub const CMSG_AUTH_SESSION: u16 = 0x01ED;
pub const SMSG_AUTH_RESPONSE: u16 = 0x01EE;
pub const SMSG_ADDON_INFO: u16 = 0x02EF;

pub const AUTH_OK: u8 = 0x0C;
pub const AUTH_FAILED: u8 = 0x0D;

// Character Enum / Create / Delete
pub const CMSG_CHAR_CREATE: u16 = 0x0036;
pub const CMSG_CHAR_ENUM: u16 = 0x0037;
pub const CMSG_CHAR_DELETE: u16 = 0x0038;
pub const SMSG_CHAR_CREATE: u16 = 0x003A;
pub const SMSG_CHAR_ENUM: u16 = 0x003B;
pub const SMSG_CHAR_DELETE: u16 = 0x003C;

pub const CHAR_CREATE_SUCCESS: u8 = 0x2E;
pub const CHAR_CREATE_ERROR: u8 = 0x2F;
pub const CHAR_CREATE_NAME_IN_USE: u8 = 0x31;
pub const CHAR_DELETE_SUCCESS: u8 = 0x39;

// Login / Logout / World State
pub const CMSG_PLAYER_LOGIN: u16 = 0x003D;
pub const SMSG_NEW_WORLD: u16 = 0x003E;
pub const SMSG_TRANSFER_PENDING: u16 = 0x003F;
pub const SMSG_TRANSFER_ABORTED: u16 = 0x0040;
pub const SMSG_CHARACTER_LOGIN_FAILED: u16 = 0x0041;
pub const SMSG_LOGIN_SETTIMESPEED: u16 = 0x0042;
pub const CMSG_PLAYER_LOGOUT: u16 = 0x004A;
pub const CMSG_LOGOUT_REQUEST: u16 = 0x004B;
pub const SMSG_LOGOUT_RESPONSE: u16 = 0x004C;
pub const SMSG_LOGOUT_COMPLETE: u16 = 0x004D;
pub const CMSG_LOGOUT_CANCEL: u16 = 0x004E;
pub const SMSG_LOGOUT_CANCEL_ACK: u16 = 0x004F;
pub const SMSG_TUTORIAL_FLAGS: u16 = 0x00FD;
pub const CMSG_TUTORIAL_FLAG: u16 = 0x00FE;
pub const CMSG_TUTORIAL_CLEAR: u16 = 0x00FF;
pub const CMSG_TUTORIAL_RESET: u16 = 0x0100;
pub const SMSG_BINDPOINTUPDATE: u16 = 0x0155;
pub const SMSG_ACCOUNT_DATA_TIMES: u16 = 0x0209;
pub const CMSG_REQUEST_ACCOUNT_DATA: u16 = 0x020A;
pub const CMSG_UPDATE_ACCOUNT_DATA: u16 = 0x020B;
pub const SMSG_UPDATE_ACCOUNT_DATA: u16 = 0x020C;
pub const SMSG_LOGIN_VERIFY_WORLD: u16 = 0x0236;
pub const SMSG_INIT_WORLD_STATES: u16 = 0x02C2;
pub const SMSG_WEATHER: u16 = 0x02F4;

// Queries
pub const CMSG_NAME_QUERY: u16 = 0x0050;
pub const SMSG_NAME_QUERY_RESPONSE: u16 = 0x0051;
pub const CMSG_PET_NAME_QUERY: u16 = 0x0052;
pub const SMSG_PET_NAME_QUERY_RESPONSE: u16 = 0x0053;
pub const CMSG_ITEM_QUERY_SINGLE: u16 = 0x0056;
pub const SMSG_ITEM_QUERY_SINGLE_RESPONSE: u16 = 0x0058;
pub const CMSG_PAGE_TEXT_QUERY: u16 = 0x005A;
pub const SMSG_PAGE_TEXT_QUERY_RESPONSE: u16 = 0x005B;
pub const CMSG_QUEST_QUERY: u16 = 0x005C;
pub const SMSG_QUEST_QUERY_RESPONSE: u16 = 0x005D;
pub const CMSG_GAMEOBJECT_QUERY: u16 = 0x005E;
pub const SMSG_GAMEOBJECT_QUERY_RESPONSE: u16 = 0x005F;
pub const CMSG_CREATURE_QUERY: u16 = 0x0060;
pub const SMSG_CREATURE_QUERY_RESPONSE: u16 = 0x0061;
pub const CMSG_PLAYED_TIME: u16 = 0x01CC;
pub const SMSG_PLAYED_TIME: u16 = 0x01CD;
pub const CMSG_QUERY_TIME: u16 = 0x01CE;
pub const SMSG_QUERY_TIME_RESPONSE: u16 = 0x01CF;

// Object Creation & Updates
pub const SMSG_UPDATE_OBJECT: u16 = 0x00A9;
pub const SMSG_DESTROY_OBJECT: u16 = 0x00AA;
pub const SMSG_COMPRESSED_UPDATE_OBJECT: u16 = 0x01F6;

// Area Triggers & World Interaction
pub const CMSG_USE_ITEM: u16 = 0x00AB;
pub const CMSG_OPEN_ITEM: u16 = 0x00AC;
pub const CMSG_GAMEOBJ_USE: u16 = 0x00B1;
pub const CMSG_AREATRIGGER: u16 = 0x00B4;
pub const SMSG_AREA_TRIGGER_MESSAGE: u16 = 0x02B8;

// Movement & Speed
pub const MSG_MOVE_START_FORWARD: u16 = 0x00B5;
pub const MSG_MOVE_START_BACKWARD: u16 = 0x00B6;
pub const MSG_MOVE_STOP: u16 = 0x00B7;
pub const MSG_MOVE_START_STRAFE_LEFT: u16 = 0x00B8;
pub const MSG_MOVE_START_STRAFE_RIGHT: u16 = 0x00B9;
pub const MSG_MOVE_STOP_STRAFE: u16 = 0x00BA;
pub const MSG_MOVE_JUMP: u16 = 0x00BB;
pub const MSG_MOVE_START_TURN_LEFT: u16 = 0x00BC;
pub const MSG_MOVE_START_TURN_RIGHT: u16 = 0x00BD;
pub const MSG_MOVE_STOP_TURN: u16 = 0x00BE;
pub const MSG_MOVE_START_PITCH_UP: u16 = 0x00BF;
pub const MSG_MOVE_START_PITCH_DOWN: u16 = 0x00C0;
pub const MSG_MOVE_STOP_PITCH: u16 = 0x00C1;
pub const MSG_MOVE_SET_RUN_MODE: u16 = 0x00C2;
pub const MSG_MOVE_SET_WALK_MODE: u16 = 0x00C3;
pub const MSG_MOVE_TELEPORT: u16 = 0x00C5;
pub const MSG_MOVE_TELEPORT_CHEAT: u16 = 0x00C6;
pub const MSG_MOVE_TELEPORT_ACK: u16 = 0x00C7;
pub const MSG_MOVE_FALL_LAND: u16 = 0x00C9;
pub const MSG_MOVE_START_SWIM: u16 = 0x00CA;
pub const MSG_MOVE_STOP_SWIM: u16 = 0x00CB;
pub const MSG_MOVE_SET_RUN_SPEED: u16 = 0x00CD;
pub const MSG_MOVE_SET_RUN_BACK_SPEED: u16 = 0x00CF;
pub const MSG_MOVE_SET_WALK_SPEED: u16 = 0x00D1;
pub const MSG_MOVE_SET_SWIM_SPEED: u16 = 0x00D3;
pub const MSG_MOVE_SET_SWIM_BACK_SPEED: u16 = 0x00D5;
pub const MSG_MOVE_SET_TURN_RATE: u16 = 0x00D8;
pub const MSG_MOVE_SET_FACING: u16 = 0x00DA;
pub const MSG_MOVE_SET_PITCH: u16 = 0x00DB;
pub const MSG_MOVE_WORLDPORT_ACK: u16 = 0x00DC;
pub const SMSG_MONSTER_MOVE: u16 = 0x00DD;
pub const SMSG_FORCE_RUN_SPEED_CHANGE: u16 = 0x00E2;
pub const CMSG_FORCE_RUN_SPEED_CHANGE_ACK: u16 = 0x00E3;
pub const SMSG_FORCE_RUN_BACK_SPEED_CHANGE: u16 = 0x00E4;
pub const CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK: u16 = 0x00E5;
pub const SMSG_FORCE_SWIM_SPEED_CHANGE: u16 = 0x00E6;
pub const CMSG_FORCE_SWIM_SPEED_CHANGE_ACK: u16 = 0x00E7;
pub const MSG_MOVE_HEARTBEAT: u16 = 0x00EE;
pub const CMSG_SET_ACTIVE_MOVER: u16 = 0x026A;
pub const CMSG_MOVE_SPLINE_DONE: u16 = 0x02C9;
pub const CMSG_MOVE_TIME_SKIPPED: u16 = 0x02CE;
pub const CMSG_MOVE_NOT_ACTIVE_MOVER: u16 = 0x02D1;
pub const SMSG_FORCE_WALK_SPEED_CHANGE: u16 = 0x02DA;
pub const CMSG_FORCE_WALK_SPEED_CHANGE_ACK: u16 = 0x02DB;
pub const SMSG_FORCE_SWIM_BACK_SPEED_CHANGE: u16 = 0x02DC;
pub const CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK: u16 = 0x02DD;
pub const SMSG_FORCE_TURN_RATE_CHANGE: u16 = 0x02DE;
pub const CMSG_FORCE_TURN_RATE_CHANGE_ACK: u16 = 0x02DF;
pub const SMSG_SPLINE_SET_RUN_SPEED: u16 = 0x02FE;

// Chat & Emotes
pub const CMSG_MESSAGECHAT: u16 = 0x0095;
pub const SMSG_MESSAGECHAT: u16 = 0x0096;
pub const CMSG_JOIN_CHANNEL: u16 = 0x0097;
pub const CMSG_LEAVE_CHANNEL: u16 = 0x0098;
pub const SMSG_CHANNEL_NOTIFY: u16 = 0x0099;
pub const CMSG_STANDSTATECHANGE: u16 = 0x0101;
pub const SMSG_EMOTE: u16 = 0x0103;
pub const CMSG_TEXT_EMOTE: u16 = 0x0104;
pub const SMSG_TEXT_EMOTE: u16 = 0x0105;
pub const SMSG_NOTIFICATION: u16 = 0x01CB;
pub const SMSG_SERVER_MESSAGE: u16 = 0x0291;
pub const SMSG_STANDSTATE_UPDATE: u16 = 0x029D;

// Spells, Action Bar & Factions
pub const SMSG_INITIALIZE_FACTIONS: u16 = 0x0122;
pub const SMSG_SET_PROFICIENCY: u16 = 0x0127;
pub const CMSG_SET_ACTION_BUTTON: u16 = 0x0128;
pub const SMSG_ACTION_BUTTONS: u16 = 0x0129;
pub const SMSG_INITIAL_SPELLS: u16 = 0x012A;
pub const SMSG_LEARNED_SPELL: u16 = 0x012B;
pub const SMSG_SUPERCEDED_SPELL: u16 = 0x012C;
pub const CMSG_CAST_SPELL: u16 = 0x012E;
pub const CMSG_CANCEL_CAST: u16 = 0x012F;
pub const SMSG_CAST_RESULT: u16 = 0x0130;
pub const SMSG_SPELL_START: u16 = 0x0131;
pub const SMSG_SPELL_GO: u16 = 0x0132;
pub const SMSG_SPELL_COOLDOWN: u16 = 0x0134;
pub const SMSG_COOLDOWN_EVENT: u16 = 0x0135;
pub const CMSG_CANCEL_AURA: u16 = 0x0136;
pub const SMSG_UPDATE_AURA_DURATION: u16 = 0x0137;
pub const MSG_CHANNEL_START: u16 = 0x0139;
pub const MSG_CHANNEL_UPDATE: u16 = 0x013A;
pub const CMSG_CANCEL_CHANNELLING: u16 = 0x013B;
pub const SMSG_SPELLHEALLOG: u16 = 0x0150;
pub const SMSG_SPELLENERGIZELOG: u16 = 0x0151;
pub const SMSG_PLAY_SPELL_VISUAL: u16 = 0x01F3;
pub const SMSG_REMOVED_SPELL: u16 = 0x0203;
pub const SMSG_SPELLLOGMISS: u16 = 0x024B;
pub const SMSG_SPELLLOGEXECUTE: u16 = 0x024C;
pub const SMSG_PERIODICAURALOG: u16 = 0x024E;
pub const SMSG_SPELLDAMAGESHIELD: u16 = 0x024F;
pub const SMSG_SPELLNONMELEEDAMAGELOG: u16 = 0x0250;
pub const CMSG_CANCEL_AUTO_REPEAT_SPELL: u16 = 0x026D;
pub const CMSG_SET_ACTIONBAR_TOGGLES: u16 = 0x02BF;

// Combat & Progression
pub const SMSG_AI_REACTION: u16 = 0x013C;
pub const CMSG_SET_SELECTION: u16 = 0x013D;
pub const CMSG_ATTACKSWING: u16 = 0x0141;
pub const CMSG_ATTACKSTOP: u16 = 0x0142;
pub const SMSG_ATTACKSTART: u16 = 0x0143;
pub const SMSG_ATTACKSTOP: u16 = 0x0144;
pub const SMSG_ATTACKSWING_NOTINRANGE: u16 = 0x0145;
pub const SMSG_ATTACKSWING_BADFACING: u16 = 0x0146;
pub const SMSG_ATTACKSWING_DEADTARGET: u16 = 0x0148;
pub const SMSG_ATTACKSWING_CANT_ATTACK: u16 = 0x0149;
pub const SMSG_ATTACKERSTATEUPDATE: u16 = 0x014A;
pub const SMSG_CANCEL_COMBAT: u16 = 0x014E;
pub const SMSG_LOG_XPGAIN: u16 = 0x01D0;
pub const SMSG_LEVELUP_INFO: u16 = 0x01D4;
pub const CMSG_SETSHEATHED: u16 = 0x01E0;
pub const SMSG_PARTYKILLLOG: u16 = 0x01F5;
pub const SMSG_EXPLORATION_EXPERIENCE: u16 = 0x01F8;

// Loot & Inventory
pub const CMSG_AUTOSTORE_LOOT_ITEM: u16 = 0x0108;
pub const CMSG_AUTOEQUIP_ITEM: u16 = 0x010A;
pub const CMSG_AUTOSTORE_BAG_ITEM: u16 = 0x010B;
pub const CMSG_SWAP_ITEM: u16 = 0x010C;
pub const CMSG_SWAP_INV_ITEM: u16 = 0x010D;
pub const CMSG_SPLIT_ITEM: u16 = 0x010E;
pub const CMSG_DESTROYITEM: u16 = 0x0111;
pub const SMSG_INVENTORY_CHANGE_FAILURE: u16 = 0x0112;
pub const CMSG_LOOT: u16 = 0x015D;
pub const CMSG_LOOT_MONEY: u16 = 0x015E;
pub const CMSG_LOOT_RELEASE: u16 = 0x015F;
pub const SMSG_LOOT_RESPONSE: u16 = 0x0160;
pub const SMSG_LOOT_RELEASE_RESPONSE: u16 = 0x0161;
pub const SMSG_LOOT_REMOVED: u16 = 0x0162;
pub const SMSG_LOOT_MONEY_NOTIFY: u16 = 0x0163;
pub const SMSG_LOOT_CLEAR_MONEY: u16 = 0x0165;
pub const SMSG_ITEM_PUSH_RESULT: u16 = 0x0166;
pub const CMSG_LIST_INVENTORY: u16 = 0x019E;
pub const SMSG_LIST_INVENTORY: u16 = 0x019F;
pub const CMSG_SELL_ITEM: u16 = 0x01A0;
pub const SMSG_SELL_ITEM: u16 = 0x01A1;
pub const CMSG_BUY_ITEM: u16 = 0x01A2;
pub const CMSG_BUY_ITEM_IN_SLOT: u16 = 0x01A3;
pub const SMSG_BUY_ITEM: u16 = 0x01A4;
pub const SMSG_BUY_FAILED: u16 = 0x01A5;

// Gossip & Quests
pub const CMSG_GOSSIP_HELLO: u16 = 0x017B;
pub const CMSG_GOSSIP_SELECT_OPTION: u16 = 0x017C;
pub const SMSG_GOSSIP_MESSAGE: u16 = 0x017D;
pub const SMSG_GOSSIP_COMPLETE: u16 = 0x017E;
pub const CMSG_NPC_TEXT_QUERY: u16 = 0x017F;
pub const SMSG_NPC_TEXT_UPDATE: u16 = 0x0180;
pub const SMSG_GOSSIP_POI: u16 = 0x0224;
pub const CMSG_QUESTGIVER_STATUS_QUERY: u16 = 0x0182;
pub const SMSG_QUESTGIVER_STATUS: u16 = 0x0183;
pub const CMSG_QUESTGIVER_HELLO: u16 = 0x0184;
pub const SMSG_QUESTGIVER_QUEST_LIST: u16 = 0x0185;
pub const CMSG_QUESTGIVER_QUERY_QUEST: u16 = 0x0186;
pub const SMSG_QUESTGIVER_QUEST_DETAILS: u16 = 0x0188;
pub const CMSG_QUESTGIVER_ACCEPT_QUEST: u16 = 0x0189;
pub const CMSG_QUESTGIVER_COMPLETE_QUEST: u16 = 0x018A;
pub const SMSG_QUESTGIVER_REQUEST_ITEMS: u16 = 0x018B;
pub const CMSG_QUESTGIVER_REQUEST_REWARD: u16 = 0x018C;
pub const SMSG_QUESTGIVER_OFFER_REWARD: u16 = 0x018D;
pub const CMSG_QUESTGIVER_CHOOSE_REWARD: u16 = 0x018E;
pub const SMSG_QUESTGIVER_QUEST_INVALID: u16 = 0x018F;
pub const SMSG_QUESTGIVER_QUEST_COMPLETE: u16 = 0x0191;
pub const SMSG_QUESTGIVER_QUEST_FAILED: u16 = 0x0192;
pub const CMSG_QUESTLOG_SWAP_QUEST: u16 = 0x0193;
pub const CMSG_QUESTLOG_REMOVE_QUEST: u16 = 0x0194;
pub const SMSG_QUESTLOG_FULL: u16 = 0x0195;
pub const SMSG_QUESTUPDATE_FAILED: u16 = 0x0196;
pub const SMSG_QUESTUPDATE_FAILEDTIMER: u16 = 0x0197;
pub const SMSG_QUESTUPDATE_COMPLETE: u16 = 0x0198;
pub const SMSG_QUESTUPDATE_ADD_KILL: u16 = 0x0199;
pub const SMSG_QUESTUPDATE_ADD_ITEM: u16 = 0x019A;

// Keepalive & Misc
pub const CMSG_PING: u16 = 0x01DC;
pub const SMSG_PONG: u16 = 0x01DD;
pub const CMSG_TOGGLE_PVP: u16 = 0x0253;
pub const CMSG_TOGGLE_HELM: u16 = 0x02B9;
pub const CMSG_TOGGLE_CLOAK: u16 = 0x02BA;

// ============================================================================
// 3. GUID High-Parts & Helpers (matching `benilla-protocol::guid`)
// ============================================================================
pub const HIGHGUID_PLAYER: u16 = 0x0000;
pub const HIGHGUID_ITEM: u16 = 0x4000;
pub const HIGHGUID_GAMEOBJECT: u16 = 0xF110;
pub const HIGHGUID_UNIT: u16 = 0xF130;
pub const HIGHGUID_PET: u16 = 0xF140;
pub const HIGHGUID_DYNAMICOBJECT: u16 = 0xF100;
pub const HIGHGUID_CORPSE: u16 = 0xF101;

pub fn make_player_guid(low: u32) -> u64 {
    u64::from(low)
}

pub fn make_item_guid(low: u32) -> u64 {
    (u64::from(HIGHGUID_ITEM) << 48) | u64::from(low)
}

pub fn make_unit_guid(entry: u32, spawn_id: u32) -> u64 {
    (u64::from(HIGHGUID_UNIT) << 48)
        | ((u64::from(entry) & 0xFF_FFFF) << 24)
        | (u64::from(spawn_id) & 0xFF_FFFF)
}

pub fn unit_entry_from_guid(guid: u64) -> u32 {
    ((guid >> 24) & 0xFF_FFFF) as u32
}

pub fn unit_spawn_id_from_guid(guid: u64) -> u32 {
    (guid & 0xFF_FFFF) as u32
}

pub fn is_unit_guid(guid: u64) -> bool {
    (guid >> 48) as u16 == HIGHGUID_UNIT
}

pub fn is_player_guid(guid: u64) -> bool {
    guid != 0 && (guid >> 48) as u16 == HIGHGUID_PLAYER
}

/// Pack a 64-bit GUID in WoW 1.12 variable-length mask format (`[mask][nonzero bytes]`).
pub fn write_packed_guid(buf: &mut Vec<u8>, guid: u64) {
    let bytes = guid.to_le_bytes();
    let mut mask = 0u8;
    let mask_pos = buf.len();
    buf.push(0);
    for (i, &b) in bytes.iter().enumerate() {
        if b != 0 {
            mask |= 1u8 << i;
            buf.push(b);
        }
    }
    buf[mask_pos] = mask;
}

/// Read a packed GUID from a byte slice, returning `(guid, bytes_consumed)`.
pub fn read_packed_guid(data: &[u8]) -> Option<(u64, usize)> {
    let &mask = data.first()?;
    let mut pos = 1usize;
    let mut bytes = [0u8; 8];
    for (i, slot) in bytes.iter_mut().enumerate() {
        if (mask & (1u8 << i)) != 0 {
            *slot = *data.get(pos)?;
            pos += 1;
        }
    }
    Some((u64::from_le_bytes(bytes), pos))
}

// ============================================================================
// 4. SMSG_UPDATE_OBJECT Block Types & Object Types (Build 5875)
// ============================================================================
pub const UPDATETYPE_VALUES: u8 = 0;
pub const UPDATETYPE_MOVEMENT: u8 = 1;
pub const UPDATETYPE_CREATE_OBJECT: u8 = 2;
pub const UPDATETYPE_CREATE_OBJECT2: u8 = 3;
pub const UPDATETYPE_OUT_OF_RANGE_OBJECTS: u8 = 4;
pub const UPDATETYPE_NEAR_OBJECTS: u8 = 5;

pub const TYPEID_OBJECT: u8 = 0;
pub const TYPEID_ITEM: u8 = 1;
pub const TYPEID_CONTAINER: u8 = 2;
pub const TYPEID_UNIT: u8 = 3;
pub const TYPEID_PLAYER: u8 = 4;
pub const TYPEID_GAMEOBJECT: u8 = 5;
pub const TYPEID_DYNAMICOBJECT: u8 = 6;
pub const TYPEID_CORPSE: u8 = 7;

pub const TYPEMASK_OBJECT: u32 = 0x0001;
pub const TYPEMASK_ITEM: u32 = 0x0002;
pub const TYPEMASK_CONTAINER: u32 = 0x0004;
pub const TYPEMASK_UNIT: u32 = 0x0008;
pub const TYPEMASK_PLAYER: u32 = 0x0010;
pub const TYPEMASK_GAMEOBJECT: u32 = 0x0020;
pub const TYPEMASK_DYNAMICOBJECT: u32 = 0x0040;
pub const TYPEMASK_CORPSE: u32 = 0x0080;

pub const UPDATEFLAG_SELF: u8 = 0x01;
pub const UPDATEFLAG_TRANSPORT: u8 = 0x02;
pub const UPDATEFLAG_FULLGUID: u8 = 0x04;
pub const UPDATEFLAG_HIGHGUID: u8 = 0x08;
pub const UPDATEFLAG_ALL: u8 = 0x10;
pub const UPDATEFLAG_LIVING: u8 = 0x20;
pub const UPDATEFLAG_HAS_POSITION: u8 = 0x40;

// ============================================================================
// 5. UpdateField Indices (Build 5875 — exact match with `benilla-protocol`)
// ============================================================================

// Object fields (0..6)
pub const OBJECT_FIELD_GUID: u16 = 0; // 2 dwords
pub const OBJECT_FIELD_TYPE: u16 = 2; // 1 dword
pub const OBJECT_FIELD_ENTRY: u16 = 3; // 1 dword
pub const OBJECT_FIELD_SCALE_X: u16 = 4; // 1 float
pub const OBJECT_FIELD_PADDING: u16 = 5;
pub const OBJECT_END: u16 = 6;

// Item fields (6..48)
pub const ITEM_FIELD_OWNER: u16 = 6; // 2 dwords (guid)
pub const ITEM_FIELD_CONTAINED: u16 = 8; // 2 dwords (guid)
pub const ITEM_FIELD_CREATOR: u16 = 10; // 2 dwords (guid)
pub const ITEM_FIELD_GIFTCREATOR: u16 = 12; // 2 dwords
pub const ITEM_FIELD_STACK_COUNT: u16 = 14;
pub const ITEM_FIELD_DURATION: u16 = 15;
pub const ITEM_FIELD_SPELL_CHARGES: u16 = 16; // 5 dwords
pub const ITEM_FIELD_FLAGS: u16 = 21;
pub const ITEM_FIELD_ENCHANTMENT: u16 = 22; // 21 dwords
pub const ITEM_FIELD_PROPERTY_SEED: u16 = 43;
pub const ITEM_FIELD_RANDOM_PROPERTIES_ID: u16 = 44;
pub const ITEM_FIELD_ITEM_TEXT_ID: u16 = 45;
pub const ITEM_FIELD_DURABILITY: u16 = 46;
pub const ITEM_FIELD_MAXDURABILITY: u16 = 47;
pub const ITEM_END: u16 = 48;

// Unit fields (6..188)
pub const UNIT_FIELD_CHARM: u16 = 6;
pub const UNIT_FIELD_SUMMON: u16 = 8;
pub const UNIT_FIELD_CHARMEDBY: u16 = 10;
pub const UNIT_FIELD_SUMMONEDBY: u16 = 12;
pub const UNIT_FIELD_CREATEDBY: u16 = 14;
pub const UNIT_FIELD_TARGET: u16 = 16; // 2 dwords (guid)
pub const UNIT_FIELD_PERSUADED: u16 = 18;
pub const UNIT_FIELD_CHANNEL_OBJECT: u16 = 20;
pub const UNIT_FIELD_HEALTH: u16 = 22;
pub const UNIT_FIELD_POWER1: u16 = 23; // Mana
pub const UNIT_FIELD_POWER2: u16 = 24; // Rage (* 10)
pub const UNIT_FIELD_POWER3: u16 = 25; // Focus
pub const UNIT_FIELD_POWER4: u16 = 26; // Energy
pub const UNIT_FIELD_POWER5: u16 = 27; // Happiness
pub const UNIT_FIELD_MAXHEALTH: u16 = 28;
pub const UNIT_FIELD_MAXPOWER1: u16 = 29;
pub const UNIT_FIELD_MAXPOWER2: u16 = 30;
pub const UNIT_FIELD_MAXPOWER3: u16 = 31;
pub const UNIT_FIELD_MAXPOWER4: u16 = 32;
pub const UNIT_FIELD_MAXPOWER5: u16 = 33;
pub const UNIT_FIELD_LEVEL: u16 = 34;
pub const UNIT_FIELD_FACTIONTEMPLATE: u16 = 35;
pub const UNIT_FIELD_BYTES_0: u16 = 36; // race | class<<8 | gender<<16 | power_type<<24
pub const UNIT_VIRTUAL_ITEM_SLOT_DISPLAY: u16 = 37; // 3 dwords (main, off, ranged display_id)
pub const UNIT_VIRTUAL_ITEM_INFO: u16 = 40; // 6 dwords (2 per slot)
pub const UNIT_FIELD_FLAGS: u16 = 46;
pub const UNIT_FIELD_AURA: u16 = 47; // 48 dwords
pub const UNIT_FIELD_AURAFLAGS: u16 = 95; // 6 dwords
pub const UNIT_FIELD_AURALEVELS: u16 = 101; // 12 dwords
pub const UNIT_FIELD_AURAAPPLICATIONS: u16 = 113; // 12 dwords
pub const UNIT_FIELD_AURASTATE: u16 = 125;
pub const UNIT_FIELD_BASEATTACKTIME: u16 = 126; // 2 dwords (main, offhand ms)
pub const UNIT_FIELD_RANGEDATTACKTIME: u16 = 128;
pub const UNIT_FIELD_BOUNDINGRADIUS: u16 = 129; // float
pub const UNIT_FIELD_COMBATREACH: u16 = 130; // float
pub const UNIT_FIELD_DISPLAYID: u16 = 131;
pub const UNIT_FIELD_NATIVEDISPLAYID: u16 = 132;
pub const UNIT_FIELD_MOUNTDISPLAYID: u16 = 133;
pub const UNIT_FIELD_MINDAMAGE: u16 = 134; // float
pub const UNIT_FIELD_MAXDAMAGE: u16 = 135; // float
pub const UNIT_FIELD_MINOFFHANDDAMAGE: u16 = 136; // float
pub const UNIT_FIELD_MAXOFFHANDDAMAGE: u16 = 137; // float
pub const UNIT_FIELD_BYTES_1: u16 = 138; // stand_state | loyalty<<8 | shapeshift<<16 | vis_flags<<24
pub const UNIT_FIELD_PETNUMBER: u16 = 139;
pub const UNIT_FIELD_PET_NAME_TIMESTAMP: u16 = 140;
pub const UNIT_FIELD_PETEXPERIENCE: u16 = 141;
pub const UNIT_FIELD_PETNEXTLEVELEXP: u16 = 142;
pub const UNIT_DYNAMIC_FLAGS: u16 = 143;
pub const UNIT_CHANNEL_SPELL: u16 = 144;
pub const UNIT_MOD_CAST_SPEED: u16 = 145; // float (1.0)
pub const UNIT_CREATED_BY_SPELL: u16 = 146;
pub const UNIT_NPC_FLAGS: u16 = 147;
pub const UNIT_NPC_EMOTESTATE: u16 = 148;
pub const UNIT_TRAINING_POINTS: u16 = 149;
pub const UNIT_FIELD_STAT0: u16 = 150; // Str
pub const UNIT_FIELD_STAT1: u16 = 151; // Agi
pub const UNIT_FIELD_STAT2: u16 = 152; // Sta
pub const UNIT_FIELD_STAT3: u16 = 153; // Int
pub const UNIT_FIELD_STAT4: u16 = 154; // Spi
pub const UNIT_FIELD_RESISTANCES: u16 = 155; // 7 dwords ([0] = Armor)
pub const UNIT_FIELD_BASE_MANA: u16 = 162;
pub const UNIT_FIELD_BASE_HEALTH: u16 = 163;
pub const UNIT_FIELD_BYTES_2: u16 = 164; // sheath_state in byte 0
pub const UNIT_FIELD_ATTACK_POWER: u16 = 165;
pub const UNIT_FIELD_ATTACK_POWER_MODS: u16 = 166;
pub const UNIT_FIELD_ATTACK_POWER_MULTIPLIER: u16 = 167;
pub const UNIT_FIELD_RANGED_ATTACK_POWER: u16 = 168;
pub const UNIT_FIELD_RANGED_ATTACK_POWER_MODS: u16 = 169;
pub const UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER: u16 = 170;
pub const UNIT_FIELD_MINRANGEDDAMAGE: u16 = 171;
pub const UNIT_FIELD_MAXRANGEDDAMAGE: u16 = 172;
pub const UNIT_END: u16 = 188;

// Player fields (188..1282)
pub const PLAYER_DUEL_ARBITER: u16 = 188;
pub const PLAYER_FLAGS: u16 = 190;
pub const PLAYER_GUILDID: u16 = 191;
pub const PLAYER_GUILDRANK: u16 = 192;
pub const PLAYER_BYTES: u16 = 193; // skin | face<<8 | hairStyle<<16 | hairColor<<24
pub const PLAYER_BYTES_2: u16 = 194; // facialHair | 0<<8 | bankBags<<16 | restState<<24
pub const PLAYER_BYTES_3: u16 = 195; // gender | drunk<<8 | pvpMedal<<16 | pvpRank<<24
pub const PLAYER_DUEL_TEAM: u16 = 196;
pub const PLAYER_GUILD_TIMESTAMP: u16 = 197;
pub const PLAYER_QUEST_LOG_1_1: u16 = 198; // 20 slots * 3 dwords (quest_id, count_state, timer)
pub const PLAYER_VISIBLE_ITEM_1_CREATOR: u16 = 258; // 19 slots * 12 dwords (entry at +2)
pub const PLAYER_FIELD_INV_SLOT_HEAD: u16 = 486; // 23 slots * 2 dwords (0..18 equip, 19..22 bags)
pub const PLAYER_FIELD_PACK_SLOT_1: u16 = 532; // 16 slots * 2 dwords (backpack)
pub const PLAYER_FIELD_BANK_SLOT_1: u16 = 564;
pub const PLAYER_FIELD_BANK_BAG_SLOT_1: u16 = 612;
pub const PLAYER_FIELD_VENDORBUYBACK_SLOT_1: u16 = 624;
pub const PLAYER_FIELD_KEYRING_SLOT_1: u16 = 648;
pub const PLAYER_FARSIGHT: u16 = 712;
pub const PLAYER_FIELD_COMBO_TARGET: u16 = 714;
pub const PLAYER_XP: u16 = 716;
pub const PLAYER_NEXT_LEVEL_XP: u16 = 717;
pub const PLAYER_SKILL_INFO_1_1: u16 = 718; // 128 * 3 dwords
pub const PLAYER_CHARACTER_POINTS1: u16 = 1102;
pub const PLAYER_CHARACTER_POINTS2: u16 = 1103;
pub const PLAYER_TRACK_CREATURES: u16 = 1104;
pub const PLAYER_TRACK_RESOURCES: u16 = 1105;
pub const PLAYER_BLOCK_PERCENTAGE: u16 = 1106; // float
pub const PLAYER_DODGE_PERCENTAGE: u16 = 1107; // float
pub const PLAYER_PARRY_PERCENTAGE: u16 = 1108; // float
pub const PLAYER_CRIT_PERCENTAGE: u16 = 1109; // float
pub const PLAYER_RANGED_CRIT_PERCENTAGE: u16 = 1110; // float
pub const PLAYER_EXPLORED_ZONES_1: u16 = 1111; // 64 dwords
pub const PLAYER_REST_STATE_EXPERIENCE: u16 = 1175;
pub const PLAYER_FIELD_COINAGE: u16 = 1176;
pub const PLAYER_FIELD_POSSTAT0: u16 = 1177;
pub const PLAYER_FIELD_NEGSTAT0: u16 = 1182;
pub const PLAYER_FIELD_RESISTANCEBUFFMODSPOSITIVE: u16 = 1187;
pub const PLAYER_FIELD_RESISTANCEBUFFMODSNEGATIVE: u16 = 1194;
pub const PLAYER_FIELD_MOD_DAMAGE_DONE_POS: u16 = 1201;
pub const PLAYER_FIELD_MOD_DAMAGE_DONE_NEG: u16 = 1208;
pub const PLAYER_FIELD_MOD_DAMAGE_DONE_PCT: u16 = 1215; // 7 floats (1.0)
pub const PLAYER_FIELD_BYTES: u16 = 1222;
pub const PLAYER_AMMO_ID: u16 = 1223;
pub const PLAYER_SELF_RES_SPELL: u16 = 1224;
pub const PLAYER_FIELD_PVP_MEDALS: u16 = 1225;
pub const PLAYER_FIELD_BUYBACK_PRICE_1: u16 = 1226;
pub const PLAYER_FIELD_BUYBACK_TIMESTAMP_1: u16 = 1238;
pub const PLAYER_FIELD_SESSION_KILLS: u16 = 1250;
pub const PLAYER_FIELD_YESTERDAY_KILLS: u16 = 1251;
pub const PLAYER_FIELD_LAST_WEEK_KILLS: u16 = 1252;
pub const PLAYER_FIELD_THIS_WEEK_KILLS: u16 = 1253;
pub const PLAYER_FIELD_THIS_WEEK_CONTRIBUTION: u16 = 1254;
pub const PLAYER_FIELD_LIFETIME_HONORABLE_KILLS: u16 = 1255;
pub const PLAYER_FIELD_LIFETIME_DISHONORABLE_KILLS: u16 = 1256;
pub const PLAYER_FIELD_YESTERDAY_CONTRIBUTION: u16 = 1257;
pub const PLAYER_FIELD_LAST_WEEK_CONTRIBUTION: u16 = 1258;
pub const PLAYER_FIELD_LAST_WEEK_RANK: u16 = 1259;
pub const PLAYER_FIELD_BYTES2: u16 = 1260;
pub const PLAYER_FIELD_WATCHED_FACTION_INDEX: u16 = 1261;
pub const PLAYER_END: u16 = 1282;

// Equipment slot constants
pub const EQUIPMENT_SLOT_MAINHAND: u8 = 15;
pub const EQUIPMENT_SLOT_OFFHAND: u8 = 16;
pub const EQUIPMENT_SLOT_RANGED: u8 = 17;

// NPC flags
pub const UNIT_NPC_FLAG_NONE: u32 = 0x00;
pub const UNIT_NPC_FLAG_GOSSIP: u32 = 0x01;
pub const UNIT_NPC_FLAG_QUESTGIVER: u32 = 0x02;
pub const UNIT_NPC_FLAG_VENDOR: u32 = 0x04;
pub const UNIT_NPC_FLAG_FLIGHTMASTER: u32 = 0x08;
pub const UNIT_NPC_FLAG_TRAINER: u32 = 0x10;
pub const UNIT_NPC_FLAG_INNKEEPER: u32 = 0x80;

// Dynamic flags
pub const UNIT_DYNFLAG_NONE: u32 = 0x00;
pub const UNIT_DYNFLAG_LOOTABLE: u32 = 0x01;
pub const UNIT_DYNFLAG_TRACK_UNIT: u32 = 0x02;
pub const UNIT_DYNFLAG_TAPPED: u32 = 0x04;
pub const UNIT_DYNFLAG_TAPPED_BY_PLAYER: u32 = 0x08;
pub const UNIT_DYNFLAG_DEAD: u32 = 0x20;

// Faction templates (from `build-celandia-data.mjs` FactionTemplate.dbc)
pub const FACTION_FRIENDLY: u32 = 35;
pub const FACTION_MONSTER: u32 = 14;

/// Helper to build a sparse `UpdateField` mask + value block for `SMSG_UPDATE_OBJECT`.
#[derive(Debug, Clone, Default)]
pub struct UpdateFieldBuilder {
    words: Vec<u32>,
    values: Vec<u32>,
}

impl UpdateFieldBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_u32(&mut self, index: u16, val: u32) {
        let idx = usize::from(index);
        let word = idx / 32;
        let bit = idx % 32;
        if word >= self.words.len() {
            self.words.resize(word + 1, 0);
            self.values.resize((word + 1) * 32, 0);
        }
        self.words[word] |= 1u32 << bit;
        self.values[idx] = val;
    }

    pub fn set_i32(&mut self, index: u16, val: i32) {
        self.set_u32(index, val as u32);
    }

    pub fn set_f32(&mut self, index: u16, val: f32) {
        self.set_u32(index, val.to_bits());
    }

    pub fn set_guid(&mut self, index: u16, guid: u64) {
        self.set_u32(index, (guid & 0xFFFF_FFFF) as u32);
        self.set_u32(index + 1, (guid >> 32) as u32);
    }

    pub fn write_into(&self, buf: &mut Vec<u8>) {
        let block_count = self.words.len() as u8;
        buf.push(block_count);
        for &w in &self.words {
            buf.extend_from_slice(&w.to_le_bytes());
        }
        for (w_idx, &w) in self.words.iter().enumerate() {
            for bit in 0..32usize {
                if (w & (1u32 << bit)) != 0 {
                    let v = self.values[w_idx * 32 + bit];
                    buf.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    }
}
