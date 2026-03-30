import { useState, useEffect } from 'react'

// ─── 預設持股資料（localStorage 沒資料時才使用）──────────────────────────────

const DEFAULT_HOLDINGS = [
  { symbol: '0050', name: '元大台灣50', shares: 1000, avgCost: 75,   price: 0, yesterdayClose: 0 },
  { symbol: '2330', name: '台積電',     shares: 1000, avgCost: 1820, price: 0, yesterdayClose: 0 },
]

// ─── localStorage ────────────────────────────────────────────────────────────

const STORAGE_KEY   = 'stock-holdings'
const WATCHLIST_KEY = 'watchlist-stocks'

function loadHoldings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return DEFAULT_HOLDINGS
}

function saveHoldings(holdings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings))
}

function loadWatchlist() {
  try {
    const saved = localStorage.getItem(WATCHLIST_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return DEFAULT_WATCHLIST
}

function saveWatchlist(list) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list))
}

// ─── 共用股價 API ─────────────────────────────────────────────────────────────
//
// fetchStockMap(symbols) → { [symbol]: { name, price, yesterdayClose } }
// 可被庫存頁與自選股共用

async function fetchStockMap(symbols) {
  if (symbols.length === 0) return {}

  const exChList = symbols
    .flatMap(s => [`tse_${s}.tw`, `otc_${s}.tw`])
    .join('|')

  const url = `/api/stock?ex_ch=${exChList}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`API 錯誤：${res.status}`)

  const data  = await res.json()
  const items = data.msgArray ?? []

  const map = {}
  for (const item of items) {
    if (!item.c) continue
    const yc   = parseFloat(item.y)
    const rawZ = item.z !== '-' ? parseFloat(item.z) : null
    if (rawZ === null && isNaN(yc)) continue
    map[item.c] = {
      name:          item.n,
      price:         (rawZ !== null && !isNaN(rawZ)) ? rawZ : null,  // null = 當下無成交
      yesterdayClose: !isNaN(yc) ? yc : 0,
    }
  }
  return map
}

// 庫存頁專用：套用價格到 holdings 陣列
async function fetchPrices(holdings) {
  if (holdings.length === 0) return holdings
  const map = await fetchStockMap(holdings.map(h => h.symbol))
  return holdings.map(h => {
    const found = map[h.symbol]
    if (!found) {
      console.warn(`[股價更新] 找不到 ${h.symbol}（${h.name}），保留原有資料`)
      return h
    }
    // price: 有即時成交價用它；否則保留已存價格（若從未有資料才用昨收補底）
    const price = found.price !== null ? found.price
                : (h.price > 0 ? h.price : found.yesterdayClose)
    return { ...h, price, yesterdayClose: found.yesterdayClose }
  })
}

// ─── 計算邏輯 ─────────────────────────────────────────────────────────────────

function calcStock(h) {
  if (h.price === 0 || h.yesterdayClose === 0) {
    return {
      code: h.symbol, name: h.name, shares: h.shares, avgCost: h.avgCost,
      price: h.price, changePercent: 0, todayPnL: 0, totalPnL: 0, returnRate: 0,
    }
  }
  return {
    code: h.symbol,
    name: h.name,
    shares: h.shares,
    avgCost: h.avgCost,
    price: h.price,
    changePercent: ((h.price - h.yesterdayClose) / h.yesterdayClose) * 100,
    todayPnL:  Math.round((h.price - h.yesterdayClose) * h.shares),
    totalPnL:  Math.round((h.price - h.avgCost) * h.shares),
    returnRate: ((h.price - h.avgCost) / h.avgCost) * 100,
  }
}

function calcSummary(stocks, holdings) {
  if (holdings.length === 0) {
    return { todayPnL: 0, todayPnLPercent: 0, totalPnL: 0, totalPnLPercent: 0, marketValue: 0, totalCost: 0 }
  }
  const totalCost      = holdings.reduce((sum, h) => sum + h.avgCost * h.shares, 0)
  const marketValue    = holdings.reduce((sum, h) => sum + h.price   * h.shares, 0)
  const yesterdayValue = holdings.reduce((sum, h) => sum + h.yesterdayClose * h.shares, 0)
  const todayPnL       = stocks.reduce((sum, s) => sum + s.todayPnL, 0)
  const totalPnL       = stocks.reduce((sum, s) => sum + s.totalPnL, 0)
  return {
    todayPnL,
    todayPnLPercent:  yesterdayValue > 0 ? (todayPnL / yesterdayValue) * 100 : 0,
    totalPnL,
    totalPnLPercent:  totalCost > 0 ? (totalPnL / totalCost) * 100 : 0,
    marketValue: Math.round(marketValue),
    totalCost:   Math.round(totalCost),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNumber(n) {
  return n.toLocaleString('zh-TW')
}

function twColor(value) {
  if (value > 0) return 'text-red-400'
  if (value < 0) return 'text-emerald-400'
  return 'text-white'
}

function PnLText({ value, className = '' }) {
  const sign = value > 0 ? '+' : ''
  return <span className={`${twColor(value)} ${className}`}>{sign}{formatNumber(value)}</span>
}

function PercentText({ value, className = '' }) {
  const sign = value > 0 ? '+' : ''
  return <span className={`${twColor(value)} ${className}`}>{sign}{value.toFixed(2)}%</span>
}

// ─── Top Bar ──────────────────────────────────────────────────────────────────

function TopBar({ lastUpdated, isFetching, onRefresh }) {
  return (
    <div className="flex items-center justify-between px-4 pt-12 pb-4">
      <h1 className="text-lg font-semibold text-white tracking-wide">我的持股</h1>
      <div className="flex items-center gap-3">
        <span className="text-xs text-white">
          {isFetching ? '更新中...' : `更新 ${lastUpdated}`}
        </span>
        <button
          onClick={onRefresh}
          disabled={isFetching}
          className="text-white transition-colors p-1 disabled:opacity-40"
          title="更新股價"
        >
          <RefreshIcon spinning={isFetching} />
        </button>
      </div>
    </div>
  )
}

function RefreshIcon({ spinning }) {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={spinning ? { animation: 'spin 1s linear infinite' } : {}}
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ summary }) {
  const todayColor = twColor(summary.todayPnL)
  const todaySign  = summary.todayPnL > 0 ? '+' : ''
  return (
    <div className="mx-4 mb-4 bg-[#1a1a1a] rounded-2xl p-4 border border-[#2a2a2a]">
      <div className="mb-4 pb-4 border-b border-[#2a2a2a]">
        <p className="text-xs text-white mb-1 uppercase tracking-wider">今日損益</p>
        <p className={`text-4xl font-bold ${todayColor}`}>
          {todaySign}{formatNumber(summary.todayPnL)}
        </p>
        <PercentText value={summary.todayPnLPercent} className="text-sm mt-1" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-white mb-1">累積損益</p>
          <PnLText value={summary.totalPnL} className="text-lg font-semibold" />
          <div className="mt-0.5">
            <PercentText value={summary.totalPnLPercent} className="text-xs" />
          </div>
        </div>
        <div>
          <p className="text-xs text-white mb-1">股票市值</p>
          <p className="text-lg font-semibold text-white">{formatNumber(summary.marketValue)}</p>
          <p className="text-xs text-white mt-0.5">成本 {formatNumber(summary.totalCost)}</p>
        </div>
      </div>
    </div>
  )
}

// ─── Holding Form (Modal) ─────────────────────────────────────────────────────

function HoldingForm({ initial, onSave, onCancel }) {
  const isEdit = initial != null
  const [form, setForm] = useState({
    name:    initial?.name    ?? '',
    symbol:  initial?.symbol  ?? '',
    shares:  initial?.shares  ?? '',
    avgCost: initial?.avgCost ?? '',
  })
  const [isLookingUp, setIsLookingUp] = useState(false)

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function lookupName() {
    const sym = form.symbol.trim().toUpperCase()
    if (!sym || form.name) return
    setIsLookingUp(true)
    try {
      const map  = await fetchStockMap([sym])
      const info = map[sym]
      if (info?.name) set('name', info.name)
    } catch {}
    setIsLookingUp(false)
  }

  function handleSubmit(e) {
    e.preventDefault()
    const shares  = Number(form.shares)
    const avgCost = Number(form.avgCost)
    if (!form.name || !form.symbol || shares <= 0 || avgCost <= 0) return
    onSave({
      price:          initial?.price          ?? 0,
      yesterdayClose: initial?.yesterdayClose ?? 0,
      name:    form.name.trim(),
      symbol:  form.symbol.trim().toUpperCase(),
      shares,
      avgCost,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end">
      <div className="w-full max-w-md mx-auto bg-[#1c1c1c] rounded-t-2xl border-t border-[#2a2a2a] p-5">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-white">{isEdit ? '編輯持股' : '新增持股'}</h2>
          <button onClick={onCancel} className="text-white p-1">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-white mb-1 block">股票代號</label>
            <input type="text" value={form.symbol}
              onChange={e => set('symbol', e.target.value)}
              onBlur={lookupName}
              placeholder="例：2330"
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
          </div>
          <div>
            <label className="text-xs text-white mb-1 block">
              股票名稱
              {isLookingUp && <span className="text-white ml-2">查詢中...</span>}
            </label>
            <input type="text" value={form.name} onChange={e => set('name', e.target.value)}
              placeholder="輸入代號後自動帶入，或手動填寫"
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white mb-1 block">持股股數</label>
              <input type="number" value={form.shares} onChange={e => set('shares', e.target.value)}
                placeholder="例：1000" min="1"
                className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
            </div>
            <div>
              <label className="text-xs text-white mb-1 block">平均成本</label>
              <input type="number" value={form.avgCost} onChange={e => set('avgCost', e.target.value)}
                placeholder="例：750" min="0.01" step="0.01"
                className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
            </div>
          </div>
          <p className="text-xs text-white">現價與昨收將在儲存後自動更新。</p>
          <div className="flex gap-2 mt-1">
            <button type="button" onClick={onCancel}
              className="flex-1 py-2.5 rounded-xl border border-[#333] text-white text-sm">取消</button>
            <button type="submit"
              className="flex-1 py-2.5 rounded-xl bg-white text-black text-sm font-medium">儲存</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Stock Row ────────────────────────────────────────────────────────────────

function StockRow({ stock, onEdit, onDelete }) {
  const [showActions, setShowActions] = useState(false)
  return (
    <div className="border-b border-[#1e1e1e] last:border-b-0">
      <div className="px-4 py-4" onClick={() => setShowActions(prev => !prev)}>
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="text-sm font-medium text-white leading-tight">{stock.name}</p>
            <p className="text-xs text-white mt-0.5">{stock.code}</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-white">
              {stock.price > 0 ? stock.price.toFixed(2) : '--'}
            </p>
            <PercentText value={stock.changePercent} className="text-xs" />
          </div>
        </div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1">
            <span className="text-sm text-white">今日</span>
            <PnLText value={stock.todayPnL} className="text-sm font-medium" />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-sm text-white">累積</span>
            <PnLText value={stock.totalPnL} className="text-sm font-medium" />
            <PercentText value={stock.returnRate} className="text-xs" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-white">{formatNumber(stock.shares)} 股</span>
          <span className="text-sm text-white">·</span>
          <span className="text-sm text-white">均價 {stock.avgCost.toFixed(2)}</span>
        </div>
      </div>
      {showActions && (
        <div className="flex border-t border-[#222]">
          <button onClick={() => { setShowActions(false); onEdit() }}
            className="flex-1 py-2.5 text-xs text-white hover:bg-[#222] transition-colors">編輯</button>
          <div className="w-px bg-[#222]" />
          <button onClick={() => onDelete()}
            className="flex-1 py-2.5 text-xs text-emerald-500 hover:text-red-400 hover:bg-[#222] transition-colors">刪除</button>
        </div>
      )}
    </div>
  )
}

// ─── Stock List ───────────────────────────────────────────────────────────────

function StockList({ stocks, onAdd, onEdit, onDelete }) {
  return (
    <div className="mx-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-white uppercase tracking-wider">持股明細</p>
        <div className="flex items-center gap-3">
          <p className="text-xs text-white">{stocks.length} 檔</p>
          <button onClick={onAdd}
            className="text-xs text-white border border-[#333] hover:border-[#555] rounded-lg px-2.5 py-1 transition-colors">
            + 新增
          </button>
        </div>
      </div>
      {stocks.length === 0 ? (
        <div className="bg-[#1a1a1a] rounded-2xl border border-[#2a2a2a] p-8 text-center">
          <p className="text-white text-sm">尚無持股</p>
          <p className="text-white text-xs mt-1">點擊「+ 新增」加入第一筆</p>
        </div>
      ) : (
        <div className="bg-[#1a1a1a] rounded-2xl border border-[#2a2a2a] overflow-hidden">
          {stocks.map((stock, index) => (
            <StockRow key={stock.code} stock={stock}
              onEdit={() => onEdit(index)} onDelete={() => onDelete(index)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 自選股資料 ───────────────────────────────────────────────────────────────

// 加權指數：固定第一筆，不可移除
// TWSE MIS API 的加權指數代號是 t00（不是 TWII）
const TAIEX_INIT = {
  symbol: 't00', name: '加權指數', price: 0, yesterdayClose: 0,
}

// 預設假資料（localStorage 無資料時使用，price=0 → 載入後自動更新）
const DEFAULT_WATCHLIST = [
  { symbol: '0050', name: '元大台灣50', price: 0, yesterdayClose: 0 },
  { symbol: '2408', name: '南亞科',     price: 0, yesterdayClose: 0 },
  { symbol: '8440', name: '綠電',       price: 0, yesterdayClose: 0 },
  { symbol: '6535', name: '順藥',       price: 0, yesterdayClose: 0 },
  { symbol: '2031', name: '新光鋼',     price: 0, yesterdayClose: 0 },
  { symbol: '2331', name: '精英',       price: 0, yesterdayClose: 0 },
  { symbol: '2498', name: '宏達電',     price: 0, yesterdayClose: 0 },
  { symbol: '2474', name: '可成',       price: 0, yesterdayClose: 0 },
]

// ─── 自選股新增表單 ───────────────────────────────────────────────────────────

function WatchlistForm({ onSave, onCancel }) {
  const [symbol,      setSymbol]      = useState('')
  const [name,        setName]        = useState('')
  const [isLookingUp, setIsLookingUp] = useState(false)
  const [isAdding,    setIsAdding]    = useState(false)
  const [error,       setError]       = useState('')

  // 代號失焦時自動查詢名稱
  async function lookupName() {
    const sym = symbol.trim().toUpperCase()
    if (!sym || name) return
    setIsLookingUp(true)
    setError('')
    try {
      const map  = await fetchStockMap([sym])
      const info = map[sym]
      if (info?.name) setName(info.name)
    } catch {}
    setIsLookingUp(false)
  }

  // 按「加入」時驗證代號並取得即時股價
  async function handleSubmit(e) {
    e.preventDefault()
    const sym = symbol.trim().toUpperCase()
    if (!sym) return

    setIsAdding(true)
    setError('')
    try {
      const map  = await fetchStockMap([sym])
      const info = map[sym]
      if (!info) {
        setError(`找不到股票代號「${sym}」，請確認後重試`)
        return
      }
      onSave({
        symbol:        sym,
        name:          info.name || name.trim() || sym,
        price:         info.price,
        yesterdayClose: info.yesterdayClose,
      })
    } catch {
      setError('查詢失敗，請稍後再試')
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end">
      <div className="w-full max-w-md mx-auto bg-[#1c1c1c] rounded-t-2xl border-t border-[#2a2a2a] p-5">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-white">新增自選股</h2>
          <button onClick={onCancel} className="text-white p-1">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-white mb-1 block">股票代號</label>
            <input
              type="text" value={symbol}
              onChange={e => { setSymbol(e.target.value); setError('') }}
              onBlur={lookupName}
              placeholder="例：2330"
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]"
            />
          </div>
          <div>
            <label className="text-xs text-white mb-1 block">
              股票名稱
              {isLookingUp && <span className="text-white/50 ml-2 text-xs">查詢中...</span>}
            </label>
            <input
              type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="輸入代號後自動帶入"
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]"
            />
          </div>

          {/* 錯誤提示 */}
          {error && (
            <p className="text-xs text-yellow-500 bg-yellow-500/10 rounded-xl px-3 py-2">{error}</p>
          )}

          <div className="flex gap-2 mt-1">
            <button type="button" onClick={onCancel}
              className="flex-1 py-2.5 rounded-xl border border-[#333] text-white text-sm">取消</button>
            <button type="submit" disabled={isAdding || !symbol.trim()}
              className="flex-1 py-2.5 rounded-xl bg-white text-black text-sm font-medium disabled:opacity-50">
              {isAdding ? '查詢中...' : '加入'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── 自選股頁 ─────────────────────────────────────────────────────────────────

function WatchlistPage() {
  const [list,        setList]        = useState(loadWatchlist)
  const [taiex,       setTaiex]       = useState(TAIEX_INIT)
  const [showForm,    setShowForm]    = useState(false)
  const [isFetching,  setIsFetching]  = useState(false)
  const [lastUpdated, setLastUpdated] = useState('--')

  // 更新自選股清單 + 加權指數
  async function refreshWatchlist(currentList) {
    setIsFetching(true)
    try {
      // 加權指數 (t00) 和自選股一起送出，一次 API 呼叫
      const symbols = ['t00', ...currentList.map(i => i.symbol)]
      const map     = await fetchStockMap(symbols)

      // 更新加權指數
      const taiexInfo = map['t00']
      if (taiexInfo) {
        const taiexPrice = taiexInfo.price !== null ? taiexInfo.price : taiex.price
        setTaiex({ ...TAIEX_INIT, price: taiexPrice, yesterdayClose: taiexInfo.yesterdayClose })
      }

      // 更新自選股清單
      const updated = currentList.map(item => {
        const found = map[item.symbol]
        if (!found) return item
        const price = found.price !== null ? found.price
                    : (item.price > 0 ? item.price : found.yesterdayClose)
        return { ...item, price, yesterdayClose: found.yesterdayClose }
      })
      setList(updated)
      saveWatchlist(updated)
      setLastUpdated(
        new Date().toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      )
    } catch (err) {
      console.error('[自選股更新失敗]', err)
    } finally {
      setIsFetching(false)
    }
  }

  // 頁面載入時自動更新一次
  useEffect(() => {
    refreshWatchlist(loadWatchlist())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function addItem(item) {
    const next = [...list, item]
    setList(next)
    saveWatchlist(next)
    setShowForm(false)
  }

  function deleteItem(symbol) {
    const next = list.filter(i => i.symbol !== symbol)
    setList(next)
    saveWatchlist(next)
  }

  return (
    <div className="px-4 pt-12 pb-4">
      {/* 標題 + 更新時間 + 刷新按鈕 */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-white tracking-wide">自選股</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-white">
            {isFetching ? '更新中...' : `更新 ${lastUpdated}`}
          </span>
          <button
            onClick={() => refreshWatchlist(list)}
            disabled={isFetching}
            className="text-white p-1 disabled:opacity-40"
          >
            <RefreshIcon spinning={isFetching} />
          </button>
        </div>
      </div>

      {/* 加權指數卡片（固定，不顯示刷新中的 --）*/}
      <div className="bg-[#1a1a1a] rounded-2xl border border-[#2a2a2a] px-5 py-2 mb-4">
        <p className="text-xs text-white/50 pt-3 pb-1 uppercase tracking-wider">大盤指數</p>
        <WatchlistRow item={taiex} fixed />
      </div>

      {/* 自選股標題 + 新增按鈕 */}
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-white/50 uppercase tracking-wider">自選清單</p>
        <div className="flex items-center gap-3">
          <p className="text-xs text-white/50">{list.length} 檔</p>
          <button
            onClick={() => setShowForm(true)}
            className="text-xs text-white border border-[#333] hover:border-[#555] rounded-lg px-2.5 py-1 transition-colors">
            + 新增
          </button>
        </div>
      </div>

      {/* 自選股卡片 */}
      {list.length === 0 ? (
        <div className="bg-[#1a1a1a] rounded-2xl border border-[#2a2a2a] p-8 text-center">
          <p className="text-white text-sm">尚無自選股</p>
          <p className="text-white/50 text-xs mt-1">點擊「+ 新增」加入第一筆</p>
        </div>
      ) : (
        <div className="bg-[#1a1a1a] rounded-2xl border border-[#2a2a2a] overflow-hidden">
          {list.map(item => (
            <WatchlistRow key={item.symbol} item={item} onDelete={() => deleteItem(item.symbol)} />
          ))}
        </div>
      )}

      {showForm && <WatchlistForm onSave={addItem} onCancel={() => setShowForm(false)} />}
    </div>
  )
}

function WatchlistRow({ item, fixed = false, onDelete }) {
  const [showActions, setShowActions] = useState(false)

  // 從 price / yesterdayClose 計算漲跌
  const hasPrice    = item.price > 0 && item.yesterdayClose > 0
  const changeAmt   = hasPrice ? item.price - item.yesterdayClose : 0
  const changePct   = hasPrice ? (changeAmt / item.yesterdayClose) * 100 : 0
  const changeColor = hasPrice ? twColor(changeAmt) : 'text-white/30'
  const arrow       = changeAmt > 0 ? '▲' : changeAmt < 0 ? '▼' : ''
  const sign        = changeAmt > 0 ? '+' : ''

  return (
    <div className="border-b border-[#252525] last:border-b-0">
      <div
        className="flex items-center px-5 py-4"
        onClick={() => !fixed && setShowActions(prev => !prev)}
      >
        {/* 左：名稱 + 代號 */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white leading-tight">{item.name}</p>
          <p className="text-xs text-white/50 mt-1">{item.symbol}</p>
        </div>

        {/* 股價 */}
        <div className="w-24 text-right">
          <p className="text-base font-semibold text-white">
            {hasPrice
              ? (fixed ? item.price.toLocaleString() : item.price.toFixed(2))
              : '--'}
          </p>
        </div>

        {/* 漲跌點 + 漲跌幅% */}
        <div className={`w-28 text-right ${changeColor}`}>
          <p className="text-sm font-medium">
            {hasPrice ? `${arrow}${Math.abs(changeAmt).toFixed(2)}` : '--'}
          </p>
          <p className="text-xs mt-1">
            {hasPrice ? `${sign}${changePct.toFixed(2)}%` : '--'}
          </p>
        </div>
      </div>

      {/* 刪除動作列 */}
      {showActions && !fixed && (
        <div className="flex border-t border-[#222]">
          <button
            onClick={() => setShowActions(false)}
            className="flex-1 py-2.5 text-xs text-white hover:bg-[#222] transition-colors">
            取消
          </button>
          <div className="w-px bg-[#222]" />
          <button
            onClick={() => onDelete()}
            className="flex-1 py-2.5 text-xs text-emerald-500 hover:text-red-400 hover:bg-[#222] transition-colors">
            刪除
          </button>
        </div>
      )}
    </div>
  )
}

// ─── 底部導覽列 ───────────────────────────────────────────────────────────────

function BottomNav({ activePage, onNavigate }) {
  const tabs = [
    {
      id: 'portfolio',
      label: '庫存',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
    },
    {
      id: 'watchlist',
      label: '自選股',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
    },
  ]

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#111] border-t border-[#222] max-w-md mx-auto">
      <div className="flex">
        {tabs.map(tab => {
          const isActive = activePage === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => onNavigate(tab.id)}
              className={`flex-1 flex flex-col items-center justify-center py-2.5 gap-1 transition-colors
                ${isActive ? 'text-white' : 'text-white/40'}`}
            >
              {tab.icon}
              <span className="text-[10px] font-medium tracking-wide">{tab.label}</span>
              {isActive && <span className="absolute bottom-1 w-1 h-1 rounded-full bg-white" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── App Root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [holdings,    setHoldings]    = useState(loadHoldings)
  const [modal,       setModal]       = useState(null)
  const [isFetching,  setIsFetching]  = useState(false)
  const [fetchError,  setFetchError]  = useState(null)
  const [lastUpdated, setLastUpdated] = useState('--')
  const [activePage,  setActivePage]  = useState('portfolio')

  const stocks  = holdings.map(calcStock)
  const summary = calcSummary(stocks, holdings)

  function updateHoldings(newHoldings) {
    setHoldings(newHoldings)
    saveHoldings(newHoldings)
  }

  async function refreshPrices(currentHoldings) {
    setIsFetching(true)
    setFetchError(null)
    try {
      const updated = await fetchPrices(currentHoldings)
      updateHoldings(updated)
      setLastUpdated(
        new Date().toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      )
    } catch (err) {
      console.error('[股價更新失敗]', err)
      setFetchError('無法取得最新股價，顯示最後已知資料')
    } finally {
      setIsFetching(false)
    }
  }

  useEffect(() => {
    refreshPrices(loadHoldings())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd(newHolding) {
    const newHoldings = [...holdings, newHolding]
    updateHoldings(newHoldings)
    setModal(null)
    await refreshPrices(newHoldings)
  }

  function handleEdit(updatedHolding) {
    const updated = holdings.map((h, i) => i === modal ? updatedHolding : h)
    updateHoldings(updated)
    setModal(null)
  }

  function handleDelete(index) {
    updateHoldings(holdings.filter((_, i) => i !== index))
  }

  return (
    <div className="min-h-screen bg-[#0f0f0f] max-w-md mx-auto pb-24">

      {/* ── 庫存頁 ── */}
      {activePage === 'portfolio' && (
        <>
          <TopBar
            lastUpdated={lastUpdated}
            isFetching={isFetching}
            onRefresh={() => refreshPrices(holdings)}
          />
          {fetchError && (
            <p className="mx-4 mb-3 text-xs text-yellow-600 bg-yellow-600/10 rounded-xl px-3 py-2">
              {fetchError}
            </p>
          )}
          <SummaryCard summary={summary} />
          <StockList
            stocks={stocks}
            onAdd={() => setModal('add')}
            onEdit={(index) => setModal(index)}
            onDelete={handleDelete}
          />
        </>
      )}

      {/* ── 自選股頁 ── */}
      {activePage === 'watchlist' && <WatchlistPage />}

      {/* ── 新增 / 編輯 Modal ── */}
      {modal === 'add' && (
        <HoldingForm initial={null} onSave={handleAdd} onCancel={() => setModal(null)} />
      )}
      {typeof modal === 'number' && (
        <HoldingForm initial={holdings[modal]} onSave={handleEdit} onCancel={() => setModal(null)} />
      )}

      {/* ── 底部導覽 ── */}
      <BottomNav activePage={activePage} onNavigate={setActivePage} />
    </div>
  )
}
