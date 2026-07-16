/**
 * 竞品搜索 + Agent 确认流水线
 *
 * 流程：
 *  1. Discover  — LLM 研究式搜索，产出候选列表
 *  2. Enrich    — 对每个候选补全价格/规格/渠道
 *  3. Score     — 多维向量威胁评分
 *  4. Verify    — Agent 二次确认，去重、校验字段可信度
 *  5. Persist   — 入库（pending 待用户确认 / 或自动确认）
 */
class SearchAgent {
  constructor(llm, db, threatAnalyzer, store) {
    this.llm = llm;
    this.db = db;
    this.threat = threatAnalyzer;
    this.store = store;
  }

  _products() {
    try {
      const Products = require('./products');
      const list = Products.list(this.store);
      if (list.length) return list;
    } catch { /* fallthrough */ }
    const legacy = this.store.get('product');
    return legacy?.name ? [legacy] : [];
  }

  _product() {
    try {
      const Products = require('./products');
      return Products.getActive(this.store) || this.store.get('product') || {};
    } catch {
      return this.store.get('product') || {};
    }
  }

  async runScan(options = {}) {
    const products = this._products();
    const product = this._product();
    if (!product?.name && !products.length) {
      throw new Error('请先在「我的产品」中配置至少一个产品');
    }
    const scanProducts = products.length ? products : [product];

    const onProgressOuter = options.onProgress || (() => {});
    const query =
      options.query ||
      this._buildQuery(product);
    const trigger = options.trigger || 'manual';

    const historyId = this.db.createScanHistory(query, {
      trigger,
      product_name: product?.name || null,
      product_id: product?.id || null,
    });

    const logProgress = (p) => {
      try {
        this.db.appendScanLog(historyId, p);
      } catch {
        /* ignore */
      }
      onProgressOuter({ ...p, historyId, trigger });
    };

    const newThreats = [];
    const foundNames = [];
    const newNames = [];
    let found = 0;
    let newCount = 0;

    try {
      logProgress({
        stage: 'start',
        message: `开始扫描（${trigger === 'loop' ? '后台 Loop' : '手动'}）· 基准：${product?.name || '未命名'}`,
        percent: 5,
        forceSave: true,
      });
      logProgress({
        stage: 'discover',
        message: `正在调用 LLM 研究竞品（目标 ${options.limit || 8} 个，可能需 30–180s）…`,
        percent: 8,
      });
      logProgress({
        stage: 'discover',
        message: `研究查询：${String(query || '').slice(0, 120)}${String(query || '').length > 120 ? '…' : ''}`,
        percent: 12,
      });

      const candidates = await this._discover(product, query, options.limit || 8);
      found = candidates.length;
      candidates.forEach((c) => {
        if (c?.name) foundNames.push(c.name);
      });

      logProgress({
        stage: 'discover-done',
        message: `发现 ${found} 个候选：${foundNames.slice(0, 8).join('、')}${foundNames.length > 8 ? '…' : ''}`,
        percent: 30,
        forceSave: true,
      });

      // 语料库 = 已有竞品 + 本轮候选（先入库临时结构再做 BM25/RAG）
      const existingAll = this.db.listCompetitors({});
      const saved = [];
      const enrichedList = [];

      if (!candidates.length) {
        logProgress({
          stage: 'enrich',
          message: '本轮无候选可补全，跳过 Enrich',
          percent: 55,
        });
      }

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        logProgress({
          stage: 'enrich',
          message: `补全情报 (${i + 1}/${candidates.length}): ${c.name}`,
          percent: 30 + Math.floor((i / Math.max(candidates.length, 1)) * 25),
        });

        let enriched = c;
        try {
          enriched = await this._enrich(product, c);
          logProgress({
            stage: 'enrich',
            message: `已补全 (${i + 1}/${candidates.length}): ${c.name}${enriched.price != null ? ` · 标价 ${enriched.price}` : ''}${(enriched.channels || []).length ? ` · 渠道 ${(enriched.channels || []).length}` : ''}`,
            percent: 30 + Math.floor(((i + 1) / Math.max(candidates.length, 1)) * 25),
          });
        } catch {
          logProgress({
            stage: 'enrich-warn',
            message: `补全失败，保留初稿: ${c.name}`,
          });
        }
        enrichedList.push(enriched);
      }

      if (enrichedList.length) {
        logProgress({
          stage: 'rag',
          message: `开始威胁判定：共 ${enrichedList.length} 个候选（BM25 召回 + RAG）`,
          percent: 55,
        });
      }

      // 临时 id 便于 BM25 索引
      const draftCorpus = [
        ...existingAll,
        ...enrichedList.map((e, idx) => ({
          ...e,
          id: e.id || `draft-${idx}-${e.name}`,
          specs: e.specs || {},
          channels: e.channels || [],
        })),
      ];

      for (let i = 0; i < enrichedList.length; i++) {
        const enriched = enrichedList[i];
        logProgress({
          stage: 'rag',
          message: `威胁判定 (${i + 1}/${enrichedList.length}): ${enriched.name}`,
          percent: 55 + Math.floor((i / Math.max(enrichedList.length, 1)) * 30),
        });

        const existing = this.db.findByName(enriched.name);
        const isNew = !existing;
        const target = {
          ...(existing || {}),
          ...enriched,
          id: existing?.id || `draft-${i}-${enriched.name}`,
          specs: enriched.specs || {},
          channels: enriched.channels || [],
        };

        const scored = await this.threat.scoreAgainstProducts(scanProducts, target, {
          corpus: draftCorpus,
          useRag: true,
          topK: 5,
        });

        const row = this.db.upsertCompetitor({
          ...(existing || {}),
          name: enriched.name,
          company: enriched.company,
          category: enriched.category || product.category,
          description: enriched.description,
          price: enriched.price,
          price_unit: enriched.price_unit || 'CNY',
          price_range: enriched.price_range,
          specs: enriched.specs || {},
          channels: enriched.channels || [],
          website: enriched.website,
          source_urls: enriched.source_urls || [],
          tags: enriched.tags || [],
          status: existing?.status === 'confirmed' ? 'confirmed' : 'pending',
          threat_score: scored.threatScore,
          threat_dimensions: scored.dimensions,
          threat_reason: scored.reason,
          threat_method: scored.method || 'rag_bm25',
          threat_confidence: scored.confidence ?? null,
          rag_evidence: scored.rag_evidence || scored.bm25 || null,
          vector: scored.vector,
          notes: enriched.notes,
          threat_vs: scored.threat_vs,
          primary_product_id: scored.primary_product_id,
          primary_product_name: scored.primary_product_name,
        });

        if (isNew) {
          newCount++;
          newNames.push(row.name);
        }
        logProgress({
          stage: 'scored',
          message: `${row.name} 威胁 ${Math.round((scored.threatScore || 0) * 100)}%${isNew ? ' · 新增' : ' · 更新'}`,
        });
        if (scored.threatScore >= (options.threatThreshold ?? this.store.get('loop.threatThreshold') ?? 0.65)) {
          if (isNew || (existing && existing.threat_score < scored.threatScore - 0.1)) {
            newThreats.push({
              id: row.id,
              name: row.name,
              threatScore: scored.threatScore,
              reason: scored.reason,
            });
          }
        }
        saved.push(row);
      }

      logProgress({ stage: 'verify', message: 'Agent 正在交叉校验候选质量…', percent: 88 });
      const topPending = saved
        .filter((s) => s.status === 'pending')
        .sort((a, b) => b.threat_score - a.threat_score)
        .slice(0, 3);

      for (const item of topPending) {
        try {
          await this.verifyCompetitor(item, logProgress);
        } catch {
          /* non-fatal */
        }
      }

      logProgress({
        stage: 'done',
        message: `扫描完成：发现 ${found}，新增 ${newCount}，高威胁 ${newThreats.length}`,
        percent: 100,
        forceSave: true,
      });

      this.db.finishScanHistory(historyId, {
        found_count: found,
        new_count: newCount,
        threat_count: newThreats.length,
        status: 'done',
        summary: `发现 ${found} 个竞品，新增 ${newCount}，高威胁 ${newThreats.length}`,
        found_names: foundNames,
        new_names: newNames,
        threats: newThreats,
        details: {
          product: product?.name,
          products: scanProducts.map((p) => p.name).filter(Boolean),
          query,
          trigger,
          saved: saved.map((s) => ({
            id: s.id,
            name: s.name,
            threat_score: s.threat_score,
            status: s.status,
            price: s.price,
            price_range: s.price_range,
          })),
        },
      });

      return {
        found,
        newCount,
        newThreats,
        competitors: this.db.listCompetitors({ limit: 50 }),
        historyId,
      };
    } catch (err) {
      try {
        this.db.appendScanLog(historyId, {
          stage: 'error',
          message: err.message,
          forceSave: true,
        });
      } catch {
        /* ignore */
      }
      this.db.finishScanHistory(historyId, {
        found_count: found,
        new_count: newCount,
        threat_count: newThreats.length,
        status: 'error',
        error: err.message,
        found_names: foundNames,
        new_names: newNames,
        threats: newThreats,
      });
      throw err;
    }
  }

  _buildQuery(product) {
    const parts = [
      product.name,
      product.category,
      ...(product.keywords || []),
    ].filter(Boolean);
    return `${parts.join(' ')} 竞品 同类产品 价格 渠道`;
  }

  async _discover(product, query, limit) {
    const data = await this.llm.research(
      `请基于你的知识与公开市场信息，列出与下列产品最相关的竞品（最多 ${limit} 个）。

搜索意图: ${query}

己方产品:
- 名称: ${product.name}
- 品类: ${product.category || '未填'}
- 描述: ${product.description || '未填'}
- 价格: ${product.price ?? '未填'}
- 关键词: ${(product.keywords || []).join(', ')}

要求:
1. 必须是真实存在或市场常见的竞品/替代品
2. 覆盖直接竞品与跨界替代
3. 尽量包含价格区间、主要渠道

返回 JSON:
{
  "competitors": [
    {
      "name": "产品名",
      "company": "公司",
      "category": "品类",
      "description": "一句话描述",
      "price": 数字或null,
      "price_range": "如 ¥99-199",
      "price_unit": "CNY",
      "specs": { "关键规格": "值" },
      "channels": ["天猫", "京东", "官网", "线下"],
      "website": "https://...",
      "source_urls": [],
      "tags": ["直接竞品"],
      "notes": "为何相关"
    }
  ]
}`,
      '你具备市场与产品研究能力。若某字段不确定，用 null 或空数组，不要编造精确到分的虚假价格；可用合理价格区间。'
    );

    const list = data.competitors || data.items || data.results || [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => c && c.name)
      .slice(0, limit)
      .map((c) => ({
        name: String(c.name).trim(),
        company: c.company || '',
        category: c.category || product.category || '',
        description: c.description || '',
        price: c.price != null && c.price !== '' ? Number(c.price) : null,
        price_range: c.price_range || null,
        price_unit: c.price_unit || 'CNY',
        specs: c.specs && typeof c.specs === 'object' ? c.specs : {},
        channels: Array.isArray(c.channels) ? c.channels : [],
        website: c.website || '',
        source_urls: Array.isArray(c.source_urls) ? c.source_urls : [],
        tags: Array.isArray(c.tags) ? c.tags : [],
        notes: c.notes || '',
      }));
  }

  async _enrich(product, candidate) {
    const data = await this.llm.research(
      `请补全以下竞品的价格、规格、销售渠道信息（尽量结构化）。

己方产品参考: ${product.name} / ${product.category || ''}
竞品: ${candidate.name}
公司: ${candidate.company || ''}
已知: ${JSON.stringify(candidate)}

返回 JSON:
{
  "name": "${candidate.name}",
  "company": "",
  "category": "",
  "description": "",
  "price": null,
  "price_range": "",
  "price_unit": "CNY",
  "specs": {},
  "channels": [],
  "website": "",
  "source_urls": [],
  "tags": [],
  "notes": "",
  "confidence": 0.0
}`,
      '补全公开市场常见信息；不确定则保留 null。confidence 表示信息可信度 0-1。'
    );

    return {
      ...candidate,
      ...data,
      name: data.name || candidate.name,
      specs: data.specs && typeof data.specs === 'object' ? data.specs : candidate.specs,
      channels: Array.isArray(data.channels) ? data.channels : candidate.channels,
      source_urls: Array.isArray(data.source_urls)
        ? data.source_urls
        : candidate.source_urls,
      price:
        data.price != null && data.price !== ''
          ? Number(data.price)
          : candidate.price,
    };
  }

  /**
   * Agent 二次确认：校验字段一致性、威胁重估、状态建议
   */
  async verifyCompetitor(competitor, onProgress = () => {}) {
    const product = this._product();
    onProgress({
      stage: 'agent-verify',
      message: `Agent 确认中: ${competitor.name}`,
    });

    const data = await this.llm.research(
      `你是竞品确认 Agent。请审核以下竞品记录是否有效、字段是否合理，并给出修正建议。

己方产品: ${JSON.stringify({
        name: product.name,
        category: product.category,
        price: product.price,
        description: product.description,
      })}

待确认竞品:
${JSON.stringify({
        name: competitor.name,
        company: competitor.company,
        category: competitor.category,
        description: competitor.description,
        price: competitor.price,
        price_range: competitor.price_range,
        specs: competitor.specs,
        channels: competitor.channels,
        website: competitor.website,
        threat_score: competitor.threat_score,
      })}

返回 JSON:
{
  "valid": true,
  "is_competitor": true,
  "confidence": 0.0,
  "corrections": {
    "price": null,
    "price_range": null,
    "specs": {},
    "channels": [],
    "description": null,
    "website": null,
    "company": null
  },
  "recommend_status": "confirmed|pending|rejected",
  "verify_notes": "审核说明"
}`,
      '严格审核：非竞品应 valid=false 或 is_competitor=false。corrections 只填需要修正的字段。'
    );

    const corrections = data.corrections || {};
    const patch = {
      id: competitor.id,
      name: competitor.name,
    };

    if (corrections.price != null) patch.price = Number(corrections.price);
    if (corrections.price_range) patch.price_range = corrections.price_range;
    if (corrections.specs && Object.keys(corrections.specs).length) {
      patch.specs = { ...(competitor.specs || {}), ...corrections.specs };
    }
    if (Array.isArray(corrections.channels) && corrections.channels.length) {
      patch.channels = corrections.channels;
    }
    if (corrections.description) patch.description = corrections.description;
    if (corrections.website) patch.website = corrections.website;
    if (corrections.company) patch.company = corrections.company;

    if (data.is_competitor === false || data.valid === false) {
      patch.status = 'rejected';
      patch.notes = [competitor.notes, data.verify_notes].filter(Boolean).join('\n');
      return this.db.upsertCompetitor(patch);
    }

    // re-score after corrections — BM25+RAG 自动判定
    const merged = { ...competitor, ...patch };
    const corpus = this.db.listCompetitors({});
    const scored = await this.threat.scoreAgainstProducts(this._products(), merged, {
      corpus,
      useRag: true,
      topK: 5,
    });
    patch.threat_score = scored.threatScore;
    patch.threat_dimensions = scored.dimensions;
    patch.threat_reason = scored.reason;
    patch.threat_method = scored.method || 'rag_bm25';
    patch.threat_confidence = scored.confidence ?? null;
    patch.rag_evidence = scored.rag_evidence || scored.bm25 || null;
    patch.vector = scored.vector;
    patch.threat_vs = scored.threat_vs;
    patch.primary_product_id = scored.primary_product_id;
    patch.primary_product_name = scored.primary_product_name;
    patch.notes = [competitor.notes, data.verify_notes].filter(Boolean).join('\n');

    // Agent can recommend confirm, but final user confirm still preferred for pending
    // We only auto-confirm if confidence high AND recommend confirmed AND already pending with high threat
    if (
      data.recommend_status === 'confirmed' &&
      Number(data.confidence) >= 0.8 &&
      scored.threatScore >= 0.7
    ) {
      patch.status = 'confirmed';
      patch.confirmed_at = new Date().toISOString();
    }

    return this.db.upsertCompetitor(patch);
  }
}

module.exports = SearchAgent;
