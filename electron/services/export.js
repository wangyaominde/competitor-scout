/**
 * 数据导出 — 单用户产品的标准能力
 */
function toCsv(rows, columns) {
  const escape = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escape(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(',')
  );
  return '\uFEFF' + [header, ...lines].join('\n');
}

function exportCompetitors(list, format = 'json') {
  if (format === 'csv') {
    return {
      filename: `competitors-${dateStamp()}.csv`,
      mime: 'text/csv;charset=utf-8',
      content: toCsv(list, [
        { key: 'name', label: '名称' },
        { key: 'company', label: '公司' },
        { key: 'category', label: '品类' },
        { key: 'price', label: '价格' },
        { key: 'price_range', label: '价格区间' },
        { key: 'channels', label: '渠道', value: (r) => (r.channels || []).join(' | ') },
        { key: 'status', label: '状态' },
        { key: 'threat_score', label: '威胁指数' },
        { key: 'threat_reason', label: '威胁说明' },
        { key: 'website', label: '官网' },
        { key: 'description', label: '描述' },
      ]),
    };
  }

  return {
    filename: `competitors-${dateStamp()}.json`,
    mime: 'application/json',
    content: JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        version: 1,
        count: list.length,
        competitors: list,
      },
      null,
      2
    ),
  };
}

function exportFullBackup(storeSnapshot, dbSnapshot) {
  return {
    filename: `competitor-intel-backup-${dateStamp()}.json`,
    mime: 'application/json',
    content: JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        version: 1,
        app: 'competitor-intel',
        settings: {
          // never dump raw secrets in plain export UI message; still include for backup
          llm: storeSnapshot.llm,
          product: storeSnapshot.product,
          loop: storeSnapshot.loop,
          notifications: storeSnapshot.notifications,
          onboarding: storeSnapshot.onboarding,
        },
        data: dbSnapshot,
      },
      null,
      2
    ),
  };
}

function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

module.exports = { exportCompetitors, exportFullBackup, toCsv };
