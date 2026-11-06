-- ============================================================================
-- Celandia: Xirtoth — CMaNGOS / vMaNGOS 1.12.1 (Build 5875) World & Realm Seed
-- ============================================================================
-- Note: By default, `deploy/docker-compose.yml` runs the native Rust
-- `celandia-server` binary which embeds all Celandia templates, spawns, quests,
-- gossip, combat AI, and terrain heights out-of-the-box with zero SQL setup.
--
-- If you prefer to run stock CMaNGOS / vMaNGOS `mangosd` + `realmd` against
-- MariaDB (`xirtoth-db`), import this seed into your `realmd` and `mangos`
-- databases:
--   mysql -u root -p < deploy/celandia-world.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Realm List & Default Accounts (`realmd`)
-- ----------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS `realmd`;
USE `realmd`;

UPDATE `realmlist`
SET `name` = 'Wokecraft NoW — Celandia',
    `address` = '127.0.0.1',
    `port` = 8085,
    `icon` = 0,
    `realmflags` = 0,
    `timezone` = 1,
    `allowedSecurityLevel` = 0
WHERE `id` = 1;

-- ----------------------------------------------------------------------------
-- 2. World Database (`mangos`) — Creature Templates (1001..1016, 2001..2011)
-- ----------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS `mangos`;
USE `mangos`;

DELETE FROM `creature_template` WHERE `entry` BETWEEN 1001 AND 1016 OR `entry` BETWEEN 2001 AND 2011;

INSERT INTO `creature_template` (
  `entry`, `name`, `subname`, `minlevel`, `maxlevel`,
  `modelid_1`, `faction_A`, `faction_H`, `scale`,
  `minhealth`, `maxhealth`, `minmana`, `maxmana`,
  `mindmg`, `maxdmg`, `baseattacktime`, `npcflag`, `type`, `family`, `rank`, `AIName`
) VALUES
  -- Friendly Cast & Kingdom Envoys (Display IDs 1..16 in CreatureDisplayInfo.dbc)
  (1001, 'Pip', 'The Cracked Cup', 12, 12, 1, 35, 35, 1.00, 1200, 1200, 600, 600, 18, 26, 2000, 3, 7, 0, 0, 'NullAI'),
  (1002, 'Tock', 'Unwound Scout', 15, 15, 2, 35, 35, 1.05, 1650, 1650, 400, 400, 24, 34, 1800, 3, 9, 0, 0, 'NullAI'),
  (1003, 'Barnaby', 'Lost Button', 10, 10, 3, 35, 35, 0.90, 980, 980, 300, 300, 14, 20, 2000, 3, 7, 0, 0, 'NullAI'),
  (1004, 'Lord Snuff', 'Candle-Baron', 25, 25, 4, 35, 35, 1.20, 4500, 4500, 2000, 2000, 48, 68, 2000, 3, 7, 0, 1, 'NullAI'),
  (1005, 'Lady Vespera', 'Keeper of the Crack', 30, 30, 5, 35, 35, 1.15, 6200, 6200, 4800, 4800, 60, 85, 2000, 3, 7, 0, 1, 'NullAI'),
  (1006, 'Elder Moss', 'Soup-Maker', 28, 28, 6, 35, 35, 1.25, 5800, 5800, 3600, 3600, 52, 74, 2200, 3, 7, 0, 1, 'NullAI'),
  (1007, 'Odo', 'Cloud-Shepherd', 20, 20, 7, 35, 35, 1.10, 3100, 3100, 1500, 1500, 35, 50, 2000, 3, 7, 0, 0, 'NullAI'),
  (1008, 'Constable Kettle', 'Porcelain Watch', 22, 22, 8, 35, 35, 1.15, 3800, 3800, 0, 0, 42, 60, 1800, 3, 7, 0, 0, 'NullAI'),
  (1009, 'Brother Vellum', 'Archivist of Folds', 18, 18, 9, 35, 35, 1.00, 2200, 2200, 2400, 2400, 28, 40, 2000, 3, 7, 0, 0, 'NullAI'),
  (1010, 'Scribe Nib', 'Margin-Walker', 14, 14, 10, 35, 35, 0.95, 1450, 1450, 1600, 1600, 20, 30, 2000, 1, 7, 0, 0, 'NullAI'),
  (1011, 'Lanolin', 'Bell-Wether', 19, 19, 11, 35, 35, 1.05, 2600, 2600, 1800, 1800, 30, 44, 2000, 1, 7, 0, 0, 'NullAI'),
  (1012, 'Sister Gloam', 'Wick-Tender', 21, 21, 12, 35, 35, 1.00, 2900, 2900, 2800, 2800, 34, 48, 2000, 1, 7, 0, 0, 'NullAI'),
  (1013, 'Master Chime', 'Escapement Keeper', 24, 24, 13, 35, 35, 1.15, 4200, 4200, 2200, 2200, 45, 64, 1800, 3, 9, 0, 1, 'NullAI'),
  (1014, 'Fern', 'Root-Speaker', 16, 16, 14, 35, 35, 1.00, 1950, 1950, 2100, 2100, 25, 36, 2000, 1, 7, 0, 0, 'NullAI'),
  (1015, 'Oris the Lantern-Bearer', 'Errand Guide', 25, 25, 15, 35, 35, 1.12, 4800, 4800, 3200, 3200, 46, 66, 2000, 3, 7, 0, 1, 'NullAI'),
  (1016, 'Seam-Tender Mira', 'Sanctum Warden', 26, 26, 16, 35, 35, 1.10, 5000, 5000, 3800, 3800, 50, 70, 2000, 3, 7, 0, 1, 'NullAI'),

  -- Hostile Celandia Fauna & Bosses (Display IDs 20..30 in CreatureDisplayInfo.dbc)
  (2001, 'Porcelain Shard-Hound', 'Splintered Watch', 2, 2, 20, 14, 14, 0.95, 120, 120, 0, 0, 6, 10, 2000, 0, 1, 1, 0, 'AggressorAI'),
  (2002, 'Cracked Sentinel', 'Hollow Guard', 4, 4, 21, 14, 14, 1.15, 240, 240, 100, 100, 11, 17, 2200, 0, 9, 0, 0, 'AggressorAI'),
  (2003, 'Ink-Blot Creeper', 'Spilled Margin', 3, 3, 22, 14, 14, 1.00, 170, 170, 160, 160, 9, 14, 2000, 0, 4, 0, 0, 'AggressorAI'),
  (2004, 'Origami Razor-Wing', 'Folded Predator', 5, 5, 23, 14, 14, 1.05, 280, 280, 0, 0, 13, 20, 1700, 0, 1, 0, 0, 'AggressorAI'),
  (2005, 'Rusted Ratchet-Beetle', 'Overwound Pest', 4, 4, 24, 14, 14, 1.00, 230, 230, 0, 0, 10, 16, 1800, 0, 9, 0, 0, 'AggressorAI'),
  (2006, 'Overwound Automaton', 'Runaway Mainspring', 7, 7, 25, 14, 14, 1.25, 450, 450, 200, 200, 18, 28, 2000, 0, 9, 0, 1, 'AggressorAI'),
  (2007, 'Tallow Leech', 'Wax-Drinker', 5, 5, 26, 14, 14, 1.00, 290, 290, 180, 180, 12, 19, 2000, 0, 1, 0, 0, 'AggressorAI'),
  (2008, 'Gutter-Wick Wisp', 'Drowning Flame', 6, 6, 27, 14, 14, 1.05, 340, 340, 300, 300, 15, 23, 2000, 0, 4, 0, 0, 'AggressorAI'),
  (2009, 'Storm-TornNimbus', 'Unraveled Wool', 6, 6, 28, 14, 14, 1.15, 360, 360, 280, 280, 16, 24, 2000, 0, 4, 0, 0, 'AggressorAI'),
  (2010, 'Hollow Bramble-Stalker', 'Dry-Rot Lurker', 5, 5, 29, 14, 14, 1.10, 310, 310, 140, 140, 14, 21, 2000, 0, 4, 0, 0, 'AggressorAI'),
  (2011, 'Archon Xirtoth', 'Herald of the Un-Bell', 12, 12, 30, 14, 14, 1.55, 1800, 1800, 2000, 2000, 32, 48, 2000, 0, 3, 0, 3, 'AggressorAI');

-- ----------------------------------------------------------------------------
-- 3. World Creature Spawns (`creature`) — Map 0 (Celandia) & Map 1 (Sanctum)
-- ----------------------------------------------------------------------------
DELETE FROM `creature` WHERE `guid` BETWEEN 90001 AND 90060;

INSERT INTO `creature` (`guid`, `id`, `map`, `position_x`, `position_y`, `position_z`, `orientation`, `spawntimesecs`, `spawndist`, `MovementType`) VALUES
  -- Porcelain Court (Friendly Cast & Hostile Shards)
  (90001, 1001, 0,   25.0,   -10.0, 26.80, 3.14, 15,  0.0, 0),
  (90002, 1005, 0,    0.0,     0.0, 33.40, 4.71, 15,  0.0, 0),
  (90003, 1008, 0,  -16.0,    12.0, 28.90, 0.80, 15,  0.0, 0),
  (90004, 1003, 0,   42.0,    18.0, 21.10, 2.40, 15,  0.0, 0),
  (90005, 2001, 0,   55.0,   -28.0, 19.40, 1.20, 15, 12.0, 1),
  (90006, 2001, 0,   68.0,     4.0, 18.20, 2.80, 15, 12.0, 1),
  (90007, 2001, 0,  -48.0,   -35.0, 20.60, 0.50, 15, 12.0, 1),
  (90008, 2001, 0,   12.0,   -62.0, 19.10, 1.57, 15, 12.0, 1),
  (90009, 2002, 0,  -64.0,    24.0, 18.80, 5.10, 15, 10.0, 1),
  (90010, 2002, 0,   38.0,    56.0, 18.90, 3.90, 15, 10.0, 1),

  -- Kingdom of Paper & Ink
  (90011, 1009, 0, -210.0,  -150.0,  9.20, 0.40, 15,  0.0, 0),
  (90012, 1010, 0, -196.0,  -164.0,  8.60, 1.90, 15,  0.0, 0),
  (90013, 2003, 0, -242.0,  -132.0,  8.40, 0.90, 15, 14.0, 1),
  (90014, 2003, 0, -228.0,  -188.0,  7.90, 2.10, 15, 14.0, 1),
  (90015, 2003, 0, -172.0,  -138.0,  7.50, 4.20, 15, 14.0, 1),
  (90016, 2004, 0, -258.0,  -166.0,  9.10, 0.10, 15, 16.0, 1),
  (90017, 2004, 0, -184.0,  -195.0,  7.80, 1.70, 15, 16.0, 1),

  -- The Clockwork Warren
  (90018, 1002, 0, -178.0,   182.0, 11.40, 5.20, 15,  0.0, 0),
  (90019, 1013, 0, -195.0,   196.0, 12.10, 4.50, 15,  0.0, 0),
  (90020, 2005, 0, -155.0,   168.0, 10.20, 3.10, 15, 12.0, 1),
  (90021, 2005, 0, -218.0,   172.0, 10.80, 0.70, 15, 12.0, 1),
  (90022, 2005, 0, -168.0,   220.0, 10.50, 4.40, 15, 12.0, 1),
  (90023, 2006, 0, -226.0,   216.0, 11.20, 5.60, 15, 10.0, 1),
  (90024, 2006, 0, -148.0,   204.0, 10.10, 3.80, 15, 10.0, 1),

  -- The Candlewax Marsh
  (90025, 1004, 0,  164.0,   212.0,  2.80, 3.70, 15,  0.0, 0),
  (90026, 1012, 0,  150.0,   196.0,  2.60, 0.90, 15,  0.0, 0),
  (90027, 2007, 0,  136.0,   228.0,  1.90, 5.10, 15, 14.0, 1),
  (90028, 2007, 0,  188.0,   186.0,  2.10, 2.50, 15, 14.0, 1),
  (90029, 2007, 0,  196.0,   238.0,  2.00, 3.90, 15, 14.0, 1),
  (90030, 2008, 0,  124.0,   184.0,  2.20, 0.40, 15, 15.0, 1),
  (90031, 2008, 0,  176.0,   254.0,  1.80, 4.60, 15, 15.0, 1),

  -- The Cloud-pasture
  (90032, 1007, 0,   42.0,  -258.0, 19.60, 1.57, 15,  0.0, 0),
  (90033, 1011, 0,   26.0,  -244.0, 18.90, 0.80, 15,  0.0, 0),
  (90034, 2009, 0,   68.0,  -238.0, 18.20, 2.90, 15, 16.0, 1),
  (90035, 2009, 0,    8.0,  -278.0, 18.50, 0.50, 15, 16.0, 1),
  (90036, 2009, 0,   58.0,  -288.0, 18.10, 2.10, 15, 16.0, 1),

  -- The Kingdom of Root & Moss
  (90037, 1006, 0,  228.0,   -84.0, 11.80, 3.14, 15,  0.0, 0),
  (90038, 1014, 0,  212.0,   -68.0, 11.20, 2.60, 15,  0.0, 0),
  (90039, 2010, 0,  194.0,  -102.0, 10.40, 0.60, 15, 14.0, 1),
  (90040, 2010, 0,  252.0,   -62.0, 10.90, 3.80, 15, 14.0, 1),
  (90041, 2010, 0,  246.0,  -116.0, 10.50, 2.20, 15, 14.0, 1),

  -- Seam-Bridges & Sanctum Portal (Map 0)
  (90042, 1015, 0,  -95.0,   -28.0,  2.50, 0.30, 15,  0.0, 0),
  (90043, 1016, 0, -108.0,   -34.0,  2.20, 0.50, 15,  0.0, 0),

  -- Map 1: The Elsewhere Sanctum (Instance Dungeon)
  (90044, 1016, 1,    6.0,     4.0,  0.50, 3.14, 15,  0.0, 0),
  (90045, 2002, 1,   18.0,    -8.0,  0.50, 3.14, 15,  6.0, 1),
  (90046, 2002, 1,   18.0,     8.0,  0.50, 3.14, 15,  6.0, 1),
  (90047, 2006, 1,   32.0,   -10.0,  0.50, 3.14, 15,  6.0, 1),
  (90048, 2008, 1,   32.0,    10.0,  0.50, 3.14, 15,  6.0, 1),
  (90049, 2011, 1,   48.0,     0.0,  1.00, 3.14, 15,  0.0, 0);

-- ----------------------------------------------------------------------------
-- 4. Custom Celandia Items (`item_template`, 50001..50012)
-- ----------------------------------------------------------------------------
DELETE FROM `item_template` WHERE `entry` BETWEEN 50001 AND 50012;

INSERT INTO `item_template` (
  `entry`, `class`, `subclass`, `name`, `displayid`, `Quality`,
  `BuyPrice`, `SellPrice`, `InventoryType`, `ItemLevel`, `RequiredLevel`,
  `dmg_min1`, `dmg_max1`, `delay`, `description`
) VALUES
  (50001, 2,  7, 'Kintsugi Glaze-Blade',         24262, 3, 2500,  500, 13, 15, 1, 14, 24, 1800, 'Mended with warm gold lacquer along a hairline fracture; hums when struck.'),
  (50002, 2, 10, 'Staff of the Un-Bell',         22802, 4, 5000, 1000, 17, 20, 1, 22, 36, 2400, 'Carved from an ash-root that grew around a silent bronze clapper.'),
  (50003, 2, 15, 'Escapement Spring-Dagger',     21520, 3, 2000,  400, 13, 14, 1, 11, 19, 1400, 'Ticks softly at the hilt; never loses a second even in Candlewax fog.'),
  (50004, 2, 19, 'Porcelain Chime-Wand',         21801, 3, 1800,  360, 15, 14, 1, 12, 22, 1500, 'Resonates with the clear C-sharp of the high Saucer Terrace.'),
  (50005, 4,  6, 'Saucer-Rim Buckler',           21485, 3, 2200,  440, 14, 15, 1,  0,  0,    0, 'Fired thrice in the High Kiln; deflects both ink-blots and brass teeth.'),
  (50006, 4,  0, 'Lantern of the Errand',        13503, 3, 1500,  300, 23, 15, 1,  0,  0,    0, 'Holds a steady tallow flame that points toward the nearest unbroken Seam-Bridge.'),
  (50007, 4,  1, 'Mantle of Folded Vellum',      21694, 3, 1600,  320,  3, 15, 1,  0,  0,    0, 'Inscribed with protective marginalia by Brother Vellum of the Paper Court.'),
  (50008, 15, 0, 'Glazed Porcelain Shard',        4594, 1,  100,   25,  0,  5, 1,  0,  0,    0, 'A curved fragment of cobalt-trimmed porcelain from the Outer Rim.'),
  (50009, 15, 0, 'Vial of Living Ink',            3372, 1,  120,   30,  0,  5, 1,  0,  0,    0, 'Still curls into tiny punctuation marks inside the glass.'),
  (50010, 15, 0, 'Brass Escapement Gear',         4375, 1,  140,   35,  0,  6, 1,  0,  0,    0, 'Precision-cut toothwheel recovered from a runaway Warren automaton.'),
  (50011, 15, 0, 'Unmelted Tallow Core',          5952, 1,  150,   40,  0,  6, 1,  0,  0,    0, 'Warm to the touch; smells faintly of beeswax and marsh-reed.'),
  (50012,  0, 0, 'Bowl of Elder Moss''s Broth',  13931, 2,  200,   50,  0, 10, 1,  0,  0,    0, 'Brewed over slow roots; restores warmth and mends hairline cracks.');

-- ----------------------------------------------------------------------------
-- 5. Celandia Quests (`quest_template`, 70001..70008) & Relations
-- ----------------------------------------------------------------------------
DELETE FROM `quest_template` WHERE `entry` BETWEEN 70001 AND 70008;
DELETE FROM `creature_questrelation` WHERE `quest` BETWEEN 70001 AND 70008;
DELETE FROM `creature_involvedrelation` WHERE `quest` BETWEEN 70001 AND 70008;

INSERT INTO `quest_template` (
  `entry`, `ZoneOrSort`, `MinLevel`, `QuestLevel`, `Type`,
  `Title`, `Objectives`, `Details`, `EndText`, `OfferRewardText`, `RequestItemsText`,
  `ReqCreatureOrGOId1`, `ReqCreatureOrGOCount1`, `ReqItemId1`, `ReqItemCount1`,
  `RewItemId1`, `RewItemCount1`, `RewOrReqMoney`, `RewXP`
) VALUES
  (70001, 100, 1,  2, 0, 'A Chip in the Saucer',
   'Slay 3 Porcelain Shard-Hounds along the Outer Rim and return to Pip in the Porcelain Court.',
   'Hear that? When the Un-Bell didn''t ring, the glaze along the Saucer Terrace shivered right off its clay! Now the stray shards have grown teeth. Clear three of the Shard-Hounds before they chip my handle too!',
   'Return to Pip at the Saucer Terrace.',
   'Not a single new crack on you! Here—take this Kintsugi blade and a bowl of Moss''s warm broth.',
   'Did the Shard-Hounds nip your heels?',
   2001, 3, 50008, 2, 50001, 1, 150, 250),

  (70002, 100, 1,  4, 0, 'The Hairline Decree',
   'Defeat 2 Cracked Sentinels guarding the Fractured Balustrade and report to Lady Vespera.',
   'The Porcelain Court does not acknowledge fractures—yet two of our own Hollow Sentinels have gone brittle and begun striking anyone who crosses the High Kiln Plaza. Put them gently to rest.',
   'Report to Lady Vespera in the Porcelain Court.',
   'You move with admirable poise. Accept this Saucer-Rim Buckler with the Court''s quiet gratitude.',
   'Have the Cracked Sentinels been stilled?',
   2002, 2, 0, 0, 50005, 1, 250, 400),

  (70003, 101, 1,  4, 0, 'Margins Run Wild',
   'Clear 3 Ink-Blot Creepers in the Kingdom of Paper & Ink for Brother Vellum.',
   'Someone overturned the Great Inkwell during the tremor! Now Ink-Blot Creepers are crawling across our finest first editions and eating the footnotes. Blot out three of them before the Treaty of Seams becomes illegible!',
   'Return to Brother Vellum in the Kingdom of Paper & Ink.',
   'Splendid! The margins are clean again. Wear this Mantle of Folded Vellum so the rain never smudges your travels.',
   'Are the Ink-Blot Creepers still smearing the folios?',
   2003, 3, 50009, 2, 50007, 1, 220, 380),

  (70004, 102, 1,  5, 0, 'Winding Back the Warren',
   'Dismantle 3 Rusted Ratchet-Beetles in the Clockwork Warren for Tock.',
   'Tick-tick-stuck! The Ratchet-Beetles got into the grease-vats and now their mainsprings are wound three turns too tight. Knock three of them loose and bring me their brass gears before the Pendulum Well jams!',
   'Return to Tock in the Clockwork Warren.',
   'Click-whirr! Right on the beat! Take this Escapement Spring-Dagger—it never misses a tick.',
   'Still hearing those overwound beetles clicking?',
   2005, 3, 50010, 2, 50003, 1, 280, 450),

  (70005, 103, 1,  6, 0, 'Wicks in the Bog',
   'Extinguish 3 Tallow Leeches in the Candlewax Marsh for Lord Snuff.',
   'A proper candle burns from the top down, traveller—not from the bottom up! Those dreadful Tallow Leeches are siphoning the wax right out of my Causeway lanterns. Snuff three of the beasts at once.',
   'Return to Lord Snuff in the Candlewax Marsh.',
   'A clean flame and a steady hand! Carry this Lantern of the Errand whenever you cross the Seam-Bridges.',
   'Have you dealt with those greedy Tallow Leeches?',
   2007, 3, 50011, 2, 50006, 1, 320, 520),

  (70006, 104, 1,  6, 0, 'Shearing the Storm-Flock',
   'Calm 2 Storm-Torn Nimbi in the Cloud-pasture for Odo the Cloud-Shepherd.',
   'My poor cumulus wethers got static in their wool when the sky-seam split! Two of them have turned into Storm-Torn Nimbi and they''re pelting the meadow with hail. Give them a good shearing so they settle back into mist!',
   'Return to Odo in the Cloud-pasture.',
   'Ah, look how softly they drift now! Take this Porcelain Chime-Wand—it sings in clear weather.',
   'Are those Storm-Torn Nimbi still thundering over the pasture?',
   2009, 2, 0, 0, 50004, 1, 350, 580),

  (70007, 105, 1,  6, 0, 'Broth for the Deep Roots',
   'Clear 2 Hollow Bramble-Stalkers in the Kingdom of Root & Moss for Elder Moss.',
   'You can''t simmer a proper root-broth when Hollow Bramble-Stalkers are tangling theladles! Shoo two of those dry-rot lurkers out of my hollow, and I''ll ladle you enough broth to warm your bones for a week.',
   'Return to Elder Moss in the Kingdom of Root & Moss.',
   'There now, smell that sage and star-moss? Drink up, little traveller—the road to the Sanctum is cold.',
   'Have those Bramble-Stalkers cleared out of the roots?',
   2010, 2, 0, 0, 50012, 3, 360, 600),

  (70008, 200, 1, 10, 81, 'Silencing the Un-Bell',
   'Enter The Elsewhere Sanctum through the Seam-Bridge Portal, defeat Archon Xirtoth, and return to Seam-Tender Mira.',
   'Beyond the Seam-Bridge Portal lies The Elsewhere Sanctum, where Archon Xirtoth tolls the Un-Bell—the hollow resonance that is splitting Porcelain, Paper, Gear, Wax, Cloud, and Root apart. Step through the portal (or speak with me to cross), strike down Xirtoth, and save the Six Kingdoms!',
   'Return to Seam-Tender Mira.',
   'The Un-Bell is still, and the Six Kingdoms breathe together once more! Bear the Staff of the Un-Bell as Champion of Celandia!',
   'Does Archon Xirtoth still toll the Un-Bell within the Sanctum?',
   2011, 1, 0, 0, 50002, 1, 1000, 1500);

INSERT INTO `creature_questrelation` (`id`, `quest`) VALUES
  (1001, 70001),
  (1005, 70002),
  (1009, 70003),
  (1002, 70004),
  (1004, 70005),
  (1007, 70006),
  (1006, 70007),
  (1016, 70008);

INSERT INTO `creature_involvedrelation` (`id`, `quest`) VALUES
  (1001, 70001),
  (1005, 70002),
  (1009, 70003),
  (1002, 70004),
  (1004, 70005),
  (1007, 70006),
  (1006, 70007),
  (1016, 70008);

-- ----------------------------------------------------------------------------
-- 6. NPC Text (`npc_text`) & Gossip Menus (`gossip_menu_option`)
-- ----------------------------------------------------------------------------
DELETE FROM `npc_text` WHERE `ID` BETWEEN 1001 AND 1016;

INSERT INTO `npc_text` (`ID`, `text0_0`) VALUES
  (1001, 'Mind my handle! Every time the Un-Bell hums beneath the Seam-Bridges, the crack in my porcelain widens another hair. Lady Vespera pretends nobody in the Court is chipped, of course—she''d rather we all shatter politely than admit the kiln went cold.'),
  (1002, 'Tick... tick... almost! My mainspring slipped three teeth when the Warren shook, and Master Chime says if I stop moving I''ll rust solid before tea-time. Watch out for the Ratchet-Beetles—they''ve been chewing through the brass pendulums!'),
  (1003, 'Have you seen a coat of blue cloud-wool with three brass buttons and one missing? That''s mine! Or rather, I''m its fourth button. I rolled all the way down from the Cloud-pasture when the wind turned sideways.'),
  (1004, 'Easy near the wicks, traveller! Here in the Candlewax Marsh, a hasty stride splashes tallow on your boots, and a cold draft costs a baron half his height. Keep your lantern trimmed—those Tallow Leeches love an unguarded flame.'),
  (1005, 'Welcome to the Porcelain Court. Please step lightly upon the Saucer Terrace; acoustics here are delicate, and we do not speak of fractures in polite company. Still... if you could silence the Cracked Sentinels beyond the balustrade, the Court would remember your grace.'),
  (1006, 'Come warm your hands by the pot, little traveller! Nothing in the Six Kingdoms mends a frayed seam like slow-simmered root-broth. Just don''t let the Hollow Bramble-Stalkers near my ladle!'),
  (1007, 'Hush now—don''t startle the cumulus! When a cloud-sheep gets static in its fleece, it rains sideways for a week. Help me shear the Storm-Torn Nimbi and the whole sky over Celandia will clear.'),
  (1008, 'By order of the Porcelain Watch: no running on the glaze, no ringing unauthorized bells, and definitely no feeding the Shard-Hounds after dusk!'),
  (1009, 'Every kingdom in Celandia was once written on a single sheet, you know—until someone folded the corners too sharply. Now the Ink-Blot Creepers are trying to rewrite our footnotes while the ink is still wet!'),
  (1010, 'I walk the margins so the story doesn''t spill off the page! Keep your boots out of the ink-puddles!'),
  (1011, 'Baa-ding! Keep the flock upwind of the Clockwork Warren, or their wool smells of axle-grease for a month!'),
  (1012, 'A single warm wick keeps the marsh-fog back ten paces. Never let your candle gutter in the reeds.'),
  (1013, 'The Great Escapement measures the breath of all Six Kingdoms. If the Overwound Automatons snap the central balance-wheel, afternoon will collide with yesterday!'),
  (1014, 'Listen closely to the taproots—they felt Archon Xirtoth stirring in the Elsewhere Sanctum long before the Porcelain cracked.'),
  (1015, 'The Errand binds the Six Kingdoms together across the Seam-Bridges. Tell me where your lantern points, traveller, and I will guide your steps across the mist.'),
  (1016, 'This portal opens directly into The Elsewhere Sanctum (Map 1), where Archon Xirtoth tolls the Un-Bell. Speak the word when your blade and spellbook are ready, or step straight through the shimmering threshold.');

-- ----------------------------------------------------------------------------
-- 7. AreaTrigger Teleports (`areatrigger_teleport`) & Starting Spawn (`playercreateinfo`)
-- ----------------------------------------------------------------------------
DELETE FROM `areatrigger_teleport` WHERE `id` IN (9001, 9002);

INSERT INTO `areatrigger_teleport` (`id`, `name`, `target_map`, `target_position_x`, `target_position_y`, `target_position_z`, `target_orientation`) VALUES
  (9001, 'Celandia — Seam-Bridge Portal to The Elsewhere Sanctum', 1,    0.0,   0.0,  0.50, 0.00),
  (9002, 'The Elsewhere Sanctum — Exit to Celandia Seam-Bridge',   0, -102.0, -30.0,  2.40, 0.40);

-- Route all newly created characters directly to Porcelain Court — The Saucer Terrace (Map 0)
UPDATE `playercreateinfo`
SET `map` = 0,
    `zone` = 100,
    `position_x` = 18.0,
    `position_y` = -6.0,
    `position_z` = 27.95,
    `orientation` = 1.57;
