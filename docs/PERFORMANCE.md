# Runtime performance checks

## 2D editor light field and prop previews (2026-09-04)

`LightingManager` r14 evaluates the runtime's point/spot/beam falloff on the
flat ground plane, using world anchors and height/pitch/yaw. Downward cones
intersect the floor as ellipses. Full fragment precision avoids edge errors
seen with default shader precision. All floor lights sit below the prop layer;
individual shadow masks only attenuate their own additive light. This retains
the flat renderer's brightness treatment: it is not a full 3D material/volume
compositor, and walls, self-shadowing and event-model casters remain outside
this editor ground-shadow approximation.

Placed props retain Three targets on PIXI's WebGL2 context, without per-frame
canvas copies. Target density follows zoom and device resolution with at least
25% sampling headroom (subject to the 4096/hardware limit), linear filtering and
four MSAA samples. Zoom-in restores detail; it does not change animation speed.
Pose/media/light-anchor updates run at the existing 60 Hz model presentation
rate. Static/hidden props reuse textures, and hidden media pauses. Flat model
materials own their ambient uniforms so another preview cannot recolor them.

Shadow masks cover each light's ground footprint, grow in retained 64-pixel
blocks to at most 512 per side, and refresh at most 30 Hz. Projected caster
bounds reject irrelevant geometry; empty pools skip rendering. Static masks
and flicker-only changes reuse their targets. A mask is unbound from consumers
before replacement/removal. Model/bone boxes are cached; production rendering
does not read pixels back to the CPU.

Run `node editor/tests/perf/nw-flat-preview.cjs` from the repository root.
It copies Demo, isolates the NW.js profile, compares 24 rendered light fields
against the runtime's actual GLSL, checks a caster outside the light footprint,
checks model-lighting isolation and zoom resolution, profiles 20 seconds of
animation, and saves 2D/3D screenshots. `RR_RENDER_NODE=/dev/dri/renderD129`
selected this machine's AMD integrated graphics. The script prints its temp
artifact directory; the author's Demo and lock are not modified.

Recorded NVIDIA comparison at map zoom 0.3: model texture area fell about 86%;
preview CPU time averaged 0.588 ms per display tick before and 0.271 ms after;
shadow submissions fell from 325 to 179 per second. Samples were 10 seconds
before and 20 seconds after, not frozen identical poses, so these describe
representative workload reduction rather than an exact GPU speedup. The final
NVIDIA sample's combined Three/PIXI GPU time averaged 0.443 ms (p95 1.649 ms).
The AMD integrated sample averaged 4.262 ms (p95 14.784 ms, max 20.526 ms).
Queries cover the editor canvas, excluding Effekseer's separate context and the
browser compositor. These devices do not establish performance on every old PC.

The 24 GPU field comparisons differed by at most one 8-bit level. The projected
shadow fixture produced 366 opaque pixels and restored caster state. Separate
NW.js lifecycle checks verify visible video/animation/shadow pixels, overlapping
colored lights preserving ambient, view/map switching and project-close cleanup.



Optimize repeated CPU work and GPU work separately. A cheap JavaScript update
can submit expensive drawing, and timing only the final PIXI composite misses
the Three.js passes submitted during the game update. Keep resolution, light
counts, shadow quality and scene state constant when comparing an optimization.

## Flat model sprites — 2026-09-04, revision .17

Animated models on 2D maps previously rendered into a private WebGL canvas,
then copied through a 2D canvas and uploaded to PIXI on each draw. The shared
path now renders directly into sprite textures, retaining the model sprite's
pixel dimensions and up to four antialiasing samples. Only the compatibility
fallback copies pixels. Culled models retain simulation but skip drawing;
catch-up ticks also skip redundant draws.

A local NW.js check on a disposable 1920×1080 Demo copy loaded 18 model
instances and 12 carried lights. A shared → canvas → shared comparison used
roughly 1.5-second samples. CPU time inside model painting averaged about
**0.11 ms per draw shared versus 0.98 ms copied** (about 89% less). Browser
presentation cadence measured about 29 FPS during the copied sample and
127 FPS in the warmed shared sample; game simulation remained near 60 ticks/s.
These are short local measurements, not an older-PC performance guarantee or
GPU timer-query results. The first shared sample included more warm-up work.

A frozen-view comparison retained resolution and showed a mean RGB difference
of 0.17/255 between shared and canvas paths; about 0.4% of pixels differed by
more than eight channel values. Thus this is not a pixel-identical claim.
Visual inspection confirmed intact model detail and soft translucent lighting.
The separate lighting correction replaces the rectangle-only cone falloff
with a tapered texture and uses reduced body opacity, avoiding white washes.

Local harness: `scratchpad/flat-model-profile.cjs` (ignored development aid).
Regression coverage lives in `editor/tests/model-playback-lifecycle.test.cjs`.

A follow-up with expanding animated bounds retained the shared-path benefit:
about 0.10 ms/draw shared versus 1.31 ms copied, and roughly 106 versus 24
presented frames/s in the warmed samples. Bone bounds are cached by geometry
and bind matrices; moving frames transform boxes instead of reading vertices.
These measurements retain the same short-run/local-machine limitations above.

## Spotlight and anchor optimization — 2026-09-04

Runtime revision **20260904.15** stops processing a spotlight once its cone
falloff reaches exactly zero, before sampling either shadow atlas. The soft
cone edge, lit pixels, shadow filtering and caster budgets retain their existing
calculations. Model effect anchors also stop explicitly updating world matrices
before `localToWorld`, because the bundled Three.js already updates the node and
its ancestors inside that method. A real-Three.js regression checks fresh parent
translation/rotation, model scale and part offsets, with one update per node.

Measured on the **integrated AMD GPU in a Ryzen 9 9950X3D**, using NW.js,
ANGLE/radeonsi, a 1280×720 Demo start-map view, 22 packed lights and 100 lit
materials. The CPU is a modern desktop CPU; this is evidence about integrated
GPU cost, not a complete old-PC benchmark.

| Shader settings | Baseline GPU median | Optimized GPU median | Pixel comparison |
| --- | ---: | ---: | --- |
| Full, 8 shadow rows, 5 taps | 27.53 ms | 22.36 ms | Identical |
| Full, repeated | 27.91 ms | 22.17 ms | Identical |
| Weak, 4 shadow rows, 1 tap | 16.01 ms | 16.43 ms | Identical |
| Weak, repeated | 15.77 ms | 15.09 ms | Identical |

Each median contains 40 GPU timer samples after shader warmup. Full quality
saved approximately 19–21% in these comparisons; weak quality showed no
consistent gain. Both tiers returned zero WebGL errors and zero failed shader
programs. An earlier full-quality experiment measured about 17.5% savings.
Normal GPU scheduling, clock changes and the animated scene's freeze point
affect timings between runs.

These are **frozen-scene rendering comparisons**, including Three.js world and
overlay passes plus the PIXI composite. They isolate the fragment-shader change;
they do not measure moving-caster atlas refreshes, simulation, media playback,
or the CPU anchor improvement. Exact pixels in these views are useful regression
evidence, not exhaustive visual coverage of every map, camera and GPU driver.
The new branch only skips mathematically zero contributions; it does not lower
any quality setting. The weak-tier run explicitly selected the existing weak
Reactor3D tier in a disposable runtime copy, since this GPU's renderer string
currently defaults to full quality.

## Reproduce

Use the matching NW.js SDK/chromedriver under `nwjs-linux` (or the platform's
equivalent directory), or pass `--nw-root`. From the repository root:

```bash
BENCH_DIR=$(mktemp -d)
cp -RL template/Demo "$BENCH_DIR/Demo"
cp runtime/reactor_3d.js runtime/reactor_main.js "$BENCH_DIR/Demo/js/"
node editor/tests/perf/nw-game-profile.cjs \
  --project="$BENCH_DIR/Demo" --seconds=6 --out="$BENCH_DIR" \
  --setup=editor/tests/perf/lighting-compare-setup.js \
  --shot="$BENCH_DIR/game.png" > "$BENCH_DIR/profile.log" 2>&1
```

Use a real copy with symlinks dereferenced: project plugins can autosave even
though the profiler itself never requests a save. On Linux with multiple GPUs,
optionally pass `--render-node=/dev/dri/renderD129`, substituting the actual
device. Check the report's renderer description rather than assuming an
environment variable selected the intended GPU.

The setup script freezes game updates, clocks and playing media, then alternates
baseline/optimized/baseline/optimized. Baseline removes only the spotlight exit
from the current shader. Materials are recompiled and warmed before sampling;
the report requires identical framebuffer pixels, a nonuniform image, 40 valid
GPU samples per batch, and no WebGL or shader errors. The normal shader, clocks,
tickers and media resume afterwards. Custom time-driven plugins may require
additional freezing; a baseline-versus-baseline mismatch detects that problem.

The subsequent `frames` report measures the running game. Its shared-context GPU
query spans the update handler and final PIXI render; it excludes separate
contexts and effects submitted after that render. CPU update time, render
submission time and frame intervals are reported separately. GPU time is not
interchangeable with FPS. Omit `--setup` for ordinary live-game profiling.

## Moving-scene shadow continuity — 2026-09-04

Revision **20260904.16** fixes a separate temporal problem: a cached static
shadow could adopt a new light origin before its dynamic partner refreshed,
temporarily suppressing character shadows. The pair now updates together
within the same budgets and intervals. Shadow-slot selection retains incumbents
through near ties, uses pre-flicker light values for priority, and changes cone
priority smoothly. Rendering still uses the actual animated light values.

Run the same profiler command above with
`--setup=editor/tests/perf/shadow-continuity-setup.js` to observe 240 rendered
frames with lights, actors and camera updates running. It checks for mismatched
static/dynamic maps, budget overruns and GL errors, and logs slot changes.
Changing slots is allowed when lights move, disappear or become substantially
more important; zero slot changes is not a general correctness condition.

The .15 Demo run recorded 24 slot changes and 46 mismatched pairs over 240
frames. Final .16 probes recorded two changes at full quality on NVIDIA and
one at weak quality on AMD integrated graphics, with zero mismatched pairs,
budget overruns or GL errors in either run. Weak quality was explicitly selected
in the disposable runtime copy. Animation phases differ across launches, so
these counts are diagnostic observations rather than a deterministic performance
comparison. The Node regressions separately reproduce controlled near ties and
paired-refresh contention; the three initial continuity cases fail on .15.

Full/weak shadow capacities and filtering remain unchanged. Lights without an
assigned shadow row still illuminate the scene; this fix does not make shadow
capacity unlimited or establish visual correctness for every scene and driver.

## Further candidates

Profile before expanding the changes. Promising remaining targets include
reusing beam-collision bounds within a frame, reducing repeated effect-anchor
lookups, and restricting each object's shader light list to lights that can
actually reach it. Any cache must invalidate on movement, animation, geometry
changes and removal. Existing static shadow caching and moving-shadow budgets
already avoid some redraws; extending them needs moving-scene comparisons to
catch stale shadows. Lowering resolution or geometry detail is a separate
quality decision, not part of this optimization.
