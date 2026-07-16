/**
 * 浏览器 Demo 的 window.api —— 契约与 Electron preload 一致
 * 无真实 LLM / 无文件系统；数据在内存中
 */
(function () {
  const DEMO = window.DEMO;
  if (!DEMO) {
    console.error('[demo] DEMO data missing');
    return;
  }

  const listeners = {};
  function on(channel, cb) {
    if (!listeners[channel]) listeners[channel] = new Set();
    listeners[channel].add(cb);
    return () => listeners[channel]?.delete(cb);
  }
  function emit(channel, data) {
    (listeners[channel] || []).forEach((cb) => {
      try {
        cb(data);
      } catch (e) {
        console.error(e);
      }
    });
  }

  function ok(data) {
    return Promise.resolve({ ok: true, data, error: null });
  }
  function fail(message, code = 'ERROR') {
    return Promise.resolve({
      ok: false,
      data: null,
      error: { message, code },
    });
  }

  function uid(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }
  function now() {
    return new Date().toISOString();
  }

  // —— 内存状态（可改，不持久到仓库）——
  const state = {
    products: [
      {
        id: DEMO.product.id || 'p1',
        name: DEMO.product.name,
        category: DEMO.product.category || '',
        description: DEMO.product.description || 'Demo 基准产品',
        price: DEMO.product.price ?? null,
        specs: { ...(DEMO.product.specs || {}) },
        channels: [...(DEMO.product.channels || [])],
        keywords: [...(DEMO.product.keywords || [])],
        created_at: now(),
        updated_at: now(),
      },
    ],
    activeId: DEMO.product.id || 'p1',
    competitors: (DEMO.competitors || []).map((c) => ({
      id: c.id,
      name: c.name,
      company: c.company || '',
      category: c.category || DEMO.product.category || '',
      description: c.description || `${c.name} — Demo 竞品`,
      price: c.price ?? null,
      price_unit: 'USD',
      price_range: c.price_range || '',
      specs: { ...(c.specs || {}) },
      channels: [...(c.channels || [])],
      website: c.website || '',
      source_urls: [],
      tags: [],
      status: c.status || 'pending',
      threat_score: c.threat ?? 0.4,
      threat_dimensions: c.threat_dimensions || {
        price: 0.5,
        category: 0.6,
        features: 0.55,
        channels: 0.45,
        positioning: 0.5,
        price_edge: 0.3,
        channel_edge: 0.35,
        completeness: 0.7,
      },
      threat_reason: c.threat_reason || `【Demo】相对 ${DEMO.product.name} 的示例威胁评估`,
      threat_method: 'rag_bm25',
      threat_confidence: 0.72,
      rag_evidence: { neighbors: [], selfBm25: 0.4 },
      vector: null,
      notes: '',
      threat_vs: [
        {
          productId: DEMO.product.id || 'p1',
          productName: DEMO.product.name,
          score: c.threat ?? 0.4,
          reason: 'Demo',
          method: 'rag_bm25',
        },
      ],
      primary_product_id: DEMO.product.id || 'p1',
      primary_product_name: DEMO.product.name,
      created_at: now(),
      updated_at: now(),
    })),
    history: [],
    roadmaps: [],
    compareMatrix: null,
    loop: { enabled: false, cron: '0 */6 * * *', threatThreshold: 0.65, isRunning: false },
    llm: {
      provider: 'demo',
      baseUrl: 'https://demo.local/v1',
      apiKey: 'demo',
      model: 'demo-model',
      temperature: 0.3,
      timeoutMs: 120000,
      hasKey: true,
    },
    onboarding: { completed: true, step: 3, firstScanDone: true },
    ui: { theme: 'dark', lang: (typeof localStorage !== 'undefined' && localStorage.getItem('cs_lang')) || 'zh' },
    notifications: { desktop: true, minThreat: 0.65 },
  };

  function readiness() {
    const products = state.products;
    // Demo 不展示大模型配置项
    const checks = [
      {
        id: 'product',
        title: '完善产品画像',
        done: products.some((p) => p.name),
        weight: 40,
        cta: 'product',
        hint: '已配置',
      },
      {
        id: 'product_rich',
        title: '规格与渠道（推荐）',
        done: products.some((p) => (p.channels || []).length || Object.keys(p.specs || {}).length),
        weight: 20,
        cta: 'product',
        hint: '已配置',
      },
      {
        id: 'first_scan',
        title: '完成首次扫描',
        done: state.competitors.length > 0 || state.onboarding.firstScanDone,
        weight: 25,
        cta: 'scan',
        hint: '已完成',
      },
      {
        id: 'confirm',
        title: '确认至少 1 个竞品',
        done: state.competitors.some((c) => c.status === 'confirmed'),
        weight: 15,
        cta: 'competitors',
        hint: '可在竞品库确认',
      },
    ];
    const score = checks.reduce((s, c) => s + (c.done ? c.weight : 0), 0);
    const next = checks.find((c) => !c.done) || null;
    return {
      score,
      maxScore: 100,
      percent: score,
      ready: true,
      complete: checks.every((c) => c.done),
      canScan: true,
      checks,
      next,
      productName: activeProduct()?.name || null,
      productCount: products.length,
      products: products.map((p) => ({ id: p.id, name: p.name, active: p.id === state.activeId })),
      loopEnabled: !!state.loop.enabled,
      stats: statsCore(),
      onboardingCompleted: true,
    };
  }

  function activeProduct() {
    return state.products.find((p) => p.id === state.activeId) || state.products[0] || null;
  }

  function listCompetitors(filters = {}) {
    let list = [...state.competitors];
    if (filters.status) list = list.filter((c) => c.status === filters.status);
    if (filters.minThreat != null) list = list.filter((c) => (c.threat_score || 0) >= Number(filters.minThreat));
    if (filters.q) {
      const q = String(filters.q).toLowerCase();
      list = list.filter((c) =>
        `${c.name} ${c.company} ${c.description}`.toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => (b.threat_score || 0) - (a.threat_score || 0));
    if (filters.limit) list = list.slice(0, filters.limit);
    return list;
  }

  function statsCore() {
    const all = state.competitors;
    const total = all.length;
    const pending = all.filter((c) => c.status === 'pending').length;
    const confirmed = all.filter((c) => c.status === 'confirmed').length;
    const highThreat = all.filter((c) => (c.threat_score || 0) >= 0.65).length;
    const confirmedList = all.filter((c) => c.status === 'confirmed');
    const avgThreat =
      confirmedList.length === 0
        ? all.reduce((s, c) => s + (c.threat_score || 0), 0) / Math.max(total, 1)
        : confirmedList.reduce((s, c) => s + (c.threat_score || 0), 0) / confirmedList.length;
    const withPrice = all.filter((c) => c.price != null || c.price_range).length;
    const withChannels = all.filter((c) => (c.channels || []).length > 0).length;
    const withSpecs = all.filter((c) => c.specs && Object.keys(c.specs).length > 0).length;
    return {
      total,
      pending,
      confirmed,
      highThreat,
      avgThreat: Math.round(avgThreat * 100) / 100,
      recentScans: state.history.length,
      coverage: total
        ? {
            price: Math.round((withPrice / total) * 100),
            channels: Math.round((withChannels / total) * 100),
            specs: Math.round((withSpecs / total) * 100),
          }
        : { price: 0, channels: 0, specs: 0 },
      topThreats: listCompetitors({ status: 'confirmed', limit: 5 }).length
        ? listCompetitors({ status: 'confirmed', limit: 5 })
        : listCompetitors({ limit: 5 }),
      pendingList: listCompetitors({ status: 'pending', limit: 8 }),
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function fakeScan() {
    const steps = [
      { stage: 'start', message: '开始扫描（Demo）· 基准：' + (activeProduct()?.name || ''), percent: 5 },
      { stage: 'discover', message: 'Agent 正在研究竞品…', percent: 12 },
      { stage: 'discover-done', message: `发现 ${state.competitors.length} 个候选`, percent: 30 },
      { stage: 'enrich', message: '补全情报…', percent: 45 },
      { stage: 'rag', message: '威胁判定 · BM25 + RAG（模拟）', percent: 70 },
      { stage: 'verify', message: 'Agent 交叉校验…', percent: 88 },
      {
        stage: 'done',
        message: `扫描完成：发现 ${state.competitors.length}，高威胁 ${statsCore().highThreat}`,
        percent: 100,
      },
    ];
    for (const s of steps) {
      emit('scan:progress', { ...s, source: 'manual' });
      await sleep(350 + Math.random() * 250);
    }
    state.onboarding.firstScanDone = true;
    const hist = {
      id: uid('hist'),
      query: 'demo scan',
      status: 'done',
      trigger: 'manual',
      found_count: state.competitors.length,
      new_count: 0,
      threat_count: statsCore().highThreat,
      started_at: now(),
      finished_at: now(),
      summary: 'Demo 扫描',
      product_name: activeProduct()?.name,
      logs: steps.map((s) => ({ ...s, at: now() })),
    };
    state.history.unshift(hist);
    return {
      found: state.competitors.length,
      newCount: 0,
      newThreats: state.competitors.filter((c) => (c.threat_score || 0) >= 0.65),
      historyId: hist.id,
      readiness: readiness(),
    };
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
    if (entity.price_range) rows.push({ key: '价格区间', value: String(entity.price_range) });
    if (entity.category) rows.push({ key: '品类', value: entity.category });
    if ((entity.channels || []).length) {
      rows.push({
        key: '渠道',
        value: entity.channels.map((c) => (typeof c === 'string' ? c : c.name)).join('、'),
      });
    }
    for (const [k, v] of Object.entries(entity.specs || {})) {
      rows.push({ key: k, value: String(v) });
    }
    return rows.map((r) => ({ ...r, norm: normKey(r.key) }));
  }
  function buildParamMatrix() {
    const products = state.products;
    const comps = state.competitors;
    const flat = [];
    const pairs = [];
    const label = {
      same: '相同',
      diff: '不同',
      ours_only: '仅我方',
      theirs_only: '仅竞品',
      ours_higher: '我方数值高',
      theirs_higher: '竞品数值高',
    };
    for (const p of products) {
      for (const c of comps) {
        const ours = collectParams(p);
        const theirs = collectParams(c);
        const map = new Map(theirs.map((t) => [t.norm, t]));
        const used = new Set();
        const params = [];
        for (const o of ours) {
          const t = map.get(o.norm);
          if (t) used.add(t.norm);
          let status = 'diff';
          if (!t) status = 'ours_only';
          else if ((o.value || '').toLowerCase() === (t.value || '').toLowerCase()) status = 'same';
          const row = {
            productId: p.id,
            productName: p.name,
            competitorId: c.id,
            competitorName: c.name,
            company: c.company || '',
            param: o.key,
            ourValue: o.value,
            theirValue: t?.value || '',
            status,
            statusLabel: label[status],
            group: 'specs',
          };
          params.push(row);
          flat.push(row);
        }
        for (const t of theirs) {
          if (used.has(t.norm)) continue;
          const row = {
            productId: p.id,
            productName: p.name,
            competitorId: c.id,
            competitorName: c.name,
            company: c.company || '',
            param: t.key,
            ourValue: '',
            theirValue: t.value,
            status: 'theirs_only',
            statusLabel: label.theirs_only,
            group: 'specs',
          };
          params.push(row);
          flat.push(row);
        }
        pairs.push({ productId: p.id, competitorId: c.id, params });
      }
    }
    return {
      type: 'param-compare',
      updatedAt: now(),
      products: products.map((p) => ({ id: p.id, name: p.name })),
      competitorCount: comps.length,
      productCount: products.length,
      paramRowCount: flat.length,
      pairs,
      rows: flat,
    };
  }

  window.api = {
    bootstrap: () =>
      ok({
        version: '1.0.0-demo',
        platform: 'web-demo',
        readiness: readiness(),
        onboarding: state.onboarding,
        llm: { ...state.llm, apiKey: '••••demo', hasKey: true },
        product: activeProduct(),
        demo: true,
      }),
    getReadiness: () => ok(readiness()),
    getOnboarding: () => ok(state.onboarding),
    saveOnboarding: (partial) => {
      Object.assign(state.onboarding, partial || {});
      return ok(state.onboarding);
    },
    completeOnboarding: () => {
      state.onboarding.completed = true;
      return ok(state.onboarding);
    },

    getSettings: () =>
      ok({
        llm: { ...state.llm, apiKey: '••••demo', hasKey: true },
        loop: state.loop,
        notifications: state.notifications,
        ui: state.ui || { theme: 'dark', lang: 'zh' },
      }),
    getSettingsFull: () =>
      ok({
        llm: { ...state.llm, apiKey: '••••demo', hasKey: true },
        loop: state.loop,
        notifications: state.notifications,
        product: activeProduct(),
        products: { items: state.products, activeId: state.activeId },
        onboarding: state.onboarding,
        ui: state.ui || { theme: 'dark', lang: 'zh' },
      }),
    saveSettings: (partial) => {
      if (partial?.llm) Object.assign(state.llm, partial.llm, { apiKey: 'demo', hasKey: true });
      if (partial?.loop) Object.assign(state.loop, partial.loop);
      if (partial?.notifications) Object.assign(state.notifications, partial.notifications);
      if (partial?.ui) {
        state.ui = { ...(state.ui || { theme: 'dark', lang: 'zh' }), ...partial.ui };
      }
      return ok({ readiness: readiness(), ui: state.ui });
    },
    testLlm: async () => {
      await sleep(400);
      // 与桌面端 llm:test 返回形状一致
      return ok({ reply: 'OK', stats: { demo: true, model: state.llm.model } });
    },

    getProduct: () => ok(activeProduct()),
    listProducts: () =>
      ok({ products: state.products, activeId: state.activeId, active: activeProduct() }),
    saveProduct: (product) => {
      const p = product || {};
      if (p.id) {
        const i = state.products.findIndex((x) => x.id === p.id);
        if (i >= 0) state.products[i] = { ...state.products[i], ...p, updated_at: now() };
      } else {
        const row = {
          id: uid('p'),
          name: p.name || '未命名',
          category: p.category || '',
          description: p.description || '',
          price: p.price ?? null,
          specs: p.specs || {},
          channels: p.channels || [],
          keywords: p.keywords || [],
          created_at: now(),
          updated_at: now(),
        };
        state.products.push(row);
        if (!state.activeId) state.activeId = row.id;
      }
      return ok({ product: activeProduct(), readiness: readiness() });
    },
    deleteProduct: (id) => {
      state.products = state.products.filter((p) => p.id !== id);
      if (state.activeId === id) state.activeId = state.products[0]?.id || null;
      return ok({ readiness: readiness() });
    },
    setActiveProduct: (id) => {
      state.activeId = id;
      return ok({ active: activeProduct(), readiness: readiness() });
    },
    parseSpecFiles: async () => ok({ canceled: true, error: 'Demo 不支持本地文件解析' }),
    applySpecFields: () => ok({ readiness: readiness() }),

    listCompetitors: (filters) => ok(listCompetitors(filters || {})),
    getCompetitor: (id) => {
      const c = state.competitors.find((x) => x.id === id);
      return c ? ok(c) : fail('竞品不存在', 'NOT_FOUND');
    },
    upsertCompetitor: (data) => {
      const d = data || {};
      if (d.id) {
        const i = state.competitors.findIndex((x) => x.id === d.id);
        if (i >= 0) {
          state.competitors[i] = { ...state.competitors[i], ...d, updated_at: now() };
          return ok(state.competitors[i]);
        }
      }
      const row = {
        id: uid('c'),
        status: 'pending',
        threat_score: 0.35,
        threat_method: 'rules',
        threat_dimensions: {},
        channels: [],
        specs: {},
        ...d,
        created_at: now(),
        updated_at: now(),
      };
      state.competitors.push(row);
      return ok(row);
    },
    deleteCompetitor: (id) => {
      state.competitors = state.competitors.filter((c) => c.id !== id);
      return ok({ deleted: true });
    },
    confirmCompetitor: (id) => {
      const c = state.competitors.find((x) => x.id === id);
      if (!c) return fail('竞品不存在', 'NOT_FOUND');
      c.status = 'confirmed';
      c.updated_at = now();
      return ok(c);
    },
    rejectCompetitor: (id) => {
      const c = state.competitors.find((x) => x.id === id);
      if (!c) return fail('竞品不存在', 'NOT_FOUND');
      c.status = 'rejected';
      c.updated_at = now();
      return ok({ rejected: true });
    },

    runScan: async () => ok(await fakeScan()),
    confirmBatch: async (ids) => ok({ results: (ids || []).map((id) => ({ id, ok: true })) }),
    verifyOne: async (id) => {
      const c = state.competitors.find((x) => x.id === id);
      if (!c) return fail('未找到竞品');
      emit('scan:progress', { stage: 'verify', message: `Demo 校验 ${c.name}`, percent: 90 });
      await sleep(500);
      c.notes = (c.notes || '') + '\n[Demo Agent 校验通过]';
      return ok({ competitor: c });
    },

    analyzeAllThreats: async () => {
      const all = state.competitors;
      emit('threat:progress', { stage: 'start', message: '全库重算判定（Demo）', percent: 0 });
      for (let i = 0; i < all.length; i++) {
        emit('threat:progress', {
          stage: 'competitor',
          message: `重算 ${all[i].name}`,
          percent: Math.round(((i + 1) / all.length) * 100),
        });
        await sleep(120);
      }
      emit('threat:progress', { stage: 'done', message: '判定已更新（Demo）', percent: 100 });
      return ok({ ranked: all, competitorCount: all.length, productCount: state.products.length });
    },
    matchThreat: async (id) => {
      const c = state.competitors.find((x) => x.id === id);
      if (!c) return fail('未找到竞品');
      emit('threat:progress', { stage: 'start', message: `重算判定「${c.name}」`, percent: 10 });
      await sleep(400);
      emit('threat:progress', { stage: 'done', message: '完成', percent: 100 });
      return ok({
        threatScore: c.threat_score,
        threat_vs: c.threat_vs,
        primary_product_name: c.primary_product_name,
        method: c.threat_method,
      });
    },
    bm25Rank: () => ok([]),
    compareProductsMatrix: async () => {
      emit('threat:progress', { stage: 'start', message: '参数对比（Demo）', percent: 5 });
      await sleep(200);
      const matrix = buildParamMatrix();
      state.compareMatrix = matrix;
      emit('threat:progress', {
        stage: 'done',
        message: `参数对比完成：${matrix.paramRowCount} 行`,
        percent: 100,
      });
      return ok(matrix);
    },
    getCompareMatrix: () => ok(state.compareMatrix),

    generateRoadmap: async () => {
      emit('roadmap:progress', { stage: 'generate', message: '生成击败路径（Demo）…' });
      await sleep(600);
      const doc = {
        id: uid('rm'),
        title: `击败路径 · ${activeProduct()?.name || '产品'}`,
        goal: 'Demo 路线图',
        horizon: '12m',
        summary: '这是 Demo 生成的示例击败路径，非真实 LLM 输出。',
        phases: [
          { name: '0–3 月', focus: '补齐核心规格与渠道', items: ['完善 iOS 体验', '对标 ATS 能力'] },
          { name: '3–6 月', focus: '差异化', items: ['端上 OCR', '订阅定价实验'] },
          { name: '6–12 月', focus: '规模化', items: ['扩展渠道', '品牌内容'] },
        ],
        gaps: [{ area: '功能', priority: 'P0', note: 'JD 匹配深度' }],
        mustHave: ['ATS 友好导出', '求职信'],
        created_at: now(),
      };
      state.roadmaps.unshift(doc);
      emit('roadmap:progress', { stage: 'done', message: '路线图已生成' });
      return ok(doc);
    },
    latestRoadmap: () => ok(state.roadmaps[0] || null),
    listRoadmaps: (limit) => ok(state.roadmaps.slice(0, limit || 20)),
    getRoadmap: (id) => ok(state.roadmaps.find((r) => r.id === id) || null),
    deleteRoadmap: (id) => {
      state.roadmaps = state.roadmaps.filter((r) => r.id !== id);
      return ok({ deleted: true });
    },

    getLoopStatus: () =>
      ok({
        enabled: state.loop.enabled,
        isScheduled: state.loop.enabled,
        isRunning: state.loop.isRunning,
        cron: state.loop.cron,
        nextHint: state.loop.enabled ? '约 6 小时后（Demo）' : null,
      }),
    startLoop: () => {
      state.loop.enabled = true;
      return ok({ enabled: true });
    },
    stopLoop: () => {
      state.loop.enabled = false;
      return ok({ enabled: false });
    },
    runLoopNow: async () => {
      state.loop.isRunning = true;
      const r = await fakeScan();
      state.loop.isRunning = false;
      emit('loop:scan-complete', r);
      return ok(r);
    },

    getStats: () => ok({ ...statsCore(), readiness: readiness(), llmStats: { calls: 0, demo: true } }),
    listHistory: (limit) => ok(state.history.slice(0, limit || 20)),
    getHistory: (id) => ok(state.history.find((h) => h.id === id) || null),
    listChannels: () => {
      const set = new Set();
      state.competitors.forEach((c) => (c.channels || []).forEach((ch) => set.add(typeof ch === 'string' ? ch : ch.name)));
      return ok([...set]);
    },

    exportCompetitors: async () => ok({ canceled: true }),
    exportBackup: async () => ok({ canceled: true }),
    importBackup: async () => ok({ canceled: true }),
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener');
      return ok(true);
    },
    on,
  };

  console.info('[demo] mock api ready — full app UI, no real LLM');
})();
