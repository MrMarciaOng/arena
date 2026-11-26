import * as THREE from "three";
import {
  ISO_DIR,
  islandCenterPoint,
  islandViewBox,
  VIEW_PADDING,
  type IslandLayout,
  type IslandPlacement,
  type Vec3,
} from "./layout";
import {
  appendBuildingVoxels,
  buildStaticIslandVoxels,
  createVoxelGrainTexture,
  createWorkerRig,
  disposeWorkerRig,
  fillInstancedMesh,
  resolveBuildStage,
  type DynamicPlotVoxels,
  type VoxelBox,
  type WorkerRig,
} from "./voxelBuilder";

export const ISLAND_BACKDROP = "#eeebe5";
const WALK_DURATION_SEC = 0.9;
/** The animation loop runs at 30 fps: smooth enough for voxel workers, half the GPU time of 60. */
const FRAME_MS = 1000 / 30;
/** Flags, smoke and looping builds step at 8 fps instead of rebuilding their voxels every frame. */
const BUILDING_STEP_MS = 125;
/** Most device pixels a canvas may draw (large islands render slightly softer instead of huge). */
const PIXEL_BUDGET = 4_000_000;
const ISO_VEC = new THREE.Vector3(ISO_DIR.x, ISO_DIR.y, ISO_DIR.z);
const POND_CENTER_X = 22;
const POND_CENTER_Z = 8;

export type ProjectedAgent = {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  walking: boolean;
};

export type ProjectedLabel = {
  seat: number;
  x: number;
  y: number;
};

export type ProjectionSnapshot = {
  agents: ProjectedAgent[];
  hiddenLabels: ProjectedLabel[];
};

type WorkerRuntime = {
  rig: WorkerRig;
  current: Vec3;
  from: Vec3;
  target: Vec3;
  walkT: number; // 1 = arrived
  walking: boolean;
  placement: IslandPlacement;
};

export type IslandEngineOptions = {
  container: HTMLElement;
  interactive: boolean;
  reducedMotion: boolean;
  onProject: (snapshot: ProjectionSnapshot) => void;
  onWalkingChange: (walkingKeys: ReadonlySet<string>) => void;
  onContextLost: () => void;
};

function createRenderer(): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Shadows are redrawn only when something casting one moves (see shadowDirty).
  renderer.shadowMap.autoUpdate = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  return renderer;
}

type SharedRenderer = { renderer: THREE.WebGLRenderer; users: number; lost: boolean };
let sharedRenderer: SharedRenderer | null = null;

/**
 * Overview thumbnails share one WebGL context and copy each frame into their own 2D canvas, so
 * eight arenas don't hold eight contexts (browsers cap them, mobile ones lower than desktop).
 */
function acquireSharedRenderer(): SharedRenderer {
  if (!sharedRenderer || sharedRenderer.lost) {
    const entry: SharedRenderer = { renderer: createRenderer(), users: 0, lost: false };
    entry.renderer.domElement.addEventListener("webglcontextlost", () => {
      entry.lost = true;
    });
    sharedRenderer = entry;
  }
  sharedRenderer.users += 1;
  return sharedRenderer;
}

function releaseSharedRenderer(entry: SharedRenderer) {
  entry.users -= 1;
  if (entry.users > 0) return;
  if (sharedRenderer === entry) sharedRenderer = null;
  entry.renderer.dispose();
  entry.renderer.forceContextLoss();
}

export class IslandEngine {
  private readonly renderer: THREE.WebGLRenderer;
  /** Set for thumbnails, which draw with the shared renderer. */
  private readonly shared: SharedRenderer | null;
  /** The canvas on the page: the renderer's own, or a 2D copy target for thumbnails. */
  private readonly output: HTMLCanvasElement;
  private readonly output2d: CanvasRenderingContext2D | null;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly unitBox: THREE.BoxGeometry;
  private readonly grainTexture: THREE.CanvasTexture | null;
  private readonly matteMat: THREE.MeshStandardMaterial;
  private readonly waterMat: THREE.MeshStandardMaterial;
  private readonly glassMat: THREE.MeshStandardMaterial;
  private readonly shadowMat: THREE.ShadowMaterial;
  private readonly shadowPlane: THREE.Mesh;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly selectionRing: THREE.Group;
  private readonly selectionRingMats: THREE.MeshBasicMaterial[];

  private staticMatteMesh: THREE.InstancedMesh | null = null;
  private staticWaterMesh: THREE.InstancedMesh | null = null;
  private buildingMatteMesh: THREE.InstancedMesh | null = null;
  private buildingGlassMesh: THREE.InstancedMesh | null = null;

  private readonly workers = new Map<string, WorkerRuntime>();
  private layout: IslandLayout | null = null;
  private staticKey = "";
  private selectedKey: string | null = null;
  private reducedMotion: boolean;
  private interactive: boolean;
  private visible = true;
  private rafId: number | null = null;
  private lastTimeMs = 0;
  private lastBuildingStepMs = 0;
  private elapsedSec = 0;
  private widthPx = 480;
  private heightPx = 284;
  private pixelRatio = 1;
  /** null until the first emit, so a new engine always clears walking state left by an old one. */
  private lastWalkingSignature: string | null = null;
  private overlayDirty = true;
  private shadowDirty = true;
  private disposed = false;
  /** Set on webglcontextlost: the component shows its fallback, so stop drawing until disposed. */
  private contextLost = false;

  private readonly onProject: (snapshot: ProjectionSnapshot) => void;
  private readonly onWalkingChange: (walkingKeys: ReadonlySet<string>) => void;
  private readonly handleContextLost: (event: Event) => void;
  private readonly projVec = new THREE.Vector3();
  private readonly headVec = new THREE.Vector3();
  private readonly sizeVec = new THREE.Vector2();

  constructor(options: IslandEngineOptions) {
    this.interactive = options.interactive;
    this.reducedMotion = options.reducedMotion;
    this.onProject = options.onProject;
    this.onWalkingChange = options.onWalkingChange;

    if (options.interactive) {
      this.shared = null;
      this.renderer = createRenderer();
      this.output = this.renderer.domElement;
      this.output2d = null;
    } else {
      this.output = document.createElement("canvas");
      const ctx = this.output.getContext("2d");
      if (!ctx) throw new Error("2D canvas unavailable");
      this.output2d = ctx;
      this.shared = acquireSharedRenderer();
      this.renderer = this.shared.renderer;
    }

    this.output.setAttribute("aria-hidden", "true");
    this.output.className = "block h-full w-full";
    options.container.appendChild(this.output);

    this.handleContextLost = (event: Event) => {
      event.preventDefault();
      this.contextLost = true;
      this.stopLoop();
      options.onContextLost();
    };
    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(ISLAND_BACKDROP);

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 220);

    // Soft top-left key light + warm hemisphere bounce + subtle cool fill (reference diorama lighting).
    const hemi = new THREE.HemisphereLight(0xfffdf8, 0xd6cdb9, 1.42);
    this.scene.add(hemi);

    this.keyLight = new THREE.DirectionalLight(0xfff8ec, 1.48);
    this.keyLight.castShadow = true;
    const shadowRes = options.interactive ? 2048 : 1024;
    this.keyLight.shadow.mapSize.set(shadowRes, shadowRes);
    this.keyLight.shadow.bias = -0.0006;
    this.keyLight.shadow.normalBias = 0.03;
    this.keyLight.shadow.radius = 2.5;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    const fillLight = new THREE.DirectionalLight(0xdce8f4, 0.34);
    fillLight.position.set(18, 12, -16);
    this.scene.add(fillLight);

    this.unitBox = new THREE.BoxGeometry(1, 1, 1);
    this.grainTexture = createVoxelGrainTexture();

    this.matteMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0,
      map: this.grainTexture ?? undefined,
    });
    this.waterMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.05,
    });
    this.glassMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.36,
      metalness: 0.06,
    });

    // Shadow catcher below the deepest dirt voxel; sized to the island in rebuildStaticIsland.
    this.shadowMat = new THREE.ShadowMaterial({ color: 0x3b3328, opacity: 0.14 });
    this.shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shadowMat);
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = -2.95;
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);

    // Subtle crisp selection square beneath the selected worker.
    this.selectionRing = new THREE.Group();
    this.selectionRing.visible = false;
    const outerMat = new THREE.MeshBasicMaterial({ color: 0x17202c });
    const innerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.selectionRingMats = [outerMat, innerMat];
    const bar = (mat: THREE.Material, sx: number, sz: number, x: number, z: number, y: number) => {
      const m = new THREE.Mesh(this.unitBox, mat);
      m.scale.set(sx, 0.04, sz);
      m.position.set(x, y, z);
      return m;
    };
    const r = 0.56;
    const t = 0.09;
    this.selectionRing.add(
      bar(outerMat, r * 2 + t, t, 0, -r, 0.03),
      bar(outerMat, r * 2 + t, t, 0, r, 0.03),
      bar(outerMat, t, r * 2 + t, -r, 0, 0.03),
      bar(outerMat, t, r * 2 + t, r, 0, 0.03),
      bar(innerMat, r * 2 - 0.12, 0.04, 0, -(r - 0.06), 0.04),
      bar(innerMat, r * 2 - 0.12, 0.04, 0, r - 0.06, 0.04),
      bar(innerMat, 0.04, r * 2 - 0.12, -(r - 0.06), 0, 0.04),
      bar(innerMat, 0.04, r * 2 - 0.12, r - 0.06, 0, 0.04),
    );
    this.scene.add(this.selectionRing);
  }

  resize(widthPx: number, heightPx: number) {
    if (this.disposed) return;
    const w = Math.max(1, Math.round(widthPx));
    const h = Math.max(1, Math.round(heightPx));
    this.widthPx = w;
    this.heightPx = h;
    // Re-read on every resize, so moving the window to a screen with another density follows it.
    this.pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      this.interactive ? 2 : 1.5,
      Math.sqrt(PIXEL_BUDGET / (w * h)),
    );
    if (this.shared) {
      this.output.width = Math.round(w * this.pixelRatio);
      this.output.height = Math.round(h * this.pixelRatio);
    } else {
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.setSize(w, h, false);
    }
    this.fitCamera();
    this.overlayDirty = true;
    this.renderOnce();
  }

  setReducedMotion(reducedMotion: boolean) {
    if (this.disposed || this.reducedMotion === reducedMotion) return;
    this.reducedMotion = reducedMotion;
    if (reducedMotion) {
      for (const worker of this.workers.values()) {
        worker.current = { ...worker.target };
        worker.walkT = 1;
        worker.walking = false;
      }
      this.emitWalkingState();
    }
    this.syncLoop();
    this.settle();
  }

  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.syncLoop();
    if (visible) this.settle();
  }

  update(layout: IslandLayout, selectedKey: string | null) {
    if (this.disposed) return;
    this.layout = layout;
    this.selectedKey = selectedKey;

    const nextStaticKey = `${layout.width}x${layout.depth}x${layout.rows}`;
    if (nextStaticKey !== this.staticKey) {
      this.staticKey = nextStaticKey;
      this.rebuildStaticIsland(layout.width, layout.depth, layout.rows);
      this.fitCamera();
    }

    this.syncWorkers(layout.placements);
    this.overlayDirty = true;
    this.shadowDirty = true;
    this.settle();
    this.syncLoop();
  }

  /** Redraw everything for the current state, without advancing animation time. */
  private settle() {
    this.rebuildBuildings();
    this.updateWorkers(0);
    this.renderOnce();
  }

  private rebuildStaticIsland(width: number, depth: number, rows: number) {
    if (this.staticMatteMesh) {
      this.scene.remove(this.staticMatteMesh);
      this.staticMatteMesh.dispose();
      this.staticMatteMesh = null;
    }
    if (this.staticWaterMesh) {
      this.scene.remove(this.staticWaterMesh);
      this.staticWaterMesh.dispose();
      this.staticWaterMesh = null;
    }

    const voxels = buildStaticIslandVoxels(width, depth, rows);
    this.staticMatteMesh = new THREE.InstancedMesh(this.unitBox, this.matteMat, Math.max(1, voxels.matte.length));
    this.staticMatteMesh.castShadow = true;
    this.staticMatteMesh.receiveShadow = true;
    fillInstancedMesh(this.staticMatteMesh, voxels.matte);
    this.scene.add(this.staticMatteMesh);

    this.staticWaterMesh = new THREE.InstancedMesh(this.unitBox, this.waterMat, Math.max(1, voxels.water.length));
    this.staticWaterMesh.receiveShadow = true;
    fillInstancedMesh(this.staticWaterMesh, voxels.water);
    this.scene.add(this.staticWaterMesh);

    const c = islandCenterPoint(width, depth);
    const center = new THREE.Vector3(c.x, c.y, c.z);
    const span = Math.max(width, depth);
    this.shadowPlane.position.set(center.x + 2, -2.95, center.z - 2);
    this.shadowPlane.scale.set(span * 3, span * 3, 1);

    this.keyLight.position.set(center.x - span * 0.82, span * 1.25, center.z + span * 0.65);
    this.keyLight.target.position.copy(center);
    this.keyLight.target.updateMatrixWorld();

    const sBound = span * 0.85;
    this.keyLight.shadow.camera.left = -sBound;
    this.keyLight.shadow.camera.right = sBound;
    this.keyLight.shadow.camera.top = sBound;
    this.keyLight.shadow.camera.bottom = -sBound;
    this.keyLight.shadow.camera.near = 2;
    this.keyLight.shadow.camera.far = span * 4.5;
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.shadowDirty = true;
  }

  private fitCamera() {
    if (!this.layout) return;
    const { width, depth } = this.layout;
    const c = islandCenterPoint(width, depth);
    const center = new THREE.Vector3(c.x, c.y, c.z);
    const dist = Math.max(width, depth) * 2.2;
    this.camera.position.copy(center).addScaledVector(ISO_VEC, dist);
    this.camera.lookAt(center);
    this.camera.updateMatrixWorld();

    // Same framing the component used to size the canvas (islandViewBox is in camera space).
    const box = islandViewBox(width, depth);
    const pad = this.interactive ? VIEW_PADDING.interactive : VIEW_PADDING.thumbnail;
    const boxW = (box.maxU - box.minU) * pad.x;
    const boxH = (box.maxV - box.minV) * pad.y;
    const cx = (box.minU + box.maxU) / 2;
    const cy = (box.minV + box.maxV) / 2;
    const aspect = this.widthPx / this.heightPx;

    let halfW = boxW / 2;
    let halfH = boxH / 2;
    if (halfW / halfH > aspect) {
      halfH = halfW / aspect;
    } else {
      halfW = halfH * aspect;
    }

    this.camera.left = cx - halfW;
    this.camera.right = cx + halfW;
    this.camera.top = cy + halfH;
    this.camera.bottom = cy - halfH;
    this.camera.near = 0.1;
    this.camera.far = dist * 3;
    this.camera.updateProjectionMatrix();
    this.overlayDirty = true;
  }

  private syncWorkers(placements: IslandPlacement[]) {
    const activeKeys = new Set<string>();
    const canAnimate = this.interactive && !this.reducedMotion;

    for (const p of placements) {
      if (p.hidden) continue;
      activeKeys.add(p.key);
      const sig = `${p.palette.skin}|${p.palette.hair}|${p.palette.shirt}|${p.palette.pants}|${p.dimmed ? 1 : 0}`;
      const existing = this.workers.get(p.key);
      if (!existing) {
        const rig = createWorkerRig(this.unitBox, p.palette, p.dimmed);
        this.scene.add(rig.root);
        this.workers.set(p.key, {
          rig,
          current: { ...p.position },
          from: { ...p.position },
          target: { ...p.position },
          walkT: 1,
          walking: false,
          placement: p,
        });
      } else {
        if (existing.rig.paletteSignature !== sig) {
          this.scene.remove(existing.rig.root);
          disposeWorkerRig(existing.rig);
          existing.rig = createWorkerRig(this.unitBox, p.palette, p.dimmed);
          this.scene.add(existing.rig.root);
        }
        const moved =
          Math.abs(existing.target.x - p.position.x) > 0.01 ||
          Math.abs(existing.target.z - p.position.z) > 0.01;
        existing.placement = p;
        if (moved) {
          if (canAnimate) {
            existing.from = { ...existing.current };
            existing.target = { ...p.position };
            existing.walkT = 0;
            existing.walking = true;
          } else {
            existing.from = { ...p.position };
            existing.target = { ...p.position };
            existing.current = { ...p.position };
            existing.walkT = 1;
            existing.walking = false;
          }
        }
      }
    }

    for (const [key, runtime] of this.workers) {
      if (!activeKeys.has(key)) {
        this.scene.remove(runtime.rig.root);
        disposeWorkerRig(runtime.rig);
        this.workers.delete(key);
      }
    }
    this.emitWalkingState();
  }

  /** Whether any plot's voxels change over time (looping builds, smoke, the done flag). */
  private hasTimedBuildings(): boolean {
    return (
      this.layout?.placements.some((p) => p.loopBuild || p.buildStage === "damaged" || p.buildStage === "complete") ??
      false
    );
  }

  private rebuildBuildings() {
    if (!this.layout) return;
    const animated = this.isAnimating();
    const dynamic: DynamicPlotVoxels = { matte: [], glass: [] };
    for (const p of this.layout.placements) {
      const stage = resolveBuildStage(p, this.elapsedSec, animated);
      appendBuildingVoxels(dynamic, p, stage, this.elapsedSec, animated);
    }
    this.buildingMatteMesh = this.fillBuildingMesh(this.buildingMatteMesh, this.matteMat, dynamic.matte);
    this.buildingGlassMesh = this.fillBuildingMesh(this.buildingGlassMesh, this.glassMat, dynamic.glass);
    this.shadowDirty = true;
  }

  /** Reuse a building mesh's instance buffers; reallocate only when they need to grow. */
  private fillBuildingMesh(
    mesh: THREE.InstancedMesh | null,
    material: THREE.Material,
    boxes: readonly VoxelBox[],
  ): THREE.InstancedMesh | null {
    if (!mesh && boxes.length === 0) return null;
    if (!mesh || boxes.length > mesh.instanceMatrix.count) {
      if (mesh) {
        this.scene.remove(mesh);
        mesh.dispose();
      }
      mesh = new THREE.InstancedMesh(this.unitBox, material, Math.max(64, Math.ceil(boxes.length * 1.5)));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    fillInstancedMesh(mesh, boxes);
    return mesh;
  }

  private updateWorkers(dtSec: number) {
    const animated = this.isAnimating();
    let walkingChanged = false;
    let selectedPos: Vec3 | null = null;

    for (const worker of this.workers.values()) {
      const { rig, placement } = worker;
      if (worker.walking && animated) {
        worker.walkT = Math.min(1, worker.walkT + dtSec / WALK_DURATION_SEC);
        const smooth = worker.walkT * worker.walkT * (3 - 2 * worker.walkT);
        worker.current.x = worker.from.x + (worker.target.x - worker.from.x) * smooth;
        worker.current.z = worker.from.z + (worker.target.z - worker.from.z) * smooth;
        this.overlayDirty = true;
        this.shadowDirty = true;
        if (worker.walkT >= 1) {
          worker.walking = false;
          walkingChanged = true;
        }
      }

      const t = animated ? this.elapsedSec + placement.seat * 0.7 : 0;
      const pose = worker.walking ? "walk" : placement.pose;

      // Reset articulated transforms cleanly each tick.
      rig.body.position.set(0, 0, 0);
      rig.body.rotation.set(0, 0, 0);
      rig.head.rotation.set(0, 0, 0);
      rig.leftArm.rotation.set(0, 0, 0);
      rig.rightArm.rotation.set(0, 0, 0);
      rig.leftLeg.rotation.set(0, 0, 0);
      rig.rightLeg.rotation.set(0, 0, 0);
      rig.mallet.visible = pose === "work";

      let facing = 0.35;
      if (pose === "walk") {
        const dx = worker.target.x - worker.from.x;
        const dz = worker.target.z - worker.from.z;
        facing = Math.atan2(dx, dz);
        const stride = Math.sin(t * 11.5);
        rig.leftLeg.rotation.x = stride * 0.65;
        rig.rightLeg.rotation.x = -stride * 0.65;
        rig.leftArm.rotation.x = -stride * 0.55;
        rig.rightArm.rotation.x = stride * 0.55;
        rig.body.position.y = Math.abs(Math.cos(t * 11.5)) * 0.08;
      } else if (pose === "work") {
        // Face the building on the plot and swing the mallet/block arm.
        facing = Math.PI * 0.85;
        const swing = animated ? Math.sin(t * 7.5) : 0.4;
        rig.rightArm.rotation.x = -1.35 + swing * 0.65;
        rig.leftArm.rotation.x = -0.35 - swing * 0.15;
        rig.body.rotation.x = 0.08 + Math.max(0, swing) * 0.06;
      } else if (pose === "wait") {
        facing = placement.atStation
          ? 0.35
          : Math.atan2(POND_CENTER_X - worker.current.x, POND_CENTER_Z - worker.current.z);
        if (animated) {
          rig.head.rotation.y = Math.sin(t * 1.4) * 0.25;
          rig.body.position.y = Math.sin(t * 2.1) * 0.02;
        }
      } else if (pose === "done") {
        facing = 0.45;
        rig.leftArm.rotation.x = -2.55;
        rig.rightArm.rotation.x = -2.55;
        rig.leftArm.rotation.z = 0.2;
        rig.rightArm.rotation.z = -0.2;
        if (animated) {
          const hop = Math.max(0, Math.sin(t * 4.4));
          rig.body.position.y = hop * hop * 0.26;
        }
      } else if (pose === "error") {
        facing = 0.35;
        rig.body.rotation.x = 0.32;
        rig.head.rotation.x = 0.34;
        rig.leftArm.rotation.x = -0.35;
        rig.rightArm.rotation.x = -0.35;
        if (animated) {
          rig.body.position.x = Math.sin(t * 16) * 0.02;
        }
      } else {
        // idle
        facing = 0.35;
        if (animated) {
          rig.body.position.y = Math.sin(t * 2.2) * 0.025;
        }
      }

      rig.root.position.set(worker.current.x, worker.current.y, worker.current.z);
      rig.root.rotation.y = facing;

      if (this.selectedKey === worker.placement.key) {
        selectedPos = worker.current;
      }
    }

    if (selectedPos) {
      this.selectionRing.visible = true;
      this.selectionRing.position.set(selectedPos.x, 0.02, selectedPos.z);
    } else {
      this.selectionRing.visible = false;
    }

    if (walkingChanged) this.emitWalkingState();
  }

  private emitWalkingState() {
    const keys: string[] = [];
    for (const [key, w] of this.workers) {
      if (w.walking) keys.push(key);
    }
    const sig = keys.sort().join(",");
    if (sig !== this.lastWalkingSignature) {
      this.lastWalkingSignature = sig;
      this.onWalkingChange(new Set(keys));
    }
  }

  private projectOverlays() {
    if (!this.layout) return;
    const agents: ProjectedAgent[] = [];
    for (const worker of this.workers.values()) {
      const { x, y, z } = worker.current;
      this.projVec.set(x, y, z).project(this.camera);
      this.headVec.set(x, y + 1.56, z).project(this.camera);

      const sx = (this.projVec.x * 0.5 + 0.5) * this.widthPx;
      const sy = (-this.projVec.y * 0.5 + 0.5) * this.heightPx;
      const hy = (-this.headVec.y * 0.5 + 0.5) * this.heightPx;
      const height = Math.max(26, Math.round(sy - hy));
      const width = Math.max(22, Math.round(height * 0.75));
      // Closer to camera in isometric view = larger (x + z).
      const zIndex = Math.max(1, Math.round((x + z) * 10));
      agents.push({
        key: worker.placement.key,
        x: sx,
        y: sy,
        width,
        height,
        zIndex,
        walking: worker.walking,
      });
    }

    const hiddenLabels: ProjectedLabel[] = [];
    if (this.interactive) {
      for (const p of this.layout.placements) {
        if (!p.hidden) continue;
        this.projVec.set(p.plot.workerSpot.x, 0, p.plot.workerSpot.z).project(this.camera);
        hiddenLabels.push({
          seat: p.seat,
          x: (this.projVec.x * 0.5 + 0.5) * this.widthPx,
          y: (-this.projVec.y * 0.5 + 0.5) * this.heightPx,
        });
      }
    }

    this.onProject({ agents, hiddenLabels });
  }

  private renderOnce() {
    if (this.disposed || this.contextLost) return;
    if (this.shared) {
      // The shared renderer draws every thumbnail: size it for this one and redraw its shadows.
      if (this.renderer.getPixelRatio() !== this.pixelRatio) this.renderer.setPixelRatio(this.pixelRatio);
      const size = this.renderer.getSize(this.sizeVec);
      if (size.x !== this.widthPx || size.y !== this.heightPx) this.renderer.setSize(this.widthPx, this.heightPx, false);
      this.renderer.shadowMap.needsUpdate = true;
    } else if (this.shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.shadowDirty = false;
    this.renderer.render(this.scene, this.camera);
    // Copy in the same task as the render, while the drawing buffer is still intact.
    this.output2d?.drawImage(this.renderer.domElement, 0, 0, this.output.width, this.output.height);
    if (this.overlayDirty) {
      this.overlayDirty = false;
      this.projectOverlays();
    }
  }

  /**
   * The scene animates only while an agent is working or walking somewhere. Otherwise it is a
   * still picture redrawn on change, so an open dashboard of done and idle agents costs nothing.
   */
  private isAnimating(): boolean {
    if (!this.interactive || this.reducedMotion || !this.visible || !this.layout || this.contextLost) return false;
    for (const worker of this.workers.values()) {
      if (worker.walking) return true;
    }
    return this.layout.placements.some((p) => p.pose === "work" && !p.hidden && !p.dimmed);
  }

  private syncLoop() {
    if (this.isAnimating()) {
      if (this.rafId === null) {
        this.lastTimeMs = performance.now();
        this.rafId = requestAnimationFrame(this.tick);
      }
    } else {
      this.stopLoop();
    }
  }

  private stopLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private readonly tick = (nowMs: number) => {
    if (this.disposed) return;
    if (nowMs - this.lastTimeMs < FRAME_MS - 1) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    const dt = Math.min(0.1, Math.max(0, (nowMs - this.lastTimeMs) / 1000));
    this.lastTimeMs = nowMs;
    this.elapsedSec += dt;

    if (this.hasTimedBuildings() && nowMs - this.lastBuildingStepMs >= BUILDING_STEP_MS) {
      this.lastBuildingStepMs = nowMs;
      this.rebuildBuildings();
    }
    this.updateWorkers(dt);
    this.renderOnce();

    if (this.isAnimating()) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      // Nothing left moving: settle into the still frame, with no mid-hop or mid-swing pose.
      this.rafId = null;
      this.settle();
    }
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);

    this.staticMatteMesh?.dispose();
    this.staticWaterMesh?.dispose();
    this.buildingMatteMesh?.dispose();
    this.buildingGlassMesh?.dispose();
    for (const worker of this.workers.values()) disposeWorkerRig(worker.rig);
    this.workers.clear();

    this.unitBox.dispose();
    this.shadowPlane.geometry.dispose();
    this.grainTexture?.dispose();
    this.matteMat.dispose();
    this.waterMat.dispose();
    this.glassMat.dispose();
    this.shadowMat.dispose();
    for (const m of this.selectionRingMats) m.dispose();
    this.keyLight.shadow.dispose();

    if (this.shared) {
      releaseSharedRenderer(this.shared);
    } else {
      // Release the context now rather than whenever the canvas is garbage collected.
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    this.output.remove();
  }
}
