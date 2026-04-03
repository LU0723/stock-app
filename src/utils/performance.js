/**
 * performance.js
 *
 * 月報酬 / 累積報酬計算工具
 *
 * 資料結構：
 *   ledger = { "YYYY-MM": { cashflows: [...], snapshot: { tw: {...}, us: {...} } } }
 *
 * 現金流符號規則（與 XIRR 一致）：
 *   入金（投入）→ 對投資人是支出，使帳戶資產增加
 *   出金（提出）→ 對投資人是收入，使帳戶資產減少
 *   已實現損益  → 屬於帳戶內部，已反映在 totalAssets，不計入外部現金流
 */

/**
 * 依 ledgerType 過濾 cashflows
 *   tw：包含無 ledgerType 的舊資料或明確標記 tw
 *   us：只包含明確標記 us
 */
function filterCfs(cashflows, ledgerType) {
  if (ledgerType === 'tw') {
    return cashflows.filter(cf => !cf.ledgerType || cf.ledgerType === 'tw')
  }
  return cashflows.filter(cf => cf.ledgerType === ledgerType)
}

/**
 * getMonthlyReturns(ledger, ledgerType)
 *
 * 對指定帳本（'tw' 或 'us'）計算每個有 snapshot 月份的月報酬率。
 *
 * 計算公式（簡化版 Modified Dietz）：
 *   netCashIn  = Σ 入金 - Σ 出金  （該月外部淨現金流入）
 *   monthReturn = (endAssets - startAssets - netCashIn) / startAssets
 *
 * startAssets = 前一個有效 snapshot 的 totalAssets（月初資產）
 * endAssets   = 本月 snapshot 的 totalAssets（月末資產）
 *
 * 若 startAssets <= 0 或找不到前一月 snapshot → returnRate = null
 *
 * @returns Array<{ month, returnRate, endAssets, startAssets, netCashIn }>
 *   已按月份升序排列。returnRate 為 null 代表資料不足，UI 顯示 --。
 */
export function getMonthlyReturns(ledger, ledgerType) {
  const months = Object.keys(ledger).sort()
  const result = []

  for (let i = 0; i < months.length; i++) {
    const month = months[i]
    const data  = ledger[month]
    const snap  = data?.snapshot
    const endAssets = snap?.[ledgerType]?.totalAssets ?? 0

    // 本月必須有該帳本的有效 snapshot 才進入列表
    if (!(endAssets > 0)) continue

    // 往前找最近一個有效 snapshot 作為月初資產
    let startAssets = null
    for (let j = i - 1; j >= 0; j--) {
      const prevSnap  = ledger[months[j]]?.snapshot
      const prevAssets = prevSnap?.[ledgerType]?.totalAssets ?? 0
      if (prevAssets > 0) {
        startAssets = prevAssets
        break
      }
    }

    // 當月外部淨現金流入（入金 - 出金，不含已實現損益）
    const cfs = filterCfs(
      Array.isArray(data?.cashflows) ? data.cashflows : [],
      ledgerType
    )
    const netCashIn = cfs.reduce((sum, cf) => {
      if (cf.type === '入金') return sum + Math.abs(Number(cf.amount))
      if (cf.type === '出金') return sum - Math.abs(Number(cf.amount))
      return sum
    }, 0)

    // 計算月報酬
    let returnRate = null
    if (startAssets !== null && startAssets > 0) {
      const r = (endAssets - startAssets - netCashIn) / startAssets
      if (Number.isFinite(r)) returnRate = r
    }

    result.push({ month, returnRate, endAssets, startAssets, netCashIn })
  }

  return result
}

/**
 * getCumulativeReturn(monthlyReturns)
 *
 * 用月報酬連乘推算累積報酬：
 *   (1 + r1) * (1 + r2) * ... * (1 + rN) - 1
 *
 * 只使用 returnRate !== null 的月份。
 * @returns number | null
 */
export function getCumulativeReturn(monthlyReturns) {
  const valid = monthlyReturns.filter(m => m.returnRate !== null)
  if (valid.length === 0) return null
  let cum = 1
  for (const m of valid) cum *= (1 + m.returnRate)
  const result = cum - 1
  return Number.isFinite(result) ? result : null
}
