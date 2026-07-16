const cron = require('node-cron');

/**
 * Loop Engineer — 定时扫描引擎
 * 按 cron 表达式周期性执行竞品扫描，发现高威胁竞品时回调通知。
 */
class LoopEngine {
  constructor({ store, searchAgent, db, onScanComplete, onError, onProgress }) {
    this.store = store;
    this.searchAgent = searchAgent;
    this.db = db;
    this.onScanComplete = onScanComplete || (() => {});
    this.onError = onError || (() => {});
    this.onProgress = onProgress || (() => {});
    this.task = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastResult = null;
    this.lastError = null;
  }

  getStatus() {
    const cfg = this.store.get('loop') || {};
    return {
      enabled: !!cfg.enabled,
      cron: cfg.cron || '0 */6 * * *',
      threatThreshold: cfg.threatThreshold ?? 0.65,
      isScheduled: !!this.task,
      isRunning: this.running,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      nextHint: this._humanCron(cfg.cron || '0 */6 * * *'),
    };
  }

  _humanCron(expr) {
    const map = {
      '0 * * * *': '每小时',
      '0 */2 * * *': '每 2 小时',
      '0 */4 * * *': '每 4 小时',
      '0 */6 * * *': '每 6 小时',
      '0 */12 * * *': '每 12 小时',
      '0 9 * * *': '每天 09:00',
      '0 9 * * 1': '每周一 09:00',
    };
    return map[expr] || expr;
  }

  start() {
    this.stop();
    const cfg = this.store.get('loop') || {};
    const expr = cfg.cron || '0 */6 * * *';
    if (!cron.validate(expr)) {
      this.lastError = `无效的 cron: ${expr}`;
      this.onError(new Error(this.lastError));
      return;
    }

    this.store.set('loop.enabled', true);
    this.task = cron.schedule(expr, () => {
      this.runOnce().catch((err) => {
        this.lastError = err.message;
        this.onError(err);
      });
    });
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    this.store.set('loop.enabled', false);
  }

  reload() {
    const cfg = this.store.get('loop') || {};
    if (cfg.enabled) this.start();
    else this.stop();
  }

  async runOnce() {
    if (this.running) {
      const err = new Error('扫描正在进行中');
      err.code = 'BUSY';
      throw err;
    }

    this.running = true;
    this.lastError = null;
    this.lastRunAt = new Date().toISOString();

    try {
      const threshold = this.store.get('loop.threatThreshold') ?? 0.65;
      const result = await this.searchAgent.runScan({
        threatThreshold: threshold,
        trigger: 'loop',
        onProgress: (p) => {
          if (typeof this.onProgress === 'function') this.onProgress(p);
        },
      });
      this.lastResult = {
        at: this.lastRunAt,
        found: result.found,
        newCount: result.newCount,
        threatCount: result.newThreats?.length || 0,
        historyId: result.historyId || null,
      };
      this.onScanComplete(result);
      // 不返回 { ok }，交给 main handle 统一包装，避免双重 ok 嵌套
      return result;
    } catch (err) {
      this.lastError = err.message;
      this.onError(err);
      throw err;
    } finally {
      this.running = false;
    }
  }
}

module.exports = LoopEngine;
