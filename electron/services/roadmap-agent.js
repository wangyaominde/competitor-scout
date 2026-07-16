/**
 * AI 击败路径 / Product Roadmap 模拟
 * 输入：己方产品组合 + 高威胁竞品情报
 * 输出：结构化可执行 Roadmap（定位、差距、分阶段里程碑、功能/价格/渠道）
 */
class RoadmapAgent {
  constructor(llm) {
    this.llm = llm;
  }

  /**
   * @param {{ products: object[], competitors: object[], focusProductId?: string, horizon?: string, goal?: string }} input
   */
  async generate(input = {}) {
    const products = input.products || [];
    const competitors = input.competitors || [];
    if (!products.length) {
      throw new Error('请先配置至少一个己方产品');
    }
    if (!competitors.length) {
      throw new Error('竞品库为空，请先扫描或添加竞品再生成路线图');
    }

    const focus =
      products.find((p) => p.id === input.focusProductId) || products[0];
    const topThreats = [...competitors]
      .sort((a, b) => (b.threat_score || 0) - (a.threat_score || 0))
      .slice(0, 12);

    const horizon = input.horizon || '12m';
    const goal =
      input.goal ||
      '在目标市场击败主要竞品，形成可感知的差异化优势并提升转化';

    const payload = {
      focusProduct: this._slimProduct(focus),
      portfolio: products.map((p) => this._slimProduct(p)),
      threats: topThreats.map((c) => this._slimCompetitor(c)),
      horizon,
      goal,
    };

    const data = await this.llm.research(
      `你是资深产品战略 / 竞品打击顾问。请基于下列情报，输出「击败竞品」的 AI 模拟 Product Roadmap。

## 目标
${goal}
时间跨度: ${horizon === '6m' ? '6 个月' : horizon === '18m' ? '18 个月' : '12 个月'}

## 当前基准产品（主打）
${JSON.stringify(payload.focusProduct, null, 2)}

## 我方产品组合
${JSON.stringify(payload.portfolio, null, 2)}

## 高威胁竞品（已按威胁分排序，含价格/规格/渠道/威胁原因）
${JSON.stringify(payload.threats, null, 2)}

## 要求
1. 结论必须可执行，避免空话（「提升体验」要落到具体功能/指标）
2. 明确「打谁」「在哪打赢」「凭什么赢」
3. 分阶段：近（0-3月）/ 中（3-6月）/ 远（6-12月或到 horizon）
4. 覆盖：功能规格、价格带、渠道、营销卖点、成功指标
5. 指出必须跟进的竞品能力 vs 必须差异化的能力
6. 引用具体竞品名称与字段，不要编造不存在的参数

严格返回 JSON：
{
  "title": "路线图标题",
  "summary": "3-5 句战略摘要",
  "northStar": "北极星指标一句话",
  "positioning": {
    "statement": "一句话定位",
    "targetUser": "目标用户",
    "battlefield": "主战场（品类/场景/价位）",
    "winTheme": "赢法主题"
  },
  "beatList": [
    {
      "competitor": "竞品名",
      "threatScore": 0.0,
      "howToBeat": "如何击败",
      "avoidCopying": "不要盲目抄的点"
    }
  ],
  "gaps": [
    {
      "area": "功能|价格|渠道|体验|品牌",
      "current": "现状",
      "target": "目标状态",
      "priority": "P0|P1|P2",
      "against": "主要对标竞品"
    }
  ],
  "mustHave": [
    { "name": "必须具备能力", "reason": "原因", "priority": "P0|P1" }
  ],
  "differentiators": [
    { "name": "差异化卖点", "reason": "原因", "moat": "护城河弱|中|强" }
  ],
  "priceStrategy": {
    "band": "建议价格带",
    "logic": "逻辑",
    "vsCompetitors": "相对竞品的价格姿态"
  },
  "channelStrategy": {
    "priorityChannels": ["渠道1"],
    "actions": ["动作"]
  },
  "phases": [
    {
      "id": "p1",
      "name": "近程 0-3 月",
      "theme": "阶段主题",
      "goals": ["目标"],
      "deliverables": ["交付物/功能"],
      "metrics": ["可量化指标"],
      "risks": ["风险"]
    },
    {
      "id": "p2",
      "name": "中程 3-6 月",
      "theme": "",
      "goals": [],
      "deliverables": [],
      "metrics": [],
      "risks": []
    },
    {
      "id": "p3",
      "name": "远程 6-12 月",
      "theme": "",
      "goals": [],
      "deliverables": [],
      "metrics": [],
      "risks": []
    }
  ],
  "kpis": [
    { "name": "指标名", "baseline": "基线", "target": "目标", "when": "何时" }
  ],
  "nextActions": [
    { "action": "本周可做的事", "owner": "产品|研发|市场|销售", "urgency": "高|中|低" }
  ],
  "assumptions": ["关键假设"],
  "confidence": 0.0
}`,
      '仅输出合法 JSON。这是击败路径模拟，要具体、可落地、可被打脸验证。'
    );

    return this._normalize(data, {
      focus,
      products,
      topThreats,
      horizon,
      goal,
    });
  }

  _slimProduct(p) {
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      description: p.description,
      price: p.price,
      specs: p.specs || {},
      channels: p.channels || [],
      keywords: p.keywords || [],
    };
  }

  _slimCompetitor(c) {
    return {
      name: c.name,
      company: c.company,
      category: c.category,
      description: c.description,
      price: c.price,
      price_range: c.price_range,
      specs: c.specs || {},
      channels: c.channels || [],
      threat_score: c.threat_score,
      threat_reason: c.threat_reason,
      threat_dimensions: c.threat_dimensions,
      primary_product_name: c.primary_product_name,
      status: c.status,
    };
  }

  _normalize(raw, ctx) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const phases = Array.isArray(d.phases) && d.phases.length
      ? d.phases
      : [
          { id: 'p1', name: '近程 0-3 月', theme: '', goals: [], deliverables: [], metrics: [], risks: [] },
          { id: 'p2', name: '中程 3-6 月', theme: '', goals: [], deliverables: [], metrics: [], risks: [] },
          { id: 'p3', name: '远程 6-12 月', theme: '', goals: [], deliverables: [], metrics: [], risks: [] },
        ];

    return {
      title: d.title || `${ctx.focus.name} · 击败路径`,
      summary: d.summary || '',
      northStar: d.northStar || '',
      positioning: d.positioning || {},
      beatList: Array.isArray(d.beatList) ? d.beatList : [],
      gaps: Array.isArray(d.gaps) ? d.gaps : [],
      mustHave: Array.isArray(d.mustHave) ? d.mustHave : [],
      differentiators: Array.isArray(d.differentiators) ? d.differentiators : [],
      priceStrategy: d.priceStrategy || {},
      channelStrategy: d.channelStrategy || {},
      phases,
      kpis: Array.isArray(d.kpis) ? d.kpis : [],
      nextActions: Array.isArray(d.nextActions) ? d.nextActions : [],
      assumptions: Array.isArray(d.assumptions) ? d.assumptions : [],
      confidence: Number.isFinite(Number(d.confidence))
        ? Math.min(1, Math.max(0, Number(d.confidence)))
        : 0.6,
      meta: {
        focusProductId: ctx.focus.id,
        focusProductName: ctx.focus.name,
        productCount: ctx.products.length,
        competitorCount: ctx.topThreats.length,
        horizon: ctx.horizon,
        goal: ctx.goal,
        generatedAt: new Date().toISOString(),
      },
    };
  }
}

module.exports = RoadmapAgent;
