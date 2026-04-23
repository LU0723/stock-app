import { useState, useEffect, useRef, useMemo } from 'react'
import { calculateXIRR } from './utils/xirr'
import { getMonthlyReturns, getCumulativeReturn } from './utils/performance'
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
  { symbol: '0050', name: '元大台灣50', shares: 1000, avgCost: 75,   price: 0, yesterdayClose: 0, buyDate: '2025-12-01', changes: [{ date: '2025-12-01', shares: 1000, avgCost: 75   }] },
  { symbol: '2330', name: '台積電',     shares: 1000, avgCost: 1820, price: 0, yesterdayClose: 0, buyDate: '2025-12-01', changes: [{ date: '2025-12-01', shares: 1000, avgCost: 1820 }] },
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
const PERF_CASHFLOWS_KEY  = 'performance-cashflows'
const NORMAL_TAB_KEY      = 'normalTab'
const ADVANCED_TAB_KEY    = 'advancedTab'
const MONTHLY_LEDGER_KEY  = 'performance-monthly-ledger'
const US_ACCOUNT_NAMES_KEY = 'us-account-names'
const DEFAULT_US_NAMES     = ['美股帳戶 1', '美股帳戶 2', '美股帳戶 3']
const US_HOLDINGS_KEY      = 'us-holdings'

// 正二曝險標的，未來可在此擴充
const LEVERAGED_SYMBOLS = ['00631L', '00675L', '00685L', '00663L']

function loadSortLocked() {
  return localStorage.getItem(SORT_LOCK_KEY) !== 'false'
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function migrateHolding(h) {
  if (Array.isArray(h.changes) && h.changes.length > 0) return h
  const date = h.buyDate || todayStr()
  return { ...h, changes: [{ date, shares: h.shares, avgCost: h.avgCost }] }
}

function migrateUsHolding(h) {
  if (Array.isArray(h.changes) && h.changes.length > 0) return h
  return { ...h, changes: [{ date: todayStr(), shares: h.shares, avgCost: h.avgCost }] }
}

function applyChange(existing, shares, avgCost) {
  const today = todayStr()
  const prev  = existing.changes ?? [{ date: existing.buyDate || today, shares: existing.shares, avgCost: existing.avgCost }]
  const last  = prev[prev.length - 1]
  const changes = (last && last.date === today)
    ? [...prev.slice(0, -1), { date: today, shares, avgCost }]
    : [...prev,              { date: today, shares, avgCost }]
  return { ...existing, shares, avgCost, changes }
}

function loadHoldings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved).map(migrateHolding)
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

function loadUsHoldings() {
  try {
    const saved = localStorage.getItem(US_HOLDINGS_KEY)
    if (saved) return JSON.parse(saved).map(migrateUsHolding)
  } catch {}
  return []
}

function saveUsHoldings(holdings) {
  localStorage.setItem(US_HOLDINGS_KEY, JSON.stringify(holdings))
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

// ─── Monthly Ledger（新版資料模型）──────────────────────────────────────────
// 格式：{ "2026-04": { cashflows: [...], snapshot: { tw: {...}, us: {...}, savedAt } } }

function migrateSnapshot(snap) {
  if (!snap) return null
  // 已是新格式（有 tw 子物件）
  if (snap.tw) return snap
  // 舊格式（直接有 totalAssets）→ 轉換為雙帳本
  return {
    tw: {
      stockValue:  snap.twStockValue ?? 0,
      cashValue:   snap.cashValue    ?? 0,
      totalAssets: (snap.twStockValue ?? 0) + (snap.cashValue ?? 0),
    },
    us: {
      usAccount1Value: snap.usStockValue ?? 0,
      usAccount2Value: 0,
      usAccount3Value: 0,
      totalAssets: snap.usStockValue ?? 0,
    },
    savedAt: snap.savedAt ?? null,
  }
}

function loadLedger() {
  let ledger = {}
  try {
    const saved = localStorage.getItem(MONTHLY_LEDGER_KEY)
    if (saved) ledger = JSON.parse(saved)
  } catch {}

  if (Object.keys(ledger).length === 0) {
    // 若舊版 cashflows 存在，遷移至當前月份（安全、不強制覆蓋）
    try {
      const raw = localStorage.getItem(PERF_CASHFLOWS_KEY)
      if (raw) {
        const oldCfs = JSON.parse(raw)
        if (Array.isArray(oldCfs) && oldCfs.length > 0) {
          const monthKey = new Date().toISOString().slice(0, 7)
          ledger[monthKey] = { cashflows: oldCfs, snapshot: null }
        }
      }
    } catch {}
    return ledger
  }

  // 遷移舊版 snapshot 格式（有 totalAssets 但沒有 tw 子物件）
  for (const [month, data] of Object.entries(ledger)) {
    const snap = data?.snapshot
    if (snap && !snap.tw) {
      ledger[month] = { ...data, snapshot: migrateSnapshot(snap) }
    }
  }

  // 遷移舊版美股 key（schwabValue/etoroValue/futoValue → usAccount1/2/3Value）
  let migrated = false
  for (const [month, data] of Object.entries(ledger)) {
    const us = data?.snapshot?.us
    if (us && 'schwabValue' in us) {
      const { schwabValue, etoroValue, futoValue, ...rest } = us
      ledger[month] = {
        ...data,
        snapshot: {
          ...data.snapshot,
          us: {
            ...rest,
            usAccount1Value: schwabValue ?? 0,
            usAccount2Value: etoroValue  ?? 0,
            usAccount3Value: futoValue   ?? 0,
          },
        },
      }
      migrated = true
    }
  }
  if (migrated) saveLedger(ledger)

  return ledger
}
function saveLedger(ledger) {
  localStorage.setItem(MONTHLY_LEDGER_KEY, JSON.stringify(ledger))
}
function loadUsAccountNames() {
  try {
    const saved = localStorage.getItem(US_ACCOUNT_NAMES_KEY)
    if (saved) {
      const arr = JSON.parse(saved)
      if (Array.isArray(arr) && arr.length === 3 && arr.every(s => typeof s === 'string')) return arr
    }
  } catch {}
  return [...DEFAULT_US_NAMES]
}
function saveUsAccountNames(names) {
  localStorage.setItem(US_ACCOUNT_NAMES_KEY, JSON.stringify(names))
}

// ─── 月份選項（近 12 個月）──────────────────────────────────────────────────
function getMonthOptions() {
  const options = []
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
    options.push({ key, label })
  }
  return options
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

// ─── 美股報價 API（Yahoo Finance，約 15 分鐘延遲）─────────────────────────────
// 回傳：{ [symbol]: { name, price, previousClose, marketState } }
// price        = regularMarketPrice（正式盤，不含 pre/post market）
// previousClose = 上一個正式盤收盤價（今日漲跌幅基準）
// marketState  = 'PRE' | 'REGULAR' | 'POST' | 'UNKNOWN'（由伺服器從時間戳推算）
async function fetchUsStockMap(symbols) {
  if (symbols.length === 0) return {}
  const res = await fetch(`/api/us-stock?symbols=${symbols.join(',')}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`US API 錯誤：${res.status}`)
  return await res.json()
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

// ─── 美股計算邏輯 ─────────────────────────────────────────────────────────────

function calcUsStock(h) {
  const hasPrevClose = h.previousClose != null && h.previousClose !== 0
  return {
    symbol: h.symbol,
    name:   h.name,
    shares: h.shares,
    avgCost: h.avgCost,
    price:  h.price,
    // 今日漲跌 %：只用 previousClose 計算，絕不使用 avgCost
    changePercent: (h.price > 0 && hasPrevClose)
      ? ((h.price - h.previousClose) / h.previousClose) * 100
      : null,
    todayPnL: (h.price > 0 && hasPrevClose)
      ? (h.price - h.previousClose) * h.shares
      : 0,
    // 累積報酬 %：只用 avgCost 計算，與今日漲跌完全分離
    totalPnL:   (h.price > 0 && h.avgCost > 0) ? (h.price - h.avgCost) * h.shares : 0,
    returnRate: (h.price > 0 && h.avgCost > 0) ? ((h.price - h.avgCost) / h.avgCost) * 100 : 0,
  }
}

function calcUsSummary(stocks, holdings) {
  if (holdings.length === 0) {
    return { todayPnL: 0, todayPnLPercent: 0, totalPnL: 0, totalPnLPercent: 0, marketValue: 0, totalCost: 0 }
  }
  const totalCost      = holdings.reduce((sum, h) => sum + h.avgCost       * h.shares, 0)
  const marketValue    = holdings.reduce((sum, h) => sum + h.price         * h.shares, 0)
  const previousValue  = holdings.reduce((sum, h) => sum + h.previousClose * h.shares, 0)
  const todayPnL       = stocks.reduce((sum, s) => sum + s.todayPnL, 0)
  const totalPnL       = stocks.reduce((sum, s) => sum + s.totalPnL, 0)
  return {
    todayPnL,
    todayPnLPercent: previousValue > 0 ? (todayPnL / previousValue) * 100 : 0,
    totalPnL,
    totalPnLPercent: totalCost > 0 ? (totalPnL / totalCost) * 100 : 0,
    marketValue,
    totalCost,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNumber(n) {
  return n.toLocaleString('zh-TW')
}

function fmtUsd(n) {
  return Number(n).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
  if (value == null) return null
  const sign = value > 0 ? '+' : ''
  return <span className={`${twColor(value)} ${className}`}>{sign}{value.toFixed(2)}%</span>
}

// ─── Top Bar ──────────────────────────────────────────────────────────────────

function TopBar({ lastUpdated, isFetching, onRefresh, onBackup, onLongPress }) {
  const timerRef = useRef(null)

  function startPress() {
    timerRef.current = setTimeout(() => { onLongPress() }, 1200)
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
      >台股持股 (TWD)</h1>
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
    buyDate: initial?.buyDate ?? new Date().toISOString().slice(0, 10),
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
      buyDate: form.buyDate || new Date().toISOString().slice(0, 10),
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
          <div>
            <label className="text-xs text-white mb-1 block">開倉日期</label>
            <input type="date" value={form.buyDate} onChange={e => set('buyDate', e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#555]" />
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
          <button
            onClick={() => stock.code && window.open(`https://tw.stock.yahoo.com/quote/${stock.code}.TW/technical-analysis`, '_blank', 'noopener,noreferrer')}
            className="flex-1 py-2.5 text-xs text-blue-500 hover:bg-blue-50 transition-colors">K線</button>
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
            onClick={() => item.symbol && window.open(`https://tw.stock.yahoo.com/quote/${item.symbol}.TW/technical-analysis`, '_blank', 'noopener,noreferrer')}
            className="flex-1 py-2.5 text-xs text-blue-500 hover:bg-blue-50 transition-colors">
            K線
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

// 驗證 performanceMonthlyLedger 格式
// 回傳 true = 合法（或空物件），false = 格式有問題
function isValidLedger(ledger) {
  if (typeof ledger !== 'object' || ledger === null || Array.isArray(ledger)) return false
  const monthRe = /^\d{4}-\d{2}$/
  for (const [key, val] of Object.entries(ledger)) {
    if (!monthRe.test(key)) return false
    if (typeof val !== 'object' || val === null) return false
    if (!('cashflows' in val) || !('snapshot' in val)) return false
    if (!Array.isArray(val.cashflows)) return false
  }
  return true
}

function BackupModal({ onClose }) {
  const fileInputRef = useRef(null)
  const [status, setStatus] = useState('')
  const isError = status.startsWith('錯誤')

  function exportBackup() {
    const now    = new Date()
    const today  = now.toISOString().split('T')[0]

    // 讀取 performanceMonthlyLedger（不存在時回傳空物件，不 crash）
    let ledger = {}
    try {
      const raw = localStorage.getItem(MONTHLY_LEDGER_KEY)
      if (raw) ledger = JSON.parse(raw)
    } catch {}

    let usAccountNames = {}
    try {
      const raw = localStorage.getItem(US_ACCOUNT_NAMES_KEY)
      if (raw) usAccountNames = JSON.parse(raw)
    } catch {}

    const backup = {
      version:    4,
      exportedAt: now.toISOString(),
      holdings:   JSON.parse(localStorage.getItem(STORAGE_KEY)     || '[]'),
      watchlist:  JSON.parse(localStorage.getItem(WATCHLIST_KEY)   || '[]'),
      sortLocked: localStorage.getItem(SORT_LOCK_KEY) ?? 'true',
      performanceMonthlyLedger: ledger,
      // 美股持股（v3+）
      usHoldings:     JSON.parse(localStorage.getItem(US_HOLDINGS_KEY) || '[]'),
      usAccountNames,
      // 進階功能曝險設定（v3+）
      exposureCash:   localStorage.getItem(CASH_KEY)            ?? null,
      exposureTarget: localStorage.getItem(TARGET_EXPOSURE_KEY) ?? null,
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

        // 基本欄位驗證（與舊版相容：holdings / watchlist 必須為陣列）
        if (!Array.isArray(data.holdings) || !Array.isArray(data.watchlist)) {
          setStatus('錯誤：備份檔格式不正確（holdings / watchlist 欄位異常）')
          return
        }

        // 還原台股持股 + 自選股（必要欄位）
        localStorage.setItem(STORAGE_KEY,   JSON.stringify(data.holdings.map(migrateHolding)))
        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(data.watchlist))
        if (data.sortLocked !== undefined) {
          localStorage.setItem(SORT_LOCK_KEY, String(data.sortLocked))
        }

        // 還原進階記帳資料（v2+ 才有；舊版備份缺少此欄位時直接跳過）
        if (data.performanceMonthlyLedger !== undefined) {
          if (!isValidLedger(data.performanceMonthlyLedger)) {
            setStatus('持股 / 自選股已還原，但進階記帳格式異常，略過還原。即將重新載入...')
            setTimeout(() => window.location.reload(), 1500)
            return
          }
          localStorage.setItem(MONTHLY_LEDGER_KEY, JSON.stringify(data.performanceMonthlyLedger))
        }

        // 還原美股持股（v3+；舊版備份無此欄位時略過，不清除現有資料）
        if (Array.isArray(data.usHoldings)) {
          localStorage.setItem(US_HOLDINGS_KEY, JSON.stringify(data.usHoldings.map(migrateUsHolding)))
        }
        if (data.usAccountNames !== undefined && typeof data.usAccountNames === 'object') {
          localStorage.setItem(US_ACCOUNT_NAMES_KEY, JSON.stringify(data.usAccountNames))
        }

        // 還原進階功能曝險設定（v3+；有值才寫入，避免用 null 覆蓋現有資料）
        if (data.exposureCash   != null) localStorage.setItem(CASH_KEY,            String(data.exposureCash))
        if (data.exposureTarget != null) localStorage.setItem(TARGET_EXPOSURE_KEY,  String(data.exposureTarget))

        setStatus('資料已恢復，即將重新載入...')
        setTimeout(() => window.location.reload(), 900)
      } catch {
        setStatus('錯誤：無法解析備份檔，請確認檔案格式正確')
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
          備份包含持股 / 自選股 / 進階記帳資料
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

// ─── 現金流新增表單（兩頁共用）────────────────────────────────────────────────

function CashflowForm({ onSave, onCancel, selectedMonth }) {
  // 限制日期在選定月份內
  const [selYear, selMon] = (selectedMonth ?? '').split('-').map(Number)
  const minDate   = selectedMonth ? `${selectedMonth}-01` : ''
  const lastDay   = selectedMonth ? new Date(selYear, selMon, 0).getDate() : 31
  const maxDate   = selectedMonth ? `${selectedMonth}-${String(lastDay).padStart(2, '0')}` : ''
  // 預設日期：若今天在選定月份內則用今天，否則用月份第一天
  const today     = new Date().toISOString().split('T')[0]
  const initDate  = (minDate && maxDate && today >= minDate && today <= maxDate) ? today : (minDate || today)
  const [date,       setDate]       = useState(initDate)
  const [type,       setType]       = useState('入金')
  const [amount,     setAmount]     = useState('')
  const [note,       setNote]       = useState('')
  const [ledgerType, setLedgerType] = useState('tw')

  function handleSubmit(e) {
    e.preventDefault()
    const amt = parseFloat(amount)
    if (!date || isNaN(amt) || amt <= 0) return
    onSave({
      id:         `cf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date,
      type,
      amount:     amt,
      note:       note.trim(),
      ledgerType,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end">
      <div className="w-full max-w-md mx-auto bg-[#1c1c1c] rounded-t-2xl border-t border-[#2a2a2a] p-5">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-white">新增現金流紀錄</h2>
          <button onClick={onCancel} className="text-white p-1">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-white mb-1 block">日期</label>
            <input
              type="date"
              value={date}
              min={minDate || undefined}
              max={maxDate || undefined}
              onChange={e => setDate(e.target.value)}
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#555]"
            />
          </div>
          <div>
            <label className="text-xs text-white mb-1 block">帳本</label>
            <select
              value={ledgerType}
              onChange={e => setLedgerType(e.target.value)}
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#555]"
            >
              <option value="tw">台股（TWD）</option>
              <option value="us">美股（USD）</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-white mb-1 block">類型</label>
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#555]"
            >
              <option value="入金">入金（投入資金）</option>
              <option value="出金">出金（提出資金）</option>
              <option value="已實現損益">已實現損益</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-white mb-1 block">金額（正整數）</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="例：100000"
              min="0.01"
              step="0.01"
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]"
            />
          </div>
          <div>
            <label className="text-xs text-white mb-1 block">備註（可選）</label>
            <input
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="例：定期定額、年終獎金"
              className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]"
            />
          </div>
          <div className="flex gap-2 mt-1">
            <button type="button" onClick={onCancel}
              className="flex-1 py-2.5 rounded-xl border border-[#333] text-white text-sm">取消</button>
            <button type="submit" disabled={!date || !amount}
              className="flex-1 py-2.5 rounded-xl bg-white text-black text-sm font-medium disabled:opacity-50">新增</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── 每月記帳頁（第 4 頁）────────────────────────────────────────────────────

const MONTH_OPTIONS = getMonthOptions()

// 現金流列表（LedgerPage / PerformancePage 共用的 render 邏輯）
function CashflowList({ cashflows, onDelete }) {
  if (cashflows.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm text-gray-400">尚無紀錄</p>
        <p className="text-xs text-gray-300 mt-1">請新增入金 / 出金 / 已實現損益</p>
      </div>
    )
  }
  return (
    <div className="divide-y divide-gray-100">
      {[...cashflows].sort((a, b) => b.date.localeCompare(a.date)).map(cf => (
        <div key={cf.id} className="flex items-center justify-between py-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                cf.ledgerType === 'us' ? 'bg-orange-50 text-orange-500' : 'bg-sky-50 text-sky-600'
              }`}>{cf.ledgerType === 'us' ? 'USD' : 'TWD'}</span>
              <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${
                cf.type === '入金'  ? 'bg-blue-50 text-blue-600' :
                cf.type === '出金'  ? 'bg-gray-100 text-gray-600' :
                'bg-green-50 text-green-700'
              }`}>{cf.type}</span>
              <span className="text-xs text-gray-400">{cf.date}</span>
            </div>
            {cf.note && <p className="text-xs text-gray-400 mt-0.5 truncate">{cf.note}</p>}
          </div>
          <div className="flex items-center gap-2 ml-2 shrink-0">
            <span className={`text-sm font-medium tabular-nums ${
              cf.type === '入金' ? 'text-gray-600' :
              cf.type === '出金' ? 'text-green-600' : 'text-red-500'
            }`}>
              {cf.type === '入金' ? '-' : '+'}{cf.ledgerType === 'us'
                ? fmtUsd(Math.abs(Number(cf.amount)))
                : formatNumber(Math.round(Math.abs(Number(cf.amount))))}
            </span>
            {onDelete && (
              <button
                onClick={() => onDelete(cf.id)}
                className="text-gray-300 hover:text-red-400 transition-colors p-1"
                title="刪除"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14H6L5 6"/>
                  <path d="M10 11v6M14 11v6"/>
                  <path d="M9 6V4h6v2"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function getCurrentMonthKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function LedgerPage({ onExitAdvanced }) {
  const [ledger,        setLedger]        = useState(loadLedger)
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthKey)
  const [snapInputs,    setSnapInputs]    = useState({
    tw: { stockValue: '', cashValue: '' },
    us: { usAccount1Value: '', usAccount2Value: '', usAccount3Value: '' },
  })
  const [showForm,     setShowForm]     = useState(false)
  const [savedMsg,     setSavedMsg]     = useState(false)
  const [note,         setNote]         = useState('')
  const [usNames,      setUsNames]      = useState(loadUsAccountNames)
  const [editingNames, setEditingNames] = useState(false)
  const [nameInputs,   setNameInputs]   = useState(loadUsAccountNames)

  // mount 時：若本月份尚未建立，自動補建空資料（只執行一次）
  useEffect(() => {
    const currentMonth = getCurrentMonthKey()
    if (!ledger[currentMonth]) {
      const next = { ...ledger, [currentMonth]: { cashflows: [], snapshot: null } }
      setLedger(next)
      saveLedger(next)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 月份切換時，從 ledger 讀入該月快照與心得
  useEffect(() => {
    setNote(ledger[selectedMonth]?.note ?? '')
    const snap = ledger[selectedMonth]?.snapshot
    setSnapInputs(snap?.tw
      ? {
          tw: { stockValue: snap.tw.stockValue ?? '', cashValue: snap.tw.cashValue ?? '' },
          us: { usAccount1Value: snap.us?.usAccount1Value ?? '', usAccount2Value: snap.us?.usAccount2Value ?? '', usAccount3Value: snap.us?.usAccount3Value ?? '' },
        }
      : {
          tw: { stockValue: '', cashValue: '' },
          us: { usAccount1Value: '', usAccount2Value: '', usAccount3Value: '' },
        }
    )
  }, [selectedMonth]) // eslint-disable-line react-hooks/exhaustive-deps

  const monthData = ledger[selectedMonth] || { cashflows: [], snapshot: null }
  const cashflows = Array.isArray(monthData.cashflows) ? monthData.cashflows : []

  // ── 台股計算 ──
  const twStock = parseFloat(snapInputs.tw.stockValue) || 0
  const twCash  = parseFloat(snapInputs.tw.cashValue)  || 0
  const twTotal = twStock + twCash

  // ── 美股計算 ──
  const usSchwab = parseFloat(snapInputs.us.usAccount1Value) || 0
  const usEtoro  = parseFloat(snapInputs.us.usAccount2Value) || 0
  const usFuto   = parseFloat(snapInputs.us.usAccount3Value) || 0
  const usTotal  = usSchwab + usEtoro + usFuto

  function updateLedger(next) { setLedger(next); saveLedger(next) }

  function handleAddCashflow(cf) {
    const existing = ledger[selectedMonth] || { cashflows: [], snapshot: null }
    const next = { ...ledger, [selectedMonth]: {
      ...existing,
      cashflows: [...existing.cashflows, cf].sort((a, b) => a.date.localeCompare(b.date)),
    }}
    updateLedger(next)
    setShowForm(false)
  }

  function handleDeleteCashflow(id) {
    if (!window.confirm('確定刪除這筆紀錄？')) return
    const existing = ledger[selectedMonth] || { cashflows: [], snapshot: null }
    const next = { ...ledger, [selectedMonth]: {
      ...existing,
      cashflows: existing.cashflows.filter(cf => cf.id !== id),
    }}
    updateLedger(next)
  }

  function handleSaveSnapshot() {
    const snap = {
      tw: { stockValue: twStock, cashValue: twCash, totalAssets: twTotal },
      us: { usAccount1Value: usSchwab, usAccount2Value: usEtoro, usAccount3Value: usFuto, totalAssets: usTotal },
      savedAt: new Date().toISOString(),
    }
    const existing = ledger[selectedMonth] || { cashflows: [], snapshot: null }
    const next = { ...ledger, [selectedMonth]: { ...existing, snapshot: snap, note: note.trim() || undefined } }
    updateLedger(next)
    setSavedMsg(true)
    setTimeout(() => setSavedMsg(false), 2000)
  }

  function setTwField(field, val) {
    setSnapInputs(prev => ({ ...prev, tw: { ...prev.tw, [field]: val } }))
  }
  function setUsField(field, val) {
    setSnapInputs(prev => ({ ...prev, us: { ...prev.us, [field]: val } }))
  }

  return (
    <div className="px-4 pt-12 pb-6">
      {/* 標題列 + 退出按鈕 */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold text-gray-800 tracking-wide">每月記帳</h1>
        <button onClick={onExitAdvanced}
          className="text-xs text-gray-500 border border-gray-300 hover:border-gray-400 rounded-lg px-2.5 py-1.5 transition-colors"
        >退出進階模式</button>
      </div>

      {/* 1. 月份選擇卡 */}
      <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">選擇月份</p>
        <select
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 bg-white focus:outline-none focus:border-gray-400"
        >
          {MONTH_OPTIONS.map(o => (
            <option key={o.key} value={o.key}>
              {o.label}{ledger[o.key]?.cashflows?.length > 0 ? ` (${ledger[o.key].cashflows.length} 筆)` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* 2. 月底資產快照卡 */}
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-4">月底資產快照</p>

        {/* 台股帳本（TWD）*/}
        <div className="mb-4">
          <p className="text-xs font-semibold text-sky-600 mb-2.5">台股帳本（TWD）</p>
          <div className="space-y-2.5">
            {[
              { label: '台股目前市值', field: 'stockValue' },
              { label: '證券戶現金',   field: 'cashValue'  },
            ].map(({ label, field }) => (
              <div key={field} className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-28 shrink-0">{label}</label>
                <input
                  type="number"
                  value={snapInputs.tw[field]}
                  onChange={e => setTwField(field, e.target.value)}
                  placeholder="0"
                  min="0"
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-gray-400"
                />
              </div>
            ))}
            <div className="flex justify-between items-center pt-2 border-t border-gray-100">
              <span className="text-sm text-gray-600">台股總資產（TWD）</span>
              <span className="text-sm font-semibold text-gray-900">
                {twTotal > 0 ? formatNumber(Math.round(twTotal)) : '--'}
              </span>
            </div>
          </div>
        </div>

        <div className="h-px bg-gray-100 my-3" />

        {/* 美股帳本（USD）*/}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <p className="text-xs font-semibold text-orange-500">美股帳本（USD）</p>
            <button
              onClick={() => { setNameInputs([...usNames]); setEditingNames(e => !e) }}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >{editingNames ? '取消' : '編輯名稱'}</button>
          </div>

          {editingNames && (
            <div className="mb-3 p-3 bg-orange-50 rounded-xl border border-orange-100">
              <p className="text-[11px] text-orange-400 mb-2">自訂帳戶名稱</p>
              {nameInputs.map((name, i) => (
                <div key={i} className="flex items-center gap-2 mb-2">
                  <span className="text-xs text-gray-400 w-4 text-right">{i + 1}.</span>
                  <input
                    value={name}
                    onChange={e => {
                      const next = [...nameInputs]
                      next[i] = e.target.value
                      setNameInputs(next)
                    }}
                    className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-orange-300"
                  />
                </div>
              ))}
              <button
                onClick={() => {
                  const names = nameInputs.map((n, i) => n.trim() || DEFAULT_US_NAMES[i])
                  setUsNames(names)
                  saveUsAccountNames(names)
                  setEditingNames(false)
                }}
                className="w-full mt-1 py-1.5 rounded-lg text-xs font-medium bg-orange-500 text-white hover:bg-orange-600 transition-colors"
              >儲存名稱</button>
            </div>
          )}

          <div className="space-y-2.5">
            {[
              { label: `${usNames[0]} 市值`, field: 'usAccount1Value' },
              { label: `${usNames[1]} 市值`, field: 'usAccount2Value' },
              { label: `${usNames[2]} 市值`, field: 'usAccount3Value' },
            ].map(({ label, field }) => (
              <div key={field} className="flex items-center gap-3">
                <label className="text-sm text-gray-600 w-28 shrink-0">{label}</label>
                <input
                  type="number"
                  value={snapInputs.us[field]}
                  onChange={e => setUsField(field, e.target.value)}
                  placeholder="0"
                  min="0"
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-gray-400"
                />
              </div>
            ))}
            <div className="flex justify-between items-center pt-2 border-t border-gray-100">
              <span className="text-sm text-gray-600">美股總資產（USD）</span>
              <span className="text-sm font-semibold text-gray-900">
                {usTotal > 0 ? fmtUsd(usTotal) : '--'}
              </span>
            </div>
          </div>
        </div>

        <button
          onClick={handleSaveSnapshot}
          className={`mt-5 w-full py-2.5 rounded-xl text-sm font-medium transition-colors ${
            savedMsg
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-gray-900 text-white hover:bg-gray-700'
          }`}
        >
          {savedMsg ? '已儲存' : '儲存本月資料'}
        </button>
      </div>

      {/* 3. 現金流紀錄卡（移至快照下方、縮小版面）*/}
      <div className="bg-white rounded-2xl px-4 py-3 mt-4 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-gray-500 uppercase tracking-wider">現金流紀錄</p>
          <button onClick={() => setShowForm(true)}
            className="text-xs text-gray-600 border border-gray-300 hover:border-gray-400 rounded-lg px-2.5 py-1 transition-colors"
          >+ 新增紀錄</button>
        </div>
        <CashflowList cashflows={cashflows} onDelete={handleDeleteCashflow} />
      </div>

      {showForm && (
        <CashflowForm
          onSave={handleAddCashflow}
          onCancel={() => setShowForm(false)}
          selectedMonth={selectedMonth}
        />
      )}

      {/* 4. 當月心得 / 操作回顧 */}
      <div className="bg-white rounded-2xl px-4 py-3 mt-4 shadow-sm border border-gray-100">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">當月心得 / 操作回顧</p>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="記錄這個月的操作、判斷、錯誤、觀察重點..."
          rows={5}
          className="w-full text-sm text-gray-800 placeholder-gray-300 border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-gray-400 resize-none"
        />
        <p className="text-[11px] text-gray-400 mt-1">按「儲存本月資料」一併儲存</p>
      </div>
    </div>
  )
}

// ─── 績效 / XIRR 統計頁（第 5 頁）────────────────────────────────────────────

// 計算單一帳本的 XIRR 摘要統計
function calcLedgerStats(cashflows, totalAssets, savedAt) {
  const today = new Date().toISOString().slice(0, 10)
  const netDeposit = cashflows.reduce((sum, cf) => {
    if (cf.type === '入金') return sum + Math.abs(Number(cf.amount))
    if (cf.type === '出金') return sum - Math.abs(Number(cf.amount))
    return sum
  }, 0)
  const realizedPnL = cashflows
    .filter(cf => cf.type === '已實現損益')
    .reduce((sum, cf) => sum + Number(cf.amount), 0)
  let xirr = null
  if (cashflows.length > 0 && totalAssets > 0) {
    const endDate = savedAt?.slice(0, 10) ?? today
    const payments = [
      ...cashflows.map(cf => ({
        date:   cf.date,
        amount: cf.type === '入金' ? -Math.abs(Number(cf.amount)) : Math.abs(Number(cf.amount)),
      })),
      { date: endDate, amount: totalAssets },
    ]
    xirr = calculateXIRR(payments)
  }
  return { netDeposit, realizedPnL, xirr }
}

function PerfCard({ title, accentClass, cashflows, totalAssets, savedAt, usd = false }) {
  const hasCfs = cashflows.length > 0
  const { netDeposit, realizedPnL, xirr } = useMemo(
    () => calcLedgerStats(cashflows, totalAssets, savedAt),
    [cashflows, totalAssets, savedAt]
  )
  const xirrStr   = xirr !== null ? `${(xirr * 100).toFixed(2)}%` : '--'
  const xirrColor = xirr !== null ? (xirr >= 0 ? 'text-red-500' : 'text-green-600') : 'text-gray-400'
  const hasRealPnL = cashflows.some(cf => cf.type === '已實現損益')

  return (
    <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
      <p className={`text-xs font-semibold ${accentClass} mb-3`}>{title}</p>
      <div className="space-y-2.5">
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-600">目前總資產</span>
          <span className="text-sm font-medium text-gray-900">
            {totalAssets > 0 ? (usd ? fmtUsd(totalAssets) : formatNumber(Math.round(totalAssets))) : '--'}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-600">累計淨入金</span>
          <span className="text-sm font-medium text-gray-900">
            {hasCfs ? (usd ? fmtUsd(netDeposit) : formatNumber(Math.round(netDeposit))) : '--'}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-600">累計已實現損益</span>
          <span className={`text-sm font-medium ${realizedPnL > 0 ? 'text-red-500' : realizedPnL < 0 ? 'text-green-600' : 'text-gray-900'}`}>
            {hasRealPnL
              ? (realizedPnL >= 0 ? '+' : '') + (usd ? fmtUsd(realizedPnL) : formatNumber(Math.round(realizedPnL)))
              : '--'}
          </span>
        </div>
        <div className="flex justify-between items-center pt-2 border-t border-gray-100">
          <span className="text-sm font-semibold text-gray-700">XIRR（年化報酬）</span>
          <span className={`text-base font-bold ${xirrColor}`}>{xirrStr}</span>
        </div>
      </div>
      {savedAt && (
        <p className="text-[11px] text-gray-300 mt-3">期末資產來源：{savedAt.slice(0, 10)}</p>
      )}
    </div>
  )
}

// ─── 月度績效卡 ───────────────────────────────────────────────────────────────

function formatReturnRate(r) {
  if (r === null || r === undefined) return '--'
  return `${r >= 0 ? '+' : ''}${(r * 100).toFixed(2)}%`
}

function returnColor(r) {
  if (r === null || r === undefined) return 'text-gray-300'
  if (r > 0) return 'text-red-500'
  if (r < 0) return 'text-green-600'
  return 'text-gray-500'
}

function MonthlyReturnCard({ title, accentClass, monthlyReturns }) {
  const [open, setOpen] = useState(false)
  const cumulativeReturn = useMemo(
    () => getCumulativeReturn(monthlyReturns),
    [monthlyReturns]
  )

  if (monthlyReturns.length === 0) return null

  const cumStr   = formatReturnRate(cumulativeReturn)
  const cumColor = returnColor(cumulativeReturn)

  return (
    <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
      {/* 標題 + 累積報酬 + 收合箭頭 */}
      <button
        className="w-full flex items-center justify-between"
        onClick={() => setOpen(o => !o)}
      >
        <p className={`text-xs font-semibold ${accentClass}`}>{title}</p>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-gray-400">累積報酬</span>
          <span className={`text-sm font-bold ${cumColor}`}>{cumStr}</span>
          <span className="text-gray-400 text-xs ml-1">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* 各月列表（最新在前）*/}
      {open && (
        <div className="space-y-1 mt-3">
          {[...monthlyReturns].reverse().map(({ month, returnRate }) => {
            const [y, m] = month.split('-')
            return (
              <div key={month} className="flex items-center justify-between py-0.5">
                <span className="text-sm text-gray-600">{y}/{m}</span>
                <span className={`text-sm font-medium ${returnColor(returnRate)}`}>
                  {formatReturnRate(returnRate)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── 總資產走勢線圖 ───────────────────────────────────────────────────────────

function PerfLineChart({ data, usd }) {
  if (!data || data.length < 2) {
    return (
      <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100 flex items-center justify-center" style={{ minHeight: 120 }}>
        <p className="text-xs text-gray-300">資料不足，需至少兩個月快照</p>
      </div>
    )
  }

  const VW = 340, VH = 130
  const PAD = { top: 10, right: 12, bottom: 24, left: 52 }
  const cW = VW - PAD.left - PAD.right
  const cH = VH - PAD.top - PAD.bottom

  const values = data.map(d => d.endAssets)
  const minV = Math.min(...values)
  const maxV = Math.max(...values)
  const range = maxV - minV
  const lo = range === 0 ? minV * 0.95 : minV - range * 0.05
  const hi = range === 0 ? maxV * 1.05 : maxV + range * 0.05
  const span = hi - lo || 1

  const toX = i => PAD.left + (i / (data.length - 1)) * cW
  const toY = v => PAD.top + (1 - (v - lo) / span) * cH

  const pts = data.map((d, i) => ({ x: toX(i), y: toY(d.endAssets), month: d.month }))
  const polyline = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  const yTicks = [lo, (lo + hi) / 2, hi]
  const fmtY = v => usd
    ? (v >= 1000 ? `$${(v / 1000).toFixed(0)}K` : `$${v.toFixed(0)}`)
    : (v >= 10000 ? `${(v / 10000).toFixed(1)}萬` : `${Math.round(v)}`)

  const xLabelIdxs = new Set([0, data.length - 1])
  if (data.length >= 4) xLabelIdxs.add(Math.floor((data.length - 1) / 2))

  const strokeColor = usd ? '#f97316' : '#0ea5e9'

  return (
    <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
      <p className="text-xs font-semibold text-gray-500 mb-2">總資產走勢</p>
      <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: 120 }}>
        {yTicks.map((v, i) => {
          const y = toY(v).toFixed(1)
          return (
            <g key={i}>
              <line x1={PAD.left} y1={y} x2={VW - PAD.right} y2={y} stroke="#f0f0f0" strokeWidth="1" />
              <text x={PAD.left - 4} y={parseFloat(y) + 4} textAnchor="end" fontSize="9" fill="#9ca3af">{fmtY(v)}</text>
            </g>
          )
        })}
        <polyline points={polyline} fill="none" stroke={strokeColor} strokeWidth="2" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="2.5" fill={strokeColor} />
        ))}
        {pts.map((p, i) => {
          if (!xLabelIdxs.has(i)) return null
          const [yr, mo] = p.month.split('-')
          return (
            <text key={i} x={p.x.toFixed(1)} y={VH - 2} textAnchor="middle" fontSize="9" fill="#9ca3af">{`${yr.slice(2)}/${mo}`}</text>
          )
        })}
      </svg>
    </div>
  )
}

// ─── 近期回測 ─────────────────────────────────────────────────────────────────

function todayISOStr() {
  return new Date().toISOString().slice(0, 10)
}

function addDays(dateStr, n) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

const MAX_BACKTEST_DAYS = 365

const BACKTEST_PERIODS = [
  { label: '7天',  days: 7        },
  { label: '30天', days: 30       },
  { label: '自訂', days: 'custom' },
]

// ─── TW 歷史資料抓取 ──────────────────────────────────────────────────────────

// 記憶體快取：key = "symbol-YYYYMM"，value = [{date:'YYYY-MM-DD', close:number}]
const twHistoryCache = new Map()

// 民國年 "115/04/07" → 西元 "2026-04-07"
function parseTwseDate(roc) {
  const [y, m, d] = roc.split('/')
  return `${parseInt(y, 10) + 1911}-${m}-${d}`
}

// 抓單一股票單一月份的每日收盤價
// yyyymm = "202604"，回傳 [{date, close}] 由早到晚排序
async function fetchTwHistoryMonth(symbol, yyyymm) {
  const key = `${symbol}-${yyyymm}`
  if (twHistoryCache.has(key)) return twHistoryCache.get(key)
  try {
    const res = await fetch(`/api/tw-history?stockNo=${encodeURIComponent(symbol)}&yyyymm=${yyyymm}`)
    if (!res.ok) return []
    const data = await res.json()
    if (data.stat !== 'OK' || !Array.isArray(data.data)) return []
    const rows = data.data
      .map(row => ({
        date:  parseTwseDate(row[0]),
        close: parseFloat(String(row[6]).replace(/,/g, '')),
      }))
      .filter(r => !isNaN(r.close))
    rows.sort((a, b) => a.date.localeCompare(b.date))
    twHistoryCache.set(key, rows)
    return rows
  } catch {
    return []
  }
}

// 推算需抓的所有月份（含 startDate 前一個月，以取得「前收」）
// 回傳 ["202603", "202604", ...]
function getRequiredMonths(startDate, endDate) {
  const seen = new Set()
  const result = []
  const cur = new Date(startDate)
  cur.setDate(1)
  cur.setMonth(cur.getMonth() - 1)       // 多取前一個月（用於第一天的前收）
  const last = new Date(endDate)
  last.setDate(1)
  while (cur <= last) {
    const yyyymm = `${cur.getFullYear()}${String(cur.getMonth() + 1).padStart(2, '0')}`
    if (!seen.has(yyyymm)) { seen.add(yyyymm); result.push(yyyymm) }
    cur.setMonth(cur.getMonth() + 1)
  }
  return result
}

// ─── US 歷史資料抓取 ──────────────────────────────────────────────────────────

// 記憶體快取：key = "symbol-YYYY-MM-DD"（當天），value = [{date, close}]
const usHistoryCache = new Map()

// 抓單一美股 1 年日線資料，回傳 [{date:'YYYY-MM-DD', close:number}] 由早到晚
async function fetchUsHistory(symbol) {
  const key = `${symbol}-${todayStr()}`
  if (usHistoryCache.has(key)) return usHistoryCache.get(key)
  try {
    const res = await fetch(`/api/us-history?symbol=${encodeURIComponent(symbol)}`)
    if (!res.ok) return []
    const rows = await res.json()
    if (!Array.isArray(rows)) return []
    usHistoryCache.set(key, rows)
    return rows
  } catch {
    return []
  }
}

// 核心計算：依持股、日期區間、priceMap 計算每日回測結果
// priceMap: Map<symbol, Map<dateStr, closePrice>>
// 回傳 { totalPnL, totalReturn, chartPts, daily } 或 null
function computeTwBacktest(holdings, startDate, endDate, priceMap) {
  // 彙整所有有資料的交易日（含區間前，作為前收用）
  const allDates = new Set()
  for (const dateMap of priceMap.values()) {
    for (const d of dateMap.keys()) allDates.add(d)
  }
  const sortedAllDates = [...allDates].sort()

  // 區間內的交易日
  const rangeDays = sortedAllDates.filter(d => d >= startDate && d <= endDate)
  if (rangeDays.length === 0) return null

  // 取某股票在指定日期之前最近一個有收盤價的日期之收盤價
  function prevClose(symbol, date) {
    const dateMap = priceMap.get(symbol)
    if (!dateMap) return null
    let best = null
    for (const d of sortedAllDates) {
      if (d >= date) break
      if (dateMap.has(d)) best = dateMap.get(d)
    }
    return best
  }

  // 取某持股在指定日當天的有效 { shares, avgCost }
  // 以 changes 為主；若無 changes 則 fallback 到舊欄位（相容舊格式）
  function effectiveState(h, day) {
    if (Array.isArray(h.changes) && h.changes.length > 0) {
      const sorted = h.changes.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      let state = null
      for (const c of sorted) {
        if (c.date <= day) state = c
        else break
      }
      return state   // null 表示該日尚未持有
    }
    // fallback：舊格式無 changes，以 buyDate 判斷開始日
    const start = h.buyDate || startDate
    return start <= day ? { shares: h.shares, avgCost: h.avgCost } : null
  }

  const dailyAsc = []   // 由舊到新，最後 reverse 給 UI 用
  const chartPts = []
  let periodPnL  = 0    // 區間內所有交易日的日損益加總

  for (const day of rangeDays) {
    // 每日依 changes 推算各持股當天的有效狀態
    const positions = holdings
      .map(h => ({ symbol: h.symbol, state: effectiveState(h, day) }))
      .filter(p => p.state !== null)

    if (positions.length === 0) continue

    let cumPnL = 0, totalCost = 0, dailyPnL = 0, prevMV = 0

    for (const { symbol, state } of positions) {
      const { shares, avgCost } = state
      // 成本分母始終納入，避免缺資料日分母忽大忽小造成報酬率跳動
      totalCost += avgCost * shares

      const close = priceMap.get(symbol)?.get(day)
      if (close == null) continue   // 無收盤價：該股不計入損益，但成本已入分母

      cumPnL += (close - avgCost) * shares

      const pc = prevClose(symbol, day)
      if (pc != null) {
        dailyPnL += (close - pc) * shares
        prevMV   += pc * shares
      }
      // 若無前收（第一個有效交易日），該股當日損益貢獻記為 0
    }

    const dailyRet = prevMV > 0 ? dailyPnL / prevMV : 0
    periodPnL += dailyPnL

    dailyAsc.push({ date: day.replace(/-/g, '/'), pnl: Math.round(dailyPnL), ret: dailyRet })
    chartPts.push(Math.round(cumPnL))
  }

  if (dailyAsc.length === 0) return null

  // 期初市值：各持股獨立計算，避免某股缺前一月資料時整體分母失真
  // 每支股票：優先取 firstDay 的 prevClose；若無則 fallback 用 firstDay 當天或之後最近收盤
  const firstDay = rangeDays.find(d => holdings.some(h => effectiveState(h, d) !== null))
  let startMV = 0
  if (firstDay) {
    for (const h of holdings) {
      const state = effectiveState(h, firstDay)
      if (!state) continue
      const pc = prevClose(h.symbol, firstDay)
      if (pc != null) {
        startMV += pc * state.shares
      } else {
        // fallback：prevClose 取不到（如前月資料缺失），用首個有收盤的日期之收盤價
        const dateMap = priceMap.get(h.symbol)
        if (dateMap) {
          for (const d of sortedAllDates) {
            if (d >= firstDay && dateMap.has(d)) {
              startMV += dateMap.get(d) * state.shares
              break
            }
          }
        }
      }
    }
  }

  // 期間報酬率：期間累積損益 / 期初市值
  const periodReturn = startMV > 0 ? periodPnL / startMV : 0

  return {
    totalPnL:    Math.round(periodPnL),
    totalReturn: periodReturn,
    chartPts,
    daily: [...dailyAsc].reverse(),   // UI 顯示由新到舊
  }
}

function BacktestLineChart({ pts }) {
  // pts: 累積損益陣列（由舊到新）
  const VW = 340, VH = 130
  const PAD = { top: 10, right: 12, bottom: 18, left: 52 }
  const cW = VW - PAD.left - PAD.right
  const cH = VH - PAD.top - PAD.bottom

  const empty = !pts || pts.length < 2

  const minV = empty ? 0 : Math.min(...pts)
  const maxV = empty ? 1 : Math.max(...pts)
  const rng  = maxV - minV || 1
  const lo   = minV - rng * 0.05
  const hi   = maxV + rng * 0.05
  const span = hi - lo || 1

  const toX = i => PAD.left + (i / (pts.length - 1)) * cW
  const toY = v => PAD.top + (1 - (v - lo) / span) * cH

  const polyline = empty ? '' : pts.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')
  const yTicks = [lo, (lo + hi) / 2, hi]
  const fmtY = v => {
    const abs = Math.abs(v)
    return abs >= 10000 ? `${(v / 10000).toFixed(1)}萬` : `${Math.round(v)}`
  }

  return (
    <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
      <p className="text-xs font-semibold text-gray-500 mb-2">近期回測走勢</p>
      {empty ? (
        <div className="flex items-center justify-center" style={{ height: 120 }}>
          <p className="text-xs text-gray-300">暫無資料</p>
        </div>
      ) : (
        <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: 120 }}>
          {yTicks.map((v, i) => {
            const y = toY(v).toFixed(1)
            return (
              <g key={i}>
                <line x1={PAD.left} y1={y} x2={VW - PAD.right} y2={y} stroke="#f0f0f0" strokeWidth="1" />
                <text x={PAD.left - 4} y={parseFloat(y) + 4} textAnchor="end" fontSize="9" fill="#9ca3af">{fmtY(v)}</text>
              </g>
            )
          })}
          <polyline points={polyline} fill="none" stroke="#8b5cf6" strokeWidth="2" strokeLinejoin="round" />
          <circle cx={toX(pts.length - 1).toFixed(1)} cy={toY(pts[pts.length - 1]).toFixed(1)} r="2.5" fill="#8b5cf6" />
        </svg>
      )}
    </div>
  )
}

// Bottom sheet：自訂日期選擇
function DatePickerSheet({ minDate, onConfirm, onCancel }) {
  const today = todayISOStr()
  const [start, setStart] = useState('')
  const [end,   setEnd]   = useState('')

  // 結束日上限 = min(今天, 開始日 + 364天)，實現最多 365 天限制
  const endMax = start
    ? (addDays(start, MAX_BACKTEST_DAYS - 1) < today ? addDays(start, MAX_BACKTEST_DAYS - 1) : today)
    : today

  function handleStartChange(val) {
    setStart(val)
    // 若已選結束日超出新的上限，自動清除
    if (end && (end < val || end > addDays(val, MAX_BACKTEST_DAYS - 1))) {
      setEnd('')
    }
  }

  const canConfirm = start && end && start <= end

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />

      {/* Sheet 本體 */}
      <div className="relative bg-white rounded-t-2xl px-5 pt-4 pb-8 shadow-xl">
        {/* 拖曳把手 */}
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />

        <p className="text-sm font-semibold text-gray-800 mb-1">選擇回測區間</p>
        <p className="text-[11px] text-gray-400 mb-4">
          可選範圍：{minDate.replace(/-/g, '/')} ～ {today.replace(/-/g, '/')}&nbsp;·&nbsp;最長 365 天
        </p>

        <div className="space-y-3 mb-2">
          <div>
            <label className="text-xs text-gray-500 mb-1.5 block">開始日期</label>
            <input
              type="date"
              value={start}
              min={minDate}
              max={end || today}
              onChange={e => handleStartChange(e.target.value)}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:border-violet-400"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1.5 block">結束日期</label>
            <input
              type="date"
              value={end}
              min={start || minDate}
              max={endMax}
              onChange={e => setEnd(e.target.value)}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:border-violet-400"
            />
          </div>
        </div>

        {/* 365 天限制提示（僅開始日已選時才顯示） */}
        {start && (
          <p className="text-[11px] text-violet-400 mb-4">
            結束日最晚可選 {endMax.replace(/-/g, '/')}（最多 365 天）
          </p>
        )}

        <div className="flex gap-3 mt-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 font-medium"
          >取消</button>
          <button
            onClick={() => canConfirm && onConfirm(start, end)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
              canConfirm ? 'bg-violet-500 text-white' : 'bg-gray-100 text-gray-300'
            }`}
          >確認</button>
        </div>
      </div>
    </div>
  )
}

function BacktestView({ isTw, twHoldings }) {
  const [period,      setPeriod]      = useState(7)
  const [showPicker,  setShowPicker]  = useState(false)
  const [customRange, setCustomRange] = useState(null)   // { start, end } | null

  // TW / US 都 fetch 真實資料
  const [twResult,  setTwResult]  = useState(null)
  const [usResult,  setUsResult]  = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [btError,   setBtError]   = useState(null)

  // US 持股：BacktestView 掛載時從 localStorage 讀一次；isTw 切換時重讀
  const usHoldings = useMemo(() => isTw ? [] : loadUsHoldings(), [isTw])

  // 從 TW 持股推算最早開倉日
  const earliestTwDate = useMemo(() => {
    if (!twHoldings || twHoldings.length === 0) return '2025-12-01'
    const dates = twHoldings.map(h => {
      if (Array.isArray(h.changes) && h.changes.length > 0) return h.changes[0].date
      return h.buyDate || '2025-12-01'
    })
    return dates.reduce((a, b) => (a < b ? a : b))
  }, [twHoldings])

  // 從 US 持股推算最早開倉日
  const earliestUsDate = useMemo(() => {
    if (!usHoldings || usHoldings.length === 0) return '2025-01-01'
    const dates = usHoldings.map(h => {
      if (Array.isArray(h.changes) && h.changes.length > 0) return h.changes[0].date
      return h.buyDate || '2025-01-01'
    })
    return dates.reduce((a, b) => (a < b ? a : b))
  }, [usHoldings])

  const minDate = isTw ? earliestTwDate : earliestUsDate

  // 市場切換時清除自訂區間
  const prevIsTwRef = useRef(isTw)
  if (prevIsTwRef.current !== isTw) {
    prevIsTwRef.current = isTw
    if (period === 'custom') {
      setPeriod(7)
      setCustomRange(null)
    }
  }

  // 計算本次回測的日期區間
  const today = todayISOStr()
  let startDate, endDate
  if (period === 'custom' && customRange) {
    startDate = customRange.start
    endDate   = customRange.end
  } else {
    endDate   = today
    const raw = addDays(today, -(period - 1))
    startDate = raw < minDate ? minDate : raw
  }

  // TW 真實資料：period / customRange / twHoldings 變動時重算
  useEffect(() => {
    if (!isTw) return
    if (!twHoldings || twHoldings.length === 0) {
      setTwResult(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setBtError(null)
    setTwResult(null)

    async function run() {
      try {
        const months = getRequiredMonths(startDate, endDate)
        const priceMap = new Map()

        await Promise.all(
          twHoldings.flatMap(h =>
            months.map(async yyyymm => {
              const rows = await fetchTwHistoryMonth(h.symbol, yyyymm)
              if (!priceMap.has(h.symbol)) priceMap.set(h.symbol, new Map())
              const dateMap = priceMap.get(h.symbol)
              for (const { date, close } of rows) dateMap.set(date, close)
            })
          )
        )

        if (cancelled) return
        const result = computeTwBacktest(twHoldings, startDate, endDate, priceMap)
        setTwResult(result)
      } catch (err) {
        if (!cancelled) setBtError(err.message || '資料載入失敗')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    run()
    return () => { cancelled = true }
  }, [isTw, twHoldings, startDate, endDate])  // eslint-disable-line react-hooks/exhaustive-deps

  // US 真實資料：isTw=false 時從 Yahoo Finance 抓歷史日線，套用 changes 邏輯
  useEffect(() => {
    if (isTw) return
    if (!usHoldings || usHoldings.length === 0) {
      setUsResult(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setBtError(null)
    setUsResult(null)

    async function run() {
      try {
        const symbols  = [...new Set(usHoldings.map(h => h.symbol))]
        const priceMap = new Map()

        await Promise.all(
          symbols.map(async sym => {
            const rows    = await fetchUsHistory(sym)
            const dateMap = new Map()
            for (const { date, close } of rows) dateMap.set(date, close)
            priceMap.set(sym, dateMap)
          })
        )

        if (cancelled) return
        const result = computeTwBacktest(usHoldings, startDate, endDate, priceMap)
        setUsResult(result)
      } catch (err) {
        if (!cancelled) setBtError(err.message || '資料載入失敗')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    run()
    return () => { cancelled = true }
  }, [isTw, usHoldings, startDate, endDate])  // eslint-disable-line react-hooks/exhaustive-deps

  // 顯示資料：TW / US 均使用真實結果
  const display     = isTw ? twResult : usResult
  const accentClass = isTw ? 'text-sky-600' : 'text-orange-500'
  const title       = isTw ? '台股近期回測（TWD）' : '美股近期回測（USD）'

  const fmtPnl = v => (v >= 0 ? '+' : '') + formatNumber(Math.round(v))
  const fmtRet = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%'

  const customLabel = customRange
    ? `${customRange.start.replace(/-/g, '/')} ～ ${customRange.end.replace(/-/g, '/')}`
    : null

  function handlePeriodClick(days) {
    if (days === 'custom') { setShowPicker(true) }
    else { setPeriod(days); setCustomRange(null) }
  }

  function handleConfirm(start, end) {
    setShowPicker(false)
    setPeriod('custom')
    setCustomRange({ start, end })
  }

  return (
    <>
      {/* 期間切換 */}
      <div className="flex gap-2 mb-4">
        {BACKTEST_PERIODS.map(({ label, days }) => (
          <button
            key={String(days)}
            onClick={() => handlePeriodClick(days)}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
              period === days
                ? 'bg-violet-500 text-white shadow-sm'
                : 'bg-white text-gray-500 border border-gray-200'
            }`}
          >{label}</button>
        ))}
      </div>

      {/* 自訂期間已選提示 */}
      {period === 'custom' && customLabel && (
        <p className="text-[11px] text-violet-500 text-center mb-3">{customLabel}</p>
      )}

      {/* 載入中 */}
      {isLoading && (
        <div className="bg-white rounded-2xl p-6 mb-4 shadow-sm border border-gray-100 flex items-center justify-center gap-2">
          <svg className="animate-spin w-4 h-4 text-violet-400" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeDashoffset="10" />
          </svg>
          <span className="text-xs text-gray-400">載入歷史資料中…</span>
        </div>
      )}

      {/* 錯誤訊息 */}
      {!isLoading && btError && (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 mb-4 text-center">
          <p className="text-xs text-red-400">{btError}</p>
        </div>
      )}

      {/* 摘要卡 */}
      {!isLoading && !btError && (
        <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm border border-gray-100">
          <p className={`text-xs font-semibold ${accentClass} mb-3`}>{title}</p>
          {display ? (
            <div className="flex gap-4">
              <div className="flex-1 text-center">
                <p className="text-[11px] text-gray-400 mb-1">累積損益</p>
                <p className={`text-base font-bold ${display.totalPnL >= 0 ? 'text-red-500' : 'text-green-600'}`}>
                  {fmtPnl(display.totalPnL)}
                </p>
              </div>
              <div className="w-px bg-gray-100" />
              <div className="flex-1 text-center">
                <p className="text-[11px] text-gray-400 mb-1">累積報酬率</p>
                <p className={`text-base font-bold ${display.totalReturn >= 0 ? 'text-red-500' : 'text-green-600'}`}>
                  {fmtRet(display.totalReturn)}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-300 text-center py-3">此區間無交易資料</p>
          )}
        </div>
      )}

      {/* 折線圖 */}
      {!isLoading && !btError && (
        <BacktestLineChart pts={display?.chartPts ?? []} />
      )}

      {/* 每日明細 */}
      {!isLoading && !btError && (
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs font-semibold text-gray-500 mb-3">每日明細</p>
          {display && display.daily.length > 0 ? (
            <div className="space-y-0.5">
              <div className="flex justify-between items-center pb-2 border-b border-gray-100">
                <span className="text-[11px] text-gray-400 w-24">日期</span>
                <span className="text-[11px] text-gray-400 text-right flex-1">當日損益</span>
                <span className="text-[11px] text-gray-400 text-right w-16">報酬率</span>
              </div>
              {display.daily.slice(0, 7).map(({ date, pnl, ret }) => (
                <div key={date} className="flex justify-between items-center py-1.5 border-b border-gray-50 last:border-0">
                  <span className="text-sm text-gray-600 w-24">{date}</span>
                  <span className={`text-sm font-medium text-right flex-1 ${pnl >= 0 ? 'text-red-500' : 'text-green-600'}`}>
                    {pnl >= 0 ? '+' : ''}{formatNumber(Math.round(pnl))}
                  </span>
                  <span className={`text-sm font-medium text-right w-16 ${ret >= 0 ? 'text-red-500' : 'text-green-600'}`}>
                    {ret >= 0 ? '+' : ''}{(ret * 100).toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-300 text-center py-3">此區間無明細</p>
          )}
        </div>
      )}

      {/* 自訂日期 Bottom Sheet */}
      {showPicker && (
        <DatePickerSheet
          minDate={minDate}
          onConfirm={handleConfirm}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </>
  )
}

// ─── 績效頁主體 ───────────────────────────────────────────────────────────────

function PerformancePage({ onExitAdvanced, twHoldings }) {
  const [ledger] = useState(loadLedger)
  const [perfMarket, setPerfMarket] = useState('tw')
  const [perfView,   setPerfView]   = useState('xirr')

  const allCashflows = useMemo(() =>
    Object.values(ledger)
      .flatMap(m => Array.isArray(m?.cashflows) ? m.cashflows : [])
      .filter(cf => cf?.date && cf?.amount != null),
    [ledger]
  )

  const twCashflows = useMemo(() =>
    Object.entries(ledger)
      .filter(([, m]) => (m?.snapshot?.tw?.totalAssets ?? 0) > 0)
      .flatMap(([, m]) => Array.isArray(m?.cashflows) ? m.cashflows : [])
      .filter(cf => cf?.date && cf?.amount != null && (!cf.ledgerType || cf.ledgerType === 'tw')),
    [ledger]
  )
  const usCashflows = useMemo(() =>
    Object.entries(ledger)
      .filter(([, m]) => (m?.snapshot?.us?.totalAssets ?? 0) > 0)
      .flatMap(([, m]) => Array.isArray(m?.cashflows) ? m.cashflows : [])
      .filter(cf => cf?.date && cf?.amount != null && cf.ledgerType === 'us'),
    [ledger]
  )

  const latestTwSnap = useMemo(() =>
    Object.entries(ledger)
      .filter(([, m]) => m?.snapshot?.tw?.totalAssets > 0)
      .sort(([a], [b]) => b.localeCompare(a))
      [0]?.[1]?.snapshot ?? null,
    [ledger]
  )
  const latestUsSnap = useMemo(() =>
    Object.entries(ledger)
      .filter(([, m]) => m?.snapshot?.us?.totalAssets > 0)
      .sort(([a], [b]) => b.localeCompare(a))
      [0]?.[1]?.snapshot ?? null,
    [ledger]
  )

  const [logsOpen, setLogsOpen] = useState(false)

  const twMonthlyReturns = useMemo(() => getMonthlyReturns(ledger, 'tw'), [ledger])
  const usMonthlyReturns = useMemo(() => getMonthlyReturns(ledger, 'us'), [ledger])

  const twReturnMap = useMemo(() =>
    Object.fromEntries(twMonthlyReturns.map(m => [m.month, m.returnRate])),
    [twMonthlyReturns]
  )
  const usReturnMap = useMemo(() =>
    Object.fromEntries(usMonthlyReturns.map(m => [m.month, m.returnRate])),
    [usMonthlyReturns]
  )

  const hasAnyData = allCashflows.length > 0 || Object.keys(ledger).length > 0
  const isTw       = perfMarket === 'tw'
  const isBacktest = perfView   === 'backtest'

  return (
    <div className="px-4 pt-12 pb-6">
      {/* 標題列 + 退出按鈕 */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-gray-800 tracking-wide">績效 / XIRR</h1>
        <button onClick={onExitAdvanced}
          className="text-xs text-gray-500 border border-gray-300 hover:border-gray-400 rounded-lg px-2.5 py-1.5 transition-colors"
        >退出進階模式</button>
      </div>

      {/* 第一列：市場切換 */}
      <div className="flex gap-2 mb-2">
        <button
          onClick={() => setPerfMarket('tw')}
          className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
            isTw ? 'bg-sky-500 text-white shadow-sm' : 'bg-white text-gray-500 border border-gray-200'
          }`}
        >台股 (TWD)</button>
        <button
          onClick={() => setPerfMarket('us')}
          className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
            !isTw ? 'bg-orange-400 text-white shadow-sm' : 'bg-white text-gray-500 border border-gray-200'
          }`}
        >美股 (USD)</button>
      </div>

      {/* 第二列：視圖切換 */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setPerfView('xirr')}
          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            !isBacktest
              ? (isTw ? 'bg-sky-100 text-sky-700' : 'bg-orange-100 text-orange-700')
              : 'bg-white text-gray-400 border border-gray-200'
          }`}
        >XIRR 績效</button>
        <button
          onClick={() => setPerfView('backtest')}
          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            isBacktest ? 'bg-violet-100 text-violet-700' : 'bg-white text-gray-400 border border-gray-200'
          }`}
        >近期回測</button>
      </div>

      {/* 近期回測頁（跟隨市場） */}
      {isBacktest && <BacktestView isTw={isTw} twHoldings={twHoldings} />}

      {/* 原有台股／美股績效內容 */}
      {!isBacktest && !hasAnyData && (
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 text-center py-10">
          <p className="text-sm text-gray-400">尚無資料</p>
          <p className="text-xs text-gray-300 mt-1">請先在「記帳」頁新增現金流並儲存月底資產</p>
        </div>
      )}

      {!isBacktest && hasAnyData && (
        <>
          {/* 線圖：只顯示目前所選市場的總資產走勢 */}
          <PerfLineChart data={isTw ? twMonthlyReturns : usMonthlyReturns} usd={!isTw} />

          {/* 中段資訊：min-height 確保切換時高度穩定，不忽高忽低 */}
          <div className="min-h-[200px]">
            {isTw ? (
              <>
                <PerfCard
                  title="台股績效（TWD）"
                  accentClass="text-sky-600"
                  cashflows={twCashflows}
                  totalAssets={latestTwSnap?.tw?.totalAssets ?? 0}
                  savedAt={latestTwSnap?.savedAt ?? null}
                />
                <MonthlyReturnCard
                  title="台股月度報酬（TWD）"
                  accentClass="text-sky-600"
                  monthlyReturns={twMonthlyReturns}
                />
              </>
            ) : (
              <>
                <PerfCard
                  title="美股績效（USD）"
                  accentClass="text-orange-500"
                  cashflows={usCashflows}
                  totalAssets={latestUsSnap?.us?.totalAssets ?? 0}
                  savedAt={latestUsSnap?.savedAt ?? null}
                  usd
                />
                <MonthlyReturnCard
                  title="美股月度報酬（USD）"
                  accentClass="text-orange-500"
                  monthlyReturns={usMonthlyReturns}
                />
              </>
            )}
          </div>
        </>
      )}

      {/* 各月紀錄（在近期回測時隱藏）*/}
      {!isBacktest && Object.keys(ledger).length > 0 && (
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <button
            className="w-full flex items-center justify-between"
            onClick={() => setLogsOpen(o => !o)}
          >
            <p className="text-xs text-gray-500 uppercase tracking-wider">各月紀錄</p>
            <span className="text-gray-400 text-xs">{logsOpen ? '▲' : '▼'}</span>
          </button>
          {logsOpen && <div className="space-y-2 mt-3">
            {Object.entries(ledger)
              .sort(([a], [b]) => b.localeCompare(a))
              .map(([month, data]) => {
                const snap = data?.snapshot
                const twT  = snap?.tw?.totalAssets
                const usT  = snap?.us?.totalAssets
                const twR  = twReturnMap[month]
                const usR  = usReturnMap[month]
                return (
                  <div key={month} className="py-1.5 border-b border-gray-50 last:border-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-700">{month.replace('-', '/')}</span>
                    </div>
                    {snap && (
                      <div className="flex gap-3 mt-0.5 flex-wrap">
                        {twT > 0 && (
                          <span className="text-[11px] text-sky-600">
                            台股 {formatNumber(Math.round(twT))}
                            {twR !== undefined && (
                              <span className={`ml-1 ${returnColor(twR)}`}>
                                ({formatReturnRate(twR)})
                              </span>
                            )}
                          </span>
                        )}
                        {usT > 0 && (
                          <span className="text-[11px] text-orange-500">
                            美股 {fmtUsd(usT)}
                            {usR !== undefined && (
                              <span className={`ml-1 ${returnColor(usR)}`}>
                                ({formatReturnRate(usR)})
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>}
        </div>
      )}
    </div>
  )
}

// ─── 美股持股 ─────────────────────────────────────────────────────────────────

function UsHoldingForm({ initial, onSave, onCancel }) {
  const isEdit = initial != null
  const [form, setForm] = useState({
    symbol:  initial?.symbol  ?? '',
    name:    initial?.name    ?? '',
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
      const map  = await fetchUsStockMap([sym])
      const info = map[sym]
      if (info?.name) set('name', info.name)
    } catch {}
    setIsLookingUp(false)
  }

  function handleSubmit(e) {
    e.preventDefault()
    const shares  = parseFloat(form.shares)
    const avgCost = parseFloat(form.avgCost)
    if (!form.symbol || !form.name || shares <= 0 || avgCost <= 0) return
    onSave({
      price:         initial?.price         ?? 0,
      previousClose: initial?.previousClose ?? 0,
      symbol:  form.symbol.trim().toUpperCase(),
      name:    form.name.trim(),
      shares,
      avgCost,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end">
      <div className="w-full max-w-md mx-auto bg-[#1c1c1c] rounded-t-2xl border-t border-[#2a2a2a] p-5">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-white">{isEdit ? '編輯美股持股' : '新增美股持股'}</h2>
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
              placeholder="例：AAPL"
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
                placeholder="例：10" min="0.000001" step="any"
                className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
            </div>
            <div>
              <label className="text-xs text-white mb-1 block">平均成本（USD）</label>
              <input type="number" value={form.avgCost} onChange={e => set('avgCost', e.target.value)}
                placeholder="例：150.00" min="0.0001" step="any"
                className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#555]" />
            </div>
          </div>
          <p className="text-xs text-gray-500">現價將在儲存後自動更新（Yahoo Finance，約 15 分鐘延遲）。</p>
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

function UsStockRow({ stock, onEdit, onDelete }) {
  const [showActions, setShowActions] = useState(false)
  const sharesStr = stock.shares % 1 === 0
    ? stock.shares.toLocaleString('zh-TW')
    : stock.shares.toLocaleString('zh-TW', { maximumFractionDigits: 6 })
  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <div className="px-4 pt-3.5 pb-3" onClick={() => setShowActions(prev => !prev)}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-base font-semibold text-gray-900 leading-tight">{stock.name}</p>
            <p className="text-xs text-gray-600 mt-0.5">{stock.symbol}</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold text-gray-900 tabular-nums">
              {stock.price > 0 ? `$${fmtUsd(stock.price)}` : '--'}
            </p>
            <PercentText value={stock.changePercent} className="text-sm mt-0.5" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 bg-gray-100 rounded-xl px-3 py-2.5 mb-2.5">
          <div>
            <p className="text-xs text-gray-600 mb-0.5 uppercase tracking-wider">今日損益</p>
            <span className={`text-base font-medium tabular-nums ${twColor(stock.todayPnL)}`}>
              {stock.todayPnL >= 0 ? '+' : ''}${fmtUsd(stock.todayPnL)}
            </span>
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-0.5 uppercase tracking-wider">累積損益</p>
            <div className="flex items-baseline gap-1.5">
              <span className={`text-base font-medium tabular-nums ${twColor(stock.totalPnL)}`}>
                {stock.totalPnL >= 0 ? '+' : ''}${fmtUsd(stock.totalPnL)}
              </span>
              <PercentText value={stock.returnRate} className="text-xs" />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>{sharesStr} 股</span>
          <span>·</span>
          <span>均價 ${fmtUsd(stock.avgCost)}</span>
          <span>·</span>
          <span>成本 ${fmtUsd(stock.shares * stock.avgCost)}</span>
        </div>
      </div>
      {showActions && (
        <div className="flex border-t border-gray-200">
          <button onClick={() => { setShowActions(false); onEdit() }}
            className="flex-1 py-2.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">編輯</button>
          <div className="w-px bg-gray-200" />
          <button
            className="flex-1 py-2.5 text-xs text-blue-500 hover:bg-blue-50 transition-colors">K線</button>
          <div className="w-px bg-gray-200" />
          <button onClick={() => onDelete()}
            className="flex-1 py-2.5 text-xs text-red-500 hover:bg-red-50 transition-colors">刪除</button>
        </div>
      )}
    </div>
  )
}

function UsHoldingsPage() {
  const [holdings,    setHoldings]    = useState(loadUsHoldings)
  const [modal,       setModal]       = useState(null)
  const [isFetching,  setIsFetching]  = useState(false)
  const [fetchError,  setFetchError]  = useState(null)
  const [lastUpdated, setLastUpdated] = useState('--')
  const [marketState, setMarketState] = useState('UNKNOWN')

  const stocks  = holdings.map(calcUsStock)
  const summary = calcUsSummary(stocks, holdings)

  function updateHoldings(next) {
    setHoldings(next)
    saveUsHoldings(next)
  }

  async function refreshPrices(currentHoldings) {
    if (currentHoldings.length === 0) return
    setIsFetching(true)
    setFetchError(null)
    try {
      const map     = await fetchUsStockMap(currentHoldings.map(h => h.symbol))
      const updated = currentHoldings.map(h => {
        const found = map[h.symbol]
        if (!found) return h
        const price = found.price !== null ? found.price : (h.price > 0 ? h.price : found.previousClose)
        return { ...h, price, previousClose: found.previousClose }
      })
      updateHoldings(updated)
      setLastUpdated(
        new Date().toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      )
      // 取第一個有回傳的股票的 marketState 作為整體市場狀態
      const firstFound = Object.values(map)[0]
      if (firstFound?.marketState) setMarketState(firstFound.marketState)
    } catch (err) {
      console.error('[美股價格更新失敗]', err)
      setFetchError('無法取得最新股價，顯示最後已知資料')
    } finally {
      setIsFetching(false)
    }
  }

  useEffect(() => {
    refreshPrices(loadUsHoldings())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd(newHolding) {
    const withChanges = {
      ...newHolding,
      changes: [{ date: todayStr(), shares: newHolding.shares, avgCost: newHolding.avgCost }],
    }
    const next = [...holdings, withChanges]
    updateHoldings(next)
    setModal(null)
    await refreshPrices(next)
  }

  function handleEdit(updatedHolding) {
    const existing = holdings[modal]
    const merged   = applyChange(
      { ...existing, name: updatedHolding.name, symbol: updatedHolding.symbol,
        price: updatedHolding.price, previousClose: updatedHolding.previousClose },
      updatedHolding.shares,
      updatedHolding.avgCost,
    )
    const next = holdings.map((h, i) => i === modal ? merged : h)
    updateHoldings(next)
    setModal(null)
  }

  function handleDelete(index) {
    updateHoldings(holdings.filter((_, i) => i !== index))
  }

  const todaySign = summary.todayPnL >= 0 ? '+' : ''
  const todayColor = twColor(summary.todayPnL)

  return (
    <div>
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 pt-12 pb-4">
        <h1 className="text-lg font-semibold text-gray-800 tracking-wide">美股持股 (USD)</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-600">
            {isFetching ? '更新中...' : `更新 ${lastUpdated}`}
          </span>
          <button
            onClick={() => refreshPrices(holdings)}
            disabled={isFetching}
            className="text-gray-500 transition-colors p-1 disabled:opacity-40"
            title="更新股價"
          >
            <RefreshIcon spinning={isFetching} />
          </button>
        </div>
      </div>

      {fetchError && (
        <p className="mx-4 mb-3 text-xs text-yellow-600 bg-yellow-600/10 rounded-xl px-3 py-2">
          {fetchError}
        </p>
      )}

      {/* Summary Card */}
      <div className="mx-4 mb-4 bg-white rounded-xl p-4 border border-gray-300">
        <div className="mb-4 pb-4 border-b border-gray-200">
          <p className="text-xs text-gray-600 mb-1 uppercase tracking-wider">今日損益</p>
          <p className={`text-[36px] leading-none font-bold ${todayColor}`}>
            {todaySign}${fmtUsd(summary.todayPnL)}
          </p>
          <PercentText value={summary.todayPnLPercent} className="text-base mt-1" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-600 mb-1">累積損益</p>
            <span className={`text-xl font-semibold ${twColor(summary.totalPnL)}`}>
              {summary.totalPnL >= 0 ? '+' : ''}${fmtUsd(summary.totalPnL)}
            </span>
            <div className="mt-0.5">
              <PercentText value={summary.totalPnLPercent} className="text-sm" />
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-1">股票市值</p>
            <p className="text-xl font-semibold text-gray-900">${fmtUsd(summary.marketValue)}</p>
            <p className="text-sm text-gray-600 mt-0.5">成本 ${fmtUsd(summary.totalCost)}</p>
          </div>
        </div>
        <p className="text-[10px] text-gray-400 mt-3">
          {marketState === 'REGULAR' && '交易中（正式盤）'}
          {marketState === 'PRE'     && '盤前時段｜顯示上一正式盤收盤價'}
          {marketState === 'POST'    && '盤後時段｜顯示今日正式盤收盤價'}
          {(marketState === 'UNKNOWN' || !marketState) && ''}
          {marketState !== 'UNKNOWN' && marketState && '　｜　'}
          Yahoo Finance｜約 15 分鐘延遲｜USD
        </p>
      </div>

      {/* Holdings List */}
      <div className="mx-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-gray-600 uppercase tracking-wider">持股明細</p>
          <div className="flex items-center gap-3">
            <p className="text-xs text-gray-600">{holdings.length} 檔</p>
            <button onClick={() => setModal('add')}
              className="text-xs text-gray-700 border border-gray-300 hover:border-gray-400 rounded-lg px-2.5 py-1 transition-colors">
              + 新增
            </button>
          </div>
        </div>
        {holdings.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-300 p-8 text-center">
            <p className="text-gray-600 text-sm">尚無美股持股</p>
            <p className="text-gray-500 text-xs mt-1">點擊「+ 新增」加入第一筆</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-300 overflow-hidden">
            {stocks.map((stock, index) => (
              <UsStockRow key={stock.symbol} stock={stock}
                onEdit={() => setModal(index)}
                onDelete={() => handleDelete(index)} />
            ))}
          </div>
        )}
      </div>

      {/* Modal */}
      {modal === 'add' && (
        <UsHoldingForm initial={null} onSave={handleAdd} onCancel={() => setModal(null)} />
      )}
      {typeof modal === 'number' && (
        <UsHoldingForm initial={holdings[modal]} onSave={handleEdit} onCancel={() => setModal(null)} />
      )}
    </div>
  )
}

// ─── 底部導覽列 ───────────────────────────────────────────────────────────────

function BottomNav({ activePage, onNavigate, advancedMode }) {
  const normalTabs = [
    {
      id: 'portfolio',
      label: '台股持股',
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
    {
      id: 'us-holdings',
      label: '美股持股',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      ),
    },
  ]

  const advancedTabs = [
    {
      id: 'exposure',
      label: '曝險',
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
      id: 'ledger',
      label: '記帳',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
      ),
    },
    {
      id: 'performance',
      label: '績效',
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
    return (saved === 'portfolio' || saved === 'watchlist' || saved === 'us-holdings') ? saved : 'portfolio'
  })
  const [advancedTab, setAdvancedTab] = useState(() => {
    const saved = localStorage.getItem(ADVANCED_TAB_KEY)
    return (saved === 'exposure' || saved === 'ledger' || saved === 'performance') ? saved : 'exposure'
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
    const date = newHolding.buyDate || todayStr()
    const withChanges = {
      ...newHolding,
      buyDate: date,
      changes: [{ date, shares: newHolding.shares, avgCost: newHolding.avgCost }],
    }
    const newHoldings = [...holdings, withChanges]
    updateHoldings(newHoldings)
    setModal(null)
    await refreshPrices(newHoldings)
  }

  function handleEdit(updatedHolding) {
    const existing = holdings[modal]
    const merged   = applyChange(
      { ...existing, name: updatedHolding.name, symbol: updatedHolding.symbol,
        price: updatedHolding.price, yesterdayClose: updatedHolding.yesterdayClose },
      updatedHolding.shares,
      updatedHolding.avgCost,
    )
    const updated = holdings.map((h, i) => i === modal ? merged : h)
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

      {/* ── 美股持股頁 ── */}
      {activePage === 'us-holdings' && <UsHoldingsPage />}

      {/* ── 曝險計算頁 ── */}
      {activePage === 'exposure' && <ExposurePage holdings={holdings} onExitAdvanced={handleExitAdvanced} />}

      {/* ── 每月記帳頁 ── */}
      {activePage === 'ledger' && <LedgerPage onExitAdvanced={handleExitAdvanced} />}

      {/* ── 績效 / XIRR 統計頁 ── */}
      {activePage === 'performance' && <PerformancePage onExitAdvanced={handleExitAdvanced} twHoldings={holdings} />}

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
