const { AppError, Codes } = require('./errors');

/** 默认单次请求超时（毫秒）。竞品研究/JSON 生成通常 >45s。 */
const DEFAULT_TIMEOUT_MS = 120000;
/** 研究类任务（discover/enrich/verify）额外缓冲 */
const RESEARCH_TIMEOUT_MS = 180000;
const MIN_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 600000;

/**
 * OpenAI-compatible LLM client.
 * Supports OpenAI / DeepSeek / 通义 / MiniMax / Kimi / 本地 Ollama 等兼容接口。
 */
class LLMService {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.stats = { calls: 0, failures: 0, lastError: null, lastLatencyMs: null };
  }

  getStats() {
    return { ...this.stats };
  }

  _config() {
    const c = this.getConfig() || {};
    if (!c.baseUrl) {
      throw new AppError(Codes.PRECONDITION, '请先配置 LLM Base URL');
    }
    if (!c.apiKey && !this._isLocal(c.baseUrl)) {
      throw new AppError(Codes.PRECONDITION, '请先在设置中配置 LLM API Key');
    }
    if (!c.model) {
      throw new AppError(Codes.PRECONDITION, '请先配置 LLM Model');
    }
    const timeoutMs = this._clampTimeout(c.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return {
      baseUrl: String(c.baseUrl).replace(/\/$/, ''),
      apiKey: c.apiKey || 'ollama',
      model: c.model,
      temperature: c.temperature ?? 0.3,
      timeoutMs,
    };
  }

  _clampTimeout(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
  }

  _isLocal(url) {
    if (!url) return false;
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url);
  }

  _isAbort(err) {
    return err?.name === 'AbortError' || /aborted|timeout/i.test(err?.message || '');
  }

  _isTransportError(err) {
    if (this._isAbort(err)) return true;
    const msg = String(err?.message || '');
    return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network/i.test(msg);
  }

  async chat(messages, options = {}) {
    const cfg = this._config();
    const body = {
      model: options.model || cfg.model,
      messages,
      temperature: options.temperature ?? cfg.temperature,
    };

    if (options.json) {
      body.response_format = { type: 'json_object' };
    }

    const started = Date.now();
    this.stats.calls += 1;
    const timeoutMs = this._clampTimeout(options.timeoutMs ?? cfg.timeoutMs);

    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.stats.failures += 1;
      this.stats.lastError = err.message;
      this.stats.lastLatencyMs = Date.now() - started;
      const aborted = this._isAbort(err);
      throw new AppError(
        Codes.LLM,
        aborted
          ? `LLM 请求超时（>${Math.round(timeoutMs / 1000)}s）。可在设置中提高「请求超时」，或检查网络/API 线路`
          : `无法连接 LLM 服务：${err.message}`,
        { baseUrl: cfg.baseUrl, timeout: aborted, timeoutMs }
      );
    }

    this.stats.lastLatencyMs = Date.now() - started;

    if (!res.ok) {
      this.stats.failures += 1;
      const text = await res.text().catch(() => '');
      const friendly =
        res.status === 401
          ? 'API Key 无效或未授权'
          : res.status === 429
            ? '请求过于频繁，请稍后重试'
            : res.status === 404
              ? '接口地址或模型不存在，请检查 Base URL / Model'
              : `LLM 请求失败 (${res.status})`;
      this.stats.lastError = friendly;
      throw new AppError(Codes.LLM, friendly, { status: res.status, body: text.slice(0, 300) });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (content == null) {
      this.stats.failures += 1;
      throw new AppError(Codes.LLM, 'LLM 返回空内容');
    }
    this.stats.lastError = null;
    return content;
  }

  async chatJson(messages, options = {}) {
    // 部分本地模型不支持 response_format，先尝试 json 模式，失败再降级
    // 超时/网络错误不再盲目重试，避免连续卡两倍时间
    try {
      const raw = await this.chat(messages, { ...options, json: true });
      return this._parseJson(raw);
    } catch (err) {
      if (err instanceof AppError && err.details?.timeout) {
        throw err;
      }
      if (err instanceof AppError && err.details?.status === 400) {
        const raw = await this.chat(messages, { ...options, json: false });
        return this._parseJson(raw);
      }
      if (String(err.message || '').includes('无法解析')) {
        throw err;
      }
      // 连接类错误不重试
      if (err instanceof AppError && /无法连接|超时/.test(err.message || '')) {
        throw err;
      }
      try {
        const raw = await this.chat(messages, { ...options, json: false });
        return this._parseJson(raw);
      } catch (e2) {
        throw err;
      }
    }
  }

  _parseJson(raw) {
    if (typeof raw !== 'string') return raw;
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    try {
      return JSON.parse(text);
    } catch {
      const obj = text.match(/\{[\s\S]*\}/);
      if (obj) {
        try {
          return JSON.parse(obj[0]);
        } catch {
          /* fallthrough */
        }
      }
      const arr = text.match(/\[[\s\S]*\]/);
      if (arr) {
        try {
          return JSON.parse(arr[0]);
        } catch {
          /* fallthrough */
        }
      }
      throw new AppError(Codes.LLM, '无法解析 LLM JSON 响应', { preview: text.slice(0, 200) });
    }
  }

  /**
   * 情报研究：默认更长超时（竞品列表/补全/威胁判定）。
   */
  async research(prompt, systemExtra = '', options = {}) {
    const cfg = this._config();
    const timeoutMs = this._clampTimeout(
      options.timeoutMs ?? Math.max(cfg.timeoutMs, RESEARCH_TIMEOUT_MS)
    );
    const system = `你是专业的竞品情报分析师（Competitor Scout Agent）。
你的任务是搜集、结构化并验证竞品信息。
输出必须严格为 JSON，不要包含解释性文字。
关注维度：产品名、公司、价格、规格参数、销售渠道、官网、差异点、威胁点。
${systemExtra}`.trim();

    return this.chatJson(
      [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      { temperature: options.temperature ?? 0.2, timeoutMs }
    );
  }
}

module.exports = LLMService;
