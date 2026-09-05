# Model face points, speech and prop playback

Available in development runtime **20260904.17**. Restart the editor/playtest to
load updated scripts; existing projects receive runtime updates through the
normal project runtime sync.

## First-person characters

First-person cameras use the player's model eye point, including its height,
scale, facing and animated bone position. Without an eye point, the camera uses
an estimate near the top/front of the fitted model. Without a model, it retains
the standard character eye-height fallback. The player's 3D body and followers
remain visible; looking down reveals the body.

In **Database → 3D Models**, select a model and click the **eye icon** for
**Face points**. Choose Eyes / camera, Mouth, Upper lip or Lower lip. Drag the
selected marker, or enter its X/Y/Z coordinates. **Follow** chooses the bone or
part it follows. Click **Save face points**. Editing uses the rest pose and
preserves existing skeleton, weights, carved parts and other sidecar fields.
Imported rigs and carved models both support these markers.

The optional top-level `model.json` field uses bone/part-local coordinates:

```json
"landmarks": {
  "eyes": { "part": "Head", "offset": [0, 0.1, 0.08] },
  "mouth": { "part": "Head", "offset": [0, 0, 0.1] },
  "upperLip": { "part": "Head", "offset": [0, 0.01, 0.1] },
  "lowerLip": { "part": "Head", "offset": [0, -0.01, 0.1] }
}
```

Those numbers are examples, not defaults for every model. Bone coordinate
units differ between imported assets. Missing named bones are ignored rather
than reinterpreting their offsets at the model's feet.

## Spoken dialogue

Use **Events → Reactor 3D → Speak 3D Dialogue**. Select the speaking event,
player or follower; choose a voice clip under `audio/se`, optionally enter a
speaker name and dialogue, and set volume/pitch/pan and whether to wait for the
voice. Dialogue uses the regular message window. **Stop** ends the target's
voice and resets its mouth. Scene exit also cleans up speech.

Speech prefers an existing `mouthOpen`, `jawOpen` or `viseme_a`/`viseme_aa` morph,
then a Jaw/LowerJaw bone. Otherwise, designated mouth/lip points generate a
small local lip morph on that model instance. Position the markers on the
actual mouth for useful results. This deforms existing geometry; it does not
create teeth or a mouth cavity.

Movement follows the audio's amplitude envelope, closing during silence and
following playback pitch and the audio clock. It is **not phoneme recognition**.
PCM analysis and fallback morph creation happen once; each frame samples the
cached envelope and changes the morph weight or jaw angle. Current speech
animation integration targets models rendered in the 3D map scene.

For a separate voiceover system, attach its actual WebAudio buffer:

```js
Reactor3D.Speech.attach(character, voiceBuffer);
Reactor3D.Speech.play(character, { name: "voices/hello", volume: 90, pitch: 100, pan: 0 });
Reactor3D.Speech.stop(character);
```

`attach` does not take ownership of external audio playback. Arbitrary sound
effects do not make every character talk.

## Prop playback in either map mode

Placed prop animation sequences and active light effects survive main-menu
return. Playback pauses across reconstruction; completed one-shot animations
and explicit stops stay stopped. The 2D model sprites use the same action,
repeat and timed-effect driver as the 3D scene.

The map's **Props** panel includes **Animation speed (%)**: 100 is normal,
50 is half speed, 200 is double. Values range from 1 to 1000. Speed belongs to
the placement, so it does not change the model's shared animation definition.
Use **Set Model Animation Speed** to select a map prop and change its speed
during play without restarting its current action. The override also applies
to subsequent animations on that instance and is stored on the character.
The scripting equivalent is `Reactor3D.setModelAnimationSpeed(character, 175)`.
Old placements without `animationSpeed` use 100%.

2D maps show orthographic model sprites, anchored effects and carried lights.
Ambient tint is converted into display brightness. Point/spot/beam overlays
use soft, translucent falloff; 2D cones include their own tapered silhouette.
This is a flat approximation, not the 3D renderer's surface lighting or shadow
atlases. Native and carried lights retain color, direction, flicker and pulse.

On supported shared WebGL contexts, 2D model sprites sample GPU render targets
directly. Canvas copying remains a compatibility fallback. Offscreen models
keep their playback/effect state but skip bitmap drawing, and catch-up game
ticks skip redundant draws. Model texture size and animation speed are retained.


Animated 2D models use cached part/bone bounds to grow their render area when
needed. Growth preserves the ground anchor and pixel density until the GPU's
texture-size limit (capped at 4096); exceptionally large extents fit within
that limit. Bounds do not shrink again during the instance's lifetime.
This avoids repeated allocation while limbs move. Offscreen culling includes
the sprite's centered frame and lift. Raised model sprites have a separate
height-aware drawing depth, including when a plugin replaces tile sorting.
Normal tile/event priority layers still take precedence.
