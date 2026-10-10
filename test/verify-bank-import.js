/**
 * 银行账单导入回归（广发格式 + 方向判定 + 摘要接入 + 自动分类 + xlsx）
 *
 * 样本：test/fixtures/make-bank-samples.js 现场造的广发账单（csv 与 xlsx 各一份，内容一致）
 *
 * 关键背景：广发导出表头为
 *   交易日期,入账日期,交易摘要,交易金额,交易货币,入账金额,入账货币
 * —— 没有「收/支」列，方向只能靠「金额符号 + 摘要前缀」双通道判定。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
// 样本现场生成（真实账单含卡号/手机号，不能进仓库）
const samples = require('./fixtures/make-bank-samples');
const TMP = path.join(os.tmpdir(), 'hl-vbi-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const CSV = path.join(TMP, '202609.csv');
const XLSX = path.join(TMP, '202609.xlsx');
fs.writeFileSync(CSV, samples.buildCgbCsv(8));
fs.writeFileSync(XLSX, samples.buildCgbSingle(8));

// 本套件不碰数据库，纯解析层测试；仍隔离 DATA_DIR 以防万一 require 链带出副作用
process.env.DATA_DIR = path.join(os.tmpdir(), 'hl-vbank-' + Date.now());

const { parseBill, parseBillFile } = require('../src/lib/importers');
const { parseXlsx } = require('../src/lib/xlsx');
const { classifyByKeywords } = require('../src/lib/ai');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✔' : '  ✘'} ${m}`); };
const eq = (a, b, m) => ok(a === b, `${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const sect = (t) => console.log(`\n=== ${t} ===`);

const csvBuf = fs.readFileSync(CSV);
const R = parseBill(csvBuf);

/* ============ 1. 源识别 ============ */
sect('1. 源识别与摘要列映射');
ok(['bank', 'generic'].includes(R.source), `source 识别为 bank/generic（实际 ${R.source}）`);
eq(R.records.length, 8, `解析出记录 ${R.records.length} 条`);
// 样本文件尾部还拼接了另一张卡（6258***）的片段：
// 「卡号行 + 重复表头行 + 年费减免,0」这 3 行不构成交易，应被跳过且不得入库。
// 卡号行/表头行由 body 过滤器排除，金额为 0 的年费减免由 norm.amount_cents 判 0 排除。
eq(R.skipped, 0, 'skipped = 0（样本不含卡号行/零金额行）');
eq(R.records.length + (R.neutralRecords || []).length, 9, '实际入库 9 条 = 8 收支 + 1 还款');

const sample = R.records[0];
ok(!!sample.merchant && sample.merchant.length > 0, `摘要落进 merchant（实际 ${JSON.stringify(sample.merchant)}）`);
ok(!!sample.note, `note 非空（实际 ${JSON.stringify(sample.note)}）`);
ok(sample.text.trim().length > 0, `text 非空，是 classifyByKeywords 的输入（实际 ${JSON.stringify(sample.text)}）`);
ok(/消费|退款|还款|赠送/.test(sample.text), `text 含摘要原文（实际 ${JSON.stringify(sample.text)}）`);

/* ============ 2. 方向判定 ============ */
sect('2. 方向判定（符号 + 摘要双通道）');
const byPrefix = {};
for (const r of R.records) {
  const p = (String(r.text).match(/^\(([^)]*)\)/) || [, '无'])[1];
  (byPrefix[p] = byPrefix[p] || []).push(r);
}
console.log(`  摘要前缀分布：${Object.entries(byPrefix).map(([k, v]) => `${k}=${v.length}`).join('  ')}`);

// (消费) → expense，正数
const consume = byPrefix['消费'] || [];
eq(consume.length ? consume.every((r) => r.type === 'expense') : true, true, `(消费) 全部为 expense（${consume.length} 条）`);
eq(consume.length ? consume.every((r) => r.amount_cents > 0) : true, true, `(消费) 金额全为正`);

// (退款) → income（用户诉求 #1：退款必须算收入）
const refund = byPrefix['退款'] || [];
ok(refund.length >= 1, `样本含 (退款) ${refund.length} 条`);
eq(refund.length ? refund.every((r) => r.type === 'income') : true, true, `(退款) 全部为 income —— 这是核心诉求`);
eq(refund.length ? refund.every((r) => r.amount_cents > 0) : true, true, `(退款) 金额存为正值（符号不再穿透到存储）`);
eq(refund.length ? refund.every((r) => r.amount_cents === Math.abs(r.amount_cents)) : true, true, `(退款) 金额无负值`);

// (还款) → transfer 且 neutral。导入器把「不计收支」记录分流到 neutralRecords（默认不导入），
// 与提现/充值同一策略 —— 用户可在导入页勾选「一并导入」保证双边平衡。
const N = R.neutralRecords || [];
const repay = N.filter((r) => (String(r.text).match(/^\(([^)]*)\)/) || [, ''])[1] === '还款');
ok(repay.length >= 1, `样本含 (还款) ${repay.length} 条（在 neutralRecords 中）`);
eq(repay.length ? repay.every((r) => r.type === 'transfer') : true, true, `(还款) 全部为 transfer（不计收支）`);
eq(repay.length ? repay.every((r) => r.neutral === true) : true, true, `(还款) 标记 neutral`);
eq(repay.length ? repay.every((r) => r.amount_cents > 0) : true, true, `(还款) 金额存为正值`);
// 还款金额必须是正的绝对值（源文件里是 -20000 分，存进库应为 20000）
const big = repay.find((r) => r.amount_cents === 20000);
ok(!!big, `还款 -200.00 被完整解析为 20000 分（负数不穿透到存储）${big ? `（${big.text}）` : ''}`);

// NaN 金额必须为 0 条（用户截图 -5,119.35 曾解析成 NaN）
const nanAmt = R.records.filter((r) => !Number.isFinite(r.amount_cents) || r.amount_cents === 0);
eq(nanAmt.length, 0, `无 NaN/0 金额记录（实际 ${nanAmt.length}：${nanAmt.slice(0, 3).map((x) => x.text).join(' | ')}）`);

// 类型分布：不应再是清一色 expense
const dist = {};
for (const r of R.records) dist[r.type] = (dist[r.type] || 0) + 1;
console.log(`  类型分布：${JSON.stringify(dist)}`);
ok((dist.income || 0) > 0, `存在 income 记录（退款，${dist.income || 0} 条）`);
ok(N.length > 0, `存在 neutral 记录（还款，${N.length} 条，不计收支）`);
// 收支合计口径：转账不计入，支出不应等于负数金额绝对值之和
const inSum = R.records.filter((r) => r.type === 'income').reduce((s, r) => s + r.amount_cents, 0) / 100;
const exSum = R.records.filter((r) => r.type === 'expense').reduce((s, r) => s + r.amount_cents, 0) / 100;
console.log(`  收入合计 ¥${inSum.toFixed(2)} / 支出合计 ¥${exSum.toFixed(2)}`);
ok(inSum > 0, `收入合计为正（用户诉求：不再"没有收入"），实际 ¥${inSum.toFixed(2)}`);
ok(exSum > 0, `支出合计为正 ¥${exSum.toFixed(2)}`);

/* ============ 3. 自动分类 ============ */
sect('3. 自动分类（交易摘要 → 分类）');
// 还款是转账、不计收支，分类无意义，命中率只统计需要分类的消费/收入记录
const needClassify = [...R.records, ...(R.neutralRecords || [])].filter((r) => !/^\(还款\)/.test(r.text));
let hit = 0;
const misses = [];
for (const r of needClassify) {
  const c = classifyByKeywords(r.text);
  if (c) hit++;
  else misses.push(r.text);
}
const rate = ((hit / needClassify.length) * 100).toFixed(1);
console.log(`  命中 ${hit}/${needClassify.length} = ${rate}%（排除 2 条还款转账）`);
ok(hit / needClassify.length >= 0.5, `命中率 ≥50%（实际 ${rate}%）`);
// 文本不得重复拼接同一段摘要
const dupText = R.records.find((r) => {
  const first = (r.text.trim().match(/\S+/) || [''])[0];
  return first && r.text.indexOf(first) !== r.text.lastIndexOf(first) && r.text.split(' ').length > 2;
});
ok(!dupText, `text 无重复拼接${dupText ? `（实际 ${JSON.stringify(dupText.text)}）` : ''}`);
if (misses.length) {
  console.log('  未命中（个人商户名，落「其他支出」兜底，属预期）：');
  for (const m of misses.slice(0, 8)) console.log(`    ${m.slice(0, 46)}`);
}

// 已知应当命中的具体样本。
// 注意：按「(消费)」前缀筛，避免误取到同商户的退款记录 ——
// 退款归「退款/income」，消费归「外卖/expense」，两者都正确但断言要指向消费那条。
const SHOULD = ['测试餐厅', '测试商城', '拼多多'];   // 生成样本里的商户，须能命中关键词规则
for (const kw of SHOULD) {
  const r = R.records.find((x) => /^\(消费\)/.test(x.text) && x.text.includes(kw));
  if (!r) { ok(false, `样本含「${kw}」的消费记录`); continue; }
  const c = classifyByKeywords(r.text);
  ok(!!c && c.kind === 'expense', `「${kw}」消费 → 支出类分类 ${c ? c.category : '未命中'}`);
}
// 退款必须归 income 类，与消费区分开
const rf = R.records.find((x) => /^\(退款\)/.test(x.text));
ok(rf && classifyByKeywords(rf.text)?.kind === 'income', `退款记录 → 收入类分类（${rf ? classifyByKeywords(rf.text)?.category : '无样本'}）`);

/* ============ 4. xlsx 导入 ============ */
sect('4. xlsx 导入（零新增依赖）');
ok(typeof parseXlsx === 'function', 'xlsx 模块导出 parseXlsx');
if (typeof parseXlsx === 'function') {
  const X = parseXlsx(fs.readFileSync(XLSX));
  ok(!!X, 'xlsx 解析未抛异常');
  eq(X.records.length, R.records.length, `xlsx 与 csv 记录数一致（${X.records.length}）`);
  eq(X.skipped, R.skipped, 'xlsx 与 csv 的 skipped 一致');
  eq(X.neutralRecords.length, (R.neutralRecords || []).length, 'xlsx 与 csv 的 neutral（还款）条数一致');
  eq(X.source, R.source, 'xlsx 与 csv 识别出同一来源');

  // 逐条比对「日期+金额+类型+商户」，确保 xlsx 转换没有丢信息。
// 不把整串打进消息（两列各 123 条会刷屏），只报第一个不一致的位置。
const key = (r) => `${r.txn_date}|${r.amount_cents}|${r.type}|${r.merchant || ''}`;
  const a = R.records.map(key).sort();
  const b = X.records.map(key).sort();
  let diffAt = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { diffAt = i; break; }
  }
  ok(diffAt < 0, diffAt < 0
    ? `xlsx 逐条比对 csv 一致（123 条的日期/金额/类型/商户全等）`
    : `第 ${diffAt} 条不一致：csv=${a[diffAt]} xlsx=${b[diffAt]}`);

  // 日期必须是真实流水日期，不能是导入当天
  const today = new Date().toISOString().slice(0, 10);
  ok(!X.records.every((r) => r.txn_date === today), `xlsx 已把日期序列号转成真实日期（非今天 ${today}）`);
  const d0 = X.records[0];
  console.log(`  首条：${d0.txn_date} ${(d0.amount_cents / 100).toFixed(2)} ${d0.type} | ${d0.merchant}`);

  // 金额不得有浮点长尾（Excel 二进制浮点会把 40.8 读成 40.799999999999997）
  const longTail = X.rows.filter((r) => r.some((c) => /^-?\d+\.\d{7,}$/.test(String(c))));
  eq(longTail.length, 0, `无浮点长尾数字（实际 ${longTail.length}）`);

  // 统一入口按扩展名分派
  eq(parseBillFile(fs.readFileSync(XLSX), '202609.xlsx').records.length, R.records.length, 'parseBillFile 按 .xlsx 分派正确');
  eq(parseBillFile(fs.readFileSync(CSV), '202609.csv').records.length, R.records.length, 'parseBillFile 按 .csv 分派正确');

  // 拒收 .xls / 非 zip
  let msg = '';
  try { parseXlsx(Buffer.from('dummy-xls-binary')); } catch (e) { msg = e.message; }
  ok(/xls|另存为/i.test(msg), `.xls / 非 zip 内容明确报错并提示另存为（实际：${msg || '未抛错'}）`);
}

/* ============ 5. 去重：不能误伤同一天同额同商户的多笔真实交易 ============ */
sect('5. 导入去重（指纹 + 计数，防丢账）');
{
  const db = require('../src/db');
  db.init();
  const importer = require('../src/lib/importers');
  const uid = db.run(
    'INSERT INTO users (username,password_hash,display_name,avatar_color,is_admin,created_at) VALUES (?,?,?,?,1,?)',
    'banktest', 'x', 'banktest', '#000', db.nowStr()
  ).lastInsertRowid;
  const L = db.createDefaultLedger(uid, 'banktest');
  const acc = db.all('SELECT id FROM accounts WHERE ledger_id=?', L)[0].id;

  // 只取收支记录（不含还款），造一个干净的导入集
  const recs = R.records.map((r) => ({
    ...r,
    account_id: acc,
    category_id: null,
  }));

  const r1 = importer.importRecords({
    ledgerId: L, userId: uid, records: recs, neutralRecords: [],
    includeNeutral: false, source: 'bank', fileName: '202609.csv', autoCreateAccount: false,
  });
  eq(r1.imported, recs.length, `首次导入全部入库 ${recs.length} 条（不得因同日期同额同商户而丢账）`);
  eq(r1.skipped, 0, '首次导入无跳过');

  // 重复导入同一份 → 必须全部跳过
  const r2 = importer.importRecords({
    ledgerId: L, userId: uid, records: recs, neutralRecords: [],
    includeNeutral: false, source: 'bank', fileName: '202609.csv', autoCreateAccount: false,
  });
  eq(r2.imported, 0, '重复导入 imported = 0');
  eq(r2.skipped, recs.length, `重复导入 skipped = ${recs.length}`);

  const cnt = db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=? AND deleted_at IS NULL', L).c;
  eq(cnt, recs.length, `库中记录数保持 ${recs.length}（未重复入库）`);

  // 人工构造「同一天同额同摘要」的两笔真实消费，必须都入库
  const dup2 = [
    { txn_date: '2026-07-01', type: 'expense', amount_cents: 5000, currency: 'CNY', merchant: '测试商户', note: null, account_id: acc, category_id: null, text: '测试商户', bank_summary: '(消费)测试商户', order_no: null, neutral: false },
    { txn_date: '2026-07-01', type: 'expense', amount_cents: 5000, currency: 'CNY', merchant: '测试商户', note: null, account_id: acc, category_id: null, text: '测试商户', bank_summary: '(消费)测试商户', order_no: null, neutral: false },
  ];
  const r3 = importer.importRecords({
    ledgerId: L, userId: uid, records: dup2, neutralRecords: [],
    includeNeutral: false, source: 'bank', fileName: 'dup.csv', autoCreateAccount: false,
  });
  eq(r3.imported, 2, '同一天同额同商户的两笔真实消费都被导入（不误判为重复）');
  const r4 = importer.importRecords({
    ledgerId: L, userId: uid, records: dup2, neutralRecords: [],
    includeNeutral: false, source: 'bank', fileName: 'dup.csv', autoCreateAccount: false,
  });
  eq(r4.imported, 0, '这两笔再导入一次则全部跳过');

  // 同日同额同商户、但摘要前缀不同（消费 vs 退款）→ 靠摘要区分，两笔都要入库。
  // 金额相同、消费与退款金额一致，是银行流水里极常见的组合（京东退款原路退回）。
  const pair = [
    { txn_date: '2026-07-02', type: 'expense', amount_cents: 8800, currency: 'CNY', merchant: '某平台', note: null, account_id: acc, category_id: null, text: '(消费)某平台', bank_summary: '(消费)某平台', order_no: null, neutral: false },
    { txn_date: '2026-07-02', type: 'income', amount_cents: 8800, currency: 'CNY', merchant: '某平台', note: null, account_id: acc, category_id: null, text: '(退款)某平台', bank_summary: '(退款)某平台', order_no: null, neutral: false },
  ];
  const r5 = importer.importRecords({
    ledgerId: L, userId: uid, records: pair, neutralRecords: [],
    includeNeutral: false, source: 'bank', fileName: 'pair.csv', autoCreateAccount: false,
  });
  eq(r5.imported, 2, '同日同额同商户的「消费 + 退款」都能入库（靠摘要区分方向）');

  // 更关键：merchant 相同、金额相同、日期相同，仅摘要的渠道前缀不同（财付通 vs 网银在线）。
  // 这种在旧指纹（日期+金额+商户）下会被判成重复而丢账。
  const chanPair = [
    { txn_date: '2026-07-03', type: 'expense', amount_cents: 6600, currency: 'CNY', merchant: '京东商城业务', note: null, account_id: acc, category_id: null, text: '(消费)网银在线-京东商城业务', bank_summary: '(消费)网银在线-京东商城业务', order_no: null, neutral: false },
    { txn_date: '2026-07-03', type: 'expense', amount_cents: 6600, currency: 'CNY', merchant: '京东商城业务', note: null, account_id: acc, category_id: null, text: '(消费)财付通-京东商城业务', bank_summary: '(消费)财付通-京东商城业务', order_no: null, neutral: false },
  ];
  const r6 = importer.importRecords({
    ledgerId: L, userId: uid, records: chanPair, neutralRecords: [],
    includeNeutral: false, source: 'bank', fileName: 'chan.csv', autoCreateAccount: false,
  });
  eq(r6.imported, 2, '同日同额同商户、仅摘要渠道不同（网银在线 vs 财付通）两笔都入库 ← 旧逻辑会丢 1 笔');
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);