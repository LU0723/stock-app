// Vercel Serverless Function
// 代理 TWSE STOCK_DAY 歷史日資料，解決瀏覽器 CORS 限制
//
// 用法：GET /api/tw-history?stockNo=0050&yyyymm=202604
// 回傳：TWSE STOCK_DAY 原始 JSON（含 stat, fields, data 陣列）
//
// 注意：僅支援 TWSE 上市股票（TSE）；上櫃股票（OTC）需另行擴充

export default async function handler(req, res) {
  const { stockNo, yyyymm } = req.query

  if (!stockNo || !yyyymm) {
    return res.status(400).json({ error: 'missing stockNo or yyyymm' })
  }

  // STOCK_DAY 以月為單位，date 傳該月任一日（慣例用 01）
  const date = `${yyyymm}01`
  const url =
    `https://www.twse.com.tw/exchangeReport/STOCK_DAY` +
    `?response=json&date=${date}&stockNo=${encodeURIComponent(stockNo)}`

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.twse.com.tw',
      },
    })

    if (!upstream.ok) {
      return res.status(502).json({ error: `TWSE API 回應錯誤：${upstream.status}` })
    }

    const data = await upstream.json()

    // 歷史月份可長期快取；當月每天有新增，快取 1hr 即可
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600')
    return res.status(200).json(data)
  } catch (err) {
    console.error('[api/tw-history] 抓取失敗：', err.message)
    return res.status(502).json({ error: err.message })
  }
}
