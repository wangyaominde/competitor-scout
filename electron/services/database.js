const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * 纯 JS 本地数据库（JSON 文件持久化）
 * 避免 better-sqlite3 等原生模块的编译依赖，Windows 开箱即用。
 */
class CompetitorDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath.endsWith('.db')
      ? dbPath.replace(/\.db$/i, '.json')
      : dbPath;
    this.data = {
      competitors: [],
      scan_history: [],
      channels: [],
      roadmaps: [],
    };
    this._load();
  }

  _load() {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = {
          competitors: parsed.competitors || [],
          scan_history: parsed.scan_history || [],
          channels: parsed.channels || [],
          roadmaps: parsed.roadmaps || [],
        };
      } else {
        this._save();
      }
    } catch (err) {
      console.error('[db] load failed, using empty store:', err.message);
      this.data = { competitors: [], scan_history: [], channels: [], roadmaps: [] };
    }
  }

  _save() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.dbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.dbPath);
  }

  _now() {
    return new Date().toISOString();
  }

  _clone(row) {
    if (!row) return null;
    return JSON.parse(JSON.stringify(row));
  }

  listCompetitors(filters = {}) {
    let list = this.data.competitors.slice();

    if (filters.status) {
      list = list.filter((c) => c.status === filters.status);
    }
    if (filters.minThreat != null) {
      list = list.filter((c) => (c.threat_score || 0) >= filters.minThreat);
    }
    if (filters.q) {
      const q = filters.q.toLowerCase();
      list = list.filter((c) => {
        const blob = `${c.name || ''} ${c.company || ''} ${c.description || ''}`.toLowerCase();
        return blob.includes(q);
      });
    }

    list.sort((a, b) => {
      const t = (b.threat_score || 0) - (a.threat_score || 0);
      if (t !== 0) return t;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });

    if (filters.limit) list = list.slice(0, filters.limit);
    return list.map((r) => this._clone(r));
  }

  getCompetitor(id) {
    return this._clone(this.data.competitors.find((c) => c.id === id));
  }

  findByName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    return this._clone(
      this.data.competitors.find((c) => (c.name || '').toLowerCase() === lower)
    );
  }

  upsertCompetitor(data) {
    const now = this._now();
    const existing = data.id
      ? this.data.competitors.find((c) => c.id === data.id)
      : data.name
        ? this.data.competitors.find(
            (c) => (c.name || '').toLowerCase() === String(data.name).toLowerCase()
          )
        : null;

    if (existing) {
      const idx = this.data.competitors.findIndex((c) => c.id === existing.id);
      const merged = {
        ...existing,
        ...data,
        id: existing.id,
        specs: data.specs ?? existing.specs ?? {},
        channels: data.channels ?? existing.channels ?? [],
        source_urls: data.source_urls
          ? [...new Set([...(existing.source_urls || []), ...data.source_urls])]
          : existing.source_urls || [],
        tags: data.tags ?? existing.tags ?? [],
        threat_dimensions: data.threat_dimensions ?? existing.threat_dimensions ?? {},
        threat_method: data.threat_method ?? existing.threat_method ?? null,
        threat_confidence: data.threat_confidence ?? existing.threat_confidence ?? null,
        rag_evidence: data.rag_evidence ?? existing.rag_evidence ?? null,
        threat_vs: data.threat_vs ?? existing.threat_vs ?? null,
        primary_product_id: data.primary_product_id ?? existing.primary_product_id ?? null,
        primary_product_name: data.primary_product_name ?? existing.primary_product_name ?? null,
        vector: data.vector ?? existing.vector ?? [],
        last_seen_at: now,
        updated_at: now,
        confirmed_at: data.confirmed_at || existing.confirmed_at || null,
        status: data.status || existing.status,
      };
      this.data.competitors[idx] = merged;
      this._syncChannels(merged.channels || []);
      this._save();
      return this._clone(merged);
    }

    const row = {
      id: data.id || uuidv4(),
      name: data.name,
      company: data.company || null,
      category: data.category || null,
      description: data.description || null,
      price: data.price ?? null,
      price_unit: data.price_unit || 'CNY',
      price_range: data.price_range || null,
      specs: data.specs || {},
      channels: data.channels || [],
      website: data.website || null,
      source_urls: data.source_urls || [],
      status: data.status || 'pending',
      threat_score: data.threat_score || 0,
      threat_dimensions: data.threat_dimensions || {},
      threat_reason: data.threat_reason || null,
      threat_method: data.threat_method || null,
      threat_confidence: data.threat_confidence ?? null,
      rag_evidence: data.rag_evidence || null,
      threat_vs: data.threat_vs || null,
      primary_product_id: data.primary_product_id || null,
      primary_product_name: data.primary_product_name || null,
      vector: data.vector || [],
      tags: data.tags || [],
      notes: data.notes || null,
      first_seen_at: now,
      last_seen_at: now,
      confirmed_at: data.confirmed_at || null,
      created_at: now,
      updated_at: now,
    };

    this.data.competitors.push(row);
    this._syncChannels(row.channels || []);
    this._save();
    return this._clone(row);
  }

  confirmCompetitor(id) {
    const c = this.data.competitors.find((x) => x.id === id);
    if (!c) return null;
    c.status = 'confirmed';
    c.confirmed_at = this._now();
    c.updated_at = this._now();
    this._save();
    return this._clone(c);
  }

  rejectCompetitor(id) {
    const c = this.data.competitors.find((x) => x.id === id);
    if (!c) return;
    c.status = 'rejected';
    c.updated_at = this._now();
    this._save();
  }

  deleteCompetitor(id) {
    this.data.competitors = this.data.competitors.filter((c) => c.id !== id);
    this._save();
  }

  updateThreatScore(id, score, dimensions, reason, extra = {}) {
    const c = this.data.competitors.find((x) => x.id === id);
    if (!c) return;
    c.threat_score = score;
    c.threat_dimensions = dimensions || {};
    c.threat_reason = reason || null;
    if (extra.method != null) c.threat_method = extra.method;
    if (extra.confidence != null) c.threat_confidence = extra.confidence;
    if (extra.rag_evidence != null) c.rag_evidence = extra.rag_evidence;
    if (extra.vector != null) c.vector = extra.vector;
    if (extra.rule_score != null) c.rule_score = extra.rule_score;
    if (extra.rag_score != null) c.rag_score = extra.rag_score;
    if (extra.threat_vs != null) c.threat_vs = extra.threat_vs;
    if (extra.primary_product_id != null) c.primary_product_id = extra.primary_product_id;
    if (extra.primary_product_name != null) c.primary_product_name = extra.primary_product_name;
    c.updated_at = this._now();
    this._save();
  }

  _syncChannels(channels) {
    if (!Array.isArray(channels)) return;
    const now = this._now();
    for (const ch of channels) {
      const name = typeof ch === 'string' ? ch : ch?.name;
      if (!name) continue;
      const type = typeof ch === 'object' ? ch.type || 'other' : 'other';
      const existing = this.data.channels.find(
        (x) => x.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        existing.competitor_count = (existing.competitor_count || 0) + 1;
        existing.updated_at = now;
      } else {
        this.data.channels.push({
          id: uuidv4(),
          name,
          type,
          url: null,
          competitor_count: 1,
          updated_at: now,
        });
      }
    }
  }

  listChannels() {
    return this._clone(
      [...this.data.channels].sort(
        (a, b) => (b.competitor_count || 0) - (a.competitor_count || 0)
      )
    );
  }

  createScanHistory(query, meta = {}) {
    const id = uuidv4();
    this.data.scan_history.unshift({
      id,
      started_at: this._now(),
      finished_at: null,
      query: query || '',
      trigger: meta.trigger || 'manual',
      product_name: meta.product_name || null,
      product_id: meta.product_id || null,
      found_count: 0,
      new_count: 0,
      threat_count: 0,
      status: 'running',
      summary: null,
      error: null,
      logs: [],
      found_names: [],
      new_names: [],
      threats: [],
      details: null,
    });
    this.data.scan_history = this.data.scan_history.slice(0, 200);
    this._save();
    return id;
  }

  appendScanLog(id, entry) {
    const h = this.data.scan_history.find((x) => x.id === id);
    if (!h) return;
    if (!Array.isArray(h.logs)) h.logs = [];
    h.logs.push({
      at: this._now(),
      stage: entry.stage || '',
      message: entry.message || '',
      percent: entry.percent != null ? entry.percent : null,
    });
    if (h.logs.length > 300) h.logs = h.logs.slice(-300);
    h._logDirty = (h._logDirty || 0) + 1;
    if (h._logDirty >= 3 || entry.forceSave) {
      h._logDirty = 0;
      this._save();
    }
  }

  getScanHistory(id) {
    const h = this.data.scan_history.find((x) => x.id === id);
    if (!h) return null;
    const clone = this._clone(h);
    delete clone._logDirty;
    return clone;
  }

  finishScanHistory(id, data) {
    const h = this.data.scan_history.find((x) => x.id === id);
    if (!h) return;
    h.finished_at = this._now();
    h.found_count = data.found_count || 0;
    h.new_count = data.new_count || 0;
    h.threat_count = data.threat_count || 0;
    h.status = data.status || 'done';
    h.summary = data.summary || null;
    h.error = data.error || null;
    if (data.found_names) h.found_names = data.found_names;
    if (data.new_names) h.new_names = data.new_names;
    if (data.threats) h.threats = data.threats;
    if (data.details) h.details = data.details;
    if (data.query) h.query = data.query;
    delete h._logDirty;
    this._save();
  }

  listScanHistory(limit = 20) {
    return this._clone(
      this.data.scan_history.slice(0, limit).map((h) => {
        const { logs, details, _logDirty, ...rest } = h;
        return {
          ...rest,
          log_count: Array.isArray(logs) ? logs.length : 0,
          has_detail: true,
        };
      })
    );
  }

  getStats() {
    const all = this.data.competitors;
    const total = all.length;
    const pending = all.filter((c) => c.status === 'pending').length;
    const confirmed = all.filter((c) => c.status === 'confirmed').length;
    const highThreat = all.filter((c) => (c.threat_score || 0) >= 0.65).length;
    const confirmedList = all.filter((c) => c.status === 'confirmed');
    const avgThreat =
      confirmedList.length === 0
        ? 0
        : confirmedList.reduce((s, c) => s + (c.threat_score || 0), 0) / confirmedList.length;

    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const recentScans = this.data.scan_history.filter((h) => {
      const t = Date.parse(h.started_at);
      return Number.isFinite(t) && t >= weekAgo;
    }).length;

    const withPrice = all.filter((c) => c.price != null || c.price_range).length;
    const withChannels = all.filter((c) => (c.channels || []).length > 0).length;
    const withSpecs = all.filter((c) => c.specs && Object.keys(c.specs).length > 0).length;
    const coverage = total
      ? {
          price: Math.round((withPrice / total) * 100),
          channels: Math.round((withChannels / total) * 100),
          specs: Math.round((withSpecs / total) * 100),
        }
      : { price: 0, channels: 0, specs: 0 };

    return {
      total,
      pending,
      confirmed,
      highThreat,
      avgThreat: Math.round(avgThreat * 100) / 100,
      recentScans,
      coverage,
      topThreats: this.listCompetitors({ status: 'confirmed', limit: 5 }),
      pendingList: this.listCompetitors({ status: 'pending', limit: 8 }),
    };
  }

  saveRoadmap(doc) {
    const id = doc.id || uuidv4();
    const now = this._now();
    const row = {
      id,
      ...doc,
      created_at: doc.created_at || now,
      updated_at: now,
    };
    this.data.roadmaps = this.data.roadmaps || [];
    this.data.roadmaps.unshift(row);
    this.data.roadmaps = this.data.roadmaps.slice(0, 50);
    this._save();
    return this._clone(row);
  }

  listRoadmaps(limit = 20) {
    return this._clone((this.data.roadmaps || []).slice(0, limit));
  }

  getRoadmap(id) {
    return this._clone((this.data.roadmaps || []).find((r) => r.id === id));
  }

  getLatestRoadmap() {
    const list = this.data.roadmaps || [];
    return list.length ? this._clone(list[0]) : null;
  }

  deleteRoadmap(id) {
    this.data.roadmaps = (this.data.roadmaps || []).filter((r) => r.id !== id);
    this._save();
  }

  /** 全量快照，用于备份导出 */
  getSnapshot() {
    return this._clone(this.data);
  }

  /** 从备份恢复（覆盖） */
  restoreSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('无效的备份数据');
    }
    this.data = {
      competitors: Array.isArray(snapshot.competitors) ? snapshot.competitors : [],
      scan_history: Array.isArray(snapshot.scan_history) ? snapshot.scan_history : [],
      channels: Array.isArray(snapshot.channels) ? snapshot.channels : [],
      roadmaps: Array.isArray(snapshot.roadmaps) ? snapshot.roadmaps : [],
    };
    this._save();
    return this.getStats();
  }

  close() {
    this._save();
  }
}

module.exports = CompetitorDatabase;
