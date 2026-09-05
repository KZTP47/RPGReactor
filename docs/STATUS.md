# Current project status

Reviewed against the working tree on **2026-09-04**. This is the current
orientation and verification summary. [HANDOFF.md](HANDOFF.md) preserves dated
engineering history; its older measurements and proposed next steps describe
those sessions, not necessarily the present implementation.

The [September 4 closeout](SESSION-2026-09-04.md) brings together the day's changes,
authored Demo updates, and verification reports.

## Version and validation

- The [database sequence audit](DATABASE_STATE_AUDIT.md) passes 405 live checks
  across all 19 sections, with zero uncaught errors. It covers navigation,
  edit/switch/return, Apply/Cancel, stale callbacks, and project cache isolation.
- Development version: **0.98.5** (`editor/package.json`).
- Runtime revision: **20260904.17** (`runtime/reactor_main.js`); inspect
  `RPG_REACTOR_RUNTIME_REVISION` in a running game's console to identify its copy.
- Latest local release tag: **v0.98.4**, dated 2026-08-31 in the changelog.
- `cd editor && npm test`: latest full run **2,643 passed, 3 failed** on 2026-09-04,
  with no cancellations, skips or TODOs. The three `stock-interfaces.test.cjs`
  failures assume a 1280×720 Demo title layout; the working Demo's resolution
  changed to 1920×1080 during this session. Its authored settings were retained.
  Before that content change, all 2,562 tests passed with the database fixes;
  the subsequent map-light regression also passes in the focused suite. These
  are development checks with known failures, not a clean release run.
- The initial documentation-only review did not run GUI smokes. Subsequent
  feature/audit GUI results are listed below; native signing and a complete
  game playthrough remain open. Recorded passes cover their tested scope.
- The subsequent lighting optimization passed NW.js frozen-frame image
  comparisons on an actual AMD integrated GPU at both full and weak shadow
  quality. Full-quality GPU rendering cost fell roughly 19% in the recorded
  comparison. See [performance checks](PERFORMANCE.md) for methodology and limits.
- Revision .16 also passed 240-frame moving-scene shadow continuity probes at
  full quality on NVIDIA and weak quality on AMD integrated graphics: no
  mismatched static/dynamic pairs, WebGL errors or per-frame budget overruns.
- Database model switching was checked in the live NW.js editor on a disposable
  Demo copy: Monitor Arm → Computer-01, manual media → mascot, and rapid
  mascot → computer → arm selections retained only the selected model's preview.
- Clipboard shortcuts, context-menu duplication and cross-model paste/save were
  checked in NW.js on a disposable Demo copy. The right-hand animation/effect
  lists support Ctrl/Cmd+C/V and Edit, Copy, Paste, Duplicate and Delete menus.
- Follow-up NW.js checks passed real right-click/Paste in the blank effect
  footer, section-header menus and an empty effects list. Database spotlight
  flicker changed both body and surface-light values across 30 live samples;
  zero flicker stayed steady. Database and map previews now animate carried
  point/spot/beam lights through the game's shared flicker/pulse routine.

- The 2D map editor now previews placed prop motion and native/carried lights
  outside the props/lighting tools. NW.js checks passed selection retention,
  tool close, 2D/3D switching, and map-switch cleanup on a disposable Demo.
  Model textures stay on the GPU; static/offscreen poses avoid redraws.
  Carried glows sit behind their emitter; a GPU pixel check confirms the
  emitter covers the glow while floor illumination and ambient tint remain correct.

- The current 2D editor light field uses the 3D source height/aim and falloff,
  verified against 24 GPU-rendered 3D references within one 8-bit level. Model
  textures follow zoom, shadows crop/cull/skip empty pools, and flat model
  lighting is isolated from other previews. Animated NW.js checks passed on
  NVIDIA and AMD integrated graphics; see [PERFORMANCE.md](PERFORMANCE.md).
  Attached animation/video effects and mode/map/project cleanup remain covered.
  This is an editor ground-light approximation, retaining flat brightness and
  ambient model tint; walls, self-shadowing and event-model casters differ.
- Revision .17 adds authored eye/mouth/lip points, first-person bodies and
  followers, and waveform-driven Speak 3D Dialogue. NW.js checks verified
  face-point save/reopen without changing the rig, exact authored eye placement,
  visible bodies, synthetic voiced/silent audio segments, mouth reset and
  dialogue/voice waits. See [feature usage and limits](3D-FACE-AND-SPEECH.md).
- Menu-return checks passed repeated prop cycles and explicit stops in both
  3D and 2D. The flat path now includes prop sprites and carried effect lights,
  display-correct ambient tint, tapered translucent cones and direct GPU model
  textures. Prop animation speed can be set per placement and changed by event.
  Cached part/bone bounds prevent animated models clipping their sprite frames;
  drawing depth accounts for lift independently of screen position and supports
  the Demo fog plugin's sorting override.

CI runs syntax checks, the full Node suite, dependency audit, patch hygiene,
and a clean-tree check. Its separate GUI job runs Web persistence and NW.js
save smokes. The UI-layout smoke and native Windows/macOS release checks are
additional gates; see [the release checklist](RELEASE-CHECKLIST.md).

## Editor audit on 2026-09-04

The [editor audit](EDITOR_AUDIT.md) records 123 command items, 19 database
sections, 56 nested dialog cases, 14 themes, and 18 locale catalogs. It fixes
silent save paths, invalid model-settings handling, unavailable quest commands,
and editor contrast/fallback colors. The expanded source inventory has 3,989
routed phrases and no missing entries; 88 phrases were added in 17 locales.
The report distinguishes GUI roundtrips from runtime scenario and native-language
coverage. Runtime revision remains .17.

## Current behavior that supersedes older notes

- **3D rendering:** Three.js normally shares PIXI's WebGL context. A canvas-copy
  fallback remains. World passes are capped at game resolution
  (`maxPassPixelRatio = 1`), use nearest sampling, and default to no MSAA
  (`renderTargetSamples = 0`). Adaptive resolution is opt-in. UI scaling follows
  the main canvas, whose backing resolution also depends on GPU tier.
- **Lighting:** the default volume path lights surfaces from world position,
  distance, and point/spot/beam shape. It does not use surface normals or normal
  maps. The older flat-light path remains available. Map lights, compatible
  plugin lights, and model light effects feed the shared light field.
- **Shadows:** two depth atlases hold static and moving casters. Full quality
  has 8 light rows and 3 dynamic rows at 512 pixels per face; weak quality has
  4 and 2 at 256. Moving-caster triangle budgets are 600,000 and 200,000.
  Rows prioritize light incident on the player and refresh within frame budgets.
  A light marked to cast can still lack an atlas row; not every in-range light
  casts simultaneously. Model effect lights exclude their own carrier from
  their shadow passes.
  Slot selection has a 25% incumbent priority margin and excludes authored
  flicker from priority; cone-edge priority changes smoothly. When a cached
  light origin changes, its static and existing dynamic rows refresh together
  within the existing budgets, retaining the previous matching pair meanwhile.
- **Model optimization:** both import presets can reduce geometry; the
  aggressive preset targets a larger reduction. Optimize also handles existing
  GLBs. Both presets disable generation of separate distance-level files.
  Existing authored LOD files remain supported. In-memory generation/caching of
  distance levels is a proposal, not shipped behavior.
- **Model effects:** animation, video/image surface, and light effects can
  attach to model parts. Placed props can list effects and animation sequences.
  In-world effects use scene depth; they are not simply screen overlays.
  Database model changes stop the previous preview immediately; stale model
  and clip loads cannot overwrite a later selection or reopen a closed preview.
  Clipboard copies preserve working edits and create uniquely named entries;
  copied animation rules carry their referenced named effects. Part/bone and
  embedded-clip names are preserved and may need retargeting on another model.
- **Quests:** Reactor owns `data/ReactorQuests.json` and `$dataReactorQuests`.
  Imports support VisuStella, Yanfly, and GS. Progress saves with the game;
  rewards are descriptive text and an on-map objective tracker is not built.
- **Custom interfaces:** seven opt-in stock-scene replacements are implemented.
  Item, Skill, Equip, Shop, Formation, Name Input/message-input, and Battle
  replacements still need dedicated adapters. The standalone MZ plugin is
  deferred. See [the interface design](DESIGN-USER-INTERFACES.md).
- **Compatibility:** Braver's recovered corescript adaptations now live in the
  MV compatibility layer. The earlier requirement for a project-local
  `BraverCoreEdits.js` is superseded. A working scene or isolated battle does
  not establish compatibility for an entire game.

## Open work and verification

- Complete moving-scene shadow/caster-budget verification on integrated GPUs.
  Revisions .15/.16 have frozen-view comparisons and short moving-scene probes
  on AMD integrated graphics; those do not establish sustained playthrough performance.
- Reproduce the owner's reported fullscreen softness in the actual launch path;
  the harness and owner screenshots did not agree. The console scaling report
  remains available; the temporary on-screen diagnostic was removed.
- Complete Braver's real victory → transfer → autosave flow and save/load through
  the storage bridge. Forced scene transitions and isolated action probes cover
  only parts of that sequence.
- Performance candidates: per-object light lists, removal of anchored-effect
  cross-context copies, generated/cached distance levels, and settings informed
  by measured frame time. Base skinned-mesh reduction exists; automatic skinned
  distance levels do not.
- 3D authoring: Block primitives and reusable structure stamping remain planned.
  Model/event transform gizmos exist; they do not complete the proposed generic
  tileset-structure manipulation tool. Weapon/armor/item bindings store data but
  do not yet draw equipment; stock battler motions do not automatically map to
  model actions.
- Content: the Demo has missing stock character/battler references and **121**
  distinct missing animation SE names. See [the verified inventory](demo-missing-se.md).
  The [July authored-data backlog](AUDIT-BACKLOG-2026-07-25.md) is separate from
  engine defects and records the date of its last corpus verification.
- Remaining visual/native checks are listed in
  [the handoff's release gates](HANDOFF.md#manual-release-gates) and
  [the release checklist](RELEASE-CHECKLIST.md).

## Documentation verification — 2026-09-04

The review covered the 40 tracked/new Markdown documents, checking current
claims against source, test results, and the Demo/corpus data where available.
Local Markdown file and heading links resolve. The 23 distinct external
Markdown links responded successfully; RPG Catalyst requires a normal GET
request because its HEAD response is 404. This checks availability, not the
future availability or every assertion on third-party pages. The six NW.js
archive hashes in the release checklist match the upstream 0.107.0 manifest.

The documentation, runtime-event contract, and release-infrastructure checks
passed after editing (30 tests). No runtime/editor code was changed by this
review. Dated release notes and art-pattern analyses remain historical records;
the review does not claim a new visual acceptance pass for their screenshots or
art recommendations.

## Keeping this summary current

Update behavior and verification separately: a passing Node run does not clear
a GUI gate, and a recorded GUI pass does not cover later renderer changes.
Record the date, runtime revision, and tested tree when reporting measurements.
Keep release devlogs and dated engineering entries as history, with explicit
supersession notes where an old claim could guide current work incorrectly.
