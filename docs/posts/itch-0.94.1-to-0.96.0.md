# What we've been building since 0.94.1

Historical release/cycle notes. Features, limitations, and counts below describe
that period; see [current project status](../STATUS.md) for today's behavior.

It's been a while since the last update post, so here's where RPG Reactor is.

Short version: three releases' worth of work, most of it under the hood. A
correctness pass that fixed around sixty-five real bugs, two new tileset sheets,
a much better map editor, and the big one — RPG Reactor can now render an
ordinary RPG Maker map in 3D.

## 3D maps

This is the headline and it's the newest, so read the caveats at the end.

Add `<3d>` to a map's note and it renders in three dimensions. The ground lies
flat, walls and buildings stand up, characters stay as 2D sprites moving on the
same grid. Event commands, passability, regions and movement all work exactly as
they did, because nothing about the game logic changed — this is a *view* of
your map, not a second engine.

Your `Map###.json` is never rewritten. Elevation and camera live in a small file
beside it, and a project with no 3D maps doesn't even download the 3D library.

The editor has a **3D** checkbox next to the A1 toggle. Orbit, pan, zoom, and
paint directly in the 3D view — same brush, same autotiles, same undo, because
painting shares one implementation with the 2D canvas.

Which tiles stand up can't be worked out from a tileset. A shopfront wall and a
forest are both just "impassable". So the tileset editor gained a **3D Shape**
mode where you say what a tile is — flat, upright, scenery, foliage — and drag a
rectangle to declare which tiles form a single object. There's a generator that
fills in a sensible starting point from how your maps are already painted.

## Everything else that changed

**A deep correctness pass.** We started using the RPG Maker-authored projects we
ship against as a reference — 1,300 maps, 37,000 events, every database record —
and checked Reactor's output against what RPG Maker itself writes. That found
bugs no amount of reading would have.

The worst were the silent ones. Opening an event command and pressing OK could
quietly change it: "Entire Party" collapsed onto actor 1 in 284 of 284 Change HP
commands, a Show Text set to Top lost its position, and a one-second BGM fadeout
actually ran for a minute. New database records were missing fields the engine
reads without checking, so a skill you created couldn't be used by anyone, a new
weapon couldn't be equipped, and using a new item set your TP to `NaN` for the
rest of the battle. All fixed.

Also fixed: deployment was shipping a complete duplicate of your database
(13–15 MB) left behind by Battle Test, `Tilesets.json` and `System.json` could
be destroyed by a crash mid-save, and an event's Name or Note could execute
markup in the editor.

**Two more tileset sheets, F and G.** 512 extra tiles on top of B–E's 1,024.
They behave exactly like B–E and use a tile-number range RPG Maker leaves empty,
so importing an MZ or MV project can never collide with them.

**Map editing.** Resizing a map now warns before discarding anything and tells
you exactly which events would be deleted — both used to vanish silently. A new
anchor picker lets a map grow from the top or left, and Transfer Player commands
elsewhere in the project that point at fixed coordinates are offered an update
so they still arrive in the right place. Right-clicking a single autotile picks
the *kind*, so painting continues the pattern instead of stamping middle pieces.
Wall autotiles painted against the map edge keep their end caps. Long events can
have their Conditional Branch, Show Choices and Loop blocks folded away, and the
folds are remembered per page.

**Tileset editor.** All eleven layer slots visible without scrolling, a proper
image picker, and every marking readable over any artwork — a red X on red
brickwork used to disappear into it.

## What's next

The 3D renderer is a first pass and we'd rather say so than let you find out.
Known and unfinished:

- Terrain needs authoring to look its best. The generator gives you a starting
  point; expect to correct it.
- Forests read as dense cover rather than as individual trees, and mountain
  ranges as texture rather than peaks.
- Interior walls show the wrong art on their tops, because a wall autotile is a
  wall *face* and has no top.
- Pits and craters stand up, because nothing in a tileset separates a hole in
  the ground from an object standing on it. Set those tiles to Flat.
- No parallax or sky in 3D yet. Battles are still 2D.
- Painting on a large 3D map is slower than in 2D — the scene rebuilds on every
  stroke.

None of that touches 2D projects. 3D is opt-in per map, and a project without a
`<3d>` map behaves exactly as it always has.

Next up is finishing that list, starting with the wall tops and the forest
arrangement.

Thanks for reading, and thanks to everyone who's sent bug reports — a good few
of the fixes above came straight from them.
