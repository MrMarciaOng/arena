import * as THREE from "three";
import type { Palette } from "@/lib/palette";
import {
  ISLAND_WIDTH,
  PLOT_COLS,
  PLOT_SIZE,
  POND_BOUNDS,
  plotOrigin,
  type BuildStage,
  type IslandPlacement,
} from "./layout";

export type VoxelBox = {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  color: string;
  rx?: number;
  ry?: number;
  rz?: number;
};

const AWAY_GRAY = new THREE.Color("#b5b2aa");
const TEMP_COLOR = new THREE.Color();
const TEMP_OBJ = new THREE.Object3D();

/** Deterministic integer hash for subtle voxel colour & terrain variation. */
function hash2(x: number, z: number, salt = 0): number {
  let h = (x * 374761393 + z * 668265263 + salt * 1442695041) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Mix a hex colour toward warm neutral grey for away/dimmed agents. */
export function maybeDimHex(hex: string, dimmed: boolean, amount = 0.48): string {
  if (!dimmed) return hex;
  TEMP_COLOR.set(hex).lerp(AWAY_GRAY, amount);
  return `#${TEMP_COLOR.getHexString()}`;
}

/** Creates a tiny 16×16 nearest-filtered grain texture so voxel faces feel tactile like the reference. */
export function createVoxelGrainTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const size = 16;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = 238 + (hash2(x, y, 17) % 18); // 238..255 subtle grain
      const idx = (y * size + x) * 4;
      img.data[idx] = v;
      img.data[idx + 1] = v;
      img.data[idx + 2] = v;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** True if `(vx, vz)` is part of the floating island footprint (notched corners like the reference). */
function isIslandTile(vx: number, vz: number, width: number, depth: number): boolean {
  if (vx < 0 || vz < 0 || vx >= width || vz >= depth) return false;
  // Softly chiseled corners for an organic floating-chunk silhouette.
  const dx = Math.min(vx, width - 1 - vx);
  const dz = Math.min(vz, depth - 1 - vz);
  if (dx === 0 && dz === 0) return false;
  if (vx === 0 && vz === depth - 2) return false;
  if (vx === width - 1 && vz === 1) return false;
  return true;
}

function isPondTile(vx: number, vz: number): boolean {
  return vx >= POND_BOUNDS.minX && vx < POND_BOUNDS.maxX && vz >= POND_BOUNDS.minZ && vz < POND_BOUNDS.maxZ;
}

function isPlotTile(vx: number, vz: number, rows: number): boolean {
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < PLOT_COLS; c += 1) {
      const origin = plotOrigin(r * PLOT_COLS + c);
      const minX = origin.center.x - PLOT_SIZE / 2;
      const minZ = origin.center.z - PLOT_SIZE / 2;
      if (vx >= minX && vx < minX + PLOT_SIZE && vz >= minZ && vz < minZ + PLOT_SIZE) return true;
    }
  }
  return false;
}

function isPlotStepTile(vx: number, vz: number, rows: number): boolean {
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < PLOT_COLS; c += 1) {
      const origin = plotOrigin(r * PLOT_COLS + c);
      const minX = origin.center.x - 1;
      const stepZ = origin.center.z + PLOT_SIZE / 2;
      if (vx >= minX && vx < minX + 2 && vz === stepZ) return true;
    }
  }
  return false;
}

function addVoxelTree(out: VoxelBox[], vx: number, vz: number, tall: boolean) {
  const cx = vx + 0.5;
  const cz = vz + 0.5;
  const trunkH = tall ? 1.85 : 1.45;
  // Brown voxel trunk.
  out.push({ x: cx, y: trunkH / 2, z: cz, sx: 0.56, sy: trunkH, sz: 0.56, color: "#6c462a" });
  const greens = ["#4c8f40", "#5aa14b", "#407e36", "#6ab258"];
  const step = 0.62;
  const baseY = trunkH + step * 0.3;
  // Layer 0 (wide clustered base)
  for (let gx = -1; gx <= 1; gx += 1) {
    for (let gz = -1; gz <= 1; gz += 1) {
      const h = hash2(vx + gx, vz + gz, 31);
      if (Math.abs(gx) === 1 && Math.abs(gz) === 1 && h % 3 === 0) continue;
      out.push({
        x: cx + gx * step,
        y: baseY,
        z: cz + gz * step,
        sx: step,
        sy: step,
        sz: step,
        color: greens[h % greens.length],
      });
    }
  }
  // Layer 1 (mid canopy)
  for (let gx = -1; gx <= 1; gx += 1) {
    for (let gz = -1; gz <= 1; gz += 1) {
      if (Math.abs(gx) === 1 && Math.abs(gz) === 1 && !tall) continue;
      const h = hash2(vx + gx, vz + gz, 53);
      out.push({
        x: cx + gx * step,
        y: baseY + step,
        z: cz + gz * step,
        sx: step,
        sy: step,
        sz: step,
        color: greens[(h + 1) % greens.length],
      });
    }
  }
  // Layer 2 (stepped crown cross)
  const crownOffsets: [number, number][] = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [gx, gz] of crownOffsets) {
    if (!tall && (gx !== 0 || gz !== 0) && (gx + gz + vx) % 2 === 0) continue;
    const h = hash2(vx + gx, vz + gz, 79);
    out.push({
      x: cx + gx * step,
      y: baseY + step * 2,
      z: cz + gz * step,
      sx: step,
      sy: step,
      sz: step,
      color: greens[(h + 3) % greens.length],
    });
  }
}

function addPlanterHedge(out: VoxelBox[], x: number, z: number, alongZ = false) {
  // Wooden planter box with crisp two-tone dark-green & pale-stone hedge cubes (reference style).
  const w = alongZ ? 0.62 : 1.18;
  const d = alongZ ? 1.18 : 0.62;
  out.push({ x, y: 0.13, z, sx: w, sy: 0.26, sz: d, color: "#a67546" });
  const off = 0.27;
  const dx = alongZ ? 0 : off;
  const dz = alongZ ? off : 0;
  // Two dark green hedge cubes + slim pale accent strip on top-back.
  out.push({ x: x - dx, y: 0.48, z: z - dz, sx: 0.48, sy: 0.46, sz: 0.48, color: "#21453b" });
  out.push({ x: x + dx, y: 0.48, z: z + dz, sx: 0.48, sy: 0.46, sz: 0.48, color: "#295448" });
  out.push({ x: x - dx, y: 0.72, z: z - dz - 0.1, sx: 0.46, sy: 0.08, sz: 0.24, color: "#ece9e2" });
  out.push({ x: x + dx, y: 0.72, z: z + dz - 0.1, sx: 0.46, sy: 0.08, sz: 0.24, color: "#ece9e2" });
}

function addBench(out: VoxelBox[], x: number, z: number, facingSouth: boolean) {
  // Warm wooden park bench by the pond.
  out.push({ x: x - 0.58, y: 0.16, z, sx: 0.16, sy: 0.32, sz: 0.46, color: "#6d4a2d" });
  out.push({ x: x + 0.58, y: 0.16, z, sx: 0.16, sy: 0.32, sz: 0.46, color: "#6d4a2d" });
  out.push({ x, y: 0.36, z, sx: 1.56, sy: 0.12, sz: 0.52, color: "#b68352" });
  const backZ = z + (facingSouth ? -0.22 : 0.22);
  out.push({ x, y: 0.62, z: backZ, sx: 1.56, sy: 0.28, sz: 0.1, color: "#a57345" });
}

function addGrassTuft(out: VoxelBox[], x: number, z: number) {
  out.push({ x: x - 0.11, y: 0.15, z: z - 0.04, sx: 0.07, sy: 0.3, sz: 0.07, color: "#429e37" });
  out.push({ x: x, y: 0.19, z: z + 0.05, sx: 0.07, sy: 0.38, sz: 0.07, color: "#54b445" });
  out.push({ x: x + 0.11, y: 0.14, z: z - 0.02, sx: 0.07, sy: 0.28, sz: 0.07, color: "#3d9233" });
}

export type StaticIslandVoxels = {
  matte: VoxelBox[];
  water: VoxelBox[];
};

/** Builds all static terrain, pond, paths, trees, planters, benches, and grass tufts for an island size. */
export function buildStaticIslandVoxels(width: number, depth: number, rows: number): StaticIslandVoxels {
  const matte: VoxelBox[] = [];
  const water: VoxelBox[] = [];

  const grassA = "#a8d46f";
  const grassB = "#b8de80";
  const dirts = ["#a8815b", "#9b7551", "#b28a63", "#906c4a"];

  // 1. Floating island terrain blocks (checker grass top + speckled dirt + stepped bottom edge + stone strata).
  for (let vx = 0; vx < width; vx += 1) {
    for (let vz = 0; vz < depth; vz += 1) {
      if (!isIslandTile(vx, vz, width, depth)) continue;
      const cx = vx + 0.5;
      const cz = vz + 0.5;
      const pond = isPondTile(vx, vz);
      const edge =
        !isIslandTile(vx - 1, vz, width, depth) ||
        !isIslandTile(vx + 1, vz, width, depth) ||
        !isIslandTile(vx, vz - 1, width, depth) ||
        !isIslandTile(vx, vz + 1, width, depth);

      // Grass cap (omitted inside the recessed pond).
      if (!pond) {
        const checker = (vx + vz) % 2 === 0 ? grassA : grassB;
        matte.push({ x: cx, y: -0.18, z: cz, sx: 1.0, sy: 0.36, sz: 1.0, color: checker });
      } else {
        // Recessed teal pond basin + glossy pale-cyan tiles with crisp grid seams.
        matte.push({ x: cx, y: -0.25, z: cz, sx: 1.0, sy: 0.22, sz: 1.0, color: "#6eaab2" });
        const waterShade = (vx + vz) % 2 === 0 ? "#9be0e6" : "#a8e7ec";
        water.push({ x: cx, y: -0.09, z: cz, sx: 0.94, sy: 0.1, sz: 0.94, color: waterShade });
      }

      // Dirt body: cohesive stepped skirt on the outer edge; solid support interior.
      if (edge) {
        const h = hash2(vx, vz, 11);
        const dropLevels = [1.65, 1.9, 2.1, 2.35];
        const dirtDepth = dropLevels[h % dropLevels.length];
        const dirtTop = -0.36;
        matte.push({
          x: cx,
          y: dirtTop - dirtDepth / 2,
          z: cz,
          sx: 1.0,
          sy: dirtDepth,
          sz: 1.0,
          color: dirts[h % dirts.length],
        });

        // Pale stone strata dashes along the visible front (+Z) and right (+X) dirt faces.
        if (!isIslandTile(vx, vz + 1, width, depth) && vx % 4 === 1 && dirtDepth >= 1.85) {
          matte.push({ x: cx + 0.2, y: -1.48, z: vz + 1.015, sx: 1.45, sy: 0.22, sz: 0.06, color: "#e3ddd1" });
        }
        if (!isIslandTile(vx + 1, vz, width, depth) && vz % 4 === 2 && dirtDepth >= 1.85) {
          matte.push({ x: vx + 1.015, y: -1.48, z: cz + 0.2, sx: 0.06, sy: 0.22, sz: 1.45, color: "#d8d1c4" });
        }
      } else {
        // Inner dirt support slab (keeps underside solid with minimal instances).
        matte.push({
          x: cx,
          y: -1.05,
          z: cz,
          sx: 1.0,
          sy: 1.38,
          sz: 1.0,
          color: dirts[0],
        });
      }
    }
  }

  // 2. Paved plot slabs (4×4 crisp stone tiles) and front entrance steps.
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < PLOT_COLS; c += 1) {
      const origin = plotOrigin(r * PLOT_COLS + c);
      const minX = origin.center.x - PLOT_SIZE / 2;
      const minZ = origin.center.z - PLOT_SIZE / 2;
      // Subtle grout base.
      matte.push({
        x: origin.center.x,
        y: 0.05,
        z: origin.center.z,
        sx: PLOT_SIZE + 0.06,
        sy: 0.1,
        sz: PLOT_SIZE + 0.06,
        color: "#cfc9be",
      });
      for (let dx = 0; dx < PLOT_SIZE; dx += 1) {
        for (let dz = 0; dz < PLOT_SIZE; dz += 1) {
          const tileColor = (dx + dz) % 2 === 0 ? "#eae7e0" : "#e3dfd7";
          matte.push({
            x: minX + dx + 0.5,
            y: 0.09,
            z: minZ + dz + 0.5,
            sx: 0.94,
            sy: 0.1,
            sz: 0.94,
            color: tileColor,
          });
        }
      }
      // Front entrance landing + step (2 tiles wide along +Z).
      const stepZ = minZ + PLOT_SIZE;
      matte.push({ x: origin.center.x - 0.5, y: 0.06, z: stepZ + 0.5, sx: 0.94, sy: 0.09, sz: 0.94, color: "#efece5" });
      matte.push({ x: origin.center.x + 0.5, y: 0.06, z: stepZ + 0.5, sx: 0.94, sy: 0.09, sz: 0.94, color: "#e6e2da" });
    }
  }

  // 3. Stepping-stone walkway linking the plot rows to the pond plaza.
  for (let vx = 18; vx <= 19; vx += 1) {
    matte.push({ x: vx + 0.5, y: 0.04, z: 7.5, sx: 0.88, sy: 0.07, sz: 0.88, color: "#e6e2da" });
    matte.push({ x: vx + 0.5, y: 0.04, z: 8.5, sx: 0.88, sy: 0.07, sz: 0.88, color: "#ece9e2" });
  }

  // 4. Waiting plaza benches (north & south of pond) and planters.
  addBench(matte, 20.8, 4.15, true);
  addBench(matte, 23.2, 4.15, true);
  addBench(matte, 20.8, 11.85, false);
  addBench(matte, 23.2, 11.85, false);

  addPlanterHedge(matte, 18.5, 5.2, false);
  addPlanterHedge(matte, 18.5, 10.8, false);
  addPlanterHedge(matte, 7.0, 6.5, false);
  addPlanterHedge(matte, 13.0, 6.5, false);
  if (rows >= 2) {
    addPlanterHedge(matte, 7.0, 14.5, false);
    addPlanterHedge(matte, 13.0, 14.5, false);
  }

  // 5. Voxel trees around the perimeter (never blocking plots, pond, or waiting spots).
  const treeCoords: [number, number, boolean][] = [
    [0, 1, true],
    [7, 0, false],
    [13, 0, true],
    [19, 1, false],
    [25, 2, true],
    [25, 14, false],
    [0, 8, false],
  ];
  for (let r = 1; r < rows; r += 1) {
    const tz = 5 + r * 8;
    if (tz < depth - 2) {
      treeCoords.push([0, tz, r % 2 === 1]);
      if (r >= 2) treeCoords.push([25, tz, r % 2 === 0]);
    }
  }
  const treeSet = new Set<string>();
  for (const [tx, tz, tall] of treeCoords) {
    if (!isIslandTile(tx, tz, width, depth)) continue;
    addVoxelTree(matte, tx, tz, tall);
    treeSet.add(`${tx},${tz}`);
  }

  // 6. Small green grass tufts scattered deterministically on open perimeter grass tiles.
  for (let vx = 1; vx < width - 1; vx += 1) {
    for (let vz = 1; vz < depth - 1; vz += 1) {
      if (!isIslandTile(vx, vz, width, depth)) continue;
      if (isPondTile(vx, vz) || isPlotTile(vx, vz, rows) || isPlotStepTile(vx, vz, rows)) continue;
      if (vx >= 18 && vx <= 25 && vz >= 4 && vz <= 12) continue; // keep plaza clear
      if (treeSet.has(`${vx},${vz}`)) continue;
      const h = hash2(vx, vz, 97);
      if (h % 13 === 0) {
        addGrassTuft(matte, vx + 0.35 + ((h % 3) * 0.12), vz + 0.35 + (((h >>> 3) % 3) * 0.12));
      }
    }
  }

  return { matte, water };
}

/** Resolve the active build stage for a placement, supporting looping animation when `loopBuild` is true. */
export function resolveBuildStage(placement: IslandPlacement, elapsedSec: number, animated: boolean): BuildStage {
  if (!placement.loopBuild || !animated) return placement.buildStage;
  const cycle = ((elapsedSec + placement.seat * 1.45) % 8.0) / 8.0;
  if (cycle < 0.1) return "slab";
  if (cycle < 0.28) return "foundation";
  if (cycle < 0.56) return "walls";
  if (cycle < 0.78) return "roof";
  return "trim";
}

export type DynamicPlotVoxels = {
  matte: VoxelBox[];
  glass: VoxelBox[];
};

/**
 * Generates voxel boxes for one agent's building at its plot.
 * Original architecture in the reference's crisp dark-green + teal-glass + bright-roof + accent-stripe style.
 */
export function appendBuildingVoxels(
  target: DynamicPlotVoxels,
  placement: IslandPlacement,
  stage: BuildStage,
  elapsedSec: number,
  animated: boolean,
) {
  if (stage === "slab") return;

  const { x: cx, z: cz } = placement.plot.center;
  const dim = placement.dimmed;
  const plinth = maybeDimHex("#e6e2da", dim);
  const wallA = maybeDimHex("#1b3f37", dim);
  const wallB = maybeDimHex("#245247", dim);
  const wallTrim = maybeDimHex("#17342e", dim);
  const glassA = maybeDimHex("#49a88e", dim);
  const glassB = maybeDimHex("#5ec2a6", dim);
  const roofGreen = maybeDimHex("#52c66b", dim);
  const skylight = maybeDimHex("#67cfb3", dim);
  const accent = maybeDimHex(placement.accentColor, dim);
  const damageRed = maybeDimHex("#d9534f", dim);
  const damageDark = maybeDimHex("#a63c3a", dim);

  const u = 0.5; // sub-voxel unit: 8×8 grid over the 4×4 plot
  const baseY = 0.14;
  const minX = cx - PLOT_SIZE / 2;
  const minZ = cz - PLOT_SIZE / 2;

  const putMatte = (gx: number, gy: number, gz: number, color: string, sy = u, sx = u, sz = u) => {
    target.matte.push({
      x: minX + (gx + 0.5) * u,
      y: baseY + 0.18 + gy * u + sy / 2,
      z: minZ + (gz + 0.5) * u,
      sx,
      sy,
      sz,
      color,
    });
  };
  const putGlass = (gx: number, gy: number, gz: number, color: string) => {
    target.glass.push({
      x: minX + (gx + 0.5) * u,
      y: baseY + 0.18 + gy * u + u / 2,
      z: minZ + (gz + 0.5) * u,
      sx: u * 0.96,
      sy: u,
      sz: u * 0.96,
      color,
    });
  };

  // Raised stone plinth under the walls.
  target.matte.push({ x: cx, y: baseY + 0.09, z: cz, sx: 3.96, sy: 0.18, sz: 3.96, color: plinth });

  const isDoor = (gx: number, gz: number) => gz === 7 && (gx === 3 || gx === 4);
  const isFrontWindow = (gx: number, gz: number) => gz === 7 && (gx === 1 || gx === 6);
  const isSideWindow = (gx: number, gz: number) => (gx === 0 || gx === 7) && gz >= 2 && gz <= 5;
  const isBackWindow = (gx: number, gz: number) => gz === 0 && (gx === 2 || gx === 3 || gx === 4 || gx === 5);
  const isPerimeter = (gx: number, gz: number) => gx === 0 || gx === 7 || gz === 0 || gz === 7;

  if (stage === "damaged") {
    // Error state: cracked partial walls, missing top corner, red warning blocks, fallen rubble, rising smoke cubes.
    for (let gy = 0; gy < 3; gy += 1) {
      for (let gx = 0; gx < 8; gx += 1) {
        for (let gz = 0; gz < 8; gz += 1) {
          if (!isPerimeter(gx, gz)) continue;
          if (isDoor(gx, gz) && gy < 2) continue;
          // Knock out a ragged chunk on the front-right upper corner.
          if (gy === 2 && gx >= 4 && gz >= 4) continue;
          if (gy === 1 && gx === 7 && gz === 6) continue;
          const isRed = (gx === 6 && gz === 7 && gy === 1) || (gx === 7 && gz === 4 && gy === 2) || (gx === 2 && gz === 7 && gy === 2);
          const color = isRed ? (gy === 2 ? damageRed : damageDark) : (gx + gy + gz) % 2 === 0 ? wallA : wallB;
          putMatte(gx, gy, gz, color);
        }
      }
    }
    // Knocked-off rubble blocks on the slab/apron.
    target.matte.push({ x: cx + 1.35, y: baseY + 0.36, z: cz + 1.55, sx: 0.44, sy: 0.44, sz: 0.44, color: damageRed, ry: 0.35 });
    target.matte.push({ x: cx + 0.85, y: baseY + 0.28, z: cz + 2.2, sx: 0.38, sy: 0.38, sz: 0.38, color: wallB, ry: -0.4 });

    // Rising grey smoke-puff cubes.
    const smokeBaseY = baseY + 2.05;
    const t = animated ? elapsedSec : 0.35;
    const puffs = [
      { ox: 0.55, oz: 0.45, phase: 0, s: 0.62, color: "#b6bac2" },
      { ox: 0.15, oz: -0.15, phase: 0.33, s: 0.54, color: "#cacdd4" },
      { ox: 0.78, oz: 0.15, phase: 0.66, s: 0.44, color: "#dcdfe5" },
    ];
    for (const puff of puffs) {
      const f = (t * 0.42 + puff.phase) % 1;
      const scale = puff.s * (0.78 + Math.sin(f * Math.PI) * 0.42);
      target.matte.push({
        x: cx + puff.ox + Math.sin(f * Math.PI * 2) * 0.16,
        y: smokeBaseY + f * 1.65,
        z: cz + puff.oz - f * 0.22,
        sx: scale,
        sy: scale,
        sz: scale,
        color: puff.color,
      });
    }
    return;
  }

  // Layer 0 (foundation course, always present for foundation..complete).
  for (let gx = 0; gx < 8; gx += 1) {
    for (let gz = 0; gz < 8; gz += 1) {
      if (!isPerimeter(gx, gz)) continue;
      if (isDoor(gx, gz)) continue;
      putMatte(gx, 0, gz, (gx + gz) % 2 === 0 ? wallA : wallB);
    }
  }
  if (stage === "foundation") {
    // Corner piers rising slightly so the foundation clearly reads as active construction.
    for (const [gx, gz] of [[0, 0], [7, 0], [0, 7], [7, 7]]) {
      putMatte(gx, 1, gz, wallB);
    }
    return;
  }

  // Layers 1..3 (walls + teal glass windows + doorway lintel).
  const wallHeight = stage === "walls" ? 3 : 4;
  for (let gy = 1; gy < wallHeight; gy += 1) {
    for (let gx = 0; gx < 8; gx += 1) {
      for (let gz = 0; gz < 8; gz += 1) {
        if (!isPerimeter(gx, gz)) continue;
        if (isDoor(gx, gz) && gy < 3) continue;
        // For "walls" stage, leave a stepped incomplete top edge on layer 2 so it looks mid-build.
        if (stage === "walls" && gy === 2 && (gx + gz) % 3 === 0) continue;

        const windowCell = (gy === 1 || gy === 2) && (isFrontWindow(gx, gz) || isSideWindow(gx, gz) || isBackWindow(gx, gz));
        if (windowCell) {
          putGlass(gx, gy, gz, (gx + gy + gz) % 2 === 0 ? glassA : glassB);
        } else if (isDoor(gx, gz) && gy === 3) {
          // Door lintel in agent's accent colour.
          putMatte(gx, gy, gz, accent);
        } else {
          putMatte(gx, gy, gz, (gx + gy + gz) % 2 === 0 ? wallA : wallB);
        }
      }
    }
  }
  if (stage === "walls") return;

  // Stage "roof": bright green roof slab sitting cleanly atop the 4 wall courses.
  const roofY = baseY + 0.18 + 4 * u;
  if (stage === "roof") {
    target.matte.push({ x: cx, y: roofY + 0.16, z: cz, sx: 4.02, sy: 0.32, sz: 4.02, color: roofGreen });
    return;
  }

  // Stages "trim" & "complete": dark roof deck, per-agent accent stripe, parapet trim, and teal skylight lantern.
  // Accent band wrapping the upper facade.
  target.matte.push({ x: cx, y: roofY + 0.11, z: cz, sx: 4.08, sy: 0.22, sz: 4.08, color: accent });
  // Dark slate roof slab.
  target.matte.push({ x: cx, y: roofY + 0.34, z: cz, sx: 4.0, sy: 0.24, sz: 4.0, color: wallTrim });
  // Low parapet ledges around roof perimeter.
  target.matte.push({ x: cx, y: roofY + 0.54, z: minZ + 0.2, sx: 3.98, sy: 0.18, sz: 0.36, color: wallB });
  target.matte.push({ x: cx, y: roofY + 0.54, z: minZ + 3.8, sx: 3.98, sy: 0.18, sz: 0.36, color: wallB });
  target.matte.push({ x: minX + 0.2, y: roofY + 0.54, z: cz, sx: 0.36, sy: 0.18, sz: 3.28, color: wallA });
  target.matte.push({ x: minX + 3.8, y: roofY + 0.54, z: cz, sx: 0.36, sy: 0.18, sz: 3.28, color: wallA });
  // Central raised skylight lantern with slim accent rim.
  target.matte.push({ x: cx, y: roofY + 0.54, z: cz, sx: 2.35, sy: 0.14, sz: 1.55, color: accent });
  target.glass.push({ x: cx, y: roofY + 0.69, z: cz, sx: 2.2, sy: 0.22, sz: 1.4, color: skylight });

  // Stage "complete" (done): roof flagpole & waving accent pennant.
  if (stage === "complete") {
    const poleX = minX + 3.45;
    const poleZ = minZ + 3.45;
    const poleBase = roofY + 0.62;
    target.matte.push({ x: poleX, y: poleBase + 0.65, z: poleZ, sx: 0.1, sy: 1.3, sz: 0.1, color: "#ece9e2" });
    const wave = animated ? Math.sin(elapsedSec * 5.2 + placement.seat) * 0.08 : 0;
    target.matte.push({ x: poleX + 0.34, y: poleBase + 1.08 + wave * 0.4, z: poleZ, sx: 0.56, sy: 0.36, sz: 0.08, color: accent, ry: wave });
    target.matte.push({ x: poleX + 0.68, y: poleBase + 1.06 - wave * 0.5, z: poleZ + wave * 0.25, sx: 0.3, sy: 0.28, sz: 0.08, color: accent, ry: wave * 1.4 });
  }
}

/** Populate an InstancedMesh from an array of VoxelBox descriptors. */
export function fillInstancedMesh(mesh: THREE.InstancedMesh, boxes: readonly VoxelBox[]) {
  mesh.count = boxes.length;
  for (let i = 0; i < boxes.length; i += 1) {
    const b = boxes[i];
    TEMP_OBJ.position.set(b.x, b.y, b.z);
    TEMP_OBJ.rotation.set(b.rx ?? 0, b.ry ?? 0, b.rz ?? 0);
    TEMP_OBJ.scale.set(b.sx, b.sy, b.sz);
    TEMP_OBJ.updateMatrix();
    mesh.setMatrixAt(i, TEMP_OBJ.matrix);
    TEMP_COLOR.set(b.color);
    mesh.setColorAt(i, TEMP_COLOR);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}

export type WorkerRig = {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  mallet: THREE.Mesh;
  materials: THREE.MeshStandardMaterial[];
  paletteSignature: string;
};

/** Build a Minecraft-proportion blocky voxel worker rig sharing a unit BoxGeometry. */
export function createWorkerRig(
  unitBox: THREE.BoxGeometry,
  palette: Palette,
  dimmed: boolean,
): WorkerRig {
  const mkMat = (hex: string) =>
    new THREE.MeshStandardMaterial({
      color: maybeDimHex(hex, dimmed),
      roughness: 0.88,
      metalness: 0,
    });

  const skinMat = mkMat(palette.skin);
  const hairMat = mkMat(palette.hair);
  const shirtMat = mkMat(palette.shirt);
  const pantsMat = mkMat(palette.pants);
  const shoeMat = mkMat("#292736");
  const eyeMat = mkMat("#1a1824");
  const toolMat = mkMat("#3b4952");
  const materials = [skinMat, hairMat, shirtMat, pantsMat, shoeMat, eyeMat, toolMat];

  const box = (mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(unitBox, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  const root = new THREE.Group();
  root.scale.setScalar(1.14);
  const body = new THREE.Group();
  root.add(body);

  // Legs pivoted at hip (y = 0.44)
  const leftLeg = new THREE.Group();
  leftLeg.position.set(-0.12, 0.44, 0);
  leftLeg.add(box(pantsMat, 0.19, 0.34, 0.2, 0, -0.17, 0));
  leftLeg.add(box(shoeMat, 0.2, 0.1, 0.24, 0, -0.39, 0.02));
  body.add(leftLeg);

  const rightLeg = new THREE.Group();
  rightLeg.position.set(0.12, 0.44, 0);
  rightLeg.add(box(pantsMat, 0.19, 0.34, 0.2, 0, -0.17, 0));
  rightLeg.add(box(shoeMat, 0.2, 0.1, 0.24, 0, -0.39, 0.02));
  body.add(rightLeg);

  // Torso (y = 0.44..0.94)
  body.add(box(shirtMat, 0.46, 0.5, 0.26, 0, 0.69, 0));

  // Left arm pivoted at shoulder (y = 0.90)
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.31, 0.9, 0);
  leftArm.add(box(shirtMat, 0.16, 0.24, 0.16, 0, -0.12, 0));
  leftArm.add(box(skinMat, 0.15, 0.2, 0.15, 0, -0.34, 0));
  body.add(leftArm);

  // Right arm pivoted at shoulder (y = 0.90) + voxel mallet/block for working pose
  const rightArm = new THREE.Group();
  rightArm.position.set(0.31, 0.9, 0);
  rightArm.add(box(shirtMat, 0.16, 0.24, 0.16, 0, -0.12, 0));
  rightArm.add(box(skinMat, 0.15, 0.2, 0.15, 0, -0.34, 0));
  const mallet = box(toolMat, 0.18, 0.18, 0.26, 0, -0.42, 0.14);
  mallet.visible = false;
  rightArm.add(mallet);
  body.add(rightArm);

  // Head pivoted at neck (y = 0.94)
  const head = new THREE.Group();
  head.position.set(0, 0.94, 0);
  head.add(box(skinMat, 0.48, 0.46, 0.46, 0, 0.23, 0));
  // Hair cap & back/side trim (blocky Minecraft hair)
  head.add(box(hairMat, 0.52, 0.15, 0.52, 0, 0.44, 0));
  head.add(box(hairMat, 0.52, 0.24, 0.14, 0, 0.28, -0.2));
  head.add(box(hairMat, 0.12, 0.14, 0.52, -0.21, 0.34, 0));
  head.add(box(hairMat, 0.12, 0.14, 0.52, 0.21, 0.34, 0));
  // Eyes on +Z face
  head.add(box(eyeMat, 0.07, 0.08, 0.04, -0.11, 0.22, 0.23));
  head.add(box(eyeMat, 0.07, 0.08, 0.04, 0.11, 0.22, 0.23));
  body.add(head);

  return {
    root,
    body,
    head,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    mallet,
    materials,
    paletteSignature: `${palette.skin}|${palette.hair}|${palette.shirt}|${palette.pants}|${dimmed ? 1 : 0}`,
  };
}

export function disposeWorkerRig(rig: WorkerRig) {
  for (const m of rig.materials) m.dispose();
}

export { ISLAND_WIDTH };
