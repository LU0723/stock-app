import { useState, useEffect } from 'react'

// ─── 預設持股資料（localStorage 沒資料時才使用）──────────────────────────────

const DEFAULT_HOLDINGS = [
  { symbol: '00631L', name: '元大台灣50正2',  shares: 2000, avgCost: 354.95, price: 0, yesterdayClose: 0 },
  { symbol: '00675L', name: '富邦臺灣加權正2', shares: 5000, avgCost: 178.68, price: 0, yesterdayClose: 0 },
  { symbol: '2330',   name: '台積電',          shares: 1000, avgCost: 754.38, price: 0, yesterdayClose: 0 },
]

// ─── localStorage ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'stock-holdings'

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

// ─── 股價抓取 ─────────────────────────────────────────────────────────────────
//
// 資料來源：TWSE MIS 即時行情 API（台灣證券交易所）
// 透過 Vite Dev Proxy 轉發請求，避免瀏覽器 CORS 限制（見 vite.config.js）
//
// 欄位說明：
//   z  = 即時成交價（盤中即時；盤後為最後收盤價；未開盤則為 "-"）
//   y  = 昨日收盤價（參考價）
//   c  = 股票代號
//
// 上市股票前綴 "tse_"，上櫃前綴 "otc_"
// 同時送出兩種前綴，API 只回傳有效的那筆

async function fetchPrices(holdings) {
  if (holdings.length === 0) return holdings

  // 每個 symbol 同時嘗試上市(tse)與上櫃(otc)，讓 API 自動篩選
  const exChList = holdings
    .flatMap(h => [`tse_${h.symbol}.tw`, `otc_${h.symbol}.tw`])
    .join('|')

  const url = `/api/stock?ex_ch=${exChList}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`TWSE MIS API 錯誤：${res.status}`)

  const data = await res.json()
  const items = data.msgArray ?? []

  // 建立 symbol → { price, yesterdayClose } 的對照表
  const priceMap = {}
  for (const item of items) {
    const yesterdayClose = parseFloat(item.y)
    // z = "-" 代表尚未開盤，此時以昨收當作目前參考價（今日損益顯示 0）
    const price = item.z !== '-' ? parseFloat(item.z) : yesterdayClose
    if (!isNaN(price) && !isNaN(yesterdayClose)) {
      priceMap[item.c] = { price, yesterdayClose }
    }
  }

  // 套用最新價格到 holdings；找不到的保留原有資料
  return holdings.map(h => {
    const found = priceMap[h.symbol]
    if (found) {
      return { ...h, price: found.price, yesterdayClose: found.yesterdayClose }
    }
    console.warn(`[股價更新] 找不到 ${h.symbol}（${h.name}），保留原有資料`)
    return h
  })
}

// ─── 計算邏輯 ─────────────────────────────────────────────────────────────────

function calcStock(h) {
  // 尚未取得價格（price = 0）時顯示 0，避免除以零
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
  return 'text-gray-400'
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
        <span className="text-xs text-gray-500">
          {isFetching ? '更新中...' : `更新 ${lastUpdated}`}
        </span>
        {/* 更新價格按鈕 */}
        <button
          onClick={onRefresh}
          disabled={isFetching}
          className="text-gray-400 hover:text-white transition-colors p-1 disabled:opacity-40"
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
        <p className="text-xs text-gray-500 mb-1 uppercase tracking-wider">今日損益</p>
        <p className={`text-4xl font-bold ${todayColor}`}>
          {todaySign}{formatNumber(summary.todayPnL)}
        </p>
        <PercentText value={summary.todayPnLPercent} className="text-sm mt-1" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-gray-500 mb-1">累積損益</p>
          <PnLText value={summary.totalPnL} className="text-lg font-semibold" />
          <div className="mt-0.5">
            <PercentText value={summary.totalPnLPercent} className="text-xs" />
          </div>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">股票市值</p>
          <p className="text-lg font-semibold text-white">{formatNumber(summary.marketValue)}</p>
          <p className="text-xs text-gray-600 mt-0.5">成本 {formatNumber(summary.totalCost)}</p>
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

  // 股票代號失焦時，自動查詢股票名稱
  async function lookupName() {
    const sym = form.symbol.trim().toUpperCase()
    if (!sym || form.name) return  // 已有名稱就不覆蓋
    setIsLookingUp(true)
    try {
      const url = `/api/stock?ex_ch=tse_${sym}.tw|otc_${sym}.tw`
      const res  = await fetch(url)
      const data = await res.json()
      const name = data.msgArray?.[0]?.n
      if (name) set('name', name)
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
          <button onClick={onCancel} className="text-gray-500 hover:text-white p-1">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">股票代號</label>
            <input type="text" value={form.symbol}
              onChange={e => set('symbol', e.target.value)}
              onBlur={lookupName}
              placeholder="例：2330"
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">
              股票名稱
              {isLookingUp && <span className="text-gray-600 ml-2">查詢中...</span>}
            </label>
            <input type="text" value={form.name} onChange={e => set('name', e.target.value)}
              placeholder="輸入代號後自動帶入，或手動填寫"
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">持股股數</label>
              <input type="number" value={form.shares} onChange={e => set('shares', e.target.value)}
                placeholder="例：1000" min="1"
                className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">平均成本</label>
              <input type="number" value={form.avgCost} onChange={e => set('avgCost', e.target.value)}
                placeholder="例：750" min="0.01" step="0.01"
                className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
            </div>
          </div>
          <p className="text-xs text-gray-600">現價與昨收將在儲存後自動更新。</p>
          <div className="flex gap-2 mt-1">
            <button type="button" onClick={onCancel}
              className="flex-1 py-2.5 rounded-xl border border-[#333] text-gray-400 text-sm">取消</button>
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
            <p className="text-xs text-gray-500 mt-0.5">{stock.code}</p>
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
            <span className="text-sm text-gray-400">今日</span>
            <PnLText value={stock.todayPnL} className="text-sm font-medium" />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-sm text-gray-400">累積</span>
            <PnLText value={stock.totalPnL} className="text-sm font-medium" />
            <PercentText value={stock.returnRate} className="text-xs" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">{formatNumber(stock.shares)} 股</span>
          <span className="text-sm text-gray-500">·</span>
          <span className="text-sm text-gray-400">均價 {stock.avgCost.toFixed(2)}</span>
        </div>
      </div>
      {showActions && (
        <div className="flex border-t border-[#222]">
          <button onClick={() => { setShowActions(false); onEdit() }}
            className="flex-1 py-2.5 text-xs text-gray-400 hover:text-white hover:bg-[#222] transition-colors">編輯</button>
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
        <p className="text-xs text-gray-500 uppercase tracking-wider">持股明細</p>
        <div className="flex items-center gap-3">
          <p className="text-xs text-gray-600">{stocks.length} 檔</p>
          <button onClick={onAdd}
            className="text-xs text-gray-400 hover:text-white border border-[#333] hover:border-[#555] rounded-lg px-2.5 py-1 transition-colors">
            + 新增
          </button>
        </div>
      </div>
      {stocks.length === 0 ? (
        <div className="bg-[#1a1a1a] rounded-2xl border border-[#2a2a2a] p-8 text-center">
          <p className="text-gray-600 text-sm">尚無持股</p>
          <p className="text-gray-700 text-xs mt-1">點擊「+ 新增」加入第一筆</p>
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

// ─── App Root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [holdings,    setHoldings]    = useState(loadHoldings)
  const [modal,       setModal]       = useState(null)       // null | 'add' | index(number)
  const [isFetching,  setIsFetching]  = useState(false)
  const [fetchError,  setFetchError]  = useState(null)
  const [lastUpdated, setLastUpdated] = useState('--')

  const stocks  = holdings.map(calcStock)
  const summary = calcSummary(stocks, holdings)

  // 更新持股並存回 localStorage
  function updateHoldings(newHoldings) {
    setHoldings(newHoldings)
    saveHoldings(newHoldings)
  }

  // 抓取最新股價並更新 holdings
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

  // 頁面載入時自動更新一次
  useEffect(() => {
    refreshPrices(loadHoldings())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 新增持股後立刻抓取該股票的股價
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
    <div className="min-h-screen bg-[#0f0f0f] max-w-md mx-auto pb-10">
      <TopBar
        lastUpdated={lastUpdated}
        isFetching={isFetching}
        onRefresh={() => refreshPrices(holdings)}
      />

      {/* 股價抓取失敗提示 */}
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

      {modal === 'add' && (
        <HoldingForm initial={null} onSave={handleAdd} onCancel={() => setModal(null)} />
      )}
      {typeof modal === 'number' && (
        <HoldingForm initial={holdings[modal]} onSave={handleEdit} onCancel={() => setModal(null)} />
      )}
    </div>
  )
}
