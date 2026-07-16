const fs = require('fs');
const path = require('path');
const { AppError, Codes } = require('./errors');

const MAX_TEXT_CHARS = 28000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const SUPPORTED_EXT = [
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.xml',
  '.log',
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.rtf',
];

/**
 * 规格书解析：读文件 → 抽文本 → LLM 结构化 → 返回待确认字段草稿
 */
class SpecParser {
  constructor(llm) {
    this.llm = llm;
  }

  supportedLabel() {
    return 'PDF / Word(.docx) / Excel(.xlsx) / TXT / MD / CSV / JSON / HTML';
  }

  async parseFiles(filePaths = []) {
    if (!filePaths.length) {
      throw new AppError(Codes.VALIDATION, '未选择文件');
    }

    const sources = [];
    const textParts = [];

    for (const fp of filePaths) {
      const extracted = await this.extractText(fp);
      sources.push({
        path: fp,
        filename: path.basename(fp),
        ext: path.extname(fp).toLowerCase(),
        bytes: extracted.bytes,
        chars: extracted.text.length,
        method: extracted.method,
        warning: extracted.warning || null,
      });
      if (extracted.text) {
        textParts.push(
          `\n\n===== 文件: ${path.basename(fp)} (${extracted.method}) =====\n${extracted.text}`
        );
      }
    }

    const combined = textParts.join('\n').trim();
    if (!combined || combined.length < 8) {
      throw new AppError(
        Codes.VALIDATION,
        '未能从文件中提取有效文本。请上传 PDF/Word/TXT 等可读规格书；扫描件图片暂不支持 OCR。'
      );
    }

    const clipped =
      combined.length > MAX_TEXT_CHARS
        ? combined.slice(0, MAX_TEXT_CHARS) + '\n\n…(正文过长，已截断)'
        : combined;

    const structured = await this.structureWithLlm(clipped, sources.map((s) => s.filename));
    const fields = this.toConfirmFields(structured);

    return {
      sources,
      preview: clipped.slice(0, 1200),
      truncated: combined.length > MAX_TEXT_CHARS,
      structured,
      fields,
      confidence: structured.confidence ?? null,
      notes: structured.notes || structured.parse_notes || '',
    };
  }

  async extractText(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new AppError(Codes.NOT_FOUND, `文件不存在: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      throw new AppError(Codes.VALIDATION, `文件过大（>${MAX_FILE_BYTES / 1024 / 1024}MB）: ${path.basename(filePath)}`);
    }

    const ext = path.extname(filePath).toLowerCase();
    const bytes = stat.size;

    if (['.txt', '.md', '.csv', '.log', '.rtf', '.xml'].includes(ext)) {
      const text = fs.readFileSync(filePath, 'utf8');
      return { text: text.replace(/\u0000/g, ''), bytes, method: 'text' };
    }

    if (['.html', '.htm'].includes(ext)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      return { text, bytes, method: 'html' };
    }

    if (ext === '.json') {
      const raw = fs.readFileSync(filePath, 'utf8');
      try {
        const obj = JSON.parse(raw);
        return { text: JSON.stringify(obj, null, 2), bytes, method: 'json' };
      } catch {
        return { text: raw, bytes, method: 'json-raw' };
      }
    }

    if (ext === '.pdf') {
      return this.extractPdf(filePath, bytes);
    }

    if (ext === '.docx') {
      return this.extractDocx(filePath, bytes);
    }

    if (ext === '.doc') {
      return {
        text: '',
        bytes,
        method: 'unsupported',
        warning: '旧版 .doc 请另存为 .docx 或 PDF 后上传',
      };
    }

    if (ext === '.xlsx' || ext === '.xls') {
      return this.extractXlsx(filePath, bytes);
    }

    if (ext === '.pptx') {
      return {
        text: '',
        bytes,
        method: 'unsupported',
        warning: '暂不支持 PPT，请导出 PDF/Word/TXT',
      };
    }

    // 尝试当文本读
    try {
      const buf = fs.readFileSync(filePath);
      const sample = buf.slice(0, 200).toString('utf8');
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(sample)) {
        return { text: buf.toString('utf8'), bytes, method: 'text-fallback' };
      }
    } catch {
      /* ignore */
    }

    throw new AppError(
      Codes.VALIDATION,
      `不支持的文件类型: ${ext || '(无扩展名)'}。支持 ${this.supportedLabel()}`
    );
  }

  async extractPdf(filePath, bytes) {
    try {
      const mod = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      let text = '';

      // pdf-parse v2+: class PDFParse
      if (mod.PDFParse) {
        const parser = new mod.PDFParse({ data: buf });
        try {
          const result = await parser.getText();
          text = (result && (result.text || result)) || '';
          if (typeof text !== 'string') text = String(text || '');
        } finally {
          try {
            await parser.destroy();
          } catch {
            /* ignore */
          }
        }
      } else {
        // 旧版 default function
        const pdfParse = mod.default || mod;
        const data = await pdfParse(buf);
        text = (data && data.text) || '';
      }

      text = text.replace(/\s+\n/g, '\n').trim();
      return {
        text,
        bytes,
        method: 'pdf-parse',
        warning: text.length < 20 ? 'PDF 文本很少，可能是扫描件（需 OCR）' : null,
      };
    } catch (err) {
      throw new AppError(
        Codes.INTERNAL,
        `PDF 解析失败: ${err.message}。可另存为 TXT/Word 再试。`
      );
    }
  }

  async extractDocx(filePath, bytes) {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      const text = (result.value || '').trim();
      return {
        text,
        bytes,
        method: 'mammoth',
        warning: result.messages?.length
          ? result.messages.map((m) => m.message).join('; ')
          : null,
      };
    } catch (err) {
      throw new AppError(Codes.INTERNAL, `Word 解析失败: ${err.message}`);
    }
  }

  async extractXlsx(filePath, bytes) {
    try {
      let AdmZip;
      try {
        AdmZip = require('adm-zip');
      } catch {
        return {
          text: '',
          bytes,
          method: 'xlsx-unavailable',
          warning: 'Excel 解析组件未安装，请导出 CSV/TXT 上传',
        };
      }
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();
      const chunks = [];
      for (const e of entries) {
        const n = e.entryName || '';
        if (
          n.includes('sharedStrings.xml') ||
          /xl\/worksheets\/sheet\d+\.xml$/i.test(n)
        ) {
          const xml = e.getData().toString('utf8');
          const text = xml
            .replace(/<[^>]+>/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) chunks.push(text);
        }
      }
      return {
        text: chunks.join('\n'),
        bytes,
        method: 'xlsx-xml',
        warning: chunks.length ? null : 'Excel 中未抽到文本',
      };
    } catch (err) {
      return {
        text: '',
        bytes,
        method: 'xlsx-error',
        warning: `Excel 解析失败: ${err.message}`,
      };
    }
  }

  async structureWithLlm(text, filenames = []) {
    const data = await this.llm.research(
      `你是产品规格书信息抽取助手。请从下列文档正文中提取「一个主产品」的结构化信息。
不确定的字段填 null 或空，不要编造。

文件名: ${filenames.join(', ')}

--- 正文开始 ---
${text}
--- 正文结束 ---

返回 JSON:
{
  "name": "产品名称或型号",
  "category": "品类",
  "description": "产品描述/卖点摘要（2-5句）",
  "price": null,
  "price_range": null,
  "price_unit": "CNY",
  "keywords": ["关键词"],
  "channels": ["销售/渠道若文中有"],
  "specs": { "规格名": "规格值" },
  "company": "厂商/品牌若有",
  "confidence": 0.0,
  "notes": "抽取说明与不确定点",
  "field_confidence": {
    "name": 0.0,
    "category": 0.0,
    "description": 0.0,
    "price": 0.0,
    "keywords": 0.0,
    "channels": 0.0,
    "specs": 0.0
  }
}`,
      '仅输出 JSON。specs 尽量扁平键值；价格只填正文明确数字。'
    );

    return data && typeof data === 'object' ? data : {};
  }

  /**
   * 转为人工确认清单
   * 每项: { key, label, path, value, type, confidence, selected, group }
   */
  toConfirmFields(structured) {
    const fc = structured.field_confidence || {};
    const fields = [];

    const push = (item) => {
      if (item.value == null || item.value === '') return;
      if (Array.isArray(item.value) && !item.value.length) return;
      if (typeof item.value === 'object' && !Array.isArray(item.value) && !Object.keys(item.value).length) {
        return;
      }
      fields.push({
        id: item.id || item.key,
        key: item.key,
        label: item.label,
        value: item.value,
        display: item.display != null ? item.display : formatDisplay(item.value),
        type: item.type || 'string',
        confidence: item.confidence ?? null,
        selected: item.selected !== false,
        group: item.group || 'basic',
      });
    };

    push({
      key: 'name',
      label: '产品名称',
      value: structured.name,
      confidence: fc.name,
      type: 'string',
      group: 'basic',
    });
    push({
      key: 'category',
      label: '品类',
      value: structured.category,
      confidence: fc.category,
      type: 'string',
      group: 'basic',
    });
    push({
      key: 'company',
      label: '品牌/公司',
      value: structured.company,
      confidence: fc.name,
      type: 'string',
      group: 'basic',
    });
    push({
      key: 'description',
      label: '产品描述',
      value: structured.description,
      confidence: fc.description,
      type: 'text',
      group: 'basic',
    });
    if (structured.price != null && structured.price !== '') {
      push({
        key: 'price',
        label: '标价',
        value: Number(structured.price),
        confidence: fc.price,
        type: 'number',
        group: 'basic',
      });
    }
    if (structured.price_range) {
      push({
        key: 'price_range',
        label: '价格区间',
        value: structured.price_range,
        confidence: fc.price,
        type: 'string',
        group: 'basic',
      });
    }
    if (Array.isArray(structured.keywords) && structured.keywords.length) {
      push({
        key: 'keywords',
        label: '关键词',
        value: structured.keywords,
        display: structured.keywords.join(', '),
        confidence: fc.keywords,
        type: 'list',
        group: 'basic',
      });
    }
    if (Array.isArray(structured.channels) && structured.channels.length) {
      push({
        key: 'channels',
        label: '渠道',
        value: structured.channels,
        display: structured.channels.join(', '),
        confidence: fc.channels,
        type: 'list',
        group: 'basic',
      });
    }

    const specs = structured.specs && typeof structured.specs === 'object' ? structured.specs : {};
    for (const [k, v] of Object.entries(specs)) {
      if (v == null || v === '') continue;
      push({
        id: `spec:${k}`,
        key: `spec.${k}`,
        label: `规格 · ${k}`,
        value: v,
        display: String(v),
        confidence: fc.specs,
        type: 'spec',
        group: 'specs',
      });
    }

    return fields;
  }

  /**
   * 根据人工勾选的 fields 合成产品补丁
   */
  applyFields(fields, { mergeSpecs = true, base = {} } = {}) {
    const patch = {
      name: base.name || '',
      category: base.category || '',
      description: base.description || '',
      price: base.price ?? null,
      keywords: Array.isArray(base.keywords) ? [...base.keywords] : [],
      channels: Array.isArray(base.channels) ? [...base.channels] : [],
      specs: { ...(base.specs || {}) },
    };
    let company = base.company || '';
    let price_range = base.price_range || null;

    for (const f of fields || []) {
      if (!f.selected) continue;
      if (f.key === 'name') patch.name = String(f.value || '').trim();
      else if (f.key === 'category') patch.category = String(f.value || '').trim();
      else if (f.key === 'description') patch.description = String(f.value || '').trim();
      else if (f.key === 'price') {
        const n = Number(f.value);
        patch.price = Number.isFinite(n) ? n : null;
      } else if (f.key === 'price_range') price_range = String(f.value || '').trim();
      else if (f.key === 'company') company = String(f.value || '').trim();
      else if (f.key === 'keywords') {
        patch.keywords = Array.isArray(f.value)
          ? f.value.map(String)
          : String(f.value)
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean);
      } else if (f.key === 'channels') {
        patch.channels = Array.isArray(f.value)
          ? f.value.map(String)
          : String(f.value)
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean);
      } else if (f.key.startsWith('spec.') || f.type === 'spec') {
        const sk = f.key.startsWith('spec.') ? f.key.slice(5) : f.label.replace(/^规格\s*·\s*/, '');
        if (mergeSpecs) patch.specs[sk] = f.value;
        else patch.specs[sk] = f.value;
      }
    }

    // 描述可附加公司/价格区间备注
    if (company && !patch.description.includes(company)) {
      patch.description = patch.description
        ? `${patch.description}\n品牌/公司: ${company}`
        : `品牌/公司: ${company}`;
    }
    if (price_range && patch.price == null) {
      patch.description = patch.description
        ? `${patch.description}\n价格区间: ${price_range}`
        : `价格区间: ${price_range}`;
    }

    return patch;
  }
}

function formatDisplay(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (v != null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

module.exports = SpecParser;
module.exports.SUPPORTED_EXT = SUPPORTED_EXT;
