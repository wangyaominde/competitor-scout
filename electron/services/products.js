const { v4: uuidv4 } = require('uuid');
const { validateProduct } = require('./validate');
const { AppError, Codes } = require('./errors');

/**
 * 多产品组合管理
 * store.products = { items: Product[], activeId: string|null }
 * 兼容旧版单一 store.product
 */
function migrate(store) {
  let ps = store.get('products');
  if (ps && Array.isArray(ps.items)) {
    return ps;
  }

  const legacy = store.get('product') || {};
  const items = [];
  let activeId = null;
  if (legacy.name) {
    activeId = uuidv4();
    items.push({
      id: activeId,
      ...legacy,
      specs: legacy.specs || {},
      channels: legacy.channels || [],
      keywords: legacy.keywords || [],
    });
  }
  ps = { items, activeId };
  store.set('products', ps);
  return ps;
}

function getState(store) {
  return migrate(store);
}

function list(store) {
  return getState(store).items.map((p) => ({ ...p }));
}

function getActive(store) {
  const ps = getState(store);
  if (!ps.items.length) return null;
  const active =
    ps.items.find((p) => p.id === ps.activeId) || ps.items[0] || null;
  // 同步 legacy product 字段（不触发 migrate 循环）
  if (active) {
    try {
      store.set('product', stripId(active));
    } catch { /* ignore */ }
  }
  return active ? { ...active } : null;
}

function getById(store, id) {
  return getState(store).items.find((p) => p.id === id) || null;
}

function stripId(p) {
  if (!p) return null;
  const { id, ...rest } = p;
  return rest;
}

function upsert(store, input) {
  const cleaned = validateProduct(input);
  const ps = getState(store);
  const now = new Date().toISOString();

  if (input.id) {
    const idx = ps.items.findIndex((p) => p.id === input.id);
    if (idx < 0) throw new AppError(Codes.NOT_FOUND, '产品不存在');
    ps.items[idx] = {
      ...ps.items[idx],
      ...cleaned,
      id: input.id,
      updated_at: now,
    };
  } else {
    const id = uuidv4();
    ps.items.push({
      id,
      ...cleaned,
      created_at: now,
      updated_at: now,
    });
    if (!ps.activeId) ps.activeId = id;
  }

  store.set('products', ps);
  const active = getActive(store);
  if (active) store.set('product', stripId(active));
  return {
    products: list(store),
    active: active ? { ...active } : null,
    product: active ? stripId(active) : null,
  };
}

function remove(store, id) {
  const ps = getState(store);
  const before = ps.items.length;
  ps.items = ps.items.filter((p) => p.id !== id);
  if (ps.items.length === before) throw new AppError(Codes.NOT_FOUND, '产品不存在');
  if (ps.activeId === id) {
    ps.activeId = ps.items[0]?.id || null;
  }
  store.set('products', ps);
  const active = getActive(store);
  store.set('product', active ? stripId(active) : {
    name: '',
    category: '',
    description: '',
    price: null,
    specs: {},
    channels: [],
    keywords: [],
  });
  return {
    products: list(store),
    active: active ? { ...active } : null,
  };
}

function setActive(store, id) {
  const ps = getState(store);
  const found = ps.items.find((p) => p.id === id);
  if (!found) throw new AppError(Codes.NOT_FOUND, '产品不存在');
  ps.activeId = id;
  store.set('products', ps);
  store.set('product', stripId(found));
  return {
    products: list(store),
    active: { ...found },
    product: stripId(found),
  };
}

/** 用于扫描：指定 id 或 active；mode=all 时返回全部 */
function resolveForScan(store, { productId, mode } = {}) {
  const all = list(store);
  if (!all.length) return { products: [], active: null };
  if (mode === 'all') return { products: all, active: getActive(store) };
  if (productId) {
    const p = all.find((x) => x.id === productId);
    if (!p) throw new AppError(Codes.NOT_FOUND, '产品不存在');
    return { products: [p], active: p };
  }
  const active = getActive(store);
  return { products: active ? [active] : all, active };
}

module.exports = {
  migrate,
  getState,
  list,
  getActive,
  getById,
  upsert,
  remove,
  setActive,
  resolveForScan,
  stripId,
};
