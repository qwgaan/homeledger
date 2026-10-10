/**
 * 复现测试（红）：验证 P0 三条缺陷。
 * 用法：node test/verify-txn-scheduler.js
 * 约定：起独立 DATA_DIR，直接调 lib 层，不依赖 HTTP。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-vts-'));
process.env.DATA_DIR = DIR;

const db = require('../src/db');
const txn = require('../src/lib/txn');
const sch = require('../src/lib/scheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✔' : '  ✘'} ${m}`); };
const eq = (a, b, m) => ok(a === b, `${m}（期望 ${b}，实际 ${a}）`);

db.init();

// 建两个用户，用来验证 user_id 归属
const mk = (name) => db.run(
  'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
  name, 'x', name, '#000', db.nowStr()
).lastInsertRowid;
const uidA = mk('alice'), uidB = mk('bob');
const ledgerId = db.createDefaultLedger(uidA, 'alice');
const accId = db.all('SELECT id FROM accounts WHERE ledger_id=?', ledgerId)[0].id;
const catId = db.get("SELECT id FROM categories WHERE name='午餐' AND kind='expense'").id;

const mkTxn = (cents, date = '2026-10-01', userId = uidA) => txn.createTransaction(ledgerId, userId, {
  type: 'expense', amount_cents: cents, account_id: accId, txn_date: date,
});

/* ============ 缺陷 1：嵌套事务 ============ */
console.log('\n[缺陷1] db.tx() 重入 —— 批量删除 / 批量报销');
{
  const ids = [mkTxn(1000), mkTxn(2000), mkTxn(3000)];
  eq(db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=? AND deleted_at IS NULL', ledgerId).c, 3, '前置：3 笔在库');

  let err = null, n = null;
  try { n = txn.bulkDelete(ids, ledgerId); } catch (e) { err = e.message; }
  ok(!err, `bulkDelete 不抛异常${err ? `（实际抛：${err}）` : ''}`);
  eq(n, 3, 'bulkDelete 返回删除数 3');
  eq(db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=? AND deleted_at IS NULL', ledgerId).c, 0, '软删除后无残留');
  eq(db.get('SELECT balance_cents FROM accounts WHERE id=?', accId).balance_cents, 0, '余额被重算回 0');

  // 批量报销
  const r1 = mkTxn(5000, '2026-10-02'), r2 = mkTxn(7000, '2026-10-02');
  let rerr = null, res = null;
  try { res = txn.markReimbursed([r1, r2], ledgerId, uidA, accId); } catch (e) { rerr = e.message; }
  ok(!rerr, `markReimbursed 不抛异常${rerr ? `（实际抛：${rerr}）` : ''}`);
  eq(res && res.count, 2, '报销覆盖 2 笔');
  eq(res && res.total, 12000, '报销入账金额 = 5000+7000');
  eq(db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=? AND deleted_at IS NULL AND type=?', ledgerId, 'reimburse').c, 1, '生成 1 笔报销入账');
  eq(db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=? AND is_reimbursable=1 AND reimbursed_at IS NOT NULL', ledgerId).c, 0, '原 2 笔已标记（基线为 0 可报销标记）');

  // 清理：把报销入账删掉，恢复干净基线
  db.run("UPDATE transactions SET deleted_at=? WHERE type='reimburse'", db.nowStr());
  db.recalcBalances(ledgerId);
}

/* ============ 缺陷 2：周期账单非自动模式重复记账 ============ */
console.log('\n[缺陷2] 周期账单 —— 只提醒模式不应重复记账，且不得写库');
{
  // 用 planning.js 的真实 payload 形状：{ items:[...], user_id }
  const payload = JSON.stringify({ items: [{ type: 'expense', amount_cents: 8000, account_id: accId, note: '房租' }], user_id: uidA });
  db.run(
    `INSERT INTO recurring_rules (ledger_id,name,payload,frequency,interval_n,day_of_month,next_run_at,auto_post,is_active,created_at)
     VALUES (?,?,?,'monthly',1,1,'2026-10-01',0,1,?)`,
    ledgerId, '只提醒的房租', payload, db.nowStr()
  );
  const ruleId = db.get("SELECT id FROM recurring_rules WHERE ledger_id=? AND name='只提醒的房租'", ledgerId).id;

  const before = db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=?', ledgerId).c;
  sch.runDueRecurring('2026-10-01');
  const after1 = db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=?', ledgerId).c;
  eq(after1, before, '只提醒模式：第一轮不应写入交易');

  sch.runDueRecurring('2026-10-01');   // 同一天再跑一次（模拟 30min 后兜底轮询）
  const after2 = db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=?', ledgerId).c;
  eq(after2, before, '只提醒模式：第二轮仍不应写入交易（不重复）');

  const r = db.get('SELECT next_run_at FROM recurring_rules WHERE id=?', ruleId);
  ok(r.next_run_at > '2026-10-01', `只提醒模式：next_run_at 已推进到下一期（实际 ${r.next_run_at}）`);

  // 自动模式：应写入且推进
  db.run(
    `INSERT INTO recurring_rules (ledger_id,name,payload,frequency,interval_n,day_of_month,next_run_at,auto_post,is_active,created_at)
     VALUES (?,?,?,'monthly',1,1,'2026-10-01',1,1,?)`,
    ledgerId, '自动的房租', payload, db.nowStr()
  );
  const autoId = db.get("SELECT id FROM recurring_rules WHERE ledger_id=? AND name='自动的房租'", ledgerId).id;
  const b2 = db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=?', ledgerId).c;
  sch.runDueRecurring('2026-10-01');
  const a2 = db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=?', ledgerId).c;
  eq(a2 - b2, 1, '自动模式：写入 1 笔');
  const r2 = db.get('SELECT next_run_at FROM recurring_rules WHERE id=?', autoId);
  ok(r2.next_run_at > '2026-10-01', `自动模式：next_run_at 已推进（实际 ${r2.next_run_at}）`);
  sch.runDueRecurring('2026-10-01');
  eq(db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=?', ledgerId).c, a2, '自动模式：同一天重跑不重复写入');
}

/* ============ 缺陷 3：记账人归属 ============ */
console.log('\n[缺陷3] 周期账单记账人 —— 必须记到创建者名下，不是恒 user_id=1');
{
  eq(db.tableColumns('recurring_rules').includes('created_by_user_id'), true, 'recurring_rules 表有 created_by_user_id 列');

  const payload = JSON.stringify([{ type: 'expense', amount_cents: 6600, account_id: accId }]);
  // 由 bob（uidB=2）创建一条自动模式规则
  db.run(
    `INSERT INTO recurring_rules (ledger_id,name,payload,frequency,interval_n,day_of_month,next_run_at,auto_post,is_active,created_by_user_id,created_at)
     VALUES (?,?,?,'monthly',1,1,'2026-10-01',1,1,?,?)`,
    ledgerId, 'bob的规则', payload, uidB, db.nowStr()
  );
  sch.runDueRecurring('2026-10-01');
  const t = db.get("SELECT user_id FROM transactions WHERE ledger_id=? AND note IS NULL AND source='recurring' ORDER BY id DESC LIMIT 1", ledgerId)
    || db.get("SELECT user_id FROM transactions WHERE ledger_id=? AND source='recurring' ORDER BY id DESC LIMIT 1", ledgerId);
  eq(Number(t.user_id), Number(uidB), `生成的交易 user_id = 创建者 ${uidB}（实际 ${t.user_id}）`);
}

/* ============ 顺带核验：scheduler 的 payload 形状兼容 ============ */
console.log('\n[附] payload 形状兼容 —— planning.js 存的 {items:[...]} 形状要能跑');
{
  // 用一个独立账本，避免前面规则的 next_run_at 落在同一天造成干扰
  const L2 = db.createDefaultLedger(uidA, 'compat');
  const acc2 = db.all('SELECT id FROM accounts WHERE ledger_id=?', L2)[0].id;
  const payload = JSON.stringify({ items: [{ type: 'expense', amount_cents: 1234, account_id: acc2, note: '兼容测试' }], user_id: uidA });
  db.run(
    `INSERT INTO recurring_rules (ledger_id,name,payload,frequency,interval_n,day_of_month,next_run_at,auto_post,is_active,created_at)
     VALUES (?,?,?,'monthly',1,1,'2026-11-01',1,1,?)`,
    L2, '兼容形状', payload, db.nowStr()
  );
  const b = db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=?', L2).c;
  sch.runDueRecurring('2026-11-01');   // 注意：调度器是全局的，会扫所有账本，故只断言本账本
  const a = db.get('SELECT COUNT(*) c FROM transactions WHERE ledger_id=?', L2).c;
  eq(a - b, 1, '{items:[...]} 形状能正确展开成 1 笔（planning.js 实际写入的就是这个形状）');
  const row = db.get("SELECT amount_base_cents, user_id FROM transactions WHERE ledger_id=? AND note='兼容测试'", L2);
  eq(Number(row && row.amount_base_cents), 1234, '金额取自 items[0].amount_cents');
  eq(Number(row && row.user_id), Number(uidA), '记账人取自 payload.user_id');
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
try { db.db.close(); } catch { /* ignore */ }
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
