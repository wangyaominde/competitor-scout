const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 渲染进程 API
 * 约定：所有 invoke 返回 { ok, data, error }
 * 此处再包一层 unwrap，前端可直接 try/catch 或看 ok
 */
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

/** 从拖拽/选择的 File 对象解析本地路径（Electron 32+ 用 webUtils） */
function pathsFromFiles(files) {
  const list = Array.isArray(files) ? files : Array.from(files || []);
  const paths = [];
  for (const f of list) {
    if (!f) continue;
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
        continue;
      }
    } catch {
      /* fallthrough */
    }
    if (f.path) paths.push(f.path);
  }
  return paths;
}

contextBridge.exposeInMainWorld('api', {
  // Bootstrap
  bootstrap: () => invoke('app:bootstrap'),
  getReadiness: () => invoke('app:readiness'),
  getOnboarding: () => invoke('onboarding:get'),
  saveOnboarding: (partial) => invoke('onboarding:save', partial),
  completeOnboarding: () => invoke('onboarding:complete'),

  // Settings
  getSettings: () => invoke('settings:get'),
  getSettingsFull: () => invoke('settings:get-full'),
  saveSettings: (partial) => invoke('settings:save', partial),
  testLlm: () => invoke('llm:test'),

  // Products
  getProduct: () => invoke('product:get'),
  listProducts: () => invoke('product:list'),
  saveProduct: (product) => invoke('product:save', product),
  deleteProduct: (id) => invoke('product:delete', id),
  setActiveProduct: (id) => invoke('product:set-active', id),
  /**
   * 解析规格书。
   * - 无参：弹出系统文件选择
   * - 传入 File / File[] / FileList：拖拽上传
   * - 传入 string[]：直接按路径解析
   */
  parseSpecFiles: (input) => {
    if (input == null) {
      return invoke('product:parse-spec-files', {});
    }
    if (Array.isArray(input) && input.length && typeof input[0] === 'string') {
      return invoke('product:parse-spec-files', { paths: input });
    }
    const paths = pathsFromFiles(input);
    if (!paths.length) {
      return Promise.resolve({
        canceled: true,
        error: '无法读取拖入文件的本地路径',
      });
    }
    return invoke('product:parse-spec-files', { paths });
  },
  applySpecFields: (payload) => invoke('product:apply-spec-fields', payload),

  // Competitors
  listCompetitors: (filters) => invoke('competitors:list', filters),
  getCompetitor: (id) => invoke('competitors:get', id),
  upsertCompetitor: (data) => invoke('competitors:upsert', data),
  deleteCompetitor: (id) => invoke('competitors:delete', id),
  confirmCompetitor: (id) => invoke('competitors:confirm', id),
  rejectCompetitor: (id) => invoke('competitors:reject', id),

  // Scan & Agent
  runScan: (options) => invoke('scan:run', options),
  confirmBatch: (ids) => invoke('agent:confirm-batch', ids),
  verifyOne: (id) => invoke('agent:verify-one', id),

  // Threat (BM25 + RAG)
  analyzeAllThreats: () => invoke('threat:analyze-all'),
  matchThreat: (id) => invoke('threat:match', id),
  bm25Rank: (topK) => invoke('threat:bm25-rank', topK),

  // Roadmap
  generateRoadmap: (options) => invoke('roadmap:generate', options),
  latestRoadmap: () => invoke('roadmap:latest'),
  listRoadmaps: (limit) => invoke('roadmap:list', limit),
  getRoadmap: (id) => invoke('roadmap:get', id),
  deleteRoadmap: (id) => invoke('roadmap:delete', id),

  // Loop
  getLoopStatus: () => invoke('loop:status'),
  startLoop: () => invoke('loop:start'),
  stopLoop: () => invoke('loop:stop'),
  runLoopNow: () => invoke('loop:run-now'),

  // Dashboard
  getStats: () => invoke('dashboard:stats'),
  listHistory: (limit) => invoke('history:list', limit),
  getHistory: (id) => invoke('history:get', id),
  listChannels: () => invoke('channels:list'),

  // Export
  exportCompetitors: (format) => invoke('export:competitors', format),
  exportBackup: () => invoke('export:backup'),
  importBackup: () => invoke('import:backup'),

  openExternal: (url) => invoke('shell:open-external', url),

  on: (channel, callback) => {
    const valid = [
      'scan:progress',
      'loop:scan-complete',
      'loop:error',
      'notification:push',
      'roadmap:progress',
      'product:parse-progress',
    ];
    if (!valid.includes(channel)) return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
