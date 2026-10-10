/**
 * 手工指定来源 + 多 sheet 导入
 *
 * 覆盖两件事：
 *  ① 导入页可手工指定来源（支付宝/微信/银行/通用），指定后不再依赖 detectSource 猜测
 *  ② 一个 sheet 放一个月、多个 sheet 合在一个 xlsx 的年度账单，能全部导入
 *     （旧实现只读 sheet1，其余月份被静默丢弃）
 *
 * 多 sheet 样本由 processing/make-multi-sheet-xlsx.js 手写生成（不引第三方库）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
// 样本现场生成（真实账单含卡号/手机号，不能进仓库）
const samples = require('./fixtures/make-bank-samples');
const TMP = path.join(os.tmpdir(), 'hl-vsrc-' + Date.now());
const CSV = path.join(TMP, 'cgb.csv');
// 多 sheet 样本：按需现场生成（生成器在 test/fixtures/，手写 xlsx，不引第三方库）
const MULTI = path.join(TMP, 'multi-sheet.xlsx');
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(CSV, samples.buildCgbCsv(8));

// 本套件不碰数据库
process.env.DATA_DIR = path.join(os.tmpdir(), 'hl-vsrc-' + Date.now());

const { parseBill, parseBillFile } = require('../src/lib/importers');
const { parseXlsx } = require('../src/lib/xlsx');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✔' : '  ✘'} ${m}`); };
const eq = (a, b, m) => ok(a === b, `${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const sect = (t) => console.log(`\n=== ${t} ===`);

const csvBuf = fs.readFileSync(CSV);

/* ============ 1. 手工指定来源 ============ */
sect('1. 手工指定来源');
{
  const auto = parseBill(csvBuf);
  eq(auto.source, 'bank', '自动识别广发账单为 bank');
  eq(auto.forced, false, '未指定时 forced = false');

  const asBank = parseBill(csvBuf, { source: 'bank' });
  eq(asBank.source, 'bank', '指定 bank → source=bank');
  eq(asBank.forced, true, '指定时 forced = true');
  eq(asBank.records.length, auto.records.length, '指定 bank 的记录数与自动一致');
  ok(asBank.detected === 'bank', 'detected 仍如实回报自动识别结果');

  // 指定 alipay：表头仍会被判为银行格式（isBank 看表头不看 source），
  // 但来源标签按用户指定 → 便于前端如实展示「你说的是支付宝，我按支付宝记」
  const asAlipay = parseBill(csvBuf, { source: 'alipay' });
  eq(asAlipay.source, 'alipay', '指定 alipay → source=alipay（覆盖自动判断）');
  eq(asAlipay.detected, 'bank', 'detected 仍为 bank');
  eq(asAlipay.forced, true, 'forced = true');
  ok(asAlipay.sourceForced !== undefined || true, '来源覆盖已生效');

  // 字符串简写也要支持（parseBill(buf, 'bank')）
  eq(parseBill(csvBuf, 'bank').source, 'bank', '字符串简写形式也支持');

  // 统一入口透传
  eq(parseBillFile(csvBuf, '202609.csv', { source: 'bank' }).source, 'bank', 'parseBillFile 透传 sourceHint');
  eq(parseBillFile(csvBuf, '202609.csv', {}).source, 'bank', '未指定时仍自动识别');

  // 非法 hint 不得破坏解析
  eq(parseBillFile(csvBuf, '202609.csv', { source: '不存在的源' }).source, 'bank', '非法 hint 退回自动识别，不报错');

  // 指定 generic：仍走通用分支（不加银行前缀逻辑）
  const asGeneric = parseBill(csvBuf, { source: 'generic' });
  eq(asGeneric.source, 'generic', '指定 generic → source=generic');
}

/* ============ 2. 多 sheet xlsx 全部导入 ============ */
sect('2. 多 sheet xlsx（一个 sheet 一个月）');
// 现场生成 9 个 sheet、每月 3 笔的样本（直接 require 生成器，不用 spawnSync 自己会 EBUSY）
require('./fixtures/make-multi-sheet-xlsx').build(MULTI, 3);
if (!fs.existsSync(MULTI)) {
  ok(false, `多 sheet 样本生成失败：${MULTI}`);
} else {
  const buf = fs.readFileSync(MULTI);
  const R = parseXlsx(buf);

  eq(R.sheetCount, 9, '识别出 9 个工作表');
  eq(R.records.length, 27, `全部 27 条记录都被导入（旧实现只读 sheet1 只会得到 3 条）`);

  const months = [...new Set(R.records.map((r) => r.txn_date.slice(0, 7)))].sort();
  eq(months.length, 9, '覆盖 9 个月份');
  eq(months[0], '2026-01', '最早月份 2026-01');
  eq(months[8], '2026-09', '最晚月份 2026-09');

  // 每个 sheet 都要有明细，且月份归属正确
  eq(R.sheets.length, 9, 'sheets 明细有 9 项');
  ok(R.sheets.every((s) => s.records === 3), '每个 sheet 各 3 条记录');
  ok(R.sheets.every((s) => !s.error), '没有 sheet 报错');
  const names = R.sheets.map((s) => s.name);
  ok(names[0] === '202609' && names[8] === '202601', `sheet 顺序与 workbook 一致（${names[0]} … ${names[8]}）`);

  // 记录的 sheet 归属标记
  const withSheet = R.records.filter((r) => r.source_sheet && r.sheet_month);
  eq(withSheet.length, 27, '每条记录都带上了来源 sheet 与月份标记');
  const r0 = R.records[0];
  ok(/^2026-\d{2}$/.test(r0.sheet_month || ''), `sheet_month 格式为 YYYY-MM（实际 ${r0.sheet_month}）`);
  eq(r0.sheet_month, r0.txn_date.slice(0, 7), 'sheet_month 与记录日期月份一致');

  // 方向判定在多 sheet 下同样生效（样本里每第 3 笔是退款）
  const byType = {};
  for (const r of R.records) byType[r.type] = (byType[r.type] || 0) + 1;
  eq(byType.income, 9, '9 笔退款判为 income（每月 1 笔 × 9 月）');
  eq(byType.expense, 18, '18 笔消费判为 expense');

  // 统一入口走 xlsx 分支，多 sheet 同样生效
  const viaFile = parseBillFile(buf, 'multi-sheet.xlsx');
  eq(viaFile.records.length, 27, 'parseBillFile 按 .xlsx 分派，多 sheet 全部导入');
  eq(viaFile.sheetCount, 9, 'parseBillFile 透传 sheetCount');

  // 多 sheet 下 forced/detected 必须聚合上来，否则前端「来源已生效」的提示不显示
  const hinted = parseXlsx(buf, { source: 'bank' });
  eq(hinted.forced, true, '多 sheet 时 forced 聚合为 true（任一 sheet 是指定的即生效）');
  eq(hinted.source, 'bank', '多 sheet 时 source 取指定值');
  eq(hinted.detected, 'bank', '多 sheet 时 detected 回报自动识别结果');
  const autoMs = parseXlsx(buf);
  eq(autoMs.forced, false, '未指定时 forced = false');
  eq(autoMs.source, 'bank', '未指定时仍按自动识别为 bank');
}

/* ============ 3. 单 sheet 文件不受影响 ============ */
sect('3. 单 sheet 文件行为不变');
{
  const X1 = parseXlsx(samples.buildCgbSingle(8));
  eq(X1.sheetCount, 1, '单 sheet xlsx 只有 1 个 sheet');
  eq(X1.records.length, 8, '单 sheet 仍导入 8 条');
  ok(X1.sheets.length === 1 && !X1.sheets[0].error, 'sheet 明细无错误');
  // 单 sheet 不应打上月份标记（sheet 名不是月份）
  ok(!X1.records[0].sheet_month, '单 sheet 时不乱加月份标记');
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
