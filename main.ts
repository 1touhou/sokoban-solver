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
