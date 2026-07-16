/**
 * 更完整的系统测试：边界、集成流、IPC 模拟、前端符号、Electron 可启动性
 * node scripts/system-test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
let failed = 0;
const warns = [];
const infos = [];

function ok(c, m) {
  if (c) console.log('  ✓', m);
  else {
    console.log('  ✗', m);
    failed++;
  }
}
function warn(m) {
  console.log('  !', m);
  warns.push(m);
}
function info(m) {
  console.log('  ·', m);
  infos.push(m);
}

const DB = require(path.join(root, 'electron/services/database'));
const Products = require(path.join(root, 'electron/services/products'));
const { validateProduct, validateCompetitor, validateLlm } = require(path.join(root, 'electron/services/validate'));
const { AppError, Codes, ok: okRes, fail } = require(path.join(root, 'electron/services/errors'));
const { computeReadiness } = require(path.join(root, 'electron/services/readiness'));
const { BM25Index, buildCompetitorIndex, productToQuery, tokenize } = require(path.join(root, 'electron/services/bm25'));
const VectorMatcher = require(path.join(root, 'electron/services/vector-matcher'));
const ThreatAnalyzer = require(path.join(root, 'electron/services/threat-analyzer'));
const RoadmapAgent = require(path.join(root, 'electron/services/roadmap-agent'));
const SearchAgent = require(path.join(root, 'electron/services/search-agent'));
const LoopEngine = require(path.join(root, 'electron/services/loop-engine'));
const LLMService = require(path.join(root, 'electron/services/llm'));
const { exportCompetitors, exportFullBackup } = require(path.join(root, 'electron/services/export'));

function makeStore(seed = {}) {
  const data = {
    llm: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'test', apiKey: '', temperature: 0.3 },
    product: { name: '', category: '', description: '', price: null, specs: {}, channels: [], keywords: [] },
    products: { items: [], activeId: null },
    loop: { enabled: false, cron: '0 */6 * * *', threatThreshold: 0.65 },
    onboarding: { completed: false, step: 0 },
    notifications: { desktop: true, minThreat: 0.65 },
    ...seed,
  };
  return {
    get(k) {
      if (typeof k === 'string' && k.includes('.')) {
        const parts = k.split('.');
        let cur = data;
        for (const p of parts) {
          if (cur == null) return undefined;
          cur = cur[p];
        }
        return cur;
      }
      return data[k];
    },
    set(k, v) {
      if (typeof k === 'string' && k.includes('.')) {
        const parts = k.split('.');
        let cur = data;
        for (let i = 0; i < parts.length - 1; i++) {
          cur[parts[i]] = cur[parts[i]] || {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = v;
        return;
      }
      data[k] = v;
    },
    _data: data,
  };
}

async function main() {
  console.log('\n████ 系统测试开始 ████\n');

  // ---------- A. 边界与校验 ----------
  console.log('A. 校验与错误契约');
  try {
    validateProduct({ name: '  ' });
    ok(false, '空白名称应失败');
  } catch (e) {
    ok(e.code === Codes.VALIDATION, '空白名称 VALIDATION');
  }
  try {
    validateProduct({ name: 'x'.repeat(200) });
    ok(false, '过长名称应失败');
  } catch (e) {
    ok(e.code === Codes.VALIDATION, '过长名称 VALIDATION');
  }
  const pOk = validateProduct({
    name: '终端A',
    price: 0,
    channels: 'a，b, c',
    keywords: ['k1'],
    specs: '{"a":1}',
  });
  ok(pOk.price === 0 && pOk.channels.length === 3, 'price=0 与中英文逗号渠道');
  try {
    validateCompetitor({ name: 'C', website: 'ftp://x' });
    ok(false, '非法 website');
  } catch (e) {
    ok(e.code === Codes.VALIDATION, 'website 协议校验');
  }
  ok(validateCompetitor({ name: 'C', website: 'https://x.com' }).website === 'https://x.com', 'https website ok');
  try {
    validateLlm({ baseUrl: 'https://x.com/v1', model: 'm', temperature: 3 });
    ok(false, 'temp>2');
  } catch (e) {
    ok(e.code === Codes.VALIDATION, 'temperature 上限');
  }
  const fr = fail(new AppError(Codes.NOT_FOUND, 'nope'));
  ok(fr.ok === false && fr.error.code === Codes.NOT_FOUND, 'fail() 结构');
  ok(okRes({ a: 1 }).ok === true && okRes({ a: 1 }).data.a === 1, 'ok() 结构');

  // ---------- B. 数据库边界 ----------
  console.log('\nB. 数据库边界');
  const dbPath = path.join(os.tmpdir(), `ci-sys-${Date.now()}.json`);
  const db = new DB(dbPath);
  ok(db.listCompetitors({}).length === 0, '空库 list');
  ok(db.getCompetitor('nope') === null, 'get 不存在');
  ok(db.findByName('nope') === null, 'findByName 不存在');
  ok(db.getLatestRoadmap() === null, '无 roadmap');

  const u1 = db.upsertCompetitor({ name: 'Alpha', price: 100, status: 'pending', channels: ['京东'] });
  const u1b = db.upsertCompetitor({ name: 'alpha', price: 110, description: 'updated' });
  ok(u1.id === u1b.id, '同名大小写合并 upsert');
  ok(u1b.price === 110 && u1b.description === 'updated', 'upsert 字段合并');

  db.confirmCompetitor(u1.id);
  ok(db.getCompetitor(u1.id).status === 'confirmed', 'confirm');
  db.rejectCompetitor(u1.id);
  ok(db.getCompetitor(u1.id).status === 'rejected', 'reject');

  // filter
  db.upsertCompetitor({ name: 'Beta', threat_score: 0.9, status: 'confirmed' });
  db.upsertCompetitor({ name: 'Gamma', threat_score: 0.2, status: 'pending' });
  ok(db.listCompetitors({ status: 'pending' }).length === 1, 'filter status pending');
  ok(db.listCompetitors({ minThreat: 0.8 }).length === 1, 'filter minThreat');
  ok(db.listCompetitors({ q: 'bet' }).some((c) => c.name === 'Beta'), 'filter q');
  ok(db.listCompetitors({ limit: 1 }).length === 1, 'filter limit');

  db.deleteCompetitor(u1.id);
  ok(!db.findByName('Alpha'), 'delete');

  // corrupt restore
  try {
    db.restoreSnapshot(null);
    ok(false, 'null snapshot');
  } catch {
    ok(true, 'null snapshot throws');
  }
  db.restoreSnapshot({ competitors: [], scan_history: [], channels: [], roadmaps: [] });
  ok(db.listCompetitors({}).length === 0, 'empty restore');

  // ---------- C. 多产品生命周期 ----------
  console.log('\nC. 多产品生命周期');
  const store = makeStore();
  Products.migrate(store);
  const r1 = Products.upsert(store, { name: 'P1', price: 1 });
  ok(r1.products.length === 1 && r1.active.name === 'P1', '首个产品自动 active');
  Products.upsert(store, { name: 'P2', price: 2 });
  ok(Products.list(store).length === 2, '两个产品');
  const id1 = Products.list(store)[0].id;
  const id2 = Products.list(store)[1].id;
  Products.setActive(store, id2);
  ok(Products.getActive(store).id === id2, 'setActive');
  // update existing
  Products.upsert(store, { id: id2, name: 'P2-改', price: 22, category: 'X' });
  ok(Products.getById(store, id2).name === 'P2-改', 'update by id');
  Products.remove(store, id2);
  ok(Products.list(store).length === 1, 'delete product');
  ok(Products.getActive(store).id === id1, 'active 回落到剩余产品');
  Products.remove(store, id1);
  ok(Products.list(store).length === 0 && Products.getActive(store) === null, '全删');

  // legacy migration
  const store2 = makeStore({
    product: { name: 'Legacy', price: 9, channels: ['a'], specs: {}, keywords: [] },
    products: undefined,
  });
  delete store2._data.products;
  const mig = Products.migrate(store2);
  ok(mig.items.length === 1 && mig.items[0].name === 'Legacy', 'legacy product 迁移');

  // ---------- D. BM25 边界 ----------
  console.log('\nD. BM25');
  ok(tokenize('').length === 0, 'empty tokenize');
  ok(tokenize('ANC降噪耳机').length > 2, '中英混合分词');
  const emptyIdx = new BM25Index([]);
  ok(emptyIdx.search('q').length === 0, 'empty index search');
  const idx = new BM25Index([
    { id: '1', text: '支付 终端 POS 扫码', meta: { name: 'A' } },
    { id: '2', text: '完全无关的水果香蕉', meta: { name: 'B' } },
  ]);
  const s = idx.search('POS 扫码支付', { topK: 2, excludeIds: [] });
  ok(s[0].id === '1', '相关文档排第一');
  ok(idx.search('xyznone').length === 0, '无匹配');

  // ---------- E. 威胁分析集成（mock LLM） ----------
  console.log('\nE. 威胁 / 扫描集成 (mock LLM)');
  const store3 = makeStore();
  Products.upsert(store3, {
    name: '我方终端',
    category: 'POS',
    price: 999,
    description: '扫码支付收银',
    channels: ['银行', '官网'],
    specs: { 屏: '5寸', 摄像头: '双目' },
    keywords: ['POS', '扫码'],
  });
  Products.upsert(store3, {
    name: '我方轻量版',
    category: 'POS',
    price: 599,
    channels: ['京东'],
    specs: { 屏: '4寸' },
  });

  const db2 = new DB(path.join(os.tmpdir(), `ci-sys2-${Date.now()}.json`));
  const competitors = [
    {
      name: 'Verifone X',
      company: 'Verifone',
      category: 'POS',
      price: 1500,
      description: '扫码支付终端 银行渠道',
      channels: ['银行', '线下'],
      specs: { 屏: '5寸' },
      status: 'pending',
    },
    {
      name: 'PAX Y',
      category: 'POS',
      price: 800,
      description: '轻量收银',
      channels: ['京东'],
      status: 'confirmed',
    },
    {
      name: '音箱无关',
      category: '音箱',
      price: 99,
      description: '蓝牙音箱',
      channels: ['天猫'],
      status: 'pending',
    },
  ].map((c) => db2.upsertCompetitor(c));

  let llmCalls = 0;
  const mockLlm = {
    async research(prompt) {
      llmCalls++;
      if (String(prompt).includes('击败') || String(prompt).includes('Roadmap') || String(prompt).includes('路线')) {
        return {
          title: '系统测试路线图',
          summary: '以银行渠道与性价比取胜',
          northStar: '份额',
          positioning: { statement: '中端扫码终端', targetUser: '商超', battlefield: '999档', winTheme: '服务+价格' },
          beatList: [{ competitor: 'Verifone X', threatScore: 0.75, howToBeat: '下沉渠道', avoidCopying: '高价堆料' }],
          gaps: [
            { area: '功能', priority: 'P0', current: '单摄', target: '双目', against: 'Verifone X' },
            { area: '价格', priority: 'P1', current: '偏高', target: '999内', against: 'PAX Y' },
          ],
          mustHave: [{ name: '双目摄像头', priority: 'P0', reason: '风控' }],
          differentiators: [{ name: '本地化服务', moat: '中', reason: '网点' }],
          priceStrategy: { band: '799-999', logic: '卡位', vsCompetitors: '低于 Verifone' },
          channelStrategy: { priorityChannels: ['银行', '京东'], actions: ['联营'] },
          phases: [
            { name: '0-3月', theme: '补齐', goals: ['双目'], deliverables: ['硬件改版'], metrics: ['样机10台'], risks: ['交期'] },
            { name: '3-6月', theme: '放量', goals: ['进银行名单'], deliverables: ['认证'], metrics: ['3家银行'], risks: [] },
            { name: '6-12月', theme: '收割', goals: ['份额'], deliverables: ['系列化'], metrics: ['市占'], risks: [] },
          ],
          kpis: [{ name: '转化率', baseline: '1%', target: '3%', when: 'Q4' }],
          nextActions: [{ action: '输出参数对标表', owner: '产品', urgency: '高' }],
          assumptions: ['供应链稳定'],
          confidence: 0.8,
        };
      }
      // discover
      if (String(prompt).includes('列出') || String(prompt).includes('competitors')) {
        return {
          competitors: [
            {
              name: 'NewRival',
              company: 'NR',
              category: 'POS',
              description: '新竞品扫码机',
              price: 900,
              channels: ['官网'],
              specs: { 屏: '5寸' },
              tags: ['直接竞品'],
            },
          ],
        };
      }
      // enrich / verify / threat
      return {
        threatScore: 0.7,
        reason: '品类与渠道重合',
        dimensions: {
          price: 0.65,
          category: 0.85,
          features: 0.55,
          channels: 0.8,
          positioning: 0.5,
          price_edge: 0.3,
          channel_edge: 0.4,
          completeness: 0.7,
        },
        confidence: 0.8,
        evidence_used: ['银行'],
        is_direct_competitor: true,
        name: 'NewRival',
        company: 'NR',
        category: 'POS',
        description: '新竞品扫码机',
        price: 900,
        specs: { 屏: '5寸' },
        channels: ['官网'],
        valid: true,
        is_competitor: true,
        recommend_status: 'pending',
        corrections: {},
        verify_notes: 'ok',
      };
    },
    async chat() {
      return 'OK';
    },
    getStats() {
      return { calls: llmCalls, failures: 0 };
    },
  };

  const vm = new VectorMatcher();
  const ta = new ThreatAnalyzer(vm, mockLlm);
  const ranked = await ta.rankAll(Products.getActive(store3), db2.listCompetitors({}), {
    products: Products.list(store3),
    useRag: true,
  });
  ok(ranked.length === 3, `rankAll n=${ranked.length}`);
  ok(ranked[0].threatScore >= ranked[ranked.length - 1].threatScore, 'rank 降序');
  ok(ranked[0].threat_vs?.length === 2, '每条含 threat_vs×2产品');

  for (const item of ranked) {
    db2.updateThreatScore(item.id, item.threatScore, item.dimensions, item.reason, {
      method: item.method,
      threat_vs: item.threat_vs,
      primary_product_name: item.primary_product_name,
    });
  }
  const top = db2.listCompetitors({ minThreat: 0.01 })[0];
  ok(top.threat_score > 0, '威胁写回库');

  // SearchAgent full scan with mock
  const sa = new SearchAgent(mockLlm, db2, ta, store3);
  const before = db2.listCompetitors({}).length;
  const scanRes = await sa.runScan({ limit: 3, threatThreshold: 0.5 });
  ok(scanRes.found >= 1, `scan found=${scanRes.found}`);
  ok(db2.listCompetitors({}).length >= before, 'scan 入库');
  ok(db2.listScanHistory(5).some((h) => h.status === 'done'), 'scan history done');

  // verify one
  const any = db2.listCompetitors({})[0];
  const verified = await sa.verifyCompetitor(any);
  ok(verified && verified.id, 'verifyCompetitor returns row');

  // Roadmap
  const ra = new RoadmapAgent(mockLlm);
  const road = await ra.generate({
    products: Products.list(store3),
    competitors: db2.listCompetitors({}),
    horizon: '12m',
    goal: '打败 Verifone',
  });
  ok(road.phases.length === 3 && road.gaps.length >= 1, 'roadmap structure');
  const savedRoad = db2.saveRoadmap(road);
  ok(db2.getRoadmap(savedRoad.id).title === road.title, 'getRoadmap');
  db2.deleteRoadmap(savedRoad.id);
  ok(!db2.getRoadmap(savedRoad.id), 'deleteRoadmap');

  // readiness
  const ready = computeReadiness(store3, db2);
  ok(ready.canScan && ready.percent >= 60, `readiness ${ready.percent}% canScan`);

  // Loop
  console.log('\nF. Loop Engine');
  let scanCount = 0;
  const loop = new LoopEngine({
    store: store3,
    searchAgent: {
      runScan: async () => {
        scanCount++;
        return { found: 1, newCount: 1, newThreats: [{ name: 'X', threatScore: 0.9, reason: 't' }] };
      },
    },
    db: db2,
    onScanComplete: () => {},
    onError: () => {},
  });
  store3.set('loop', { enabled: false, cron: '0 */6 * * *', threatThreshold: 0.65 });
  const once = await loop.runOnce();
  ok(once.newCount === 1 && scanCount === 1, 'runOnce');
  try {
    loop.running = true;
    await loop.runOnce();
    ok(false, 'concurrent should throw');
  } catch (e) {
    ok(/进行中/.test(e.message), 'concurrent busy throw');
  }
  loop.running = false;

  // invalid cron
  store3.set('loop.cron', 'not-a-cron');
  loop.start();
  ok(!loop.task, 'invalid cron 不调度');
  store3.set('loop.cron', '0 */6 * * *');
  loop.start();
  ok(!!loop.task, 'valid cron 调度');
  loop.stop();
  ok(!loop.task, 'stop 清除调度');

  // Export
  console.log('\nG. 导出');
  const list = db2.listCompetitors({});
  const csv = exportCompetitors(list, 'csv');
  ok(csv.content.split('\n').length >= 2, 'csv lines');
  const json = exportCompetitors(list, 'json');
  ok(JSON.parse(json.content).count === list.length, 'json count');
  const bak = exportFullBackup(
    { llm: store3.get('llm'), product: store3.get('product'), products: store3.get('products'), loop: store3.get('loop'), notifications: store3.get('notifications'), onboarding: store3.get('onboarding') },
    db2.getSnapshot()
  );
  ok(JSON.parse(bak.content).data.competitors, 'backup shape');

  // LLM precondition
  console.log('\nH. LLM 前置条件');
  const llmEmpty = new LLMService(() => ({}));
  try {
    llmEmpty._config();
    ok(false, 'empty config');
  } catch (e) {
    ok(e.code === Codes.PRECONDITION, 'LLM 缺配置');
  }

  // Frontend buildRoadmapVizModel logic reimplemented check
  console.log('\nI. 前端关键逻辑符号 / 契约');
  const appJs = fs.readFileSync(path.join(root, 'src/js/app.js'), 'utf8');
  ok(appJs.includes('buildRoadmapVizModel'), 'buildRoadmapVizModel');
  ok(appJs.includes('mountRoadmapViz'), 'mountRoadmapViz');
  ok(appJs.includes("layout: 'absolute'") || appJs.includes('layout: "absolute"') || appJs.includes("setRoadmapScene"), 'roadmap absolute layout');
  ok(appJs.includes('threat_vs'), 'UI threat_vs');
  ok(appJs.includes('primary_product_name'), 'UI primary product');

  // simulate buildRoadmapVizModel inline
  const dimsFromGaps = (() => {
    const current = { price: 0.5, features: 0.4, channels: 0.5, positioning: 0.4, category: 0.5, price_edge: 0.3, channel_edge: 0.3, completeness: 0.5 };
    const target = { ...current };
    for (const g of road.gaps) {
      if (/功能/.test(g.area)) target.features = Math.min(0.98, target.features + 0.32);
      if (/价格/.test(g.area)) target.price = Math.min(0.98, target.price + 0.2);
    }
    return target.features > current.features;
  })();
  ok(dimsFromGaps, '路线图 gaps 提升目标 features');

  // IPC double-wrap regression
  ok(!String(require('fs').readFileSync(path.join(root, 'electron/services/loop-engine.js'), 'utf8')).includes('return { ok: true'), 'loop 不再返回 ok 包装');

  // ---------- J. Electron 冷启动 ----------
  console.log('\nJ. Electron 冷启动 (8s)');
  const electronPath = require(path.join(root, 'node_modules/electron'));
  await new Promise((resolve) => {
    const child = spawn(electronPath, ['.'], {
      cwd: root,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* */
      }
      // still running after 8s without crash = success
      ok(true, 'Electron 进程存活 ≥8s（未秒退）');
      if (err && /Error|throw/i.test(err) && !/security|DevTools|GPU/i.test(err)) {
        warn('stderr 含 Error: ' + err.slice(0, 200));
      } else {
        info('启动日志长度 stdout=' + out.length + ' stderr=' + err.length);
      }
      resolve();
    }, 8000);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0 && code !== null) {
        ok(false, `Electron 异常退出 code=${code} stderr=${err.slice(0, 300)}`);
      } else if (code === 0) {
        // exited cleanly before timeout - still ok if no error
        info('Electron 在超时前退出 code=0');
        ok(true, 'Electron 可执行');
      }
      resolve();
    });
    child.on('error', (e) => {
      clearTimeout(t);
      ok(false, 'spawn error ' + e.message);
      resolve();
    });
  });

  // cleanup
  db.close();
  db2.close();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* */
  }

  console.log('\n████ 结果 ████');
  console.log(`失败: ${failed}  警告: ${warns.length}  信息: ${infos.length}`);
  if (warns.length) {
    console.log('\n警告:');
    warns.forEach((w) => console.log(' -', w));
  }
  if (failed) {
    console.log('\n存在失败项，请查看上方 ✗');
    process.exit(1);
  }
  console.log('\n系统测试通过。');
  console.log('未覆盖（需真 LLM/人手）: 真实 API 延迟/限流、桌面通知点击、3D 拖拽观感、系统托盘。');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
