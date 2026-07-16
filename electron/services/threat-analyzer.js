const {
  BM25Index,
  competitorToDoc,
  productToQuery,
  buildCompetitorIndex,
} = require('./bm25');

/**
 * 威胁分析器（核心：BM25 召回 + RAG 自动判定）
 *
 * 流程：
 *  1. 规则特征分（结构化基线，可解释）
 *  2. BM25 从竞品语料库召回相关证据
 *  3. RAG：证据 + 己方产品 + 目标竞品 → LLM 输出威胁分与理由
 *  4. 融合：RAG 为主（0.7），规则为辅（0.3）；LLM 不可用时回退规则
 *
 * 人工判断：不在此层；由 UI 筛选 + 确认/忽略 完成
 */
class ThreatAnalyzer {
  constructor(vectorMatcher, llm) {
    this.vector = vectorMatcher;
    this.llm = llm;
  }

  /**
   * @param {object} product
   * @param {object} competitor
   * @param {{ corpus?: object[], useRag?: boolean, topK?: number }} options
   */
  async scoreOne(product, competitor, options = {}) {
    const useRag = options.useRag !== false; // 默认开启 RAG 自动判断
    const corpus = options.corpus || [];
    const topK = options.topK ?? 5;

    const base = this.vector.score(product, competitor);
    const query = this._buildQuery(product, competitor);
    const evidence = this._retrieveEvidence(query, competitor, corpus, topK);

    if (!useRag || !product?.name) {
      return {
        ...base,
        method: 'rules',
        bm25: evidence,
        rag_evidence: evidence,
      };
    }

    try {
      const rag = await this._ragJudge(product, competitor, base, evidence);
      return rag;
    } catch (err) {
      return {
        ...base,
        method: 'rules_fallback',
        reason: `${base.reason}（RAG 不可用：${err.message}）`,
        bm25: evidence,
        rag_evidence: evidence,
        rag_error: err.message,
      };
    }
  }

  async rankAll(product, competitors, options = {}) {
    const list = competitors || [];
    const corpus = list;
    const products = options.products?.length
      ? options.products
      : product
        ? [product]
        : [];
    const results = [];

    for (const c of list) {
      const scored = await this.scoreAgainstProducts(products, c, {
        ...options,
        corpus,
        ragAll: options.ragAll === true,
        ragProductIds: options.ragProductIds,
      });
      results.push({
        id: c.id,
        name: c.name,
        ...scored,
      });
    }

    results.sort((a, b) => b.threatScore - a.threatScore);
    return results;
  }

  /**
   * 对多个己方产品分别评分，取最高威胁作为自动判定结果
   * @returns 综合分 + threat_vs 明细
   */
  async scoreAgainstProducts(products, competitor, options = {}) {
    const list = (products || []).filter((p) => p && p.name);
    if (!list.length) {
      return this.scoreOne({ name: '' }, competitor, { ...options, useRag: false });
    }
    if (list.length === 1) {
      const one = await this.scoreOne(list[0], competitor, options);
      return {
        ...one,
        threat_vs: [
          {
            productId: list[0].id || null,
            productName: list[0].name,
            score: one.threatScore,
            reason: one.reason,
          },
        ],
        primary_product_id: list[0].id || null,
        primary_product_name: list[0].name,
      };
    }

    // 多产品：默认只对 active / 指定产品做 RAG，其余用规则，避免 N 次 LLM 卡死 UI
    const ragIds = options.ragProductIds
      ? new Set(options.ragProductIds)
      : options.ragAll
        ? new Set(list.map((p) => p.id))
        : new Set([list[0].id]);

    const vs = [];
    for (const p of list) {
      const useRag = options.useRag !== false && ragIds.has(p.id);
      const scored = await this.scoreOne(p, competitor, { ...options, useRag });
      vs.push({
        productId: p.id || null,
        productName: p.name,
        score: scored.threatScore,
        reason: scored.reason,
        dimensions: scored.dimensions,
        method: scored.method,
        confidence: scored.confidence,
        rag_evidence: scored.rag_evidence || scored.bm25,
        vector: scored.vector,
        rule_score: scored.rule_score,
        rag_score: scored.rag_score,
        _full: scored,
      });
    }
    vs.sort((a, b) => b.score - a.score);
    const best = vs[0];
    const full = best._full;
    return {
      ...full,
      threatScore: best.score,
      reason: `【相对 ${best.productName}】${best.reason || full.reason || ''}`,
      threat_vs: vs.map(({ _full, ...rest }) => rest),
      primary_product_id: best.productId,
      primary_product_name: best.productName,
    };
  }

  /**
   * 仅 BM25：按与己方产品的文本相关度排序（不做 LLM）
   */
  rankByBm25(product, competitors, topK = 50) {
    const index = buildCompetitorIndex(competitors || []);
    const query = productToQuery(product);
    const hits = index.search(query, { topK });
    const byId = new Map((competitors || []).map((c) => [c.id, c]));
    return hits
      .map((h) => {
        const c = byId.get(h.id);
        if (!c) return null;
        return {
          id: c.id,
          name: c.name,
          bm25Score: h.score,
          bm25Norm: h.scoreNorm,
          competitor: c,
        };
      })
      .filter(Boolean);
  }

  _buildQuery(product, competitor) {
    // 查询 = 己方画像 + 当前竞品关键字段，便于召回「同类威胁证据」
    return [
      productToQuery(product),
      competitor?.name,
      competitor?.category,
      competitor?.description,
    ]
      .filter(Boolean)
      .join(' ');
  }

  _retrieveEvidence(query, competitor, corpus, topK) {
    const docs = (corpus || [])
      .filter((c) => c && (c.id || c.name))
      .map(competitorToDoc);

    // 语料过少时，仍索引当前竞品自身，保证 pipeline 可跑
    if (!docs.find((d) => d.id === (competitor.id || competitor.name))) {
      docs.push(competitorToDoc(competitor));
    }

    const index = new BM25Index(docs);
    const hits = index.search(query, {
      topK,
      excludeIds: competitor.id ? [competitor.id] : [],
    });

    // 自身文档相对查询的 BM25 相关度
    const selfDoc = competitorToDoc(competitor);
    const selfOnly = new BM25Index([selfDoc]);
    const selfScore = selfOnly.score(query, selfOnly.docs[0]);

    return {
      query: query.slice(0, 500),
      selfBm25: Math.round(selfScore * 1000) / 1000,
      neighbors: hits.map((h) => ({
        id: h.id,
        name: h.meta?.name || h.id,
        score: Math.round(h.score * 1000) / 1000,
        scoreNorm: h.scoreNorm,
        snippet: (h.text || '').slice(0, 220),
        price: h.meta?.price,
        category: h.meta?.category,
      })),
    };
  }

  async _ragJudge(product, competitor, base, evidence) {
    const neighborBlock =
      evidence.neighbors?.length > 0
        ? evidence.neighbors
            .map(
              (n, i) =>
                `[证据${i + 1}] ${n.name} | BM25=${n.score} | 品类=${n.category || '—'} | 价格=${n.price ?? '—'} | 摘要=${n.snippet}`
            )
            .join('\n')
        : '（语料库中暂无其它相关竞品证据）';

    const data = await this.llm.research(
      `你是竞品威胁评估 Agent。请基于【结构化特征】与【BM25 检索证据】做 RAG 威胁判定。

## 己方产品
名称: ${product.name}
品类: ${product.category || ''}
描述: ${product.description || ''}
价格: ${product.price ?? '未知'}
规格: ${JSON.stringify(product.specs || {})}
渠道: ${JSON.stringify(product.channels || [])}
关键词: ${JSON.stringify(product.keywords || [])}

## 待评估竞品
名称: ${competitor.name}
公司: ${competitor.company || ''}
品类: ${competitor.category || ''}
描述: ${competitor.description || ''}
价格: ${competitor.price ?? competitor.price_range ?? '未知'}
规格: ${JSON.stringify(competitor.specs || {})}
渠道: ${JSON.stringify(competitor.channels || [])}
网站: ${competitor.website || ''}

## 规则基线分（可参考，勿盲从）
threatScore: ${base.threatScore}
dimensions: ${JSON.stringify(base.dimensions)}
rule_reason: ${base.reason}

## BM25 检索证据（库内相关竞品）
自身与查询相关度 selfBm25: ${evidence.selfBm25}
${neighborBlock}

## 判定要求
1. 威胁分 0~1，越高越危险（直接竞品、同价位、同渠道、功能重叠高 → 高威胁）
2. 必须引用检索证据或结构化字段，禁止编造不存在的价格/参数
3. 若证据不足，降低分数并在 reason 中说明不确定性
4. dimensions 给出 0~1 细分

返回 JSON:
{
  "threatScore": 0.0,
  "reason": "一句话结论（含关键证据）",
  "dimensions": {
    "price": 0,
    "category": 0,
    "features": 0,
    "channels": 0,
    "positioning": 0,
    "price_edge": 0,
    "channel_edge": 0,
    "completeness": 0
  },
  "confidence": 0.0,
  "evidence_used": ["用到的证据简述"],
  "is_direct_competitor": true
}`,
      '仅输出 JSON。这是 RAG 威胁评估：以证据为准，结构化维度为辅。'
    );

    const ragScore = Number(data.threatScore);
    const conf = Number.isFinite(Number(data.confidence))
      ? Math.min(1, Math.max(0, Number(data.confidence)))
      : 0.7;

    // RAG 为核心；confidence 越高，RAG 权重越大（0.55~0.85）
    const ragW = 0.55 + conf * 0.3;
    const ruleW = 1 - ragW;
    const blended = Number.isFinite(ragScore)
      ? Math.min(1, Math.max(0, ragScore * ragW + base.threatScore * ruleW))
      : base.threatScore;

    // 维度：RAG 覆盖优先，否则用规则
    const dims = { ...base.dimensions };
    if (data.dimensions && typeof data.dimensions === 'object') {
      for (const [k, v] of Object.entries(data.dimensions)) {
        if (Number.isFinite(Number(v))) {
          dims[k] = Math.min(1, Math.max(0, Number(v)));
        }
      }
    }

    // BM25 自身相关度作为 positioning 轻微校准
    if (evidence.selfBm25 > 0 && (dims.positioning == null || dims.positioning < 0.3)) {
      const bump = Math.min(0.25, Math.log1p(evidence.selfBm25) / 10);
      dims.positioning = Math.min(1, (dims.positioning || 0) + bump);
    }

    return {
      threatScore: Math.round(blended * 1000) / 1000,
      dimensions: dims,
      vector: Object.keys(dims).length
        ? [
            dims.price || 0,
            dims.category || 0,
            dims.features || 0,
            dims.channels || 0,
            dims.positioning || 0,
            dims.price_edge || 0,
            dims.channel_edge || 0,
            dims.completeness || 0,
          ]
        : base.vector,
      reason: data.reason || base.reason,
      method: 'rag_bm25',
      confidence: conf,
      is_direct_competitor: data.is_direct_competitor !== false,
      evidence_used: Array.isArray(data.evidence_used) ? data.evidence_used : [],
      bm25: evidence,
      rag_evidence: evidence,
      rule_score: base.threatScore,
      rag_score: Number.isFinite(ragScore) ? ragScore : null,
    };
  }
}

module.exports = ThreatAnalyzer;
