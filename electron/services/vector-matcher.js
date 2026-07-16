/**
 * 多维向量匹配器
 * 将「己方产品 vs 竞品」映射为固定维度特征向量，计算威胁相似度。
 *
 * 维度设计（0–1 归一化后的特征，以及差异类特征）：
 *  0  price_ratio      价格接近度（越接近越高威胁）
 *  1  category_overlap 品类重合
 *  2  feature_overlap  规格/功能重合
 *  3  channel_overlap  渠道重合
 *  4  positioning      定位相似度（描述语义代理）
 *  5  price_undercut   对方更低价威胁
 *  6  channel_breadth  对方渠道更广
 *  7  completeness     信息完整度（有价格/规格/渠道）
 */

const DIMENSIONS = [
  { key: 'price', label: '价格竞争力', weight: 0.2 },
  { key: 'category', label: '品类重合', weight: 0.15 },
  { key: 'features', label: '规格/功能', weight: 0.2 },
  { key: 'channels', label: '渠道重合', weight: 0.15 },
  { key: 'positioning', label: '定位相似', weight: 0.15 },
  { key: 'price_edge', label: '价格压制', weight: 0.08 },
  { key: 'channel_edge', label: '渠道广度', weight: 0.04 },
  { key: 'completeness', label: '情报完整度', weight: 0.03 },
];

class VectorMatcher {
  getDimensionMeta() {
    return DIMENSIONS.map((d) => ({ key: d.key, label: d.label, weight: d.weight }));
  }

  /**
   * 构建己方产品基准向量（用于展示与对比）
   */
  buildProductVector(product) {
    return {
      price: this._num(product?.price),
      category: (product?.category || '').toLowerCase(),
      description: (product?.description || '').toLowerCase(),
      specs: product?.specs || {},
      channels: this._normalizeChannels(product?.channels),
      keywords: (product?.keywords || []).map((k) => String(k).toLowerCase()),
      name: (product?.name || '').toLowerCase(),
    };
  }

  /**
   * 计算多维威胁分数
   * @returns {{ threatScore: number, dimensions: object, vector: number[], reason: string }}
   */
  score(product, competitor) {
    const p = this.buildProductVector(product);
    const dims = {};

    dims.price = this._priceSimilarity(p.price, competitor.price);
    dims.category = this._categoryOverlap(p.category, competitor.category, p.keywords, competitor);
    dims.features = this._featureOverlap(p.specs, competitor.specs || {}, p.description, competitor.description || '');
    dims.channels = this._channelOverlap(p.channels, competitor.channels || []);
    dims.positioning = this._textSimilarity(
      [p.name, p.category, p.description, ...(p.keywords || [])].join(' '),
      [competitor.name, competitor.company, competitor.category, competitor.description].filter(Boolean).join(' ')
    );
    dims.price_edge = this._priceEdge(p.price, competitor.price);
    dims.channel_edge = this._channelEdge(p.channels, competitor.channels || []);
    dims.completeness = this._completeness(competitor);

    const vector = DIMENSIONS.map((d) => dims[d.key] ?? 0);
    let threatScore = 0;
    let weightSum = 0;
    for (const d of DIMENSIONS) {
      threatScore += (dims[d.key] || 0) * d.weight;
      weightSum += d.weight;
    }
    threatScore = weightSum > 0 ? threatScore / weightSum : 0;
    threatScore = Math.min(1, Math.max(0, threatScore));

    // 余弦相似度作为辅助增强（与等权基向量）
    const base = DIMENSIONS.map(() => 0.7);
    const cos = this.cosine(vector, base);
    threatScore = Math.min(1, threatScore * 0.85 + cos * 0.15);

    const reason = this._buildReason(dims, competitor);

    return {
      threatScore: Math.round(threatScore * 1000) / 1000,
      dimensions: dims,
      vector,
      reason,
    };
  }

  cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  _num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  _normalizeChannels(channels) {
    if (!Array.isArray(channels)) return [];
    return channels
      .map((c) => (typeof c === 'string' ? c : c?.name || ''))
      .filter(Boolean)
      .map((s) => s.toLowerCase().trim());
  }

  _priceSimilarity(pPrice, cPrice) {
    const a = this._num(pPrice);
    const b = this._num(cPrice);
    if (a == null || b == null) return 0.35; // 未知时给中性偏弱
    const ratio = Math.min(a, b) / Math.max(a, b);
    // 价格越接近，威胁越高
    return Math.pow(ratio, 0.8);
  }

  _priceEdge(pPrice, cPrice) {
    const a = this._num(pPrice);
    const b = this._num(cPrice);
    if (a == null || b == null) return 0.2;
    if (b >= a) return 0.1;
    const discount = (a - b) / a;
    return Math.min(1, discount * 1.5);
  }

  _categoryOverlap(pCat, cCat, keywords, competitor) {
    let score = 0;
    const cCatL = (cCat || '').toLowerCase();
    if (pCat && cCatL && (pCat.includes(cCatL) || cCatL.includes(pCat))) score += 0.7;
    const blob = `${competitor.name || ''} ${competitor.description || ''} ${cCatL}`.toLowerCase();
    const hits = (keywords || []).filter((k) => k && blob.includes(k));
    if (keywords?.length) score += 0.3 * (hits.length / keywords.length);
    else if (pCat && blob.includes(pCat)) score += 0.3;
    return Math.min(1, score);
  }

  _featureOverlap(pSpecs, cSpecs, pDesc, cDesc) {
    const pKeys = Object.keys(pSpecs || {});
    const cKeys = Object.keys(cSpecs || {});
    let score = 0;

    if (pKeys.length && cKeys.length) {
      const pSet = new Set(pKeys.map((k) => k.toLowerCase()));
      const cSet = new Set(cKeys.map((k) => k.toLowerCase()));
      let inter = 0;
      for (const k of pSet) if (cSet.has(k)) inter++;
      const union = new Set([...pSet, ...cSet]).size;
      score = union ? inter / union : 0;

      // value closeness for shared numeric keys
      let valHits = 0;
      let valTotal = 0;
      for (const k of pKeys) {
        const ck = cKeys.find((x) => x.toLowerCase() === k.toLowerCase());
        if (!ck) continue;
        valTotal++;
        const pv = pSpecs[k];
        const cv = cSpecs[ck];
        if (String(pv).toLowerCase() === String(cv).toLowerCase()) valHits += 1;
        else if (!isNaN(Number(pv)) && !isNaN(Number(cv))) {
          const a = Math.abs(Number(pv));
          const b = Math.abs(Number(cv));
          if (a + b > 0) valHits += Math.min(a, b) / Math.max(a, b);
        }
      }
      if (valTotal) score = score * 0.6 + (valHits / valTotal) * 0.4;
    } else {
      // fallback: description token overlap
      score = this._textSimilarity(pDesc, cDesc) * 0.7;
    }
    return Math.min(1, score);
  }

  _channelOverlap(pCh, cCh) {
    const a = this._normalizeChannels(pCh);
    const b = this._normalizeChannels(cCh);
    if (!a.length || !b.length) return b.length ? 0.25 : 0.15;
    let inter = 0;
    for (const x of a) {
      if (b.some((y) => y.includes(x) || x.includes(y))) inter++;
    }
    return Math.min(1, inter / Math.max(a.length, 1));
  }

  _channelEdge(pCh, cCh) {
    const a = this._normalizeChannels(pCh).length;
    const b = this._normalizeChannels(cCh).length;
    if (b === 0) return 0.1;
    if (b <= a) return 0.2;
    return Math.min(1, 0.3 + (b - a) * 0.15);
  }

  _completeness(c) {
    let s = 0;
    if (c.price != null || c.price_range) s += 0.3;
    if (c.specs && Object.keys(c.specs).length) s += 0.3;
    if (c.channels && c.channels.length) s += 0.25;
    if (c.website) s += 0.15;
    return s;
  }

  _textSimilarity(a, b) {
    const ta = this._tokens(a);
    const tb = this._tokens(b);
    if (!ta.size || !tb.size) return 0.1;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = ta.size + tb.size - inter;
    return union ? inter / union : 0;
  }

  _tokens(text) {
    const set = new Set();
    const s = (text || '').toLowerCase();
    // CJK bigrams + latin words
    const latin = s.match(/[a-z0-9]{2,}/g) || [];
    latin.forEach((w) => set.add(w));
    const cjk = s.replace(/[^\u4e00-\u9fff]/g, '');
    for (let i = 0; i < cjk.length - 1; i++) {
      set.add(cjk.slice(i, i + 2));
    }
    return set;
  }

  _buildReason(dims, competitor) {
    const ranked = Object.entries(dims)
      .map(([k, v]) => ({ k, v, label: DIMENSIONS.find((d) => d.key === k)?.label || k }))
      .sort((a, b) => b.v - a.v);

    const top = ranked.slice(0, 3).filter((x) => x.v >= 0.4);
    if (!top.length) {
      return `${competitor.name} 与本品重合度有限，暂为观察级竞品。`;
    }
    const parts = top.map((t) => `${t.label}${(t.v * 100).toFixed(0)}%`);
    return `主要威胁来自：${parts.join('、')}。`;
  }
}

module.exports = VectorMatcher;
