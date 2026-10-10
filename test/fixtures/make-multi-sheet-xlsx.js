/**
 * 造一个「每个 sheet 一个月」的多 sheet xlsx，模拟银行网银的年度账单导出。
 * 手写 xlsx（不引第三方库），只用 node:zlib。
 *
 * 用法：node make-multi-sheet-xlsx.js <输出路径> [每月笔数]
 */
'use strict';
const fs = require('node:fs');

/* ---------------- xlsx = zip（存储方式，无需压缩） ---------------- */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    // CRC32
    let crcTable = zipStore._t;
    if (!crcTable) {
      crcTable = zipStore._t = (() => {
        const t = new Int32Array(256);
        for (let i = 0; i < 256; i++) {
          let c = i;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          t[i] = c;
        }
        return t;
      })();
    }
    let crc = -1;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
    crc = (crc ^ -1) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // method = store
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
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
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cd, eocd]);
}

/** 生成多 sheet xlsx。导出为函数供测试直接 require（避免 spawnSync 自己会 EBUSY） */
function build(OUT, PER_MONTH = 3) {
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 构造 9 个月（202601 ~ 202609），每月 PER_MONTH 笔
const MONTHS = ['202609', '202608', '202607', '202606', '202605', '202604', '202603', '202602', '202601'];
const SHOP = ['广东三元麦当劳食品有限公司', '财付通-美团', '网银在线-京东商城业务', '财付通-滴滴出行', '拼多多平台商户'];
const strings = [];
const sIdx = (s) => {
  let i = strings.indexOf(s);
  if (i < 0) { strings.push(s); i = strings.length - 1; }
  return i;
};

const sheetXmls = MONTHS.map((ym, mi) => {
  const rows = [];
  rows.push(`<row r="1"><c r="A1" t="s"><v>${sIdx('卡号：6251********1776')}</v></c></row>`);
  const hdr = ['交易日期', '入账日期', '交易摘要', '交易金额', '交易货币', '入账金额', '入账货币'];
  rows.push(`<row r="2">${hdr.map((h, i) => `<c r="${String.fromCharCode(65 + i)}2" t="s"><v>${sIdx(h)}</v></c>`).join('')}</row>`);
  for (let k = 0; k < PER_MONTH; k++) {
    const day = String(3 + k * 5).padStart(2, '0');
    const day2 = String(4 + k * 5).padStart(2, '0');
    const refund = k % 3 === 2;
    const summary = refund ? `(退款)财付通-${SHOP[k % SHOP.length]}` : `(消费)财付通-${SHOP[k % SHOP.length]}`;
    const amt = refund ? -(1000 + k * 137) : 1000 + k * 137;
    const r = mi * 100 + 10 + k;
    rows.push(
      `<row r="${r}">` +
      `<c r="A${r}" t="s"><v>${sIdx(`${ym.slice(0, 4)}/${ym.slice(4, 6)}/${day}`)}</v></c>` +
      `<c r="B${r}" t="s"><v>${sIdx(`${ym.slice(0, 4)}/${ym.slice(4, 6)}/${day2}`)}</v></c>` +
      `<c r="C${r}" t="s"><v>${sIdx(summary)}</v></c>` +
      `<c r="D${r}"><v>${amt}</v></c>` +
      `<c r="E${r}" t="s"><v>${sIdx('人民币')}</v></c>` +
      `<c r="F${r}"><v>${amt}</v></c>` +
      `<c r="G${r}" t="s"><v>${sIdx('人民币')}</v></c>` +
      `</row>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
});

// workbook.xml（含 sheet 名称=月份，用于验证能否按月份归类）
const sheetTags = MONTHS.map((m, i) =>
  `<sheet name="${m}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
).join('');
const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets></workbook>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${MONTHS.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
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
${MONTHS.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
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

fs.writeFileSync(OUT, zipStore(files));
console.log(`已生成多 sheet 样本：${OUT}`);
console.log(`  sheet 数 = ${MONTHS.length}（${MONTHS.join(', ')}）`);
console.log(`  每 sheet ${PER_MONTH} 笔 → 应有 ${MONTHS.length * PER_MONTH} 条记录`);
}

module.exports = { build };

/* ------------------------------------------------------------------ */
/* 命令行入口：node make-multi-sheet-xlsx.js <输出路径> [每月笔数]     */
/* ------------------------------------------------------------------ */
if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('用法：node make-multi-sheet-xlsx.js <输出路径> [每月笔数]');
    process.exit(1);
  }
  build(out, Number(process.argv[3] || 3));
}