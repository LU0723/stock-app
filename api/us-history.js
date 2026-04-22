// Vercel Serverless Function
// 代理 Yahoo Finance 美股每日歷史收盤價，解決瀏覽器 CORS 限制
//
// 用法：GET /api/us-history?symbol=AAPL
// 回傳：[{ date: 'YYYY-MM-DD', close: number }] 由早到晚排序，近 1 年資料
//
// Yahoo Finance v8 chart API：range=1y&interval=1d
//   result[0].timestamp       → Unix 秒時間戳陣列
//   result[0].indicators.quote[0].close → 收盤價陣列（可含 null）
//
// Cache 策略：Vercel Edge 15 分鐘（日線資料每天只更新一次，15min 夠用）

const CACHE_TTL_MS = 15 * 60 * 1000   // 15 分鐘

// { [symbol]: { data: [{date, close}], expiresAt: number } }
const memCache = new Map()

export default async function handler(req, res) {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'missing symbol' })

  const sym = symbol.trim().toUpperCase()

  const cached = memCache.get(sym)
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=900')
    return res.status(200).json(cached.data)
  }

  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
      `?range=1y&interval=1d`

    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    })

    if (!upstream.ok) {
      return res.status(502).json({ error: `Yahoo Finance 回應錯誤：${upstream.status}` })
    }

    const data = await upstream.json()
    const result = data?.chart?.result?.[0]
    if (!result) {
      return res.status(200).json([])
    }

    const timestamps = result.timestamp ?? []
    const closes     = result.indicators?.quote?.[0]?.close ?? []

    const rows = []
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i]
      if (close == null || isNaN(close)) continue
      // Yahoo Finance 美股日線時間戳為 ET 午夜；轉 UTC ISO 取前 10 碼即為正確日期
      const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
      rows.push({ date, close })
    }
    rows.sort((a, b) => a.date.localeCompare(b.date))

    memCache.set(sym, { data: rows, expiresAt: Date.now() + CACHE_TTL_MS })

    res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=900')
    return res.status(200).json(rows)
  } catch (err) {
    console.error('[api/us-history]', err.message)
    return res.status(502).json({ error: err.message })
  }
}
