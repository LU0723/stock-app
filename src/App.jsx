import { useState, useEffect, useRef } from 'react'
import {
  DndContext, closestCenter,
  PointerSensor, TouchSensor,
  useSensor, useSensors,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ─── 預設持股資料（localStorage 沒資料時才使用）──────────────────────────────

const DEFAULT_HOLDINGS = [
  { symbol: '0050', name: '元大台灣50', shares: 1000, avgCost: 75,   price: 0, yesterdayClose: 0 },
  { symbol: '2330', name: '台積電',     shares: 1000, avgCost: 1820, price: 0, yesterdayClose: 0 },
]

// ─── localStorage ────────────────────────────────────────────────────────────

const STORAGE_KEY      = 'stock-holdings'
const WATCHLIST_KEY    = 'watchlist-stocks'
const SORT_LOCK_KEY    = 'watchlist-sort-locked'
const CASH_KEY            = 'exposure-cash'
const INDEX_HIGH_KEY      = 'twii-year-high'
const TARGET_EXPOSURE_KEY = 'exposure-target-lev'
const ADVANCED_MODE_KEY   = 'advanced-mode'
const YEAR_HIGH_CACHE_KEY = 'twii-year-high-cache'  // { date, value }，每日快取
const PERF_SNAPSHOT_KEY   = 'performance-snapshot'
const PERF_CASHFLOWS_KEY  = 'performance-cashflows'
const NORMAL_TAB_KEY      = 'normalTab'
const ADVANCED_TAB_KEY    = 'advancedTab'

// 正二曝險標的，未來可在此擴充
const LEVERAGED_SYMBOLS = ['00631L', '00675L']

function loadSortLocked() {
  return localStorage.getItem(SORT_LOCK_KEY) !== 'false'
}

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

function loadCash() {
  const v = parseFloat(localStorage.getItem(CASH_KEY))
  return isNaN(v) ? 0 : v
}
function saveCash(v) {
  localStorage.setItem(CASH_KEY, String(v))
}
function loadIndexHigh() {
  const v = parseFloat(localStorage.getItem(INDEX_HIGH_KEY))
  return isNaN(v) ? null : v
}
function saveIndexHigh(v) {
  localStorage.setItem(INDEX_HIGH_KEY, String(v))
}
function loadTargetExposure() {
  const saved = localStorage.getItem(TARGET_EXPOSURE_KEY)
  return saved !== null ? saved : null   // null = 尚未設定
}
function loadYearHighCache() {
  try {
    const saved = localStorage.getItem(YEAR_HIGH_CACHE_KEY)
    if (!saved) return null
    const { date, value } = JSON.parse(saved)
    const today = new Date().toISOString().split('T')[0]
    if (date === today && value > 0) return value
  } catch {}
  return null
}
function saveYearHighCache(value) {
  const today = new Date().toISOString().split('T')[0]
  localStorage.setItem(YEAR_HIGH_CACHE_KEY, JSON.stringify({ date: today, value }))
}
function saveTargetExposure(v) {
  localStorage.setItem(TARGET_EXPOSURE_KEY, String(v))
}

function loadSnapshot() {
  try {
    const saved = localStorage.getItem(PERF_SNAPSHOT_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return { twStockValue: '', usStockValue: '', cashValue: '', otherAssetsValue: '' }
}
function saveSnapshot(s) {
  localStorage.setItem(PERF_SNAPSHOT_KEY, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }))
}
function loadCashflows() {
  try {
    const saved = localStorage.getItem(PERF_CASHFLOWS_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return []
}

// ─── 共用股價 API ─────────────────────────────────────────────────────────────
//
// fetchStockMap(symbols) → { [symbol]: { name, price, yesterdayClose } }
// 可被庫存頁與自選股共用

// z='-' 時用委買賣中間價估算現價
function bidAskMid(a, b) {
  const ask = parseFloat((a || '').split('_')[0])
  const bid = parseFloat((b || '').split('_')[0])
  if (!isNaN(ask) && ask > 0 && !isNaN(bid) && bid > 0) return (ask + bid) / 2
  if (!isNaN(ask) && ask > 0) return ask
  if (!isNaN(bid) && bid > 0) return bid
  return null
}

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
    const rawZ  = item.z !== '-' ? parseFloat(item.z) : null
    const mid   = (rawZ === null) ? bidAskMid(item.a, item.b) : null
    const price = (rawZ !== null && !isNaN(rawZ)) ? rawZ : (mid ?? null)
    if (price === null && isNaN(yc)) continue
    map[item.c] = {
      name:          item.n,
      price,                               // null = 完全無法估算現價
      yesterdayClose: !isNaN(yc) ? yc : 0,
    }
  }
  return map
}

// 台灣加權指數近一年高點：抓 TWSE exchangeReport/FMTQIK 歷史月資料
// 直接前端 fetch（www.twse.com.tw 支援 CORS），不需 proxy
async function fetchYearHigh() {
  const today = new Date()
  let maxPrice = 0

  for (let i = 0; i < 12; i++) {
    const d     = new Date(today.getFullYear(), today.getMonth() - i, 1)
    const year  = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const dateStr = `${year}${month}01`
    try {
      const url = `https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date=${dateStr}`
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json()

      // Task 1：第一個月印出原始資料，確認欄位順序
      if (i === 0) {
        console.log('[fetchYearHigh] fields:', data.fields)
        console.log('[fetchYearHigh] data[0]:', data.data?.[0])
      }

      if (data.stat !== 'OK' || !Array.isArray(data.data)) continue

      // Task 2：動態找「發行量加權股價指數」欄位，避免欄位順序變動
      const fields = Array.isArray(data.fields) ? data.fields : []
      const colIdx = fields.findIndex(f => String(f).includes('加權股價指數'))
      const idx    = colIdx >= 0 ? colIdx : 1   // fallback 到 column 1

      for (const row of data.data) {
        // Task 3：去除千分位逗號再 parseFloat
        const val = parseFloat(String(row[idx] ?? '').replace(/,/g, ''))

        // Task 4：安全檢查，指數不可能超過 1,000,000
        if (!isNaN(val) && val > maxPrice && val < 1_000_000) maxPrice = val
      }
    } catch { /* 單月失敗跳過，繼續其他月份 */ }
  }

  if (maxPrice === 0) throw new Error('無法取得近一年高點資料')
  return maxPrice
}

// 台灣加權指數（代碼 t00）
async function fetchTaiwanIndex() {
  const url = '/api/stock?ex_ch=tse_t00.tw'
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`API 錯誤：${res.status}`)
  const data  = await res.json()
  const items = data.msgArray ?? []
  const item  = items[0]
  if (!item) throw new Error('無加權指數資料')
  const z  = item.z !== '-' ? parseFloat(item.z) : null
  const y  = parseFloat(item.y)
  const price = z !== null && !isNaN(z) ? z : (!isNaN(y) ? y : null)
  if (price === null) throw new Error('加權指數無法解析')
  return price
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
  if (value > 0) return 'text-red-500'
  if (value < 0) return 'text-green-600'
  return 'text-gray-500'
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

function TopBar({ lastUpdated, isFetching, onRefresh, onBackup, onLongPress }) {
  const timerRef = useRef(null)

  function startPress() {
    timerRef.current = setTimeout(() => { onLongPress() }, 2000)
  }
  function cancelPress() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }

  return (
    <div className="flex items-center justify-between px-4 pt-12 pb-4">
      <h1
        className="text-lg font-semibold text-gray-800 tracking-wide select-none"
        onMouseDown={startPress} onMouseUp={cancelPress} onMouseLeave={cancelPress}
        onTouchStart={startPress} onTouchEnd={cancelPress} onTouchCancel={cancelPress}
      >我的持股</h1>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-600">
          {isFetching ? '更新中...' : `更新 ${lastUpdated}`}
        </span>
        <button
          onClick={onBackup}
          className="text-gray-400 hover:text-gray-600 transition-colors p-1"
          title="資料備份"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="21 8 21 21 3 21 3 8"/>
            <rect x="1" y="3" width="22" height="5"/>
            <line x1="10" y1="12" x2="14" y2="12"/>
          </svg>
        </button>
        <button
          onClick={onRefresh}
          disabled={isFetching}
          className="text-gray-500 transition-colors p-1 disabled:opacity-40"
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
    <div className="mx-4 mb-4 bg-white rounded-xl p-4 border border-gray-300">
      <div className="mb-4 pb-4 border-b border-gray-200">
        <p className="text-xs text-gray-600 mb-1 uppercase tracking-wider">今日損益</p>
        <p className={`text-[42px] leading-none font-bold ${todayColor}`}>
          {todaySign}{formatNumber(summary.todayPnL)}
        </p>
        <PercentText value={summary.todayPnLPercent} className="text-base mt-1" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-gray-600 mb-1">累積損益</p>
          <PnLText value={summary.totalPnL} className="text-xl font-semibold" />
          <div className="mt-0.5">
            <PercentText value={summary.totalPnLPercent} className="text-sm" />
          </div>
        </div>
        <div>
          <p className="text-xs text-gray-600 mb-1">股票市值</p>
          <p className="text-xl font-semibold text-gray-900">{formatNumber(summary.marketValue)}</p>
          <p className="text-sm text-gray-600 mt-0.5">成本 {formatNumber(summary.totalCost)}</p>
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
    <div className="border-b border-gray-200 last:border-b-0">
      <div className="px-4 pt-3.5 pb-3" onClick={() => setShowActions(prev => !prev)}>

        {/* 第一行：名稱／代號  +  現價／漲跌幅 */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-base font-semibold text-gray-900 leading-tight">{stock.name}</p>
            <p className="text-xs text-gray-600 mt-0.5">{stock.code}</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold text-gray-900 tabular-nums">
              {stock.price > 0 ? stock.price.toFixed(2) : '--'}
            </p>
            <PercentText value={stock.changePercent} className="text-sm mt-0.5" />
          </div>
        </div>

        {/* 第二行：今日損益 / 累積損益 — 格狀對齊 */}
        <div className="grid grid-cols-2 gap-x-4 bg-gray-100 rounded-xl px-3 py-2.5 mb-2.5">
          <div>
            <p className="text-xs text-gray-600 mb-0.5 uppercase tracking-wider">今日損益</p>
            <PnLText value={stock.todayPnL} className="text-base font-medium tabular-nums" />
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-0.5 uppercase tracking-wider">累積損益</p>
            <div className="flex items-baseline gap-1.5">
              <PnLText value={stock.totalPnL} className="text-base font-medium tabular-nums" />
              <PercentText value={stock.returnRate} className="text-xs" />
            </div>
          </div>
        </div>

        {/* 第三行：股數 + 均價 + 成本（次要資訊） */}
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>{formatNumber(stock.shares)} 股</span>
          <span>·</span>
          <span>均價 {stock.avgCost.toFixed(2)}</span>
          <span>·</span>
          <span>成本 {formatNumber(Math.round(stock.shares * stock.avgCost))}</span>
        </div>
      </div>

      {showActions && (
        <div className="flex border-t border-gray-200">
          <button onClick={() => { setShowActions(false); onEdit() }}
            className="flex-1 py-2.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">編輯</button>
          <div className="w-px bg-gray-200" />
          <button onClick={() => onDelete()}
            className="flex-1 py-2.5 text-xs text-red-500 hover:bg-red-50 transition-colors">刪除</button>
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
        <p className="text-xs text-gray-600 uppercase tracking-wider">持股明細</p>
        <div className="flex items-center gap-3">
          <p className="text-xs text-gray-600">{stocks.length} 檔</p>
          <button onClick={onAdd}
            className="text-xs text-gray-700 border border-gray-300 hover:border-gray-400 rounded-lg px-2.5 py-1 transition-colors">
            + 新增
          </button>
        </div>
      </div>
      {stocks.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-300 p-8 text-center">
          <p className="text-gray-600 text-sm">尚無持股</p>
          <p className="text-gray-500 text-xs mt-1">點擊「+ 新增」加入第一筆</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-300 overflow-hidden">
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
  { symbol: '0050',   name: '元大台灣50',       price: 0, yesterdayClose: 0 },
  { symbol: '2330',   name: '台積電',           price: 0, yesterdayClose: 0 },
  { symbol: '00631L', name: '元大台灣50正2',    price: 0, yesterdayClose: 0 },
  { symbol: '00675L', name: '富邦臺灣加權正2',  price: 0, yesterdayClose: 0 },
]

// ─── 自選股新增表單 ───────────────────────────────────────────────────────────

function WatchlistForm({ onSave, onCancel, existingSymbols = [] }) {
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

    if (existingSymbols.includes(sym)) {
      setError(`${sym} 已在自選股中`)
      return
    }

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
  const [sortLocked,  setSortLocked]  = useState(loadSortLocked)

  function toggleLock() {
    const next = !sortLocked
    setSortLocked(next)
    localStorage.setItem(SORT_LOCK_KEY, String(next))
  }

  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    const oldIdx = list.findIndex(i => i.symbol === active.id)
    const newIdx = list.findIndex(i => i.symbol === over.id)
    const reordered = arrayMove(list, oldIdx, newIdx)
    setList(reordered)
    saveWatchlist(reordered)
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 5 } })
  )

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
    <div className="pb-4">
      {/* 標題列 */}
      <div className="flex items-center justify-between px-4 pt-12 pb-3 border-b border-gray-100">
        <h1 className="text-lg font-semibold text-gray-900 tracking-wide">自選股</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-600">
            {isFetching ? '更新中...' : `更新 ${lastUpdated}`}
          </span>
          <button
            onClick={() => refreshWatchlist(list)}
            disabled={isFetching}
            className="text-gray-500 p-1 disabled:opacity-40"
          >
            <RefreshIcon spinning={isFetching} />
          </button>
        </div>
      </div>

      {/* 加權指數列 */}
      <div className="border-b border-gray-100">
        <div className="px-4 pt-2 pb-0.5">
          <p className="text-[10px] text-gray-600 uppercase tracking-wider">大盤指數</p>
        </div>
        <WatchlistRow item={taiex} fixed />
      </div>

      {/* 自選清單標題 + 鎖定按鈕 + 新增按鈕 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <p className="text-[10px] text-gray-600 uppercase tracking-wider">自選清單 {list.length} 檔</p>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleLock}
            title={sortLocked ? '解鎖排序' : '鎖定排序'}
            className={`p-1.5 rounded-md transition-colors
              ${sortLocked ? 'text-gray-400 hover:text-gray-600' : 'text-blue-500 hover:text-blue-600'}`}
          >
            {sortLocked ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
              </svg>
            )}
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="text-xs text-gray-600 border border-gray-300 hover:border-gray-400 rounded-md px-2.5 py-1 transition-colors">
            + 新增
          </button>
        </div>
      </div>

      {/* 自選股列表 */}
      {list.length === 0 ? (
        <div className="p-10 text-center">
          <p className="text-gray-400 text-sm">尚無自選股</p>
          <p className="text-gray-300 text-xs mt-1">點擊「+ 新增」加入第一筆</p>
        </div>
      ) : sortLocked ? (
        <div>
          {list.map(item => (
            <WatchlistRow key={item.symbol} item={item} onDelete={() => deleteItem(item.symbol)} />
          ))}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={list.map(i => i.symbol)} strategy={verticalListSortingStrategy}>
            {list.map(item => (
              <SortableWatchlistRow key={item.symbol} item={item} onDelete={() => deleteItem(item.symbol)} />
            ))}
          </SortableContext>
        </DndContext>
      )}

      {showForm && <WatchlistForm existingSymbols={list.map(i => i.symbol)} onSave={addItem} onCancel={() => setShowForm(false)} />}
    </div>
  )
}

function WatchlistRow({ item, fixed = false, onDelete, dragHandle }) {
  const [showActions, setShowActions] = useState(false)

  // 從 price / yesterdayClose 計算漲跌
  const hasPrice    = item.price > 0 && item.yesterdayClose > 0
  const changeAmt   = hasPrice ? item.price - item.yesterdayClose : 0
  const changePct   = hasPrice ? (changeAmt / item.yesterdayClose) * 100 : 0
  const changeColor = hasPrice
    ? (changeAmt > 0 ? 'text-red-500' : changeAmt < 0 ? 'text-green-600' : 'text-gray-400')
    : 'text-gray-300'
  const arrow = changeAmt > 0 ? '▲' : changeAmt < 0 ? '▼' : ''
  const sign  = changeAmt > 0 ? '+' : ''

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <div
        className="flex items-center px-4 py-3"
        onClick={() => !fixed && setShowActions(prev => !prev)}
      >
        {/* 拖拉把手（手動排序模式才會傳入） */}
        {dragHandle}

        {/* 左：名稱 + 代號 */}
        <div className="flex-1 min-w-0">
          <p className="text-base font-medium text-gray-900 leading-tight">{item.name}</p>
          <p className="text-xs text-gray-600 mt-0.5">{item.symbol}</p>
        </div>

        {/* 股價 */}
        <div className="w-24 text-right">
          <p className={`text-lg font-semibold ${changeColor}`}>
            {hasPrice
              ? (fixed ? item.price.toLocaleString() : item.price.toFixed(2))
              : '--'}
          </p>
        </div>

        {/* 漲跌點 + 漲跌幅% */}
        <div className={`w-28 text-right ${changeColor}`}>
          <p className="text-base">
            {hasPrice ? `${arrow}${Math.abs(changeAmt).toFixed(2)}` : '--'}
          </p>
          <p className="text-sm mt-0.5">
            {hasPrice ? `${sign}${changePct.toFixed(2)}%` : '--'}
          </p>
        </div>
      </div>

      {/* 刪除動作列 */}
      {showActions && !fixed && (
        <div className="flex border-t border-gray-100">
          <button
            onClick={() => setShowActions(false)}
            className="flex-1 py-2.5 text-xs text-gray-500 hover:bg-gray-50 transition-colors">
            取消
          </button>
          <div className="w-px bg-gray-100" />
          <button
            onClick={() => onDelete()}
            className="flex-1 py-2.5 text-xs text-red-500 hover:bg-red-50 transition-colors">
            刪除
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Sortable Watchlist Row ───────────────────────────────────────────────────

function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <circle cx="4" cy="3"  r="1.2" /><circle cx="10" cy="3"  r="1.2" />
      <circle cx="4" cy="7"  r="1.2" /><circle cx="10" cy="7"  r="1.2" />
      <circle cx="4" cy="11" r="1.2" /><circle cx="10" cy="11" r="1.2" />
    </svg>
  )
}

function SortableWatchlistRow({ item, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.symbol })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex:  isDragging ? 10 : 'auto',
    position: 'relative',
  }
  const handle = (
    <button
      {...attributes}
      {...listeners}
      className="text-gray-300 touch-none cursor-grab active:cursor-grabbing p-1 -ml-1"
      tabIndex={-1}
      onClick={e => e.stopPropagation()}
    >
      <GripIcon />
    </button>
  )
  return (
    <div ref={setNodeRef} style={style}>
      <WatchlistRow item={item} onDelete={onDelete} dragHandle={handle} />
    </div>
  )
}

// ─── 備份 / 還原 ─────────────────────────────────────────────────────────────

function BackupModal({ onClose }) {
  const fileInputRef = useRef(null)
  const [status, setStatus] = useState('')
  const isError = status.includes('錯誤')

  function exportBackup() {
    const today = new Date().toISOString().split('T')[0]
    const backup = {
      version: 1,
      exportedAt: today,
      holdings:   JSON.parse(localStorage.getItem('stock-holdings')      || '[]'),
      watchlist:  JSON.parse(localStorage.getItem('watchlist-stocks')     || '[]'),
      sortLocked: localStorage.getItem('watchlist-sort-locked') ?? 'true',
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `stock-app-backup-${today}.json`
    a.click()
    URL.revokeObjectURL(url)
    setStatus('備份已下載')
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result)
        if (!Array.isArray(data.holdings) || !Array.isArray(data.watchlist)) {
          setStatus('備份檔格式錯誤')
          return
        }
        localStorage.setItem('stock-holdings',      JSON.stringify(data.holdings))
        localStorage.setItem('watchlist-stocks',     JSON.stringify(data.watchlist))
        if (data.sortLocked !== undefined) {
          localStorage.setItem('watchlist-sort-locked', String(data.sortLocked))
        }
        setStatus('資料已恢復，即將重新載入...')
        setTimeout(() => window.location.reload(), 900)
      } catch {
        setStatus('備份檔格式錯誤')
      }
    }
    reader.readAsText(file)
    e.target.value = ''   // 允許重複選同一個檔
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end" onClick={onClose}>
      <div
        className="w-full max-w-md mx-auto bg-white rounded-t-2xl border-t border-gray-200 px-5 pt-5 pb-8"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-gray-800">資料備份</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {status && (
          <p className={`text-sm mb-4 px-3 py-2 rounded-xl
            ${isError ? 'text-red-600 bg-red-50' : 'text-green-700 bg-green-50'}`}>
            {status}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <button
            onClick={exportBackup}
            className="w-full py-3 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 transition-colors"
          >
            匯出備份
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFile}
          />
          <button
            onClick={() => fileInputRef.current.click()}
            className="w-full py-3 rounded-xl border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            匯入備份
          </button>
        </div>

        <p className="text-xs text-gray-400 mt-4 text-center">
          備份包含持股、自選股資料
        </p>
      </div>
    </div>
  )
}

// ─── 曝險模型 ─────────────────────────────────────────────────────────────────
// drawdown 為負數（例：-11.8 代表回檔 11.8%）
// 回傳建議正二持倉 %

function calcSuggestedLeverage(drawdown) {
  if (drawdown > -10) return 70   // 0% ~ -10%
  if (drawdown > -15) return 75   // -10% ~ -15%
  if (drawdown > -20) return 80   // -15% ~ -20%
  if (drawdown > -25) return 90   // -20% ~ -25%
  return 100                      // <= -25%
}


// ─── 曝險計算頁 ───────────────────────────────────────────────────────────────

function ExposurePage({ holdings, onExitAdvanced }) {
  const [cashInput,   setCashInput]   = useState(() => {
    const v = loadCash()
    return v > 0 ? String(v) : ''
  })
  const [targetInput, setTargetInput] = useState(() => {
    const saved = loadTargetExposure()
    return saved !== null ? saved : ''   // '' = 尚未初始化，等 TWII 載入後設定
  })
  const [twii,      setTwii]      = useState(null)
  const [twiiError, setTwiiError] = useState(false)

  useEffect(() => {
    async function init() {
      // 1. 抓目前指數
      let price = null
      try {
        price = await fetchTaiwanIndex()
        setTwii(price)
      } catch {
        setTwiiError(true)
      }

      // 2. 近一年高點：優先用今日快取，否則抓 12 個月歷史
      let yh = loadYearHighCache()
      if (yh === null) {
        try {
          yh = await fetchYearHigh()
        } catch {
          yh = loadIndexHigh()   // fallback：退回本機記錄
        }
      }

      // 3. 若今日指數超過歷史高點，更新（例如大漲創高）
      if (price !== null && yh !== null && price > yh) yh = price

      // 4. 寫入 localStorage
      if (yh !== null) {
        saveIndexHigh(yh)
        saveYearHighCache(yh)
      }

      // 5. 第一次進入：以當下建議曝險作為目標預設
      if (loadTargetExposure() === null && price !== null && yh !== null && yh > 0) {
        const dd     = ((price - yh) / yh) * 100
        const sugLev = calcSuggestedLeverage(dd)
        setTargetInput(String(sugLev))
        saveTargetExposure(sugLev)
      }
    }
    init()
  }, [])

  const cash = parseFloat(cashInput) || 0

  function handleCashBlur() {
    saveCash(parseFloat(cashInput) || 0)
  }

  function handleTargetBlur() {
    let v = parseFloat(targetInput)
    if (isNaN(v)) v = 70
    v = Math.max(0, Math.min(100, Math.round(v)))
    setTargetInput(String(v))
    saveTargetExposure(v)
  }

  const leveragedValue   = holdings
    .filter(h => LEVERAGED_SYMBOLS.includes(h.symbol))
    .reduce((sum, h) => sum + h.price * h.shares, 0)
  const totalMarketValue = holdings.reduce((sum, h) => sum + h.price * h.shares, 0)
  const totalAssets      = totalMarketValue + cash
  const leveragedPct     = totalAssets > 0 ? (leveragedValue / totalAssets) * 100 : 0
  const cashPct          = totalAssets > 0 ? (cash / totalAssets) * 100 : 0

  const yearHigh  = loadIndexHigh()
  const drawdown  = (twii !== null && yearHigh !== null && yearHigh > 0)
    ? ((twii - yearHigh) / yearHigh) * 100
    : null
  const sugLev    = drawdown !== null ? calcSuggestedLeverage(drawdown) : null
  const targetLev = Math.max(0, Math.min(100, parseFloat(targetInput) || 0))

  return (
    <div className="px-4 pt-12 pb-6">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold text-gray-800 tracking-wide">曝險計算</h1>
        <button
          onClick={onExitAdvanced}
          className="text-xs text-gray-500 border border-gray-300 hover:border-gray-400 rounded-lg px-2.5 py-1.5 transition-colors"
        >退出進階模式</button>
      </div>

      {/* A. 市場狀態 */}
      <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">市場狀態</p>
        <div className="space-y-2.5">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">台股近一年高點</span>
            <span className="text-sm font-medium text-gray-900">
              {yearHigh !== null ? formatNumber(Math.round(yearHigh)) : '--'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">目前台股</span>
            <span className="text-sm font-medium text-gray-900">
              {twiiError ? '無法取得' : twii !== null ? formatNumber(Math.round(twii)) : '載入中...'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">回檔幅度</span>
            <span className={`text-sm font-medium ${drawdown !== null && drawdown < 0 ? 'text-green-600' : 'text-gray-500'}`}>
              {drawdown !== null ? `${drawdown.toFixed(2)}%` : '--'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">建議正二曝險</span>
            <span className="text-sm font-medium text-gray-900">
              {sugLev !== null ? `${sugLev}%` : '--'}
            </span>
          </div>
        </div>
      </div>

      {/* B. 我的資產 */}
      <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">我的資產</p>
        <div className="mb-3">
          <label className="text-sm text-gray-600 block mb-1.5">現金（手動輸入）</label>
          <input
            type="number"
            value={cashInput}
            onChange={e => setCashInput(e.target.value)}
            onBlur={handleCashBlur}
            placeholder="0"
            min="0"
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-gray-400"
          />
        </div>
        <div className="space-y-2.5 pt-3 border-t border-gray-100">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">現金</span>
            <span className="text-sm font-medium text-gray-900">
              {formatNumber(Math.round(cash))}
              <span className="text-xs text-gray-400 ml-1.5">({cashPct.toFixed(1)}%)</span>
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">全部持股市值</span>
            <span className="text-sm font-medium text-gray-900">
              {formatNumber(Math.round(totalMarketValue))}
              <span className="text-xs text-gray-400 ml-1.5">({leveragedPct.toFixed(1)}%)</span>
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">總資產</span>
            <span className="text-base font-semibold text-gray-900">{formatNumber(Math.round(totalAssets))}</span>
          </div>
        </div>
      </div>

      {/* D. 目標曝險（使用者主觀設定） */}
      <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">目標曝險</p>
        <p className="text-xs text-gray-400 mb-3">你自己決定的正二曝險目標</p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={targetInput}
            onChange={e => setTargetInput(e.target.value)}
            onBlur={handleTargetBlur}
            placeholder="70"
            min="0"
            max="100"
            className="w-24 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 text-center focus:outline-none focus:border-gray-400"
          />
          <span className="text-sm text-gray-600">% 正二</span>
        </div>
      </div>

      {/* E. 再平衡建議（依據目標曝險計算） */}
      {(() => {
        if (targetInput === '') {
          return (
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">再平衡建議</p>
              <p className="text-sm text-gray-500">暫時無法計算</p>
            </div>
          )
        }
        const diff         = targetLev - leveragedPct          // 百分比差距
        const targetLevAmt = totalAssets * (targetLev / 100)
        const diffAmt      = Math.round(Math.abs(targetLevAmt - leveragedValue))
        const isSmall      = Math.abs(diff) < 3.0

        let label, labelColor, amtLine
        if (isSmall) {
          label      = '目前曝險已接近目標'
          labelColor = 'text-gray-700'
          amtLine    = '不需調整部位'
        } else if (diff > 0) {
          label      = `距目標還需加碼 +${diff.toFixed(1)}% 正二`
          labelColor = 'text-red-500'
          amtLine    = `建議增加正二部位：NT$ ${formatNumber(diffAmt)}`
        } else {
          label      = `正二曝險高於目標 ${Math.abs(diff).toFixed(1)}%`
          labelColor = 'text-green-600'
          amtLine    = `建議減少正二部位：NT$ ${formatNumber(diffAmt)}`
        }
        return (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">再平衡建議</p>
            <p className={`text-sm font-semibold ${labelColor}`}>{label}</p>
            <p className="text-sm text-gray-500 mt-1.5">{amtLine}</p>
          </div>
        )
      })()}
    </div>
  )
}

// ─── 績效 / XIRR 頁 ───────────────────────────────────────────────────────────

function PerformancePage({ onExitAdvanced }) {
  const [snap, setSnap] = useState(loadSnapshot)
  const cashflows = loadCashflows()

  function handleSnapChange(field, value) {
    const next = { ...snap, [field]: value }
    setSnap(next)
    saveSnapshot(next)
  }

  const tw    = parseFloat(snap.twStockValue)    || 0
  const us    = parseFloat(snap.usStockValue)    || 0
  const cash  = parseFloat(snap.cashValue)       || 0
  const other = parseFloat(snap.otherAssetsValue)|| 0
  const total = tw + us + cash + other

  return (
    <div className="px-4 pt-12 pb-6">
      {/* 標題列 + 退出按鈕 */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold text-gray-800 tracking-wide">績效 / XIRR</h1>
        <button
          onClick={onExitAdvanced}
          className="text-xs text-gray-500 border border-gray-300 hover:border-gray-400 rounded-lg px-2.5 py-1.5 transition-colors"
        >退出進階模式</button>
      </div>

      {/* 1. 績效摘要卡 */}
      <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">績效摘要</p>
        <div className="space-y-2.5">
          {[
            ['目前總資產',     total > 0 ? formatNumber(Math.round(total)) : '--'],
            ['累計淨入金',     '--'],
            ['累計已實現損益', '--'],
            ['XIRR',          '--'],
            ['近 30 天報酬',  '--'],
            ['年化報酬率',    '--'],
          ].map(([label, val]) => (
            <div key={label} className="flex justify-between items-center">
              <span className="text-sm text-gray-600">{label}</span>
              <span className="text-sm font-medium text-gray-900">{val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 2. 資產快照卡 */}
      <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">資產快照（手動輸入）</p>
        <div className="space-y-3">
          {[
            { label: '台股目前市值', field: 'twStockValue', placeholder: '0' },
            { label: '美股目前市值', field: 'usStockValue', placeholder: '0' },
            { label: '現金',         field: 'cashValue',    placeholder: '0' },
            { label: '其他資產',     field: 'otherAssetsValue', placeholder: '0（可選）' },
          ].map(({ label, field, placeholder }) => (
            <div key={field} className="flex items-center gap-3">
              <label className="text-sm text-gray-600 w-32 shrink-0">{label}</label>
              <input
                type="number"
                value={snap[field]}
                onChange={e => handleSnapChange(field, e.target.value)}
                placeholder={placeholder}
                min="0"
                className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-gray-400"
              />
            </div>
          ))}
        </div>
        <div className="flex justify-between items-center mt-3 pt-3 border-t border-gray-100">
          <span className="text-sm font-medium text-gray-700">總資產</span>
          <span className="text-base font-semibold text-gray-900">
            {total > 0 ? formatNumber(Math.round(total)) : '--'}
          </span>
        </div>
      </div>

      {/* 3. 現金流紀錄卡 */}
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">現金流紀錄</p>
        {cashflows.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-gray-400">尚無紀錄</p>
            <p className="text-xs text-gray-300 mt-1">請新增入金 / 出金 / 已實現損益紀錄</p>
          </div>
        ) : (
          <div className="space-y-2">
            {cashflows.map(cf => (
              <div key={cf.id} className="flex justify-between items-center py-1.5">
                <div>
                  <p className="text-sm text-gray-800">{cf.type}</p>
                  <p className="text-xs text-gray-400">{cf.date}{cf.note ? ` · ${cf.note}` : ''}</p>
                </div>
                <span className={`text-sm font-medium ${cf.amount >= 0 ? 'text-red-500' : 'text-green-600'}`}>
                  {cf.amount >= 0 ? '+' : ''}{formatNumber(cf.amount)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 底部導覽列 ───────────────────────────────────────────────────────────────

function BottomNav({ activePage, onNavigate, advancedMode }) {
  const normalTabs = [
    {
      id: 'portfolio',
      label: '我的持股',
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

  const advancedTabs = [
    {
      id: 'exposure',
      label: '曝險計算',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6"  y1="20" x2="6"  y2="14" />
        </svg>
      ),
    },
    {
      id: 'performance',
      label: '績效/XIRR',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
    },
  ]

  const tabs = advancedMode ? advancedTabs : normalTabs

  return (
    <div className={`fixed bottom-0 left-0 right-0 z-40 max-w-md mx-auto border-t bg-white ${advancedMode ? 'border-indigo-100' : 'border-gray-200'}`}>
      <div className="flex">
        {tabs.map(tab => {
          const isActive = activePage === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => onNavigate(tab.id)}
              className={`flex-1 flex flex-col items-center justify-center py-2.5 gap-1 transition-colors
                ${isActive
                  ? (advancedMode ? 'text-indigo-600' : 'text-gray-900')
                  : 'text-gray-300'}`}
            >
              {tab.icon}
              <span className="text-[10px] font-medium tracking-wide">{tab.label}</span>
              {isActive && (
                <span className={`absolute bottom-1 w-1 h-1 rounded-full ${advancedMode ? 'bg-indigo-500' : 'bg-gray-900'}`} />
              )}
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
  const [showBackup,    setShowBackup]    = useState(false)
  const [advancedMode,  setAdvancedMode]  = useState(
    () => localStorage.getItem(ADVANCED_MODE_KEY) === 'true'
  )
  const [normalTab, setNormalTab] = useState(() => {
    const saved = localStorage.getItem(NORMAL_TAB_KEY)
    return (saved === 'portfolio' || saved === 'watchlist') ? saved : 'portfolio'
  })
  const [advancedTab, setAdvancedTab] = useState(() => {
    const saved = localStorage.getItem(ADVANCED_TAB_KEY)
    return (saved === 'exposure' || saved === 'performance') ? saved : 'exposure'
  })
  const activePage = advancedMode ? advancedTab : normalTab
  const [toast, setToast] = useState('')

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

  const prevPageRef = useRef(activePage)
  useEffect(() => {
    if (prevPageRef.current !== 'portfolio' && activePage === 'portfolio') {
      refreshPrices(loadHoldings())
    }
    prevPageRef.current = activePage
  }, [normalTab, advancedTab, advancedMode]) // eslint-disable-line react-hooks/exhaustive-deps

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

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2000)
  }

  function handleTitleLongPress() {
    const next = !advancedMode
    setAdvancedMode(next)
    localStorage.setItem(ADVANCED_MODE_KEY, String(next))
    if (next) {
      setAdvancedTab('exposure')
      localStorage.setItem(ADVANCED_TAB_KEY, 'exposure')
      showToast('已開啟進階模式')
    } else {
      setNormalTab('portfolio')
      localStorage.setItem(NORMAL_TAB_KEY, 'portfolio')
      showToast('已關閉進階模式')
    }
  }

  function handleExitAdvanced() {
    setAdvancedMode(false)
    localStorage.setItem(ADVANCED_MODE_KEY, 'false')
    setNormalTab('portfolio')
    localStorage.setItem(NORMAL_TAB_KEY, 'portfolio')
    showToast('已關閉進階模式')
  }

  return (
    <div className="min-h-screen max-w-md mx-auto pb-24 bg-gray-50">

      {/* ── 庫存頁 ── */}
      {activePage === 'portfolio' && (
        <>
          <TopBar
            lastUpdated={lastUpdated}
            isFetching={isFetching}
            onRefresh={() => refreshPrices(holdings)}
            onBackup={() => setShowBackup(true)}
            onLongPress={handleTitleLongPress}
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

      {/* ── 曝險計算頁 ── */}
      {activePage === 'exposure' && <ExposurePage holdings={holdings} onExitAdvanced={handleExitAdvanced} />}

      {/* ── 績效 / XIRR 頁 ── */}
      {activePage === 'performance' && <PerformancePage onExitAdvanced={handleExitAdvanced} />}

      {/* ── 新增 / 編輯 Modal ── */}
      {modal === 'add' && (
        <HoldingForm initial={null} onSave={handleAdd} onCancel={() => setModal(null)} />
      )}
      {typeof modal === 'number' && (
        <HoldingForm initial={holdings[modal]} onSave={handleEdit} onCancel={() => setModal(null)} />
      )}

      {/* ── 備份 Modal ── */}
      {showBackup && <BackupModal onClose={() => setShowBackup(false)} />}

      {/* ── 底部導覽 ── */}
      <BottomNav
        activePage={activePage}
        advancedMode={advancedMode}
        onNavigate={page => {
          if (advancedMode) {
            setAdvancedTab(page)
            localStorage.setItem(ADVANCED_TAB_KEY, page)
          } else {
            setNormalTab(page)
            localStorage.setItem(NORMAL_TAB_KEY, page)
          }
        }}
      />

      {/* ── Toast 提示 ── */}
      {toast && (
        <div className="fixed top-16 inset-x-0 z-50 flex justify-center pointer-events-none">
          <div className="bg-gray-800/90 text-white text-sm px-5 py-2 rounded-full shadow-lg">
            {toast}
          </div>
        </div>
      )}
    </div>
  )
}
