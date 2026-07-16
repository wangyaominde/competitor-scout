/* global api */
(() => {
  const state = {
    page: 'dashboard',
    notifications: [],
    scanRunning: false,
    scanLastStage: null,
    scanLastMessage: null,
    scanLastPercent: 0,
    scanStartedAt: 0,
    scanLastProgressAt: 0,
    scanHeartbeatTimer: null,
    scanLastPulseAt: 0,
    threatRunning: false,
    threatLastPercent: 0,
    compareMatrix: null,
    readiness: null,
    bootstrap: null,
    onboardingStep: 0,
    threatViz: null,
    compView: 'space', // space | cards | table
    compCache: [],
  };

  function disposeThreatViz() {
    if (state.threatViz) {
      try {
        state.threatViz.dispose();
      } catch { /* ignore */ }
      state.threatViz = null;
    }
    if (state.roadmapViz) {
      try {
        state.roadmapViz.dispose();
      } catch { /* ignore */ }
      state.roadmapViz = null;
    }
  }

  /** 从路线图 + 产品 + 竞品构建多维能力坐标 */
  function buildRoadmapVizModel(doc, focusProduct, competitors) {
    const dimKeys = [
      'price',
      'features',
      'channels',
      'positioning',
      'category',
      'price_edge',
      'channel_edge',
      'completeness',
    ];

    const productCapability = (p) => {
      const specs = Object.keys(p?.specs || {}).length;
      const ch = (p?.channels || []).length;
      const d = {
        price: p?.price != null ? 0.55 : 0.32,
        features: Math.min(1, 0.28 + specs * 0.09),
        channels: Math.min(1, 0.22 + ch * 0.13),
        positioning: p?.description ? 0.48 : 0.28,
        category: p?.category ? 0.52 : 0.28,
        price_edge: 0.38,
        channel_edge: Math.min(1, 0.2 + ch * 0.14),
        completeness:
          ((p?.price != null ? 1 : 0) +
            (p?.description ? 1 : 0) +
            (specs > 0 ? 1 : 0) +
            (ch > 0 ? 1 : 0)) /
          4,
      };
      return d;
    };

    const currentDims = productCapability(focusProduct || {});
    const targetDims = { ...currentDims };

    for (const g of doc.gaps || []) {
      const a = String(g.area || '');
      let key = null;
      if (/功能|规格/.test(a)) key = 'features';
      else if (/价格/.test(a)) key = 'price';
      else if (/渠道/.test(a)) key = 'channels';
      else if (/品牌|体验|定位/.test(a)) key = 'positioning';
      else if (/品类/.test(a)) key = 'category';
      if (!key) continue;
      const boost = /P0|高/i.test(g.priority) ? 0.32 : /P1|中/i.test(g.priority) ? 0.2 : 0.12;
      targetDims[key] = Math.min(0.98, (targetDims[key] || 0.4) + boost);
    }
    for (const m of doc.mustHave || []) {
      targetDims.features = Math.min(
        0.98,
        targetDims.features + (/P0/i.test(m.priority) ? 0.14 : 0.07)
      );
      targetDims.completeness = Math.min(0.98, targetDims.completeness + 0.08);
    }
    for (const _d of doc.differentiators || []) {
      targetDims.positioning = Math.min(0.98, targetDims.positioning + 0.1);
    }
    if (doc.priceStrategy?.band) {
      targetDims.price = Math.min(0.95, targetDims.price + 0.16);
      targetDims.price_edge = Math.min(0.9, targetDims.price_edge + 0.12);
    }
    const chN = (doc.channelStrategy?.priorityChannels || []).length;
    if (chN) {
      targetDims.channels = Math.min(0.95, targetDims.channels + 0.1 * chN);
      targetDims.channel_edge = Math.min(0.95, targetDims.channel_edge + 0.08 * chN);
    }

    const avg = (dims) =>
      dimKeys.reduce((s, k) => s + (dims[k] || 0), 0) / dimKeys.length;

    const currentProduct = {
      ...(focusProduct || {}),
      id: focusProduct?.id || 'self-current',
      name: focusProduct?.name || '我方·现状 · Ours · Current',
      threat_dimensions: currentDims,
      threat_score: avg(currentDims),
    };

    const targetProduct = {
      id: 'self-target',
      name: doc.positioning?.statement
        ? `目标 Target：${String(doc.positioning.statement).slice(0, 18)}`
        : '模拟目标 · Simulated target产品 · Simulated target product',
      threat_dimensions: targetDims,
      threat_score: avg(targetDims),
      meta: {
        winTheme: doc.positioning?.winTheme,
        band: doc.priceStrategy?.band,
      },
    };

    // 竞品：用威胁维度作为「对方能力」代理
    const comps = (competitors || [])
      .slice()
      .sort((a, b) => (b.threat_score || 0) - (a.threat_score || 0))
      .slice(0, 16)
      .map((c) => ({
        ...c,
        threat_dimensions: c.threat_dimensions || {},
        threat_score: c.threat_score || 0,
      }));

    return {
      products: [currentProduct],
      targets: [targetProduct],
      competitors: comps,
      activeProductId: currentProduct.id,
    };
  }

  async function mountRoadmapViz(doc) {
    if (state.roadmapViz) {
      try {
        state.roadmapViz.dispose();
      } catch { /* */ }
      state.roadmapViz = null;
    }
    const el = $('#rm-viz-canvas');
    if (!el || !doc) return;
    if (!window.ThreatViz) {
      el.innerHTML =
        '<p class="muted empty-hint" style="padding:40px">可视化加载中… · Loading… · Loading visualization…</p>';
      setTimeout(() => mountRoadmapViz(doc), 400);
      return;
    }

    let focus = null;
    let competitors = [];
    try {
      const pl = await call(api.listProducts());
      focus =
        pl.products?.find((p) => p.id === doc.meta?.focusProductId) ||
        pl.active ||
        pl.products?.[0];
      competitors = await call(api.listCompetitors({}));
    } catch {
      /* empty */
    }

    const model = buildRoadmapVizModel(doc, focus, competitors);
    state.roadmapViz = new window.ThreatViz(el, {
      mode: '3d',
      layout: 'absolute',
      x: 'price',
      y: 'features',
      z: 'channels',
      products: model.products,
      targets: model.targets,
      activeProductId: model.activeProductId,
      pathLinks: true,
      onSelect: (c) => {
        if (c?.id) openCompetitor(c.id);
      },
      onSelectProduct: () => toast('蓝钻 = 我方现状 · Our current · Blue diamond = our current capability', 'info'),
      onSelectTarget: (t) =>
        toast(t?.meta?.winTheme || t?.name || '金色 = AI 模拟目标 · Simulated target · Gold = AI simulated target product', 'info'),
    });
    state.roadmapViz.setRoadmapScene(model);

    // bind controls
    $$('#rm-viz-mode [data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#rm-viz-mode [data-mode]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        const y = $('#rm-viz-y-wrap');
        const z = $('#rm-viz-z-wrap');
        if (y) y.style.display = mode === '1d' ? 'none' : '';
        if (z) z.style.display = mode === '3d' ? '' : 'none';
        state.roadmapViz?.setMode(mode);
      });
    });
    const sync = () => {
      state.roadmapViz?.setAxes({
        x: $('#rm-viz-x')?.value,
        y: $('#rm-viz-y')?.value,
        z: $('#rm-viz-z')?.value,
      });
    };
    $('#rm-viz-x')?.addEventListener('change', sync);
    $('#rm-viz-y')?.addEventListener('change', sync);
    $('#rm-viz-z')?.addEventListener('change', sync);
  }

  function roadmapVizShell() {
    return `
      <div class="viz-panel section-gap" id="rm-viz-panel">
        <div class="viz-toolbar">
          <div class="seg" id="rm-viz-mode">
            <button type="button" data-mode="3d" class="active">3D</button>
            <button type="button" data-mode="2d">2D</button>
            <button type="button" data-mode="1d">1D</button>
          </div>
          <div class="viz-axis-pick">
            <label>X <select id="rm-viz-x">${dimOptsHtml('price')}</select></label>
            <label id="rm-viz-y-wrap">Y <select id="rm-viz-y">${dimOptsHtml('features')}</select></label>
            <label id="rm-viz-z-wrap">Z <select id="rm-viz-z">${dimOptsHtml('channels')}</select></label>
          </div>
          <span class="muted" style="font-size:11px;margin-left:auto">蓝 Blue=current · 金 Gold=target · 球 Ball=competitors · 金线 = beat path</span>
        </div>
        <div class="viz-canvas-wrap" id="rm-viz-canvas"></div>
        <div class="viz-legend">
          <span><i class="swatch" style="background:#6b9bff"></i>我方现状 · Our current</span>
          <span><i class="swatch" style="background:#fbbf24"></i>模拟目标 · Simulated target</span>
          <span><i class="swatch" style="background:#fb7185"></i>高威胁竞品 · High-threat rivals</span>
          <span class="viz-grad"><span>弱</span><i></i><span>强</span></span>
        </div>
        <p class="viz-hint">多维能力空间 · Multi-dim capability space: roadmap → target; gold line = beat path; dashed = key rivals.</p>
      </div>`;
  }

  const titles = {
    dashboard: [L('仪表盘', 'Dashboard'), L('威胁态势、就绪度与待确认', 'Threat overview, readiness & pending review')],
    competitors: [L('竞品库', 'Competitors'), L('三维威胁空间 · 卡片 · 高维表 · Table · 人工筛选', '3D space · cards · table · manual review')],
    scan: [L('智能扫描', 'Smart Scan'), L('LLM 研究 + BM25/RAG 自动威胁 + 待人工筛选', 'LLM research + BM25/RAG threat + human review')],
    product: [L('我的产品', 'My Products'), L('多产品 · 规格书 · Spec sheet上传解析 · 人工确认后入库', 'Multi-product · spec upload · confirm to save')],
    roadmap: [L('击败路径', 'Beat Roadmap'), L('AI 模拟：要打败竞品，产品应做成什么样', 'AI plan: what the product should become to win')],
    loop: [L('Loop 引擎', 'Loop Engine'), L('定时扫描，发现高威胁即通知 · Notifications', 'Scheduled scans · high-threat alerts')],
    settings: [L('设置', 'Settings'), L('模型、通知 · Notifications、备份与导出', 'Model, notifications, backup & export')],
  };

  const dimLabels = {
    price: L('价格竞争力', 'Price competitiveness'),
    category: L('品类重合', 'Category overlap'),
    features: L('规格/功能', 'Features / specs'),
    channels: L('渠道重合', 'Channel overlap'),
    positioning: L('定位相似', 'Positioning fit'),
    price_edge: L('价格压制', 'Price pressure'),
    channel_edge: L('渠道广度', 'Channel breadth'),
    completeness: L('情报完整度 · Intel completeness', 'Intel completeness'),
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 中英双语 · Bilingual label */
  function L(zh, en) {
    if (en == null || en === '') return zh;
    return zh + ' · ' + en;
  }

  /** 统一解包 { ok, data, error } */
  async function call(promise) {
    const res = await promise;
    if (res == null) return null;
    if (typeof res === 'object' && 'ok' in res) {
      if (!res.ok) {
        const msg = res.error?.message || '操作失败 · Failed';
        const err = new Error(msg);
        err.code = res.error?.code;
        err.details = res.error?.details;
        throw err;
      }
      return res.data;
    }
    return res;
  }

  function money(v, unit = 'CNY') {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: unit === 'USD' ? 'USD' : unit === 'EUR' ? 'EUR' : 'CNY',
        maximumFractionDigits: 0,
      }).format(n);
    } catch {
      return `¥${n}`;
    }
  }

  function threatClass(score) {
    if (score >= 0.65) return 'threat-high';
    if (score >= 0.4) return 'threat-mid';
    return 'threat-low';
  }

  function threatLabel(score) {
    const pct = Math.round((score || 0) * 100);
    if (score >= 0.65) return `高威胁 High ${pct}%`;
    if (score >= 0.4) return `中威胁 Mid ${pct}%`;
    return `低威胁 Low ${pct}%`;
  }

  function avatarText(name) {
    return String(name || '?').trim().slice(0, 1).toUpperCase();
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return iso;
    }
  }

  function statusText(s) {
    return (
      {
        pending: L('待确认', 'Pending'),
        confirmed: L('已确认 · Confirmed', 'Confirmed'),
        rejected: L('已忽略 · Dismissed', 'Dismissed'),
      }[s] || s
    );
  }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  function pushNotify(n) {
    state.notifications.unshift(n);
    state.notifications = state.notifications.slice(0, 50);
    renderNotifyBadge();
    renderNotifyList();
    toast(n.title, n.level === 'high' ? 'error' : 'info');
  }

  function renderNotifyBadge() {
    const badge = $('#notify-badge');
    const n = state.notifications.length;
    if (n > 0) {
      badge.textContent = n > 9 ? '9+' : String(n);
      badge.classList.remove('hidden');
    } else badge.classList.add('hidden');
  }

  function renderNotifyList() {
    const list = $('#notify-list');
    if (!state.notifications.length) {
      list.innerHTML = '<p class="muted empty-hint">暂无通知 · Notifications · No notifications</p>';
      return;
    }
    list.innerHTML = state.notifications
      .map(
        (n) => `
      <div class="notify-item">
        <div class="t">${esc(n.title)}</div>
        <div class="b">${esc(n.body)}</div>
        <div class="time">${esc(fmtTime(n.time))}</div>
      </div>`
      )
      .join('');
  }

  function setReadiness(r) {
    if (!r) return;
    state.readiness = r;
    const pct = r.percent || 0;
    const complete = r.complete === true || (pct >= 100 && !r.next);
    $('#ready-mini-pct').textContent = `${pct}%`;
    $('#ready-mini-bar').style.width = `${pct}%`;
    // 全部配置完成后隐藏侧栏就绪度，避免一直占位
    const mini = $('#ready-mini');
    if (mini) mini.classList.toggle('hidden', complete);
  }

  /** 遍历匹配进度条（竞品库 / 仪表盘 / 详情） */
  function showThreatProgress(show, message, percent) {
    let bar = $('#threat-progress-bar');
    // 若不在竞品页，用 toast 即可；进度仍写 state
    if (percent != null) state.threatLastPercent = percent;
    if (!bar && show) {
      // 挂到 content 顶部
      const content = $('#content');
      if (content) {
        bar = document.createElement('div');
        bar.id = 'threat-progress-bar';
        bar.className = 'threat-progress';
        bar.innerHTML = `
          <div class="threat-progress-top">
            <span id="threat-progress-text">待命 · Idle</span>
            <strong id="threat-progress-pct">0%</strong>
          </div>
          <div class="progress"><i id="threat-progress-fill"></i></div>`;
        content.insertBefore(bar, content.firstChild);
      }
    }
    bar = $('#threat-progress-bar');
    if (!bar) return;
    if (!show) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const text = $('#threat-progress-text');
    const pctEl = $('#threat-progress-pct');
    const fill = $('#threat-progress-fill');
    if (message && text) text.textContent = message;
    if (percent != null) {
      const n = Math.max(0, Math.min(100, Math.round(percent)));
      if (pctEl) pctEl.textContent = `${n}%`;
      if (fill) fill.style.width = `${n}%`;
    }
  }

  async function refreshLoopPill() {
    try {
      const st = await call(api.getLoopStatus());
      const pill = $('#loop-pill');
      const text = $('#loop-pill-text');
      if (st.isScheduled || st.enabled) {
        pill.classList.add('on');
        text.textContent = st.isRunning ? '扫描中… · Scanning…' : `Loop · ${st.nextHint || '运行中 · Running'}`;
      } else {
        pill.classList.remove('on');
        text.textContent = 'Loop 未启动 · Loop off';
      }
    } catch { /* ignore */ }
  }

  function skeletonHtml() {
    return `
      <div class="grid stats">
        ${[1, 2, 3, 4].map(() => '<div class="card sk-card skeleton"></div>').join('')}
      </div>
      <div class="grid two section-gap">
        <div class="card"><div class="skeleton sk-line lg"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>
        <div class="card"><div class="skeleton sk-line lg"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>
      </div>`;
  }

  function emptyState(icon, title, desc, actionLabel, actionId) {
    return `
      <div class="empty-state">
        <div class="icon">${icon}</div>
        <h4>${esc(title)}</h4>
        <p>${esc(desc)}</p>
        ${actionLabel ? `<button class="btn primary" id="${actionId}">${esc(actionLabel)}</button>` : ''}
      </div>`;
  }

  // ---------- navigation ----------
  function navigate(page) {
    disposeThreatViz();
    state.page = page;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    const [t, s] = titles[page] || ['', ''];
    $('#page-title').textContent = t;
    $('#page-sub').textContent = s;
    renderPage();
  }

  async function renderPage() {
    const content = $('#content');
    content.innerHTML = skeletonHtml();
    try {
      switch (state.page) {
        case 'dashboard':
          content.innerHTML = await pageDashboard();
          bindDashboard();
          break;
        case 'competitors':
          content.innerHTML = await pageCompetitors();
          bindCompetitors();
          break;
        case 'scan':
          content.innerHTML = pageScan();
          bindScan();
          break;
        case 'product':
          content.innerHTML = await pageProduct();
          bindProduct();
          break;
        case 'roadmap':
          content.innerHTML = await pageRoadmap();
          bindRoadmap();
          break;
        case 'loop':
          content.innerHTML = await pageLoop();
          bindLoop();
          break;
        case 'settings':
          content.innerHTML = await pageSettings();
          bindSettings();
          break;
        default:
          content.innerHTML = '';
      }
    } catch (err) {
      content.innerHTML = `
        <div class="card">
          <div class="empty-state">
            <div class="icon">!</div>
            <h4>加载失败 · Load failed</h4>
            <p>${esc(err.message)}</p>
            <button class="btn primary" id="btn-retry">重试 · Retry</button>
          </div>
        </div>`;
      $('#btn-retry')?.addEventListener('click', () => renderPage());
    }
    refreshLoopPill();
  }

  // ---------- pages ----------
  async function pageDashboard() {
    const stats = await call(api.getStats());
    setReadiness(stats.readiness);
    const history = await call(api.listHistory(6));
    const r = stats.readiness || {};

    const checklistComplete =
      r.complete === true ||
      ((r.checks || []).length > 0 && (r.checks || []).every((c) => c.done)) ||
      (r.percent >= 100 && !r.next);

    const banner = !checklistComplete
      ? `<div class="banner ${r.canScan ? '' : 'warn'}">
            <span>${r.canScan ? `就绪度 ${r.percent}% · Ready — you can refine setup further` : `尚未就绪（${r.percent}%）· Not ready — ${esc(r.next?.title || '请完成基础配置 · Complete basic setup')}`}</span>
            <button class="btn sm" id="btn-goto-next">${r.canScan ? '查看清单 · Checklist' : '去完成 · Continue'}</button>
          </div>`
      : '';

    const checks = (r.checks || [])
      .map(
        (c) => `
      <div class="check-item ${c.done ? 'done' : ''}" data-cta="${esc(c.cta)}">
        <div class="check-box">${c.done ? '✓' : ''}</div>
        <div class="check-body">
          <div class="check-title">${esc(c.title)}</div>
          <div class="check-hint">${esc(c.hint)}</div>
        </div>
      </div>`
      )
      .join('');

    const topRows = (stats.topThreats || [])
      .map(
        (c) => `
      <div class="list-item" data-open="${esc(c.id)}">
        <div class="avatar">${esc(avatarText(c.name))}</div>
        <div class="item-main">
          <div class="item-title">${esc(c.name)}</div>
          <div class="item-sub">${esc(c.company || c.category || '—')} · ${esc(money(c.price, c.price_unit))}</div>
        </div>
        <span class="threat-pill ${threatClass(c.threat_score)}">${esc(threatLabel(c.threat_score))}</span>
      </div>`
      )
      .join('') ||
      emptyState('◎', '还没有已确认 · Confirmed竞品 · No confirmed competitors yet', '完成扫描后，在待确认队列 · Pending queue中确认入库 · After scan, confirm items in the pending queue', '去扫描 · Go scan', 'dash-to-scan');

    const pendingRows = (stats.pendingList || [])
      .map(
        (c) => `
      <div class="list-item" data-open="${esc(c.id)}">
        <div class="avatar">${esc(avatarText(c.name))}</div>
        <div class="item-main">
          <div class="item-title">${esc(c.name)}</div>
          <div class="item-sub">${esc(c.threat_reason || c.description || '待确认')}</div>
        </div>
        <div class="row-actions" onclick="event.stopPropagation()">
          <button class="btn sm success" data-confirm="${esc(c.id)}">确认 · Confirm</button>
          <button class="btn sm danger" data-reject="${esc(c.id)}">忽略 · Dismiss</button>
        </div>
      </div>`
      )
      .join('') || '<p class="muted empty-hint">没有待确认项 — 干净利落 · Nothing pending</p>';

    const cov = stats.coverage || {};
    const histRows = (history || [])
      .map(
        (h) => `
      <tr class="clickable-row" data-history-id="${esc(h.id)}" title="点击查看详情 · Click for details">
        <td>${esc(fmtTime(h.started_at))}</td>
        <td>
          <span class="chip ${h.status === 'done' ? 'green' : h.status === 'error' ? 'red' : 'blue'}">${esc(h.status)}</span>
          ${h.trigger === 'loop' ? '<span class="chip purple">后台 · BG</span>' : '<span class="chip">手动 · Manual</span>'}
        </td>
        <td>${h.found_count ?? 0}</td>
        <td>${h.new_count ?? 0}</td>
        <td>${h.threat_count ?? 0}</td>
        <td class="muted">${esc(h.summary || h.error || h.product_name || '—')}</td>
      </tr>`
      )
      .join('') || '<tr><td colspan="6" class="muted">暂无扫描记录 · No scan history</td></tr>';

    return `
      ${banner}
      <div class="grid stats">
        <div class="card stat-card">
          <div class="stat-label">竞品总量 · Total competitors</div>
          <div class="stat-value">${stats.total}</div>
          <div class="stat-hint">已确认 · Confirmed Confirmed ${stats.confirmed} · 待确认 Pending ${stats.pending}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">高威胁 · High threat</div>
          <div class="stat-value" style="color:var(--danger)">${stats.highThreat}</div>
          <div class="stat-hint">威胁指数 ≥ 65% · Threat score ≥ 65%</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">平均威胁 · Avg threat</div>
          <div class="stat-value">${Math.round((stats.avgThreat || 0) * 100)}%</div>
          <div class="stat-hint">已确认 · Confirmed竞品均值 · Mean of confirmed</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">情报完整度 · Intel completeness</div>
          <div class="stat-value">${Math.round(((cov.price || 0) + (cov.channels || 0) + (cov.specs || 0)) / 3)}%</div>
          <div class="stat-hint">价格 Price ${cov.price || 0}% · 渠道 Channels ${cov.channels || 0}% · 规格 Specs ${cov.specs || 0}%</div>
        </div>
      </div>

      <div class="grid ${checklistComplete ? '' : 'two'} section-gap">
        ${
          checklistComplete
            ? ''
            : `<div class="card">
          <h3>配置清单 · Setup checklist <span class="muted" style="font-weight:500;font-size:12px">${r.percent || 0}%</span></h3>
          <div class="check-list">${checks}</div>
        </div>`
        }
        <div class="card">
          <h3>待确认队列 · Pending queue</h3>
          ${pendingRows}
        </div>
      </div>

      <div class="grid two section-gap">
        <div class="card">
          <h3>最具威胁 · Top threats <button class="btn sm" id="btn-reanalyze" title="按判定规则重算威胁分 · Rescore by rules">全库重算判定 · Rescore all</button></h3>
          ${topRows}
        </div>
        <div class="card">
          <h3>扫描历史 · Scan history</h3>
          <table class="table">
            <thead>
              <tr><th>时间 · Time</th><th>状态 · Status</th><th>发现 · Found</th><th>新增 · New</th><th>高威胁 · High threat</th><th>摘要 · Summary</th></tr>
            </thead>
            <tbody>${histRows}</tbody>
          </table>
        </div>
      </div>`;
  }

  function bindDashboard() {
    $$('[data-open]').forEach((el) => el.addEventListener('click', () => openCompetitor(el.dataset.open)));
    $$('[data-confirm]').forEach((el) =>
      el.addEventListener('click', async () => {
        try {
          await call(api.confirmCompetitor(el.dataset.confirm));
          toast('已确认 · Confirmed入库 · Confirmed & saved', 'success');
          renderPage();
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );
    $$('[data-reject]').forEach((el) =>
      el.addEventListener('click', async () => {
        try {
          await call(api.rejectCompetitor(el.dataset.reject));
          toast('已忽略 · Dismissed', 'info');
          renderPage();
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );
    $$('[data-cta]').forEach((el) =>
      el.addEventListener('click', () => {
        if (el.dataset.cta) navigate(el.dataset.cta);
      })
    );
    $('#btn-goto-next')?.addEventListener('click', () => {
      const next = state.readiness?.next;
      navigate(next?.cta || 'settings');
    });
    $('#dash-to-scan')?.addEventListener('click', () => navigate('scan'));
    $('#btn-reanalyze')?.addEventListener('click', async () => {
      if (state.threatRunning) {
        toast('任务进行中… · In progress… · Task in progress…', 'info');
        return;
      }
      state.threatRunning = true;
      showThreatProgress(true, '全库重算判定 · Rescore all… · Rescoring all…', 0);
      try {
        toast('按判定规则重算威胁分 · Rescore by rules… · Rescoring by rules…', 'info');
        const res = await call(api.analyzeAllThreats());
        toast(`判定已更新 · Updated: ${res?.competitorCount ?? 0} competitors`, 'success');
        showThreatProgress(true, '完成 · Done', 100);
        renderPage();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        state.threatRunning = false;
        setTimeout(() => showThreatProgress(false), 2500);
      }
    });
    $$('[data-history-id]').forEach((el) => {
      el.addEventListener('click', () => openScanHistory(el.dataset.historyId));
    });
  }

  async function openScanHistory(id) {
    try {
      const h = await call(api.getHistory(id));
      const logs = (h.logs || [])
        .map(
          (l) =>
            `<div class="scan-log-line"><span class="t">${esc(fmtTime(l.at))}</span><span class="m">${esc(l.message)}</span>${l.percent != null ? `<span class="p">${l.percent}%</span>` : ''}</div>`
        )
        .join('');
      const threats = (h.threats || [])
        .map(
          (t) =>
            `<div class="list-item" ${t.id ? `data-open="${esc(t.id)}"` : ''}>
              <div class="item-main">
                <div class="item-title">${esc(t.name)}</div>
                <div class="item-sub">${esc(t.reason || '')}</div>
              </div>
              <span class="threat-pill ${threatClass(t.threatScore || 0)}">${Math.round((t.threatScore || 0) * 100)}%</span>
            </div>`
        )
        .join('');
      const names = (h.found_names || []).map((n) => `<span class="chip">${esc(n)}</span>`).join('');
      const news = (h.new_names || []).map((n) => `<span class="chip green">${esc(n)}</span>`).join('');
      const saved = (h.details?.saved || [])
        .map(
          (s) =>
            `<tr>
              <td>${esc(s.name)}</td>
              <td>${Math.round((s.threat_score || 0) * 100)}%</td>
              <td>${esc(statusText(s.status))}</td>
              <td>${esc(money(s.price))}${s.price_range ? ' · ' + esc(s.price_range) : ''}</td>
              <td>${s.id ? `<button class="btn sm" data-open="${esc(s.id)}">详情 · Details</button>` : '—'}</td>
            </tr>`
        )
        .join('');

      $('#modal-card').innerHTML = `
        <div class="flex-between">
          <div>
            <h2 style="font-size:18px">扫描详情 · Scan details</h2>
            <p class="muted" style="margin-top:4px">${esc(fmtTime(h.started_at))} → ${esc(fmtTime(h.finished_at) || '进行中 · In progress')}</p>
          </div>
          <div>
            <span class="chip ${h.status === 'done' ? 'green' : h.status === 'error' ? 'red' : 'blue'}">${esc(h.status)}</span>
            ${h.trigger === 'loop' ? '<span class="chip purple">后台 Loop · Background Loop</span>' : '<span class="chip">手动 · Manual</span>'}
          </div>
        </div>
        <div class="kv section-gap">
          <div class="k">基准产品 · Baseline product</div><div>${esc(h.product_name || h.details?.product || '—')}</div>
          <div class="k">搜索意图 · Search intent</div><div>${esc(h.query || '—')}</div>
          <div class="k">发现 Found / 新增 New / 高威胁 High threat</div>
          <div>${h.found_count ?? 0} / ${h.new_count ?? 0} / ${h.threat_count ?? 0}</div>
          <div class="k">摘要 · Summary</div><div>${esc(h.summary || h.error || '—')}</div>
        </div>
        ${names ? `<h3 style="font-size:13px;margin:14px 0 8px">发现竞品 · Found competitors</h3><div>${names}</div>` : ''}
        ${news ? `<h3 style="font-size:13px;margin:14px 0 8px">本轮新增 · New this run</h3><div>${news}</div>` : ''}
        ${threats ? `<h3 style="font-size:13px;margin:14px 0 8px">高威胁 · High threat</h3>${threats}` : ''}
        ${
          saved
            ? `<h3 style="font-size:13px;margin:14px 0 8px">入库明细 · Saved items</h3>
          <div class="dim-table-wrap" style="border:none"><table class="table">
            <thead><tr><th>名称</th><th>威胁</th><th>状态 · Status</th><th>价格 · Price</th><th></th></tr></thead>
            <tbody>${saved}</tbody>
          </table></div>`
            : ''
        }
        <h3 style="font-size:13px;margin:14px 0 8px">运行日志 · Run log (${(h.logs || []).length})</h3>
        <div class="scan-log-box">${logs || '<p class="muted">无逐步日志（旧记录） · No step logs (legacy)</p>'}</div>
        <div class="flex-between section-gap">
          <span class="muted" style="font-size:12px">后台扫描与手动扫描共用此详情 · Background & manual scans share this view</span>
          <button class="btn primary" data-close-modal>关闭 · Close</button>
        </div>`;
      $('#modal').classList.remove('hidden');
      $$('[data-open]', $('#modal-card')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeModal();
          openCompetitor(btn.dataset.open);
        });
      });
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function dimOptsHtml(selected) {
    const dims =
      (typeof window !== 'undefined' && window.ThreatVizDims) || [
        { key: 'threat_score', label: '综合威胁 · Overall' },
        { key: 'price', label: '价格竞争力 · Price' },
        { key: 'category', label: '品类重合 · Category' },
        { key: 'features', label: '规格/功能 · Features' },
        { key: 'channels', label: '渠道重合 · Channels' },
        { key: 'positioning', label: '定位相似 · Positioning' },
        { key: 'price_edge', label: '价格压制 · Price pressure' },
        { key: 'channel_edge', label: '渠道广度 · Channel breadth' },
        { key: 'completeness', label: '情报完整度 · Intel completeness · Completeness' },
      ];
    return dims
      .map(
        (d) =>
          `<option value="${esc(d.key)}" ${d.key === selected ? 'selected' : ''}>${esc(d.label)}</option>`
      )
      .join('');
  }

  async function pageCompetitors() {
    const list = await call(api.listCompetitors({}));
    state.compAll = list;
    state.compCache = list;
    // 加载已缓存的对比表（不触碰判定）
    try {
      if (!state.compareMatrix) {
        state.compareMatrix = await call(api.getCompareMatrix());
      }
    } catch {
      /* ignore */
    }
    if (!list.length) {
      return `
        <div class="card">
          ${emptyState('◎', '竞品库是空的 · Competitor library is empty', '运行智能扫描，或手动添加 · Add manually第一家竞品 · Run Smart Scan or add manually', '去扫描 · Go scan', 'empty-to-scan')}
          <div style="text-align:center;margin-top:-8px;padding-bottom:24px">
            <button class="btn" id="btn-add-manual">手动添加 · Add manually</button>
          </div>
        </div>`;
    }

    const view = state.compView || 'space';
    return `
      <div class="banner">
        <span>判定 Scoring: BM25+RAG · <strong>对比表 Compare</strong>: param-by-param (does not change scores)</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm primary" id="btn-compare-matrix" title="按规格参数一条一条对比，不写回威胁判定 · Param compare; does not write scores">参数对比 · Compare表 · Param compare</button>
          <button class="btn sm" id="btn-rag-rerank" title="按判定规则重算威胁分 · Rescore by rules">全库重算判定 · Rescore all</button>
        </div>
      </div>
      <div id="threat-progress-bar" class="threat-progress hidden">
        <div class="threat-progress-top">
          <span id="threat-progress-text">待命 · Idle</span>
          <strong id="threat-progress-pct">0%</strong>
        </div>
        <div class="progress"><i id="threat-progress-fill"></i></div>
      </div>
      <div class="toolbar">
        <input class="search" id="comp-search" type="text" placeholder="搜索名称 / 公司 / 描述… · Search name / company / description…" />
        <select id="comp-status">
          <option value="">全部状态 · All statuses</option>
          <option value="pending">待人工确认 · Pending review</option>
          <option value="confirmed">已确认 · Confirmed</option>
          <option value="rejected">已忽略 · Dismissed</option>
        </select>
        <select id="comp-threat">
          <option value="">全部威胁 · All threats</option>
          <option value="0.75">极高 Extreme ≥75%</option>
          <option value="0.65">高威胁 High ≥65%</option>
          <option value="0.4">中高 Mid-high ≥40%</option>
        </select>
        <select id="comp-method">
          <option value="">全部方法 · All methods</option>
          <option value="rag_bm25">RAG+BM25</option>
          <option value="rules">仅规则 · Rules only</option>
          <option value="rules_fallback">规则回退 · Rules fallback</option>
        </select>
        <div class="view-tabs" id="view-tabs">
          <button type="button" data-view="space" class="${view === 'space' ? 'active' : ''}">空间图 · Space</button>
          <button type="button" data-view="cards" class="${view === 'cards' ? 'active' : ''}">卡片 · Cards</button>
          <button type="button" data-view="table" class="${view === 'table' ? 'active' : ''}">高维表 · Table</button>
          <button type="button" data-view="compare" class="${view === 'compare' ? 'active' : ''}">参数对比 · Compare</button>
        </div>
        <div class="spacer"></div>
        <button class="btn" id="btn-export-csv">导出 · Export</button>
        <button class="btn" id="btn-add-manual">手动添加 · Add manually</button>
        <button class="btn primary" id="btn-goto-scan">去扫描 · Go scan</button>
      </div>
      <div id="comp-main" class="comp-layout">
        ${renderCompMain(list, view)}
      </div>`;
  }

  function renderCompMain(list, view) {
    if (view === 'space') {
      return `
        <div class="viz-panel">
          <div class="viz-toolbar">
            <div class="seg" id="viz-mode">
              <button type="button" data-mode="3d" class="active">3D</button>
              <button type="button" data-mode="2d">2D</button>
              <button type="button" data-mode="1d">1D</button>
            </div>
            <div class="viz-axis-pick">
              <label>X <select id="viz-x">${dimOptsHtml('price')}</select></label>
              <label id="viz-y-wrap">Y <select id="viz-y">${dimOptsHtml('features')}</select></label>
              <label id="viz-z-wrap">Z <select id="viz-z">${dimOptsHtml('channels')}</select></label>
            </div>
            <label class="muted" style="font-size:12px;display:flex;align-items:center;gap:6px">
              空间基准 · Space baseline
              <select id="viz-baseline" style="min-width:140px"></select>
            </label>
            <span class="muted" style="font-size:11px;margin-left:auto">蓝钻 Blue=baseline · 青钻 Teal=other products · 球 Ball=competitors</span>
          </div>
          <div class="viz-canvas-wrap" id="viz-canvas"></div>
          <div class="viz-legend">
            <span><i class="swatch" style="background:#6b9bff"></i>当前基准 · Active baseline</span>
            <span><i class="swatch" style="background:#2dd4bf"></i>其他我方 · Other ours</span>
            <span><i class="swatch" style="background:#f43f5e"></i>高威胁连线 · High-threat links</span>
            <span class="viz-grad"><span>低</span><i></i><span>高</span></span>
          </div>
          <p class="viz-hint">拖拽旋转 · 滚轮缩放 · 点击查看详情 · Click for details · Drag to rotate, scroll to zoom. Multi-product: max threat; origin is <strong>active baseline</strong> — rescore after switch.</p>
        </div>
        <div class="comp-grid" id="comp-cards-mini">
          ${list.slice(0, 6).map((c) => compCard(c)).join('')}
        </div>`;
    }
    if (view === 'cards') {
      return `<div class="comp-grid" id="comp-cards">${list.map((c) => compCard(c)).join('') || '<p class="muted empty-hint">无匹配 · No matches</p>'}</div>`;
    }
    if (view === 'compare') {
      return renderCompareMatrixHtml(state.compareMatrix);
    }
    // high-dim table
    return `
      <div class="dim-table-wrap">
        <table class="table" id="dim-table">
          <thead>
            <tr>
              <th>竞品 · Competitor</th>
              <th>综合威胁 · Overall</th>
              <th>价格 · Price</th>
              <th>品类 · Category</th>
              <th>规格 · Specs</th>
              <th>渠道维 · Channels</th>
              <th>定位 · Positioning</th>
              <th>价格压制 · Price pressure</th>
              <th>渠道广 · Channel reach</th>
              <th>完整度 · Completeness</th>
              <th>标价 · List price</th>
              <th>销售渠道 · Sales channels</th>
              <th>状态 · Status</th>
              <th>操作 · Actions</th>
            </tr>
          </thead>
          <tbody id="comp-tbody">${list.map((c) => dimRow(c)).join('')}</tbody>
        </table>
      </div>
      <p class="muted" style="font-size:12px;margin-top:8px">高维（≥4）用表 · High-dim (≥4) table; use Space view for 1–3 dims.</p>`;
  }

  /** 参数级对比表：规格/价格/品类/渠道 一条一条遍历（非判定标准） */
  function renderCompareMatrixHtml(matrix) {
    // 旧版威胁维度矩阵缓存 → 提示重生成
    if (matrix && matrix.dimMeta && matrix.type !== 'param-compare') {
      return `
        <div class="card compare-empty">
          <h3 style="margin-bottom:8px">参数对比 · Compare表 · Param compare</h3>
          <p class="muted" style="margin-bottom:14px">检测到旧版对比缓存 · Legacy compare cache — regenerate<strong>参数级</strong>对比表。</p>
          <button class="btn primary" id="btn-run-compare">生成参数对比 · Compare表 · Param compare</button>
        </div>`;
    }

    if (!matrix || !matrix.rows?.length) {
      return `
        <div class="card compare-empty">
          <h3 style="margin-bottom:8px">参数对比 · Compare表 · Param compare</h3>
          <p class="muted" style="margin-bottom:14px;line-height:1.65">
            对每个<strong>我方产品 · Our product × 竞品</strong>，把<strong>规格参数逐项</strong>对齐比较（含标价、品类、渠道）。
            <br/>例如：平台、ATS、求职信… 一行一个参数，只做分析 (analysis only), 
            <strong>不写入威胁判定分 · Does not write threat scores</strong>。
          </p>
          <button class="btn primary" id="btn-run-compare">生成参数对比 · Compare表 · Param compare</button>
        </div>`;
    }

    const products = matrix.products || [];
    const productOpts = [
      `<option value="">全部我方产品 · Our product · All our products</option>`,
      ...products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`),
    ].join('');

    const statusOpts = [
      ['', '全部状态 · All statuses'],
      ['diff', '不同 / 数值差'],
      ['same', '相同 · Same'],
      ['ours_only', '仅我方有 · Ours only'],
      ['theirs_only', '仅竞品有 · Theirs only'],
    ]
      .map(([v, l]) => `<option value="${v}">${l}</option>`)
      .join('');

    const body = matrix.rows
      .map((r) => {
        const st = r.status || '';
        return `
        <tr class="param-row status-${esc(st)}" data-open="${esc(r.competitorId)}" data-product="${esc(r.productId || '')}" data-status="${esc(st)}">
          <td class="sticky-col">
            <div class="item-title" title="${esc(r.productName)}">${esc(r.productName)}</div>
          </td>
          <td>
            <div class="item-title" title="${esc(r.competitorName)}">${esc(r.competitorName)}</div>
            <div class="item-sub">${esc(r.company || '')}</div>
          </td>
          <td>
            <strong>${esc(r.param)}</strong>
            ${r.paramAlt ? `<div class="item-sub">竞品键 · Their key: ${esc(r.paramAlt)}</div>` : ''}
            ${r.group === 'base' ? '<span class="chip">基础</span>' : '<span class="chip purple">规格</span>'}
          </td>
          <td class="param-val" title="${esc(r.ourValue)}">${esc(r.ourValue || '—')}</td>
          <td class="param-val" title="${esc(r.theirValue)}">${esc(r.theirValue || '—')}</td>
          <td><span class="param-status st-${esc(st)}">${esc(r.statusLabel || st)}</span></td>
        </tr>`;
      })
      .join('');

    return `
      <div class="card compare-toolbar">
        <div>
          <h3 style="margin:0 0 4px">参数对比 · Compare · ${matrix.productCount || products.length} 我方 × ${matrix.competitorCount || 0} 竞品</h3>
          <p class="muted" style="font-size:12px;margin:0">
            ${esc(fmtTime(matrix.updatedAt))} · 共 <strong>${matrix.paramRowCount || matrix.rows.length}</strong> 行参数 ·
            <strong>不改威胁判定 · Does not change threat scores</strong>
          </p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="compare-filter-product" style="min-width:140px">${productOpts}</select>
          <select id="compare-filter-status" style="min-width:120px">${statusOpts}</select>
          <button class="btn sm" id="btn-run-compare">重新生成 · Regenerate</button>
        </div>
      </div>
      <div class="dim-table-wrap compare-table-wrap">
        <table class="table compare-table param-compare-table" id="compare-table">
          <thead>
            <tr>
              <th class="sticky-col">我方产品 · Our product</th>
              <th>竞品 · Competitor</th>
              <th>参数 · Param</th>
              <th>我方值 · Ours</th>
              <th>竞品值 · Theirs</th>
              <th>对比 · Compare</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="muted" style="font-size:12px;margin-top:8px">
        同名/近义参数名会自动对齐 · Same/similar param names auto-align（如「ATS 关键词评分」与「ATS_优化」需人工看值）。点击行打开竞品详情。
      </p>`;
  }

  function methodLabel(m) {
    return (
      {
        rag_bm25: 'RAG+BM25',
        rules: '规则 · Rules',
        rules_fallback: '规则回退 · Rules fallback',
      }[m] || m || '—'
    );
  }

  function dimPct(c, key) {
    if (key === 'threat') return Math.round((c.threat_score || 0) * 100);
    const d = c.threat_dimensions || {};
    return Math.round((d[key] || 0) * 100);
  }

  /** 卡片内长文：展示截断，完整内容放 title */
  function clampText(s, max = 48) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length <= max) return t;
    return `${t.slice(0, max - 1)}…`;
  }

  function priceCardHtml(c) {
    const main = money(c.price, c.price_unit);
    const rangeRaw = (c.price_range || '').trim();
    const range = rangeRaw ? clampText(rangeRaw, 56) : '';
    const full = [main !== '—' ? main : '', rangeRaw].filter(Boolean).join(' · ') || '—';
    return `
      <div class="k">价格 · Price</div>
      <div class="v" title="${esc(full)}">
        <span class="price-main">${esc(main)}</span>${
          range ? `<span class="price-range"> · ${esc(range)}</span>` : ''
        }
      </div>`;
  }

  function compCard(c) {
    const channels = (c.channels || [])
      .slice(0, 3)
      .map((ch) => {
        const name = typeof ch === 'string' ? ch : ch.name;
        return `<span class="chip" title="${esc(name)}">${esc(clampText(name, 18))}</span>`;
      })
      .join('');
    return `
      <div class="comp-card" data-open-card="${esc(c.id)}">
        <div class="comp-card-head">
          <div class="avatar">${esc(avatarText(c.name))}</div>
          <div class="item-main">
            <div class="item-title" title="${esc(c.name)}">${esc(c.name)}</div>
            <div class="item-sub" title="${esc(c.company || c.category || '')}">${esc(c.company || c.category || '—')}</div>
          </div>
          <span class="threat-pill ${threatClass(c.threat_score)}">${Math.round((c.threat_score || 0) * 100)}%</span>
        </div>
        <div class="threat-bar"><i style="width:${Math.round((c.threat_score || 0) * 100)}%"></i></div>
        <div class="comp-card-meta">
          <div>${priceCardHtml(c)}</div>
          <div>
            <div class="k">状态 · Status</div>
            <div class="v is-short"><span class="status-dot status-${esc(c.status)}"></span>${esc(statusText(c.status))}</div>
          </div>
          <div>
            <div class="k">方法 · Method</div>
            <div class="v is-short" title="${esc(methodLabel(c.threat_method))}">${esc(methodLabel(c.threat_method))}</div>
          </div>
          <div>
            <div class="k">价/规/渠 · P/S/C</div>
            <div class="v is-short">${dimPct(c, 'price')}/${dimPct(c, 'features')}/${dimPct(c, 'channels')}</div>
          </div>
        </div>
        <div class="comp-card-channels">${channels || '<span class="muted">无渠道 · No channels</span>'}</div>
        <div class="comp-card-actions" onclick="event.stopPropagation()">
          <button class="btn sm" data-open="${esc(c.id)}">详情 · Details</button>
          ${c.status === 'pending' ? `<button class="btn sm success" data-confirm="${esc(c.id)}">确认 · Confirm</button>` : ''}
          <button class="btn sm" data-verify="${esc(c.id)}">Agent</button>
        </div>
      </div>`;
  }

  function dimRow(c) {
    const ch = (c.channels || [])
      .slice(0, 2)
      .map((x) => (typeof x === 'string' ? x : x.name))
      .join('、');
    return `
      <tr>
        <td title="${esc(c.name)}">${esc(c.name)}</td>
        <td><strong style="color:${(c.threat_score || 0) >= 0.65 ? 'var(--danger)' : 'inherit'}">${dimPct(c, 'threat')}%</strong></td>
        <td>${dimPct(c, 'price')}%</td>
        <td>${dimPct(c, 'category')}%</td>
        <td>${dimPct(c, 'features')}%</td>
        <td>${dimPct(c, 'channels')}%</td>
        <td>${dimPct(c, 'positioning')}%</td>
        <td>${dimPct(c, 'price_edge')}%</td>
        <td>${dimPct(c, 'channel_edge')}%</td>
        <td>${dimPct(c, 'completeness')}%</td>
        <td>${esc(money(c.price, c.price_unit))}</td>
        <td title="${esc(ch)}">${esc(ch || '—')}</td>
        <td>${esc(statusText(c.status))}</td>
        <td><button class="btn sm" data-open="${esc(c.id)}">详情 · Details</button></td>
      </tr>`;
  }

  async function mountThreatViz(list) {
    disposeThreatViz();
    const el = $('#viz-canvas');
    if (!el) return;
    if (!window.ThreatViz) {
      el.innerHTML =
        '<p class="muted empty-hint" style="padding:40px">Three.js 可视化加载中… · Loading… · Loading visualization… · Loading viz… switch view to retry</p>';
      setTimeout(() => {
        if (window.ThreatViz && state.page === 'competitors' && state.compView === 'space') {
          mountThreatViz(list);
        }
      }, 400);
      return;
    }
    let products = [];
    let activeId = null;
    try {
      const pl = await call(api.listProducts());
      products = pl.products || [];
      activeId = pl.activeId || products[0]?.id || null;
    } catch {
      const p = state.bootstrap?.product;
      products = p?.name ? [p] : [];
    }
    const active = products.find((p) => p.id === activeId) || products[0] || null;

    const sel = $('#viz-baseline');
    if (sel) {
      sel.innerHTML = products.length
        ? products
            .map(
              (p) =>
                `<option value="${esc(p.id)}" ${p.id === activeId ? 'selected' : ''}>${esc(p.name)}</option>`
            )
            .join('')
        : '<option value="">未配置产品 · No product configured</option>';
      sel.onchange = async () => {
        const id = sel.value;
        if (!id) return;
        try {
          await call(api.setActiveProduct(id));
          const next = products.find((p) => p.id === id);
          state.threatViz?.setProducts(products, id);
          toast(`空间基准 · Space baseline：${next?.name || id}`, 'info');
        } catch (e) {
          toast(e.message, 'error');
        }
      };
    }

    state.threatViz = new window.ThreatViz(el, {
      mode: '3d',
      x: 'price',
      y: 'features',
      z: 'channels',
      product: active,
      products,
      activeProductId: activeId,
      onSelect: (c) => {
        if (c?.id) openCompetitor(c.id);
      },
      onSelectProduct: async (p) => {
        if (!p?.id) return;
        try {
          await call(api.setActiveProduct(p.id));
          if (sel) sel.value = p.id;
          state.threatViz?.setProducts(products, p.id);
          toast(`已切换基准 · Baseline set: ${p.name}`, 'success');
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    });
    state.threatViz.renderData(list);
  }

  function updateAxisVisibility(mode) {
    const y = $('#viz-y-wrap');
    const z = $('#viz-z-wrap');
    if (y) y.style.display = mode === '1d' ? 'none' : '';
    if (z) z.style.display = mode === '3d' ? '' : 'none';
  }

  function bindCompetitors() {
    $('#empty-to-scan')?.addEventListener('click', () => navigate('scan'));
    $('#btn-goto-scan')?.addEventListener('click', () => navigate('scan'));
    $('#btn-add-manual')?.addEventListener('click', () => showManualAdd());
    $('#btn-export-csv')?.addEventListener('click', async () => {
      try {
        const res = await call(api.exportCompetitors('csv'));
        if (!res.canceled) toast(`已导出 · Exported ${res.count} rows`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    const runCompareMatrix = async () => {
      if (state.threatRunning) {
        toast('任务进行中… · In progress… · Task in progress…', 'info');
        return;
      }
      state.threatRunning = true;
      showThreatProgress(true, '参数逐项对比中… · Comparing params…', 0);
      try {
        toast('正在按规格参数逐条对比… · Comparing params…', 'info');
        const matrix = await call(api.compareProductsMatrix());
        state.compareMatrix = matrix;
        state.compView = 'compare';
        toast(
          `参数对比 · Compare完成：${matrix.paramRowCount || 0} 行（${matrix.productCount} 产品 × ${matrix.competitorCount} 竞品，未改判定）`,
          'success'
        );
        showThreatProgress(true, '完成 · Done', 100);
        renderPage();
      } catch (e) {
        toast(e.message, 'error');
        showThreatProgress(true, e.message || '失败 · Failed', state.threatLastPercent || 0);
      } finally {
        state.threatRunning = false;
        setTimeout(() => showThreatProgress(false), 2500);
      }
    };

    const applyCompareFilters = () => {
      const pid = $('#compare-filter-product')?.value || '';
      const st = $('#compare-filter-status')?.value || '';
      $$('#compare-table tbody tr').forEach((tr) => {
        const okP = !pid || tr.dataset.product === pid;
        const okS =
          !st ||
          tr.dataset.status === st ||
          (st === 'diff' &&
            ['diff', 'ours_higher', 'theirs_higher'].includes(tr.dataset.status));
        tr.style.display = okP && okS ? '' : 'none';
      });
    };
    const runRerank = async () => {
      if (state.threatRunning) {
        toast('任务进行中… · In progress… · Task in progress…', 'info');
        return;
      }
      state.threatRunning = true;
      showThreatProgress(true, '全库重算判定 · Rescore all… · Rescoring all…', 0);
      try {
        const res = await call(api.analyzeAllThreats());
        toast(`判定已更新 · Updated: ${res?.competitorCount ?? 0} competitors`, 'success');
        showThreatProgress(true, '完成 · Done', 100);
        renderPage();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        state.threatRunning = false;
        setTimeout(() => showThreatProgress(false), 2500);
      }
    };
    $('#btn-rag-rerank')?.addEventListener('click', () => runRerank());
    $('#btn-compare-matrix')?.addEventListener('click', () => {
      state.compView = 'compare';
      renderPage();
    });
    $('#btn-run-compare')?.addEventListener('click', () => runCompareMatrix());
    $('#compare-filter-product')?.addEventListener('change', applyCompareFilters);
    $('#compare-filter-status')?.addEventListener('change', applyCompareFilters);
    $$('#compare-table tbody tr[data-open]').forEach((el) =>
      el.addEventListener('click', () => openCompetitor(el.dataset.open))
    );

    const filterList = (source) => {
      const q = ($('#comp-search')?.value || '').trim().toLowerCase();
      const st = $('#comp-status')?.value;
      const mt = $('#comp-threat')?.value ? Number($('#comp-threat').value) : null;
      const method = $('#comp-method')?.value;
      return (source || []).filter((c) => {
        if (st && c.status !== st) return false;
        if (mt != null && (c.threat_score || 0) < mt) return false;
        if (method && (c.threat_method || '') !== method) return false;
        if (q) {
          const blob = `${c.name || ''} ${c.company || ''} ${c.description || ''}`.toLowerCase();
          if (!blob.includes(q)) return false;
        }
        return true;
      });
    };

    const paintCompView = (list) => {
      state.compCache = list;
      const view = state.compView || 'space';
      const main = $('#comp-main');
      if (!main) return;
      $$('#view-tabs [data-view]').forEach((b) =>
        b.classList.toggle('active', b.dataset.view === view)
      );
      disposeThreatViz();
      main.innerHTML = renderCompMain(list, view);
      wireCompActions();
      if (view === 'space') {
        mountThreatViz(list);
        bindVizControls();
      }
    };

    const applyCompFilter = async (refetch = false) => {
      try {
        if (refetch) {
          const list = await call(
            api.listCompetitors({
              q: $('#comp-search')?.value.trim() || undefined,
              status: $('#comp-status')?.value || undefined,
              minThreat: $('#comp-threat')?.value ? Number($('#comp-threat').value) : undefined,
            })
          );
          // 合并 method 客户端筛选
          const method = $('#comp-method')?.value;
          state.compAll = list;
          paintCompView(method ? list.filter((c) => (c.threat_method || '') === method) : list);
        } else {
          paintCompView(filterList(state.compAll || state.compCache || []));
        }
      } catch (e) {
        toast(e.message, 'error');
      }
    };

    function bindVizControls() {
      $$('#viz-mode [data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          $$('#viz-mode [data-mode]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const mode = btn.dataset.mode;
          updateAxisVisibility(mode);
          state.threatViz?.setMode(mode);
        });
      });
      const syncAxes = () => {
        state.threatViz?.setAxes({
          x: $('#viz-x')?.value,
          y: $('#viz-y')?.value,
          z: $('#viz-z')?.value,
        });
      };
      $('#viz-x')?.addEventListener('change', syncAxes);
      $('#viz-y')?.addEventListener('change', syncAxes);
      $('#viz-z')?.addEventListener('change', syncAxes);
      updateAxisVisibility(state.threatViz?.mode || '3d');
    }

    $$('#view-tabs [data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.compView = btn.dataset.view;
        applyCompFilter(false);
      });
    });

    let timer;
    $('#comp-search')?.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => applyCompFilter(true), 250);
    });
    $('#comp-status')?.addEventListener('change', () => applyCompFilter(true));
    $('#comp-threat')?.addEventListener('change', () => applyCompFilter(true));
    $('#comp-method')?.addEventListener('change', () => applyCompFilter(false));

    wireCompActions();
    if ((state.compView || 'space') === 'space') {
      mountThreatViz(state.compCache || []);
      bindVizControls();
    }
  }

  function wireCompActions() {
    $$('[data-open-card]').forEach((el) =>
      el.addEventListener('click', () => openCompetitor(el.dataset.openCard))
    );
    $$('[data-open]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openCompetitor(el.dataset.open);
      })
    );
    $$('[data-confirm]').forEach((el) =>
      el.addEventListener('click', async () => {
        try {
          await call(api.confirmCompetitor(el.dataset.confirm));
          toast('已确认 · Confirmed', 'success');
          renderPage();
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );
    $$('[data-verify]').forEach((el) =>
      el.addEventListener('click', async () => {
        try {
          toast('Agent 确认中… · Agent verifying…', 'info');
          await call(api.verifyOne(el.dataset.verify));
          toast('Agent 确认完成 · Agent verify done', 'success');
          renderPage();
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );
  }

  function showManualAdd() {
    $('#modal-card').innerHTML = `
      <h2 style="margin-bottom:16px;font-size:18px">手动添加 · Add manually竞品 · Add competitor manually</h2>
      <div class="grid form">
        <div class="form-group"><label>名称 * · Name *</label><input id="m-name" type="text" placeholder="必填" /></div>
        <div class="form-group"><label>公司 · Company</label><input id="m-company" type="text" /></div>
        <div class="form-group"><label>价格 · Price</label><input id="m-price" type="number" min="0" /></div>
        <div class="form-group"><label>品类 · Category</label><input id="m-category" type="text" /></div>
      </div>
      <div class="form-group"><label>描述 · Description</label><textarea id="m-desc"></textarea></div>
      <div class="form-group"><label>渠道（逗号分隔） · Channels (comma-separated)</label><input id="m-channels" type="text" placeholder="天猫, 京东, 官网 · Tmall, JD, site" /></div>
      <div class="form-group"><label>规格 JSON · Specs JSON</label><textarea id="m-specs" placeholder='{"容量":"500ml"}'></textarea></div>
      <div class="flex-between section-gap">
        <button class="btn" data-close-modal>取消 · Cancel</button>
        <button class="btn primary" id="m-save">保存并评分 · Save & score</button>
      </div>`;
    $('#modal').classList.remove('hidden');
    $('#m-save').onclick = async () => {
      try {
        let specs = {};
        const raw = $('#m-specs').value.trim();
        if (raw) specs = JSON.parse(raw);
        await call(
          api.upsertCompetitor({
            name: $('#m-name').value.trim(),
            company: $('#m-company').value.trim(),
            price: $('#m-price').value ? Number($('#m-price').value) : null,
            category: $('#m-category').value.trim(),
            description: $('#m-desc').value.trim(),
            channels: $('#m-channels').value,
            specs,
            status: 'pending',
          })
        );
        closeModal();
        toast('已添加 · Added', 'success');
        navigate('competitors');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }

  async function openCompetitor(id) {
    try {
      const c = await call(api.getCompetitor(id));
      const dims = c.threat_dimensions || {};
      const dimHtml = Object.keys(dimLabels)
        .map((k) => {
          const v = dims[k] ?? 0;
          return `
            <div class="dim-row">
              <span class="label">${esc(dimLabels[k])}</span>
              <div class="dim-track"><i style="width:${Math.round(v * 100)}%"></i></div>
              <span class="val">${Math.round(v * 100)}%</span>
            </div>`;
        })
        .join('');

      const specs = c.specs || {};
      const specsHtml =
        Object.keys(specs).length === 0
          ? '<span class="muted">暂无规格 · No specs</span>'
          : Object.entries(specs)
              .map(([k, v]) => `<span class="chip blue">${esc(k)}: ${esc(v)}</span>`)
              .join('');

      const channels = (c.channels || [])
        .map((ch) => `<span class="chip purple">${esc(typeof ch === 'string' ? ch : ch.name)}</span>`)
        .join('') || '<span class="muted">—</span>';

      const ev = c.rag_evidence || {};
      const neighbors = ev.neighbors || [];
      const evidenceHtml = neighbors.length
        ? neighbors
            .map(
              (n) => `
            <div class="list-item" style="cursor:default">
              <div class="item-main">
                <div class="item-title">${esc(n.name)} <span class="chip blue">BM25 ${esc(n.score)}</span></div>
                <div class="item-sub">${esc(n.snippet || '')}</div>
              </div>
            </div>`
            )
            .join('')
        : '<p class="muted empty-hint">暂无邻域证据 · No neighbor evidence yet</p>';

      $('#modal-card').innerHTML = `
        <div class="flex-between">
          <div>
            <h2 style="font-size:20px">${esc(c.name)}</h2>
            <p class="muted" style="margin-top:4px">${esc(c.company || '未知公司')} · ${esc(c.category || '未分类')}</p>
          </div>
          <div style="text-align:right">
            <span class="threat-pill ${threatClass(c.threat_score)}">${esc(threatLabel(c.threat_score))}</span>
            <div class="item-sub" style="margin-top:6px">${esc(methodLabel(c.threat_method))}${
              c.threat_confidence != null
                ? ` · 置信 ${Math.round(c.threat_confidence * 100)}%`
                : ''
            }</div>
          </div>
        </div>
        <div class="kv section-gap">
          <div class="k">价格 · Price</div><div>${esc(money(c.price, c.price_unit))} ${c.price_range ? `<span class="muted">(${esc(c.price_range)})</span>` : ''}</div>
          <div class="k">状态 · Status</div><div><span class="status-dot status-${esc(c.status)}"></span>${esc(statusText(c.status))} <span class="muted">（人工 · Manual）</span></div>
          <div class="k">自动判定</div><div>${esc(methodLabel(c.threat_method))}${c.rule_score != null ? ` · 规则基线 ${Math.round(c.rule_score * 100)}%` : ''}${c.rag_score != null ? ` · RAG ${Math.round(c.rag_score * 100)}%` : ''}</div>
          <div class="k">官网 · Website</div><div>${c.website ? `<a class="linkish" data-url="${esc(c.website)}">${esc(c.website)}</a>` : '—'}</div>
          <div class="k">self BM25</div><div>${ev.selfBm25 != null ? esc(ev.selfBm25) : '—'}</div>
          <div class="k">最近更新 · Updated</div><div>${esc(fmtTime(c.updated_at))}</div>
        </div>
        <p style="margin:12px 0;color:var(--text-secondary)">${esc(c.description || '暂无描述 · No description')}</p>
        <div class="card" style="padding:12px;margin-bottom:12px;background:var(--bg)">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">RAG 威胁结论 · RAG threat conclusion</div>
          <div>${esc(c.threat_reason || '尚未自动判定 · Not scored yet')}</div>
          ${
            c.primary_product_name
              ? `<div class="item-sub" style="margin-top:8px">最高威胁相对我方 · Highest threat vs ours: <strong>${esc(c.primary_product_name)}</strong></div>`
              : ''
          }
          ${
            Array.isArray(c.threat_vs) && c.threat_vs.length
              ? `<div class="threat-vs-list" style="margin-top:12px">
                  <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">判定参考 · Score reference (max = threat) · use Compare for detail</div>
                  ${c.threat_vs
                    .map(
                      (v) => `
                    <div class="threat-vs-row ${v.productId === c.primary_product_id ? 'is-primary' : ''}">
                      <div class="threat-vs-name">${esc(v.productName || '—')}${
                        v.productId === c.primary_product_id ? ' <span class="chip blue">判定最高 · Top score</span>' : ''
                      }</div>
                      <div class="threat-vs-score">${Math.round((v.score || 0) * 100)}%</div>
                      <div class="threat-vs-meta">${esc(methodLabel(v.method))}</div>
                    </div>`
                    )
                    .join('')}
                </div>`
              : ''
          }
        </div>
        <h3 style="margin:14px 0 8px;font-size:13px">BM25 检索证据 · BM25 evidence</h3>
        ${evidenceHtml}
        <h3 style="margin:14px 0 8px;font-size:13px">多维威胁画像 · Multi-dim threat profile</h3>
        ${dimHtml}
        <h3 style="margin:16px 0 8px;font-size:13px">规格 · Specs</h3>
        <div>${specsHtml}</div>
        <h3 style="margin:16px 0 8px;font-size:13px">渠道 · Channels</h3>
        <div>${channels}</div>
        ${c.notes ? `<h3 style="margin:16px 0 8px;font-size:13px">备注 / Agent · Notes / Agent</h3><div class="pre-box">${esc(c.notes)}</div>` : ''}
        <div class="flex-between section-gap" style="margin-top:20px">
          <div class="row-actions">
            <button class="btn sm danger" id="c-delete">删除 · Delete</button>
            ${c.status === 'pending' ? '<button class="btn sm danger" id="c-reject">忽略 · Dismiss</button>' : ''}
          </div>
          <div class="row-actions">
            <button class="btn" data-close-modal>关闭 · Close</button>
            <button class="btn" id="c-verify">Agent 确认 · Agent verify</button>
            <button class="btn" id="c-rescore" title="按判定规则重算威胁分 · Rescore by rules">重算判定 · Rescore</button>
            ${c.status !== 'confirmed' ? '<button class="btn primary" id="c-confirm">人工确认入库 · Confirm to library</button>' : ''}
          </div>
        </div>`;

      $('#modal').classList.remove('hidden');

      $('[data-url]', $('#modal-card'))?.addEventListener('click', (e) => {
        e.preventDefault();
        api.openExternal(e.currentTarget.dataset.url);
      });
      $('#c-confirm')?.addEventListener('click', async () => {
        await call(api.confirmCompetitor(id));
        toast('已确认 · Confirmed入库 · Confirmed & saved', 'success');
        closeModal();
        renderPage();
      });
      $('#c-reject')?.addEventListener('click', async () => {
        await call(api.rejectCompetitor(id));
        toast('已忽略 · Dismissed', 'info');
        closeModal();
        renderPage();
      });
      $('#c-delete')?.addEventListener('click', async () => {
        if (!confirm('确定删除 · Confirm delete该竞品？· Delete this competitor? Cannot be undone.')) return;
        await call(api.deleteCompetitor(id));
        toast('已删除 · Deleted', 'info');
        closeModal();
        renderPage();
      });
      $('#c-verify')?.addEventListener('click', async () => {
        try {
          toast('Agent 确认中… · Agent verifying…', 'info');
          await call(api.verifyOne(id));
          toast('完成 · Done', 'success');
          openCompetitor(id);
        } catch (e) {
          toast(e.message, 'error');
        }
      });
      $('#c-rescore')?.addEventListener('click', async () => {
        if (state.threatRunning) {
          toast('任务进行中… · In progress… · Task in progress…', 'info');
          return;
        }
        state.threatRunning = true;
        showThreatProgress(true, `重算判定 · Rescore · Rescoring 「${c.name}」…`, 0);
        try {
          const result = await call(api.matchThreat(id));
          toast(
            `判定已更新 · Updated ${Math.round((result.threatScore || 0) * 100)}% (vs ${result.primary_product_name || '—'})`,
            'success'
          );
          openCompetitor(id);
        } catch (e) {
          toast(e.message, 'error');
        } finally {
          state.threatRunning = false;
          setTimeout(() => showThreatProgress(false), 2000);
        }
      });
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modal-card').innerHTML = '';
  }

  /** 扫描流水线指示灯：每灯对应不同阶段 */
  const SCAN_PIPELINE_STEPS = [
    { id: 'start', label: '启动 · Start', hint: '初始化任务 · Init', color: 'cyan' },
    { id: 'discover', label: '发现 · Discover', hint: 'Discover 研究候选 · Research candidates', color: 'violet' },
    { id: 'enrich', label: '补全 · Enrich', hint: 'Enrich 价格/规格/渠道 · Price / specs / channels', color: 'amber' },
    { id: 'threat', label: '威胁 · Threat', hint: 'BM25 + RAG 评分 · Scoring', color: 'rose' },
    { id: 'verify', label: '校验 · Verify', hint: 'Agent 交叉确认 · Agent cross-check', color: 'teal' },
    { id: 'done', label: '完成 · Done', hint: '入库待筛选 · Saved for review', color: 'lime' },
  ];

  function mapScanStageToStep(stage) {
    const s = String(stage || '');
    if (s === 'start') return 'start';
    if (s === 'discover' || s === 'discover-done') return 'discover';
    if (s === 'enrich' || s === 'enrich-warn') return 'enrich';
    if (s === 'rag' || s === 'scored') return 'threat';
    if (s === 'verify' || s === 'agent-verify') return 'verify';
    if (s === 'done') return 'done';
    if (s === 'error') return 'error';
    return null;
  }

  function renderScanPipelineMarkup() {
    const lamps = SCAN_PIPELINE_STEPS.map(
      (step, i) => `
      <div class="scan-pipe-step" data-step="${step.id}" data-color="${step.color}" title="${esc(step.hint)}">
        ${i > 0 ? '<div class="scan-pipe-link" aria-hidden="true"><i></i></div>' : ''}
        <div class="scan-lamp">
          <span class="scan-lamp-core"></span>
          <span class="scan-lamp-ring"></span>
          <span class="scan-lamp-glow"></span>
        </div>
        <div class="scan-pipe-meta">
          <strong>${esc(step.label)}</strong>
          <span class="scan-step-hint">${esc(step.hint)}</span>
        </div>
      </div>`
    ).join('');
    return `
      <div class="scan-pipeline idle" id="scan-pipeline" data-active="" data-status="idle">
        <div class="scan-pipeline-head">
          <div class="scan-pipeline-head-main">
            <div class="scan-pipeline-title">流水线状态 · Pipeline status</div>
            <div class="scan-pipeline-sub" id="scan-stage">就绪 · Ready — waiting to start scan</div>
            <div class="scan-live-row">
              <span class="scan-live-dot" id="scan-live-dot" aria-hidden="true"></span>
              <span class="scan-live-text" id="scan-live-text">待命 · Idle</span>
              <span class="scan-live-sep">·</span>
              <span class="scan-elapsed" id="scan-elapsed">0s</span>
              <span class="scan-live-sep">·</span>
              <span class="scan-activity" id="scan-activity">尚未开始 · Not started</span>
            </div>
          </div>
          <div class="scan-pipeline-pct"><span id="scan-pct-num">0</span>%</div>
        </div>
        <div class="scan-pipeline-track" id="scan-pipeline-track">
          ${lamps}
          <div class="scan-pipeline-sweep" aria-hidden="true"></div>
        </div>
        <div class="progress scan-progress-bar"><i id="scan-progress"></i></div>
      </div>`;
  }

  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}m ${String(r).padStart(2, '0')}s`;
  }

  function stopScanHeartbeat() {
    if (state.scanHeartbeatTimer) {
      clearInterval(state.scanHeartbeatTimer);
      state.scanHeartbeatTimer = null;
    }
  }

  function startScanHeartbeat() {
    stopScanHeartbeat();
    state.scanStartedAt = Date.now();
    state.scanLastProgressAt = Date.now();
    state.scanLastPulseAt = 0;
    const tick = () => {
      if (!state.scanRunning) return;
      const now = Date.now();
      const elapsedEl = $('#scan-elapsed');
      if (elapsedEl) elapsedEl.textContent = formatElapsed(now - (state.scanStartedAt || now));
      const quiet = now - (state.scanLastProgressAt || now);
      const live = $('#scan-live-text');
      const act = $('#scan-activity');
      if (quiet > 12000) {
        if (live) live.textContent = '等待模型响应 · Waiting for model';
        if (act) act.textContent = `仍在处理 · Still working · quiet ${formatElapsed(quiet)} (not stuck)`;
        // 每 15s 写一条心跳日志
        if (now - (state.scanLastPulseAt || 0) >= 15000) {
          state.scanLastPulseAt = now;
          appendScanLog({
            level: 'pulse',
            stage: state.scanLastStage || 'discover',
            message: `心跳 · Heartbeat: still running (${formatElapsed(now - state.scanStartedAt)})`,
          });
        }
      } else if (live) {
        live.textContent = '运行中 · Running';
      }
    };
    tick();
    state.scanHeartbeatTimer = setInterval(tick, 1000);
  }

  function stageBadge(stage) {
    const step = mapScanStageToStep(stage);
    const map = {
      start: '启动 · Start',
      discover: '发现 · Discover',
      enrich: '补全 · Enrich',
      threat: '威胁 · Threat',
      verify: '校验 · Verify',
      done: '完成 · Done',
      error: '错误 · Error',
    };
    return map[step] || stage || '信息 · Info';
  }

  function appendScanLog({ level = 'info', stage = '', message = '' } = {}) {
    const box = $('#scan-console');
    if (!box || !message) return;
    // 清掉占位
    const placeholder = box.querySelector('.scan-log-placeholder');
    if (placeholder) placeholder.remove();

    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    line.className = `scan-log-row level-${level}${stage === 'error' || level === 'err' ? ' is-err' : ''}`;
    line.innerHTML = `
      <span class="scan-log-time">${esc(t)}</span>
      <span class="scan-log-badge stage-${esc(mapScanStageToStep(stage) || 'info')}">${esc(stageBadge(stage))}</span>
      <span class="scan-log-msg" title="${esc(message)}">${esc(message)}</span>`;
    box.appendChild(line);
    // 限制行数，避免 DOM 过大
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function setScanPipeline(stage, message, percent) {
    const root = $('#scan-pipeline');
    if (!root) return;

    const stepId = mapScanStageToStep(stage);
    const order = SCAN_PIPELINE_STEPS.map((s) => s.id);

    if (percent != null) {
      const n = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      const bar = $('#scan-progress');
      if (bar) bar.style.width = `${n}%`;
      const pct = $('#scan-pct-num');
      if (pct) pct.textContent = String(n);
    }

    if (message) {
      const stageEl = $('#scan-stage');
      if (stageEl) stageEl.textContent = message;
      const act = $('#scan-activity');
      if (act) act.textContent = clampText(message, 72);
    }

    if (stepId === 'error') {
      root.classList.remove('idle', 'running', 'done');
      root.classList.add('error');
      root.dataset.status = 'error';
      const live = $('#scan-live-text');
      if (live) live.textContent = '失败 · Failed';
      const active = root.dataset.active || 'start';
      $$('.scan-pipe-step', root).forEach((el) => {
        const id = el.dataset.step;
        el.classList.remove('active', 'done', 'error');
        if (id === active) el.classList.add('error', 'active');
        else if (order.indexOf(id) < order.indexOf(active)) el.classList.add('done');
      });
      return;
    }

    if (!stepId) return;

    root.dataset.active = stepId;
    root.classList.remove('idle', 'error');

    if (stepId === 'done') {
      root.classList.remove('running');
      root.classList.add('done');
      root.dataset.status = 'done';
      const live = $('#scan-live-text');
      if (live) live.textContent = '已完成 · Done';
      $$('.scan-pipe-step', root).forEach((el) => {
        el.classList.remove('active', 'error');
        el.classList.add('done');
      });
      return;
    }

    root.classList.add('running');
    root.classList.remove('done');
    root.dataset.status = 'running';
    const live = $('#scan-live-text');
    if (live) live.textContent = '运行中 · Running';
    const idx = order.indexOf(stepId);
    $$('.scan-pipe-step', root).forEach((el) => {
      const id = el.dataset.step;
      const i = order.indexOf(id);
      el.classList.remove('active', 'done', 'error');
      if (i < idx) el.classList.add('done');
      else if (i === idx) el.classList.add('active');
    });
  }

  function resetScanPipeline() {
    const root = $('#scan-pipeline');
    if (!root) return;
    root.classList.remove('running', 'done', 'error');
    root.classList.add('idle');
    root.dataset.status = 'idle';
    root.dataset.active = '';
    $$('.scan-pipe-step', root).forEach((el) => el.classList.remove('active', 'done', 'error'));
    const bar = $('#scan-progress');
    if (bar) bar.style.width = '0%';
    const pct = $('#scan-pct-num');
    if (pct) pct.textContent = '0';
    const stageEl = $('#scan-stage');
    if (stageEl) stageEl.textContent = '就绪 · Ready — waiting to start scan';
    const live = $('#scan-live-text');
    if (live) live.textContent = '待命 · Idle';
    const elapsed = $('#scan-elapsed');
    if (elapsed) elapsed.textContent = '0s';
    const act = $('#scan-activity');
    if (act) act.textContent = '尚未开始 · Not started';
  }

  function pageScan() {
    const can = state.readiness?.canScan;
    return `
      ${
        !can
          ? `<div class="banner warn">
              <span>扫描前需完成 LLM 与产品配置 · Complete LLM & product setup before scanning — ${esc(state.readiness?.next?.title || '')}</span>
              <button class="btn sm" id="scan-fix-setup">去配置 · Configure</button>
            </div>`
          : ''
      }
      <div class="card scan-hero-card">
        ${renderScanPipelineMarkup()}
      </div>
      <div class="scan-layout">
        <div class="card scan-form-card">
          <h3>发起扫描 · Start a scan</h3>
          <div class="form-group">
            <label>搜索意图 · Search intent（可选）</label>
            <textarea id="scan-query" placeholder="例如 e.g.：智能耳机 主动降噪 500元档 竞品 价格 渠道"></textarea>
            <div class="hint">留空则根据「我的产品」自动生成 · Leave empty to auto-generate from My Products</div>
          </div>
          <div class="form-group">
            <label>候选数量 · Candidate count</label>
            <select id="scan-limit">
              <option value="5">5</option>
              <option value="8" selected>8</option>
              <option value="12">12</option>
            </select>
          </div>
          <div class="flex-between scan-form-actions">
            <span class="muted" style="font-size:12px;line-height:1.4">判定 Scoring: BM25+RAG · param compare in Competitors → Compare</span>
            <button class="btn primary" id="btn-run-scan" ${can ? '' : 'disabled'}>
              <span class="btn-label">开始扫描 · Start scan</span>
            </button>
          </div>
        </div>
        <div class="card scan-log-card">
          <div class="scan-log-head">
            <h3>运行日志 · Run log</h3>
            <span class="muted" id="scan-log-count" style="font-size:12px">结构化 · 实时</span>
          </div>
          <div class="scan-console" id="scan-console">
            <div class="scan-log-placeholder muted">等待扫描任务… · Waiting — stage changes & per-item logs appear here</div>
          </div>
        </div>
      </div>`;
  }

  function bindScan() {
    $('#scan-fix-setup')?.addEventListener('click', () => {
      navigate(state.readiness?.next?.cta || 'settings');
    });

    // 若仍在扫描中切回本页，保持指示灯 running 态
    if (state.scanRunning) {
      setScanPipeline(state.scanLastStage || 'start', state.scanLastMessage || '扫描进行中… · In progress… · Scan in progress…', state.scanLastPercent ?? 5);
      startScanHeartbeat();
    } else {
      resetScanPipeline();
    }

    $('#btn-run-scan')?.addEventListener('click', async () => {
      if (state.scanRunning) return;
      state.scanRunning = true;
      const btn = $('#btn-run-scan');
      btn.disabled = true;
      btn.classList.add('is-loading');
      const label = btn.querySelector('.btn-label');
      if (label) label.textContent = '扫描中… · Scanning…';
      resetScanPipeline();
      const box = $('#scan-console');
      if (box) box.innerHTML = '';
      setScanPipeline('start', '启动中… · Starting…', 5);
      state.scanLastStage = 'start';
      state.scanLastMessage = '启动中… · Starting…';
      state.scanLastPercent = 5;
      startScanHeartbeat();
      appendScanLog({ level: 'info', stage: 'start', message: '开始扫描 · Start scan任务 · Scan task started' });

      try {
        appendScanLog({
          level: 'info',
          stage: 'start',
          message: '威胁判定 · Threat: baseline RAG + multi-product max (no param table here)',
        });
        const res = await call(
          api.runScan({
            query: $('#scan-query').value.trim() || undefined,
            limit: Number($('#scan-limit').value) || 8,
          })
        );
        if (res.readiness) setReadiness(res.readiness);
        setScanPipeline('done', `完成 · 发现 ${res.found} · 新增 ${res.newCount}`, 100);
        state.scanLastStage = 'done';
        state.scanLastPercent = 100;
        appendScanLog({
          level: 'ok',
          stage: 'done',
          message: `扫描完成：发现 ${res.found}，新增 ${res.newCount}，高威胁 ${res.newThreats?.length || 0} · 耗时 ${formatElapsed(Date.now() - state.scanStartedAt)}`,
        });
        toast(`扫描完成 · Scan done, ${res.newCount} new competitors`, 'success');
      } catch (e) {
        setScanPipeline('error', e.message || '失败 · Failed', state.scanLastPercent);
        appendScanLog({ level: 'err', stage: 'error', message: e.message || '扫描失败 · Scan failed' });
        toast(e.message, 'error');
      } finally {
        state.scanRunning = false;
        stopScanHeartbeat();
        btn.disabled = !state.readiness?.canScan;
        btn.classList.remove('is-loading');
        if (label) label.textContent = '开始扫描 · Start scan';
        const live = $('#scan-live-text');
        if (live && state.scanLastStage === 'done') live.textContent = '已完成 · Done';
        else if (live && state.scanLastStage === 'error') live.textContent = '失败 · Failed';
      }
    });
  }

  async function pageProduct() {
    const data = await call(api.listProducts());
    const products = data.products || [];
    const activeId = data.activeId;
    const editingId = state.editingProductId || activeId || null;
    const p = products.find((x) => x.id === editingId) || {
      name: '',
      category: '',
      description: '',
      price: null,
      keywords: [],
      channels: [],
      specs: {},
    };
    state.editingProductId = p.id || null;

    const specsStr =
      p.specs && Object.keys(p.specs).length ? JSON.stringify(p.specs, null, 2) : '';

    const listHtml = products.length
      ? products
          .map(
            (item) => `
        <div class="product-item ${item.id === activeId ? 'active' : ''}" data-edit-product="${esc(item.id)}">
          <div class="avatar">${esc(avatarText(item.name))}</div>
          <div class="meta">
            <div class="name">${esc(item.name)} ${item.id === activeId ? '<span class="chip blue">当前基准 · Active baseline</span>' : ''}</div>
            <div class="sub">${esc(item.category || '未分类')} · ${esc(money(item.price))}</div>
          </div>
          <div class="row-actions" onclick="event.stopPropagation()">
            ${
              item.id !== activeId
                ? `<button class="btn sm" data-activate="${esc(item.id)}">设为基准 · Set baseline</button>`
                : ''
            }
            <button class="btn sm" data-edit-product="${esc(item.id)}">编辑 · Edit</button>
            <button class="btn sm danger" data-del-product="${esc(item.id)}">删除 · Delete</button>
          </div>
        </div>`
          )
          .join('')
      : '<p class="muted empty-hint">还没有产品 · No products yet — add the first below</p>';

    return `
      <div class="banner">
        <span>支持上传规格书 · Spec sheet · Upload specs → AI extract → <strong>逐项人工确认</strong> 后再写入产品</span>
        <button class="btn sm primary" id="btn-upload-spec">选择文件 · Choose files</button>
      </div>
      <div
        class="drop-zone"
        id="spec-drop-zone"
        tabindex="0"
        role="button"
        aria-label="拖拽或点击上传 · Click to upload规格书 · Spec sheet · Drag or click to upload specs"
      >
        <div class="drop-zone-inner">
          <div class="drop-zone-icon">📄</div>
          <div class="drop-zone-title">拖拽规格书 · Spec sheet到这里</div>
          <div class="drop-zone-sub">或点击上传 · Click to upload · multi-file PDF/Word/Excel/TXT/MD/CSV/JSON</div>
        </div>
      </div>
      <div class="grid two section-gap" style="align-items:start">
        <div class="card">
          <h3>
            产品组合 · Product portfolio
            <button class="btn sm primary" id="btn-new-product">+ 添加产品 · Add product</button>
          </h3>
          <p class="muted" style="margin-bottom:12px;font-size:12px">
            可配置多个己方产品。扫描与威胁自动取<strong>对全部产品</strong>的最高威胁；空间图 · Space以「当前基准 · Active baseline」为原点。
          </p>
          <div class="product-list" id="product-list">${listHtml}</div>
        </div>
        <div class="card">
          <h3 id="product-form-title">${p.id ? '编辑 · Edit产品 · Edit product' : '新建产品 · New product'}</h3>
          <input type="hidden" id="p-id" value="${esc(p.id || '')}" />
          <div class="grid form">
            <div class="form-group">
              <label>产品名称 * · Product name *</label>
              <input id="p-name" type="text" value="${esc(p.name || '')}" placeholder="例如 e.g.：Aura 降噪耳机 Pro" />
            </div>
            <div class="form-group">
              <label>品类 · Category</label>
              <input id="p-category" type="text" value="${esc(p.category || '')}" placeholder="消费电子 / consumer electronics / 无线耳机" />
            </div>
            <div class="form-group">
              <label>标价 · List price</label>
              <input id="p-price" type="number" min="0" value="${p.price ?? ''}" placeholder="999" />
            </div>
            <div class="form-group">
              <label>关键词（逗号分隔） · Keywords (comma-separated)</label>
              <input id="p-keywords" type="text" value="${esc((p.keywords || []).join(', '))}" placeholder="ANC, 长续航 / long battery" />
            </div>
          </div>
          <div class="form-group">
            <label>产品描述 · Description</label>
            <textarea id="p-desc" placeholder="核心卖点、目标用户、差异化 · Differentiation…">${esc(p.description || '')}</textarea>
          </div>
          <div class="form-group">
            <label>销售渠道（逗号分隔） · Sales channels (comma-separated)</label>
            <input id="p-channels" type="text" value="${esc((p.channels || []).map((c) => (typeof c === 'string' ? c : c.name)).join(', '))}" placeholder="天猫, 京东, 官网 · Tmall, JD, site" />
          </div>
          <div class="form-group">
            <label>规格 JSON · Specs JSON</label>
            <textarea id="p-specs" style="min-height:100px;font-family:var(--mono)" placeholder='{"降噪":"混合ANC"}'>${esc(specsStr)}</textarea>
          </div>
          <div class="flex-between">
            <span class="muted" id="p-save-msg"></span>
            <div class="row-actions">
              <button class="btn" id="btn-clear-form">清空表单 · Clear form</button>
              <button class="btn primary" id="btn-save-product">${p.id ? '保存修改 · Save' : '添加产品 · Add product'}</button>
            </div>
          </div>
        </div>
      </div>
      <div id="spec-parse-panel" class="card section-gap hidden">
        <div class="flex-between">
          <h3 style="margin:0">规格书 · Spec sheet解析 · Spec parse · confirm manually</h3>
          <button class="btn sm" id="btn-close-parse">收起 · Collapse</button>
        </div>
        <p class="muted" style="font-size:12px;margin:8px 0 12px" id="spec-parse-status">等待上传… · Waiting for upload…</p>
        <div id="spec-parse-sources" class="spec-sources"></div>
        <div id="spec-parse-notes" class="muted" style="font-size:12px;margin:8px 0"></div>
        <div class="flex-between" style="margin:10px 0">
          <div class="row-actions">
            <button class="btn sm" id="btn-spec-all">全选 · Select all</button>
            <button class="btn sm" id="btn-spec-none">全不选 · Clear all</button>
            <button class="btn sm" id="btn-spec-high">仅高置信(≥70%) · High confidence only (≥70%)</button>
          </div>
          <span class="muted" style="font-size:12px" id="spec-parse-count"></span>
        </div>
        <div id="spec-field-list" class="spec-field-list"></div>
        <div class="flex-between section-gap">
          <label class="muted" style="font-size:12px;display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="spec-as-new" /> 导入为<strong>新产品</strong>（不勾选则合并到当前编辑 · Edit产品 · Edit product）
          </label>
          <div class="row-actions">
            <button class="btn" id="btn-spec-to-form">仅填入表单 · Fill form</button>
            <button class="btn primary" id="btn-spec-apply">确认写入产品 · Confirm write to product</button>
          </div>
        </div>
        <details class="section-gap">
          <summary class="muted" style="cursor:pointer;font-size:12px">原文预览 · Source preview</summary>
          <pre class="pre-box" id="spec-preview" style="margin-top:8px;max-height:160px"></pre>
        </details>
      </div>`;
  }

  function confLabel(c) {
    if (c == null || !Number.isFinite(Number(c))) return '';
    const pct = Math.round(Number(c) * 100);
    const cls = pct >= 70 ? 'green' : pct >= 40 ? 'orange' : 'red';
    return `<span class="chip ${cls}">${pct}%</span>`;
  }

  function renderSpecFields(fields) {
    const list = $('#spec-field-list');
    if (!list) return;
    if (!fields?.length) {
      list.innerHTML = '<p class="muted empty-hint">未抽取出可用字段 · No usable fields extracted</p>';
      return;
    }
    const basic = fields.filter((f) => f.group !== 'specs');
    const specs = fields.filter((f) => f.group === 'specs');
    const block = (title, arr) => {
      if (!arr.length) return '';
      return `
        <div class="spec-group">
          <div class="spec-group-title">${esc(title)}</div>
          ${arr
            .map(
              (f) => `
            <label class="spec-field ${f.selected ? 'on' : ''}" data-field-id="${esc(f.id || f.key)}">
              <input type="checkbox" class="spec-check" data-fid="${esc(f.id || f.key)}" ${f.selected ? 'checked' : ''} />
              <div class="spec-field-body">
                <div class="spec-field-head">
                  <strong>${esc(f.label)}</strong>
                  ${confLabel(f.confidence)}
                </div>
                <div class="spec-field-val">${esc(f.display != null ? f.display : f.value)}</div>
              </div>
            </label>`
            )
            .join('')}
        </div>`;
    };
    list.innerHTML = block('基础信息 · Basics', basic) + block('规格参数 · Specs', specs);
    const n = fields.filter((f) => f.selected).length;
    const el = $('#spec-parse-count');
    if (el) el.textContent = `已选 ${n} / ${fields.length} 项`;

    $$('.spec-check').forEach((chk) => {
      chk.addEventListener('change', () => {
        const id = chk.dataset.fid;
        const f = state.specParse?.fields?.find((x) => (x.id || x.key) === id);
        if (f) f.selected = chk.checked;
        const row = chk.closest('.spec-field');
        if (row) row.classList.toggle('on', chk.checked);
        const cnt = state.specParse.fields.filter((x) => x.selected).length;
        if ($('#spec-parse-count')) {
          $('#spec-parse-count').textContent = `已选 ${cnt} / ${state.specParse.fields.length} 项`;
        }
      });
    });
  }

  function showSpecParseResult(result) {
    state.specParse = result;
    const panel = $('#spec-parse-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    const src = (result.sources || [])
      .map(
        (s) =>
          `<span class="chip blue" title="${esc(s.warning || s.method || '')}">${esc(s.filename)} · ${esc(s.method || '')}${s.warning ? ' ⚠' : ''}</span>`
      )
      .join('');
    if ($('#spec-parse-sources')) $('#spec-parse-sources').innerHTML = src || '';
    if ($('#spec-parse-notes')) {
      $('#spec-parse-notes').textContent = result.notes
        ? `抽取说明 · Extract notes: ${result.notes}`
        : result.truncated
          ? '正文过长已截断后解析 · Truncated long body before parse'
          : '';
    }
    if ($('#spec-parse-status')) {
      const conf =
        result.confidence != null ? ` · 总体置信 ${Math.round(result.confidence * 100)}%` : '';
      $('#spec-parse-status').textContent = `解析完成 · Parsed — select fields to import${conf}`;
    }
    if ($('#spec-preview')) $('#spec-preview').textContent = result.preview || '';
    renderSpecFields(result.fields || []);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function fieldsToForm(fields) {
    const selected = (fields || []).filter((f) => f.selected);
    const get = (key) => selected.find((f) => f.key === key);
    const name = get('name');
    const cat = get('category');
    const desc = get('description');
    const price = get('price');
    const kw = get('keywords');
    const ch = get('channels');
    if (name && $('#p-name')) $('#p-name').value = name.value;
    if (cat && $('#p-category')) $('#p-category').value = cat.value;
    if (desc && $('#p-desc')) $('#p-desc').value = desc.value;
    if (price && $('#p-price')) $('#p-price').value = price.value;
    if (kw && $('#p-keywords')) {
      $('#p-keywords').value = Array.isArray(kw.value) ? kw.value.join(', ') : kw.value;
    }
    if (ch && $('#p-channels')) {
      $('#p-channels').value = Array.isArray(ch.value) ? ch.value.join(', ') : ch.value;
    }
    // merge specs into JSON textarea
    const specItems = selected.filter((f) => f.type === 'spec' || String(f.key).startsWith('spec.'));
    if (specItems.length && $('#p-specs')) {
      let cur = {};
      try {
        cur = JSON.parse($('#p-specs').value || '{}');
      } catch {
        cur = {};
      }
      for (const f of specItems) {
        const k = String(f.key).startsWith('spec.') ? f.key.slice(5) : f.label.replace(/^规格\s*·\s*/, '');
        cur[k] = f.value;
      }
      $('#p-specs').value = JSON.stringify(cur, null, 2);
    }
  }

  function bindProduct() {
    const reload = () => renderPage();

    $('#btn-new-product')?.addEventListener('click', () => {
      state.editingProductId = null;
      $('#p-id').value = '';
      $('#p-name').value = '';
      $('#p-category').value = '';
      $('#p-price').value = '';
      $('#p-keywords').value = '';
      $('#p-desc').value = '';
      $('#p-channels').value = '';
      $('#p-specs').value = '';
      const t = $('#product-form-title');
      if (t) t.textContent = '新建产品 · New product';
      toast('填写后点击添加产品 · Fill in then click Add product', 'info');
    });

    $('#btn-clear-form')?.addEventListener('click', () => {
      $('#btn-new-product')?.click();
    });

    $$('[data-edit-product]').forEach((el) => {
      el.addEventListener('click', () => {
        state.editingProductId = el.dataset.editProduct;
        reload();
      });
    });

    $$('[data-activate]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const res = await call(api.setActiveProduct(el.dataset.activate));
          if (res.readiness) setReadiness(res.readiness);
          toast('已设为当前基准 · Active baseline', 'success');
          reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });

    $$('[data-del-product]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('确定删除 · Confirm delete该产品？· Delete this product?')) return;
        try {
          const res = await call(api.deleteProduct(el.dataset.delProduct));
          if (res.readiness) setReadiness(res.readiness);
          state.editingProductId = res.active?.id || null;
          toast('已删除 · Deleted', 'info');
          reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });

    $('#btn-save-product')?.addEventListener('click', async () => {
      try {
        let specs = {};
        const raw = $('#p-specs').value.trim();
        if (raw) specs = JSON.parse(raw);
        const payload = {
          name: $('#p-name').value.trim(),
          category: $('#p-category').value.trim(),
          price: $('#p-price').value ? Number($('#p-price').value) : null,
          description: $('#p-desc').value.trim(),
          keywords: $('#p-keywords').value,
          channels: $('#p-channels').value,
          specs,
        };
        const id = $('#p-id').value.trim();
        if (id) payload.id = id;
        const res = await call(api.saveProduct(payload));
        if (res.readiness) setReadiness(res.readiness);
        state.editingProductId =
          res.active?.id || res.products?.[res.products.length - 1]?.id || null;
        $('#p-save-msg').textContent = '已保存 · Saved';
        toast(id ? '产品已更新 · Product updated' : '产品已添加 · Added', 'success');
        reload();
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    // ---- 规格书 · Spec sheet上传（选择文件 · Choose files + 拖拽） ----
    const unsub =
      api.on &&
      api.on('product:parse-progress', (p) => {
        const el = $('#spec-parse-status');
        if (el && p?.message) el.textContent = p.message;
      });

    async function runSpecParse(input) {
      const panel = $('#spec-parse-panel');
      if (panel) panel.classList.remove('hidden');
      const status = $('#spec-parse-status');
      if (status) {
        status.textContent = input == null ? '请选择文件 · Choose files…' : '正在读取拖入文件… · Reading dropped files…';
      }
      const zone = $('#spec-drop-zone');
      zone?.classList.add('busy');
      try {
        if (input == null) toast('请选择规格书 · Spec sheet文件… · Choose spec files…', 'info');
        else toast(`正在解析 · Parsing ${Array.isArray(input) ? input.length : 1} file(s)…`, 'info');
        const res = await call(api.parseSpecFiles(input));
        if (res?.error && res.canceled) {
          throw new Error(res.error);
        }
        if (res.canceled) {
          if (status) status.textContent = '已取消 · Canceled';
          return;
        }
        showSpecParseResult(res);
        toast(`解析完成 · Parsed ${res.fields?.length || 0} fields pending`, 'success');
      } catch (e) {
        toast(e.message, 'error');
        if (status) status.textContent = '失败 · Failed: ' + e.message;
      } finally {
        zone?.classList.remove('busy', 'drag-over');
      }
    }

    $('#btn-upload-spec')?.addEventListener('click', () => runSpecParse(null));

    const dropZone = $('#spec-drop-zone');
    if (dropZone) {
      const setOver = (on) => dropZone.classList.toggle('drag-over', on);

      // 防止整页被浏览器打开文件
      const preventNav = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
        dropZone.addEventListener(ev, preventNav);
      });

      dropZone.addEventListener('dragenter', () => setOver(true));
      dropZone.addEventListener('dragover', () => setOver(true));
      dropZone.addEventListener('dragleave', (e) => {
        // 仅离开区域本身时取消高亮
        if (!dropZone.contains(e.relatedTarget)) setOver(false);
      });
      dropZone.addEventListener('drop', (e) => {
        setOver(false);
        const files = e.dataTransfer?.files;
        if (!files?.length) {
          toast('未检测到文件 · No file detected', 'error');
          return;
        }
        runSpecParse(Array.from(files));
      });
      dropZone.addEventListener('click', () => runSpecParse(null));
      dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          runSpecParse(null);
        }
      });
    }

    $('#btn-close-parse')?.addEventListener('click', () => {
      $('#spec-parse-panel')?.classList.add('hidden');
    });

    $('#btn-spec-all')?.addEventListener('click', () => {
      if (!state.specParse?.fields) return;
      state.specParse.fields.forEach((f) => {
        f.selected = true;
      });
      renderSpecFields(state.specParse.fields);
    });
    $('#btn-spec-none')?.addEventListener('click', () => {
      if (!state.specParse?.fields) return;
      state.specParse.fields.forEach((f) => {
        f.selected = false;
      });
      renderSpecFields(state.specParse.fields);
    });
    $('#btn-spec-high')?.addEventListener('click', () => {
      if (!state.specParse?.fields) return;
      state.specParse.fields.forEach((f) => {
        f.selected = f.confidence == null || Number(f.confidence) >= 0.7;
      });
      renderSpecFields(state.specParse.fields);
    });

    $('#btn-spec-to-form')?.addEventListener('click', () => {
      if (!state.specParse?.fields?.some((f) => f.selected)) {
        toast('请先勾选要填入的字段 · Select fields to fill first', 'error');
        return;
      }
      fieldsToForm(state.specParse.fields);
      toast('已填入表单 · Fill form · Filled into form — review then save', 'success');
      $('#product-form-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#btn-spec-apply')?.addEventListener('click', async () => {
      if (!state.specParse?.fields?.some((f) => f.selected)) {
        toast('请先勾选要写入的字段 · Select fields to write first', 'error');
        return;
      }
      try {
        const asNew = !!$('#spec-as-new')?.checked;
        const productId = $('#p-id')?.value?.trim() || state.editingProductId || null;
        const res = await call(
          api.applySpecFields({
            fields: state.specParse.fields,
            productId,
            asNew,
            sources: state.specParse.sources,
          })
        );
        if (res.readiness) setReadiness(res.readiness);
        state.editingProductId = res.active?.id || productId;
        toast(asNew ? '已创建新产品 · Created new product' : '已合并到产品 · Merged into product', 'success');
        reload();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  async function pageRoadmap() {
    let pl = { products: [], activeId: null };
    try {
      pl = await call(api.listProducts());
    } catch {
      /* empty */
    }
    const latest = await call(api.latestRoadmap()).catch(() => null);
    const history = await call(api.listRoadmaps(8)).catch(() => []);
    const plist = pl.products || [];
    const focusId = pl.activeId || plist[0]?.id || '';

    return `
      <div class="banner">
        <span>基于我方 + 高威胁竞品 · High-threat rivals · AI simulates an actionable roadmap to win</span>
      </div>
      <div class="grid two" style="align-items:start">
        <div class="card">
          <h3>生成击败路径 · Generate beat path</h3>
          <p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.6">
            将综合威胁分、价格/规格/渠道差距，推演近中远三期路线：打谁、补什么、差异化 · Differentiation什么、价格与渠道怎么走。
          </p>
          <div class="form-group">
            <label>主打产品（聚焦） · Focus product</label>
            <select id="rm-focus">
              ${
                plist.length
                  ? plist
                      .map(
                        (p) =>
                          `<option value="${esc(p.id)}" ${p.id === focusId ? 'selected' : ''}>${esc(p.name)}</option>`
                      )
                      .join('')
                  : '<option value="">请先添加产品 · Add a product first</option>'
              }
            </select>
          </div>
          <div class="form-group">
            <label>时间跨度 · Horizon</label>
            <select id="rm-horizon">
              <option value="6m">6 个月 · 6 months</option>
              <option value="12m" selected>12 个月 · 12 months</option>
              <option value="18m">18 个月 · 18 months</option>
            </select>
          </div>
          <div class="form-group">
            <label>战略目标（可选） · Strategic goal (optional)</label>
            <textarea id="rm-goal" placeholder="例如 e.g.：在 999 价位段拿下…击败 Verifone / PAX">${esc(
              latest?.meta?.goal || ''
            )}</textarea>
          </div>
          <div class="flex-between">
            <span class="muted" id="rm-status">${latest ? `上次生成 · Last: ${esc(fmtTime(latest.meta?.generatedAt || latest.created_at))}` : '尚未生成'}</span>
            <button class="btn primary" id="btn-gen-roadmap" ${plist.length ? '' : 'disabled'}>AI 生成路线图 · Generate roadmap · Generate AI roadmap</button>
          </div>
          ${
            history?.length
              ? `<div class="section-gap">
                  <h3 style="font-size:13px">历史版本 · History</h3>
                  <div class="rm-history">
                    ${history
                      .map(
                        (h) => `
                      <button class="rm-hist-item" data-rm-id="${esc(h.id)}">
                        <span class="t">${esc(h.title || '未命名 · Untitled')}</span>
                        <span class="s">${esc(fmtTime(h.meta?.generatedAt || h.created_at))}</span>
                      </button>`
                      )
                      .join('')}
                  </div>
                </div>`
              : ''
          }
        </div>
        <div class="card">
          <h3>使用建议 · Tips</h3>
          <div class="check-list">
            <div class="check-item done"><div class="check-box">1</div><div class="check-body"><div class="check-title">先配齐产品与竞品 · Set up products & competitors first</div><div class="check-hint">威胁分越高越有的放矢 · Higher threat scores → sharper roadmap</div></div></div>
            <div class="check-item done"><div class="check-box">2</div><div class="check-body"><div class="check-title">选定主打产品 · Pick focus product</div><div class="check-hint">组合产品时以一个 SKU 为主战场 · One focus SKU for multi-product</div></div></div>
            <div class="check-item done"><div class="check-box">3</div><div class="check-body"><div class="check-title">生成后人工裁剪 · Human edit after generate</div><div class="check-hint">AI 给路径 · AI suggests; you decide</div></div></div>
          </div>
        </div>
      </div>
      <div id="rm-result" class="section-gap">
        ${latest ? renderRoadmapDoc(latest) : emptyState('⇢', '还没有击败路径', '配置产品与竞品后生成 AI 路线图 · After products & competitors, generate AI roadmap', null, null)}
      </div>`;
  }

  function priorityChip(p) {
    const v = String(p || '').toUpperCase();
    if (v === 'P0' || v === '高') return 'chip red';
    if (v === 'P1' || v === '中') return 'chip orange';
    return 'chip';
  }

  function renderRoadmapDoc(doc) {
    if (!doc) return '';
    const pos = doc.positioning || {};
    const price = doc.priceStrategy || {};
    const ch = doc.channelStrategy || {};
    const conf = Math.round((doc.confidence || 0) * 100);

    const phases = (doc.phases || [])
      .map(
        (ph, i) => `
      <div class="rm-phase">
        <div class="rm-phase-head">
          <span class="rm-step">${i + 1}</span>
          <div>
            <div class="rm-phase-name">${esc(ph.name || `阶段 Phase ${i + 1}`)}</div>
            <div class="rm-phase-theme">${esc(ph.theme || '')}</div>
          </div>
        </div>
        <div class="rm-phase-body">
          <div class="rm-block"><h4>目标 · Goals</h4><ul>${(ph.goals || []).map((g) => `<li>${esc(g)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
          <div class="rm-block"><h4>交付 / 功能</h4><ul>${(ph.deliverables || []).map((g) => `<li>${esc(g)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
          <div class="rm-block"><h4>指标 · Metrics</h4><ul>${(ph.metrics || []).map((g) => `<li>${esc(g)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
          ${(ph.risks || []).length ? `<div class="rm-block"><h4>风险 · Risks</h4><ul>${ph.risks.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
        </div>
      </div>`
      )
      .join('');

    const gaps = (doc.gaps || [])
      .map(
        (g) => `
      <tr>
        <td><span class="${priorityChip(g.priority)}">${esc(g.priority || 'P2')}</span></td>
        <td>${esc(g.area || '')}</td>
        <td>${esc(g.current || '')}</td>
        <td>${esc(g.target || '')}</td>
        <td>${esc(g.against || '')}</td>
      </tr>`
      )
      .join('');

    const beat = (doc.beatList || [])
      .map(
        (b) => `
      <div class="rm-beat-card">
        <div class="flex-between">
          <strong>${esc(b.competitor || '')}</strong>
          <span class="threat-pill ${threatClass(b.threatScore || 0)}">${Math.round((b.threatScore || 0) * 100)}%</span>
        </div>
        <p class="item-sub" style="margin-top:8px;white-space:normal">${esc(b.howToBeat || '')}</p>
        ${b.avoidCopying ? `<p class="muted" style="font-size:12px;margin-top:6px">别盲目抄 · Don't blindly copy: ${esc(b.avoidCopying)}</p>` : ''}
      </div>`
      )
      .join('');

    const must = (doc.mustHave || [])
      .map(
        (m) =>
          `<div class="rm-pill"><span class="${priorityChip(m.priority)}">${esc(m.priority || '')}</span> <strong>${esc(m.name)}</strong><span class="muted"> — ${esc(m.reason || '')}</span></div>`
      )
      .join('');

    const diff = (doc.differentiators || [])
      .map(
        (m) =>
          `<div class="rm-pill"><span class="chip green">${esc(m.moat || '差异 · Diff')}</span> <strong>${esc(m.name)}</strong><span class="muted"> — ${esc(m.reason || '')}</span></div>`
      )
      .join('');

    const actions = (doc.nextActions || [])
      .map(
        (a) => `
      <tr>
        <td><span class="${priorityChip(a.urgency)}">${esc(a.urgency || '')}</span></td>
        <td>${esc(a.action || '')}</td>
        <td>${esc(a.owner || '')}</td>
      </tr>`
      )
      .join('');

    const kpis = (doc.kpis || [])
      .map(
        (k) => `
      <tr>
        <td>${esc(k.name || '')}</td>
        <td>${esc(k.baseline || '—')}</td>
        <td>${esc(k.target || '')}</td>
        <td>${esc(k.when || '')}</td>
      </tr>`
      )
      .join('');

    return `
      <div class="rm-doc">
        <div class="rm-hero">
          <div>
            <div class="rm-kicker">AI 模拟击败路径 · 置信 ${conf}%</div>
            <h2 class="rm-title">${esc(doc.title || '击败路径 · Beat roadmap')}</h2>
            <p class="rm-summary">${esc(doc.summary || '')}</p>
            ${doc.northStar ? `<div class="rm-north"><span>北极星 · North star</span>${esc(doc.northStar)}</div>` : ''}
          </div>
          <div class="rm-meta-card">
            <div class="k">主打产品 · Focus product</div><div>${esc(doc.meta?.focusProductName || '—')}</div>
            <div class="k">对标竞品</div><div>${doc.meta?.competitorCount ?? '—'} 个</div>
            <div class="k">跨度 · Horizon</div><div>${esc(doc.meta?.horizon || '12m')}</div>
            <div class="k">生成时间 · Generated</div><div>${esc(fmtTime(doc.meta?.generatedAt || doc.created_at))}</div>
          </div>
        </div>

        ${roadmapVizShell()}

        <div class="grid three section-gap">
          <div class="card rm-soft">
            <h3>定位 · Positioning</h3>
            <p class="rm-quote">${esc(pos.statement || '—')}</p>
            <div class="kv">
              <div class="k">用户 · User</div><div>${esc(pos.targetUser || '—')}</div>
              <div class="k">战场 · Battlefield</div><div>${esc(pos.battlefield || '—')}</div>
              <div class="k">赢法 · Win theme</div><div>${esc(pos.winTheme || '—')}</div>
            </div>
          </div>
          <div class="card rm-soft">
            <h3>价格策略 · Pricing strategy</h3>
            <div class="stat-value" style="font-size:20px;margin-bottom:8px">${esc(price.band || '—')}</div>
            <p class="muted" style="font-size:12px;line-height:1.6">${esc(price.logic || '')}</p>
            <p class="item-sub" style="margin-top:8px;white-space:normal">${esc(price.vsCompetitors || '')}</p>
          </div>
          <div class="card rm-soft">
            <h3>渠道策略 · Channel strategy</h3>
            <div style="margin-bottom:8px">${(ch.priorityChannels || []).map((c) => `<span class="chip purple">${esc(c)}</span>`).join('') || '—'}</div>
            <ul class="rm-ul">${(ch.actions || []).map((a) => `<li>${esc(a)}</li>`).join('') || '<li class="muted">—</li>'}</ul>
          </div>
        </div>

        <div class="card section-gap">
          <h3>分阶段路线 · Phased roadmap</h3>
          <div class="rm-timeline">${phases}</div>
        </div>

        <div class="grid two section-gap">
          <div class="card">
            <h3>能力差距 · Capability gaps</h3>
            <div class="dim-table-wrap" style="border:none">
              <table class="table">
                <thead><tr><th>优先级 · Priority</th><th>领域 · Area</th><th>现状 · Current</th><th>目标 · Target</th><th>对标 · Benchmark</th></tr></thead>
                <tbody>${gaps || '<tr><td colspan="5" class="muted">—</td></tr>'}</tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <h3>打谁 / 怎么赢 · Who to beat / how to win</h3>
            <div class="rm-beat-grid">${beat || '<p class="muted empty-hint">—</p>'}</div>
          </div>
        </div>

        <div class="grid two section-gap">
          <div class="card">
            <h3>Must-have</h3>
            <div class="rm-stack">${must || '<p class="muted">—</p>'}</div>
          </div>
          <div class="card">
            <h3>差异化 · Differentiation</h3>
            <div class="rm-stack">${diff || '<p class="muted">—</p>'}</div>
          </div>
        </div>

        <div class="grid two section-gap">
          <div class="card">
            <h3>本周可行动作 · Actions this week</h3>
            <table class="table">
              <thead><tr><th>紧急 · Urgency</th><th>动作 · Action</th><th>角色 · Owner</th></tr></thead>
              <tbody>${actions || '<tr><td colspan="3" class="muted">—</td></tr>'}</tbody>
            </table>
          </div>
          <div class="card">
            <h3>KPI</h3>
            <table class="table">
              <thead><tr><th>指标 · Metric</th><th>基线 · Baseline</th><th>目标 · Target</th><th>节点 · Milestone</th></tr></thead>
              <tbody>${kpis || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        ${(doc.assumptions || []).length
          ? `<div class="card section-gap"><h3>关键假设 · Key assumptions</h3><ul class="rm-ul">${doc.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`
          : ''}
      </div>`;
  }

  function bindRoadmap() {
    const showDoc = async (doc) => {
      const box = $('#rm-result');
      if (box) box.innerHTML = renderRoadmapDoc(doc);
      // next frame so canvas has size
      requestAnimationFrame(() => mountRoadmapViz(doc));
    };

    // 进入页面时若已有结果，挂载多维图
    if ($('#rm-viz-canvas')) {
      call(api.latestRoadmap())
        .then((doc) => {
          if (doc) mountRoadmapViz(doc);
        })
        .catch(() => {});
    }

    $('#btn-gen-roadmap')?.addEventListener('click', async () => {
      const btn = $('#btn-gen-roadmap');
      const status = $('#rm-status');
      try {
        btn.disabled = true;
        if (status) status.textContent = '生成中 · Generating, may take 30–90s…';
        toast('AI 正在推演击败路径… · AI is planning the beat path…', 'info');
        const doc = await call(
          api.generateRoadmap({
            focusProductId: $('#rm-focus')?.value || undefined,
            horizon: $('#rm-horizon')?.value || '12m',
            goal: $('#rm-goal')?.value.trim() || undefined,
          })
        );
        await showDoc(doc);
        if (status) status.textContent = `已生成 · Generated: ${fmtTime(doc.meta?.generatedAt || doc.created_at)}`;
        toast('击败路径已生成 · Beat roadmap generated', 'success');
      } catch (e) {
        toast(e.message, 'error');
        if (status) status.textContent = '生成失败 · Generation failed';
      } finally {
        btn.disabled = false;
      }
    });

    $$('[data-rm-id]').forEach((el) => {
      el.addEventListener('click', async () => {
        try {
          const doc = await call(api.getRoadmap(el.dataset.rmId));
          await showDoc(doc);
          toast('已加载历史版本 · History · Loaded historical version', 'info');
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    api.on('roadmap:progress', (p) => {
      const status = $('#rm-status');
      if (status && p?.message) status.textContent = p.message;
    });
  }

  async function pageLoop() {
    const st = await call(api.getLoopStatus());
    const settings = await call(api.getSettingsFull());
    const loop = settings.loop || {};
    const history = await call(api.listHistory(15)).catch(() => []);
    const histRows = (history || [])
      .map(
        (h) => `
      <tr class="clickable-row" data-history-id="${esc(h.id)}">
        <td>${esc(fmtTime(h.started_at))}</td>
        <td>${h.trigger === 'loop' ? '<span class="chip purple">后台 · BG</span>' : '<span class="chip">手动 · Manual</span>'}</td>
        <td><span class="chip ${h.status === 'done' ? 'green' : h.status === 'error' ? 'red' : 'blue'}">${esc(h.status)}</span></td>
        <td>${h.found_count ?? 0}/${h.new_count ?? 0}/${h.threat_count ?? 0}</td>
        <td class="muted">${esc(h.summary || h.error || h.product_name || '—')}</td>
        <td><button class="btn sm" data-history-id="${esc(h.id)}">详情 · Details</button></td>
      </tr>`
      )
      .join('') || '<tr><td colspan="6" class="muted">暂无记录 · No records</td></tr>';

    return `
      <div class="banner">
        <span>后台扫描写完整日志 · Background scans log fully. Open Details for steps, finds & scores.</span>
      </div>
      <div class="grid two">
        <div class="card">
          <h3>引擎状态 · Engine status</h3>
          <div class="kv">
            <div class="k">调度 · Schedule</div>
            <div>${st.isScheduled ? '<span class="chip green">运行中 · Running</span>' : '<span class="chip">已停止 · Stopped</span>'}</div>
            <div class="k">执行中 · Running</div><div id="loop-running-flag">${st.isRunning ? '是 · Yes' : '否 · No'}</div>
            <div class="k">频率 · Frequency</div><div>${esc(st.nextHint || st.cron)}</div>
            <div class="k">威胁阈值 · Threat threshold</div><div>${Math.round((st.threatThreshold || 0.65) * 100)}%</div>
            <div class="k">上次运行 · Last run</div><div>${esc(fmtTime(st.lastRunAt))}</div>
            <div class="k">上次结果 · Last result</div>
            <div>${st.lastResult ? `发现 Found ${st.lastResult.found} / 新增 New ${st.lastResult.newCount} / 高威胁 High ${st.lastResult.threatCount}` : '—'}</div>
            <div class="k">错误 · Error</div><div class="muted">${esc(st.lastError || '无')}</div>
          </div>
          <div class="row-actions section-gap">
            <button class="btn primary" id="btn-loop-start">${st.isScheduled ? '重启调度 · Restart schedule' : '启动 Loop · Start Loop'}</button>
            <button class="btn" id="btn-loop-stop" ${st.isScheduled ? '' : 'disabled'}>停止 · Stop</button>
            <button class="btn" id="btn-loop-now">立即执行一轮 · Run one cycle now</button>
            ${
              st.lastResult?.historyId
                ? `<button class="btn" id="btn-loop-last-detail" data-history-id="${esc(st.lastResult.historyId)}">上次详情 · Last details</button>`
                : ''
            }
          </div>
        </div>
        <div class="card">
          <h3>调度配置 · Schedule config</h3>
          <div class="form-group">
            <label>扫描频率 · Scan frequency</label>
            <select id="loop-cron">${cronOptions(loop.cron)}</select>
          </div>
          <div class="form-group">
            <label>高威胁通知 · Notifications阈值 · High-threat alert threshold</label>
            <select id="loop-threshold">
              <option value="0.5" ${loop.threatThreshold == 0.5 ? 'selected' : ''}>50%</option>
              <option value="0.65" ${loop.threatThreshold == null || Number(loop.threatThreshold) === 0.65 ? 'selected' : ''}>65%（推荐 · Recommended）</option>
              <option value="0.75" ${loop.threatThreshold == 0.75 ? 'selected' : ''}>75%</option>
              <option value="0.85" ${loop.threatThreshold == 0.85 ? 'selected' : ''}>85%</option>
            </select>
          </div>
          <button class="btn primary" id="btn-loop-save">保存配置 · Save config</button>
          <p class="muted" style="margin-top:14px;font-size:12px;line-height:1.6">
            后台实时日志 · Live log见下 · Live logs below; Details for full steps.
          </p>
        </div>
      </div>
      <div class="grid two section-gap">
        <div class="card">
          <h3>实时日志 · Live log <span class="muted" style="font-weight:500;font-size:12px" id="loop-live-stage">待命</span></h3>
          <div class="progress"><i id="loop-live-progress"></i></div>
          <div class="scan-console" id="loop-live-console">
            <div class="line info">// 后台进度 · Progress for background / run-now appears here</div>
          </div>
        </div>
        <div class="card">
          <h3>扫描历史 · Scan history</h3>
          <div class="dim-table-wrap" style="border:none;max-height:320px">
            <table class="table">
              <thead>
                <tr><th>时间 · Time</th><th>来源 · Source</th><th>状态 · Status</th><th>发/新/危 · F/N/T</th><th>摘要 · Summary</th><th></th></tr>
              </thead>
              <tbody>${histRows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function cronOptions(current) {
    const opts = [
      ['0 * * * *', '每小时 · Hourly'],
      ['0 */2 * * *', '每 2 小时 · Every 2h'],
      ['0 */4 * * *', '每 4 小时 · Every 4h'],
      ['0 */6 * * *', '每 6 小时 · Every 6h'],
      ['0 */12 * * *', '每 12 小时 · Every 12h'],
      ['0 9 * * *', '每天 09:00 · Daily 09:00'],
      ['0 9 * * 1', '每周一 09:00 · Mon 09:00'],
    ];
    return opts
      .map(([v, l]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${l}</option>`)
      .join('');
  }

  function bindLoop() {
    $('#btn-loop-save')?.addEventListener('click', async () => {
      try {
        const res = await call(
          api.saveSettings({
            loop: {
              cron: $('#loop-cron').value,
              threatThreshold: Number($('#loop-threshold').value),
            },
          })
        );
        if (res.readiness) setReadiness(res.readiness);
        toast('配置已保存 · Settings saved', 'success');
        renderPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#btn-loop-start')?.addEventListener('click', async () => {
      try {
        await call(
          api.saveSettings({
            loop: {
              enabled: true,
              cron: $('#loop-cron').value,
              threatThreshold: Number($('#loop-threshold').value),
            },
          })
        );
        await call(api.startLoop());
        toast('Loop 已启动 · Loop started', 'success');
        renderPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#btn-loop-stop')?.addEventListener('click', async () => {
      try {
        await call(api.stopLoop());
        toast('Loop 已停止 · Loop stopped', 'info');
        renderPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#btn-loop-now')?.addEventListener('click', async () => {
      try {
        toast('正在执行… · Running…', 'info');
        const box = $('#loop-live-console');
        if (box) {
          box.innerHTML = '<div class="line info">// 开始后台一轮 · Starting background cycle…</div>';
        }
        const res = await call(api.runLoopNow());
        toast(`完成 Done · new ${res?.newCount || 0}`, 'success');
        if (res?.historyId) {
          // 留一秒让用户看到完成日志，再刷新可点详情
          setTimeout(() => renderPage(), 400);
        } else {
          renderPage();
        }
      } catch (e) {
        toast(e.message, 'error');
        const box = $('#loop-live-console');
        if (box) {
          const line = document.createElement('div');
          line.className = 'line err';
          line.textContent = e.message;
          box.appendChild(line);
        }
      }
    });

    $$('[data-history-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openScanHistory(el.dataset.historyId);
      });
    });
  }

  async function pageSettings() {
    const s = await call(api.getSettingsFull());
    const llm = s.llm || {};
    const n = s.notifications || {};
    return `
      <div class="grid two">
        <div class="card">
          <h3>LLM 配置 · LLM settings</h3>
          <p class="muted" style="margin-bottom:12px;font-size:12px">兼容 OpenAI Chat Completions · Supports MiniMax / Kimi / DeepSeek / Qwen / Ollama…</p>
          <div class="form-group">
            <label>Provider 预设 · Provider preset</label>
            <select id="llm-preset">
              <option value="openai">OpenAI</option>
              <option value="minimax">MiniMax（国内 · China）</option>
              <option value="minimax-intl">MiniMax（国际 · Intl）</option>
              <option value="kimi">Kimi 月之暗面（国内 · China）</option>
              <option value="kimi-intl">Kimi（国际 · Intl）</option>
              <option value="deepseek">DeepSeek</option>
              <option value="qwen">通义千问 · Qwen</option>
              <option value="ollama">Ollama 本地 · Ollama local</option>
              <option value="custom">自定义 · Custom</option>
            </select>
          </div>
          <div class="form-group">
            <label>Base URL</label>
            <input id="llm-base" type="url" value="${esc(llm.baseUrl || '')}" placeholder="https://api.openai.com/v1" />
          </div>
          <div class="form-group">
            <label>API Key</label>
            <input id="llm-key" type="password" value="${esc(llm.apiKey || '')}" placeholder="sk-..." />
          </div>
          <div class="form-group">
            <label>Model</label>
            <input id="llm-model" type="text" value="${esc(llm.model || '')}" placeholder="MiniMax-M2 / gpt-4o-mini" />
            <div class="hint">MiniMax：MiniMax-M2 · Kimi：kimi-k2.5 / moonshot-v1-128k（以控制台为准）</div>
          </div>
          <div class="form-group">
            <label>Temperature</label>
            <input id="llm-temp" type="number" min="0" max="2" step="0.1" value="${llm.temperature ?? 0.3}" />
          </div>
          <div class="form-group">
            <label>请求超时 · Request timeout</label>
            <select id="llm-timeout">
              <option value="60000" ${Number(llm.timeoutMs) === 60000 ? 'selected' : ''}>60 秒 · 60s</option>
              <option value="120000" ${!llm.timeoutMs || Number(llm.timeoutMs) === 120000 ? 'selected' : ''}>120 秒（推荐 · Recommended）</option>
              <option value="180000" ${Number(llm.timeoutMs) === 180000 ? 'selected' : ''}>180 秒 · 180s</option>
              <option value="300000" ${Number(llm.timeoutMs) === 300000 ? 'selected' : ''}>300 秒 · 300s</option>
            </select>
            <div class="hint">竞品扫描多轮研究 · Multi-round research; MiniMax/Kimi ≥120s recommended (≥180s for research).</div>
          </div>
          <div class="row-actions">
            <button class="btn" id="btn-test-llm">测试连接 · Test connection</button>
            <button class="btn primary" id="btn-save-llm">保存 · Save</button>
          </div>
          <p class="muted" id="llm-test-msg" style="margin-top:10px;font-size:12px"></p>
        </div>
        <div>
          <div class="card">
            <h3>通知 · Notifications</h3>
            <div class="switch-row">
              <div>
                <div>桌面通知 · Notifications · Desktop notifications</div>
                <div class="hint muted">高威胁竞品 · High-threat rivals出现时弹出 · Popup when high-threat appears</div>
              </div>
              <label class="switch">
                <input type="checkbox" id="n-desktop" ${n.desktop !== false ? 'checked' : ''} />
                <span class="slider"></span>
              </label>
            </div>
            <div class="form-group" style="margin-top:12px">
              <label>通知 · Notifications最低威胁</label>
              <select id="n-min">
                <option value="0.5" ${n.minThreat == 0.5 ? 'selected' : ''}>50%</option>
                <option value="0.65" ${n.minThreat == null || Number(n.minThreat) === 0.65 ? 'selected' : ''}>65%</option>
                <option value="0.75" ${n.minThreat == 0.75 ? 'selected' : ''}>75%</option>
              </select>
            </div>
            <button class="btn primary" id="btn-save-notify">保存通知 · Save notifications · Notifications</button>
          </div>
          <div class="card section-gap">
            <h3>数据 · Data</h3>
            <p class="muted" style="font-size:12px;line-height:1.6;margin-bottom:12px">
              本地单机存储 · Local-only storage. Export competitors, full backup, or restore.
            </p>
            <div class="row-actions">
              <button class="btn" id="btn-export-json">导出 JSON · Export JSON</button>
              <button class="btn" id="btn-export-csv2">导出 CSV · Export CSV</button>
              <button class="btn" id="btn-backup">完整备份 · Full backup</button>
              <button class="btn" id="btn-restore">恢复备份 · Restore backup</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function bindSettings() {
    const presets = {
      openai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      minimax: {
        provider: 'minimax',
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M2',
      },
      'minimax-intl': {
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M2',
      },
      kimi: {
        provider: 'kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'kimi-k2.5',
      },
      'kimi-intl': {
        provider: 'kimi',
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'kimi-k2.5',
      },
      deepseek: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      qwen: {
        provider: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
      },
      ollama: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
    };

    // 根据已保存的 baseUrl 回显预设
    const currentBase = ($('#llm-base')?.value || '').replace(/\/$/, '');
    const matched = Object.entries(presets).find(([, p]) => p.baseUrl.replace(/\/$/, '') === currentBase);
    if (matched && $('#llm-preset')) $('#llm-preset').value = matched[0];

    $('#llm-preset')?.addEventListener('change', () => {
      const p = presets[$('#llm-preset').value];
      if (!p) return;
      $('#llm-base').value = p.baseUrl;
      $('#llm-model').value = p.model;
    });

    const saveLlm = async () => {
      const presetKey = $('#llm-preset')?.value;
      const baseNow = ($('#llm-base')?.value || '').toLowerCase();
      const provider =
        (presetKey && presets[presetKey]?.provider) ||
        (baseNow.includes('minimax')
          ? 'minimax'
          : baseNow.includes('moonshot') || baseNow.includes('kimi')
            ? 'kimi'
            : 'custom');
      const res = await call(
        api.saveSettings({
          llm: {
            provider,
            baseUrl: $('#llm-base').value.trim(),
            apiKey: $('#llm-key').value.trim(),
            model: $('#llm-model').value.trim(),
            temperature: Number($('#llm-temp').value) || 0.3,
            timeoutMs: Number($('#llm-timeout')?.value) || 120000,
          },
        })
      );
      if (res.readiness) setReadiness(res.readiness);
      return res;
    };

    $('#btn-save-llm')?.addEventListener('click', async () => {
      try {
        await saveLlm();
        toast('LLM 配置已保存 · Settings saved · LLM settings saved', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    $('#btn-test-llm')?.addEventListener('click', async () => {
      try {
        await saveLlm();
        $('#llm-test-msg').textContent = '测试中… · Testing…';
        const res = await call(api.testLlm());
        $('#llm-test-msg').textContent = '连接成功 · Connected: ' + String(res.reply || '').slice(0, 80);
        toast('LLM 连接成功 · LLM connected', 'success');
      } catch (e) {
        $('#llm-test-msg').textContent = '失败 · Failed: ' + e.message;
        toast(e.message, 'error');
      }
    });

    $('#btn-save-notify')?.addEventListener('click', async () => {
      try {
        await call(
          api.saveSettings({
            notifications: {
              desktop: $('#n-desktop').checked,
              minThreat: Number($('#n-min').value),
            },
          })
        );
        toast('通知 · Notifications设置已保存 · Notification settings saved', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    $('#btn-export-json')?.addEventListener('click', async () => {
      try {
        const r = await call(api.exportCompetitors('json'));
        if (!r.canceled) toast(`已导出 · Exported ${r.count} rows`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#btn-export-csv2')?.addEventListener('click', async () => {
      try {
        const r = await call(api.exportCompetitors('csv'));
        if (!r.canceled) toast(`已导出 · Exported ${r.count} rows`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#btn-backup')?.addEventListener('click', async () => {
      try {
        const r = await call(api.exportBackup());
        if (!r.canceled) toast('备份完成 · Backup done', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#btn-restore')?.addEventListener('click', async () => {
      if (!confirm('恢复备份 · Restore backup将覆盖数据 · Restore overwrites data & some settings. Continue?')) return;
      try {
        const r = await call(api.importBackup());
        if (!r.canceled) {
          if (r.readiness) setReadiness(r.readiness);
          toast('恢复成功 · Restore successful', 'success');
          renderPage();
        }
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  // ---------- Onboarding ----------
  function showOnboarding(step = 0) {
    state.onboardingStep = step;
    $('#onboarding').classList.remove('hidden');
    renderOnboardingStep();
  }

  function hideOnboarding() {
    $('#onboarding').classList.add('hidden');
  }

  function renderOnboardingStep() {
    const step = state.onboardingStep;
    const total = 4;
    $('#ob-progress').style.width = `${((step + 1) / total) * 100}%`;
    const body = $('#ob-body');
    $('#ob-back').style.visibility = step === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = step === total - 1 ? '进入应用 · Enter app' : '继续 · Continue';

    if (step === 0) {
      body.innerHTML = `
        <div class="ob-step-title">欢迎使用竞品情报 · Welcome to Competitor Scout</div>
        <div class="ob-step-desc">单机本地应用 · Local desktop app: guided setup, readiness, multi-dim threat matching, scheduled scans, backup/export.</div>
        <div class="ob-features">
          <div class="ob-feature"><div><strong>LLM 研究扫描 · LLM research scan</strong><span>自配模型 · Bring your model; structured price / specs / channels</span></div></div>
          <div class="ob-feature"><div><strong>Agent 二次确认 · Agent re-verify</strong><span>交叉校验后再入库 · Cross-check candidates before save</span></div></div>
          <div class="ob-feature"><div><strong>多维向量威胁 · Multi-dim threat vectors</strong><span>价格/功能/渠道/定位综合排名 · Rank by price, features, channels, positioning</span></div></div>
          <div class="ob-feature"><div><strong>Loop 定时巡检 · Loop scheduled watch</strong><span>发现高威胁自动通知 · Notifications · Auto-notify on high threat</span></div></div>
        </div>`;
    } else if (step === 1) {
      const llm = state.bootstrap?.llm || {};
      body.innerHTML = `
        <div class="ob-step-title">连接你的大模型 · LLM · Connect your LLM</div>
        <div class="ob-step-desc">支持 OpenAI 兼容接口 · OpenAI-compatible APIs (MiniMax / Kimi…). Change later in Settings.</div>
        <div class="form-group">
          <label>快速预设 · Quick preset</label>
          <select id="ob-preset">
            <option value="minimax">MiniMax（国内 · China）</option>
            <option value="minimax-intl">MiniMax（国际 · Intl）</option>
            <option value="kimi">Kimi 月之暗面（国内 · China）</option>
            <option value="kimi-intl">Kimi（国际 · Intl）</option>
            <option value="openai">OpenAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">通义千问 · Qwen</option>
            <option value="ollama">Ollama 本地 · Ollama local</option>
          </select>
        </div>
        <div class="form-group"><label>Base URL</label><input id="ob-base" type="url" value="${esc(llm.baseUrl || 'https://api.minimaxi.com/v1')}" /></div>
        <div class="form-group"><label>API Key</label><input id="ob-key" type="password" value="" placeholder="在对应开放平台获取 API Key · Get API key from the provider console" /></div>
        <div class="form-group"><label>Model</label><input id="ob-model" type="text" value="${esc(llm.model || 'MiniMax-M2')}" placeholder="MiniMax-M2 / kimi-k2.5" />
          <div class="hint">MiniMax：MiniMax-M2 · Kimi：kimi-k2.5 / moonshot-v1-128k</div>
        </div>`;
      const obPresets = {
        minimax: { baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2' },
        'minimax-intl': { baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M2' },
        kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.5' },
        'kimi-intl': { baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2.5' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
        ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
      };
      $('#ob-preset')?.addEventListener('change', () => {
        const p = obPresets[$('#ob-preset').value];
        if (!p) return;
        $('#ob-base').value = p.baseUrl;
        $('#ob-model').value = p.model;
      });
    } else if (step === 2) {
      const p = state.bootstrap?.product || {};
      body.innerHTML = `
        <div class="ob-step-title">定义你的产品 · Define your product</div>
        <div class="ob-step-desc">这是威胁匹配基准 · Threat-matching baseline. Name required; more detail is better.</div>
        <div class="form-group"><label>产品名称 * · Product name *</label><input id="ob-pname" type="text" value="${esc(p.name || '')}" placeholder="你的产品名 · Your product name" /></div>
        <div class="form-group"><label>品类 · Category</label><input id="ob-pcat" type="text" value="${esc(p.category || '')}" /></div>
        <div class="form-group"><label>标价 · List price</label><input id="ob-pprice" type="number" value="${p.price ?? ''}" /></div>
        <div class="form-group"><label>一句话描述 · One-line description</label><textarea id="ob-pdesc">${esc(p.description || '')}</textarea></div>`;
    } else {
      body.innerHTML = `
        <div class="ob-step-title">一切就绪 · You're all set</div>
        <div class="ob-step-desc">建议路径 · Suggested path: enrich specs/channels → first scan → confirm high threats → enable Loop.</div>
        <div class="ob-features">
          <div class="ob-feature"><div><strong>1. 智能扫描 · Smart Scan</strong><span>让 Agent 拉取第一批候选 · Let Agent pull first candidates</span></div></div>
          <div class="ob-feature"><div><strong>2. 竞品库确认 · Confirm in library</strong><span>只把真正的对手入库 · Keep only real rivals</span></div></div>
          <div class="ob-feature"><div><strong>3. 开启 Loop · Enable Loop</strong><span>自动盯盘，高威胁即通知 · Notifications · Watch the market; alert on high threat</span></div></div>
        </div>`;
    }
  }

  async function onboardingNext() {
    const step = state.onboardingStep;
    try {
      if (step === 1) {
        const key = $('#ob-key').value.trim();
        const base = $('#ob-base').value.trim();
        const provider = /minimax/i.test(base)
          ? 'minimax'
          : /moonshot|kimi/i.test(base)
            ? 'kimi'
            : /deepseek/i.test(base)
              ? 'deepseek'
              : /dashscope|qwen/i.test(base)
                ? 'qwen'
                : /11434|ollama/i.test(base)
                  ? 'ollama'
                  : 'openai';
        const llmPatch = {
          provider,
          baseUrl: base,
          model: $('#ob-model').value.trim(),
          temperature: 0.3,
        };
        if (key) llmPatch.apiKey = key;
        await call(api.saveSettings({ llm: llmPatch }));
      }
      if (step === 2) {
        await call(
          api.saveProduct({
            name: $('#ob-pname').value.trim(),
            category: $('#ob-pcat').value.trim(),
            price: $('#ob-pprice').value ? Number($('#ob-pprice').value) : null,
            description: $('#ob-pdesc').value.trim(),
            keywords: [],
            channels: [],
            specs: {},
          })
        );
        // 引导写入第一个产品到多产品列表
      }
      if (step >= 3) {
        await call(api.completeOnboarding());
        hideOnboarding();
        const readiness = await call(api.getReadiness());
        setReadiness(readiness);
        toast('配置完成，开始使用吧 · Setup done — start exploring', 'success');
        navigate(readiness.canScan ? 'scan' : 'dashboard');
        return;
      }
      state.onboardingStep += 1;
      await call(api.saveOnboarding({ step: state.onboardingStep }));
      renderOnboardingStep();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ---------- global ----------
  function bindGlobal() {
    $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.page)));
    $('#btn-quick-scan')?.addEventListener('click', () => navigate('scan'));
    $('#btn-export')?.addEventListener('click', async () => {
      try {
        const r = await call(api.exportCompetitors('json'));
        if (!r.canceled) toast(`已导出 · Exported ${r.count} rows`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    $('#btn-notify-toggle')?.addEventListener('click', () => $('#notify-drawer').classList.toggle('hidden'));
    $('#btn-notify-close')?.addEventListener('click', () => $('#notify-drawer').classList.add('hidden'));

    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-close-modal]') || e.target.closest('[data-close-modal]')) {
        if (e.target.closest('#m-save')) return;
        closeModal();
      }
    });

    $('#ob-skip')?.addEventListener('click', async () => {
      await call(api.saveOnboarding({ completed: true, skippedAt: new Date().toISOString() }));
      hideOnboarding();
      navigate('dashboard');
    });
    $('#ob-back')?.addEventListener('click', () => {
      if (state.onboardingStep > 0) {
        state.onboardingStep -= 1;
        renderOnboardingStep();
      }
    });
    $('#ob-next')?.addEventListener('click', () => onboardingNext());

    api.on('threat:progress', (p) => {
      if (!p) return;
      if (p.percent != null) state.threatLastPercent = p.percent;
      if (p.message) {
        showThreatProgress(true, p.message, p.percent);
        // 扫描页也写日志，便于与扫描流水线对照
        if (state.page === 'scan' && p.stage !== 'product-match') {
          appendScanLog({
            level: p.stage === 'done' ? 'ok' : p.stage === 'error' ? 'err' : 'work',
            stage: 'threat',
            message: p.message,
          });
        }
      } else if (p.percent != null) {
        showThreatProgress(true, undefined, p.percent);
      }
      if (p.stage === 'done' || p.stage === 'error') {
        setTimeout(() => {
          if (!state.threatRunning) showThreatProgress(false);
        }, 2200);
      }
    });

    api.on('scan:progress', (p) => {
      if (p?.stage) state.scanLastStage = p.stage;
      if (p?.message) state.scanLastMessage = p.message;
      if (p?.percent != null) state.scanLastPercent = p.percent;
      state.scanLastProgressAt = Date.now();

      // 手动扫描页：指示灯 + 进度 + 结构化日志
      if (state.page === 'scan') {
        setScanPipeline(p.stage, p.message, p.percent);
        if (p.message) {
          let level = 'info';
          if (p.stage === 'error') level = 'err';
          else if (p.stage === 'done') level = 'ok';
          else if (String(p.stage || '').includes('warn')) level = 'warn';
          else if (p.stage === 'scored' || p.stage === 'discover-done') level = 'item';
          else if (p.stage === 'enrich' || p.stage === 'rag' || p.stage === 'verify') level = 'work';
          appendScanLog({ level, stage: p.stage, message: p.message });
        }
      }
      // Loop 页实时日志 · Live log（后台扫描也能看）
      if (state.page === 'loop') {
        if (p.percent != null) {
          const bar = $('#loop-live-progress');
          if (bar) bar.style.width = `${p.percent}%`;
        }
        const stage = $('#loop-live-stage');
        if (stage && p.message) stage.textContent = p.message;
        const flag = $('#loop-running-flag');
        if (flag) {
          flag.textContent =
            p.stage === 'done' || p.stage === 'error' ? '否 · No' : '是 · Yes';
        }
        const box = $('#loop-live-console');
        if (box && p.message) {
          const line = document.createElement('div');
          line.className =
            p.stage === 'error' ? 'line err' : p.source === 'loop' ? 'line info' : 'line';
          const tag = p.source === 'loop' ? '[Loop] ' : '';
          line.textContent = `${tag}${p.message}`;
          box.appendChild(line);
          box.scrollTop = box.scrollHeight;
        }
      }
    });

    api.on('loop:scan-complete', (result) => {
      refreshLoopPill();
      if (state.page === 'dashboard' || state.page === 'loop') renderPage();
      if (result.newCount > 0) {
        pushNotify({
          id: Date.now().toString(),
          title: '定时扫描完成 · Scheduled scan done',
          body: `新增 New ${result.newCount} · 高威胁 High threat ${result.newThreats?.length || 0}`,
          level: result.newThreats?.length ? 'high' : 'info',
          time: new Date().toISOString(),
        });
      }
    });

    api.on('loop:error', (err) => {
      pushNotify({
        id: Date.now().toString(),
        title: 'Loop 扫描失败 · Scan failed',
        body: err.message || '未知错误 · Unknown error',
        level: 'high',
        time: new Date().toISOString(),
      });
    });

    api.on('notification:push', (n) => pushNotify(n));
  }

  async function boot() {
    try {
      if (typeof api === 'undefined') {
        throw new Error('API 未注入 · API not injected — start with Electron (npm start)');
      }
      const bootData = await call(api.bootstrap());
      state.bootstrap = bootData;
      setReadiness(bootData.readiness);
      $('#boot')?.classList.add('hidden');
      $('#app')?.classList.remove('hidden');
      bindGlobal();

      if (!bootData.onboarding?.completed) {
        showOnboarding(bootData.onboarding?.step || 0);
      }
      navigate('dashboard');
    } catch (err) {
      const bootEl = $('#boot');
      if (bootEl) {
        bootEl.innerHTML = `
          <div class="boot-card">
            <div class="brand-mark lg">!</div>
            <div class="boot-title">启动失败 · Startup failed</div>
            <div class="boot-sub">${esc(err.message)}</div>
          </div>`;
      }
    }
  }

  boot();
})();
