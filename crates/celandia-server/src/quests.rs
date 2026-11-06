//! Celandia NPC Dialogue, Gossip Menus, and Quest Templates & Wire Encoders (Build 5875).

use crate::spawns::get_item_template;

// ============================================================================
// 1. Questgiver Dialog Status Constants (Build 5875)
// ============================================================================
pub const DIALOG_STATUS_NONE: u8 = 0;
pub const DIALOG_STATUS_UNAVAILABLE: u8 = 1;
pub const DIALOG_STATUS_CHAT: u8 = 2;
pub const DIALOG_STATUS_INCOMPLETE: u8 = 3;
pub const DIALOG_STATUS_REWARD_REP: u8 = 4;
pub const DIALOG_STATUS_AVAILABLE: u8 = 5;
pub const DIALOG_STATUS_REWARD_OLD: u8 = 6;
pub const DIALOG_STATUS_REWARD2: u8 = 7;

// ============================================================================
// 2. NPC Gossip Texts & Interactive Options (Ported from Celandia `story.js`)
// ============================================================================

#[derive(Debug, Clone)]
pub struct GossipOption {
    pub id: u32,
    pub icon: u8,
    pub text: &'static str,
    pub action: GossipAction,
}

#[derive(Debug, Clone, Copy)]
pub enum GossipAction {
    HealAndFeed,
    Teleport(&'static str),
    SendSubText(u32),
}

pub fn get_npc_text(text_id: u32) -> &'static str {
    match text_id {
        1001 => "“The bells under Frostbell are ringing the old route song. We’re still here. Come the long way.”\n\nI’m Rook, route-mender of Lowbell. Every membrane seam in this archipelago answers to a brass hook and a steady cadence.",
        1002 => "“You came through the north membrane with a moth and a hook. You must be the route-mender who closed Mere.”\n\nThere is one thaw left in the Bellmere garden. Help my keepers quiet the restless drifters along the frozen ribbon, and Frostbell will stand with you.",
        1003 => "“Press your ear to the wind and I will listen with you. Seams sound like two notes that cannot agree.”\n\nI have charted the bubble-crossings to every Kingdom in the Elsewhere Tide. Tell me where you need to sail, Captain.",
        1004 => "“Don’t step on the echoes. They’re all that’s left of people who walked this way and didn’t come back.”\n\nThe old channel under Hushwood has three sluices. Clear out the Seam Hollows and the nursery pools will sing again.",
        1005 => "“ROOK! I lost the map. Good news: the flowers know where we are. Bad news: it’s the wrong world!”\n\nThe roses in this hanging conservatory hum the exact same route-song I do.",
        1006 => "“Every crossing gate requires a stamped brass permit—or a very good reason to look the other way.”\n\nBeyond the north-west basalt arch lies Nocturnum Obsidian Isle. Ready your blade before you cross that lava moat.",
        1007 => "“There you are. The tide brought a lighthouse into Lowbell harbor this morning. Lamp still burning. Bread still warm.”\n\nI’ve got three pots of soup simmering at the Long Table, and a mailbag with your route seal on it.",
        1008 => "“Dude! This bell garden has, like, outstanding acoustical potential. We’re The Almost Legends—the name is temporary.”\n\nOur porcelain resonator coil rolled into the Wildwood and the berry-hoppers think it’s a snack!",
        1009 => "“…We booked the bell for our debut. Our music literally opens doors. Only, like, emotionally loud.”",
        1010 => "“Look at the crown roots. They remember every path that ever ran through the Porcelain Wake—and one of them runs to Mere.”\n\nHelp me restore the water to the nursery pools without letting the forest’s young go dry.",
        1011 => "“A Wake fairy in my desert, at night, without a hat. You must want something.”\n\nGlasswake keeps its storms in glass. Bring me stormglass shards from the dunes and we will bargain like civilized sovereigns.",
        1012 => "“Welcome to the Aureate Reach. Every route you crossed today is held open by this city.”\n\nIf Lord Oriel’s evacuation record for Mere is flawed, bring me the proof from the Great Orrery and I will open the royal corridor.",
        1013 => "“Do you know how many bubbles the Great Orrery holds steady at this moment? Four hundred and twelve.”\n\nEven our clockwork colossi are straining against the seam. Tread carefully on the Orrery terrace.",
        1014 => "“Postwoman Wren of the Archipelago Express! Neither bubble-membrane nor Cinderveil hound stays these appointed couriers.”",
        1015 => "“Across the dimensional seam, my Space Lance resonates with Celandia’s crystal core. Point me toward the Obsidian Colossus!”",
        1016 => "“Showtime, Synergy! Our starlight acoustics harmonize with Lowbell’s bells—let’s light up the Elsewhere Sanctum!”",
        2001 => "Moss ladles a steaming bowl of Seven-Island Porcelain Broth into your hands. Your health and spirit are completely restored!",
        _ => "The Elsewhere Tide hums softly through the porcelain bells.",
    }
}

pub fn get_npc_gossip_options(entry: u32) -> Vec<GossipOption> {
    match entry {
        1007 => vec![
            GossipOption {
                id: 1,
                icon: 0,
                text: "Sit at the Long Table and eat a bowl of Moss's hot soup (Restore Health & Mana).",
                action: GossipAction::HealAndFeed,
            },
            GossipOption {
                id: 2,
                icon: 2,
                text: "Sail the Errand to Frostbell Lagoon.",
                action: GossipAction::Teleport("frostbell"),
            },
            GossipOption {
                id: 3,
                icon: 2,
                text: "Sail the Errand to Glasswake Mesas.",
                action: GossipAction::Teleport("glasswake"),
            },
            GossipOption {
                id: 4,
                icon: 2,
                text: "Sail the Errand to The Aureate Reach.",
                action: GossipAction::Teleport("aureate"),
            },
        ],
        1003 | 1001 => vec![
            GossipOption {
                id: 10,
                icon: 2,
                text: "Chart a crossing to The Porcelain Wake (Lowbell Court).",
                action: GossipAction::Teleport("porcelain"),
            },
            GossipOption {
                id: 11,
                icon: 2,
                text: "Chart a crossing to Frostbell Lagoon.",
                action: GossipAction::Teleport("frostbell"),
            },
            GossipOption {
                id: 12,
                icon: 2,
                text: "Chart a crossing to Glasswake Mesas.",
                action: GossipAction::Teleport("glasswake"),
            },
            GossipOption {
                id: 13,
                icon: 2,
                text: "Chart a crossing to The Aureate Reach.",
                action: GossipAction::Teleport("aureate"),
            },
            GossipOption {
                id: 14,
                icon: 2,
                text: "Chart a crossing to Nocturnum Obsidian Isle.",
                action: GossipAction::Teleport("nocturnum"),
            },
            GossipOption {
                id: 15,
                icon: 2,
                text: "Step through the Seam into The Elsewhere Sanctum (Map 1).",
                action: GossipAction::Teleport("elsewhere"),
            },
        ],
        _ => vec![GossipOption {
            id: 99,
            icon: 0,
            text: "Rest a moment by the bell-light (Restore Health & Mana).",
            action: GossipAction::HealAndFeed,
        }],
    }
}

// ============================================================================
// 3. Celandia Quest Templates (IDs 70001..=70008)
// ============================================================================

#[derive(Debug, Clone)]
pub struct QuestObjective {
    pub creature_entry: u32,
    pub required_count: u32,
    pub text: &'static str,
}

#[derive(Debug, Clone)]
pub struct QuestTemplate {
    pub quest_id: u32,
    pub quest_level: u32,
    pub min_level: u32,
    pub zone_or_sort: i32,
    pub giver_entries: &'static [u32],
    pub turnin_entries: &'static [u32],
    pub title: &'static str,
    pub objectives_summary: &'static str,
    pub details: &'static str,
    pub request_items_text: &'static str,
    pub offer_reward_text: &'static str,
    pub end_text: &'static str,
    pub reward_xp: u32,
    pub reward_money: u32,
    pub reward_items: &'static [(u32, u32)],        // (item_id, count)
    pub choice_reward_items: &'static [(u32, u32)], // (item_id, count)
    pub objectives: &'static [QuestObjective],      // up to 4
}

pub static QUEST_TEMPLATES: &[QuestTemplate] = &[
    QuestTemplate {
        quest_id: 70001,
        quest_level: 2,
        min_level: 1,
        zone_or_sort: 1,
        giver_entries: &[1007, 1001],
        turnin_entries: &[1007, 1003, 1001],
        title: "Chapter I: The Lighthouse Mailbag",
        objectives_summary: "Clear 2 Porcelain Hoppers near the Lowbell creek trail and report to Moss Calder or Ilex.",
        details: "The tide brought a drifting lighthouse into Lowbell harbor this morning—lamp still burning, bread still warm. Inside its mailbag was a letter sealed with the mark of Mere.\n\nBefore you and Ilex set out toward the Frostbell membrane, shoo away the nest of Porcelain Hoppers blocking the creek trail.",
        request_items_text: "Did you clear the creek trail and read the letter from Mere?",
        offer_reward_text: "“The bells under Frostbell are ringing the old route song. We’re still here. Come the long way.”\n\nTake this kiln-tempered Porcelain Rapier, Captain. You’ll need it on the road north.",
        end_text: "Return to Moss Calder or Ilex in Lowbell Court.",
        reward_xp: 250,
        reward_money: 200,
        reward_items: &[(50001, 1)],
        choice_reward_items: &[(50007, 1), (50002, 1)],
        objectives: &[QuestObjective {
            creature_entry: 2001,
            required_count: 2,
            text: "Porcelain Hoppers shooed from the trail",
        }],
    },
    QuestTemplate {
        quest_id: 70002,
        quest_level: 3,
        min_level: 1,
        zone_or_sort: 1,
        giver_entries: &[1008, 1009],
        turnin_entries: &[1008, 1009],
        title: "A Permit to Party",
        objectives_summary: "Recover The Almost Legends' resonator coil by defeating 3 Porcelain Hoppers in the Wildwood.",
        details: "Dude! Daze and I booked the Lowbell Bell Garden for our debut as The Almost Legends, but our porcelain resonator coil rolled off an alarming root in the Wildwood!\n\nThe berry-hoppers are bouncing around with it. Get our coil back so we can run our soundcheck!",
        request_items_text: "Did you hear a bee that went to music school out there?",
        offer_reward_text: "The coil! You are, like, a real legend—not an almost one. Soundcheck in three, two... whoa! Even the root bridge by the falls just woke up!",
        end_text: "Bring the resonator coil back to Riff and Daze in the Bell Garden.",
        reward_xp: 350,
        reward_money: 300,
        reward_items: &[(50009, 1)],
        choice_reward_items: &[(50002, 1), (50003, 1)],
        objectives: &[QuestObjective {
            creature_entry: 2001,
            required_count: 3,
            text: "Wildwood Hoppers searched for the Coil",
        }],
    },
    QuestTemplate {
        quest_id: 70003,
        quest_level: 4,
        min_level: 1,
        zone_or_sort: 1,
        giver_entries: &[1010, 1004],
        turnin_entries: &[1010, 1004],
        title: "Chapter II: The Living Solution",
        objectives_summary: "Clear 2 Seam Hollows in Hushwood so Mora and Princess Elowen can open the three water sluices.",
        details: "Look at the crown roots, route-mender. One of them still reaches Mere, but to open that crossing without draining the Wake's nursery pools, we must reopen the old channel under Hushwood.\n\nMora tends the echoes there, where drifting Seam Hollows have clogged the three sluices.",
        request_items_text: "Are the three Hushwood sluices clear of Seam Hollows?",
        offer_reward_text: "Listen—the nursery pools are singing again, and the root to Mere is wet! When you sail home the long way, the Porcelain Wake stands with you.",
        end_text: "Report back to Princess Elowen or Mora.",
        reward_xp: 480,
        reward_money: 450,
        reward_items: &[(50007, 1)],
        choice_reward_items: &[(50001, 1), (50002, 1)],
        objectives: &[QuestObjective {
            creature_entry: 2006,
            required_count: 2,
            text: "Seam Hollows cleared from Hushwood sluices",
        }],
    },
    QuestTemplate {
        quest_id: 70004,
        quest_level: 6,
        min_level: 1,
        zone_or_sort: 2,
        giver_entries: &[1002],
        turnin_entries: &[1002],
        title: "The Last Warm Bell of Frostbell",
        objectives_summary: "Subdue 2 Frostbell Woolly Drifters along the frozen ribbon in Frostbell Lagoon.",
        details: "The family who wrote to you from Mere is sheltered beneath the Bellmere garden on the far side of the ice. There is one thaw left in the great bell, but waking it while the Woolly Drifters stampede across the frozen ribbon will shatter the nursery.\n\nCalm the lagoon ridge so my keepers can guide the sleepers uphill.",
        request_items_text: "Is the frozen ribbon quiet enough to ring the Bellmere bell?",
        offer_reward_text: "The keepers are singing the little ones uphill now. I will remember who carried them through the snow, Rook.",
        end_text: "Return to Princess Serein at the Bellmere Pavilion.",
        reward_xp: 650,
        reward_money: 600,
        reward_items: &[(50002, 1)],
        choice_reward_items: &[(50004, 1), (50007, 1)],
        objectives: &[QuestObjective {
            creature_entry: 2002,
            required_count: 2,
            text: "Frostbell Woolly Drifters calmed",
        }],
    },
    QuestTemplate {
        quest_id: 70005,
        quest_level: 8,
        min_level: 1,
        zone_or_sort: 3,
        giver_entries: &[1011],
        turnin_entries: &[1011],
        title: "Chapter III: Stored Weather",
        objectives_summary: "Gather stormglass from 2 Glasswake Skimmers in the Glasswake Mesas.",
        details: "Glasswake keeps its storms in glass, and you need a wind strong enough to push an entire neighborhood through a bubble-crossing.\n\nBring me warm stormglass shards from the Glasswake Skimmers out on the turquoise mesas, and we will settle our bargain at my feast table.",
        request_items_text: "Have you brought the stormglass shards without dropping them? I dislike surprise weather.",
        offer_reward_text: "Shards warm in the hand, and the storm core still crackling. When the Errand sails for Mere, Glasswake will send its wind freely.",
        end_text: "Return to Princess Solenne in the Glasswake Mesas.",
        reward_xp: 850,
        reward_money: 800,
        reward_items: &[(50003, 1)],
        choice_reward_items: &[(50004, 1), (50005, 1)],
        objectives: &[QuestObjective {
            creature_entry: 2003,
            required_count: 2,
            text: "Glasswake Skimmers hunted for Stormglass",
        }],
    },
    QuestTemplate {
        quest_id: 70006,
        quest_level: 11,
        min_level: 1,
        zone_or_sort: 4,
        giver_entries: &[1012, 1013, 1005],
        turnin_entries: &[1012, 1013],
        title: "Chapter IV: The Great Orrery",
        objectives_summary: "Defeat 1 Ashen Knight and 1 Orrery Iron Colossus in the Aureate Reach to recover the Evacuation Record.",
        details: "Lord Oriel's Great Orrery holds four hundred and twelve bubbles steady, and somewhere on its brass console lies the evacuation record that declared Mere empty.\n\nPush past the Oathbound Ashen Knights and malfunctioning Iron Colossi on the Orrery terrace and bring the record to light.",
        request_items_text: "Have you recovered the evacuation record from the Great Orrery?",
        offer_reward_text: "I signed the closure of Mere because this record said it was empty. Tomorrow the Aureate Reach learns what its music costs—and the royal corridor is yours.",
        end_text: "Bring the Evacuation Record to Princess Avelune.",
        reward_xp: 1200,
        reward_money: 1100,
        reward_items: &[(50004, 1)],
        choice_reward_items: &[(50005, 1), (50006, 1)],
        objectives: &[
            QuestObjective {
                creature_entry: 2007,
                required_count: 1,
                text: "Ashen Knight defeated",
            },
            QuestObjective {
                creature_entry: 2008,
                required_count: 1,
                text: "Orrery Iron Colossus disabled",
            },
        ],
    },
    QuestTemplate {
        quest_id: 70007,
        quest_level: 15,
        min_level: 1,
        zone_or_sort: 5,
        giver_entries: &[1006, 1001, 1015, 1016],
        turnin_entries: &[1006, 1001, 1015, 1016],
        title: "The Sixth Realm: Nocturnum Obsidian",
        objectives_summary: "Vanquish the Obsidian Colossus on Nocturnum Obsidian Isle or in The Elsewhere Sanctum.",
        details: "Across the basalt sea-arch of Nocturnum Obsidian, the caldera moat is guarded by the towering Obsidian Colossus. Until its violet shadow-core is broken, the western seam will tear at the Errand's hull.\n\nCross the lava bridge and shatter the Colossus!",
        request_items_text: "Has the Obsidian Colossus fallen?",
        offer_reward_text: "Incredible! With the Nocturnum Cinder Core secured, all five Kingdoms and the Elsewhere Sanctum are united. The Errand is ready to bring Mere home!",
        end_text: "Return to Rook, Latch, or Tekkaman.",
        reward_xp: 2000,
        reward_money: 2500,
        reward_items: &[(50006, 1)],
        choice_reward_items: &[(50005, 1), (50004, 1)],
        objectives: &[QuestObjective {
            creature_entry: 2005,
            required_count: 1,
            text: "Obsidian Colossus vanquished",
        }],
    },
    QuestTemplate {
        quest_id: 70008,
        quest_level: 4,
        min_level: 1,
        zone_or_sort: 1,
        giver_entries: &[1014],
        turnin_entries: &[1014],
        title: "The Archipelago Express",
        objectives_summary: "Clear 2 Cinderveil Blight Hounds along the Lowbell waterfall path for Postwoman Wren.",
        details: "Now that the seams are opening, I have forty-two bags of post-bell letters to deliver across Celandia! Unfortunately, a pair of Cinderveil Blight Hounds have camped right below the escarpment falls.\n\nClear the delivery trail so the Archipelago Express can roll!",
        request_items_text: "Is the Cinderveil waterfall path safe for the mail cart?",
        offer_reward_text: "Signed, stamped, and delivered! Every household from Lowbell to Mere will get their letters before dinner.",
        end_text: "Return to Postwoman Wren in Lowbell Court.",
        reward_xp: 420,
        reward_money: 350,
        reward_items: &[(50001, 1)],
        choice_reward_items: &[(50003, 1), (50007, 1)],
        objectives: &[QuestObjective {
            creature_entry: 2011,
            required_count: 2,
            text: "Cinderveil Blight Hounds driven off",
        }],
    },
];

pub fn get_quest_template(quest_id: u32) -> Option<&'static QuestTemplate> {
    QUEST_TEMPLATES.iter().find(|q| q.quest_id == quest_id)
}

pub fn quests_for_npc(npc_entry: u32) -> Vec<&'static QuestTemplate> {
    QUEST_TEMPLATES
        .iter()
        .filter(|q| q.giver_entries.contains(&npc_entry) || q.turnin_entries.contains(&npc_entry))
        .collect()
}

// ============================================================================
// 4. Wire Packet Serializers (Exact Match with `benilla-protocol`)
// ============================================================================

fn write_cstring(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(s.as_bytes());
    buf.push(0);
}

/// `SMSG_NPC_TEXT_UPDATE` (`0x0180`):
/// `u32 text_id`, followed by 8 `NpcTextSlot` blocks.
pub fn encode_npc_text_update(text_id: u32) -> Vec<u8> {
    let text = get_npc_text(text_id);
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(&text_id.to_le_bytes());
    for i in 0..8 {
        if i == 0 {
            buf.extend_from_slice(&1.0f32.to_le_bytes()); // probability
            write_cstring(&mut buf, text);
            write_cstring(&mut buf, text);
            buf.extend_from_slice(&0u32.to_le_bytes()); // language = common
            for _ in 0..3 {
                buf.extend_from_slice(&0u32.to_le_bytes()); // delay
                buf.extend_from_slice(&1u32.to_le_bytes()); // emote (talk)
            }
        } else {
            buf.extend_from_slice(&0.0f32.to_le_bytes());
            write_cstring(&mut buf, "");
            write_cstring(&mut buf, "");
            buf.extend_from_slice(&0u32.to_le_bytes());
            for _ in 0..3 {
                buf.extend_from_slice(&0u32.to_le_bytes());
                buf.extend_from_slice(&0u32.to_le_bytes());
            }
        }
    }
    buf
}

/// `SMSG_GOSSIP_MESSAGE` (`0x017D`):
/// `u64 guid`, `u32 title_text_id`, `u32 option_count`, options, `u32 quest_count`, quests.
pub fn encode_gossip_message(
    npc_guid: u64,
    title_text_id: u32,
    options: &[GossipOption],
    quests: &[(&QuestTemplate, u32)], // (quest, quest_icon_status)
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(&npc_guid.to_le_bytes());
    buf.extend_from_slice(&title_text_id.to_le_bytes());
    buf.extend_from_slice(&(options.len() as u32).to_le_bytes());
    for opt in options {
        buf.extend_from_slice(&opt.id.to_le_bytes());
        buf.push(opt.icon);
        buf.push(0); // coded = false
        write_cstring(&mut buf, opt.text);
    }
    buf.extend_from_slice(&(quests.len() as u32).to_le_bytes());
    for &(q, icon) in quests {
        buf.extend_from_slice(&q.quest_id.to_le_bytes());
        buf.extend_from_slice(&icon.to_le_bytes());
        buf.extend_from_slice(&(q.quest_level as i32).to_le_bytes());
        write_cstring(&mut buf, q.title);
    }
    buf
}

/// `SMSG_QUESTGIVER_STATUS` (`0x0183`): `u64 guid`, `u32 status` (1.12 uses `u8` in some cores,
/// wait — let's check `benilla-protocol/src/messages/quest/giver.rs` `QuestGiverStatus::read`!).
/// In `benilla-protocol/src/messages/quest/giver.rs` line 40:
/// `guid: read_u64_le(r)?, status: read_u32_le(r)?`. It reads `u32`!
pub fn encode_questgiver_status(npc_guid: u64, status: u8) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12);
    buf.extend_from_slice(&npc_guid.to_le_bytes());
    buf.extend_from_slice(&u32::from(status).to_le_bytes());
    buf
}

/// `SMSG_QUEST_QUERY_RESPONSE` (`0x005D`): exact match with `QuestQueryResponse::read` in `benilla-protocol`.
pub fn encode_quest_query_response(q: &QuestTemplate) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);
    buf.extend_from_slice(&q.quest_id.to_le_bytes());
    buf.extend_from_slice(&2u32.to_le_bytes()); // quest_method = 2
    buf.extend_from_slice(&(q.quest_level as i32).to_le_bytes());
    buf.extend_from_slice(&q.zone_or_sort.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // quest_type
    buf.extend_from_slice(&0u32.to_le_bytes()); // reputation_objective_faction
    buf.extend_from_slice(&0u32.to_le_bytes()); // reputation_objective_value
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_opposite_rep_faction
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_opposite_rep_value
    buf.extend_from_slice(&0u32.to_le_bytes()); // next_quest_in_chain
    buf.extend_from_slice(&(q.reward_money as i32).to_le_bytes());
    buf.extend_from_slice(&q.reward_money.to_le_bytes()); // max_level_reward_money
    buf.extend_from_slice(&0u32.to_le_bytes()); // reward_spell
    buf.extend_from_slice(&0u32.to_le_bytes()); // source_item_id
    buf.extend_from_slice(&0x08u32.to_le_bytes()); // quest_flags (sharable)

    // 4 fixed reward items (item_id, count)
    for i in 0..4 {
        let (item_id, count) = q.reward_items.get(i).copied().unwrap_or((0, 0));
        buf.extend_from_slice(&item_id.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
    }
    // 6 choice reward items (item_id, count)
    for i in 0..6 {
        let (item_id, count) = q.choice_reward_items.get(i).copied().unwrap_or((0, 0));
        buf.extend_from_slice(&item_id.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
    }

    // point_map_id, point_x, point_y, point_opt
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&0.0f32.to_le_bytes());
    buf.extend_from_slice(&0.0f32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());

    write_cstring(&mut buf, q.title);
    write_cstring(&mut buf, q.objectives_summary);
    write_cstring(&mut buf, q.details);
    write_cstring(&mut buf, q.end_text);

    // 4 (creature_or_go_id, count, item_id, item_count) pairs
    for i in 0..4 {
        if let Some(obj) = q.objectives.get(i) {
            buf.extend_from_slice(&(obj.creature_entry as i32).to_le_bytes());
            buf.extend_from_slice(&obj.required_count.to_le_bytes());
        } else {
            buf.extend_from_slice(&0i32.to_le_bytes());
            buf.extend_from_slice(&0u32.to_le_bytes());
        }
        buf.extend_from_slice(&0u32.to_le_bytes()); // req_item_id
        buf.extend_from_slice(&0u32.to_le_bytes()); // req_item_count
    }

    // 4 objective texts
    for i in 0..4 {
        let text = q.objectives.get(i).map_or("", |o| o.text);
        write_cstring(&mut buf, text);
    }
    buf
}

/// `SMSG_QUESTGIVER_QUEST_DETAILS` (`0x0188`): exact match with `QuestDetails::read`.
pub fn encode_questgiver_quest_details(npc_guid: u64, q: &QuestTemplate) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);
    buf.extend_from_slice(&npc_guid.to_le_bytes());
    buf.extend_from_slice(&q.quest_id.to_le_bytes());
    write_cstring(&mut buf, q.title);
    write_cstring(&mut buf, q.details);
    write_cstring(&mut buf, q.objectives_summary);
    buf.extend_from_slice(&1u32.to_le_bytes()); // auto_finish = 1 (active accept button)

    // Choice rewards: count, then [item_id, count, display_id]
    buf.extend_from_slice(&(q.choice_reward_items.len() as u32).to_le_bytes());
    for &(item_id, count) in q.choice_reward_items {
        let disp = get_item_template(item_id).map_or(item_id, |t| t.display_id);
        buf.extend_from_slice(&item_id.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
        buf.extend_from_slice(&disp.to_le_bytes());
    }

    // Fixed rewards: count, then [item_id, count, display_id]
    buf.extend_from_slice(&(q.reward_items.len() as u32).to_le_bytes());
    for &(item_id, count) in q.reward_items {
        let disp = get_item_template(item_id).map_or(item_id, |t| t.display_id);
        buf.extend_from_slice(&item_id.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
        buf.extend_from_slice(&disp.to_le_bytes());
    }

    buf.extend_from_slice(&q.reward_money.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // reward_spell

    // 4 emotes: (emote, delay_ms)
    buf.extend_from_slice(&4u32.to_le_bytes());
    for i in 0..4 {
        let emote = if i == 0 { 1u32 } else { 0u32 };
        buf.extend_from_slice(&emote.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
    }
    buf
}

/// `SMSG_QUESTGIVER_REQUEST_ITEMS` (`0x018B`): exact match with `QuestRequestItems::read`.
pub fn encode_questgiver_request_items(
    npc_guid: u64,
    q: &QuestTemplate,
    completable: bool,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(&npc_guid.to_le_bytes());
    buf.extend_from_slice(&q.quest_id.to_le_bytes());
    write_cstring(&mut buf, q.title);
    write_cstring(&mut buf, q.request_items_text);
    buf.extend_from_slice(&0u32.to_le_bytes()); // emote_delay
    buf.extend_from_slice(&1u32.to_le_bytes()); // emote
    buf.extend_from_slice(&0u32.to_le_bytes()); // auto_finish
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_money
    buf.extend_from_slice(&0u32.to_le_bytes()); // required_items count
    buf.extend_from_slice(&2u32.to_le_bytes()); // flags1 = 2
    let flags2 = if completable { 0x03u32 } else { 0x00u32 };
    buf.extend_from_slice(&flags2.to_le_bytes());
    buf.extend_from_slice(&0x04u32.to_le_bytes()); // flags3 = 4
    buf.extend_from_slice(&0x08u32.to_le_bytes()); // flags4 = 8
    buf
}

/// `SMSG_QUESTGIVER_OFFER_REWARD` (`0x018D`): exact match with `QuestOfferReward::read`.
pub fn encode_questgiver_offer_reward(npc_guid: u64, q: &QuestTemplate) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);
    buf.extend_from_slice(&npc_guid.to_le_bytes());
    buf.extend_from_slice(&q.quest_id.to_le_bytes());
    write_cstring(&mut buf, q.title);
    write_cstring(&mut buf, q.offer_reward_text);
    buf.extend_from_slice(&1u32.to_le_bytes()); // enable_next = 1

    // 4 emotes: NOTE that OfferReward writes `(delay_ms, emote)` order!
    buf.extend_from_slice(&4u32.to_le_bytes());
    for i in 0..4 {
        let emote = if i == 0 { 1u32 } else { 0u32 };
        buf.extend_from_slice(&0u32.to_le_bytes()); // delay_ms
        buf.extend_from_slice(&emote.to_le_bytes()); // emote
    }

    // Choice rewards
    buf.extend_from_slice(&(q.choice_reward_items.len() as u32).to_le_bytes());
    for &(item_id, count) in q.choice_reward_items {
        let disp = get_item_template(item_id).map_or(item_id, |t| t.display_id);
        buf.extend_from_slice(&item_id.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
        buf.extend_from_slice(&disp.to_le_bytes());
    }

    // Fixed rewards
    buf.extend_from_slice(&(q.reward_items.len() as u32).to_le_bytes());
    for &(item_id, count) in q.reward_items {
        let disp = get_item_template(item_id).map_or(item_id, |t| t.display_id);
        buf.extend_from_slice(&item_id.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
        buf.extend_from_slice(&disp.to_le_bytes());
    }

    buf.extend_from_slice(&q.reward_money.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // quest_flags
    buf.extend_from_slice(&0u32.to_le_bytes()); // reward_spell
    buf
}

/// `SMSG_QUESTGIVER_QUEST_COMPLETE` (`0x0191`): exact match with `QuestComplete::read`.
pub fn encode_questgiver_quest_complete(q: &QuestTemplate, chosen_item_id: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(&q.quest_id.to_le_bytes());
    buf.extend_from_slice(&3u32.to_le_bytes()); // unknown = 3
    buf.extend_from_slice(&q.reward_xp.to_le_bytes());
    buf.extend_from_slice(&q.reward_money.to_le_bytes());

    let mut items: Vec<(u32, u32)> = q.reward_items.to_vec();
    if chosen_item_id != 0 {
        if let Some(&choice) = q
            .choice_reward_items
            .iter()
            .find(|&&(id, _)| id == chosen_item_id)
        {
            items.push(choice);
        }
    }
    buf.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for (id, count) in items {
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
    }
    buf
}

/// `SMSG_QUESTUPDATE_ADD_KILL` (`0x0199`): exact match with `QuestUpdateAddKill::read`.
pub fn encode_questupdate_add_kill(
    quest_id: u32,
    entry: u32,
    new_count: u32,
    max_count: u32,
    victim_guid: u64,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(24);
    buf.extend_from_slice(&quest_id.to_le_bytes());
    buf.extend_from_slice(&entry.to_le_bytes());
    buf.extend_from_slice(&new_count.to_le_bytes());
    buf.extend_from_slice(&max_count.to_le_bytes());
    buf.extend_from_slice(&victim_guid.to_le_bytes());
    buf
}
