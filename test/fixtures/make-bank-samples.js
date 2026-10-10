'use strict';
/**
 * 测试样本生成器 —— 造广发 / 招商 两种银行账单的 xlsx 与 csv。
 *
 * **为什么不直接用真实账单**：真实账单含卡号、手机号等敏感信息，不能进仓库。
 * 所以按实测到的真实结构造等价格式：
 *
 *   广发（cgb，单月 / 9 个月多 sheet）：
 *     表头 交易日期,入账日期,交易摘要,交易金额,交易货币,入账金额,入账货币
 *     摘要带 (消费)/(退款)/(还款) 前缀；金额靠正负号表示方向
 *
 *   招商（cmb）：
 *     一个文件里两个小节，各自表头
 *     「还款」节无表头，固定列 D=日期 F=金额，金额自带负号 ¥ -480.00
 *     「消费」节有表头 C=交易日 D=记账日 E=交易摘要 F=人民币金额，金额一律为正
 *     日期只有 3 位（812 = 8月12日），年份不在单元格里
 *
 * 生成的文件写到调用方给的路径（测试里用临时目录），不会污染仓库。
 */
const fs = require('node:fs');
const zlib = require('node:zlib');

/* ------------------------------ zip（store） ------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);        // method = store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 结构化生成多 sheet xlsx：所有 sheet 共享一张字符串表。
 * @param {Array<{name:string, rows:string[][]}>} sheets 每 sheet 的行（数组元素为 string|number|null）
 */
function buildSharedXlsx(sheets) {
  const strings = [];
  const sIdx = (s) => {
    let i = strings.indexOf(s);
    if (i < 0) { strings.push(s); i = strings.length - 1; }
    return i;
  };
  const colName = (n) => {
    let s = '';
    n += 1;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  const sheetXmls = sheets.map((sh) => {
    const rowXml = sh.rows.map((cells, ri) => {
      const r = ri + 1;
      const parts = cells.map((v, i) => {
        if (v === null || v === undefined || v === '') return `<c r="${colName(i)}${r}"/>`;
        if (typeof v === 'number') return `<c r="${colName(i)}${r}"><v>${v}</v></c>`;
        return `<c r="${colName(i)}${r}" t="s"><v>${sIdx(String(v))}</v></c>`;
      });
      return `<row r="${r}">${parts.join('')}</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml.join('')}</sheetData></worksheet>`;
  });

  const sheetTags = sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;
  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;

  const files = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/sharedStrings.xml', sharedXml],
    ...sheetXmls.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x]),
  ];
  return zipStore(files);
}

/* ------------------------------ 广发样本 ------------------------------ */

const CGB_HEADER = ['交易日期', '入账日期', '交易摘要', '交易金额', '交易货币', '入账金额', '入账货币'];

/** 造广发一个月的数据行（含消费/退款/还款三种） */
function cgbMonthRows(ym, perMonth) {
  const [Y, M] = [ym.slice(0, 4), ym.slice(4, 6)];
  // 卡号用纯虚构号段：0000 段开头 + 全掩码尾号。
  // 不用任何真实银行的 BIN 前缀（如 6251=广发），避免"虽是假号但前缀指向真银行"。
  const rows = [
    ['卡号：0000********0000', null, null, null, null, null, null],
    CGB_HEADER,
  ];
  const shops = ['测试餐厅', '测试商城', '出行平台', '测试外卖', '拼多多平台商户'];
  for (let k = 0; k < perMonth; k++) {
    const day = String(2 + k).padStart(2, '0');
    const date = `${Y}/${M}/${day}`;
    const postDate = day;
    // 每 4 笔放一笔退款（k=3,7,11…）。perMonth 较小时（3 笔）也要有退款，
    // 否则样本里根本没有退款行，测不到「退款 → income」这条路径。
    const isRefund = k % 4 === 3 || (perMonth <= 3 && k === 2);
    // 渠道名只在摘要前缀里出现一次（真实账单是「(消费)财付通-商户名」）
    const channel = k % 2 === 0 ? '财付通' : '网银在线';
    const summary = isRefund
      ? `(退款)${channel}-${shops[k % shops.length]}`
      : `(消费)${channel}-${shops[k % shops.length]}`;
    const amt = isRefund ? -(1500 + k * 137) : 1500 + k * 137;
    rows.push([date, postDate, summary, amt, '人民币', amt, '人民币']);
  }
  // 每月一条还款（放在最后）。金额写 -200.00 元（真实账单里还款带负号）
  const repayDay = String(Math.min(28, perMonth + 2)).padStart(2, '0');
  rows.push([`${Y}/${M}/${repayDay}`, repayDay, '(还款)跨行自动转账还款', -200, '人民币', -200, '人民币']);
  return rows;
}

function buildCgbSingle(perMonth = 8) {
  const rows = cgbMonthRows('202609', perMonth);
  return buildSharedXlsx([{ name: '202609', rows }]);
}

function buildCgbYear(months = 9, perMonth = 3) {
  const list = [];
  for (let i = 0; i < months; i++) {
    const m = 9 - i;
    const ym = m >= 1 ? `2026${String(m).padStart(2, '0')}` : `2025${String(12 + m).padStart(2, '0')}`;
    list.push({ name: ym, rows: cgbMonthRows(ym, perMonth) });
  }
  return buildSharedXlsx(list);
}

/** 广发 CSV（与 xlsx 同内容，UTF-8 + BOM） */
function buildCgbCsv(perMonth = 8) {
  const rows = cgbMonthRows('202609', perMonth);
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return '\uFEFF' + rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : q(c))).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------ 招商样本 ------------------------------ */

/**
 * 造招商银行一个月的账单，结构严格照实测的 cmb-202609.xlsx：
 *   行1：B 列 = 「还款」（小节标题，无表头）
 *   行2..：D=日期(3位) E=摘要 F=¥ 金额(带负号) G=卡号末四位
 *   空行穿插
 *   然后：B 列 = 「消费」，下一行才是表头
 *   消费数据：C=交易日(3位) D=记账日(3位) E=摘要 F=¥ 金额(正数) G=卡号末四位 H=交易地
 */
function buildCmb(perMonth = 6) {
  const rows = [];
  const shops = ['测试餐饮', '测试出行', '羊城通', '测试超市', '测试影院', '测试商城', '测试书店', '测试药店',
    '测试服饰', '测试数码', '测试家居', '测试运动'];

  // 还款小节（无表头，列 D/E/F/G）
  rows.push([null, '还款']);
  rows.push([null, null, null, '829', '一卡通转账还款', '¥  -480.00', '0000']);
  rows.push([null, null, null, '901', '自动还款', '¥  -1,108.88', '0000']);

  // 消费小节（有表头，列 C/D/E/F/G/H）
  rows.push([null, '消费']);
  rows.push([null, null, '交易日', '记账日', '交易摘要', '人民币金额', '卡号末四位', '交易地']);
  for (let k = 0; k < perMonth; k++) {
    // 招行日期只有 3 位（MMDD）。这里跨 8/9 两个月循环生成，
    // 保证 12 笔也不会因为日号溢出而被判为非法日期丢弃。
    const dayOfMonth = 1 + (k * 3) % 28;
    const month = k % 2 === 0 ? 8 : 9;          // 8/9 月交替，跨月能测到
    const mmdd = month * 100 + dayOfMonth;      // 801, 804, 807 … / 901, 904 …
    const post = dayOfMonth + 1;
    // 用整数分构造金额文本，避免浮点误差拼出 '19.94.94' 这种坏串
    const cents = 1994 + k * 837;
    const yuan = Math.floor(cents / 100);
    const cent = String(cents % 100).padStart(2, '0');
    rows.push([null, null, String(mmdd), String(post),
      `${k % 2 === 0 ? '财付通' : '支付宝'}-${shops[k % shops.length]}`,
      `¥  ${yuan}.${cent}`, '0000', 'CN']);
    // 注：招行原文件每两行之间有空行，但 xlsx 解析层会过滤全空行，
    // 所以这里不生成空行 —— 空行不携带任何信息，略去不影响结构真实性。
  }
  return buildSharedXlsx([{ name: '202609', rows }]);
}

module.exports = { buildCgbSingle, buildCgbYear, buildCgbCsv, buildCmb, buildSharedXlsx, zipStore };
