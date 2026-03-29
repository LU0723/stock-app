// Vercel Serverless Function
// 代理 TWSE MIS 即時股價 API，解決瀏覽器 CORS 限制
//
// 用法：GET /api/stock?ex_ch=tse_2330.tw|otc_00631L.tw|...
// 回傳：TWSE 原始 JSON（msgArray 陣列）

export default async function handler(req, res) {
  const { ex_ch } = req.query

  if (!ex_ch) {
    return res.status(400).json({ error: 'missing ex_ch parameter' })
  }

  const twseUrl =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` +
    `?ex_ch=${encodeURIComponent(ex_ch)}&json=1&delay=0`

  try {
    const upstream = await fetch(twseUrl, {
      headers: {
        // TWSE 需要 Referer，否則可能回傳空資料
        Referer: 'https://mis.twse.com.tw',
        'User-Agent': 'Mozilla/5.0',
      },
    })

    if (!upstream.ok) {
      return res.status(502).json({ error: `TWSE API 回應錯誤：${upstream.status}` })
    }

    const data = await upstream.json()

    // 不快取股價資料，確保每次都是即時資料
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(data)
  } catch (err) {
    console.error('[api/stock] 抓取失敗：', err.message)
    return res.status(502).json({ error: err.message })
  }
}
