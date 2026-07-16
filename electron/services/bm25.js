/**
 * BM25 检索（纯 JS，无原生依赖）
 * 用于竞品语料粗排与 RAG 证据召回
 */
class BM25Index {
  /**
   * @param {Array<{ id: string, text: string, meta?: object }>} docs
   * @param {{ k1?: number, b?: number }} options
   */
  constructor(docs = [], options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.docs = [];
    this.avgdl = 0;
    this.df = new Map(); // term -> doc frequency
    this.N = 0;
    this.rebuild(docs);
  }

  rebuild(docs) {
    this.docs = (docs || []).map((d) => {
      const tokens = tokenize(d.text || '');
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      return {
        id: d.id,
        text: d.text || '',
        meta: d.meta || {},
        tokens,
        tf,
        len: tokens.length,
      };
    });

    this.N = this.docs.length;
    this.df = new Map();
    let totalLen = 0;
    for (const doc of this.docs) {
      totalLen += doc.len;
      const seen = new Set(doc.tf.keys());
      for (const t of seen) {
        this.df.set(t, (this.df.get(t) || 0) + 1);
      }
    }
    this.avgdl = this.N > 0 ? totalLen / this.N : 0;
  }

  idf(term) {
    const n = this.df.get(term) || 0;
    // Robertson-Spärck Jones IDF with smoothing
    return Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
  }

  score(query, doc) {
    const qTokens = tokenize(query);
    if (!qTokens.length || !doc.len) return 0;
    let s = 0;
    const qtf = new Map();
    for (const t of qTokens) qtf.set(t, (qtf.get(t) || 0) + 1);

    for (const [term, qCount] of qtf) {
      const f = doc.tf.get(term) || 0;
      if (!f) continue;
      const idf = this.idf(term);
      const denom = f + this.k1 * (1 - this.b + this.b * (doc.len / (this.avgdl || 1)));
      s += idf * ((f * (this.k1 + 1)) / denom) * (1 + Math.log(1 + qCount));
    }
    return s;
  }

  /**
   * @param {string} query
   * @param {{ topK?: number, excludeIds?: string[] }} options
   */
  search(query, options = {}) {
    const topK = options.topK ?? 5;
    const exclude = new Set(options.excludeIds || []);
    const scored = [];

    for (const doc of this.docs) {
      if (exclude.has(doc.id)) continue;
      const bm25 = this.score(query, doc);
      if (bm25 <= 0) continue;
      scored.push({
        id: doc.id,
        score: bm25,
        text: doc.text,
        meta: doc.meta,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const max = scored[0]?.score || 1;
    return scored.slice(0, topK).map((r) => ({
      ...r,
      // 归一化 0-1 便于展示
      scoreNorm: max > 0 ? Math.round((r.score / max) * 1000) / 1000 : 0,
    }));
  }
}

/**
 * 中英混合分词：英文词 + 数字 + 中文 bigram + 单字（低频兜底用 bigram 为主）
 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];

  const latin = s.match(/[a-z0-9][a-z0-9+.\-/]{0,40}/g) || [];
  for (const w of latin) {
    if (w.length >= 1) tokens.push(w);
  }

  const cjk = s.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.push(cjk.slice(i, i + 2));
  }
  // 短中文补单字，避免 1 字关键信息丢失
  if (cjk.length === 1) tokens.push(cjk);
  if (cjk.length >= 2 && cjk.length <= 4) {
    for (const ch of cjk) tokens.push(ch);
  }

  return tokens;
}

/**
 * 把竞品/产品压成检索文档
 */
function competitorToDoc(c) {
  const specs =
    c.specs && typeof c.specs === 'object'
      ? Object.entries(c.specs)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')
      : '';
  const channels = Array.isArray(c.channels)
    ? c.channels.map((ch) => (typeof ch === 'string' ? ch : ch?.name || '')).join(' ')
    : '';
  const text = [
    c.name,
    c.company,
    c.category,
    c.description,
    c.price != null ? `价格${c.price}` : '',
    c.price_range || '',
    specs,
    channels,
    c.notes,
    ...(c.tags || []),
  ]
    .filter(Boolean)
    .join(' ');

  return {
    id: c.id || c.name,
    text,
    meta: {
      name: c.name,
      company: c.company,
      category: c.category,
      price: c.price,
      price_range: c.price_range,
      status: c.status,
    },
  };
}

function productToQuery(product) {
  const specs =
    product.specs && typeof product.specs === 'object'
      ? Object.entries(product.specs)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')
      : '';
  return [
    product.name,
    product.category,
    product.description,
    product.price != null ? `价格${product.price}` : '',
    specs,
    ...(product.channels || []).map((ch) => (typeof ch === 'string' ? ch : ch?.name || '')),
    ...(product.keywords || []),
  ]
    .filter(Boolean)
    .join(' ');
}

function buildCompetitorIndex(competitors) {
  return new BM25Index((competitors || []).map(competitorToDoc));
}

module.exports = {
  BM25Index,
  tokenize,
  competitorToDoc,
  productToQuery,
  buildCompetitorIndex,
};
