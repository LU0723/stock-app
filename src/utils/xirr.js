/**
 * calculateXIRR(payments, guessRate?)
 *
 * payments: Array of { date: 'YYYY-MM-DD', amount: number }
 *   - amount < 0 → cash going OUT (e.g. 入金：你把錢投入，對帳戶是流出)
 *   - amount > 0 → cash coming IN  (e.g. 出金、已實現損益、期末資產)
 *
 * Returns annualized rate as decimal (e.g. 0.1245 = 12.45%)
 * Returns null if calculation fails or input is insufficient.
 *
 * Algorithm: Newton-Raphson, max 100 iterations, tolerance 1e-6
 */
export function calculateXIRR(payments, guessRate = 0.1) {
  if (!Array.isArray(payments) || payments.length < 2) return null

  // Parse and validate
  const parsed = payments.map(p => ({
    days: 0,
    amount: Number(p.amount),
    date: new Date(p.date),
  }))

  // Sort by date
  parsed.sort((a, b) => a.date - b.date)

  const t0 = parsed[0].date.getTime()
  for (const p of parsed) {
    p.days = (p.date.getTime() - t0) / 86400000  // ms → days
  }

  // Must have at least one negative and one positive amount
  const hasNeg = parsed.some(p => p.amount < 0)
  const hasPos = parsed.some(p => p.amount > 0)
  if (!hasNeg || !hasPos) return null

  // NPV at rate r: Σ Ci / (1+r)^(ti/365)
  function npv(r) {
    let sum = 0
    for (const p of parsed) {
      sum += p.amount / Math.pow(1 + r, p.days / 365)
    }
    return sum
  }

  // Derivative of NPV: Σ -Ci * (ti/365) / (1+r)^(ti/365 + 1)
  function dnpv(r) {
    let sum = 0
    for (const p of parsed) {
      const exp = p.days / 365
      sum -= (exp * p.amount) / Math.pow(1 + r, exp + 1)
    }
    return sum
  }

  let r = guessRate
  for (let i = 0; i < 100; i++) {
    const f  = npv(r)
    const df = dnpv(r)
    if (!isFinite(f) || !isFinite(df) || Math.abs(df) < 1e-10) break
    const delta = f / df
    r = r - delta
    if (!isFinite(r) || r <= -1) return null
    if (Math.abs(delta) < 1e-6) return r
  }

  return null
}
