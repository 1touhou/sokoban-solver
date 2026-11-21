// A push-optimal Sokoban solver.
//
// The levels are a hallway with rooms off it, and a box pushed into the
// hallway can never come back, so each room is solved on its own from its
// door. Each room is searched with A* over pushes: a state is the boxes plus
// the player's reachable region, and the estimate is the cheapest matching of
// boxes to goals over shortest-path distances, which never overestimates the
// pushes left. Two deadlocks are pruned: a dead square (no pull path to any
// goal) and a frozen 2x2 block of walls and boxes with a box off its goal.
// If a room resists, the whole level is tried the same way, and finally a
// plain move A* is tried so a level still gets a (suboptimal) answer rather
// than none. Every budget counts work, never the clock, so two runs agree
// byte for byte.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets: expansions counted, never the clock. */
const ROOM_STATES = 500_000;
const LEVEL_STATES = 500_000;
const MOVE_STATES = 100_000;

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** The square one step from p in direction d, or -1 off the board. */
function stepFrom(p: number, d: number, w: number, h: number): number {
  const x = p % w;
  const y = (p / w) | 0;
  const nx = x + DX[d]!;
  const ny = y + DY[d]!;
  if (nx < 0 || ny < 0 || nx >= w || ny >= h) return -1;
  return ny * w + nx;
}

/** A level in XSB text. Short rows and the border pad out as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** Squares a box can be pulled from onto some goal, found by pulling back from the goals. */
function liveSquares(wall: Uint8Array, goals: number[], w: number, h: number): Uint8Array {
  const size = w * h;
  const live = new Uint8Array(size);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let d = 0; d < 4; d++) {
      const y = stepFrom(x, d ^ 1, w, h);
      if (y < 0 || wall[y] || live[y]) continue;
      const behind = stepFrom(y, d ^ 1, w, h);
      if (behind < 0 || wall[behind]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/** Whether the box just pushed to t sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number, w: number, size: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a + w + 1 >= size || (a % w) > w - 2) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Flood the player's region from `from` (walls and `occupied` in the way), marking `seen` with `stamp`; returns its lowest square. */
function reachLow(wall: Uint8Array, occupied: Uint8Array, from: number, w: number, h: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let d = 0; d < 4; d++) {
      const q = stepFrom(p, d, w, h);
      if (q >= 0 && !wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Shortest walk from `from` to `to` around walls and boxes; the first direction wins ties. */
function walkTo(wall: Uint8Array, occupied: Uint8Array, from: number, to: number, w: number, h: number): string {
  const size = w * h;
  if (from === to) return '';
  const prev = new Int32Array(size).fill(-1);
  const how = new Uint8Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let d = 0; d < 4; d++) {
      const q = stepFrom(p, d, w, h);
      if (q < 0 || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = LETTER[how[p]!]! + s;
  return s;
}

/** Shortest-path distances from each goal over open floor, ignoring boxes. */
function goalDistances(wall: Uint8Array, goals: number[], w: number, h: number): Int32Array[] {
  const size = w * h;
  const all: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(size).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (let d = 0; d < 4; d++) {
        const q = stepFrom(p, d, w, h);
        if (q >= 0 && !wall[q] && dist[q] === -1) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    all.push(dist);
  }
  return all;
}

/** Every assignment of boxes to goals, as permutations of the goal indices. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i]!, a[k]!];
      gen(k + 1);
      [a[k], a[i]] = [a[i]!, a[k]!];
    }
  };
  gen(0);
  return out;
}

/** Cheapest matching of the boxes to the goals over shortest-path distances; Infinity when no box can reach its goal. */
function matchingCost(boxes: number[], dist: Int32Array[], perms: number[][]): number {
  let best = Infinity;
  for (const perm of perms) {
    let s = 0;
    for (let i = 0; i < boxes.length; i++) {
      const d = dist[perm[i]!]![boxes[i]!]!;
      if (d < 0) {
        s = Infinity;
        break;
      }
      s += d;
    }
    if (s < best) best = s;
  }
  return best;
}

/** A heap on [f, g, index]: least f first, then most pushes, then first found. */
function heapLess(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
}
function heapPush(heap: [number, number, number][], e: [number, number, number]): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i]!, heap[p]!)) break;
    [heap[i], heap[p]] = [heap[p]!, heap[i]!];
    i = p;
  }
}
function heapPop(heap: [number, number, number][]): [number, number, number] {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
      if (!heapLess(heap[c]!, heap[i]!)) break;
      [heap[i], heap[c]] = [heap[c]!, heap[i]!];
      i = c;
    }
  }
  return top;
}

/** Push-optimal solution of a level: {pushes, moves}, or null when the search gives up. */
function solvePush(
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  w: number,
  h: number,
  maxStates: number,
): { pushes: number; moves: string } | null {
  const size = w * h;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(wall, goals, w, h);
  const boxes = boxes0.slice().sort((a, b) => a - b);
  if (boxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (solved(boxes)) return { pushes: 0, moves: '' };
  const dist = goalDistances(wall, goals, w, h);
  const perms = permutations(goals.length);
  const numericKey = Math.pow(size, boxes.length + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (bs: number[], low: number): number | string => {
    if (numericKey) {
      let k = low;
      for (const b of bs) k = k * size + b;
      return k;
    }
    return `${low}|${bs.join(',')}`;
  };

  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const occupied = new Uint8Array(size);
  let stamp = 0;

  const sBoxes: number[][] = [boxes];
  const sPlayer: number[] = [player0];
  const sParent: number[] = [-1];
  const sKey: (number | string)[] = [];
  const sDone: number[] = [0];
  const best = new Map<number | string, number>();
  const heap: [number, number, number][] = [];

  for (const b of boxes) occupied[b] = 1;
  const low0 = reachLow(wall, occupied, player0, w, h, seen, ++stamp, stack);
  for (const b of boxes) occupied[b] = 0;
  const k0 = keyOf(boxes, low0);
  sKey.push(k0);
  best.set(k0, 0);
  const h0 = matchingCost(boxes, dist, perms);
  if (h0 === Infinity) return null;
  heapPush(heap, [h0, 0, 0]);

  let found = -1;
  let expanded = 0;
  while (heap.length > 0) {
    const [, g, s] = heapPop(heap);
    if (best.get(sKey[s]!) !== g || sDone[s]) continue;
    sDone[s] = 1;
    const bs = sBoxes[s]!;
    if (solved(bs)) {
      found = s;
      break;
    }
    if (expanded >= maxStates) return null;
    expanded++;
    const player = sPlayer[s]!;
    for (const b of bs) occupied[b] = 1;
    reachLow(wall, occupied, player, w, h, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < bs.length && found < 0; bi++) {
      const b = bs[bi]!;
      for (let d = 0; d < 4; d++) {
        const behind = stepFrom(b, d ^ 1, w, h);
        const t = stepFrom(b, d, w, h);
        if (behind < 0 || t < 0 || seen[behind] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(wall, occupied, goal, t, w, size)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const nb = bs.slice();
        nb[bi] = t;
        nb.sort((a, b2) => a - b2);
        const low = reachLow(wall, occupied, b, w, h, mark, ++stamp, stack);
        occupied[t] = 0;
        occupied[b] = 1;
        const g2 = g + 1;
        const k = keyOf(nb, low);
        const prev = best.get(k);
        if (prev !== undefined && prev <= g2) continue;
        const h2 = matchingCost(nb, dist, perms);
        if (h2 === Infinity) continue;
        best.set(k, g2);
        const idx = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(b);
        sParent.push(s);
        sKey.push(k);
        sDone.push(0);
        heapPush(heap, [g2 + h2, g2, idx]);
        if (solved(nb)) {
          found = idx;
          break;
        }
      }
    }
    for (const b of bs) occupied[b] = 0;
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = player0;
  let cur = boxes;
  for (const s of path) {
    const nb = sBoxes[s]!;
    const from = cur.find((b) => !nb.includes(b))!;
    const to = nb.find((b) => !cur.includes(b))!;
    const d = to - from === -w ? 0 : to - from === w ? 1 : to - from === -1 ? 2 : 3;
    for (const b of cur) occupied[b] = 1;
    moves += walkTo(wall, occupied, player, stepFrom(from, d ^ 1, w, h)!, w, h);
    for (const b of cur) occupied[b] = 0;
    moves += LETTER[d]!;
    player = from;
    cur = nb;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/** The level's rooms: cut the hallway row's dead squares out of the floor, and each part left holding boxes is a room. */
function roomsOf(level: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const size = w * h;
  const live = liveSquares(wall, goals, w, h);
  const row = (player / w) | 0;
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let d = 0; d < 4; d++) {
        const q = stepFrom(squares[i]!, d, w, h);
        if (q >= 0 && !wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The player's square after playing `moves` from `player`. */
function endOf(w: number, h: number, player: number, moves: string): number {
  let p = player;
  for (const ch of moves) {
    const d = 'udlr'.indexOf(ch);
    if (d < 0) continue;
    const q = stepFrom(p, d, w, h);
    if (q >= 0) p = q;
  }
  return p;
}

/** Solve room by room, the other rooms' boxes standing as walls (on their goals once done). */
function solveByRooms(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePush(level.wall, level.goals, level.boxes, level.player, level.w, level.h, LEVEL_STATES);
  let player = level.player;
  let moves = '';
  let pushes = 0;
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub = solvePush(wall, room.goals.slice().sort((a, b) => a - b), room.boxes.slice().sort((a, b) => a - b), player, level.w, level.h, maxStates);
    if (sub === null) return null;
    moves += sub.moves;
    pushes += sub.pushes;
    player = endOf(level.w, level.h, player, sub.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Last resort: A* over moves (fewest steps, not pushes), so a level still gets an answer. */
function solveMoves(level: Level, maxStates: number): string | null {
  const { w, h, wall, goals } = level;
  const size = w * h;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dist = (b: number): number => {
    let m = Infinity;
    for (const g of goals) m = Math.min(m, Math.abs((g % w) - (b % w)) + Math.abs(((g / w) | 0) - ((b / w) | 0)));
    return m;
  };
  const est = (bs: number[]): number => bs.reduce((a, b) => a + dist(b), 0);
  const keyOf = (p: number, bs: number[]): string => `${p}|${bs.join(',')}`;
  const boxes0 = level.boxes.slice().sort((a, b) => a - b);
  const sp: number[] = [level.player];
  const sb: number[][] = [boxes0];
  const parent: number[] = [-1];
  const step: string[] = [''];
  const done = new Set<number>();
  const best = new Map<string, number>([[keyOf(level.player, boxes0), 0]]);
  const heap: [number, number, number][] = [];
  heapPush(heap, [est(boxes0), 0, 0]);
  let expanded = 0;
  while (heap.length > 0) {
    const [, g, s] = heapPop(heap);
    if (best.get(keyOf(sp[s]!, sb[s]!)) !== g || done.has(s)) continue;
    done.add(s);
    const bs = sb[s]!;
    if (bs.every((b) => goal[b])) {
      let moves = '';
      for (let t = s; t > 0; t = parent[t]!) moves = step[t]! + moves;
      return moves;
    }
    if (expanded >= maxStates) return null;
    expanded++;
    const p = sp[s]!;
    for (let d = 0; d < 4; d++) {
      const q = stepFrom(p, d, w, h);
      if (q < 0 || wall[q]) continue;
      let nb = bs;
      const at = bs.indexOf(q);
      if (at >= 0) {
        const t = stepFrom(q, d, w, h);
        if (t < 0 || wall[t] || bs.includes(t)) continue;
        nb = bs.slice();
        nb[at] = t;
        nb.sort((a, b) => a - b);
      }
      const k = keyOf(q, nb);
      const prev = best.get(k);
      if (prev !== undefined && prev <= g + 1) continue;
      const t = sp.length;
      sp.push(q);
      sb.push(nb);
      parent.push(s);
      step.push(LETTER[d]!);
      best.set(k, g + 1);
      heapPush(heap, [g + 1 + est(nb), g + 1, t]);
    }
  }
  return null;
}

/** The moves for one level: room by room when the level splits, else the whole level, else a move search. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const byRooms = solveByRooms(level, ROOM_STATES);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePush(level.wall, level.goals, level.boxes, level.player, level.w, level.h, LEVEL_STATES);
  if (whole !== null) return whole.moves;
  return solveMoves(level, MOVE_STATES) ?? '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
