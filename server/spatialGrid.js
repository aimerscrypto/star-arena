'use strict';

/**
 * Uniform spatial hash grid (data-oriented).
 *
 * The world is cut into square cells. Every tick the grid is rebuilt from the
 * live entities with a counting sort: positions are copied into flat typed
 * arrays and entity indices are grouped by cell. "What is near (x, y)?" then
 * only touches the handful of cells overlapping the query rectangle, reading
 * contiguous memory instead of chasing object pointers.
 *
 * Result: the cost of a proximity query depends on *local density*, not on the
 * total number of entities in the world. This is what lets one server process
 * handle hundreds of players: 1000 players spread over the map cost roughly the
 * same per query as 50.
 *
 *   8000 x 8000 world, 500px cells  ->  16 x 16 = 256 cells
 *   A 2400 x 1600 interest box touches at most 6 x 5 = 30 of them.
 *
 * build() writes each item's index into `item.gi` so callers can look up
 * per-tick data (encoded records, flags) by index.
 */
class SpatialGrid {
  constructor(worldSize, cellSize) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(worldSize / cellSize);
    this.nCells = this.cols * this.cols;
    this.cellStart = new Int32Array(this.nCells + 1); // items of cell c are order[cellStart[c] .. cellStart[c+1])
    this.cursor = new Int32Array(this.nCells);
    this.items = [];
    this.count = 0;
    this.alloc(256);
  }

  alloc(n) {
    this.xs = new Float32Array(n);
    this.ys = new Float32Array(n);
    this.cellOf = new Int32Array(n);
    this.order = new Int32Array(n);
  }

  _col(v) {
    const c = Math.floor(v / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  /** Rebuild from an array of objects with x/y. O(n + cells). */
  build(items) {
    const n = items.length;
    this.items = items;
    this.count = n;
    if (this.xs.length < n) this.alloc(Math.max(n, this.xs.length * 2));
    const { xs, ys, cellOf, order, cellStart, cursor, cols } = this;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      it.gi = i;
      const x = it.x, y = it.y;
      xs[i] = x; ys[i] = y;
      const c = this._col(y) * cols + this._col(x);
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 1; c <= this.nCells; c++) cellStart[c] += cellStart[c - 1];
    cursor.set(cellStart.subarray(0, this.nCells));
    for (let i = 0; i < n; i++) order[cursor[cellOf[i]]++] = i;
  }

  /** Write the indices of all items inside the rectangle into `out` (Int32Array); returns how many. */
  queryIdx(minX, minY, maxX, maxY, out) {
    const c0 = this._col(minX), c1 = this._col(maxX);
    const r0 = this._col(minY), r1 = this._col(maxY);
    const { xs, ys, order, cellStart, cols } = this;
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      const row = r * cols;
      for (let c = c0; c <= c1; c++) {
        const end = cellStart[row + c + 1];
        for (let k = cellStart[row + c]; k < end; k++) {
          const i = order[k];
          const x = xs[i], y = ys[i];
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) out[n++] = i;
        }
      }
    }
    return n;
  }

  /** Convenience: push the matching objects into `out` (array) and return it. */
  query(minX, minY, maxX, maxY, out) {
    if (!this.tmp || this.tmp.length < this.count) this.tmp = new Int32Array(Math.max(256, this.count * 2));
    const n = this.queryIdx(minX, minY, maxX, maxY, this.tmp);
    for (let k = 0; k < n; k++) out.push(this.items[this.tmp[k]]);
    return out;
  }
}

module.exports = { SpatialGrid };
