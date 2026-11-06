//! The run's pick screen, laid out like the 1.12 character create and select glue screens and built
//! from their own widgets and art ([`crate::glue`]): the race, gender and class tower on the left,
//! the zone list in the character-select frame on the right, Enter World at the bottom.
//!
//! The survivors HUD lays out on the 768-unit canvas through `UiScale`, so every glue builder here
//! takes a unit scale.

use bevy::prelude::*;
use bevy::ui_render::ui_material::MaterialNode;

use super::hud::{looks_for, rgb, start_run, HudFont, MenuRoot};
use super::{data, Phase, Rng, Run, Selection};
use crate::char_select::race_name;
use crate::glue::art::{class_tc, race_tc, tc_rect, GlueArt, GOLD, NAME_EDGE};
use crate::glue::backdrop::{backdrop_border, tiled_bg_node};
use crate::glue::widgets::{
    abs, glue_button, icon_button, outlined_text, GlueBtnKind, GlueDisabled, GlueText, Hilight,
    HoverLabel, LockHighlight,
};
use crate::glue::GlueClicks;

/// The create screen's two race columns.
const ALLIANCE: [u8; 4] = [1, 3, 4, 7];
const HORDE: [u8; 4] = [2, 5, 6, 8];

/// `CharacterSelectCharacterFrame`'s border and fill tints (Celandia Antique Brass & Porcelain Plum).
const FRAME_BORDER: Color = Color::srgb(0.843, 0.655, 0.282);
const FRAME_FILL: Color = Color::srgba(0.129, 0.082, 0.176, 0.92);
const CYAN_ACCENT: Color = Color::srgb(0.569, 0.933, 0.914);
const PAPER_TEXT: Color = Color::srgb(1.0, 0.953, 0.890);

/// The tower ends under the class grid and Randomize, where the create screen's appearance dials
/// would start: there is nothing to customise here.
const TOWER_H: f32 = 590.0;

/// The zone rows: the character-select row, compacted so every zone fits the 642-tall frame.
const ROW_TOP: f32 = 44.0;
const ROW_PITCH: f32 = 36.0;
const ROW_H: f32 = 34.0;
const ROW_W: f32 = 228.0;

#[derive(Component, Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum MenuAction {
    Race(u8),
    Sex(u8),
    Class(usize),
    Map(usize),
    Randomize,
    Enter,
    CoopMode(super::coop::CoopMode),
}

/// On [`MenuRoot`] once the glue art is in and the screen is built.
#[derive(Component)]
pub(super) struct MenuBuilt;

/// A race button's face, re-cropped to the picked gender.
#[derive(Component)]
pub(super) struct RaceFace(u8);

#[derive(Component)]
pub(super) struct PickName;

#[derive(Component)]
pub(super) struct CoopMenuStatus;

#[derive(Component)]
pub(super) struct ArenaCardImage;

#[derive(Component)]
pub(super) struct ChronicleZoneText;

#[derive(Component)]
pub(super) struct ChronicleHeroText;

#[derive(Resource, Default)]
pub(super) struct ArenaCards(pub(super) [Option<Handle<Image>>; 4]);

/// The saved pick, `benilla-config/survivors-pick.txt` (`localStorage` on the page):
/// `class race sex map`, restored at the menu so a reload keeps the last hero and zone.
fn pick_path() -> Option<std::path::PathBuf> {
    crate::local_state::home().map(|h| h.join("survivors-pick.txt"))
}

fn save_pick(sel: &Selection) {
    let (Some(class), Some(&(_, race, sex))) = (sel.class, sel.look.and_then(|i| sel.looks.get(i)))
    else {
        return;
    };
    if let Some(path) = pick_path() {
        let _ =
            crate::local_state::write_atomic(&path, &format!("{class} {race} {sex} {}", sel.map));
    }
}

/// Restore the saved pick once the creature data can resolve its looks; a stale or missing file
/// leaves the default.
pub(super) fn restore_pick(
    creatures: Option<Res<crate::entities::Creatures>>,
    mut selection: ResMut<Selection>,
    mut done: Local<bool>,
) {
    if *done {
        return;
    }
    let Some(creatures) = creatures.as_deref() else {
        return;
    };
    *done = true;
    let Some(text) = pick_path().and_then(|p| crate::local_state::read_to_string(&p).ok()) else {
        return;
    };
    let v: Vec<usize> = text
        .split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    let [class, race, sex, map] = v[..] else {
        return;
    };
    if map < data::MAPS.len() {
        selection.map = map;
        selection.stage = map;
        selection.version += 1;
    }
    if class < data::CLASSES.len() {
        let all = all_looks(creatures);
        if let Some(l) = find(&all[class], Some(race as u8), Some(sex as u8)) {
            set(&mut selection, &all, class, l);
        }
    }
}

/// Every class's looks, `(display, race, sex)`, indexed like [`data::CLASSES`].
fn all_looks(creatures: &crate::entities::Creatures) -> Vec<Vec<(u32, u8, u8)>> {
    data::CLASSES
        .iter()
        .map(|c| looks_for(c, creatures))
        .collect()
}

fn find(looks: &[(u32, u8, u8)], race: Option<u8>, sex: Option<u8>) -> Option<usize> {
    looks
        .iter()
        .position(|&(_, r, s)| race.is_none_or(|x| x == r) && sex.is_none_or(|x| x == s))
}

fn set(sel: &mut Selection, all: &[Vec<(u32, u8, u8)>], class: usize, look: usize) {
    sel.class = Some(class);
    sel.looks = all[class].clone();
    sel.look = Some(look);
    sel.version += 1;
}

/// Build the screen into [`MenuRoot`] once the archives are readable, so the glue art is there.
pub(super) fn build_menu(
    mut commands: Commands,
    roots: Query<Entity, (With<MenuRoot>, Without<MenuBuilt>)>,
    assets: Option<ResMut<benilla_assets::WorldAssets>>,
    mut art: ResMut<GlueArt>,
    mut images: ResMut<Assets<Image>>,
    mut add_mats: ResMut<Assets<crate::glue::add_material::AddUiMaterial>>,
    font: Res<HudFont>,
) {
    let Ok(root) = roots.single() else { return };
    let Some(mut assets) = assets else { return };
    art.ensure_loaded(&mut assets, &mut images, &mut add_mats);
    let arena_cards = [
        assets.sprite_texture("Interface\\Celandia\\Arena0", &mut images),
        assets.sprite_texture("Interface\\Celandia\\Arena1", &mut images),
        assets.sprite_texture("Interface\\Celandia\\Arena2", &mut images),
        assets.sprite_texture("Interface\\Celandia\\Arena3", &mut images),
    ];
    let first_arena = arena_cards[0].clone();
    commands.insert_resource(ArenaCards(arena_cards));

    let f = &font.0;
    commands.entity(root).insert(MenuBuilt).with_children(|ui| {
        tower(ui, &art, f);
        // `CharacterCreateWoWLogo`, 256×128 at TOPLEFT (3,-7), after the tower so it draws over
        // the border art, as the create screen orders it.
        if let Some(logo) = &art.logo {
            ui.spawn((
                ImageNode::new(logo.clone()),
                abs(1.0, 3.0, 7.0, 256.0, 128.0),
            ));
        }

        // Top-Center Celandia Expansion Cartouche Banner
        ui.spawn(Node {
            position_type: PositionType::Absolute,
            top: Val::Px(14.0),
            width: Val::Percent(100.0),
            justify_content: JustifyContent::Center,
            ..default()
        })
        .with_children(|top_wrap| {
            top_wrap
                .spawn((
                    Node {
                        flex_direction: FlexDirection::Column,
                        align_items: AlignItems::Center,
                        padding: UiRect::axes(Val::Px(22.0), Val::Px(7.0)),
                        border: UiRect::all(Val::Px(2.0)),
                        border_radius: BorderRadius::all(Val::Px(14.0)),
                        row_gap: Val::Px(2.0),
                        ..default()
                    },
                    BackgroundColor(Color::srgba(0.129, 0.082, 0.176, 0.90)),
                    BorderColor::all(FRAME_BORDER),
                ))
                .with_children(|banner| {
                    outlined_text(
                        banner,
                        Node::default(),
                        (),
                        (),
                        GlueText {
                            text: "CELANDIA: WOKECRAFT NoW",
                            size: 16.0,
                            color: PAPER_TEXT,
                            wrap: false,
                        },
                        f,
                        1.0,
                    );
                    outlined_text(
                        banner,
                        Node::default(),
                        (),
                        (),
                        GlueText {
                            text: "THE ELSEWHERE TIDE EXPANSION  •  XIRTUS FOSS GPLv3",
                            size: 11.0,
                            color: CYAN_ACCENT,
                            wrap: false,
                        },
                        f,
                        1.0,
                    );
                });
        });

        zone_frame(ui, &art, f, first_arena);

        // Co-Op mode toggle bar (`SOLO` / `HOST CO-OP :8091` / `JOIN CO-OP`) and `[Party: N/8]`
        // status line above the character name and Enter World button.
        ui.spawn(Node {
            position_type: PositionType::Absolute,
            bottom: Val::Px(134.0),
            width: Val::Percent(100.0),
            flex_direction: FlexDirection::Column,
            align_items: AlignItems::Center,
            row_gap: Val::Px(6.0),
            ..default()
        })
        .with_children(|coop_bar| {
            outlined_text(
                coop_bar,
                Node::default(),
                (),
                CoopMenuStatus,
                GlueText {
                    text: "MULTIPLAYER CO-OP: SOLO [Party: 1/8] (Press C to cycle)",
                    size: 14.0,
                    color: GOLD,
                    wrap: false,
                },
                f,
                1.0,
            );
            coop_bar
                .spawn(Node {
                    flex_direction: FlexDirection::Row,
                    column_gap: Val::Px(8.0),
                    justify_content: JustifyContent::Center,
                    ..default()
                })
                .with_children(|row| {
                    for (mode, label, w) in [
                        (super::coop::CoopMode::Solo, "SOLO", 96.0),
                        (super::coop::CoopMode::Host, "HOST CO-OP :8091", 156.0),
                        (super::coop::CoopMode::Join, "JOIN CO-OP", 126.0),
                    ] {
                        glue_button(
                            row,
                            &art,
                            f,
                            MenuAction::CoopMode(mode),
                            label,
                            w,
                            28.0,
                            GlueBtnKind::Small,
                            1.0,
                        );
                    }
                });
        });

        // `CharSelectCharacterName`, GlueFontNormalHuge at BOTTOM (0,100).
        ui.spawn(Node {
            position_type: PositionType::Absolute,
            bottom: Val::Px(100.0),
            width: Val::Percent(100.0),
            justify_content: JustifyContent::Center,
            ..default()
        })
        .with_children(|c| {
            outlined_text(
                c,
                Node::default(),
                (),
                PickName,
                GlueText {
                    text: "",
                    size: 22.0,
                    color: GOLD,
                    wrap: false,
                },
                f,
                1.0,
            );
        });
        // `CharSelectEnterWorldButton`, 200×60 at BOTTOM (0,30).
        ui.spawn(Node {
            position_type: PositionType::Absolute,
            bottom: Val::Px(30.0),
            width: Val::Percent(100.0),
            justify_content: JustifyContent::Center,
            ..default()
        })
        .with_children(|c| {
            glue_button(
                c,
                &art,
                f,
                MenuAction::Enter,
                "Enter Celandia",
                200.0,
                60.0,
                GlueBtnKind::Normal,
                1.0,
            );
        });
    });
}

/// `CharacterCreateConfigurationFrame`, 206×600 at TOPLEFT (28,-74): the race columns under the
/// faction banners, the gender pair, the class grid, the class text and Randomize.
fn tower(ui: &mut ChildSpawnerCommands, art: &GlueArt, f: &Handle<Font>) {
    let px = Val::Px;
    ui.spawn(Node {
        position_type: PositionType::Absolute,
        left: px(28.0),
        top: px(74.0),
        width: px(206.0),
        height: px(TOWER_H),
        ..default()
    })
    .with_children(|tower| {
        if let Some(bg) = &art.tower_bg {
            tower.spawn((
                ImageNode::new(bg.clone()),
                abs(1.0, -3.0, 0.0, 218.0, TOWER_H + 6.0),
            ));
        }
        // The create tower's top piece, then its foot piece cut to end where the class grid does.
        if let Some((border, size)) = &art.tower_border {
            for (top, height, tc) in [
                (0.0, 236.0, [0.0, 0.875, 0.0, 0.9375]),
                (
                    236.0,
                    TOWER_H - 236.0 + 6.0,
                    [
                        0.0,
                        0.875,
                        1.0 - (TOWER_H - 236.0 + 6.0) / 256.0 * 0.8203125 / (210.0 / 256.0),
                        1.0,
                    ],
                ),
            ] {
                tower.spawn((
                    ImageNode {
                        image: border.clone(),
                        rect: Some(tc_rect(*size, tc)),
                        ..default()
                    },
                    abs(1.0, -9.0, top, 224.0, height),
                ));
            }
        }
        if let Some(banners) = &art.banners {
            tower.spawn((
                ImageNode::new(banners.clone()),
                abs(1.0, -27.0, 60.0, 256.0, 259.0),
            ));
        }
        for (label, center) in [("Porcelain", 51.0), ("Nocturnum", 151.0)] {
            outlined_text(
                tower,
                Node {
                    justify_content: JustifyContent::Center,
                    ..abs(1.0, center - 60.0, 40.0, 120.0, 17.0)
                },
                (),
                (),
                GlueText {
                    text: label,
                    size: 15.0,
                    color: GOLD,
                    wrap: false,
                },
                f,
                1.0,
            );
        }

        for (faction, left) in [(ALLIANCE, 33.0), (HORDE, 127.0)] {
            tower
                .spawn(Node {
                    position_type: PositionType::Absolute,
                    left: px(left),
                    top: px(68.0),
                    flex_direction: FlexDirection::Column,
                    row_gap: px(5.0),
                    ..default()
                })
                .with_children(|col| {
                    for race in faction {
                        let face = art.races.as_ref().and_then(|(sheet, size)| {
                            race_tc(race, 0).map(|tc| (sheet.clone(), tc_rect(*size, tc)))
                        });
                        icon_button(
                            col,
                            f,
                            MenuAction::Race(race),
                            Some(RaceFace(race)),
                            face,
                            None::<()>,
                            race_name(race),
                            art,
                            1.0,
                        );
                    }
                });
        }

        tower
            .spawn(Node {
                position_type: PositionType::Absolute,
                left: px(53.0),
                top: px(303.0),
                flex_direction: FlexDirection::Row,
                column_gap: px(5.0),
                ..default()
            })
            .with_children(|g| {
                for (sex, label) in [(0u8, "Male"), (1u8, "Female")] {
                    let face = art.gender.as_ref().map(|(sheet, size)| {
                        let half = if sex == 0 {
                            [0.0, 0.5, 0.0, 1.0]
                        } else {
                            [0.5, 1.0, 0.0, 1.0]
                        };
                        (sheet.clone(), tc_rect(*size, half))
                    });
                    icon_button(
                        g,
                        f,
                        MenuAction::Sex(sex),
                        None::<()>,
                        face,
                        None::<()>,
                        label,
                        art,
                        1.0,
                    );
                }
            });

        tower
            .spawn(Node {
                position_type: PositionType::Absolute,
                // The gender pair's centre line: 53 + (2·48 + 5)/2 ≈ 103.
                left: px(103.0 - (3.0 * 48.0 + 2.0 * 4.0) / 2.0),
                width: px(3.0 * 48.0 + 2.0 * 4.0),
                top: px(368.0),
                flex_direction: FlexDirection::Row,
                flex_wrap: FlexWrap::Wrap,
                justify_content: JustifyContent::Center,
                column_gap: px(4.0),
                row_gap: px(4.0),
                ..default()
            })
            .with_children(|grid| {
                for (i, class) in data::CLASSES.iter().enumerate() {
                    let face = art.classes.as_ref().and_then(|(sheet, size)| {
                        class_tc(class.id).map(|tc| (sheet.clone(), tc_rect(*size, tc)))
                    });
                    icon_button(
                        grid,
                        f,
                        MenuAction::Class(i),
                        None::<()>,
                        face,
                        None::<()>,
                        class.name,
                        art,
                        1.0,
                    );
                }
            });

        tower
            .spawn(Node {
                position_type: PositionType::Absolute,
                left: px(30.0),
                top: px(TOWER_H - 46.0),
                ..default()
            })
            .with_children(|r| {
                glue_button(
                    r,
                    art,
                    f,
                    MenuAction::Randomize,
                    "Randomize",
                    146.0,
                    30.0,
                    GlueBtnKind::Small,
                    1.0,
                );
            });
    });
}

/// The zone list in `CharacterSelectCharacterFrame` (260×642 at TOPRIGHT (-5,-15)), one
/// character-row per zone, lowest level first, followed by the Kingdom Archipelago painting
/// card and the Champion Chronicle panel.
fn zone_frame(
    ui: &mut ChildSpawnerCommands,
    art: &GlueArt,
    f: &Handle<Font>,
    first_arena: Option<Handle<Image>>,
) {
    let px = Val::Px;
    let mut order: Vec<(usize, u32, u32)> = (0..data::MAPS.len())
        .map(|i| {
            let levels = data::roster(i).enemies.iter().map(|e| e.level);
            let lo = levels.clone().min().unwrap_or(1);
            let hi = levels.max().unwrap_or(lo);
            (i, lo, hi)
        })
        .collect();
    order.sort_by_key(|&(i, lo, _)| (lo, data::MAPS[i].name));

    ui.spawn(Node {
        position_type: PositionType::Absolute,
        right: px(5.0),
        top: px(15.0),
        width: px(260.0),
        height: px(642.0),
        ..default()
    })
    .with_children(|frame| {
        if let (Some(bg), Some(border)) = (&art.tooltip_bg, &art.name_border) {
            frame.spawn((
                tiled_bg_node(bg.clone(), NAME_EDGE, 1.0, FRAME_FILL),
                Node {
                    position_type: PositionType::Absolute,
                    left: px(10.0),
                    right: px(5.0),
                    top: px(4.0),
                    bottom: px(9.0),
                    ..default()
                },
            ));
            backdrop_border(frame, border, NAME_EDGE, FRAME_BORDER);
        } else {
            frame.spawn((BackgroundColor(FRAME_FILL), crate::glue::widgets::overlay()));
        }
        outlined_text(
            frame,
            Node {
                position_type: PositionType::Absolute,
                top: px(12.0),
                width: Val::Percent(100.0),
                justify_content: JustifyContent::Center,
                ..default()
            },
            (),
            (),
            GlueText {
                text: "Celandia Kingdoms",
                size: 17.0,
                color: GOLD,
                wrap: false,
            },
            f,
            1.0,
        );
        for (row, &(i, lo, hi)) in order.iter().enumerate() {
            let map = &data::MAPS[i];
            frame
                .spawn((
                    MenuAction::Map(i),
                    Button,
                    LockHighlight::default(),
                    Node {
                        position_type: PositionType::Absolute,
                        left: px(24.0),
                        top: px(ROW_TOP + row as f32 * ROW_PITCH),
                        width: px(ROW_W),
                        height: px(ROW_H),
                        ..default()
                    },
                ))
                .with_children(|b| {
                    if let Some(hi) = &art.select_highlight {
                        b.spawn((
                            Hilight,
                            Visibility::Hidden,
                            MaterialNode(hi.clone()),
                            abs(1.0, -20.0, -6.0, ROW_W + 20.0, ROW_H + 12.0),
                        ));
                    }
                    outlined_text(
                        b,
                        abs(1.0, 0.0, 2.0, ROW_W, 16.0),
                        (),
                        (),
                        GlueText {
                            text: map.name,
                            size: 15.0,
                            color: GOLD,
                            wrap: false,
                        },
                        f,
                        1.0,
                    );
                    let levels = if lo == hi {
                        format!("Level {lo}")
                    } else {
                        format!("Level {lo}-{hi}")
                    };
                    outlined_text(
                        b,
                        abs(1.0, 0.0, 19.0, ROW_W, 14.0),
                        (),
                        (),
                        GlueText {
                            text: &format!("{levels}  {}", map.zone),
                            size: 12.0,
                            color: PAPER_TEXT,
                            wrap: false,
                        },
                        f,
                        1.0,
                    );
                });
        }

        // Kingdom Archipelago Generative Art Preview Card (224x112)
        if let Some(arena_tex) = first_arena {
            frame.spawn((
                ArenaCardImage,
                ImageNode::new(arena_tex),
                Node {
                    position_type: PositionType::Absolute,
                    left: px(20.0),
                    top: px(198.0),
                    width: px(224.0),
                    height: px(112.0),
                    border: UiRect::all(px(2.0)),
                    border_radius: BorderRadius::all(px(6.0)),
                    ..default()
                },
                BorderColor::all(FRAME_BORDER),
            ));
        }

        // Kingdom & Champion Chronicle Panel (below the painting card)
        frame
            .spawn((
                Node {
                    position_type: PositionType::Absolute,
                    left: px(20.0),
                    top: px(320.0),
                    width: px(224.0),
                    height: px(304.0),
                    flex_direction: FlexDirection::Column,
                    padding: UiRect::all(px(10.0)),
                    row_gap: px(8.0),
                    border: UiRect::all(px(1.0)),
                    border_radius: BorderRadius::all(px(6.0)),
                    ..default()
                },
                BackgroundColor(Color::srgba(0.08, 0.05, 0.12, 0.86)),
                BorderColor::all(Color::srgba(0.843, 0.655, 0.282, 0.65)),
            ))
            .with_children(|chron| {
                outlined_text(
                    chron,
                    Node::default(),
                    (),
                    (),
                    GlueText {
                        text: "REALM CHRONICLE",
                        size: 13.0,
                        color: CYAN_ACCENT,
                        wrap: false,
                    },
                    f,
                    1.0,
                );
                outlined_text(
                    chron,
                    Node {
                        width: Val::Percent(100.0),
                        ..default()
                    },
                    (),
                    ChronicleZoneText,
                    GlueText {
                        text: "",
                        size: 11.5,
                        color: PAPER_TEXT,
                        wrap: true,
                    },
                    f,
                    1.0,
                );
                chron.spawn((
                    Node {
                        width: Val::Percent(100.0),
                        height: px(1.0),
                        margin: UiRect::vertical(px(2.0)),
                        ..default()
                    },
                    BackgroundColor(Color::srgba(0.843, 0.655, 0.282, 0.45)),
                ));
                outlined_text(
                    chron,
                    Node::default(),
                    (),
                    (),
                    GlueText {
                        text: "CHAMPION KIT",
                        size: 13.0,
                        color: GOLD,
                        wrap: false,
                    },
                    f,
                    1.0,
                );
                outlined_text(
                    chron,
                    Node {
                        width: Val::Percent(100.0),
                        ..default()
                    },
                    (),
                    ChronicleHeroText,
                    GlueText {
                        text: "",
                        size: 11.5,
                        color: PAPER_TEXT,
                        wrap: true,
                    },
                    f,
                    1.0,
                );
            });
    });
}

#[allow(clippy::too_many_arguments)]
pub(super) fn menu_clicks(
    clicks: Res<GlueClicks>,
    actions: Query<(Entity, &MenuAction)>,
    phase: Res<State<Phase>>,
    creatures: Option<Res<crate::entities::Creatures>>,
    mut selection: ResMut<Selection>,
    mut coop: ResMut<super::coop::CoopSession>,
    mut run: ResMut<Run>,
    mut rng: ResMut<Rng>,
    mut next: ResMut<NextState<Phase>>,
) {
    if *phase.get() != Phase::Menu {
        return;
    }
    let Some(action) = actions
        .iter()
        .find(|(e, _)| clicks.hit(*e))
        .map(|(_, a)| *a)
    else {
        return;
    };
    if let MenuAction::CoopMode(mode) = action {
        if coop.mode != mode {
            coop.set_mode(mode);
            selection.version += 1;
        }
        return;
    }
    let Some(creatures) = creatures.as_deref() else {
        return;
    };
    let all = all_looks(creatures);
    let cur = selection
        .look
        .and_then(|i| selection.looks.get(i))
        .map(|&(_, r, s)| (r, s));
    let (race, sex) = (cur.map(|c| c.0), cur.map_or(0, |c| c.1));
    match action {
        MenuAction::Map(i) => {
            if selection.map != i {
                selection.map = i;
                selection.version += 1;
            }
        }
        MenuAction::Enter => {
            if start_run(&mut run, &mut selection) {
                if coop.is_active() {
                    coop.send_start_run(selection.map, rng.0, 0.0);
                }
                next.set(Phase::Playing);
            }
        }
        MenuAction::Randomize => {
            let picks: Vec<(usize, usize)> = all
                .iter()
                .enumerate()
                .flat_map(|(c, looks)| (0..looks.len()).map(move |l| (c, l)))
                .collect();
            if !picks.is_empty() {
                let (c, l) = picks[rng.index(picks.len())];
                set(&mut selection, &all, c, l);
            }
        }
        // The class keeps the race and gender where it can.
        MenuAction::Class(c) => {
            let looks = &all[c];
            let l = find(looks, race, Some(sex))
                .or_else(|| find(looks, race, None))
                .or_else(|| find(looks, None, Some(sex)))
                .or_else(|| find(looks, None, None));
            if let Some(l) = l {
                set(&mut selection, &all, c, l);
            }
        }
        // The race keeps the class where it can, else takes the first class it has.
        MenuAction::Race(r) => {
            let classes = selection.class.into_iter().chain(0..all.len());
            for c in classes {
                let l = find(&all[c], Some(r), Some(sex)).or_else(|| find(&all[c], Some(r), None));
                if let Some(l) = l {
                    set(&mut selection, &all, c, l);
                    break;
                }
            }
        }
        MenuAction::Sex(s) => {
            if let Some(c) = selection.class {
                if let Some(l) = find(&all[c], race, Some(s)) {
                    set(&mut selection, &all, c, l);
                }
            }
        }
        MenuAction::CoopMode(_) => {}
    }
    save_pick(&selection);
}

/// The screen's per-frame state: the locked highlights, hover labels, which races and classes
/// the pick allows, the gender on the race faces, the name line and Enter World.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn refresh_menu_ui(
    selection: Res<Selection>,
    coop: Res<super::coop::CoopSession>,
    creatures: Option<Res<crate::entities::Creatures>>,
    art: Res<GlueArt>,
    arena_cards: Option<Res<ArenaCards>>,
    mut buttons: Query<(
        &MenuAction,
        &Interaction,
        &Children,
        Option<&mut LockHighlight>,
        Option<&mut GlueDisabled>,
        &mut Node,
        &mut Visibility,
    )>,
    mut labels: Query<&mut Visibility, (With<HoverLabel>, Without<MenuAction>)>,
    mut faces: Query<(&RaceFace, &mut ImageNode), Without<ArenaCardImage>>,
    mut arena_img: Query<&mut ImageNode, (With<ArenaCardImage>, Without<RaceFace>)>,
    mut text_queries: ParamSet<(
        Query<(&mut Text, &mut TextColor), With<PickName>>,
        Query<(&mut Text, &mut TextColor), With<CoopMenuStatus>>,
        Query<&mut Text, With<ChronicleZoneText>>,
        Query<(&mut Text, &mut TextColor), With<ChronicleHeroText>>,
    )>,
    mut cache: Local<(Option<u32>, bool, Vec<Vec<(u32, u8, u8)>>)>,
) {
    let have = creatures.is_some();
    if cache.0 != Some(selection.version) || cache.1 != have {
        *cache = (
            Some(selection.version),
            have,
            creatures.as_deref().map(all_looks).unwrap_or_default(),
        );
    }
    let all = &cache.2;
    let cur = selection
        .look
        .and_then(|i| selection.looks.get(i))
        .map(|&(_, r, s)| (r, s));

    for (action, interaction, children, lock, disabled, mut node, mut vis) in &mut buttons {
        let selected = match *action {
            MenuAction::Race(r) => cur.is_some_and(|c| c.0 == r),
            MenuAction::Sex(s) => cur.is_some_and(|c| c.1 == s),
            MenuAction::Class(i) => selection.class == Some(i),
            MenuAction::Map(i) => selection.map == i,
            MenuAction::CoopMode(m) => coop.mode == m,
            MenuAction::Randomize | MenuAction::Enter => false,
        };
        if let Some(mut lock) = lock {
            if lock.0 != selected {
                lock.0 = selected;
            }
        }
        if let Some(mut disabled) = disabled {
            let off = *action == MenuAction::Enter && cur.is_none();
            if disabled.0 != off {
                disabled.0 = off;
            }
        }
        match *action {
            // As on the create screen, a class the race cannot be leaves the grid.
            MenuAction::Class(i) => {
                let ok = cur.is_none_or(|(r, _)| {
                    all.get(i).is_some_and(|l| find(l, Some(r), None).is_some())
                });
                let display = if ok { Display::Flex } else { Display::None };
                if node.display != display {
                    node.display = display;
                }
            }
            MenuAction::Race(r) => {
                let ok = all.is_empty() || all.iter().any(|l| find(l, Some(r), None).is_some());
                let want = if ok {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                };
                if *vis != want {
                    *vis = want;
                }
            }
            _ => {}
        }
        let show = selected || *interaction != Interaction::None || art.races.is_none();
        for child in children {
            if let Ok(mut label) = labels.get_mut(*child) {
                let want = if show {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                };
                if *label != want {
                    *label = want;
                }
            }
        }
    }

    if let (Some((_, size)), Some((_, sex))) = (&art.races, cur) {
        for (face, mut img) in &mut faces {
            if let Some(tc) = race_tc(face.0, sex) {
                let rect = Some(tc_rect(*size, tc));
                if img.rect != rect {
                    img.rect = rect;
                }
            }
        }
    }

    if let Some(cards) = arena_cards.as_deref() {
        let map_idx = selection.map.min(cards.0.len() - 1);
        if let Some(handle) = &cards.0[map_idx] {
            for mut img in &mut arena_img {
                if img.image != *handle {
                    img.image = handle.clone();
                }
            }
        }
    }

    let class = selection.class_def();
    if let Ok((mut t, mut color)) = text_queries.p0().single_mut() {
        let want = match (class, cur) {
            (Some(c), Some((r, _))) => format!("{} {}", race_name(r), c.name),
            _ => String::new(),
        };
        if t.0 != want {
            t.0 = want;
        }
        let want = class.map_or(GOLD, |c| rgb(c.color));
        if color.0 != want {
            color.0 = want;
        }
    }

    if let Ok((mut t, mut color)) = text_queries.p1().single_mut() {
        let party = coop.party_count();
        let max_p = super::coop::MAX_PARTY_SIZE;
        let want = match coop.mode {
            super::coop::CoopMode::Solo => {
                format!("MODE: SOLO  [Party: {party}/{max_p}]  (Press C for Co-Op)")
            }
            super::coop::CoopMode::Host | super::coop::CoopMode::Join => {
                format!("{}  [Party: {party}/{max_p}]  (Press C to cycle)", coop.status_label)
            }
        };
        if t.0 != want {
            t.0 = want;
        }
        let want_col = if coop.is_active() {
            CYAN_ACCENT
        } else {
            GOLD
        };
        if color.0 != want_col {
            color.0 = want_col;
        }
    }

    let map_def = selection.map_def();
    let roster = data::roster(selection.map);
    let boss_name = roster
        .bosses
        .last()
        .map(|b| b.name)
        .unwrap_or("Obsidian Colossus");
    let zone_lore = match selection.map {
        0 => "Pastel wildwoods, porcelain terraces & glass bridges along the Wake.",
        1 => "Resonant ice-bell coves & shimmering aurora waters of the Lagoon.",
        2 => "Turquoise prism canyons, bamboo reeds & mirage plateaus.",
        _ => "Gilded solar basilicas & obsidian rifts at the edge of the Elsewhere.",
    };
    let want_zone = format!(
        "{} ({})\n{}\nBoss: {}",
        map_def.name, map_def.zone, zone_lore, boss_name
    );
    if let Ok(mut zt) = text_queries.p2().single_mut() {
        if zt.0 != want_zone {
            zt.0 = want_zone;
        }
    }

    if let Ok((mut ht, mut hcol)) = text_queries.p3().single_mut() {
        if let Some(c) = class {
            let (mob_name, mob_desc) = super::mobility::for_class(c.id)
                .map(|m| (m.name, m.desc))
                .unwrap_or(("Phase Step", "Burst forward through the Elsewhere."));
            let want_hero = format!(
                "{}\nStarting Spell: {}\nMobility [F]: {} — {}",
                c.name, c.start, mob_name, mob_desc
            );
            if ht.0 != want_hero {
                ht.0 = want_hero;
            }
            hcol.0 = PAPER_TEXT;
        }
    }
}
