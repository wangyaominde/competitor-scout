/**
 * 系统冒烟测试（无需 GUI）
 * 运行: node scripts/smoke-test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
process.chdir(root);

let failed = 0;
const findings = [];

function ok(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else {
    console.log('  ✗', msg);
    failed++;
    findings.push({ level: 'error', msg });
  }
}
function info(msg) {
  console.log('  ·', msg);
  findings.push({ level: 'info', msg });
}
function warn(msg) {
  console.log('  !', msg);
  findings.push({ level: 'warn', msg });
}

console.log('\n========== 1. 文件与依赖 ==========');
ok(fs.existsSync('electron/main.js'), 'main.js');
ok(fs.existsSync('electron/preload.js'), 'preload.js');
ok(fs.existsSync('src/index.html'), 'index.html');
ok(fs.existsSync('src/js/app.js'), 'app.js');
ok(fs.existsSync('src/js/threat-viz.js'), 'threat-viz.js');
ok(fs.existsSync('src/vendor/three.module.min.js'), 'three vendor');
// 跨平台 Electron 二进制路径
const electronCandidates = [
  'node_modules/electron/dist/electron.exe',
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  'node_modules/electron/dist/electron',
];
const electronBin = electronCandidates.find((p) => fs.existsSync(p));
ok(Boolean(electronBin), `electron binary (${electronBin || 'missing'})`);
ok(fs.existsSync('node_modules/three'), 'three package');
ok(fs.existsSync('node_modules/node-cron'), 'node-cron');
ok(fs.existsSync('node_modules/electron-store'), 'electron-store');
ok(fs.existsSync('node_modules/uuid'), 'uuid');
ok(fs.existsSync('.gitignore'), '.gitignore');
ok(fs.readFileSync('.gitignore', 'utf8').includes('.data'), '.gitignore excludes .data');

console.log('\n========== 2. IPC 契约 ==========');
const pre = fs.readFileSync('electron/preload.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');
const appJs = fs.readFileSync('src/js/app.js', 'utf8');
const html = fs.readFileSync('src/index.html', 'utf8');
const viz = fs.readFileSync('src/js/threat-viz.js', 'utf8');

const preApis = [...pre.matchAll(/invoke\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
const mainHandlers = [...main.matchAll(/handle\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
const preKeys = [...pre.matchAll(/^\s{2}([a-zA-Z0-9_]+):/gm)].map((m) => m[1]);
// 仅匹配调用形态 api.foo( / api.foo. — 排除 URL 里的 api.openai.com
const appCalls = [
  ...new Set(
    [...appJs.matchAll(/(?<![a-zA-Z0-9_/])api\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)].map(
      (m) => m[1]
    )
  ),
].filter((c) => c !== 'on');

for (const a of preApis) {
  ok(mainHandlers.includes(a), `handler exists: ${a}`);
}
for (const c of appCalls) {
  ok(preKeys.includes(c), `preload exposes api.${c}`);
}

const pages = [
  'dashboard',
  'competitors',
  'scan',
  'product',
  'roadmap',
  'loop',
  'settings',
];
console.log('\n========== 3. 页面与导航 ==========');
for (const p of pages) {
  ok(appJs.includes(`case '${p}'`), `page case: ${p}`);
  ok(html.includes(`data-page="${p}"`), `nav: ${p}`);
}

console.log('\n========== 4. 可视化关键符号 ==========');
for (const m of [
  '_drawTargets',
  '_drawRoadmapPaths',
  'setRoadmapScene',
  '_coordsFromDims',
  'layout',
]) {
  ok(viz.includes(m), `threat-viz: ${m}`);
}
ok(appJs.includes('mountRoadmapViz'), 'app mountRoadmapViz');
ok(appJs.includes('buildRoadmapVizModel'), 'app buildRoadmapVizModel');
ok(appJs.includes('roadmapVizShell'), 'app roadmapVizShell');

console.log('\n========== 5. 核心服务逻辑 ==========');
const DB = require(path.join(root, 'electron/services/database'));
const Products = require(path.join(root, 'electron/services/products'));
const { validateProduct, validateLlm } = require(path.join(root, 'electron/services/validate'));
const { Codes } = require(path.join(root, 'electron/services/errors'));
const { computeReadiness } = require(path.join(root, 'electron/services/readiness'));
const {
  buildCompetitorIndex,
  productToQuery,
} = require(path.join(root, 'electron/services/bm25'));
const VectorMatcher = require(path.join(root, 'electron/services/vector-matcher'));
const ThreatAnalyzer = require(path.join(root, 'electron/services/threat-analyzer'));
const RoadmapAgent = require(path.join(root, 'electron/services/roadmap-agent'));
const { exportCompetitors } = require(path.join(root, 'electron/services/export'));
const LoopEngine = require(path.join(root, 'electron/services/loop-engine'));

const dbPath = path.join(os.tmpdir(), `ci-smoke-${Date.now()}.json`);
const db = new DB(dbPath);

// products store mock
const storeData = {
  products: { items: [], activeId: null },
  product: { name: '', category: '', description: '', price: null, specs: {}, channels: [], keywords: [] },
  llm: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'x', apiKey: '' },
  loop: { enabled: false, cron: '0 */6 * * *', threatThreshold: 0.65 },
  onboarding: { completed: false },
};
const store = {
  get: (k) => {
    if (k.includes('.')) {
      const [a, b] = k.split('.');
      return storeData[a]?.[b];
    }
    return storeData[k];
  },
  set: (k, v) => {
    if (k.includes('.')) {
      const [a, b] = k.split('.');
      storeData[a] = storeData[a] || {};
      storeData[a][b] = v;
    } else storeData[k] = v;
  },
};

Products.upsert(store, {
  name: '我方POS-A',
  category: '支付终端',
  price: 1200,
  description: '扫码支付',
  channels: ['银行渠道', '官网'],
  specs: { 屏幕: '5寸' },
  keywords: ['POS', '扫码'],
});
Products.upsert(store, {
  name: '我方POS-B',
  category: '支付终端',
  price: 800,
  channels: ['京东'],
});
ok(Products.list(store).length === 2, 'multi product count=2');
Products.setActive(store, Products.list(store)[0].id);
ok(Products.getActive(store).name === '我方POS-A', 'active product');

const cA = db.upsertCompetitor({
  name: 'Verifone P400',
  company: 'Verifone',
  price: 1500,
  price_range: '1500-3000',
  channels: ['银行渠道'],
  specs: { 屏幕: '4寸' },
  description: '支付终端',
  status: 'pending',
});
db.upsertCompetitor({
  name: 'PAX Q92',
  company: 'PAX',
  price: 1000,
  channels: ['百富官网'],
  status: 'confirmed',
  threat_score: 0.7,
});
ok(db.listCompetitors({}).length === 2, 'competitors seeded');

const product = Products.getActive(store);
const corpus = db.listCompetitors({});
const hits = buildCompetitorIndex(corpus).search(productToQuery(product), {
  topK: 5,
});
ok(hits.length >= 1, `BM25 hits=${hits.length}`);

const vm = new VectorMatcher();
const vs = vm.score(product, cA);
ok(vs.threatScore >= 0 && vs.threatScore <= 1, `vector score=${vs.threatScore}`);

const mockLlm = {
  async research() {
    return {
      threatScore: 0.77,
      reason: '渠道重合且价格接近',
      dimensions: {
        price: 0.7,
        category: 0.8,
        features: 0.5,
        channels: 0.9,
        positioning: 0.4,
        price_edge: 0.2,
        channel_edge: 0.3,
        completeness: 0.7,
      },
      confidence: 0.85,
      evidence_used: ['银行'],
      is_direct_competitor: true,
    };
  },
};
const ta = new ThreatAnalyzer(vm, mockLlm);

(async () => {
  const multi = await ta.scoreAgainstProducts(Products.list(store), cA, {
    corpus,
    useRag: true,
  });
  ok(multi.threat_vs?.length === 2, 'threat vs both products');
  ok(!!multi.primary_product_name, 'primary product named');

  db.updateThreatScore(cA.id, multi.threatScore, multi.dimensions, multi.reason, {
    method: multi.method,
    confidence: multi.confidence,
    threat_vs: multi.threat_vs,
    primary_product_id: multi.primary_product_id,
    primary_product_name: multi.primary_product_name,
    rag_evidence: multi.rag_evidence || multi.bm25,
  });
  const saved = db.getCompetitor(cA.id);
  ok(saved.primary_product_name != null, 'persisted primary_product_name');
  ok(Array.isArray(saved.threat_vs), 'persisted threat_vs');

  const ra = new RoadmapAgent({
    async research() {
      return {
        title: '击败路径测试',
        summary: '摘要',
        northStar: '份额',
        positioning: { statement: '中端支付终端', winTheme: '性价比' },
        beatList: [{ competitor: 'Verifone P400', threatScore: 0.7, howToBeat: '渠道下沉' }],
        gaps: [{ area: '功能', priority: 'P0', current: '弱', target: '强', against: 'PAX' }],
        mustHave: [{ name: '双屏', priority: 'P0', reason: '门店' }],
        differentiators: [{ name: '本地化服务', moat: '中', reason: '服务网' }],
        priceStrategy: { band: '800-1200', logic: '下探' },
        channelStrategy: { priorityChannels: ['京东', '银行'], actions: ['联营'] },
        phases: [
          { name: '0-3月', theme: '补齐', goals: ['g'], deliverables: ['d'], metrics: ['m'], risks: [] },
          { name: '3-6月', theme: '放量', goals: [], deliverables: [], metrics: [], risks: [] },
          { name: '6-12月', theme: '收割', goals: [], deliverables: [], metrics: [], risks: [] },
        ],
        kpis: [{ name: '转化', baseline: '1%', target: '3%', when: 'Q4' }],
        nextActions: [{ action: '对标参数表', owner: '产品', urgency: '高' }],
        assumptions: ['预算充足'],
        confidence: 0.72,
      };
    },
  });
  const road = await ra.generate({
    products: Products.list(store),
    competitors: db.listCompetitors({}),
  });
  ok(road.phases.length === 3, 'roadmap 3 phases');
  ok(road.meta.focusProductName, 'roadmap focus name');
  const savedRm = db.saveRoadmap(road);
  ok(db.getLatestRoadmap().id === savedRm.id, 'roadmap persisted');

  // readiness
  const ready = computeReadiness(store, db);
  ok(ready.canScan === true, `readiness canScan score=${ready.percent}`);

  // export
  const csv = exportCompetitors(db.listCompetitors({}), 'csv');
  ok(csv.content.includes('Verifone'), 'export contains competitor');

  // loop
  const loop = new LoopEngine({
    store,
    searchAgent: {
      runScan: async () => ({ found: 1, newCount: 1, newThreats: [] }),
    },
    db,
  });
  ok(loop.getStatus().isScheduled === false, 'loop not scheduled by default');

  // validate edges
  try {
    validateProduct({ name: '' });
    ok(false, 'empty product should throw');
  } catch (e) {
    ok(e.code === Codes.VALIDATION, 'validation error code');
  }
  try {
    validateLlm({ baseUrl: 'ftp://x', model: 'm' });
    ok(false, 'bad protocol should throw');
  } catch (e) {
    ok(e.code === Codes.VALIDATION, 'llm url validation');
  }

  const loopOnce = await loop.runOnce();
  ok(loopOnce && typeof loopOnce.found === 'number', 'loop.runOnce returns scan result');

  // restore snapshot missing roadmaps default in old files — already handled
  const snap = db.getSnapshot();
  ok(Array.isArray(snap.roadmaps), 'snapshot has roadmaps');

  db.close();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }

  console.log('\n========== 6. 已知风险 / 建议 ==========');
  // scan without LLM will fail at runtime - expected
  info('扫描/RAG/击败路径依赖真实 LLM，本冒烟用 mock，未测网络与模型质量');
  info('前端 Three.js / UI 需人工点一遍 3D 交互与筛选');
  // chip.red - check CSS
  const css = fs.readFileSync('src/styles/app.css', 'utf8');
  ok(css.includes('.chip.red') || css.includes('chip red'), 'chip.red style exists');
  ok(css.includes('viz-label-target'), 'target label style');

  // CSP and three path
  ok(html.includes('threat-viz.js'), 'html loads threat-viz');
  ok(html.includes('type="module"'), 'threat-viz as module');

  console.log('\n========== 结果 ==========');
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  console.log(`失败: ${failed}, 警告: ${warns.length}, 信息: ${findings.filter((f) => f.level === 'info').length}`);
  if (failed > 0) {
    console.log('\n失败项:');
    errors.forEach((e) => console.log(' -', e.msg));
    process.exit(1);
  }
  console.log('\n冒烟测试通过（逻辑层）。建议再做一次 GUI 手测清单。');
  process.exit(0);
})().catch((e) => {
  console.error('TEST ERROR', e);
  process.exit(1);
});
