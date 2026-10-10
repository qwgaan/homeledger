'use strict';
/**
 * 最小 xlsx 解析器（零新增依赖）
 *
 * xlsx 本质是一个 zip 包，内含 xl/sharedStrings.xml（共享字符串表）与
 * xl/worksheets/sheet1.xml（单元格数据）。Node 自带 zlib 能解 deflate，
 * 因此不需要引入 SheetJS 就能读出单元格文本。
 *
 * 支持：.xlsx（zip 容器）、共享字符串、inlineStr、数字/布尔/日期序列号、空行。
 * 不支持：老的 .xls（BIFF 二进制）、加密工作簿、公式结果以外的计算值。
 *   —— .xls 请另存为 .xlsx 或 .csv 后再导入。
 */
const zlib = require('node:zlib');

/* ------------------------------ zip 最小读取 ------------------------------ */

/**
 * 从 zip 中央目录里定位并读取一个条目。
 * 只支持 store(0) 与 deflate(8) 两种压缩方式 —— 绝大多数 xlsx 都是 deflate。
 */
function readZipEntry(buf, entryName) {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;

  // 反向扫描找 End of Central Directory（注释区最长 64KB）
  let eocd = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（未找到 zip 结构）。请另存为 .xlsx 或 .csv 后重试');

  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (name === entryName) {
      // 本地文件头的 extra 长度可能与中央目录不同，必须重新读
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`xlsx 条目 ${entryName} 使用了不支持的压缩方式（${method}）`);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

/* ------------------------------- XML 解析 ------------------------------- */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"' };

function decodeXml(s) {
  return String(s || '').replace(/&(?:amp|lt|gt|quot|apos|#39|#34);/g, (m) => XML_ENTITIES[m.slice(1, -1)] || m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 取 <tag .../> 的属性 */
function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
}

/** Excel 1900 日期系统基准：序号 1 = 1900-01-01 */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function excelSerialToDate(n) {
  const ms = EXCEL_EPOCH + Math.round(n * 86400000);
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 解析 sharedStrings.xml → 字符串数组 */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  // 每个 <si> 可能被富文本拆成多个 <t>，需拼接
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1] || '';
    let text = '';
    let t;
    tRe.lastIndex = 0;
    while ((t = tRe.exec(inner)) !== null) text += decodeXml(t[1]);
    out.push(text);
  }
  return out;
}

/**
 * 从 styles.xml 解析出「哪些 cellXfs 索引是日期格式」。
 * xlsx 的日期没有独立类型，靠单元格的 numFmtId 判断（内置 14–22、45–47 为日期/时间），
 * 自定义格式则看是否含 y/m/d/h/s 等日期占位符（排除 [h] 与 [m] 这类已内置的）。
 */
function parseDateStyles(xml) {
  const set = new Set();
  if (!xml) return set;
  const numFmts = {};
  const nfRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g;
  let m;
  while ((m = nfRe.exec(xml)) !== null) numFmts[m[1]] = decodeXml(m[2]);

  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfsBlock) return set;
  const xfRe = /<xf\b[^>]*\/?>/g;
  const xfs = cellXfsBlock[1].match(xfRe) || [];
  xfs.forEach((xf, i) => {
    const id = /numFmtId="(\d+)"/.exec(xf);
    if (!id) return;
    const fmtId = id[1];
    const builtin = (Number(fmtId) >= 14 && Number(fmtId) <= 22) || (Number(fmtId) >= 45 && Number(fmtId) <= 47);
    const code = numFmts[fmtId] || '';
    // 自定义格式：去掉字面量与颜色/条件段后，看是否还剩日期占位符
    const cleaned = code
      .replace(/"[^"]*"/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\[[^\]]*\]/g, '');
    const custom = /[ymdhs]/i.test(cleaned) && !/^[#0.,%\s]*$/.test(cleaned);
    if (builtin || custom) set.add(i);
  });
  return set;
}

/** 单元格列名 "BC" → 索引 54 */
function colIndex(ref) {
  const letters = String(ref || '').replace(/\d+/g, '');
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/**
 * 单元格值归一化：修正 Excel 导出的两类脏值。
 *
 * 1) 浮点误差：Excel 存数字用二进制浮点，40.8 读出来可能是 40.799999999999997，
 *    直接 Number() 再 ×100 会在边界上抖动（4080 vs 4079.99…）。这里按有效数字
 *    收敛到 6 位小数，40.799999999999997 → 40.8。
 * 2) 日期序列号：xlsx 里的日期是「1900 基准的序号」，需要按样式判定后转文本。
 *    银行导出的表都是文本日期，这里只处理真正的数值日期（如 46285 → 2026-09-20）。
 */
function normalizeCell(raw, isDateStyle) {
  let v = String(raw ?? '').trim();
  if (v === '') return '';
  if (!/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (isDateStyle) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 20000 && n < 80000) return excelSerialToDate(n);
  }
  // 非日期：收敛浮点误差。Excel 用二进制浮点存数字，40.8 会读成 40.799999999999997。
  // 金额最多两位小数，保留 6 位小数足够安全，直接截断其后的长尾。
  if (v.includes('.')) {
    const dot = v.indexOf('.');
    if (v.length - dot > 7) {
      let cut = v.slice(0, dot + 7);
      cut = cut.replace(/0+$/, '').replace(/\.$/, '');
      return cut;
    }
  }
  return v;
}

/** 解析 sheet xml → 二维字符串数组。dateStyles 为日期样式的 xf 索引集合 */
function parseSheet(xml, shared, dateStyles = new Set()) {
  const rows = [];
  if (!xml) return rows;
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowInner = rm[1] || '';
    const cells = [];
    let cm;
    cRe.lastIndex = 0;
    while ((cm = cRe.exec(rowInner)) !== null) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = attr(attrs, 'r');
      const type = attr(attrs, 't');
      const style = attr(attrs, 's');
      const idx = ref ? colIndex(ref) : cells.length;
      const isDate = style !== null && dateStyles.has(Number(style));

      let value = '';
      if (type === 's') {
        // 共享字符串：<v> 是 sharedStrings 的下标
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? (shared[Number(decodeXml(v[1]))] ?? '') : '';
      } else if (type === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        value = t ? decodeXml(t[1]) : '';
      } else if (type === 'str') {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? decodeXml(v[1]) : '';
      } else if (type === 'b') {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        value = v && decodeXml(v[1]) === '1' ? 'TRUE' : 'FALSE';
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        value = normalizeCell(v ? decodeXml(v[1]) : '', isDate);
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = String(value).trim();
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * 从 workbook.xml 读出「有哪些 sheet、叫什么、按什么顺序」。
 * 银行网银导出的年度账单通常是「每个 sheet 一个月」（sheet 名如 202609/202608…），
 * 只读 sheet1 会静默丢掉其余月份，所以必须按关系表把每个 sheet 都找出来。
 * @returns {Array<{name:string, target:string}>} target 是 zip 内路径
 */
function parseWorkbookSheets(workbookXml, relsXml) {
  if (!workbookXml) return [];
  // rels：Id → Target（Target 可能是 worksheets/sheet1.xml，也可能是绝对路径 /xl/worksheets/…）
  const relMap = new Map();
  if (relsXml) {
    const re = /<Relationship\b[^>]*\/?>/g;
    let m;
    while ((m = re.exec(relsXml)) !== null) {
      const tag = m[0];
      const id = attr(tag, 'Id');
      const target = attr(tag, 'Target');
      if (id && target) relMap.set(id, target.replace(/^\/?(xl\/)?/, '').replace(/^\//, ''));
    }
  }
  const out = [];
  const sheetRe = /<sheet\b[^>]*\/?>/g;
  let m;
  while ((m = sheetRe.exec(workbookXml)) !== null) {
    const tag = m[0];
    const name = attr(tag, 'name') || '';
    const rid = /r:id="([^"]+)"/.exec(tag) || attr(tag, 'id');
    const target = rid ? (relMap.get(rid[1] || rid) || '') : '';
    out.push({ name, target: target ? `xl/${target}` : '' });
  }
  return out;
}

/** 按关系表列出全部 worksheet 的 zip 路径（保持 workbook 中的顺序） */
function listSheetPaths(buf) {
  const wb = readZipEntry(buf, 'xl/workbook.xml');
  const rels = readZipEntry(buf, 'xl/_rels/workbook.xml.rels');
  const sheets = parseWorkbookSheets(wb ? wb.toString('utf8') : null, rels ? rels.toString('utf8') : null);

  const paths = [];
  const seen = new Set();
  for (const s of sheets) {
    if (!s.target || seen.has(s.target)) continue;
    if (!readZipEntry(buf, s.target)) continue;   // 关系表指向的条目可能不存在
    seen.add(s.target);
    paths.push({ name: s.name, path: s.target });
  }
  if (paths.length) return paths;

  // workbook.xml 缺失或不可解析时，退回按编号扫（至少能拿到 sheet1）
  for (let i = 1; i <= 40; i++) {
    const p = `xl/worksheets/sheet${i}.xml`;
    if (readZipEntry(buf, p)) paths.push({ name: '', path: p });
  }
  return paths;
}

/**
 * 从工作表名解析月份。
 *
 * 两种用途，别混：
 *  · 广发等多 sheet 年度账单：sheet 名就是「哪个月」，用于给记录打 sheet_month 标记
 *  · 招行等日期缺年份的账单：**sheet 名是年份的唯一权威来源**（cmb-202609.xlsx 的
 *    sheet 名为 202609，日期只有 812 这样的三位数），单 sheet 时也必须解析。
 *
 * 所以这里不做 sheetCount 判断，解析与否只取决于 sheet 名本身像不像月份。
 */
function monthOfSheetName(name) {
  const m = /^\s*(20\d{2})[-/年]?(\d{1,2})\s*$/.exec(String(name || ''));
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : null;
}

/* --------------------------------- 对外 -------------------------------- */

/**
 * 解析 xlsx → 与 parseCsv 同构的二维数组，再复用同一套解析逻辑。
 *
 * 多 sheet 处理：银行网银导出的年度账单常常「一个 sheet 一个月」，
 * 这里逐个 sheet 解析后**合并全部记录**，避免只导第一个月、其余月份静默丢失。
 * 只有当某个 sheet 解析不出交易（表头不匹配等）时才跳过，并在 sheets 统计里如实反映。
 *
 * @param {Buffer} buf .xlsx 文件内容
 * @param {object} [opts] { source, bank } source=来源（alipay/wechat/bank/generic），
 *   bank=银行 profile（cgb/cmb/generic）。指定 bank=cmb 时走招行专用解析。
 */
function parseXlsx(buf, opts = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw new Error('文件内容为空或不是有效的 xlsx');
  // PK\x03\x04 是 zip 的本地文件头签名
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('不支持的文件格式：仅支持 .xlsx。老的 .xls 请在 Excel/WPS 中「另存为 .xlsx」后再导入');
  }
  const sharedXml = readZipEntry(buf, 'xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedXml ? sharedXml.toString('utf8') : null);
  const stylesXml = readZipEntry(buf, 'xl/styles.xml');
  const dateStyles = parseDateStyles(stylesXml ? stylesXml.toString('utf8') : null);

  const sheetPaths = listSheetPaths(buf);
  if (!sheetPaths.length) throw new Error('xlsx 中未找到工作表，请确认文件未损坏');

  const { parseBill } = require('./importers');
  const bankKey = String(opts.bank || '');
  const merged = {
    records: [], neutralRecords: [], rows: [], sheets: [],
    header: [], source: '', detected: '', forced: false,
    encoding: 'xlsx', totalLines: 0, skipped: 0, error: null,
    year: null, yearInferred: false, yearFrom: null,
  };

  for (const sp of sheetPaths) {
    const xml = readZipEntry(buf, sp.path);
    const raw = parseSheet(xml.toString('utf8'), shared, dateStyles);
    const rows = raw
      .map((r) => (r || []).map((c) => String(c ?? '')))
      .filter((r) => r.some((c) => c !== ''));
    if (!rows.length) {
      merged.sheets.push({ name: sp.name, records: 0, skipped: 0, empty: true, error: null });
      continue;
    }
    const sheetMonth = monthOfSheetName(sp.name);

    // 招行等有专用解析器的银行，走专用路径（不经过 CSV 链路）
    let parsed;
    if (bankKey === 'cmb') {
      const { parseCmb } = require('./cmb');
      // sheetName 原样传入：招行靠它定年份（202609），回报时也用原名而非改写过的 2026-09
      const r = parseCmb(rows, { sheetMonth, sheetName: sp.name });
      parsed = {
        source: 'bank', detected: 'bank', forced: true,
        encoding: 'xlsx', header: r.header || [],
        records: r.records, neutralRecords: r.neutralRecords,
        totalLines: rows.length, skipped: (r.skipped || []).length,
        year: r.year, yearInferred: r.yearInferred, yearFrom: r.yearFrom,
        sections: r.sections,
      };
    } else {
      // 每个 sheet 独立走一遍完整解析（找表头、映射列、方向判定、分类）
      parsed = parseBill(Buffer.from(rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'utf8'), opts);
    }

    if (parsed.error) {
      // 该 sheet 不是账单（如封面/说明页），跳过但不报错
      merged.sheets.push({ name: sp.name, records: 0, skipped: 0, empty: false, error: parsed.error });
      continue;
    }
    // 记录打 sheet_month 标记只在「确实是按月分表」时打（sheetCount > 1）。
    // 单 sheet 文件即使名字碰巧是 202609，也不是年度账单，打标记会误导。
    // 注意：这与「年份锚点」是两件事 —— 招行单 sheet 也要靠 sheet 名补年份，见 inferYear。
    const tagMonth = sheetPaths.length > 1 ? sheetMonth : null;
    const tag = (r) => (tagMonth ? { ...r, source_sheet: sp.name, sheet_month: tagMonth } : r);
    merged.records.push(...(parsed.records || []).map(tag));
    merged.neutralRecords.push(...(parsed.neutralRecords || []).map(tag));
    merged.rows.push(...rows);
    merged.totalLines += parsed.totalLines || rows.length;
    merged.skipped += parsed.skipped || 0;
    if (!merged.header.length) merged.header = parsed.header;
    if (!merged.source) merged.source = parsed.source;
    if (!merged.detected) merged.detected = parsed.detected || parsed.source;
    // forced 取「任一 sheet 是用户指定的」——多 sheet 时前端要显示来源下拉生效了
    if (parsed.forced) merged.forced = true;
    // 年份推断结果（招行日期没有年份，取首个 sheet 的结论即可）
    if (parsed.year && !merged.year) {
      merged.year = parsed.year;
      merged.yearInferred = parsed.yearInferred;
      merged.yearFrom = parsed.yearFrom;
    }
    merged.sheets.push({
      name: sp.name, month: sheetMonth,
      records: (parsed.records || []).length, neutral: (parsed.neutralRecords || []).length,
      skipped: parsed.skipped || 0, error: null,
      sections: parsed.sections || null,
    });
  }

  if (!merged.records.length && !merged.neutralRecords.length) {
    const reasons = merged.sheets.filter((s) => s.error).map((s) => `${s.name || '工作表'}：${s.error}`);
    merged.error = reasons.length
      ? `未能在任何工作表中识别出账单表头。${reasons[0]}`
      : '未能在工作表中识别出账单表头，请确认文件内容是否为交易明细';
  }
  merged.xlsx = true;
  merged.sheetCount = sheetPaths.length;
  return merged;
}

/** 单元格转 CSV 文本：含逗号/引号/换行时加引号并转义 */
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = {
  parseXlsx, readZipEntry, parseSharedStrings, parseSheet, parseDateStyles,
  parseWorkbookSheets, listSheetPaths,
  colIndex, excelSerialToDate, normalizeCell,
};