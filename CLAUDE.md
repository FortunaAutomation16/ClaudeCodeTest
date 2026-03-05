# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based retro games built as standalone HTML files with no build tools, frameworks, or external dependencies. Each game is a single self-contained `.html` file using vanilla JS and Canvas 2D rendering.

## Running

Open any `.html` file directly in a browser: `open <file>.html`

There is no build step, no package manager, no test framework.

## Architecture

### mario.html — "Red Cap Adventures"
A 2D platformer with a canvas-based game loop (`requestAnimationFrame`). Key architecture:

- **Game states**: `MENU → PLAYING → LEVEL_COMPLETE → WIN` (with `DYING` and `GAMEOVER` branches). State machine drives both `update()` and `render()`.
- **Pixel-art sprites**: Defined as 2D arrays of color characters, drawn at runtime via `drawPixels()`. No image files. Player has 4 frames (idle, walk1, walk2, jump). Enemies have 2 frames.
- **Tile-based levels**: Each level is a string map (`levels[]` array) parsed by `loadLevel()`. Characters map to tile types: `=` ground, `D` dirt, `B` brick, `P` player start, `E` enemy, `C` coin, `F` flag.
- **Physics/collision**: AABB tile collision in `collideTiles()` handles horizontal then vertical resolution. Enemies use a `bounce` flag to reverse direction on wall hits.
- **Camera**: Follows player with lerp smoothing, clamped to level bounds.

To add a new level: add an entry to the `levels[]` array with `bg`, `groundColor`, `dirtColor`, `brickColor`, and a `map` string array.

### tictactoe.html
Simple two-player tic-tac-toe with CSS grid layout and score tracking. No canvas — uses DOM elements.

## Git Workflow — MANDATORY

- GitHub remote: `FortunaAutomation16/ClaudeCodeTest`
- **After every meaningful change, you MUST commit and push to GitHub.** Do not let work accumulate uncommitted. If you've added a feature, fixed a bug, or made any substantive edit, commit and push immediately so progress is never lost.
- Write clean, descriptive commit messages that explain the "why" not just the "what".
- Stage specific files by name — do not use `git add .` or `git add -A`.
- Always push to `origin main` after committing so the remote stays up to date.
