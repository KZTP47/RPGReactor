# RPG Reactor 0.98.5: Build the Battle, Bring the World to Life

RPG Reactor 0.98.5 brings a big piece of RPG creation into the editor: visual battle choreography. You can now build a battle arena from a map, position your party and enemies, and assemble an attack from steps you can see, rearrange and preview.

There is also a lot around that centerpiece: native lighting, posters and video screens placed directly in your maps, a quest system, more custom-interface tools, and a substantial pass over older 2D projects and everyday editor workflows.

RPG Reactor is a free, open-source RPG editor and runtime built around RPG Maker MV/MZ-compatible projects. Familiar maps, events, database records and plugin workflows remain central. The new battle presentation is optional: existing battles keep their current behavior until you choose to use it.

## Battles can happen inside your maps

The Troops database now lets you choose a **Battle Room** alongside the familiar battleback option. Pick a map, open Room Setup, and move your actors and enemies into place.

The battle can inherit that map's camera or use a camera override for the troop. That means isometric staging, third-person views and custom angles. You can navigate the setup preview directly, and the Troops preview shows the room and formation you have chosen.

There is also a proper **Max Battle Members** setting under System 1. Room Setup creates the corresponding number of party slots. Existing party-size plugins keep control until you choose an explicit database override.

## Build attacks with visual Action Sequences

Action Sequences has its own database section. It combines a step list, timeline and live preview with movement, battler motions, sounds, animations, camera cues and an impact step.

Start with **Unarmed Punch**: run toward the target, punch, then turn and return home. The same Run to Target, Punch and Return Home building blocks are available for your own sequences.

From there you can:

- Drag steps into order, copy/cut/paste them, and insert new steps beneath the current selection.
- Scrub the timeline, play the full sequence, or use **Play Step** to audition one part.
- Preview with 2D sprites or 3D models and move test targets independently.
- Adjust motion offsets, rotation and proportions with sliders, numeric controls, arrows and rotation rings.
- Position and scale animations on their targets, and choose whether sounds/effects should hold up the next step.
- Assign different sequences to skills, items, weapons, unarmed attacks, actors and enemies.

Cinematic camera framing eases toward the acting battler, follows the impact and returns to your overview. You can also place explicit camera cues where you need them.

This is the first version of the system. The PSYCHRONIC Battle Engine adapter keeps the battle engine responsible for damage and other combat rules. Other battle engines retain their existing choreography until dedicated adapters are available; Reactor does not automatically convert their note-tag sequences. Keeping Scene_Battle helps existing battle UI work with the new presentation, but individual plugin combinations still need testing.

## Light the world and put media on its surfaces

The native **Lighting** tool lets you place fixtures, adjust ambient light, choose from twelve presets, and work with flicker, pulse and compound lights. Lights can attach to models and respond to event commands. In 3D they illuminate the room and model surfaces, with shadow budgets for static geometry and moving characters.

The 2D editor also gained better previews of animated props, attached media, lighting and effects. The reactor housing now hides effects that belong behind it, and nearby lights illuminate the model instead of leaving it unexpectedly dim.

**Media Surfaces** now has its own toolbar button. Place a poster, a monitor image, an animated screen or a video on the map without needing an event just to keep it there. Move it with arrows, rotate it with rings, edit individual corners, duplicate it, and use Undo. The camera can look up far enough to author ceiling surfaces too.

Tall posters stay tall: choosing media reads its original dimensions instead of forcing it into the old widescreen default. Keep Proportions links resizing controls; hold Shift during corner dragging to preserve the current shape.

## More expressive models

Model face controls now include precise eye, mouth and lip placement. **Speak 3D Dialogue** plays a voice clip with audio-driven mouth movement and an adjustable mouth interior. Use the normal message system for the accompanying text. Detailed teeth and tongues still belong in the model itself.

Model previews and thumbnails are sharper, animation/effect editing supports more copy-and-paste workflows, and the database shows useful rendering-cost information. You can optimize a model already in the project while retaining skinned animation and authored parts, with the original retained by the optimizer.

Performance work reduces repeated lighting calculations, GPU copies and unnecessary redraws. The improvements are measured against specific scenes and hardware; this is not a promise that every dense 3D map will run at 60 FPS.

## Quests, menus, music and everyday authoring

There is a new **Quests** database and runtime quest log, with objectives, progress, visibility/completion rules and event commands. Definitions can be imported from VisuStella, Yanfly and GS. Reactor keeps its quest file separate from those plugins' files. An on-map tracker and automatic reward grants are still future work.

Custom interface authoring expands Actor Panels, state/buff icons, variable-driven gauges, circular gauges, Main Menu formation/custom-scene support, multi-selection and script editing.

Map music can be a sequence of tracks, silence and layered randomized palettes. Sound effects gain variants and pitch variation. Skills and items can use multiple elements, states have descriptions, and trait help explains more of what a setting does.

Playtest checkpoints make it easier to return to a recent battle or map transfer. Forge Project Tools can host project-supplied HTML tools with constrained save operations, and plugin authors have a read-only battle event feed.

## Keeping older projects working

We spent time back in the existing 2D project collection as well. Fixes cover fog and dust movement/opacity, missing ships, picture-choice icons, older MV plugin APIs, game-over/autosave fades, animations and plugin-defined resolutions.

The editor also received a broad reliability and presentation pass:

- Saving an event's new 3D height no longer restores the old value from a closed inspector.
- OK commits new events correctly, and model choices stay in the draft until Apply/OK.
- Switching among Media Surfaces, Events, Lighting, tiles and 3D-M releases the old tool properly.
- Map copies and undo preserve sidecar data; unknown map fields survive editing; BOM-encoded JSON loads correctly.
- Database cards, tables, price fields, pickers and buttons fit and follow the selected theme more consistently.
- Missing labels in the new systems have been translated across all 17 non-English languages, with live-language and Arabic layout checks.

The current source passes **2,932 automated tests**, with additional native editor/game checks, an audit across 11 existing 2D projects, 18-language coverage and 14-theme checks. Those are useful regression checks, while full-game and plugin-combination testing remains ongoing.

Thank you to everyone contributing code and reporting issues with examples, screenshots and console logs. That feedback is shaping both the new systems and the fixes to familiar workflows.

[Download RPG Reactor](https://psychronic.itch.io/rpg-reactor) · [0.98.5 release notes](https://github.com/Psychronic-Games/RPGReactor/releases/tag/v0.98.5) · [Battle Rooms and Action Sequences guide](https://github.com/Psychronic-Games/RPGReactor/blob/v0.98.5/docs/BATTLE-PRESENTATION.md)
