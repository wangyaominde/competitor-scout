const { AppError, Codes } = require('./errors');

function requireString(value, field, { min = 1, max = 200 } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (s.length < min) throw new AppError(Codes.VALIDATION, `${field} 不能为空`);
  if (s.length > max) throw new AppError(Codes.VALIDATION, `${field} 过长（最多 ${max} 字）`);
  return s;
}

function optionalString(value, field, { max = 2000 } = {}) {
  if (value == null || value === '') return '';
  const s = String(value).trim();
  if (s.length > max) throw new AppError(Codes.VALIDATION, `${field} 过长`);
  return s;
}

function optionalNumber(value, field) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new AppError(Codes.VALIDATION, `${field} 必须是数字`);
  if (n < 0) throw new AppError(Codes.VALIDATION, `${field} 不能为负`);
  return n;
}

function optionalObject(value, field) {
  if (value == null || value === '') return {};
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new AppError(Codes.VALIDATION, `${field} 不是合法 JSON`);
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(Codes.VALIDATION, `${field} 必须是对象`);
  }
  return value;
}

function stringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((x) => (typeof x === 'string' ? x : x?.name || String(x))).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function validateProduct(input) {
  return {
    name: requireString(input.name, '产品名称', { max: 120 }),
    category: optionalString(input.category, '品类', { max: 80 }),
    description: optionalString(input.description, '描述', { max: 4000 }),
    price: optionalNumber(input.price, '价格'),
    specs: optionalObject(input.specs, '规格'),
    channels: stringList(input.channels),
    keywords: stringList(input.keywords),
  };
}

function validateCompetitor(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name != null) {
    out.name = requireString(input.name, '竞品名称', { max: 120 });
  }
  if (input.company != null) out.company = optionalString(input.company, '公司', { max: 120 });
  if (input.category != null) out.category = optionalString(input.category, '品类', { max: 80 });
  if (input.description != null) out.description = optionalString(input.description, '描述', { max: 4000 });
  if (input.price !== undefined) out.price = optionalNumber(input.price, '价格');
  if (input.price_range != null) out.price_range = optionalString(input.price_range, '价格区间', { max: 80 });
  if (input.price_unit != null) out.price_unit = optionalString(input.price_unit, '货币', { max: 8 }) || 'CNY';
  if (input.specs !== undefined) out.specs = optionalObject(input.specs, '规格');
  if (input.channels !== undefined) out.channels = stringList(input.channels);
  if (input.website != null) {
    const w = optionalString(input.website, '官网', { max: 500 });
    if (w && !/^https?:\/\//i.test(w)) {
      throw new AppError(Codes.VALIDATION, '官网需以 http(s):// 开头');
    }
    out.website = w;
  }
  if (input.tags !== undefined) out.tags = stringList(input.tags);
  if (input.notes != null) out.notes = optionalString(input.notes, '备注', { max: 4000 });
  if (input.status != null) {
    if (!['pending', 'confirmed', 'rejected'].includes(input.status)) {
      throw new AppError(Codes.VALIDATION, '无效状态');
    }
    out.status = input.status;
  }
  if (input.id) out.id = String(input.id);
  return out;
}

function validateLlm(input) {
  const baseUrl = requireString(input.baseUrl, 'Base URL', { max: 300 });
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new AppError(Codes.VALIDATION, 'Base URL 需以 http(s):// 开头');
  }
  return {
    provider: optionalString(input.provider, 'Provider', { max: 40 }) || 'custom',
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey: input.apiKey == null ? '' : String(input.apiKey),
    model: requireString(input.model, 'Model', { max: 80 }),
    temperature: (() => {
      if (input.temperature == null || input.temperature === '') return 0.3;
      const t = Number(input.temperature);
      if (!Number.isFinite(t) || t < 0 || t > 2) {
        throw new AppError(Codes.VALIDATION, 'Temperature 需在 0–2 之间');
      }
      return t;
    })(),
    timeoutMs: (() => {
      if (input.timeoutMs == null || input.timeoutMs === '') return 120000;
      const t = Number(input.timeoutMs);
      if (!Number.isFinite(t) || t < 15000 || t > 600000) {
        throw new AppError(Codes.VALIDATION, '请求超时需在 15–600 秒之间');
      }
      return Math.round(t);
    })(),
  };
}

module.exports = {
  validateProduct,
  validateCompetitor,
  validateLlm,
  stringList,
  optionalObject,
};
