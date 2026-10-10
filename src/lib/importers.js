'use strict';
/**
 * 账单导入 / 导出
 *  - 支付宝账单 CSV（GBK 编码，含表头说明行）
 *  - 微信支付账单 CSV（UTF-8）
 *  - 通用 CSV（按表头智能匹配）
 * 自动识别编码、自动映射分类与账户、自动去重
 */
const { all, get, run, tx, nowStr, todayStr, recalcBalances } = require('../db');
const { parseAmountToCents, monthOf } = require('./util');
const { classifyByKeywords, guessAccountName, resolveCategoryId, resolveAccountId } = require('./ai');

/* ------------------------------- 编码与 CSV ------------------------------- */

/** 支付宝导出为 GBK，微信为 UTF-8：先按 UTF-8 解，出现替换字符则按 GBK 重解 */
function decodeBuffer(buf) {
  const tryDecode = (enc) => {
    try { return new TextDecoder(enc, { fatal: false }).decode(buf); } catch { return null; }
  };
  const utf8 = tryDecode('utf-8');
  if (utf8 && !utf8.includes('\uFFFD')) return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  const gbk = tryDecode('gbk') || tryDecode('gb18030');
  if (gbk) return { text: gbk.replace(/^\uFEFF/, ''), encoding: 'gbk' };
  return { text: utf8 || '', encoding: 'utf-8' };
}

/** 支持引号包裹与转义的 CSV 行解析 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map(parseCsvLine);
}

const HEADER_KEYS = ['交易时间', '交易分类', '交易类型', '金额', '收/支', '收/付款方式', '支付方式', '日期', '时间', '交易摘要', '摘要', 'amount', 'date'];

function isHeaderRow(cells) {
  const joined = cells.join(',');
  return HEADER_KEYS.some((k) => joined.includes(k)) && cells.length >= 4;
}

/** 表头名 → 索引（支持模糊） */
function headerIndex(header, candidates) {
  for (const c of candidates) {
    const i = header.findIndex((h) => h === c);
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const i = header.findIndex((h) => h && h.includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 识别账单来源。
 * 银行流水（广发/招行/工行等导出格式）与支付宝/微信差别很大：没有「收/支」列，
 * 交易信息集中在「交易摘要」一列里，表头形如
 *   交易日期,入账日期,交易摘要,交易金额,交易货币,入账金额,入账货币
 *
 * 判定顺序很重要：银行流水里也会出现「支付宝」（如「(消费)支付宝-…」），
 * 所以必须先按表头结构判银行，再轮到支付宝/微信的全文关键字，否则会被误判成 alipay。
 */
function detectSource(headerLine, fullText) {
  const h = headerLine.join(',');
  // 1) 银行流水：摘要列 + （交易金额 或 借方/贷方发生额），或「入账日期」这类银行专有表头
  const hasSummary = /摘要/.test(h);
  const hasAmount = /交易金额|入账金额|发生额|收入金额|支出金额/.test(h);
  if (hasSummary && hasAmount) return 'bank';
  if (/^(入账日期|记账日期)/.test(h) && /金额/.test(h)) return 'bank';
  // 2) 支付宝/微信：靠交易分类列或正文关键字
  if (h.includes('交易分类') || /支付宝/.test(fullText.slice(0, 2000))) return 'alipay';
  if (h.includes('交易类型') || h.includes('当前状态') || /微信/.test(fullText.slice(0, 2000))) return 'wechat';
  return 'generic';
}

/* ------------------------------- 单条规范化 ------------------------------- */

const SKIP_STATUS = /已关闭|交易关闭|已退款|全额退款|退款成功|失败|已撤销|已取消|待付款|待收货|银行处理中|已退回/;

/**
 * 银行流水的摘要前缀 → 记账类型。
 * 银行导出习惯用括号标注交易性质，这是比「收/支」列更可靠的方向来源：
 *   (消费) → 支出；(退款) → 收入；(还款) → 转账（自己的钱换地方，不计收支）
 */
const BANK_PREFIX_TYPE = {
  消费: 'expense', 消费: 'expense', 支出: 'expense', 付款: 'expense', 借记: 'expense',
  退款: 'income', 退货: 'income', 退汇: 'income', 冲正: 'income', 贷记: 'income', 收入: 'income',
  还款: 'transfer', 转账: 'transfer', 汇款: 'transfer', 预借现金: 'transfer', 存款: 'transfer',
  利息: 'income', 返现: 'income', 赠送: 'income', 减免: 'income', 工资: 'income', 代发: 'income',
};

/** 从银行摘要里取出括号前缀，如「(消费)财付通-美团」→「消费」 */
function bankPrefix(summary) {
  const m = /^\s*[（(]\s*([^）)]+?)\s*[）)]/.exec(String(summary || ''));
  return m ? m[1] : '';
}

/**
 * 银行流水方向判定：以「金额符号」为主、「摘要前缀」为辅。
 *
 * 符号优先的原因：银行流水里负数几乎必然是钱流出（消费/还款/退款都是负的），
 * 这是账务真相，比文本推断可靠。只有符号缺失（如工行那种只给绝对值）才退到前缀判定。
 *
 * 注意：金额统一存绝对值，方向由 type 决定 —— 避免负数穿透到存储层造成统计错乱。
 */
function bankDirection(summary, amountCents) {
  const prefix = bankPrefix(summary);
  const byPrefix = BANK_PREFIX_TYPE[prefix] || null;
  if (amountCents < 0) {
    // 流出。退款类虽为负数，但性质是钱回来了 → 记收入
    if (byPrefix === 'income') return { type: 'income', neutral: false };
    if (byPrefix === 'transfer') return { type: 'transfer', neutral: true };
    return { type: 'expense', neutral: false };
  }
  // 流入
  if (byPrefix === 'expense') return { type: 'expense', neutral: false };
  if (byPrefix === 'transfer') return { type: 'transfer', neutral: true };
  return { type: 'income', neutral: false };
}

/**
 * 归一化单行。
 * @param {boolean} isBank 银行流水走「符号 + 摘要前缀」双通道，支付宝/微信仍按「收/支」列
 */
function normalizeRow({ date, direction, amountText, merchant, desc, categoryText, accountText, status, orderNo, summary, isBank }) {
  const rawCents = parseAmountToCents(amountText);
  const amountCents = Math.abs(rawCents);
  if (isBank) {
    // 银行流水的全部信息都在摘要列里：iDesc 与 iMerchant 会命中同一列（headerIndex 模糊匹配的必然结果），
    // 这里按「摘要优先」取值并去重，避免 text 拼出两遍同一串。
    const summaryText = String(summary || '').trim();
    const merchantText = String(merchant || '').trim();
    const extra = merchantText && merchantText !== summaryText ? merchantText : '';
    const text = [summaryText, extra, desc === summary ? '' : desc, categoryText]
      .filter(Boolean).join(' ').trim();
    const dir = bankDirection(summaryText, rawCents);
    return {
      skip: false,
      neutral: dir.neutral,
      type: dir.type,
      amount_cents: amountCents,
      txn_date: normalizeDate(date),
      merchant: bankMerchant(summaryText, merchantText),
      note: [summaryText, desc === summaryText ? '' : desc, status].filter(Boolean).join(' · ').slice(0, 200) || null,
      category_hint: null,      // 银行流水没有交易分类列，分类交给关键词规则
      text,
      account_hint: accountText || null,   // 银行流水来自同一张卡，不按摘要猜账户
      order_no: orderNo || null,
      bank_summary: summaryText,           // 存进 ai_json 供去重指纹用
    };
  }
  const text = `${categoryText || ''} ${desc || ''} ${merchant || ''}`;
  const dir = String(direction || '').trim();
  let type = 'expense';
  let neutral = false;
  if (/不计/.test(dir)) {
    // 转账 / 提现 / 充值 等「不计收支」记录：默认不导入（成对记录只导一半会破坏余额）
    type = 'transfer';
    neutral = true;
  } else if (/收入|收/.test(dir)) type = 'income';
  else if (/支出|支/.test(dir)) type = 'expense';
  return {
    skip: false,
    neutral,
    type,
    amount_cents: amountCents,
    txn_date: normalizeDate(date),
    merchant: (merchant || desc || '').slice(0, 60) || null,
    note: [categoryText, desc, status].filter(Boolean).join(' · ').slice(0, 200) || null,
    category_hint: categoryText || null,
    text,
    account_hint: accountText || guessAccountName(text) || null,
    order_no: orderNo || null,
  };
}

/**
 * 从银行摘要里剥离「(消费)」这类前缀，得到纯商户名。
 * 「(消费)财付通-广东三元麦当劳食品有限公司」→「麦当劳 / 广东三元麦当劳食品有限公司」
 * 同时把渠道名（财付通/网银在线/支付宝/云闪付）也剥掉，便于后续按商户分类。
 */
function bankMerchant(summary, fallback) {
  let s = String(summary || '').replace(/^\s*[（(][^）)]+[）)]\s*/, '').trim();
  s = s.replace(/^(财付通|网银在线|银联在线|云闪付|支付宝|微信支付|财付通支付)[-－_]?\s*/, '');
  s = s.trim();
  if (!s) s = String(fallback || '').trim();
  return s ? s.slice(0, 60) : null;
}

function normalizeDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/(20\d{2})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](20\d{2})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return todayStr();
}

/* --------------------------------- 主解析器 -------------------------------- */

/**
 * 解析账单文件内容。
 * @param {Buffer} buffer CSV/xlsx 转换后的文本内容
 * @param {object|string} [opts] 传字符串时视为 { source: '...' }。
 *   source: 手工指定来源（'alipay' | 'wechat' | 'bank' | 'generic'），
 *           指定后跳过 detectSource 的猜测 —— 银行流水与支付宝流水表头相近时，
 *           自动识别可能误判，用户可在导入页手工指定以消除歧义。
 *           传 'auto'（或不传）表示仍由表头自动判断。
 */
const VALID_SOURCES = ['alipay', 'wechat', 'bank', 'generic'];
function parseBill(buffer, opts = {}) {
  const o = typeof opts === 'string' ? { source: opts } : (opts || {});
  // 只接受白名单里的来源；其它值（含 'auto'、拼错的）一律退回自动识别，
  // 免得前端传了个脏值就把整份账单的解析带偏
  const forced = VALID_SOURCES.includes(String(o.source || '')) ? String(o.source) : null;
  const { text, encoding } = decodeBuffer(buffer);
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex(isHeaderRow);
  if (headerIdx < 0) {
    return { source: forced || 'unknown', encoding, header: [], records: [], totalLines: rows.length, error: '未找到有效表头，请确认文件内容是否为交易明细账单' };
  }
  const header = rows[headerIdx];
  const detected = detectSource(header, text);
  const source = forced || detected;
  const body = rows.slice(headerIdx + 1).filter((r) => r.length > 2 && r.join('').replace(/[-,\s]/g, '').length > 0);

  const iDate = headerIndex(header, ['交易时间', '交易日期', '日期', '时间', 'date']);
  const iDir = headerIndex(header, ['收/支', '收支', '类型', '方向']);
  const iAmount = headerIndex(header, ['金额(元)', '金额', 'amount']);
  const iMerchant = headerIndex(header, ['交易对方', '对方', 'merchant', '商家']);
  // 摘要列：银行流水全靠这一列（(消费)财付通-美团 / (还款)跨行自动转账还款）。
  // 放在 iMerchant 之后算，但候选词排在前面，保证银行格式优先命中摘要。
  const iDesc = headerIndex(header, ['交易摘要', '摘要', '商品说明', '商品', '备注', '描述', '说明', 'note', 'detail']);
  const iCategory = headerIndex(header, ['交易分类', '分类', 'category']);
  const iAccount = headerIndex(header, ['收/付款方式', '支付方式', '付款方式', '账户', 'account']);
  const iStatus = headerIndex(header, ['当前状态', '交易状态', '状态', 'status']);
  const iOrder = headerIndex(header, ['交易订单号', '交易单号', '订单号', 'order']);
  // 银行流水走「符号 + 摘要」通道。判定看表头本身有没有「摘要/入账日期/发生额」这类
  // 银行专有列，而不是只看 source —— 这样用户手工指定来源时也不会走错分支。
  const headerJoined = header.join(',');
  const isBank = /摘要/.test(headerJoined)
    || /^(入账日期|记账日期)/.test(headerJoined)
    || /发生额|入账金额|收入金额|支出金额/.test(headerJoined);

  const records = [];
  const neutralRecords = []; // 提现 / 充值 / 还款等「不计收支」记录，默认不入库
  let skipped = 0;
  for (const r of body) {
    const status = iStatus >= 0 ? r[iStatus] : '';
    if (status && SKIP_STATUS.test(status)) { skipped++; continue; }
    const summary = isBank ? (iDesc >= 0 ? r[iDesc] : '') : '';
    const norm = normalizeRow({
      date: iDate >= 0 ? r[iDate] : '',
      direction: iDir >= 0 ? r[iDir] : '',
      amountText: iAmount >= 0 ? r[iAmount] : '',
      merchant: iMerchant >= 0 ? r[iMerchant] : '',
      // 银行流水的 desc 已在 summary 里，这里传空串避免 normalizeRow 里再拼一遍
      desc: isBank ? '' : (iDesc >= 0 ? r[iDesc] : ''),
      categoryText: iCategory >= 0 ? r[iCategory] : '',
      accountText: iAccount >= 0 ? r[iAccount] : '',
      status,
      orderNo: iOrder >= 0 ? r[iOrder] : '',
      summary,
      isBank,
    });
    if (norm.skip || !norm.amount_cents) { skipped++; continue; }
    if (norm.neutral) neutralRecords.push(norm);
    else records.push(norm);
  }
  return { source, detected, forced: !!forced, encoding, header, records, neutralRecords, totalLines: rows.length, skipped };
}

/* --------------------------------- 执行导入 -------------------------------- */

function ensureAccount(ledgerId, name, createdList) {
  if (!name) return null;
  const id = resolveAccountId(ledgerId, name);
  if (id) return id;
  const type = /信用/.test(name) ? 'credit' : /支付宝|微信|京东|云闪付/.test(name) ? 'virtual' : /银行|卡/.test(name) ? 'debit' : 'other';
  const icon = type === 'credit' ? '💳' : type === 'virtual' ? '📱' : type === 'debit' ? '🏦' : '📦';
  const r = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at)
     VALUES (?,?,?,?,?,0,0,999,?,?)`,
    ledgerId, String(name).slice(0, 30), type, icon, 'CNY', '由账单导入自动创建', nowStr()
  );
  createdList.push(name);
  return r.lastInsertRowid;
}

/** 「不计收支」记录（提现/充值）找不到对方账户时使用的兜底账户，保证转账双边平衡 */
const NEUTRAL_FALLBACK_ACCOUNT = '外部往来账户';

/**
 * 导入去重指纹。
 *
 * 银行流水里「同一天 + 同金额 + 同商户」的两笔真实交易非常常见（当天在麦当劳买两次、
 * 滴滴连打两单金额相同）。原先只靠这三项会把第二笔误判成重复而**丢账**。
 *
 * 银行摘要自带渠道与订单信息，所以把摘要一并纳入指纹：
 *   · 摘要不同（如「(消费)京东」vs「(退款)京东」）→ 天然区分，不会误判
 *   · 摘要也相同（同一天同额同商户的两次消费）→ 用 dupIndex 序号区分：
 *     库里已有几笔，本文件又出现几次，就放行几笔。真正重复导入同一份文件时，
 *     文件内的条数与库里已有条数相等，仍然会被正确去重。
 */
function dupFingerprint(txnDate, amountCents, merchant, bankSummary) {
  const base = `${txnDate}|${amountCents}|${merchant || ''}`;
  return bankSummary ? `${base}|${bankSummary}` : base;
}

/** 从已入库记录的 ai_json 里取回银行摘要（存导入时写入） */
function bankSummaryOf(aiJson) {
  if (!aiJson) return '';
  try {
    const o = JSON.parse(aiJson);
    return o.bank_summary || '';
  } catch {
    return '';
  }
}

/**
 * 把解析结果写入数据库
 * @param {object} o
 * @param {boolean} [o.includeNeutral] 是否同时导入「不计收支」记录（提现 / 充值等）
 * @returns {{imported:number, skipped:number, failed:number, createdAccounts:string[], jobId:number}}
 */
function importRecords({
  ledgerId, userId, records, neutralRecords = [], includeNeutral = false,
  source, fileName, autoCreateAccount = true, defaultAccountId = null,
}) {
  const createdAccounts = [];
  let imported = 0, skipped = 0, failed = 0;
  const list = includeNeutral ? records.concat(neutralRecords) : records.slice();
  // dupCount: 指纹 → 库中已存在的条数。
  // 预载已有记录指纹，避免重复导入；用计数而非布尔，才能支持「同一天同额同商户的多笔」。
  const dupCount = new Map();
  const dupUsed = new Map();   // 本次导入中，每个指纹已被消耗的次数
  const bump = (fp) => dupCount.set(fp, (dupCount.get(fp) || 0) + 1);
  for (const t of all(
    `SELECT t.txn_date, t.amount_base_cents, t.merchant, t.ai_json
     FROM transactions t
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.source = ?`,
    ledgerId, 'import'
  )) {
    bump(dupFingerprint(t.txn_date, t.amount_base_cents, t.merchant, bankSummaryOf(t.ai_json)));
  }

  tx(() => {
    for (const rec of list) {
      try {
        const fp = dupFingerprint(rec.txn_date, rec.amount_cents, rec.merchant, rec.bank_summary);
        // 库里该指纹已有 N 笔，本文件中该指纹出现到第 k 次（k 从 0 起）
        // → 第 k < N 次视为重复导入跳过；k >= N 视为新交易放行
        const seen = dupCount.get(fp) || 0;
        const used = dupUsed.get(fp) || 0;
        if (used < seen) { dupUsed.set(fp, used + 1); skipped++; continue; }
        dupUsed.set(fp, used + 1);

        let categoryId = null;
        let toAccountId = null;
        const accountId = autoCreateAccount
          ? ensureAccount(ledgerId, rec.account_hint, createdAccounts)
          : resolveAccountId(ledgerId, rec.account_hint) || defaultAccountId;

        if (rec.neutral) {
          // 提现 / 充值：账户之间搬钱，不计入收支。对方账户优先从说明文字推断
          const cpName = guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
          toAccountId = autoCreateAccount
            ? ensureAccount(ledgerId, cpName, createdAccounts) || ensureAccount(ledgerId, NEUTRAL_FALLBACK_ACCOUNT, createdAccounts)
            : resolveAccountId(ledgerId, cpName) || null;
        } else {
          const kind = rec.type === 'income' ? 'income' : 'expense';
          const kw = classifyByKeywords(rec.text);
          if (rec.category_hint) categoryId = resolveCategoryId(ledgerId, rec.category_hint, kind);
          if (!categoryId && kw) categoryId = resolveCategoryId(ledgerId, kw.category, kw.kind === 'income' ? 'income' : kind);
          if (!categoryId) categoryId = resolveCategoryId(ledgerId, kind === 'income' ? '其他收入' : '其他支出', kind);
        }

        run(
          `INSERT INTO transactions
           (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
            user_id, txn_date, note, merchant, status, source, ai_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ledgerId, rec.type, rec.amount_cents, 'CNY', 1, rec.amount_cents,
          accountId, toAccountId, categoryId, userId, rec.txn_date, rec.note, rec.merchant,
          'cleared', 'import', JSON.stringify({ source, order_no: rec.order_no, neutral: !!rec.neutral, bank_summary: rec.bank_summary || '' }),
          nowStr(), nowStr()
        );
        bump(fp);   // 记为已入库，后续同指纹的记录才能正确计数
        imported++;      } catch {
        failed++;
      }
    }
  });

  // 导入是直接写表，必须重算账户余额，否则余额与流水不一致
  if (imported > 0) recalcBalances(ledgerId);

  const job = run(
    `INSERT INTO import_jobs (ledger_id, user_id, source, file_name, total, imported, skipped, failed, status, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, userId, source, fileName, list.length, imported, skipped, failed, 'done',
    createdAccounts.length ? `自动创建账户：${createdAccounts.join('、')}` : null, nowStr()
  );
  return { imported, skipped, failed, createdAccounts, jobId: job.lastInsertRowid };
}

/* --------------------------------- 导出 ---------------------------------- */

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  // 加 BOM 让 Excel 正确识别 UTF-8
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

const EXPORT_HEADER = ['日期', '类型', '金额', '币种', '折算金额', '分类', '账户', '转入账户', '成员', '商家', '备注', '标签', '来源', '状态'];

function exportRows(ledgerId, rows) {
  return rows.map((t) => [
    t.txn_date, t.type_label || t.type, (t.amount_cents / 100).toFixed(2), t.currency,
    (t.amount_base_cents / 100).toFixed(2), t.category_path || '', t.account_name || '',
    t.to_account_name || '', t.member_name || '', t.merchant || '', t.note || '',
    t.tag_names || '', t.source, t.status,
  ]);
}

/**
 * 账单文件统一入口：按扩展名分派到 CSV / XLSX 解析。
 * @param {Buffer} buf 文件内容
 * @param {string} [fileName] 用于判断格式；不传时按内容嗅探
 * @param {object} [opts] { source, bank } source=来源；bank=银行 profile（cmb 走专用解析）
 */
function parseBillFile(buf, fileName = '', opts = {}) {
  const isXlsx = /\.xlsx$/i.test(String(fileName))
    || (buf[0] === 0x50 && buf[1] === 0x4b);   // PK 头 = zip 容器
  if (isXlsx) return require('./xlsx').parseXlsx(buf, opts);
  // 招行的专用解析目前只覆盖 xlsx；CSV 形态的招行账单先走通用逻辑
  if (opts.bank === 'cmb') delete opts.bank;
  return parseBill(buf, opts);
}

module.exports = {
  parseBill, parseBillFile, importRecords, toCsv, csvEscape, EXPORT_HEADER, exportRows,
  decodeBuffer, normalizeDate, bankPrefix, bankDirection, bankMerchant,
  BANK_PREFIX_TYPE,
};
