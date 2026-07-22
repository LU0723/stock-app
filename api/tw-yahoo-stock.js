// Vercel Serverless Function
// Taiwan intraday quotes from Yahoo Finance chart API.
//
// GET /api/tw-yahoo-stock?symbols=2330,00631L
// Returns { [symbol]: { name, price, yesterdayClose, marketState, strictPrice } }

function normalizeSymbol(symbol) {
  return String(symbol ?? '').trim().toUpperCase()
}

function buildMissing(symbol) {
  return {
    name: symbol,
    price: null,
    yesterdayClose: 0,
    basePrice: 0,
    limitUp: null,
    limitDown: null,
    marketState: 'UNKNOWN',
    yahooSymbol: null,
    priceSource: 'yahoo-none',
    strictPrice: true,
  }
}

function getTaiwanTick(price) {
  if (price < 10) return 0.01
  if (price < 50) return 0.05
  if (price < 100) return 0.1
  if (price < 500) return 0.5
  if (price < 1000) return 1
  return 5
}

function roundToTick(price, direction) {
  if (!(price > 0)) return null
  const tick = getTaiwanTick(price)
  const scaled = price / tick
  const rounded = direction === 'up'
    ? Math.floor(scaled + 1e-8)
    : Math.ceil(scaled - 1e-8)
  return Number((rounded * tick).toFixed(2))
}

function calculateTaiwanLimits(previousClose) {
  if (!(previousClose > 0)) return { limitUp: null, limitDown: null }
  return {
    limitUp: roundToTick(previousClose * 1.1, 'up'),
    limitDown: roundToTick(previousClose * 0.9, 'down'),
  }
}

async function fetchYahooSymbol(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m`
  const upstream = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  })
  if (!upstream.ok) return null

  const json = await upstream.json()
  const result = json?.chart?.result?.[0]
  const meta = result?.meta
  if (!meta) return null

  const price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : null
  const previousClose = typeof meta.previousClose === 'number'
    ? meta.previousClose
    : (typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : 0)
  const { limitUp, limitDown } = calculateTaiwanLimits(previousClose)

  return {
    name: meta.shortName || meta.longName || yahooSymbol,
    price,
    yesterdayClose: previousClose,
    basePrice: previousClose,
    limitUp,
    limitDown,
    marketState: meta.marketState || 'UNKNOWN',
    yahooSymbol,
    priceSource: price === null ? 'yahoo-none' : 'yahoo',
    strictPrice: true,
  }
}

async function fetchTaiwanSymbol(symbol) {
  for (const suffix of ['TW', 'TWO']) {
    const data = await fetchYahooSymbol(`${symbol}.${suffix}`)
    if (data) return { ...data, name: data.name === `${symbol}.${suffix}` ? symbol : data.name }
  }
  return buildMissing(symbol)
}

export default async function handler(req, res) {
  const { symbols } = req.query
  if (!symbols) {
    return res.status(400).json({ error: 'missing symbols parameter' })
  }

  const syms = symbols
    .split(',')
    .map(normalizeSymbol)
    .filter(Boolean)
    .slice(0, 30)

  const results = {}

  await Promise.all(
    syms.map(async (sym) => {
      try {
        results[sym] = await fetchTaiwanSymbol(sym)
      } catch {
        results[sym] = buildMissing(sym)
      }
    })
  )

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json(results)
}
