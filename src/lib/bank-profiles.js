'use strict';
/**
 * 银行账单 profile
 *
 * 各家网银导出的表头、列名、日期格式差异很大，靠自动识别总会漏。与其猜，
 * 不如把「已知银行的格式」显式声明出来，让用户在导入页指定银行。
 *
 * 每个 profile 只需回答四个问题：
 *   1) 表头在哪一行（招行一个文件里有「还款」「消费」两个小节，各自带表头）
 *   2) 哪几列是什么（日期 / 金额 / 摘要 / 方向）
 *   3) 日期怎么解析（广发是 2026/9/20，招行只有 812 三个数字）
 *   4) 方向怎么判定（有无 (消费)/「收/支」列，还是只能靠金额正负）
 *
 * 未列出的银行走 `generic` profile —— 即原有的表头模糊匹配逻辑，
 * 也就是「广发实测可靠 + 结构留好」的那条中间路线。
 */

/** 通用：沿用原有的 headerIndex 模糊匹配（广发格式实测可靠） */
const genericProfile = {
  key: 'generic',
  label: '通用银行账单',
  // 表头行靠 isHeaderRow 特征匹配；日期/金额/摘要列靠候选词模糊匹配
  multiSection: false,
  date: 'auto',
  amount: 'auto',
  summary: 'auto',
  dirColumn: 'auto',
  /** 方向判定：广发有 (消费)/(退款)/(还款) 前缀 + 金额符号 */
  direction: 'prefix+sign',
};

/**
 * 招商银行
 *
 * 实测样本 cmb-202609.xlsx 的结构：
 *   第 1 行  B 列 = 「还款」        ← 小节标题
 *   第 2 行  D=829  E=一卡通转账还款  F=¥ -480.00   ← 还款明细（无表头）
 *   第 6 行  B 列 = 「消费」        ← 第二个小节
 *   第 7 行  C=交易日 D=记账日 E=交易摘要 F=人民币金额 G=卡号末四位 H=交易地
 *   第 8 行  C=812  D=813  E=财付通-雅爱肆店  F=¥ 19.94
 *
 * 三处与广发不同的硬差异：
 *   ① 日期只有 3 位数字（812 = 8月12日），**没有年份**
 *   ② 一个文件里有多个小节，各有小节标题，表头行位置不固定
 *   ③ 摘要没有 (消费) 前缀，方向只能靠金额正负
 */
const cmbProfile = {
  key: 'cmb',
  label: '招商银行',
  bankCode: 'cmb',
  /** 小节标题（B 列）→ 该小节的记账/类型语义 */
  sections: {
    还款: 'repay',
    消费: 'consume',
    收入: 'income',
    利息: 'interest',
    手续费: 'fee',
  },
  /** 找到这些词所在行即认为是表头行（每个小节各认一次） */
  headerAnchors: ['交易日', '交易摘要', '记账日'],
  multiSection: true,
  // 列名 → 该列承担的角色（小节内相对定位，兼容不同起始列）
  columns: {
    date: ['交易日'],
    postDate: ['记账日'],
    summary: ['交易摘要', '摘要'],
    amount: ['人民币金额', '金额'],
    dir: ['收/支', '收支'],
  },
  /**
   * 日期只有 MMDD 三位（如 812），年份从外部锚点推断：
   *   ① 优先用 sheet 名（招行年度账单每个 sheet 叫 202609）
   *   ② 其次用文件里出现的最完整日期（记账日可能是 4 位或带年份）
   *   ③ 都没有则退回导入当年，并在预览里明确提示年份来源不可靠
   */
  dateCompact: true,
  /** 摘要无 (消费) 前缀 → 方向只能靠金额符号：负数=流出，正数=流入 */
  direction: 'sign',
  /** 金额列带 ¥ 与千分位（¥ -1,108.88），需要清洗 */
  amountCleanup: true,
};

/** 广发：单表头、日期 2026/9/20、摘要带 (消费) 前缀 —— 走通用逻辑即可 */
const cgbProfile = { ...genericProfile, key: 'cgb', label: '广发银行' };

const PROFILES = {
  generic: genericProfile,
  cgb: cgbProfile,
  cmb: cmbProfile,
};

/** 导入页下拉用 */
function listProfiles() {
  return Object.values(PROFILES).map((p) => ({ key: p.key, label: p.label }));
}

/** 取 profile；未知 key 一律退回 generic，绝不抛错 */
function getProfile(key) {
  return PROFILES[String(key || '')] || genericProfile;
}

module.exports = {
  PROFILES, listProfiles, getProfile,
  genericProfile, cmbProfile, cgbProfile,
};
