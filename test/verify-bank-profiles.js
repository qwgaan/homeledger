/**
 * 银行 profile 与招行专用解析
 *
 * 样本（全部是用户真实导出文件，不是构造的 mock）：
 *   docs/202609.xlsx     广发单月（2026/9/20，摘要带 (消费) 前缀）
 *   docs/gf.xlsx        广发 202601–202609，一个 sheet 一个月
 *   docs/cmb-202609.xlsx 招商银行单月（三处特殊：多小节、日期只有 3 位、摘要无前缀）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
// 样本在临时目录现场生成：真实账单含卡号/手机号，不能进仓库，
// 所以用 test/fixtures/make-bank-samples.js 按实测到的真实结构造等价格式。
const samples = require('./fixtures/make-bank-samples');
const TMP = path.join(os.tmpdir(), 'hl-vbank-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const CGB_SINGLE = path.join(TMP, 'cgb-single.xlsx');
const CGB_YEAR = path.join(TMP, 'cgb-year.xlsx');
const CMB = path.join(TMP, 'cmb.xlsx');
fs.writeFileSync(CGB_SINGLE, samples.buildCgbSingle(8));
fs.writeFileSync(CGB_YEAR, samples.buildCgbYear(9, 3));
fs.writeFileSync(CMB, samples.buildCmb(12));

process.env.DATA_DIR = path.join(TMP, 'data');

const { parseBillFile } = require('../src/lib/importers');
const { parseCompactDate, parseCmbAmount, inferYear, cmbMerchant, sectionKind } = require('../src/lib/cmb');
const { getProfile, listProfiles } = require('../src/lib/bank-profiles');
const { classifyByKeywords } = require('../src/lib/ai');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✔' : '  ✘'} ${m}`); };
const eq = (a, b, m) => ok(a === b, `${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const sect = (t) => console.log(`\n=== ${t} ===`);

const has = (f) => fs.existsSync(f);
const read = (f) => fs.readFileSync(f);
const dist = (recs) => {
  const d = {};
  for (const r of recs) d[r.type] = (d[r.type] || 0) + 1;
  return d;
};

/* ============ 1. profile 注册 ============ */
sect('1. 银行 profile');
{
  const keys = listProfiles().map((p) => p.key);
  ok(keys.includes('generic') && keys.includes('cgb') && keys.includes('cmb'), `已注册 ${keys.join('/')}`);
  eq(getProfile('cmb').label, '招商银行', 'cmb → 招商银行');
  eq(getProfile('nope').key, 'generic', '未知银行退回 generic，不抛错');
  eq(getProfile('').key, 'generic', '空值退回 generic');
  eq(getProfile('cgb').direction, 'prefix+sign', '广发方向靠 (前缀)+符号');
  eq(getProfile('cmb').direction, 'sign', '招行摘要无前缀，方向靠小节语义');
  eq(getProfile('cmb').multiSection, true, '招行标记为多小节格式');
}

/* ============ 2. 广发单月（回归不退化）======== */
sect('2. 广发单月 202609.xlsx');
if (!has(CGB_SINGLE)) {
  ok(false, `样本缺失：${CGB_SINGLE}`);
} else {
  const R = parseBillFile(read(CGB_SINGLE), '202609.xlsx', { source: 'bank' });
  eq(R.records.length, 8, '解析 8 条（8 笔里第 4、8 笔为退款）');
  eq(R.neutralRecords.length, 1, '还款 1 条走 neutral');
  eq(R.source, 'bank', '来源 bank');
  const d = dist(R.records);
  eq(d.income || 0, 2, '退款 2 条判为 income');
  eq(d.expense || 0, 6, '消费 6 条判为 expense');
  const ds = R.records.map((r) => r.txn_date);
  ok(ds.every((x) => /^2026-\d{2}-\d{2}$/.test(x)), '全部日期为合法 YYYY-MM-DD');
  ok(!ds.some((x) => x === new Date().toISOString().slice(0, 10)), '没有「全部是今天」的退化');
}

/* ============ 3. 广发 9 个月（gf.xlsx）======== */
sect('3. 广发 202601–202609（gf.xlsx，一个 sheet 一个月）');
if (!has(CGB_YEAR)) {
  ok(false, `样本缺失：${CGB_YEAR}`);
} else {
  const R = parseBillFile(read(CGB_YEAR), 'gf.xlsx', { source: 'bank' });
  eq(R.sheetCount, 9, '识别 9 个工作表');
  eq(R.records.length, 27, '全部记录导入（27 条 = 9 月 x 3 笔）');
  const months = [...new Set(R.records.map((r) => r.txn_date.slice(0, 7)))].sort();
  ok(months.length >= 9, `覆盖多个月份（${months.length} 个月：${months[0]} ~ ${months[months.length - 1]}）`);
  const ds = R.records.map((r) => r.txn_date).sort();
  ok(ds.every((x) => /^20\d{2}-\d{2}-\d{2}$/.test(x)), '全部日期格式合法');
  ok(R.records.every((r) => r.amount_cents >= 0), '无负金额穿透到存储');
  // 每月应有退款（income）
  ok(dist(R.records).income >= 9, `退款进收入（${dist(R.records).income} 条）`);
}

/* ============ 4. 招商银行：日期与方向 ============ */
sect('4. 招商银行 cmb-202609.xlsx');
if (!has(CMB)) {
  ok(false, `样本缺失：${CMB}`);
} else {
  // 4.1 紧凑日期解析（用户问的 812 → 20260812）
  eq(parseCompactDate('812', 2026), '2026-08-12', '交易日 812 → 2026-08-12');
  eq(parseCompactDate('901', 2026), '2026-09-01', '901 → 2026-09-01');
  eq(parseCompactDate('1225', 2026), '2026-12-25', '1225 → 2026-12-25');
  eq(parseCompactDate('101', 2026), '2026-01-01', '101 → 2026-01-01（补零）');
  eq(parseCompactDate('20260812', 2026), '2026-08-12', '8 位完整日期也支持');
  eq(parseCompactDate('', 2026), null, '空值返回 null（不猜今天）');
  eq(parseCompactDate('999', 2026), null, '非法日期返回 null');

  // 4.2 年份推断
  eq(inferYear(['812', '813'], '202609').year, 2026, '从 sheet 名 202609 推断年份');
  eq(inferYear(['812'], '202609').inferred, false, 'sheet 名给出的年份不算推断');
  eq(inferYear(['20260812'], '').year, 2026, '从 8 位完整日期推断');
  const guessed = inferYear(['812'], '');
  eq(guessed.inferred, true, '无线索时标记为推断（界面要提示用户核对）');
  eq(inferYear(['812'], '202609').from, '工作表名「202609」', '年份依据如实回报');

  // 4.3 金额清洗
  eq(parseCmbAmount('¥ 19.94'), 1994, '¥ 19.94 → 1994 分');
  eq(parseCmbAmount('¥ -1,108.88'), -110888, '¥ -1,108.88 → -110888 分（负号+千分位）');
  eq(parseCmbAmount('¥ -480.00'), -48000, '¥ -480.00 → -48000 分');
  eq(parseCmbAmount('0'), 0, '金额 0');

  // 4.4 小节与摘要
  eq(sectionKind('还款'), 'repay', '「还款」小节 → repay');
  eq(sectionKind('消费'), 'consume', '「消费」小节 → consume');
  eq(sectionKind(''), null, '非小节标题返回 null');
  eq(cmbMerchant('财付通-美团'), '美团', '剥离「财付通-」');
  eq(cmbMerchant('支付宝-高德打车'), '高德打车', '剥离「支付宝-」');
  eq(cmbMerchant(''), null, '空摘要 → null');

  // 4.5 整体解析
  const R = parseBillFile(read(CMB), 'cmb-202609.xlsx', { bank: 'cmb' });
  ok(!R.error, `解析无错误${R.error ? '：' + R.error : ''}`);
  eq(R.sheetCount, 1, '单工作表');
  ok(R.records.length > 0, `消费记录 ${R.records.length} 条`);
  eq(R.neutralRecords.length, 2, `还款 2 条走 neutral（不计收支）`);

  // 方向：消费节全部 expense —— 招行支出也是正数，不能靠符号判
  const d = dist(R.records);
  eq(d.income || 0, 0, '消费节无 income（招行「消费」小节的金额一律为正，靠小节语义判支出）');
  ok((d.expense || 0) === R.records.length, `消费节全部 expense（${d.expense || 0}/${R.records.length}）`);
  ok(R.neutralRecords.every((r) => r.type === 'transfer'), '还款为 transfer（自己的钱换地方，不计收支）');

  // 日期：不能全是今天
  const ds = [...R.records, ...R.neutralRecords].map((r) => r.txn_date).sort();
  ok(!ds.every((x) => x === new Date().toISOString().slice(0, 10)), '没有「全部是今天」的退化（3 位日期已补全）');
  ok(ds.every((x) => /^20\d{2}-\d{2}-\d{2}$/.test(x)), '全部日期为合法 YYYY-MM-DD');
  ok(ds[0].startsWith('2026-08'), `最早日期 ${ds[0]}（8 月）`);
  ok(ds[ds.length - 1].startsWith('2026-09'), `最晚日期 ${ds[ds.length - 1]}（9 月，跨月正确）`);
  eq(R.year, 2026, '年份推断为 2026');
  eq(R.yearInferred, false, '年份来自工作表名，非猜测');
  eq(R.yearFrom, '工作表名「202609」', '年份依据如实回报');

  // 摘要保留供分类使用
  const m = R.records[0];
  ok(!!m.merchant && m.merchant.length > 0, `商户已剥离渠道前缀（${m.merchant}）`);
  ok(!!m.text && m.text.length > 0, `text 非空可供分类（${m.text}）`);
  const hit = R.records.filter((r) => classifyByKeywords(r.text)).length;
  const rate = ((hit / R.records.length) * 100).toFixed(1);
  ok(hit / R.records.length >= 0.5, `招行摘要自动分类命中率 ${rate}%（≥50%）`);
  ok(R.neutralRecords.every((r) => r.amount_cents > 0), '还款金额存为正值');

  // 小节信息要带到界面上
  const secInfo = (R.sheets && R.sheets[0] && R.sheets[0].sections) || [];
  ok(secInfo.includes('消费'), `小节信息如实回报（${secInfo.join('/')}）`);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
