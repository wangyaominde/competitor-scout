/**
 * 多维威胁空间 — 视觉升级版
 * 1D / 2D / 3D 散点 + 多产品基准
 */
import * as THREE from '../vendor/three.module.min.js';

const DIM_OPTIONS = [
  { key: 'threat_score', label: '综合威胁' },
  { key: 'price', label: '价格竞争力' },
  { key: 'category', label: '品类重合' },
  { key: 'features', label: '规格/功能' },
  { key: 'channels', label: '渠道重合' },
  { key: 'positioning', label: '定位相似' },
  { key: 'price_edge', label: '价格压制' },
  { key: 'channel_edge', label: '渠道广度' },
  { key: 'completeness', label: '情报完整度' },
];

const PALETTE = {
  bg: 0x080a12,
  fog: 0x0a0c16,
  grid: 0x1e2638,
  gridMajor: 0x2d3850,
  axisX: 0x6b9bff,
  axisY: 0x5eead4,
  axisZ: 0xc4b5fd,
  self: 0x6b9bff,
  selfGlow: 0x3b6fff,
  peer: 0x2dd4bf,
  peerGlow: 0x0f766e,
};

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function dimValue(c, key) {
  if (key === 'threat_score') return clamp01(c.threat_score ?? 0);
  return clamp01((c.threat_dimensions || {})[key] ?? 0);
}

/** 冷青 → 琥珀 → 玫红，饱和度更高级 */
function threatColor(score) {
  const s = clamp01(score);
  const stops = [
    { t: 0, c: [56, 189, 248] }, // sky
    { t: 0.35, c: [52, 211, 153] }, // emerald
    { t: 0.55, c: [251, 191, 36] }, // amber
    { t: 0.78, c: [251, 113, 133] }, // rose
    { t: 1, c: [244, 63, 94] }, // red
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (s >= stops[i].t && s <= stops[i + 1].t) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const u = (s - a.t) / Math.max(b.t - a.t, 1e-6);
  const r = (a.c[0] + (b.c[0] - a.c[0]) * u) / 255;
  const g = (a.c[1] + (b.c[1] - a.c[1]) * u) / 255;
  const bl = (a.c[2] + (b.c[2] - a.c[2]) * u) / 255;
  return new THREE.Color(r, g, bl);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class SimpleOrbit {
  constructor(camera, dom, target) {
    this.camera = camera;
    this.dom = dom;
    this.target = target.clone();
    this.spherical = new THREE.Spherical().setFromVector3(
      camera.position.clone().sub(this.target)
    );
    this.rotate = true;
    this.dragging = false;
    this.lastX = 0;
    this.lastY = 0;
    this._moved = false;
    this.autoRotate = true;
    this.autoSpeed = 0.0012;

    this._onDown = (e) => {
      this.dragging = true;
      this._moved = false;
      this.autoRotate = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.style.cursor = 'grabbing';
    };
    this._onUp = () => {
      this.dragging = false;
      dom.style.cursor = 'grab';
    };
    this._onMove = (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) this._moved = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.rotate) {
        this.spherical.theta -= dx * 0.0045;
        this.spherical.phi -= dy * 0.0045;
        this.spherical.phi = Math.max(0.25, Math.min(Math.PI - 0.25, this.spherical.phi));
      } else {
        this.target.x -= dx * 0.0035;
        this.target.y += dy * 0.0035;
      }
      this.apply();
    };
    this._onWheel = (e) => {
      e.preventDefault();
      this.spherical.radius *= e.deltaY > 0 ? 1.07 : 0.93;
      this.spherical.radius = Math.max(1.6, Math.min(10, this.spherical.radius));
      this.apply();
    };

    dom.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointermove', this._onMove);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    this.apply();
  }

  tick() {
    if (this.autoRotate && this.rotate && !this.dragging) {
      this.spherical.theta += this.autoSpeed;
      this.apply();
    }
  }

  apply() {
    const pos = new THREE.Vector3().setFromSpherical(this.spherical).add(this.target);
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }

  setRotate(enabled) {
    this.rotate = enabled;
    if (!enabled) this.autoRotate = false;
  }

  wasDrag() {
    return this._moved;
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointermove', this._onMove);
    this.dom.removeEventListener('wheel', this._onWheel);
  }
}

class ThreatViz {
  constructor(container, options = {}) {
    this.container = container;
    this.mode = options.mode || '3d';
    this.axis = {
      x: options.x || 'price',
      y: options.y || 'features',
      z: options.z || 'channels',
    };
    this.product = options.product || null;
    this.products = options.products || (options.product ? [options.product] : []);
    this.activeProductId = options.activeProductId || this.product?.id || null;
    /** relative: 我方在原点；absolute: 按能力坐标散点（击败路径模拟） */
    this.layout = options.layout || 'relative';
    /** 模拟目标点 [{ name, threat_dimensions, threat_score }] */
    this.targets = options.targets || [];
    this.pathLinks = options.pathLinks !== false;
    this.onSelect = options.onSelect || (() => {});
    this.onSelectProduct = options.onSelectProduct || (() => {});
    this.onSelectTarget = options.onSelectTarget || (() => {});
    this.competitors = [];
    this._labels = [];
    this._points = [];
    this._pulse = [];
    this._t0 = performance.now();
    this._disposed = false;
    this._init();
    if (!this._disposed && this.renderer) this._loop();
  }

  setProducts(products, activeProductId) {
    this.products = products || [];
    this.activeProductId = activeProductId || this.products[0]?.id || null;
    this.product =
      this.products.find((p) => p.id === this.activeProductId) || this.products[0] || null;
    this.renderData(this.competitors);
  }

  setProduct(product) {
    this.product = product || null;
    if (product && !this.products.find((p) => p.id === product.id)) {
      this.products = [product, ...this.products];
    }
    this.activeProductId = product?.id || this.activeProductId;
    this.renderData(this.competitors);
  }

  /** 击败路径场景：绝对坐标 + 目标点 */
  setRoadmapScene({ products, targets, competitors, activeProductId } = {}) {
    this.layout = 'absolute';
    if (products) this.products = products;
    if (activeProductId !== undefined) this.activeProductId = activeProductId;
    this.targets = targets || [];
    this.product =
      this.products.find((p) => p.id === this.activeProductId) || this.products[0] || null;
    this.renderData(competitors || []);
  }

  _coordsFromDims(source) {
    const SCALE = 1.55;
    const vx = dimValue(source, this.axis.x);
    const vy = dimValue(source, this.axis.y);
    const vz = dimValue(source, this.axis.z);
    if (this.mode === '1d') return { x: (vx - 0.5) * SCALE * 2, y: 0, z: 0, vx, vy, vz };
    if (this.mode === '2d') {
      return {
        x: (vx - 0.5) * SCALE * 2,
        y: (vy - 0.5) * SCALE * 2,
        z: 0,
        vx,
        vy,
        vz,
      };
    }
    return {
      x: (vx - 0.5) * SCALE * 2,
      y: (vy - 0.5) * SCALE * 2,
      z: (vz - 0.5) * SCALE * 2,
      vx,
      vy,
      vz,
    };
  }

  _showEmpty(title, detail) {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="viz-empty">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(detail || '')}</p>
        </div>
      </div>`;
  }

  _init() {
    const w = Math.max(this.container.clientWidth || 0, 320);
    const h = Math.max(this.container.clientHeight || 0, 280);

    // WebGL 可用性检测（GPU 被关时直接友好提示，而不是黑屏）
    try {
      const test = document.createElement('canvas');
      const gl =
        test.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) ||
        test.getContext('webgl', { failIfMajorPerformanceCaveat: false }) ||
        test.getContext('experimental-webgl');
      if (!gl) {
        this._disposed = true;
        this._showEmpty(
          '3D 空间图不可用',
          '当前环境无法创建 WebGL 上下文。macOS 请确认未禁用 GPU；Windows 安全模式可能关闭了硬件加速。'
        );
        return;
      }
    } catch {
      this._disposed = true;
      this._showEmpty('3D 空间图不可用', 'WebGL 初始化失败。');
      return;
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.bg);
    this.scene.fog = new THREE.FogExp2(PALETTE.fog, 0.055);

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 80);
    this.camera.position.set(3.2, 2.1, 3.6);

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
      });
    } catch (err) {
      this._disposed = true;
      this._showEmpty(
        '3D 渲染器创建失败',
        (err && err.message) || 'WebGLRenderer 无法启动，请检查 GPU / 显卡驱动。'
      );
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);
    Object.assign(this.renderer.domElement.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      borderRadius: '0',
      cursor: 'grab',
    });

    this.controls = new SimpleOrbit(
      this.camera,
      this.renderer.domElement,
      new THREE.Vector3(0, 0.15, 0)
    );
    this.controls.spherical.set(5.2, 1.05, 0.75);
    this.controls.apply();

    // lighting stack
    this.scene.add(new THREE.AmbientLight(0x8b9dc3, 0.35));
    const hemi = new THREE.HemisphereLight(0x9ec5ff, 0x0a0c14, 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(4, 6, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7aa2ff, 0.35);
    rim.position.set(-3, 2, -4);
    this.scene.add(rim);
    const fill = new THREE.PointLight(0x5b8cff, 0.45, 12);
    fill.position.set(0, 1.2, 0);
    this.scene.add(fill);
    this._fillLight = fill;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    // vignette-like dark floor disc
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.5, 64),
      new THREE.MeshBasicMaterial({
        color: 0x06080f,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.72;
    this.scene.add(floor);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'viz-labels';
    this.container.appendChild(this.labelLayer);

    this.axisHud = document.createElement('div');
    this.axisHud.className = 'viz-axis-hud';
    this.container.appendChild(this.axisHud);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points = { threshold: 0.08 };
    this.pointer = new THREE.Vector2();
    this.renderer.domElement.addEventListener('pointerup', (e) => this._onClick(e));

    this._ro = new ResizeObserver(() => {
      if (this._disposed) return;
      const ww = this.container.clientWidth || 640;
      const hh = this.container.clientHeight || 420;
      this.camera.aspect = ww / hh;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(ww, hh);
    });
    this._ro.observe(this.container);
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === '3d') {
      this.controls.setRotate(true);
      this.controls.autoRotate = true;
      this.controls.spherical.set(5.2, 1.05, 0.75);
      this.controls.target.set(0, 0.15, 0);
      this.controls.apply();
    } else if (mode === '2d') {
      this.controls.setRotate(false);
      this.controls.spherical.set(4.2, Math.PI / 2, 0);
      this.controls.target.set(0, 0, 0);
      this.controls.apply();
    } else {
      this.controls.setRotate(false);
      this.controls.spherical.set(3.8, Math.PI / 2, 0);
      this.controls.target.set(0, 0, 0);
      this.controls.apply();
    }
    this.renderData(this.competitors);
  }

  setAxes({ x, y, z } = {}) {
    if (x) this.axis.x = x;
    if (y) this.axis.y = y;
    if (z) this.axis.z = z;
    this.renderData(this.competitors);
  }

  _dimLabel(key) {
    return DIM_OPTIONS.find((d) => d.key === key)?.label || key;
  }

  _updateAxisHud() {
    const xl = this._dimLabel(this.axis.x);
    const yl = this._dimLabel(this.axis.y);
    const zl = this._dimLabel(this.axis.z);
    if (this.mode === '1d') {
      this.axisHud.innerHTML = `<span class="ah x">X · ${escapeHtml(xl)}</span>`;
    } else if (this.mode === '2d') {
      this.axisHud.innerHTML = `
        <span class="ah x">X · ${escapeHtml(xl)}</span>
        <span class="ah y">Y · ${escapeHtml(yl)}</span>`;
    } else {
      this.axisHud.innerHTML = `
        <span class="ah x">X · ${escapeHtml(xl)}</span>
        <span class="ah y">Y · ${escapeHtml(yl)}</span>
        <span class="ah z">Z · ${escapeHtml(zl)}</span>`;
    }
  }

  renderData(competitors = []) {
    this.competitors = competitors || [];
    this._pulse = [];
    if (this._disposed || !this.root || !this.renderer) return;

    while (this.root.children.length) {
      const o = this.root.children.pop();
      o.traverse((ch) => {
        if (ch.geometry) ch.geometry.dispose();
        if (ch.material) {
          if (Array.isArray(ch.material)) ch.material.forEach((m) => m.dispose());
          else ch.material.dispose();
        }
      });
    }
    this._points = [];
    this.labelLayer.innerHTML = '';
    this._labels = [];

    this._drawEnvironment();
    this._drawAxes();
    this._drawSelfProducts();
    this._drawTargets();
    this._drawCompetitors();
    this._drawRoadmapPaths();
    this._updateAxisHud();
  }

  _drawEnvironment() {
    // soft radial glow at center
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 32, 32),
      new THREE.MeshBasicMaterial({
        color: 0x1a2a55,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      })
    );
    this.root.add(glow);

    if (this.mode === '1d') {
      // elegant baseline
      this._line(
        new THREE.Vector3(-2.1, 0, 0),
        new THREE.Vector3(2.1, 0, 0),
        0x334155,
        0.9
      );
      // tick marks
      for (let i = 0; i <= 4; i++) {
        const x = -2 + i;
        this._line(
          new THREE.Vector3(x, -0.06, 0),
          new THREE.Vector3(x, 0.06, 0),
          0x475569,
          0.6
        );
      }
      return;
    }

    if (this.mode === '2d') {
      this._drawPlaneGrid(3.6, 8, 0);
      // subtle frame
      this._rectFrame(1.8, 1.8, 0x243044);
      return;
    }

    // 3D floor grid
    const grid = new THREE.GridHelper(4.2, 14, PALETTE.gridMajor, PALETTE.grid);
    grid.position.y = -1.65;
    const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
    mats.forEach((m) => {
      if (!m) return;
      m.transparent = true;
      m.opacity = 0.5;
    });
    this.root.add(grid);

    // translucent bounding box
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(3.4, 3.4, 3.4)),
      new THREE.LineBasicMaterial({
        color: 0x2a3548,
        transparent: true,
        opacity: 0.35,
      })
    );
    this.root.add(box);
  }

  _drawPlaneGrid(size, divisions, z) {
    const step = size / divisions;
    const half = size / 2;
    const pts = [];
    for (let i = 0; i <= divisions; i++) {
      const p = -half + i * step;
      pts.push(new THREE.Vector3(-half, p, z), new THREE.Vector3(half, p, z));
      pts.push(new THREE.Vector3(p, -half, z), new THREE.Vector3(p, half, z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.root.add(
      new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ color: PALETTE.grid, transparent: true, opacity: 0.55 })
      )
    );
  }

  _rectFrame(hx, hy, color) {
    const pts = [
      new THREE.Vector3(-hx, -hy, 0),
      new THREE.Vector3(hx, -hy, 0),
      new THREE.Vector3(hx, hy, 0),
      new THREE.Vector3(-hx, hy, 0),
      new THREE.Vector3(-hx, -hy, 0),
    ];
    this.root.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 })
      )
    );
  }

  _line(a, b, color, opacity = 1) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    this.root.add(
      new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity })
      )
    );
  }

  _drawAxes() {
    const L = 1.75;
    const makeAxis = (dir, color) => {
      const end = dir.clone().multiplyScalar(L);
      this._line(new THREE.Vector3(0, 0, 0), end, color, 0.95);
      // arrow head
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.045, 0.14, 12),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.35,
          metalness: 0.2,
          roughness: 0.4,
        })
      );
      cone.position.copy(end);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      this.root.add(cone);
    };

    if (this.mode === '1d') {
      makeAxis(new THREE.Vector3(1, 0, 0), PALETTE.axisX);
      return;
    }
    if (this.mode === '2d') {
      makeAxis(new THREE.Vector3(1, 0, 0), PALETTE.axisX);
      makeAxis(new THREE.Vector3(0, 1, 0), PALETTE.axisY);
      return;
    }
    makeAxis(new THREE.Vector3(1, 0, 0), PALETTE.axisX);
    makeAxis(new THREE.Vector3(0, 1, 0), PALETTE.axisY);
    makeAxis(new THREE.Vector3(0, 0, 1), PALETTE.axisZ);
  }

  _drawSelfProducts() {
    const list =
      this.products?.length > 0
        ? this.products
        : this.product
          ? [this.product]
          : [{ name: '我的产品', id: null }];

    const activeId = this.activeProductId || list[0]?.id;
    const active = list.find((p) => p.id === activeId) || list[0];
    const others = list.filter((p) => p !== active);

    if (this.layout === 'absolute') {
      const place = (p, primary) => {
        const c = this._coordsFromDims(p);
        this._addSelfMarker(p, {
          x: c.x,
          y: c.y,
          z: c.z,
          primary,
          size: primary ? 0.13 : 0.085,
          badge: primary ? '现状' : '我方',
        });
      };
      place(active, true);
      others.forEach((p) => place(p, false));
      return;
    }

    this._addSelfMarker(active, {
      x: 0,
      y: 0,
      z: 0,
      primary: true,
      size: 0.13,
      badge: '基准',
    });

    const n = others.length;
    const orbit = 0.62;
    others.forEach((p, i) => {
      const ang = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
      let x = Math.cos(ang) * orbit;
      let y = Math.sin(ang) * orbit * 0.55;
      let z = 0;
      if (this.mode === '1d') {
        x = ((i + 1) / (n + 1) - 0.5) * 1.4;
        y = 0.28;
      } else if (this.mode === '3d') {
        z = Math.sin(ang * 1.2) * orbit * 0.4;
      }
      this._addSelfMarker(p, {
        x,
        y,
        z,
        primary: false,
        size: 0.085,
        badge: '我方',
      });
    });
  }

  _drawTargets() {
    if (!this.targets?.length) return;
    for (const t of this.targets) {
      this._addTargetMarker(t, this._coordsFromDims(t));
    }
  }

  _addTargetMarker(target, { x, y, z }) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const color = 0xfbbf24;

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 24, 24),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
      })
    );
    group.add(halo);
    this._pulse.push({ mesh: halo, base: 0.32, amp: 0.1, phase: 1.3 });

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.2, 0.014, 12, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
    );
    if (this.mode === '3d') ring.rotation.x = Math.PI / 2;
    group.add(ring);
    this._pulse.push({ mesh: ring, rot: true, speed: 0.55 });

    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.12, 0),
      new THREE.MeshStandardMaterial({
        color,
        emissive: 0xb45309,
        emissiveIntensity: 0.75,
        metalness: 0.5,
        roughness: 0.2,
      })
    );
    core.userData = { target, isTarget: true };
    group.add(core);

    const spike = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.12, 0),
      new THREE.MeshStandardMaterial({
        color: 0xfde68a,
        emissive: 0xfbbf24,
        emissiveIntensity: 0.4,
        metalness: 0.4,
        roughness: 0.3,
        transparent: true,
        opacity: 0.85,
      })
    );
    spike.rotation.y = Math.PI / 4;
    spike.scale.setScalar(0.72);
    group.add(spike);

    this.root.add(group);
    this._points.push(core);
    this._pulse.push({ mesh: core, float: true, amp: 0.04, phase: 1.5 });

    const name = target?.name || '模拟目标';
    const pct = Math.round(clamp01(target.threat_score ?? 0) * 100);
    const el = document.createElement('div');
    el.className = 'viz-label viz-label-target';
    el.innerHTML = `<span class="self-badge gold">目标</span><span class="viz-name">${escapeHtml(name)}</span><span class="viz-pct">${pct}%</span>`;
    el.title = 'AI 模拟的目标产品能力画像';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onSelectTarget(target);
    });
    this.labelLayer.appendChild(el);
    this._labels.push({ el, mesh: core, isTarget: true });
  }

  _drawRoadmapPaths() {
    if (!this.pathLinks || this.layout !== 'absolute') return;
    const list = this.products || [];
    const active = list.find((p) => p.id === this.activeProductId) || list[0];
    const target = this.targets?.[0];
    if (!active || !target) return;

    const a = this._coordsFromDims(active);
    const b = this._coordsFromDims(target);
    const from = new THREE.Vector3(a.x, a.y, a.z);
    const to = new THREE.Vector3(b.x, b.y, b.z);
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 0.25;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    this.root.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)),
        new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.55 })
      )
    );

    const dir = to.clone().sub(from).normalize();
    if (dir.lengthSq() > 0.0001) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.05, 0.14, 10),
        new THREE.MeshStandardMaterial({
          color: 0xfbbf24,
          emissive: 0xb45309,
          emissiveIntensity: 0.5,
        })
      );
      cone.position.copy(to).addScaledVector(dir, -0.12);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.root.add(cone);
    }

    const tops = [...(this.competitors || [])]
      .sort((x, y) => (y.threat_score || 0) - (x.threat_score || 0))
      .slice(0, 3);
    const linkPts = [];
    for (const c of tops) {
      const p = this._coordsFromDims(c);
      linkPts.push(to.clone(), new THREE.Vector3(p.x, p.y, p.z));
    }
    if (linkPts.length) {
      this.root.add(
        new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(linkPts),
          new THREE.LineBasicMaterial({ color: 0xfb7185, transparent: true, opacity: 0.22 })
        )
      );
    }
  }

  _addSelfMarker(product, { x, y, z, primary, size, badge }) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const color = primary ? PALETTE.self : PALETTE.peer;
    const emissive = primary ? PALETTE.selfGlow : PALETTE.peerGlow;
    const badgeText = badge || (primary ? '基准' : '我方');

    // soft halo sphere
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(size * 2.2, 24, 24),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: primary ? 0.12 : 0.08,
        depthWrite: false,
      })
    );
    group.add(halo);
    this._pulse.push({ mesh: halo, base: size * 2.2, amp: 0.08, phase: primary ? 1 : 0.7 });

    if (primary) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(size * 1.55, 0.012, 12, 48),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.7,
        })
      );
      if (this.mode === '3d') ring.rotation.x = Math.PI / 2;
      group.add(ring);
      this._pulse.push({ mesh: ring, rot: true, speed: 0.4 });

      if (this.mode === '3d') {
        const beamMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
        });
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.028, 1.1, 10), beamMat);
        beam.position.y = 0.55;
        group.add(beam);
      }
    }

    const diamond = new THREE.Mesh(
      new THREE.OctahedronGeometry(size, 0),
      new THREE.MeshStandardMaterial({
        color,
        emissive,
        emissiveIntensity: primary ? 0.7 : 0.45,
        metalness: 0.55,
        roughness: 0.22,
      })
    );
    diamond.userData = { ownProduct: product, isSelf: true, primary };
    group.add(diamond);
    this.root.add(group);
    this._points.push(diamond);
    this._pulse.push({ mesh: diamond, float: true, amp: primary ? 0.03 : 0.02, phase: 1.1 });

    const name = product?.name || '我的产品';
    const el = document.createElement('div');
    el.className = primary ? 'viz-label viz-label-self' : 'viz-label viz-label-self secondary';
    el.innerHTML = primary
      ? `<span class="self-badge">${escapeHtml(badgeText)}</span><span class="viz-name">${escapeHtml(name)}</span>`
      : `<span class="self-badge teal">${escapeHtml(badgeText)}</span><span class="viz-name">${escapeHtml(name)}</span>`;
    el.title = primary ? `当前：${name}` : `己方产品：${name}`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (product?.id) this.onSelectProduct(product);
    });
    this.labelLayer.appendChild(el);
    this._labels.push({ el, mesh: diamond, isSelf: true });
  }

  _drawCompetitors() {
    // subtle link lines for high threat (relative layout only)
    const linkPts = [];

    for (const c of this.competitors) {
      const threat = clamp01(c.threat_score ?? 0);
      const { x, y, z } = this._coordsFromDims(c);
      const pos = new THREE.Vector3(x, y, z);
      if (this.layout !== 'absolute' && threat >= 0.65) {
        linkPts.push(new THREE.Vector3(0, 0, 0), pos.clone());
      }

      const radius = 0.055 + threat * 0.1;
      const col = threatColor(threat);

      // outer glow shell
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.55, 20, 20),
        new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: 0.12 + threat * 0.12,
          depthWrite: false,
        })
      );
      shell.position.copy(pos);
      this.root.add(shell);

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 28, 28),
        new THREE.MeshStandardMaterial({
          color: col,
          emissive: col.clone().multiplyScalar(0.35),
          emissiveIntensity: 0.45 + threat * 0.35,
          metalness: 0.25,
          roughness: 0.35,
        })
      );
      mesh.position.copy(pos);
      mesh.userData = { competitor: c };
      this.root.add(mesh);
      this._points.push(mesh);

      if (threat >= 0.75) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 1.45, 0.01, 8, 32),
          new THREE.MeshBasicMaterial({
            color: 0xff6b8a,
            transparent: true,
            opacity: 0.65,
          })
        );
        ring.position.copy(pos);
        this.root.add(ring);
        this._pulse.push({ mesh: ring, rot: true, speed: 0.8 });
      }

      const pct = Math.round(threat * 100);
      const el = document.createElement('div');
      el.className = 'viz-label viz-label-comp' + (threat >= 0.65 ? ' hot' : '');
      el.innerHTML = `<span class="viz-name">${escapeHtml(c.name || '?')}</span><span class="viz-pct">${pct}%</span>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelect(c);
      });
      this.labelLayer.appendChild(el);
      this._labels.push({ el, mesh });
    }

    if (linkPts.length) {
      const geo = new THREE.BufferGeometry().setFromPoints(linkPts);
      this.root.add(
        new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({
            color: 0xff6b8a,
            transparent: true,
            opacity: 0.18,
          })
        )
      );
    }
  }

  _onClick(e) {
    if (this.controls.wasDrag()) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this._points, false);
    if (!hits.length) return;
    const u = hits[0].object.userData;
    if (u.competitor) this.onSelect(u.competitor);
    else if (u.ownProduct) this.onSelectProduct(u.ownProduct);
    else if (u.target) this.onSelectTarget(u.target);
  }

  _loop = () => {
    if (this._disposed || !this.renderer || !this.scene) return;
    this._raf = requestAnimationFrame(this._loop);
    const t = (performance.now() - this._t0) / 1000;
    this.controls?.tick();

    for (const p of this._pulse) {
      if (p.float && p.mesh) {
        p.mesh.position.y = Math.sin(t * (p.phase || 1) * 1.4) * (p.amp || 0.02);
      }
      if (p.rot && p.mesh) {
        p.mesh.rotation.z = t * (p.speed || 0.5);
        if (this.mode === '3d') p.mesh.rotation.x = Math.PI / 2;
      }
      if (p.base && p.mesh?.scale) {
        const s = 1 + Math.sin(t * 1.6 * (p.phase || 1)) * (p.amp || 0.05);
        p.mesh.scale.setScalar(s);
      }
    }
    if (this._fillLight) {
      this._fillLight.intensity = 0.4 + Math.sin(t * 1.2) * 0.08;
    }

    this.renderer.render(this.scene, this.camera);

    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    for (const item of this._labels) {
      const world = new THREE.Vector3();
      item.mesh.getWorldPosition(world);
      const v = world.project(this.camera);
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      if (v.z > 1 || x < -50 || y < -30 || x > w + 50 || y > h + 30) {
        item.el.style.display = 'none';
      } else {
        item.el.style.display = 'block';
        item.el.style.transform = `translate(-50%, -130%) translate(${x}px, ${y}px)`;
      }
    }
  };

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    if (this.container) this.container.innerHTML = '';
  }
}

window.ThreatViz = ThreatViz;
window.ThreatVizDims = DIM_OPTIONS;
