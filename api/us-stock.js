// Vercel Serverless Function
// 代理 Yahoo Finance 美股報價（約 15 分鐘延遲）
//
// 用法：GET /api/us-stock?symbols=AAPL,TSLA,NVDA
// 回傳：{ [symbol]: { name, price, previousClose, marketState } }
//
// ── 價格欄位說明 ──────────────────────────────────────────────────────────────
// Yahoo Finance v8 chart API 的 meta 物件中：
//   regularMarketPrice         → 正式盤最後成交價（非 pre/post market）
//                                 盤中：即時（~15min 延遲）
//                                 收盤後 / 盤前：維持上一個正式盤收盤價不變
//   previousClose              → 上一個正式盤收盤價（計算今日漲跌幅的基準）
//   chartPreviousClose         → 同上，通常與 previousClose 相同，作為備援
//   postMarketPrice / preMarketPrice → v8 chart API 不回傳此欄位（恆為空）
//   marketState                → v8 chart API 不回傳此欄位
//
// 因此本 API 永遠不會把盤前/盤後價格混入回傳值。
//
// marketState 由我們自行從 currentTradingPeriod 時間戳推算，回傳給前端顯示參考。
//
// ── Cache 策略 ────────────────────────────────────────────────────────────────
//   1. Module-level 記憶體 cache（TTL 60s，per symbol）
//   2. Cache-Control: s-maxage=60 讓 Vercel Edge Network 在 CDN 層快取

const CACHE_TTL_MS = 60_000 // 60 秒

// { [symbol]: { data: {...}, expiresAt: number } }
const memCache = new Map()

function getCached(sym) {
  const entry = memCache.get(sym)
  if (entry && Date.now() < entry.expiresAt) return entry.data
  return null
}

function setCache(sym, data) {
  memCache.set(sym, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

// 從 currentTradingPeriod 時間戳推算目前市場狀態
function deriveMarketState(tradingPeriod) {
  if (!tradingPeriod?.regular) return 'UNKNOWN'
  const now     = Math.floor(Date.now() / 1000)
  const { start, end } = tradingPeriod.regular
  if (now < start) return 'PRE'
  if (now <= end)  return 'REGULAR'
  return 'POST'
}

async function fetchSymbol(sym) {
  // range=1d&interval=1m：meta.previousClose 才會是前一個正式交易日收盤（今日漲跌基準）
  // range=5d&interval=1d 的 meta.previousClose 為 undefined，chartPreviousClose 為 5 天前收盤，不可用
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m`
  const upstream = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  })
  if (!upstream.ok) return null
  const data = await upstream.json()
  const result = data?.chart?.result?.[0]
  if (!result) return null
  const meta = result.meta

  // ── 主價格：只使用 regularMarketPrice，永不使用 pre/post market 價格 ──
  const price = (typeof meta.regularMarketPrice === 'number') ? meta.regularMarketPrice : null

  // ── 前日收盤：previousClose = 前一個正式交易日收盤（今日漲跌的正確基準）
  // chartPreviousClose = chart range 開始前的收盤（range=5d 即 5 個交易日前），不可用於今日漲跌計算
  // 若兩者皆無則回傳 null，前端收到 null 時隱藏今日漲跌 %，避免錯誤計算
  const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? null

  // ── 市場狀態：從 currentTradingPeriod 時間戳推算 ──
  const marketState = deriveMarketState(meta.currentTradingPeriod)

  return {
    name: meta.shortName || meta.longName || sym,
    price,
    previousClose,
    marketState,
    regularSessionEnd: meta.currentTradingPeriod?.regular?.end ?? null,
  }
}

export default async function handler(req, res) {
  const { symbols } = req.query

  if (!symbols) {
    return res.status(400).json({ error: 'missing symbols parameter' })
  }

  const syms = symbols
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20) // 安全限制

  const results = {}

  await Promise.all(
    syms.map(async (sym) => {
      try {
        // 優先從記憶體 cache 取
        const cached = getCached(sym)
        if (cached) {
          results[sym] = cached
          return
        }

        const data = await fetchSymbol(sym)
        if (!data) return

        setCache(sym, data)
        results[sym] = data
      } catch {
        // 單一股票失敗不影響其他股票
      }
    })
  )

  // s-maxage：Vercel Edge 快取 60 秒；stale-while-revalidate：過期後背景更新時仍可用舊資料
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30')
  return res.status(200).json(results)
}
