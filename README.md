# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/1touhou/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/1touhou/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: it answers all 5 instances of a set in one run, in as few pushes as possible.

## Approach

The levels are a hallway with rooms off it, and a box pushed into the hallway can never come back, so each room is solved on its own from its door:

1. **Split into rooms.** The hallway row's dead squares are cut out of the floor; each remaining part holding boxes is a room. The other rooms' boxes stand as walls while a room is solved (on their goals once their room is done).
2. **A\* over pushes, per room.** A state is the boxes plus the player's reachable region (named by its lowest square). The estimate is the cheapest matching of boxes to goals over shortest-path distances, which never overestimates the pushes left, so the first solved state met is push-optimal.
3. **Deadlock pruning.** A push is refused when its target square is dead (no pull path to any goal) or when it lands in a frozen 2x2 block of walls and boxes with a box off its goal. Neither prunes a solvable state.
4. **Fallbacks.** If a room resists, the whole level is tried the same way; if that fails too, a plain move A\* is tried so the level still gets an answer rather than none.

All budgets count work (expanded states), never the clock, so two runs write byte-identical outputs. The whole set runs in a few seconds on one CPU.

## Practice set

On the kit's practice set it solves every instance in its push-optimal count (P\* 13 / 16 / 29 / 47 / 60), for a practice score of 1,000,000 — against the plain-astar 1.0.0 baseline's 200,000 (it only solves the first instance).

## Run it

```sh
node main.ts
```

It reads every instance from `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt`: the player's moves in LURD, one letter a step. Dependency-free, JavaScript/TypeScript only, deterministic.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3bes5xfn&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
