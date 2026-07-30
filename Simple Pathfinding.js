(function (Scratch) {
  'use strict';

  // This extension needs direct access to sprite positions/bounds and the
  // list of other sprites, so it must be loaded "unsandboxed" in PenguinMod.
  if (!Scratch.extensions.unsandboxed) {
    throw new Error('Simple Pathfinding must be run unsandboxed');
  }

  // Stores each sprite's target position: targetId -> {x, y}
  const targetPositions = new Map();

  // Stores each sprite's avoidance settings: targetId -> {mode, names}
  // mode: 'all' (avoid every other sprite, default), 'none' (avoid nothing),
  // or 'list' (only avoid sprites whose name is in "names")
  const avoidConfigs = new Map();

  class SimplePathfinding {
    constructor() {
      this.runtime = Scratch.vm.runtime;
    }

    getInfo() {
      return {
        id: 'simplePathfinding',
        name: 'Simple Pathfinding',
        color1: '#4C97FF',
        color2: '#3373CC',
        blocks: [
          {
            opcode: 'setTarget',
            blockType: Scratch.BlockType.COMMAND,
            text: 'set target position to x: [X] y: [Y]',
            arguments: {
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
            }
          },
          {
            opcode: 'moveStepAvoid',
            blockType: Scratch.BlockType.COMMAND,
            text: 'move [STEPS] steps toward target avoiding sprites',
            arguments: {
              STEPS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 10 }
            }
          },
          {
            opcode: 'goToTargetAvoid',
            blockType: Scratch.BlockType.COMMAND,
            text: 'go to target avoiding sprites (max [MAXSTEPS] steps)',
            arguments: {
              MAXSTEPS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 }
            }
          },
          '---',
          {
            opcode: 'avoidSprite',
            blockType: Scratch.BlockType.COMMAND,
            text: 'avoid sprite [SPRITE]',
            arguments: {
              SPRITE: { type: Scratch.ArgumentType.STRING, menu: 'spriteMenu' }
            }
          },
          {
            opcode: 'stopAvoidingSprite',
            blockType: Scratch.BlockType.COMMAND,
            text: 'stop avoiding sprite [SPRITE]',
            arguments: {
              SPRITE: { type: Scratch.ArgumentType.STRING, menu: 'spriteMenu' }
            }
          },
          {
            opcode: 'avoidAllSprites',
            blockType: Scratch.BlockType.COMMAND,
            text: 'avoid all other sprites'
          },
          {
            opcode: 'avoidNoSprites',
            blockType: Scratch.BlockType.COMMAND,
            text: 'avoid no sprites'
          },
          '---',
          {
            opcode: 'distanceToTarget',
            blockType: Scratch.BlockType.REPORTER,
            text: 'distance to target'
          },
          {
            opcode: 'atTarget',
            blockType: Scratch.BlockType.BOOLEAN,
            text: 'reached target?'
          },
          {
            opcode: 'targetX',
            blockType: Scratch.BlockType.REPORTER,
            text: 'target x'
          },
          {
            opcode: 'targetY',
            blockType: Scratch.BlockType.REPORTER,
            text: 'target y'
          }
        ],
        menus: {
          spriteMenu: {
            acceptReporters: true,
            items: 'getSpriteMenu'
          }
        }
      };
    }

    // ---- helpers ----

    getSpriteMenu() {
      const names = this.runtime.targets
        .filter((t) => t.isOriginal && !t.isStage)
        .map((t) => t.getName());
      return names.length > 0 ? names : ['no sprites'];
    }

    getTarget(util) {
      const id = util.target.id;
      if (!targetPositions.has(id)) {
        targetPositions.set(id, { x: util.target.x, y: util.target.y });
      }
      return targetPositions.get(id);
    }

    getAvoidConfig(util) {
      const id = util.target.id;
      if (!avoidConfigs.has(id)) {
        avoidConfigs.set(id, { mode: 'all', names: new Set() });
      }
      return avoidConfigs.get(id);
    }

    // Keep a candidate position inside the stage, shrunk by the sprite's own
    // half-width/half-height so its whole costume stays on screen.
    clampToStage(util, x, y) {
      const stageWidth = this.runtime.stageWidth || 480;
      const stageHeight = this.runtime.stageHeight || 360;
      const bounds = util.target.getBounds();
      const halfW = bounds ? (bounds.right - bounds.left) / 2 : 0;
      const halfH = bounds ? (bounds.top - bounds.bottom) / 2 : 0;
      const maxX = Math.max(0, stageWidth / 2 - halfW);
      const maxY = Math.max(0, stageHeight / 2 - halfH);
      return {
        x: Math.max(-maxX, Math.min(maxX, x)),
        y: Math.max(-maxY, Math.min(maxY, y))
      };
    }

    // Builds a grid over the stage and runs A* from the sprite's current
    // cell to the target's cell, treating cells covered by "avoided"
    // sprites as walls. Returns an array of {x, y} waypoints (stage
    // coordinates) from just after the start up to the goal, or null if no
    // route exists at all.
    findPath(util) {
      const cellSize = 20;
      const me = util.target;
      const stageWidth = this.runtime.stageWidth || 480;
      const stageHeight = this.runtime.stageHeight || 360;
      const cols = Math.max(1, Math.floor(stageWidth / cellSize));
      const rows = Math.max(1, Math.floor(stageHeight / cellSize));

      const cfg = this.getAvoidConfig(util);
      const myBounds = me.getBounds();
      const halfW = myBounds ? (myBounds.right - myBounds.left) / 2 : cellSize / 2;
      const halfH = myBounds ? (myBounds.top - myBounds.bottom) / 2 : cellSize / 2;

      // For each obstacle keep an (inflated) bounding box, used only as a
      // cheap first filter, plus a reference to the actual sprite. A
      // costume can contain more than one separate shape with empty space
      // between them, so the bounding box alone is never trusted to mark a
      // cell blocked - it's only used to skip cells that are obviously
      // nowhere near the obstacle, before doing a real pixel-perfect check.
      const obstacles = [];
      if (cfg.mode !== 'none') {
        for (const other of util.runtime.targets) {
          if (other === me) continue;
          if (other.isStage) continue;
          if (!other.visible) continue;
          if (cfg.mode === 'list' && !cfg.names.has(other.getName())) continue;
          const ob = other.getBounds();
          if (!ob) continue;
          obstacles.push({
            target: other,
            left: ob.left - halfW,
            right: ob.right + halfW,
            bottom: ob.bottom - halfH,
            top: ob.top + halfH
          });
        }
      }

      const toCol = (x) => Math.floor((x + stageWidth / 2) / cellSize);
      const toRow = (y) => Math.floor((stageHeight / 2 - y) / cellSize);
      const cellX = (col) => -stageWidth / 2 + (col + 0.5) * cellSize;
      const cellY = (row) => stageHeight / 2 - (row + 0.5) * cellSize;
      const clampCol = (c) => Math.max(0, Math.min(cols - 1, c));
      const clampRow = (r) => Math.max(0, Math.min(rows - 1, r));

      // Precise check: is a specific cell actually blocked? We use the same
      // pixel-perfect mechanism as Scratch's "touching [sprite]?" block -
      // temporarily place our sprite at the candidate spot and ask if its
      // real costume shape overlaps the obstacle's real costume shape, then
      // put it back. This correctly ignores transparent/empty gaps within a
      // costume instead of treating its whole bounding box as solid.
      const isBlocked = (col, row) => {
        const x = cellX(col);
        const y = cellY(row);

        const namesToCheck = new Set();
        for (const ob of obstacles) {
          if (x > ob.left && x < ob.right && y < ob.top && y > ob.bottom) {
            namesToCheck.add(ob.target.getName());
          }
        }
        if (namesToCheck.size === 0) return false;

        const origX = me.x;
        const origY = me.y;
        me.setXY(x, y, true);
        let collided = false;
        for (const name of namesToCheck) {
          if (me.isTouchingSprite(name)) {
            collided = true;
            break;
          }
        }
        me.setXY(origX, origY, true);
        return collided;
      };

      const t = this.getTarget(util);
      const startCol = clampCol(toCol(me.x));
      const startRow = clampRow(toRow(me.y));
      let goalCol = clampCol(toCol(t.x));
      let goalRow = clampRow(toRow(t.y));

      // If the exact goal cell is inside an obstacle (target dropped on top
      // of a wall, etc), aim for the nearest open cell to it instead of
      // failing outright.
      if (isBlocked(goalCol, goalRow)) {
        let bestCol = goalCol;
        let bestRow = goalRow;
        let foundOpen = false;
        for (let radius = 1; radius <= Math.max(cols, rows) && !foundOpen; radius++) {
          for (let dc = -radius; dc <= radius && !foundOpen; dc++) {
            for (let dr = -radius; dr <= radius && !foundOpen; dr++) {
              if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
              const c = clampCol(goalCol + dc);
              const r = clampRow(goalRow + dr);
              if (!isBlocked(c, r)) {
                bestCol = c;
                bestRow = r;
                foundOpen = true;
              }
            }
          }
        }
        goalCol = bestCol;
        goalRow = bestRow;
      }

      // --- A* search over the grid ---
      const key = (c, r) => c + ',' + r;
      const startKey = key(startCol, startRow);
      const goalKey = key(goalCol, goalRow);

      const gScore = new Map([[startKey, 0]]);
      const cameFrom = new Map();
      const open = new Map([[startKey, { col: startCol, row: startRow, f: Math.hypot(goalCol - startCol, goalRow - startRow) }]]);
      const closed = new Set();

      const neighborOffsets = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1]
      ];

      const maxIterations = cols * rows * 4;
      let iterations = 0;
      let found = open.has(goalKey) && startKey === goalKey;

      while (open.size > 0 && iterations < maxIterations) {
        iterations++;
        let currentKey = null;
        let current = null;
        for (const [k, node] of open) {
          if (!current || node.f < current.f) {
            current = node;
            currentKey = k;
          }
        }
        if (currentKey === goalKey) {
          found = true;
          break;
        }
        open.delete(currentKey);
        closed.add(currentKey);

        for (const [dcol, drow] of neighborOffsets) {
          const ncol = current.col + dcol;
          const nrow = current.row + drow;
          if (ncol < 0 || ncol >= cols || nrow < 0 || nrow >= rows) continue;
          const nk = key(ncol, nrow);
          if (closed.has(nk)) continue;
          if (isBlocked(ncol, nrow)) continue;
          // don't let the search cut across a blocked corner diagonally
          if (dcol !== 0 && drow !== 0) {
            if (isBlocked(current.col + dcol, current.row) || isBlocked(current.col, current.row + drow)) continue;
          }
          const moveCost = (dcol !== 0 && drow !== 0) ? Math.SQRT2 : 1;
          const tentativeG = (gScore.get(currentKey) ?? Infinity) + moveCost;
          if (tentativeG < (gScore.get(nk) ?? Infinity)) {
            gScore.set(nk, tentativeG);
            cameFrom.set(nk, currentKey);
            const h = Math.hypot(goalCol - ncol, goalRow - nrow);
            open.set(nk, { col: ncol, row: nrow, f: tentativeG + h });
          }
        }
      }

      if (!found) return null;

      const path = [];
      let curKey = goalKey;
      while (curKey && curKey !== startKey) {
        const [c, r] = curKey.split(',').map(Number);
        path.push({ x: cellX(c), y: cellY(r) });
        curKey = cameFrom.get(curKey);
      }
      path.reverse();
      return path;
    }

    // Walk along a sequence of waypoints for up to "moveDist" total distance,
    // starting from (startX, startY). Returns the resulting {x, y}.
    followPath(path, moveDist, startX, startY) {
      let remaining = moveDist;
      let curX = startX;
      let curY = startY;
      for (const wp of path) {
        const segDx = wp.x - curX;
        const segDy = wp.y - curY;
        const segDist = Math.hypot(segDx, segDy);
        if (segDist <= remaining) {
          remaining -= segDist;
          curX = wp.x;
          curY = wp.y;
          if (remaining <= 0.0001) break;
        } else {
          const ratio = segDist > 0 ? remaining / segDist : 0;
          curX += segDx * ratio;
          curY += segDy * ratio;
          break;
        }
      }
      return { x: curX, y: curY };
    }

    // ---- blocks ----

    setTarget(args, util) {
      targetPositions.set(util.target.id, { x: Number(args.X), y: Number(args.Y) });
    }

    avoidSprite(args, util) {
      const cfg = this.getAvoidConfig(util);
      cfg.mode = 'list';
      cfg.names.add(String(args.SPRITE));
    }

    stopAvoidingSprite(args, util) {
      const cfg = this.getAvoidConfig(util);
      cfg.names.delete(String(args.SPRITE));
    }

    avoidAllSprites(args, util) {
      const cfg = this.getAvoidConfig(util);
      cfg.mode = 'all';
      cfg.names.clear();
    }

    avoidNoSprites(args, util) {
      const cfg = this.getAvoidConfig(util);
      cfg.mode = 'none';
      cfg.names.clear();
    }

    targetX(args, util) {
      return this.getTarget(util).x;
    }

    targetY(args, util) {
      return this.getTarget(util).y;
    }

    distanceToTarget(args, util) {
      const t = this.getTarget(util);
      const dx = t.x - util.target.x;
      const dy = t.y - util.target.y;
      return Math.round(Math.sqrt(dx * dx + dy * dy) * 100) / 100;
    }

    atTarget(args, util) {
      return this.distanceToTarget(args, util) < 2;
    }

    moveStepAvoid(args, util) {
      const steps = Number(args.STEPS);
      const me = util.target;
      const t = this.getTarget(util);

      const dist = Math.hypot(t.x - me.x, t.y - me.y);
      if (dist < 2) return;

      const path = this.findPath(util);
      if (!path || path.length === 0) return; // fully boxed in - no route exists right now

      const origX = me.x;
      const origY = me.y;
      const dest = this.followPath(path, steps, origX, origY);
      const clamped = this.clampToStage(util, dest.x, dest.y);

      const dx = clamped.x - origX;
      const dy = clamped.y - origY;
      if (Math.hypot(dx, dy) < 0.01) return;

      const angle = (Math.atan2(dx, dy) * 180) / Math.PI;
      me.setXY(clamped.x, clamped.y, true);
      me.setDirection(angle);
    }

    async goToTargetAvoid(args, util) {
      const maxSteps = Math.max(1, Number(args.MAXSTEPS));
      for (let i = 0; i < maxSteps; i++) {
        if (this.atTarget(args, util)) break;
        this.moveStepAvoid({ STEPS: 5 }, util);
        // small pause so the movement animates instead of teleporting
        await new Promise((resolve) => setTimeout(resolve, 1000 / 30));
      }
    }
  }

  Scratch.extensions.register(new SimplePathfinding());
})(Scratch);