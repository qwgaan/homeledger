'use strict';
/**
 * 回归：导入时指定目标账户（HTTP 端到端）
 *
 * 背景：银行账单摘要里没有账户信息，导入时若不指定账户，程序只能靠 ensureAccount
 * 兜底猜测并**自动新建账户** —— 实测导致 1295 笔广发流水全部落到「储蓄卡」上，
 * 广发信用卡余额恒为 0。本套件锁死「用户指定的账户说了算」这条契约。
 *
 * 需先在 8099 起隔离实例（run-all.js 负责）：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify-runall node server.js
 *
 * 运行：node test/verify-import-account.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = 'http://127.0.0.1:8099';
const ROOT = path.join(__dirname, '..');
const samples = require('./fixtures/make-bank-samples');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
const sect = (t) => console.log(`\n=== ${t} ===`);

let jar = '';
async function req(method, p, { form, json, headers = {}, cookie } = {}) {
  const h = { ...headers };
  h.cookie = cookie || jar;
  let body;
  if (form) { h['content-type'] = h['content-type'] || 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  else if (json !== undefined) {
    h['content-type'] = 'application/json';
    // JSON 请求体不是表单，CSRF 中间件读不到 _csrf 字段 → 必须走 x-csrf-token 头，
    // 否则会被当成跨站请求直接 403（页面拿到的是 HTML，JSON.parse 会炸）
    if (csrf) h['x-csrf-token'] = csrf;
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual' });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length && !cookie) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), location: res.headers.get('location'), setCookie: sc };
}

let csrf = '';
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

/** 从 /transactions 页面按账户名抓「该账户下的流水条数」 */
async function accountTxnCount(cookie, accountName) {
  const r = await req('GET', '/transactions?account_id&page=1', { cookie });
  return r.text;
}

(async () => {
  console.log('\n=== 导入指定目标账户（HTTP 端到端）===\n');

  /* ---------- 登录 ---------- */
  let r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  const cookie = loginRes.setCookie.map((c) => c.split(';')[0]).join('; ');

  /* ---------- 导入页渲染出账户下拉 ---------- */
  sect('1. 导入页账户选择器');
  r = await req('GET', '/import', { cookie });
  check('导入页可访问', r.status === 200, `HTTP ${r.status}`);
  csrf = csrfOf(r.text);   // JSON 接口要带 x-csrf-token
  check('取得 CSRF 令牌', !!csrf);
  check('存在「导入到账户」下拉', r.text.includes('id="import-account"'));
  check('下拉含「＋ 新建账户…」选项', r.text.includes('__new__'));
  check('下拉含「按摘要自动判断」默认项', r.text.includes('按摘要自动判断'));
  check('存在新建账户输入框', r.text.includes('id="import-account-new"'));
  const importCsrf = csrfOf(r.text);

  /* ---------- 未指定账户时，银行账单要给出警告 ---------- */
  sect('2. 未指定账户的告警');
  const csv = samples.buildCgbCsv(6);
  const dataUrl = 'data:text/csv;base64,' + Buffer.from(csv, 'utf8').toString('base64');
  r = await req('POST', '/api/import/preview', {
    cookie, json: { dataUrl, fileName: 'cgb.csv', sourceHint: 'bank', bankHint: 'cgb' },
  });
  const prev0 = JSON.parse(r.text);
  check('预览成功', prev0.ok === true, r.text.slice(0, 160));
  check('预览回传账户列表', Array.isArray(prev0.accounts) && prev0.accounts.length > 0, `accounts=${(prev0.accounts || []).length}`);
  check('未指定时 targetAccountId 为空', !prev0.targetAccountId, String(prev0.targetAccountId));
  check('银行账单解析为 bank 来源', prev0.source === 'bank', prev0.source);

  /* ---------- 新建账户并导入 → 全部落到该账户 ---------- */
  sect('3. 新建账户并导入');
  r = await req('POST', '/api/import/preview', {
    cookie, json: { dataUrl, fileName: 'cgb.csv', sourceHint: 'bank', bankHint: 'cgb' },
  });
  const prevNew = JSON.parse(r.text);
  check('第二次预览成功（取 token）', prevNew.ok === true, r.text.slice(0, 160));

  r = await req('POST', '/api/import/commit', {
    cookie, json: { token: prevNew.token, new_account_name: '广发信用卡', auto_create_account: true },
  });
  const commitNew = JSON.parse(r.text);
  check('新建账户导入成功', commitNew.ok === true, r.text.slice(0, 200));
  check('导入条数与解析条数一致', commitNew.imported === prevNew.count, `${commitNew.imported} vs ${prevNew.count}`);

  /* ---------- 校验账户类型推断：广发信用卡必须是 credit ---------- */
  sect('4. 账户类型推断');
  r = await req('GET', '/accounts', { cookie });
  check('账户页可访问', r.status === 200, `HTTP ${r.status}`);
  // 直接读库核对类型最可靠：页面会按类型分组折叠渲染，grep 名字容易漏。
  // DATA_DIR 由 run-all 传绝对路径；本地手动跑可能是相对路径，这里统一转绝对。
  const dataDir = process.env.DATA_DIR
    ? path.resolve(ROOT, process.env.DATA_DIR)
    : path.join(ROOT, 'data');
  const dbPath = path.join(dataDir, 'homeledger.db');
  let accRow = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    accRow = db.prepare('SELECT id, name, type FROM accounts WHERE name = ?').get('广发信用卡');
    db.close();
  } catch (e) {
    check('读取数据库核对账户类型', false, `${dbPath}: ${e.message}`);
  }
  check('「广发信用卡」账户已创建', !!accRow, accRow ? `id=${accRow.id}` : '未找到');
  check('「广发信用卡」类型为 credit（非 debit）', !!(accRow && accRow.type === 'credit'),
    `${accRow ? accRow.type : '未找到'}（旧逻辑 /银行|卡/ 会抢先判成 debit → 钱记到储蓄卡）`);

  /* ---------- 指定已有账户导入 → 覆盖自动判断 ---------- */
  sect('5. 指定已有账户覆盖猜测');
  // 取「广发信用卡」的账户 id（用 /import 页面下拉）
  r = await req('GET', '/import', { cookie });
  const optSel = r.text.slice(r.text.indexOf('id="import-account"'));
  check('新建的账户带信用卡图标（💳）', /💳\s*广发信用卡\s*</.test(optSel), '下拉项应带 💳');
  check('「信用卡」与「广发信用卡」是两个独立账户（未被模糊匹配吞并）',
    /💳\s*信用卡\s*</.test(optSel) && /💳\s*广发信用卡\s*</.test(optSel),
    'resolveAccountId 的双向包含曾让「广发信用卡」直接复用「信用卡」');
  const optMatch = optSel.match(/value="(\d+)"[^>]*>[^<]*广发信用卡/);
  check('导入页下拉能列出刚建的账户', !!optMatch, optMatch ? `id=${optMatch[1]}` : '未匹配到');
  const gfaId = optMatch ? Number(optMatch[1]) : null;

  // 换一份内容不同的账单，避免被去重逻辑跳过。
  // ⚠️ 去重指纹是「日期+金额+商家+摘要」，只改月份不够 —— 同一套样本在两轮之间
  // 会有完全相同的行。这里连商户名一起扰动，保证第二次导入不会被误判成重复。
  const stamp = String(Date.now() % 100000);
  const csv2 = samples.buildCgbCsv(5)
    .replace(/2026\/09\//g, '2026/11/')
    .replace(/测试/g, '测试' + stamp);
  const dataUrl2 = 'data:text/csv;base64,' + Buffer.from(csv2, 'utf8').toString('base64');
  r = await req('POST', '/api/import/preview', {
    cookie, json: { dataUrl: dataUrl2, fileName: 'cgb-2.csv', sourceHint: 'bank', bankHint: 'cgb', targetAccountId: gfaId },
  });
  const prevSpec = JSON.parse(r.text);
  check('指定账户后预览成功', prevSpec.ok === true, r.text.slice(0, 160));
  check('预览回传 targetAccountId', Number(prevSpec.targetAccountId) === gfaId, `${prevSpec.targetAccountId} vs ${gfaId}`);

  r = await req('POST', '/api/import/commit', {
    cookie, json: { token: prevSpec.token, target_account_id: gfaId, auto_create_account: true },
  });
  const commitSpec = JSON.parse(r.text);
  check('指定账户导入成功', commitSpec.ok === true && commitSpec.imported > 0, `imported=${commitSpec.imported}`);
  check('返回的 targetAccountId 正确', Number(commitSpec.targetAccountId) === gfaId, String(commitSpec.targetAccountId));

  /* ---------- 非法账户 id 必须被拒 ---------- */
  sect('6. 非法账户防护');
  r = await req('POST', '/api/import/preview', {
    cookie, json: { dataUrl, fileName: 'cgb.csv', sourceHint: 'bank', bankHint: 'cgb' },
  });
  const prevBad = JSON.parse(r.text);
  r = await req('POST', '/api/import/commit', {
    cookie, json: { token: prevBad.token, target_account_id: 999999 },
  });
  const badCommit = JSON.parse(r.text);
  check('不存在的账户 id 被拒绝', badCommit.ok === false, JSON.stringify(badCommit).slice(0, 160));

  /* ---------- 必须落库到指定账户（查账户余额/流水） ---------- */
  sect('7. 落库校验');
  r = await req('GET', '/accounts', { cookie });
  // 广发信用卡应有非零流水（导入进去的钱）
  const gfaIdx = r.text.indexOf('广发信用卡');
  const gfaBlock = gfaIdx >= 0 ? r.text.slice(gfaIdx, gfaIdx + 600) : '';
  const hasFlow = !/近30天\s*0\.00\s*\/\s*0\.00/.test(gfaBlock);
  check('广发信用卡有流水记录（不再是 0.00/0.00）', hasFlow, hasFlow ? '有流水' : '仍为空');

  // 导出 CSV 校验账户名落到了「广发信用卡」
  r = await req('GET', '/export/csv', { cookie });
  const csvOut = r.text;
  check('导出的流水含广发信用卡账户名', csvOut.includes('广发信用卡'), csvOut.slice(0, 60));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
