const { app, BrowserWindow, ipcMain, Notification, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// 开发：数据落在项目 .data（方便调试，且已被 .gitignore 排除）
// 打包：使用系统 userData，避免把密钥/竞品库写进安装包目录
const isPackaged = app.isPackaged;
if (!isPackaged) {
  const userDataDir = path.join(__dirname, '..', '.data');
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch {
    /* ignore */
  }
  app.setPath('userData', userDataDir);
}
const userDataDir = app.getPath('userData');

// Windows 上部分环境 GPU/缓存权限会导致秒退；macOS 需保留 GPU 才能跑 WebGL 3D
try {
  if (process.platform === 'win32') {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-software-rasterizer');
  } else {
    // mac/linux：仅限制磁盘缓存，不关 GL
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  }
  app.commandLine.appendSwitch('disk-cache-size', '1');
  app.commandLine.appendSwitch('no-sandbox');
} catch {
  /* ignore */
}

// 单实例：第二次启动时聚焦已有窗口（不要 process.exit，避免诡异退出码）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error('another instance is running, quitting this one');
  app.quit();
}

const Store = require('electron-store');

const Database = require('./services/database');
const LLMService = require('./services/llm');
const SearchAgent = require('./services/search-agent');
const VectorMatcher = require('./services/vector-matcher');
const LoopEngine = require('./services/loop-engine');
const ThreatAnalyzer = require('./services/threat-analyzer');
const RoadmapAgent = require('./services/roadmap-agent');
const { AppError, Codes, ok, fail } = require('./services/errors');
const { validateCompetitor, validateLlm } = require('./services/validate');
const { computeReadiness } = require('./services/readiness');
const { exportCompetitors, exportFullBackup } = require('./services/export');
const Products = require('./services/products');
const SpecParser = require('./services/spec-parser');
const { SUPPORTED_EXT } = require('./services/spec-parser');

const logPath = path.join(userDataDir, 'startup.log');
function logBoot(msg, err) {
  const line = `[${new Date().toISOString()}] ${msg}${err ? ' ' + (err.stack || err.message || err) : ''}\n`;
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    /* ignore */
  }
  console.error(msg, err || '');
}

process.on('uncaughtException', (err) => {
  logBoot('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  logBoot('unhandledRejection', err);
});

// 配置/库文件：新名 competitor-scout；兼容旧名 competitor-intel（仅本地迁移，非品牌）
function migrateLegacyDataFiles(dir) {
  const pairs = [
    ['competitor-intel-config.json', 'competitor-scout-config.json'],
    ['competitor-intel.json', 'competitor-scout.json'],
  ];
  for (const [from, to] of pairs) {
    const src = path.join(dir, from);
    const dest = path.join(dir, to);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        logBoot(`migrated ${from} → ${to}`);
      }
    } catch (err) {
      logBoot(`migrate ${from} skip`, err);
    }
  }
}

// 若项目内尚无配置，尝试从旧 Roaming 目录拷贝一次，避免换路径后像「设置丢失」
try {
  const oldDir = path.join(app.getPath('appData'), 'competitor-intel');
  const legacyCfg = path.join(oldDir, 'competitor-intel-config.json');
  const newCfg = path.join(userDataDir, 'competitor-scout-config.json');
  if (fs.existsSync(legacyCfg) && !fs.existsSync(newCfg)) {
    fs.copyFileSync(legacyCfg, newCfg);
    logBoot('migrated config from Roaming');
  }
  migrateLegacyDataFiles(userDataDir);
} catch (err) {
  logBoot('config migrate skip', err);
}

const store = new Store({
  name: 'competitor-scout-config',
  cwd: userDataDir,
  defaults: {
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.3,
      /** 普通 chat 超时；research 任务至少 180s */
      timeoutMs: 120000,
    },
    product: {
      name: '',
      category: '',
      description: '',
      price: null,
      specs: {},
      channels: [],
      keywords: [],
    },
    products: {
      items: [],
      activeId: null,
    },
    loop: {
      enabled: false,
      cron: '0 */6 * * *',
      threatThreshold: 0.65,
    },
    notifications: {
      desktop: true,
      minThreat: 0.65,
    },
    onboarding: {
      completed: false,
      step: 0,
      firstScanDone: false,
      skippedAt: null,
    },
    ui: {
      theme: 'dark',
    },
  },
});

let mainWindow = null;
let db = null;
let llm = null;
let searchAgent = null;
let vectorMatcher = null;
let loopEngine = null;
let threatAnalyzer = null;
let roadmapAgent = null;
let specParser = null;
let ipcRegistered = false;

/** 统一 IPC 包装：统一 { ok, data, error }，捕获异常 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...args);
      // 若业务已返回契约结构，直接透传
      if (data && typeof data === 'object' && 'ok' in data && 'error' in data) {
        return data;
      }
      return ok(data);
    } catch (err) {
      console.error(`[ipc:${channel}]`, err);
      return fail(err);
    }
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  logBoot('createWindow: BrowserWindow…');
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    // 安装包/进程名用英文 CompetitorScout；窗口标题可用中文
    title: '竞品情报 · Competitor Scout',
    backgroundColor: '#0b0d13',
    // macOS：隐藏标题栏但保留红绿灯；内容区需自备 traffic-light 安全区
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    // 让窗口在 mac 上更像原生应用（圆角 + 阴影由系统绘制）
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 中文路径下更稳
      webSecurity: true,
    },
    // 直接显示，避免 ready-to-show 在部分 Windows/GPU 环境下不触发导致像秒退
    show: true,
  });

  const indexHtml = path.join(__dirname, '..', 'src', 'index.html');
  logBoot('createWindow: loadFile ' + indexHtml);
  mainWindow.loadFile(indexHtml).catch((err) => {
    logBoot('loadFile failed: ' + indexHtml, err);
  });

  mainWindow.once('ready-to-show', () => {
    logBoot('createWindow: ready-to-show');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logBoot(`did-fail-load code=${code} desc=${desc} url=${url}`);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logBoot('render-process-gone ' + JSON.stringify(details));
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function notifyUser(title, body, level = 'info') {
  const settings = store.get('notifications');
  if (!settings.desktop) return;

  if (Notification.isSupported()) {
    const n = new Notification({
      title,
      body,
      urgency: level === 'high' ? 'critical' : 'normal',
    });
    n.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
    n.show();
  }

  sendToRenderer('notification:push', {
    id: Date.now().toString(),
    title,
    body,
    level,
    time: new Date().toISOString(),
  });
}

function maskLlm(llmCfg) {
  const key = llmCfg.apiKey || '';
  return {
    ...llmCfg,
    apiKey: key ? `••••••••${key.slice(-4)}` : '',
    hasKey: Boolean(key),
  };
}

function initServices() {
  logBoot('initServices: database…');
  const userData = app.getPath('userData');
  migrateLegacyDataFiles(userData);
  db = new Database(path.join(userData, 'competitor-scout.json'));
  logBoot('initServices: products migrate…');
  Products.migrate(store);
  logBoot('initServices: llm…');
  llm = new LLMService(() => store.get('llm'));
  logBoot('initServices: matchers…');
  vectorMatcher = new VectorMatcher();
  threatAnalyzer = new ThreatAnalyzer(vectorMatcher, llm);
  roadmapAgent = new RoadmapAgent(llm);
  specParser = new SpecParser(llm);
  searchAgent = new SearchAgent(llm, db, threatAnalyzer, store);
  logBoot('initServices: loop…');
  loopEngine = new LoopEngine({
    store,
    searchAgent,
    db,
    onProgress: (p) => {
      sendToRenderer('scan:progress', { ...p, source: 'loop' });
    },
    onScanComplete: (result) => {
      try {
        store.set('onboarding.firstScanDone', true);
        sendToRenderer('loop:scan-complete', result);
        sendToRenderer('scan:progress', {
          stage: 'done',
          message: `后台扫描完成：新增 ${result.newCount || 0}`,
          percent: 100,
          source: 'loop',
          historyId: result.historyId,
        });
        if (result.newThreats?.length) {
          const top = result.newThreats[0];
          notifyUser(
            `发现高威胁竞品 · High threat: ${top.name}`,
            `威胁指数 ${(top.threatScore * 100).toFixed(0)}% · ${top.reason || '多维匹配命中'}`,
            'high'
          );
        } else if (result.newCount > 0) {
          notifyUser('竞品扫描完成 · Scan complete', `新发现 New ${result.newCount} candidates — confirm in library`, 'info');
        }
      } catch (err) {
        logBoot('onScanComplete error', err);
      }
    },
    onError: (err) => {
      sendToRenderer('loop:error', { message: err.message });
      sendToRenderer('scan:progress', {
        stage: 'error',
        message: err.message,
        source: 'loop',
      });
    },
  });
  logBoot('initServices: done');
}

function registerIpc() {
  if (ipcRegistered) {
    logBoot('registerIpc skipped (already registered)');
    return;
  }
  ipcRegistered = true;
  // ---- App bootstrap / readiness ----
  handle('app:bootstrap', () => {
    const readiness = computeReadiness(store, db);
    return {
      version: app.getVersion() || '1.0.0',
      platform: process.platform,
      readiness,
      onboarding: store.get('onboarding'),
      product: Products.stripId(Products.getActive(store)) || store.get('product'),
      products: Products.list(store),
      activeProductId: Products.getState(store).activeId,
      llm: maskLlm(store.get('llm')),
      loop: store.get('loop'),
      notifications: store.get('notifications'),
    };
  });

  handle('app:readiness', () => computeReadiness(store, db));

  handle('onboarding:get', () => store.get('onboarding'));

  handle('onboarding:save', (_e, partial) => {
    const next = { ...store.get('onboarding'), ...partial };
    store.set('onboarding', next);
    return next;
  });

  handle('onboarding:complete', () => {
    store.set('onboarding', {
      ...store.get('onboarding'),
      completed: true,
      step: 99,
    });
    return store.get('onboarding');
  });

  // ---- Settings ----
  handle('settings:get', () => ({
    llm: maskLlm(store.get('llm')),
    product: store.get('product'),
    loop: store.get('loop'),
    notifications: store.get('notifications'),
  }));

  handle('settings:get-full', () => ({
    llm: store.get('llm'),
    product: store.get('product'),
    loop: store.get('loop'),
    notifications: store.get('notifications'),
  }));

  handle('settings:save', (_e, partial) => {
    if (partial.llm) {
      const current = store.get('llm');
      const merged = { ...current, ...partial.llm };
      if (merged.apiKey && String(merged.apiKey).startsWith('••••')) {
        merged.apiKey = current.apiKey;
      }
      store.set('llm', validateLlm(merged));
    }
    if (partial.product) {
      Products.upsert(store, {
        ...(Products.getActive(store) || {}),
        ...partial.product,
        id: Products.getActive(store)?.id,
      });
    }
    if (partial.loop) {
      store.set('loop', { ...store.get('loop'), ...partial.loop });
      loopEngine.reload();
    }
    if (partial.notifications) {
      store.set('notifications', { ...store.get('notifications'), ...partial.notifications });
    }
    return {
      saved: true,
      readiness: computeReadiness(store, db),
    };
  });

  handle('llm:test', async () => {
    const result = await llm.chat([{ role: 'user', content: 'Reply with exactly: OK' }]);
    return { reply: result, stats: llm.getStats() };
  });

  // ---- Products (multi) ----
  handle('product:get', () => {
    const active = Products.getActive(store);
    return active || store.get('product') || null;
  });

  handle('product:list', () => ({
    products: Products.list(store),
    activeId: Products.getState(store).activeId,
    active: Products.getActive(store),
  }));

  handle('product:save', (_e, product) => {
    const result = Products.upsert(store, product || {});
    return {
      ...result,
      readiness: computeReadiness(store, db),
    };
  });

  handle('product:delete', (_e, id) => {
    const result = Products.remove(store, id);
    return { ...result, readiness: computeReadiness(store, db) };
  });

  handle('product:set-active', (_e, id) => {
    const result = Products.setActive(store, id);
    return { ...result, readiness: computeReadiness(store, db) };
  });

  // ---- 规格书上传解析（人工确认后再写入） ----
  // payload.paths 有值时直接解析（拖拽）；否则弹出文件选择框
  handle('product:parse-spec-files', async (_e, payload = {}) => {
    let filePaths = Array.isArray(payload?.paths)
      ? payload.paths.filter((p) => typeof p === 'string' && p.trim())
      : [];

    if (!filePaths.length) {
      const { canceled, filePaths: picked } = await dialog.showOpenDialog(mainWindow, {
        title: '选择规格书 / 产品文档 · Choose specs / product docs',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '规格文档',
            extensions: SUPPORTED_EXT.map((e) => e.replace(/^\./, '')),
          },
          { name: '全部文件', extensions: ['*'] },
        ],
      });
      if (canceled || !picked?.length) return { canceled: true };
      filePaths = picked;
    }

    sendToRenderer('product:parse-progress', {
      stage: 'extract',
      message: `正在读取 ${filePaths.length} 个文件…`,
    });

    try {
      sendToRenderer('product:parse-progress', {
        stage: 'llm',
        message: 'LLM 结构化抽取中…',
      });
      const result = await specParser.parseFiles(filePaths);
      sendToRenderer('product:parse-progress', {
        stage: 'done',
        message: '解析完成，请人工确认字段',
      });
      return { canceled: false, ...result };
    } catch (err) {
      sendToRenderer('product:parse-progress', {
        stage: 'error',
        message: err.message,
      });
      throw err;
    }
  });

  handle('product:apply-spec-fields', (_e, payload = {}) => {
    const { fields, productId, asNew } = payload;
    if (!Array.isArray(fields) || !fields.length) {
      throw new AppError(Codes.VALIDATION, '没有可应用的字段');
    }
    const selected = fields.filter((f) => f.selected);
    if (!selected.length) {
      throw new AppError(Codes.VALIDATION, '请至少勾选一项要导入的信息');
    }

    let base = {};
    if (!asNew && productId) {
      base = Products.getById(store, productId) || {};
    } else if (!asNew) {
      base = Products.getActive(store) || {};
    }

    const patch = specParser.applyFields(selected, {
      base,
      mergeSpecs: true,
    });

    // 附件来源备注
    if (payload.sources?.length) {
      const srcLine = payload.sources.map((s) => s.filename || s).join(', ');
      const note = `规格书导入: ${srcLine}`;
      patch.description = patch.description
        ? `${patch.description}\n${note}`
        : note;
    }

    if (!patch.name) {
      throw new AppError(Codes.VALIDATION, '产品名称不能为空，请勾选名称或先填写名称');
    }

    const savePayload = { ...patch };
    if (!asNew && (productId || base.id)) {
      savePayload.id = productId || base.id;
    }

    const result = Products.upsert(store, savePayload);
    return {
      ...result,
      applied: selected.map((f) => f.key),
      readiness: computeReadiness(store, db),
    };
  });

  // ---- Competitors ----
  handle('competitors:list', (_e, filters) => db.listCompetitors(filters || {}));

  handle('competitors:get', (_e, id) => {
    const row = db.getCompetitor(id);
    if (!row) throw new AppError(Codes.NOT_FOUND, '竞品不存在 · Competitor not found');
    return row;
  });

  handle('competitors:upsert', async (_e, data) => {
    const cleaned = validateCompetitor(data, { partial: Boolean(data.id) });
    if (data.id) cleaned.id = data.id;
    const row = db.upsertCompetitor(cleaned);
    // 自动 BM25+RAG：对全部己方产品取最高威胁
    const products = Products.list(store);
    if (products.length) {
      const corpus = db.listCompetitors({});
      const active = Products.getActive(store);
      // 入库快速路径：仅对当前基准产品走 RAG，其余产品规则分，再取最高威胁
      const scored = await threatAnalyzer.scoreAgainstProducts(products, row, {
        corpus,
        useRag: true,
        topK: 5,
        ragProductIds: active?.id ? [active.id] : [products[0].id],
      });
      db.updateThreatScore(row.id, scored.threatScore, scored.dimensions, scored.reason, {
        method: scored.method,
        confidence: scored.confidence,
        rag_evidence: scored.rag_evidence || scored.bm25,
        vector: scored.vector,
        rule_score: scored.rule_score,
        rag_score: scored.rag_score,
        threat_vs: scored.threat_vs,
        primary_product_id: scored.primary_product_id,
        primary_product_name: scored.primary_product_name,
      });
      return db.getCompetitor(row.id);
    }
    return row;
  });

  handle('competitors:delete', (_e, id) => {
    if (!db.getCompetitor(id)) throw new AppError(Codes.NOT_FOUND, '竞品不存在 · Competitor not found');
    db.deleteCompetitor(id);
    return { deleted: true };
  });

  handle('competitors:confirm', (_e, id) => {
    const row = db.confirmCompetitor(id);
    if (!row) throw new AppError(Codes.NOT_FOUND, '竞品不存在 · Competitor not found');
    return row;
  });

  handle('competitors:reject', (_e, id) => {
    if (!db.getCompetitor(id)) throw new AppError(Codes.NOT_FOUND, '竞品不存在 · Competitor not found');
    db.rejectCompetitor(id);
    return { rejected: true };
  });

  // ---- Scan & Agent ----
  handle('scan:run', async (_e, options) => {
    const readiness = computeReadiness(store, db);
    if (!readiness.canScan) {
      const next = readiness.next;
      throw new AppError(
        Codes.PRECONDITION,
        next ? `请先完成：${next.title}` : '尚未满足扫描条件',
        { readiness }
      );
    }
    sendToRenderer('scan:progress', {
      stage: 'start',
      message: '开始联网搜索…',
      percent: 2,
      source: 'manual',
    });
    const result = await searchAgent.runScan({
      ...options,
      trigger: 'manual',
      onProgress: (p) => sendToRenderer('scan:progress', { ...p, source: 'manual' }),
    });
    store.set('onboarding.firstScanDone', true);
    return { ...result, readiness: computeReadiness(store, db) };
  });

  handle('history:get', (_e, id) => {
    const row = db.getScanHistory(id);
    if (!row) throw new AppError(Codes.NOT_FOUND, '扫描记录不存在');
    return row;
  });

  handle('agent:confirm-batch', async (_e, ids) => {
    const results = [];
    for (const id of ids || []) {
      try {
        const c = db.getCompetitor(id);
        if (!c) {
          results.push({ id, error: '未找到' });
          continue;
        }
        const verified = await searchAgent.verifyCompetitor(c, (p) =>
          sendToRenderer('scan:progress', p)
        );
        results.push(verified);
      } catch (err) {
        results.push({ id, error: err.message });
      }
    }
    return { results };
  });

  handle('agent:verify-one', async (_e, id) => {
    const c = db.getCompetitor(id);
    if (!c) throw new AppError(Codes.NOT_FOUND, '未找到竞品 · Competitor not found');
    const verified = await searchAgent.verifyCompetitor(c, (p) =>
      sendToRenderer('scan:progress', p)
    );
    return { competitor: verified };
  });

  // ---- Threat (BM25 + RAG 核心自动判定) ----
  /** 全库重算判定分（不跑对比表；多产品仍按判定规则取最高） */
  handle('threat:analyze-all', async () => {
    const products = Products.list(store);
    if (!products.length) throw new AppError(Codes.PRECONDITION, '请先配置至少一个产品');
    const all = db.listCompetitors({});
    if (!all.length) return { ranked: [], productCount: products.length, competitorCount: 0 };

    const active = Products.getActive(store);
    sendToRenderer('threat:progress', {
      stage: 'start',
      message: `全库重算威胁判定 · Rescoring all (${all.length} competitors)`,
      percent: 0,
      productCount: products.length,
      competitorCount: all.length,
    });

    const ranked = await threatAnalyzer.rankAll(products[0], all, {
      useRag: true,
      topK: 5,
      products,
      ragProductIds: active?.id ? [active.id] : products[0]?.id ? [products[0].id] : undefined,
      onProgress: (p) => sendToRenderer('threat:progress', { ...p, source: 'analyze-all' }),
    });

    for (const item of ranked) {
      db.updateThreatScore(item.id, item.threatScore, item.dimensions, item.reason, {
        method: item.method,
        confidence: item.confidence,
        rag_evidence: item.rag_evidence || item.bm25,
        vector: item.vector,
        rule_score: item.rule_score,
        rag_score: item.rag_score,
        threat_vs: item.threat_vs,
        primary_product_id: item.primary_product_id,
        primary_product_name: item.primary_product_name,
      });
    }

    sendToRenderer('threat:progress', {
      stage: 'done',
      message: `判定已更新 · Updated: ${ranked.length} competitors`,
      percent: 100,
    });

    return {
      ranked,
      productCount: products.length,
      competitorCount: all.length,
    };
  });

  /** 单竞品重算判定（不跑对比表） */
  handle('threat:match', async (_e, competitorId) => {
    const products = Products.list(store);
    const id = typeof competitorId === 'string' ? competitorId : competitorId?.id;
    const c = db.getCompetitor(id || competitorId);
    if (!c) throw new AppError(Codes.NOT_FOUND, '未找到竞品 · Competitor not found');
    if (!products.length) throw new AppError(Codes.PRECONDITION, '请先配置产品');
    const corpus = db.listCompetitors({});
    const active = Products.getActive(store);

    sendToRenderer('threat:progress', {
      stage: 'start',
      message: `重算判定「${c.name}」`,
      percent: 5,
      competitorName: c.name,
    });

    const result = await threatAnalyzer.scoreAgainstProducts(products, c, {
      corpus,
      useRag: true,
      topK: 5,
      ragProductIds: active?.id ? [active.id] : products[0]?.id ? [products[0].id] : undefined,
    });
    db.updateThreatScore(c.id, result.threatScore, result.dimensions, result.reason, {
      method: result.method,
      confidence: result.confidence,
      rag_evidence: result.rag_evidence || result.bm25,
      vector: result.vector,
      rule_score: result.rule_score,
      rag_score: result.rag_score,
      threat_vs: result.threat_vs,
      primary_product_id: result.primary_product_id,
      primary_product_name: result.primary_product_name,
    });

    sendToRenderer('threat:progress', {
      stage: 'done',
      message: `「${c.name}」判定 ${Math.round((result.threatScore || 0) * 100)}%`,
      percent: 100,
    });

    return result;
  });

  /**
   * 参数级对比表：规格/价格/品类/渠道 一条一条遍历
   * 独立分析，**不写回** threat_score / 判定标准
   */
  handle('threat:compare-matrix', async () => {
    const products = Products.list(store);
    if (!products.length) throw new AppError(Codes.PRECONDITION, '请先配置至少一个产品');
    const all = db.listCompetitors({});
    if (!all.length) throw new AppError(Codes.PRECONDITION, '竞品库为空 · Library empty — scan or add competitors first');

    const { buildParamCompareMatrix } = require('./services/param-compare');

    sendToRenderer('threat:progress', {
      stage: 'start',
      message: `参数对比 · Param compare: ${products.length} products × ${all.length} competitors`,
      percent: 0,
      productCount: products.length,
      competitorCount: all.length,
    });

    const matrix = buildParamCompareMatrix(products, all, {
      onProgress: (p) => sendToRenderer('threat:progress', { ...p, source: 'param-compare' }),
    });

    store.set('productCompare', matrix);

    sendToRenderer('threat:progress', {
      stage: 'done',
      message: `参数对比完成：${matrix.paramRowCount} 行（未改判定）`,
      percent: 100,
    });

    return matrix;
  });

  handle('threat:compare-get', () => store.get('productCompare') || null);

  handle('threat:bm25-rank', (_e, topK) => {
    const product = Products.getActive(store);
    if (!product?.name) throw new AppError(Codes.PRECONDITION, '请先配置我的产品');
    return threatAnalyzer.rankByBm25(product, db.listCompetitors({}), topK || 50);
  });

  // ---- Roadmap (AI 击败路径) ----
  handle('roadmap:generate', async (_e, options = {}) => {
    const products = Products.list(store);
    if (!products.length) {
      throw new AppError(Codes.PRECONDITION, '请先配置至少一个己方产品');
    }
    let competitors = db.listCompetitors({});
    // 默认用已确认 + 高威胁；若太少则用全部
    const preferred = competitors.filter(
      (c) => c.status === 'confirmed' || (c.threat_score || 0) >= 0.4
    );
    if (preferred.length >= 3) competitors = preferred;
    if (!competitors.length) {
      throw new AppError(Codes.PRECONDITION, '竞品库为空 · Library empty — scan or add competitors first');
    }

    sendToRenderer('roadmap:progress', {
      stage: 'generate',
      message: 'AI 正在模拟击败路径…',
    });

    const plan = await roadmapAgent.generate({
      products,
      competitors,
      focusProductId: options.focusProductId || Products.getState(store).activeId,
      horizon: options.horizon || '12m',
      goal: options.goal,
    });

    const saved = db.saveRoadmap({
      ...plan,
      status: 'ready',
    });
    sendToRenderer('roadmap:progress', { stage: 'done', message: '路线图已生成' });
    return saved;
  });

  handle('roadmap:latest', () => db.getLatestRoadmap());
  handle('roadmap:list', (_e, limit) => db.listRoadmaps(limit || 20));
  handle('roadmap:get', (_e, id) => {
    const row = db.getRoadmap(id);
    if (!row) throw new AppError(Codes.NOT_FOUND, '路线图不存在');
    return row;
  });
  handle('roadmap:delete', (_e, id) => {
    db.deleteRoadmap(id);
    return { deleted: true };
  });

  // ---- Loop ----
  handle('loop:status', () => loopEngine.getStatus());

  handle('loop:start', () => {
    const readiness = computeReadiness(store, db);
    if (!readiness.canScan) {
      throw new AppError(Codes.PRECONDITION, '请先完成 LLM 与产品配置，再启动 Loop');
    }
    loopEngine.start();
    return loopEngine.getStatus();
  });

  handle('loop:stop', () => {
    loopEngine.stop();
    return loopEngine.getStatus();
  });

  handle('loop:run-now', async () => {
    const readiness = computeReadiness(store, db);
    if (!readiness.canScan) {
      throw new AppError(Codes.PRECONDITION, '请先完成 LLM 与产品配置');
    }
    return loopEngine.runOnce();
  });

  // ---- Dashboard ----
  handle('dashboard:stats', () => ({
    ...db.getStats(),
    readiness: computeReadiness(store, db),
    llmStats: llm.getStats(),
  }));

  handle('history:list', (_e, limit) => db.listScanHistory(limit || 20));
  handle('channels:list', () => db.listChannels());

  // ---- Export / Backup ----
  handle('export:competitors', async (_e, format = 'json') => {
    const list = db.listCompetitors({});
    const file = exportCompetitors(list, format);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出竞品 · Export competitors',
      defaultPath: file.filename,
      filters:
        format === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, file.content, 'utf8');
    return { canceled: false, path: filePath, count: list.length };
  });

  handle('export:backup', async () => {
    const file = exportFullBackup(
      {
        llm: store.get('llm'),
        product: store.get('product'),
        products: store.get('products'),
        loop: store.get('loop'),
        notifications: store.get('notifications'),
        onboarding: store.get('onboarding'),
      },
      db.getSnapshot()
    );
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '备份全部数据 · Backup all data',
      defaultPath: file.filename,
      filters: [{ name: 'JSON Backup', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, file.content, 'utf8');
    return { canceled: false, path: filePath };
  });

  handle('import:backup', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '从备份恢复 · Restore from backup',
      filters: [{ name: 'JSON Backup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths?.[0]) return { canceled: true };
    const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (raw.settings) {
      if (raw.settings.llm) store.set('llm', { ...store.get('llm'), ...raw.settings.llm });
      if (raw.settings.products) store.set('products', raw.settings.products);
      if (raw.settings.product) store.set('product', raw.settings.product);
      Products.migrate(store);
      if (raw.settings.loop) store.set('loop', { ...store.get('loop'), ...raw.settings.loop });
      if (raw.settings.notifications) {
        store.set('notifications', { ...store.get('notifications'), ...raw.settings.notifications });
      }
    }
    const data = raw.data || raw;
    const stats = db.restoreSnapshot(data);
    loopEngine.reload();
    return { canceled: false, stats, readiness: computeReadiness(store, db) };
  });

  handle('shell:open-external', (_e, url) => {
    if (url && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { opened: true };
  });
}

app.on('second-instance', () => {
  // 用户再次双击启动：唤起已有窗口，而不是新开后立刻退出
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

if (gotLock) {
  app
    .whenReady()
    .then(() => {
      try {
        logBoot('app ready, init…');
        initServices();
        logBoot('registerIpc…');
        registerIpc();
        logBoot('createWindow…');
        createWindow();
        logBoot('startup complete');

        if (store.get('loop.enabled')) {
          try {
            loopEngine.start();
          } catch (err) {
            logBoot('loop auto-start failed', err);
          }
        }
      } catch (err) {
        logBoot('startup fatal', err);
        try {
          dialog.showErrorBox(
            '启动失败',
            ((err && err.message) || String(err)) + '\n\n详见:\n' + logPath
          );
        } catch {
          /* ignore */
        }
        // 延迟退出，确保错误框能显示
        setTimeout(() => app.quit(), 500);
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((err) => {
      logBoot('whenReady rejected', err);
      setTimeout(() => app.quit(), 300);
    });
}

app.on('window-all-closed', () => {
  logBoot('window-all-closed');
  if (loopEngine) {
    try {
      loopEngine.stop();
    } catch {
      /* ignore */
    }
  }
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== 'darwin') app.quit();
});
