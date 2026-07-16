(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const D = window.DEMO;
  if (!D) return;

  const state = {
    page: 'dashboard',
    scanning: false,
    scanPct: 0,
    compareRows: null,
    filterStatus: '',
  };

  const STEPS = [
    { id: 'start', label: '启动', hint: '任务' },
    { id: 'discover', label: '发现', hint: 'Discover' },
    { id: 'enrich', label: '补全', hint: 'Enrich' },
    { id: 'threat', label: '威胁', hint: 'BM25+RAG' },
    { id: 'verify', label: '校验', hint: 'Agent' },
    { id: 'done', label: '完成', hint: '入库' },
  ];

  function threatClass(s) {
    if (s >= 0.65) return 'high';
    if (s >= 0.4) return 'mid';
    return 'low';
  }
  function pct(s) {
    return Math.round((s || 0) * 100);
  }
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function normKey(k) {
    return String(k || '')
      .toLowerCase()
      .replace(/（[^）]*）|\([^)]*\)/g, '')
      .replace(/[_\s\-/·.]+/g, '');
  }

  function collectParams(entity) {
    const rows = [];
    if (entity.price != null) rows.push({ key: '标价', value: String(entity.price) });
    if (entity.price_range) rows.push({ key: '价格区间', value: entity.price_range });
    if (entity.category) rows.push({ key: '品类', value: entity.category });
    if (entity.channels?.length) rows.push({ key: '渠道', value: entity.channels.join('、') });
    for (const [k, v] of Object.entries(entity.specs || {})) {
      rows.push({ key: k, value: String(v) });
    }
    return rows.map((r) => ({ ...r, norm: normKey(r.key) }));
  }

  function comparePair(product, comp) {
    const ours = collectParams(product);
    const theirs = collectParams(comp);
    const map = new Map(theirs.map((t) => [t.norm, t]));
    const used = new Set();
    const out = [];
    for (const o of ours) {
      const t = map.get(o.norm);
      if (t) used.add(t.norm);
      let status = 'diff';
      if (!t) status = 'ours_only';
      else if ((o.value || '').toLowerCase() === (t.value || '').toLowerCase()) status = 'same';
      out.push({
        productName: product.name,
        competitorName: comp.name,
        param: o.key,
        ourValue: o.value,
        theirValue: t?.value || '',
        status,
      });
    }
    for (const t of theirs) {
      if (used.has(t.norm)) continue;
      out.push({
        productName: product.name,
        competitorName: comp.name,
        param: t.key,
        ourValue: '',
        theirValue: t.value,
        status: 'theirs_only',
      });
    }
    return out;
  }

  const STATUS_LABEL = {
    same: '相同',
    diff: '不同',
    ours_only: '仅我方',
    theirs_only: '仅竞品',
  };

  function setPage(page) {
    state.page = page;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
    const titles = {
      dashboard: ['仪表盘', '威胁态势与待确认（Demo 数据）'],
      scan: ['智能扫描', '点「开始扫描」看流水线动画'],
      competitors: ['竞品库', '点卡片看详情'],
      compare: ['参数对比', '规格参数一条一条对齐'],
      space: ['威胁空间', '简易散点 Demo（非 WebGL）'],
    };
    const t = titles[page] || ['Demo', ''];
    $('#page-title').textContent = t[0];
    $('#page-sub').textContent = t[1];
    if (page === 'space') drawSpace();
  }

  function renderDashboard() {
    const list = D.competitors;
    const high = list.filter((c) => c.threat >= 0.5).length;
    const pending = list.filter((c) => c.status === 'pending').length;
    const avg = list.reduce((s, c) => s + c.threat, 0) / list.length;
    $('#stat-total').textContent = list.length;
    $('#stat-high').textContent = high;
    $('#stat-avg').textContent = pct(avg) + '%';
    $('#stat-pending').textContent = pending;

    $('#dash-list').innerHTML = list
      .slice()
      .sort((a, b) => b.threat - a.threat)
      .map(
        (c) => `
      <div class="comp-card" data-id="${esc(c.id)}">
        <div class="comp-head">
          <div class="avatar">${esc(c.name[0])}</div>
          <div style="min-width:0;flex:1">
            <div class="title">${esc(c.name)}</div>
            <div class="sub">${esc(c.company)}</div>
          </div>
          <span class="threat ${threatClass(c.threat)}">${pct(c.threat)}%</span>
        </div>
        <div class="bar"><i style="width:${pct(c.threat)}%"></i></div>
      </div>`
      )
      .join('');
  }

  function renderCompetitors() {
    $('#comp-grid').innerHTML = D.competitors
      .map(
        (c) => `
      <div class="comp-card" data-id="${esc(c.id)}">
        <div class="comp-head">
          <div class="avatar">${esc(c.name[0])}</div>
          <div style="min-width:0;flex:1">
            <div class="title">${esc(c.name)}</div>
            <div class="sub">${esc(c.company)}</div>
          </div>
          <span class="threat ${threatClass(c.threat)}">${pct(c.threat)}%</span>
        </div>
        <div class="bar"><i style="width:${pct(c.threat)}%"></i></div>
        <div class="meta">
          <div><div class="k">价格</div><div class="v">${esc(c.price_range || c.price || '—')}</div></div>
          <div><div class="k">状态</div><div class="v">${c.status === 'pending' ? '待确认' : '已确认'}</div></div>
        </div>
        <div class="chips">${(c.channels || [])
          .slice(0, 3)
          .map((ch) => `<span class="chip">${esc(ch)}</span>`)
          .join('')}</div>
      </div>`
      )
      .join('');
  }

  function logLine(msg, cls = '') {
    const box = $('#scan-console');
    if (!box) return;
    const div = document.createElement('div');
    div.className = `line ${cls}`;
    div.textContent = `› ${msg}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function setPipe(activeIdx, done = false) {
    $$('.pipe-step').forEach((el, i) => {
      el.classList.remove('active', 'done');
      if (done || i < activeIdx) el.classList.add('done');
      if (!done && i === activeIdx) el.classList.add('active');
    });
  }

  async function runScanDemo() {
    if (state.scanning) return;
    state.scanning = true;
    const btn = $('#btn-scan');
    btn.disabled = true;
    btn.textContent = '扫描中…';
    $('#scan-console').innerHTML = '';
    const msgs = [
      [0, 8, 'start', '启动扫描任务 · 基准 TailorCV'],
      [1, 22, 'discover', 'Agent 研究竞品候选…'],
      [1, 35, 'discover', '发现 4 个候选：Rezi、Teal、Huntr、Careerflow'],
      [2, 48, 'enrich', '补全情报 (1/4): Rezi'],
      [2, 58, 'enrich', '补全情报 (2/4): Teal'],
      [3, 72, 'threat', '威胁判定 · BM25 召回 + RAG'],
      [3, 82, 'threat', 'Rezi 55% · Teal 58%'],
      [4, 92, 'verify', 'Agent 交叉校验候选质量…'],
      [5, 100, 'done', '完成：发现 4，待确认 2'],
    ];
    for (const [step, p, , msg] of msgs) {
      setPipe(step, step === 5 && p === 100);
      $('#scan-progress').style.width = p + '%';
      $('#scan-msg').textContent = msg;
      logLine(msg, p === 100 ? 'ok' : step >= 3 ? 'work' : 'info');
      await new Promise((r) => setTimeout(r, 420 + Math.random() * 280));
    }
    setPipe(5, true);
    state.scanning = false;
    btn.disabled = false;
    btn.textContent = '再扫一次';
  }

  function buildCompare() {
    const rows = [];
    for (const c of D.competitors) {
      rows.push(...comparePair(D.product, c));
    }
    state.compareRows = rows;
    renderCompare();
  }

  function renderCompare() {
    const rows = state.compareRows;
    const box = $('#compare-body');
    if (!rows) {
      box.innerHTML = `
        <div class="card">
          <p class="hint" style="margin-bottom:12px">
            Demo：对 <strong>${esc(D.product.name)}</strong> × 各竞品，把规格参数<strong>逐项</strong>对齐。
            不调用真实 LLM，不写威胁判定。
          </p>
          <button class="btn primary" id="btn-build-compare">生成参数对比表</button>
        </div>`;
      $('#btn-build-compare')?.addEventListener('click', () => {
        buildCompare();
        logDemoToast('已生成参数对比表');
      });
      return;
    }
    const st = state.filterStatus;
    const filtered = st
      ? rows.filter((r) =>
          st === 'diff'
            ? r.status === 'diff' || r.status === 'ours_only' || r.status === 'theirs_only'
            : r.status === st
        )
      : rows;

    box.innerHTML = `
      <div class="toolbar-row">
        <span class="hint">共 ${rows.length} 行参数 · 显示 ${filtered.length}</span>
        <select id="cmp-filter">
          <option value="">全部状态</option>
          <option value="diff" ${st === 'diff' ? 'selected' : ''}>不同 / 仅一方</option>
          <option value="same" ${st === 'same' ? 'selected' : ''}>相同</option>
          <option value="ours_only" ${st === 'ours_only' ? 'selected' : ''}>仅我方</option>
          <option value="theirs_only" ${st === 'theirs_only' ? 'selected' : ''}>仅竞品</option>
        </select>
        <button class="btn sm" id="btn-build-compare">重新生成</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>我方产品</th><th>竞品</th><th>参数</th><th>我方值</th><th>竞品值</th><th>对比</th>
            </tr>
          </thead>
          <tbody>
            ${filtered
              .map(
                (r) => `
              <tr>
                <td>${esc(r.productName)}</td>
                <td>${esc(r.competitorName)}</td>
                <td><strong>${esc(r.param)}</strong></td>
                <td class="val-cell">${esc(r.ourValue || '—')}</td>
                <td class="val-cell">${esc(r.theirValue || '—')}</td>
                <td><span class="st st-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
    $('#cmp-filter')?.addEventListener('change', (e) => {
      state.filterStatus = e.target.value;
      renderCompare();
    });
    $('#btn-build-compare')?.addEventListener('click', buildCompare);
  }

  function drawSpace() {
    const canvas = $('#space-canvas');
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const x = (w / 8) * i;
      const y = (h / 8) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const cx = w * 0.5;
    const cy = h * 0.52;
    // self
    ctx.fillStyle = '#6b9bff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx + 9, cy + 8);
    ctx.lineTo(cx - 9, cy + 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#9db9ff';
    ctx.font = '11px sans-serif';
    ctx.fillText(D.product.name, cx + 12, cy + 4);

    // competitors as bubbles by threat
    D.competitors.forEach((c, i) => {
      const ang = (i / D.competitors.length) * Math.PI * 2 - 0.4;
      const r = 40 + c.threat * 90;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r * 0.65;
      const rad = 6 + c.threat * 10;
      const g = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, rad);
      if (c.threat >= 0.5) {
        g.addColorStop(0, '#fda4af');
        g.addColorStop(1, '#e11d48');
      } else {
        g.addColorStop(0, '#6ee7b7');
        g.addColorStop(1, '#0f766e');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '11px sans-serif';
      ctx.fillText(`${c.name} ${pct(c.threat)}%`, x + rad + 4, y + 3);
    });
  }

  function openDetail(id) {
    const c = D.competitors.find((x) => x.id === id);
    if (!c) return;
    const specs = Object.entries(c.specs || {})
      .map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`)
      .join(' ');
    $('#drawer').classList.add('open');
    $('#drawer-body').innerHTML = `
      <h2>${esc(c.name)}</h2>
      <div class="sub">${esc(c.company)} · 威胁 ${pct(c.threat)}% · ${c.status === 'pending' ? '待确认' : '已确认'}</div>
      <p class="hint" style="margin-bottom:10px">价格：${esc(c.price_range || '—')}</p>
      <div class="chips">${specs}</div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn" id="drawer-close">关闭</button>
      </div>`;
    $('#drawer-close')?.addEventListener('click', () => $('#drawer').classList.remove('open'));
  }

  function logDemoToast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1800);
  }

  // init pipe
  $('#pipe').innerHTML = STEPS.map(
    (s) => `
    <div class="pipe-step" data-step="${s.id}">
      <div class="lamp"></div>
      <strong>${s.label}</strong>
      <small>${s.hint}</small>
    </div>`
  ).join('');

  $$('.nav-item').forEach((b) =>
    b.addEventListener('click', () => {
      setPage(b.dataset.page);
      if (b.dataset.page === 'compare') renderCompare();
    })
  );

  $('#btn-scan')?.addEventListener('click', runScanDemo);
  $('#btn-goto-scan')?.addEventListener('click', () => setPage('scan'));
  $('#btn-goto-compare')?.addEventListener('click', () => {
    setPage('compare');
    renderCompare();
  });

  document.addEventListener('click', (e) => {
    const card = e.target.closest('.comp-card[data-id]');
    if (card) openDetail(card.dataset.id);
    if (e.target.id === 'drawer' || e.target.id === 'drawer-close') {
      $('#drawer').classList.remove('open');
    }
  });

  window.addEventListener('resize', () => {
    if (state.page === 'space') drawSpace();
  });

  renderDashboard();
  renderCompetitors();
  renderCompare();
  setPage('dashboard');
})();
