# Model face points, speech and prop playback

Updated in development runtime **20260906.3**. Restart the editor/playtest to
load updated scripts; existing projects receive runtime updates through the
normal project runtime sync.

## First-person characters

First-person cameras use the player's model eye point, including its height,
scale, facing and animated bone position. Without an eye point, the camera uses
an estimate near the top/front of the fitted model. Without a model, it retains
the standard character eye-height fallback. The player's 3D body and followers
remain visible; looking down reveals the body.

In **Database → 3D Models**, select a model and click the **eye icon** for
**Face points**. The compact right-hand card uses the same placement conventions
as model transforms and effects. Choose Eyes / camera, Mouth, Upper lip or
Lower lip. Drag the selected marker freely, drag its colored axis arrows to
move along one viewport axis, or use the X/Y/Z sliders and numeric steppers
(0.001 increments). Numeric positions use model coordinates; controls and markers
update together. Double-click a slider to restore that coordinate to its value
when face editing began. **Follow** chooses the bone or part it follows.
Click **Save face points** to save all four markers. Editing uses the rest pose and
preserves existing skeleton, weights, carved parts and other sidecar fields.
Imported rigs and carved models both support these markers.

Mouth and lip targets also show **Mouth interior**, its color, and a **Preview
mouth** slider. Scrub the preview to check closed/open positions before saving.
Moving a marker or changing its interior resets the preview to the rest pose.
The lip dots are smaller than the mouth/eye dots, with a larger invisible hit
area retained for dragging. The preview uses the same speech geometry as the
game and never writes generated meshes into the source GLB.

The optional top-level `model.json` field uses bone/part-local coordinates:

```json
"landmarks": {
  "eyes": { "part": "Head", "offset": [0, 0.1, 0.08] },
  "mouth": { "part": "Head", "offset": [0, 0, 0.1], "interior": "dark", "interiorColor": "#080808" },
  "upperLip": { "part": "Head", "offset": [0, 0.01, 0.1] },
  "lowerLip": { "part": "Head", "offset": [0, -0.01, 0.1] }
}
```

Those numbers are examples, not defaults for every model. Bone coordinate
units differ between imported assets. Missing named bones are ignored rather
than reinterpreting their offsets at the model's feet.

## Spoken dialogue

Use **Events → Reactor 3D → Speak 3D Dialogue**. Select the speaking event,
player or follower and choose a voice clip under `audio/se`. Volume, pitch and
pan are edited in the voice picker; reopening it preserves all three values.
The command controls voice playback and mouth animation only. For dialogue,
uncheck **Wait for voice to finish**, then add a normal **Show Text** command
with the speaker and message. The voice can play alongside that message;
closing the message does not stop the voice. With waiting enabled, the next
event command runs after audio ends. **Stop** ends the target's voice and
resets its mouth. Scene exit also cleans up speech.

Legacy `speaker`/`text` arguments are ignored at runtime and removed when the
command is edited and accepted. Move any previously embedded dialogue into
Show Text. Existing project event data is not rewritten automatically.

Speech prefers an existing `mouthOpen`, `jawOpen` or `viseme_a`/`viseme_aa` morph,
then a Jaw/LowerJaw bone. Otherwise, designated mouth/lip points generate a
local lip morph on that model instance. All three mouth/lip points allow the
fallback to split triangles along the lip line and open a real seam. A dark,
inset lining fills that opening; **None** leaves it unfilled. The geometry,
interpolated skin weights and morph are generated once per instance. Shared
geometry and the source model stay unchanged. A mouth point alone retains the
older deformation-only fallback.

Put **Mouth** on the closed lip seam, **Upper lip** just above it and **Lower
lip** just below it. Their separation sizes the local deformation. Preview the
result: a point on the chin opens the chin, and a point in empty space cannot
find a mouth surface. The generated opening is a stylized fallback for ordinary
front-facing character meshes, not an anatomical reconstruction. It does not
generate teeth or a tongue, infer the intended gum line from a texture, or
replace a properly authored human mouth. For close-up human characters, supply
an open-mouth morph or jaw rig with teeth, tongue and inner-mouth geometry in
the asset. Existing mouth morphs and jaw rigs retain their own interiors.

The September 6 fix refreshes skinned bind transforms before capturing the
speech rest pose. Previously the mascot's fresh imported mesh was sampled at
the wrong scale, selecting no mouth vertices even with saved face points.

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
