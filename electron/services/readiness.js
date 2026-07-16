/**
 * 产品就绪度：SaaS 级单用户应用的「能不能开工」检查清单
 */
function computeReadiness(store, db) {
  const llm = store.get('llm') || {};
  const Products = require('./products');
  const products = Products.list(store);
  const product = Products.getActive(store) || store.get('product') || {};
  const loop = store.get('loop') || {};
  const stats = db.getStats();
  const onboarding = store.get('onboarding') || {};

  const checks = [
    {
      id: 'llm',
      title: '配置大模型',
      done: Boolean(llm.baseUrl && llm.model && (llm.apiKey || /localhost|127\.0\.0\.1/i.test(llm.baseUrl || ''))),
      weight: 30,
      cta: 'settings',
      hint: '填写兼容 OpenAI 的 Base URL / API Key / Model',
    },
    {
      id: 'product',
      title: '完善产品画像',
      done: Boolean(
        products.length > 0 &&
          products.some(
            (p) => p.name && (p.category || p.description || p.price != null)
          )
      ),
      weight: 30,
      cta: 'product',
      hint: products.length > 1
        ? `已配置 ${products.length} 个产品，可继续补充`
        : '至少添加 1 个产品，并补充品类、价格或描述之一',
    },
    {
      id: 'product_rich',
      title: '规格与渠道（推荐）',
      done: products.some(
        (p) =>
          (p.channels && p.channels.length) ||
          (p.specs && Object.keys(p.specs).length) ||
          (p.keywords && p.keywords.length)
      ),
      weight: 15,
      cta: 'product',
      hint: '规格、渠道、关键词会显著提升威胁匹配精度；支持多产品组合',
    },
    {
      id: 'first_scan',
      title: '完成首次扫描',
      done: (stats.total || 0) > 0 || (stats.recentScans || 0) > 0 || Boolean(onboarding.firstScanDone),
      weight: 15,
      cta: 'scan',
      hint: '用 LLM 拉取第一批竞品候选',
    },
    {
      id: 'confirm',
      title: '确认至少 1 个竞品',
      done: (stats.confirmed || 0) > 0,
      weight: 10,
      cta: 'competitors',
      hint: '把有效竞品从待确认推进到已入库',
    },
  ];

  const score = checks.reduce((s, c) => s + (c.done ? c.weight : 0), 0);
  const next = checks.find((c) => !c.done) || null;
  const canScan = checks.find((c) => c.id === 'llm').done && checks.find((c) => c.id === 'product').done;
  /** 清单全部完成：UI 应隐藏配置清单 / 侧栏就绪度 */
  const complete = checks.length > 0 && checks.every((c) => c.done);

  return {
    score,
    maxScore: 100,
    percent: score,
    ready: score >= 60 && canScan,
    complete,
    canScan,
    checks,
    next,
    productName: product?.name || null,
    productCount: products.length,
    products: products.map((p) => ({ id: p.id, name: p.name, active: p.id === (Products.getState(store).activeId) })),
    loopEnabled: !!loop.enabled,
    stats: {
      total: stats.total,
      pending: stats.pending,
      confirmed: stats.confirmed,
      highThreat: stats.highThreat,
    },
    onboardingCompleted: Boolean(onboarding.completed),
  };
}

module.exports = { computeReadiness };
