import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { fetchFinanceData, isSupabaseConfigured, sendEmailOtp, signOut, upsertFinanceData, verifyEmailOtp, withTimeout } from './lib/financeRemote'
import { consumeAuthHashFromUrl, supabase } from './lib/supabaseClient'
import './App.css'

const moneyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

/**
 * Cloud/sync trace logs (filter console by `[finance-dash]`).
 * Silence: localStorage.setItem('finance-dash-sync-log', '0')
 * Force on: localStorage.removeItem('finance-dash-sync-log') or set to '1'
 */
function syncLog(phase, detail) {
  if (typeof window !== 'undefined' && window.localStorage?.getItem('finance-dash-sync-log') === '0') return
  if (detail !== undefined && detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
    console.log(`[finance-dash] ${phase}`, { ...detail })
  } else {
    console.log(`[finance-dash] ${phase}`, detail ?? '')
  }
}

const ASSET_CLASSES = ['Equity', 'Debt', 'Cash', 'Gold', 'Others']

const initialState = {
  monthlySalary: '',
  extraIncome: '',
  spendCategories: ['Food', 'Transport', 'Shopping', 'Bills', 'Health'],
  categoryBudgets: {},
  netWorthBasis: 'fdPrincipal',
  allocationTargets: {
    Equity: '40',
    Debt: '30',
    Cash: '10',
    Gold: '10',
    Others: '10',
  },
  settings: { pin: '' },
  onboardingComplete: false,
  backups: [],
  dailySpends: [],
  creditCards: [],
  loans: [],
  emis: [],
  assets: [],
  mutualFunds: [],
  stocks: [],
  fds: [],
  rds: [],
  goals: {
    emergencyFundTarget: '',
    emergencyFundSaved: '',
  },
}

function migrateLoadedState(raw) {
  const s = typeof raw === 'object' && raw !== null ? raw : {}
  const base = { ...initialState, ...s }
  base.allocationTargets = { ...initialState.allocationTargets, ...(s.allocationTargets || {}) }
  base.settings = { ...initialState.settings, ...(s.settings || {}) }
  base.backups = Array.isArray(s.backups) ? s.backups : []
  base.categoryBudgets = s.categoryBudgets && typeof s.categoryBudgets === 'object' ? s.categoryBudgets : {}
  base.goals = {
    ...initialState.goals,
    ...(s.goals && typeof s.goals === 'object' ? s.goals : {}),
  }
  if (Array.isArray(base.rds)) {
    base.rds = base.rds.map(recomputeStoredRd)
  }
  return base
}

/** True if JSON from Supabase looks like a full saved app state (not empty {}). */
function cloudDataLooksComplete(data) {
  if (!data || typeof data !== 'object') return false
  return 'dailySpends' in data && 'netWorthBasis' in data && Array.isArray(data.dailySpends)
}

function parseAmount(value) {
  const num = Number(value)
  if (Number.isNaN(num) || num < 0) return 0
  return num
}

function toNumber(value) {
  const num = Number(value)
  if (Number.isNaN(num)) return 0
  return num
}

function calculateLoanEmi(principal, annualRatePercent, tenureMonths) {
  const p = Math.max(0, toNumber(principal))
  const months = Math.max(0, toNumber(tenureMonths))
  const monthlyRate = Math.max(0, toNumber(annualRatePercent)) / 1200
  if (!p || !months) return 0
  if (!monthlyRate) return p / months
  const factor = (1 + monthlyRate) ** months
  return (p * monthlyRate * factor) / (factor - 1)
}

function calculateLoanOutstanding(principal, annualRatePercent, tenureMonths, paymentsMade) {
  const p = Math.max(0, toNumber(principal))
  const months = Math.max(0, toNumber(tenureMonths))
  const paid = Math.max(0, toNumber(paymentsMade))
  const monthlyRate = Math.max(0, toNumber(annualRatePercent)) / 1200
  const emi = calculateLoanEmi(p, annualRatePercent, months)
  if (!p || !months || paid >= months) return 0
  if (!monthlyRate) return Math.max(0, p - emi * paid)
  const factor = (1 + monthlyRate) ** paid
  return Math.max(0, p * factor - emi * ((factor - 1) / monthlyRate))
}

function addMonths(isoDate, monthsToAdd) {
  if (!isoDate) return ''
  const date = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(date.getTime())) return ''
  date.setMonth(date.getMonth() + Math.max(0, toNumber(monthsToAdd)))
  return date.toISOString().slice(0, 10)
}

function todayIsoLocal() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatIsoDateReadable(iso) {
  if (!iso) return '—'
  const d = new Date(`${iso}T12:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatTodayHeading(iso) {
  const d = new Date(`${iso}T12:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

function loanPayoffIsoDate(loan) {
  if (!loan?.startDate) return ''
  const n = Math.max(0, Math.floor(toNumber(loan.tenureMonths)))
  if (!n) return ''
  return addMonths(loan.startDate, n)
}

function loanPrincipalPaidRatio(loan) {
  const principal = Math.max(0, toNumber(loan.principal))
  if (!principal) return 0
  const outstanding = calculateLoanOutstanding(loan.principal, loan.rate, loan.tenureMonths, loan.paymentsMade)
  return Math.min(1, Math.max(0, (principal - outstanding) / principal))
}

function calculateFDMaturityValue(principal, annualRatePercent, tenureMonths) {
  const p = Math.max(0, toNumber(principal))
  const rate = Math.max(0, toNumber(annualRatePercent)) / 100
  const years = Math.max(0, toNumber(tenureMonths)) / 12
  if (!p) return 0
  return p * (1 + rate) ** years
}

function calculateHoldingMetrics(units, avgPrice, currentPrice) {
  const qty = Math.max(0, toNumber(units))
  const avg = Math.max(0, toNumber(avgPrice))
  const current = Math.max(0, toNumber(currentPrice))
  const invested = qty * avg
  const currentValue = qty * current
  const gainLoss = currentValue - invested
  return { invested, currentValue, gainLoss }
}

function calculateRDMaturityValue(monthlyInstallment, annualRatePercent, tenureMonths) {
  const p = Math.max(0, toNumber(monthlyInstallment))
  const n = Math.max(0, toNumber(tenureMonths))
  const r = Math.max(0, toNumber(annualRatePercent)) / 400
  if (!p || !n) return 0
  if (!r) return p * n
  return p * (((1 + r) ** n - 1) / (1 - (1 + r) ** -1))
}

/** Count of monthly installments credited as of asOfIso (same calendar day rule as typical RD). */
function completedRdInstallmentMonths(startDate, asOfIso) {
  if (!startDate || !asOfIso) return 0
  const start = new Date(`${startDate}T12:00:00`)
  const asOf = new Date(`${asOfIso}T12:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(asOf.getTime())) return 0
  if (asOf < start) return 0
  let months = (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth())
  if (asOf.getDate() >= start.getDate()) months += 1
  return Math.max(0, months)
}

/** Accrued RD value today: same formula as maturity but only for installments paid so far. */
function calculateRDCurrentValue(monthlyInstallment, annualRatePercent, tenureMonths, startDate, maturityDateIso) {
  const nFull = Math.max(0, Math.floor(toNumber(tenureMonths)))
  const maturityVal = calculateRDMaturityValue(monthlyInstallment, annualRatePercent, nFull)
  if (!nFull) return 0
  const today = new Date().toISOString().slice(0, 10)
  if (maturityDateIso && today >= maturityDateIso) return maturityVal
  if (!startDate) return maturityVal

  const k = Math.min(nFull, completedRdInstallmentMonths(startDate, today))
  if (k <= 0) return 0
  return calculateRDMaturityValue(monthlyInstallment, annualRatePercent, k)
}

function recomputeStoredRd(item) {
  const row = typeof item === 'object' && item !== null ? item : {}
  const maturityDate = addMonths(row.startDate, row.tenureMonths)
  const maturityValue = calculateRDMaturityValue(row.monthlyInstallment, row.rate, row.tenureMonths)
  const currentValue = calculateRDCurrentValue(row.monthlyInstallment, row.rate, row.tenureMonths, row.startDate, maturityDate)
  return {
    ...row,
    assetClass: row.assetClass || 'Debt',
    amount: String(currentValue),
    maturityDate,
    maturityValue: String(maturityValue),
    note: `Maturity ${maturityDate || '-'} | Current ${moneyFormatter.format(currentValue)} | At maturity ${moneyFormatter.format(maturityValue)}`,
  }
}

function getTotal(items) {
  return items.reduce((sum, item) => sum + parseAmount(item.amount), 0)
}

function yearsBetween(isoStart, isoEnd = new Date().toISOString().slice(0, 10)) {
  if (!isoStart) return 0
  const a = new Date(`${isoStart}T00:00:00`)
  const b = new Date(`${isoEnd}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0
  const ms = b - a
  return Math.max(ms / (365.25 * 24 * 60 * 60 * 1000), 0)
}

function calculateCagr(invested, currentValue, years) {
  if (invested <= 0 || years <= 0 || currentValue <= 0) return null
  // Below ~3 months, exponent 1/years explodes for normal returns → Infinity → .toFixed throws.
  if (years < 0.25) return null
  const raw = (currentValue / invested) ** (1 / years) - 1
  return Number.isFinite(raw) ? raw : null
}

/** Simulate months to clear balance and total interest from current outstanding. */
function simulateLoanPayoff(outstanding, annualRatePercent, monthlyEmi, extraMonthly) {
  const r = Math.max(0, toNumber(annualRatePercent)) / 1200
  let bal = Math.max(0, toNumber(outstanding))
  const emi = Math.max(0, toNumber(monthlyEmi))
  const extra = Math.max(0, toNumber(extraMonthly))
  let months = 0
  let interestTotal = 0
  const maxMonths = 600
  while (bal > 0.01 && months < maxMonths) {
    const interest = bal * r
    interestTotal += interest
    const payment = emi + extra
    const toPrincipal = payment - interest
    if (toPrincipal <= 0) {
      return { months: maxMonths, interestTotal: Number.POSITIVE_INFINITY, stuck: true }
    }
    bal = Math.max(0, bal - toPrincipal)
    months += 1
  }
  return { months, interestTotal, stuck: false }
}

function sumAllocationByClass(state, fdValuePerItem) {
  const buckets = { Equity: 0, Debt: 0, Cash: 0, Gold: 0, Others: 0 }
  const add = (item, value) => {
    const cls = item.assetClass && buckets[item.assetClass] !== undefined ? item.assetClass : 'Others'
    buckets[cls] += value
  }
  state.stocks.forEach((i) => add(i, parseAmount(i.amount)))
  state.mutualFunds.forEach((i) => add(i, parseAmount(i.amount)))
  state.assets.forEach((i) => add(i, parseAmount(i.amount)))
  state.fds.forEach((i) => {
    const v = typeof fdValuePerItem === 'function' ? fdValuePerItem(i) : parseAmount(i.principal ?? i.amount)
    add({ assetClass: i.assetClass || 'Debt' }, v)
  })
  state.rds.forEach((i) => add({ assetClass: i.assetClass || 'Debt' }, parseAmount(i.amount)))
  return buckets
}

function parseIsoDateLoose(str) {
  if (!str || typeof str !== 'string') return null
  const m = str.match(/(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

function nextDueDateForDay(dueDay, from = new Date()) {
  const day = Math.min(28, Math.max(1, toNumber(dueDay) || 5))
  const d = new Date(from.getFullYear(), from.getMonth(), day)
  if (d < from) d.setMonth(d.getMonth() + 1)
  return d.toISOString().slice(0, 10)
}

function Currency({ value }) {
  return <span>{moneyFormatter.format(value)}</span>
}

/** Unrealized gain/loss as % of invested; null if cost basis is zero or missing. */
function holdingUnrealizedReturnPct(item) {
  const inv = parseAmount(item?.invested)
  if (inv <= 0) return null
  // gainLoss can be negative; parseAmount() would clamp it to 0 and hide losses.
  const gl = toNumber(item?.gainLoss)
  return (gl / inv) * 100
}

function HoldingReturnPct({ item }) {
  const pct = holdingUnrealizedReturnPct(item)
  if (pct === null) return null
  const abs = Math.abs(pct)
  const decimals = abs >= 100 ? 1 : 2
  const formatted = pct.toFixed(decimals)
  const sign = pct > 0 ? '+' : ''
  const cls =
    pct > 0
      ? 'holding-return-pct holding-return-up'
      : pct < 0
        ? 'holding-return-pct holding-return-down'
        : 'holding-return-pct holding-return-flat'
  return (
    <span className={cls} title="Unrealized return vs invested amount">
      {sign}
      {formatted}%
    </span>
  )
}

function SingleFieldCard({ label, value, onBlurPersist, placeholder, helper }) {
  const [draft, setDraft] = useState(value)
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    setDraft(value)
  }, [value])

  async function handleBlur() {
    if (String(draft) === String(value)) return
    setSyncing(true)
    try {
      await Promise.resolve(onBlurPersist(draft))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="card">
      <h3>{label}</h3>
      {helper && <p className="helper">{helper}</p>}
      <input type="number" min="0" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={handleBlur} placeholder={placeholder} />
      {syncing && <p className="helper field-sync-hint">Syncing to cloud…</p>}
    </div>
  )
}

function collectSearchText(value, depth = 0) {
  if (depth > 4 || value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return ` ${String(value)}`
  }
  if (Array.isArray(value)) {
    return value.map((v) => collectSearchText(v, depth + 1)).join(' ')
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .map((v) => collectSearchText(v, depth + 1))
      .join(' ')
  }
  return ''
}

function truncateListText(str, maxLen = 96) {
  if (str == null || str === '') return ''
  const s = String(str)
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`
}

function listItemDetailsCell(item) {
  const chunks = []
  if (item.date) chunks.push(item.date)
  if (item.note) chunks.push(truncateListText(item.note, 120))
  if (item.tag) chunks.push(`Tag: ${item.tag}`)
  if (item.attachment) chunks.push(`File: ${item.attachment}`)
  const line = chunks.join(' · ')
  return line || '—'
}

/** Stored note = auto summary + this marker + user folio/notes only (mutual funds / stocks). */
const HOLDING_USER_NOTE_MARKER = '\n--- notes ---\n'

/** Strip repeated auto-generated "Invested | Unrealized…" prefixes; return only user-written notes. */
function extractUserNoteFromHoldingStoredNote(stored) {
  if (stored == null) return ''
  const s = String(stored)
  const idx = s.indexOf(HOLDING_USER_NOTE_MARKER)
  if (idx !== -1) {
    return s.slice(idx + HOLDING_USER_NOTE_MARKER.length).trim()
  }
  let rest = s.trim()
  const autoBlock =
    /^(?:\|\s*)?Invested\s[^|]+\|\s*Unrealized\s[^|]+(?:\s*\|\s*CAGR\s[^|]+)?(?:\s*\|\s*Realized P\/L\s[^|]+)?/
  for (let guard = 0; guard < 30 && rest.length > 0; guard++) {
    const m = rest.match(autoBlock)
    if (!m) break
    rest = rest.slice(m[0].length).replace(/^\s*\|\s*/, '').trim()
  }
  return rest
}

/** Newest first: explicit createdAt, else calendar date fields, else array order (higher index = newer). */
function listItemSortTimeMs(item) {
  if (item.createdAt) {
    const t = Date.parse(String(item.createdAt))
    if (!Number.isNaN(t)) return t
  }
  const iso = item.date || item.purchaseDate || item.startDate || item.maturityDate || ''
  if (typeof iso === 'string' && iso.length >= 10) {
    const t = Date.parse(`${iso.slice(0, 10)}T12:00:00`)
    if (!Number.isNaN(t)) return t
  }
  return 0
}

function ListCard({
  title,
  items,
  onAdd,
  onDelete,
  onUpdate,
  fields,
  total,
  helper,
  pageSize = 10,
  sanitizeEntryForEdit,
  showHoldingReturnPct = false,
}) {
  const [entry, setEntry] = useState(Object.fromEntries(fields.map((field) => [field.key, ''])))
  const [query, setQuery] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [editingIndex, setEditingIndex] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [submitSyncing, setSubmitSyncing] = useState(false)
  const [deletingIndex, setDeletingIndex] = useState(null)

  function updateEntry(key, value) {
    setEntry((prev) => ({ ...prev, [key]: value }))
  }

  function resetEntry() {
    setEntry(Object.fromEntries(fields.map((field) => [field.key, ''])))
    setEditingIndex(null)
  }

  function closeDialog() {
    resetEntry()
    setDialogOpen(false)
  }

  async function handleSubmit() {
    const hasAmountField = fields.some((field) => field.key === 'amount')
    if ('name' in entry && !String(entry.name).trim()) return
    if (hasAmountField && (!entry.amount || parseAmount(entry.amount) <= 0)) return
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    syncLog('listSubmit:start', {
      runId,
      title,
      mode: editingIndex !== null ? 'edit' : 'add',
      editingIndex,
      units: entry.units,
      unitsType: typeof entry.units,
      avgPrice: entry.avgPrice,
      currentPrice: entry.currentPrice,
    })
    setSubmitSyncing(true)
    try {
      if (editingIndex !== null && onUpdate) {
        await Promise.resolve(onUpdate(editingIndex, entry))
      } else {
        await Promise.resolve(onAdd(entry))
      }
      syncLog('listSubmit:success', { runId, title })
      resetEntry()
      setDialogOpen(false)
    } catch (err) {
      syncLog('listSubmit:error', {
        runId,
        title,
        message: err?.message,
        name: err?.name,
        stack: err?.stack,
      })
      /* cloudError shown in app header */
    } finally {
      syncLog('listSubmit:finally', { runId, title })
      setSubmitSyncing(false)
    }
  }

  function openAddDialog() {
    resetEntry()
    setDialogOpen(true)
  }

  function beginEdit(originalIndex) {
    setEditingIndex(originalIndex)
    let raw = items[originalIndex] || {}
    if (typeof sanitizeEntryForEdit === 'function') {
      raw = sanitizeEntryForEdit(raw) || raw
    }
    const next = { ...raw }
    for (const f of fields) {
      const v = raw[f.key]
      if (f.type === 'number') {
        next[f.key] = v === undefined || v === null || v === '' ? '' : String(v)
      } else if (f.type === 'select') {
        next[f.key] = v === undefined || v === null ? '' : String(v)
      } else if (f.type === 'file') {
        next[f.key] = v == null ? '' : String(v)
      } else {
        next[f.key] = v == null ? '' : String(v)
      }
    }
    setEntry(next)
    setDialogOpen(true)
  }

  const filteredItems = items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((a, b) => {
      const diff = listItemSortTimeMs(b.item) - listItemSortTimeMs(a.item)
      if (diff !== 0) return diff
      return b.originalIndex - a.originalIndex
    })
    .filter(({ item }) => {
      const q = query.trim().toLowerCase()
      const haystack = collectSearchText(item).toLowerCase()
      const matchesQuery = !q || haystack.includes(q)
      const itemDate = item.date || item.purchaseDate || item.startDate || item.maturityDate || ''
      const matchesFromDate = !fromDate || !itemDate || itemDate >= fromDate
      const matchesToDate = !toDate || !itemDate || itemDate <= toDate
      return matchesQuery && matchesFromDate && matchesToDate
    })

  const totalFiltered = filteredItems.length
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize) || 1)
  const displayPage = Math.min(Math.max(1, page), totalPages)
  const sliceStart = (displayPage - 1) * pageSize
  const pagedItems = filteredItems.slice(sliceStart, sliceStart + pageSize)

  const hasActiveFilters = query.trim() !== '' || Boolean(fromDate) || Boolean(toDate)

  function clearFilters() {
    setQuery('')
    setFromDate('')
    setToDate('')
    setPage(1)
  }

  const modalPanelRef = useRef(null)
  const dialogLaunchFocusRef = useRef(null)

  useEffect(() => {
    if (!dialogOpen) return
    dialogLaunchFocusRef.current = document.activeElement

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        if (submitSyncing) return
        setEditingIndex(null)
        setEntry(Object.fromEntries(fields.map((field) => [field.key, ''])))
        setDialogOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const panel = modalPanelRef.current
    const focusables = panel
      ? [...panel.querySelectorAll('button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
          (el) => !el.disabled,
        )
      : []
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const t = window.setTimeout(() => first?.focus(), 0)

    function onTrapKey(event) {
      if (event.key !== 'Tab' || focusables.length === 0) return
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        }
      } else if (document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    panel?.addEventListener('keydown', onTrapKey)

    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      panel?.removeEventListener('keydown', onTrapKey)
      const toRestore = dialogLaunchFocusRef.current
      if (toRestore && typeof toRestore.focus === 'function') {
        try {
          toRestore.focus()
        } catch {
          /* ignore */
        }
      }
    }
  }, [dialogOpen, fields, submitSyncing])

  const dialogTitleId = `list-form-${title.replace(/\s+/g, '-')}`

  return (
    <div className="card list-card">
      <div className="card-head card-head-with-actions">
        <h3>{title}</h3>
        <div className="card-head-actions">
          <p className="card-total">
            Total: <Currency value={total} />
          </p>
          <button type="button" className="btn-add-new" onClick={openAddDialog} disabled={submitSyncing || deletingIndex !== null}>
            Add new
          </button>
        </div>
      </div>
      {helper && <p className="helper">{helper}</p>}
      <div className="filters-row list-toolbar-filters">
        <input
          type="search"
          name={`list-filter-search-${title.replace(/\s+/g, '-')}`}
          autoComplete="off"
          placeholder="Search..."
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
        />
        <input
          type="date"
          value={fromDate}
          onChange={(event) => {
            setFromDate(event.target.value)
            setPage(1)
          }}
        />
        <input
          type="date"
          value={toDate}
          onChange={(event) => {
            setToDate(event.target.value)
            setPage(1)
          }}
        />
        {hasActiveFilters && (
          <button type="button" className="filter-clear-btn" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div className="list-card-stack" aria-label={`${title} entries`}>
        {items.length === 0 && (
          <div className="list-card-mobile-empty">
            No entries yet. Use <strong>Add new</strong> to create one.
          </div>
        )}
        {items.length > 0 && totalFiltered === 0 && <div className="list-card-mobile-empty">No matching entries. Clear search or date filters.</div>}
        {pagedItems.map(({ item, originalIndex }) => (
          <div key={`card-${originalIndex}`} className="list-card-row">
            <div className="list-card-row-head">
              <strong className="list-card-row-title">{item.name || 'Untitled'}</strong>
              <span
                className={`list-card-row-amount${showHoldingReturnPct ? ' list-card-row-amount--stack' : ''}`}
              >
                <Currency value={parseAmount(item.amount)} />
                {showHoldingReturnPct && <HoldingReturnPct item={item} />}
              </span>
            </div>
            <p className="list-card-row-meta">{listItemDetailsCell(item)}</p>
            <div className="list-card-row-actions">
              {onUpdate && (
                <button type="button" disabled={deletingIndex !== null} onClick={() => beginEdit(originalIndex)}>
                  Edit
                </button>
              )}
              <button
                type="button"
                disabled={deletingIndex !== null}
                onClick={() => {
                  void (async () => {
                    setDeletingIndex(originalIndex)
                    try {
                      await Promise.resolve(onDelete(originalIndex))
                    } catch {
                      /* header */
                    } finally {
                      setDeletingIndex(null)
                    }
                  })()
                }}
              >
                {deletingIndex === originalIndex ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="list-table-wrap">
        <table className="list-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="list-table-details">
                Details
              </th>
              <th scope="col" className="list-table-amount">
                Amount
              </th>
              <th scope="col" className="list-table-actions">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="list-table-empty">
                  No entries yet. Use <strong>Add new</strong> to create one.
                </td>
              </tr>
            )}
            {items.length > 0 && totalFiltered === 0 && (
              <tr>
                <td colSpan={4} className="list-table-empty">
                  No matching entries. Clear search or date filters.
                </td>
              </tr>
            )}
            {pagedItems.map(({ item, originalIndex }) => (
              <tr key={`row-${originalIndex}`}>
                <td className="list-table-name">
                  <span className="list-table-primary">{item.name || 'Untitled'}</span>
                </td>
                <td className="list-table-details">
                  <span className="list-table-meta">{listItemDetailsCell(item)}</span>
                </td>
                <td className="list-table-amount">
                  {showHoldingReturnPct ? (
                    <div className="list-table-amount-stack">
                      <Currency value={parseAmount(item.amount)} />
                      <HoldingReturnPct item={item} />
                    </div>
                  ) : (
                    <Currency value={parseAmount(item.amount)} />
                  )}
                </td>
                <td className="list-table-actions">
                  <div className="table-row-actions">
                    {onUpdate && (
                      <button type="button" disabled={deletingIndex !== null} onClick={() => beginEdit(originalIndex)}>
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={deletingIndex !== null}
                      onClick={() => {
                        void (async () => {
                          setDeletingIndex(originalIndex)
                          try {
                            await Promise.resolve(onDelete(originalIndex))
                          } catch {
                            /* header */
                          } finally {
                            setDeletingIndex(null)
                          }
                        })()
                      }}
                    >
                      {deletingIndex === originalIndex ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalFiltered > 0 && (
        <div className="pagination-bar">
          <span className="pagination-meta">
            Showing {sliceStart + 1}–{sliceStart + pagedItems.length} of {totalFiltered}
          </span>
          <div className="pagination-controls">
            <button
              type="button"
              className="pagination-btn"
              disabled={displayPage <= 1}
              onClick={() =>
                setPage((p) => {
                  const cur = Math.min(Math.max(1, p), totalPages)
                  return Math.max(1, cur - 1)
                })
              }
            >
              Previous
            </button>
            <span className="pagination-page">
              Page {displayPage} of {totalPages}
            </span>
            <button
              type="button"
              className="pagination-btn"
              disabled={displayPage >= totalPages}
              onClick={() =>
                setPage((p) => {
                  const cur = Math.min(Math.max(1, p), totalPages)
                  return Math.min(totalPages, cur + 1)
                })
              }
            >
              Next
            </button>
          </div>
        </div>
      )}

      {dialogOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!submitSyncing) closeDialog()
          }}
        >
          <div
            ref={modalPanelRef}
            className="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h3 id={dialogTitleId}>
                {editingIndex !== null ? 'Edit entry' : 'Add new'} — {title}
              </h3>
              <button type="button" className="modal-close" onClick={closeDialog} disabled={submitSyncing} aria-label="Close">
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="entry-grid modal-entry-grid">
                {fields.map((field) => {
                  const label = field.label || field.placeholder || field.key
                  const fieldId = `list-modal-${title.replace(/\s+/g, '-')}-${field.key}`
                  return field.type === 'select' ? (
                    <div key={field.key} className="modal-field-label">
                      <label className="modal-field-label-text" htmlFor={fieldId}>
                        {label}
                      </label>
                      <select id={fieldId} value={entry[field.key] ?? ''} onChange={(event) => updateEntry(field.key, event.target.value)}>
                        <option value="">Choose…</option>
                        {field.options?.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div key={field.key} className="modal-field-label">
                      <label className="modal-field-label-text" htmlFor={fieldId}>
                        {label}
                      </label>
                      <input
                        id={fieldId}
                        type={field.type ?? 'text'}
                        min={field.type === 'number' ? '0' : undefined}
                        step={field.type === 'number' ? 'any' : undefined}
                        inputMode={field.type === 'number' ? 'decimal' : undefined}
                        placeholder={field.placeholder}
                        autoComplete="off"
                        value={field.type === 'file' ? undefined : (entry[field.key] ?? '')}
                        onChange={(event) => updateEntry(field.key, field.type === 'file' ? (event.target.files?.[0]?.name ?? '') : event.target.value)}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="ghost-btn modal-footer-btn" onClick={closeDialog} disabled={submitSyncing}>
                Cancel
              </button>
              <button type="button" className="add-btn modal-footer-btn" disabled={submitSyncing} onClick={() => void handleSubmit()}>
                {submitSyncing ? 'Syncing to cloud…' : editingIndex !== null ? 'Save changes' : 'Add entry'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SpendCategoriesPage({ categories, onAdd, onDelete }) {
  const [newCategory, setNewCategory] = useState('')
  const [addSyncing, setAddSyncing] = useState(false)
  const [deleting, setDeleting] = useState(null)

  async function handleAddCategory() {
    const cleaned = newCategory.trim()
    if (!cleaned || addSyncing) return
    setAddSyncing(true)
    try {
      await Promise.resolve(onAdd(cleaned))
      setNewCategory('')
    } finally {
      setAddSyncing(false)
    }
  }

  async function handleDelete(category) {
    if (deleting) return
    setDeleting(category)
    try {
      await Promise.resolve(onDelete(category))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="cards-grid one-col">
      <div className="card">
        <div className="card-head">
          <h3>Spend Category Enums</h3>
        </div>
        <p className="helper">Manage values used in Daily Spends category dropdown.</p>
        <div className="inline-form">
          <input type="text" value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="e.g. Travel" disabled={addSyncing} />
          <button className="add-btn" type="button" onClick={handleAddCategory} disabled={addSyncing}>
            {addSyncing ? 'Syncing to cloud…' : 'Add Category'}
          </button>
        </div>

        <ul className="item-list">
          {categories.length === 0 && <li className="empty-row">No categories yet. Add one above.</li>}
          {categories.map((category) => (
            <li key={category}>
              <div>
                <strong>{category}</strong>
              </div>
              <div className="row-actions">
                <button type="button" onClick={() => handleDelete(category)} disabled={deleting !== null}>
                  {deleting === category ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function MiniBarChart({ title, data }) {
  const maxValue = Math.max(...data.map((item) => item.value), 0)
  return (
    <article className="chart-card">
      <h4>{title}</h4>
      {data.length === 0 && <p className="helper">No data yet.</p>}
      <ul className="chart-list">
        {data.map((item) => {
          const width = maxValue > 0 ? (item.value / maxValue) * 100 : 0
          return (
            <li key={item.label}>
              <div className="chart-label-row">
                <span>{item.label}</span>
                <span>{moneyFormatter.format(item.value)}</span>
              </div>
              <div className="chart-track">
                <div className="chart-fill" style={{ width: `${Math.max(width, 3)}%` }} />
              </div>
            </li>
          )
        })}
      </ul>
    </article>
  )
}

function DailySpendsPage({ items, total, categories, onAddItem, onUpdateItem, onDeleteItem, onAddCategory, onDeleteCategory }) {
  const [newCategory, setNewCategory] = useState('')
  const [addSyncing, setAddSyncing] = useState(false)
  const [deleting, setDeleting] = useState(null)

  async function handleAddCategory() {
    const cleaned = newCategory.trim()
    if (!cleaned || addSyncing) return
    setAddSyncing(true)
    try {
      await Promise.resolve(onAddCategory(cleaned))
      setNewCategory('')
    } finally {
      setAddSyncing(false)
    }
  }

  async function handleDeleteCategory(category) {
    if (deleting) return
    setDeleting(category)
    try {
      await Promise.resolve(onDeleteCategory(category))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="cards-grid one-col">
      <ListCard
        title="Daily Spends"
        helper="Choose category from enums and pick a date."
        items={items}
        onAdd={onAddItem}
        onUpdate={onUpdateItem}
        onDelete={onDeleteItem}
        total={total}
        fields={[
          {
            key: 'name',
            type: 'select',
            placeholder: 'Select category',
            options: categories,
          },
          { key: 'amount', type: 'number', placeholder: 'Amount' },
          { key: 'date', type: 'date', placeholder: 'Date' },
          { key: 'tag', placeholder: 'Tag (optional)' },
          { key: 'attachment', type: 'file', placeholder: 'Attachment (optional)' },
          { key: 'note', placeholder: 'Note (optional)' },
        ]}
      />

      <div className="card">
        <h3>Add/Manage Spend Categories</h3>
        <p className="helper">Add a new category here and it will appear in the dropdown above.</p>
        <div className="inline-form">
          <input
            type="text"
            value={newCategory}
            onChange={(event) => setNewCategory(event.target.value)}
            placeholder="e.g. Entertainment"
            disabled={addSyncing}
          />
          <button className="add-btn" type="button" onClick={handleAddCategory} disabled={addSyncing}>
            {addSyncing ? 'Syncing to cloud…' : 'Add Category'}
          </button>
        </div>
        <ul className="item-list">
          {categories.map((category) => (
            <li key={category}>
              <strong>{category}</strong>
              <div className="row-actions">
                <button type="button" onClick={() => handleDeleteCategory(category)} disabled={deleting !== null}>
                  {deleting === category ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function BudgetCategoryRow({ category, budgetValue, onCommit }) {
  const [local, setLocal] = useState(budgetValue ?? '')
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    setLocal(budgetValue ?? '')
  }, [budgetValue])

  async function handleBlur() {
    if (String(local) === String(budgetValue ?? '')) return
    setSyncing(true)
    try {
      await Promise.resolve(onCommit(category, local))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <li>
      <strong>{category}</strong>
      <div className="row-actions budget-row-sync" style={{ flexWrap: 'wrap', gap: '0.35rem' }}>
        <input type="number" min="0" placeholder="Monthly budget" value={local} onChange={(event) => setLocal(event.target.value)} onBlur={handleBlur} />
        {syncing && <span className="helper">Syncing to cloud…</span>}
      </div>
    </li>
  )
}

function BudgetPage({ categories, budgets, onSaveBudget }) {
  return (
    <div className="cards-grid one-col">
      <div className="card">
        <h3>Monthly Category Budgets</h3>
        <p className="helper">Set monthly limits used for dashboard over/under alerts. Values save when you leave each field.</p>
        <ul className="item-list">
          {categories.map((category) => (
            <BudgetCategoryRow key={category} category={category} budgetValue={budgets[category]} onCommit={onSaveBudget} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function AllocationPie({ slices }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (total <= 0) {
    return <p className="helper">Add holdings with asset class to see allocation.</p>
  }
  const colors = ['#2563eb', '#16a34a', '#ca8a04', '#9333ea', '#64748b']
  const cx = 100
  const cy = 100
  const r = 78
  const positive = slices.filter((x) => x.value > 0)
  const { paths } = positive.reduce(
    (acc, slice, i) => {
      const frac = slice.value / total
      const a = frac * 2 * Math.PI
      const start = acc.angle
      const end = start + a
      const x1 = cx + r * Math.cos(start)
      const y1 = cy + r * Math.sin(start)
      const x2 = cx + r * Math.cos(end)
      const y2 = cy + r * Math.sin(end)
      const large = a > Math.PI ? 1 : 0
      const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
      const el = <path key={slice.label} d={d} fill={colors[i % colors.length]} stroke="var(--bg)" strokeWidth="1" />
      return { angle: end, paths: [...acc.paths, el] }
    },
    { angle: -Math.PI / 2, paths: [] },
  )
  return (
    <div className="pie-wrap">
      <svg viewBox="0 0 200 200" className="pie-svg" aria-hidden>
        {paths}
      </svg>
      <ul className="pie-legend">
        {slices
          .filter((x) => x.value > 0)
          .map((slice, i) => (
            <li key={slice.label}>
              <span className="swatch" style={{ background: colors[i % colors.length] }} />
              {slice.label} <strong>{((slice.value / total) * 100).toFixed(1)}%</strong>
            </li>
          ))}
      </ul>
    </div>
  )
}

function LoanPlanningPage({ loans, creditCards, emis }) {
  const [loanIndex, setLoanIndex] = useState(0)
  const [extra, setExtra] = useState('')
  const selected = loans[loanIndex]
  const outstanding = selected ? parseAmount(selected.amount) : 0
  const rate = selected ? toNumber(selected.rate) : 0
  const emi = selected ? calculateLoanEmi(selected.principal, selected.rate, selected.tenureMonths) : 0
  const baseline = selected ? simulateLoanPayoff(outstanding, rate, emi, 0) : { months: 0, interestTotal: 0, stuck: false }
  const withExtra = selected ? simulateLoanPayoff(outstanding, rate, emi, parseAmount(extra)) : { months: 0, interestTotal: 0, stuck: false }

  const cardDebts = creditCards
    .map((c) => ({
      name: c.name || 'Card',
      balance: parseAmount(c.amount),
      rate: 0,
    }))
    .filter((d) => d.balance > 0)
  const loanDebts = loans
    .map((l) => ({
      name: l.name || 'Loan',
      balance: parseAmount(l.amount),
      rate: toNumber(l.rate),
    }))
    .filter((d) => d.balance > 0)
  const allDebts = [...cardDebts, ...loanDebts]
  const snowball = [...allDebts].sort((a, b) => a.balance - b.balance)
  const avalanche = [...allDebts].sort((a, b) => b.rate - a.rate || b.balance - a.balance)

  const today = new Date()
  const events = []
  creditCards.forEach((c) => {
    const fromNote = parseIsoDateLoose(c.note)
    const date = fromNote || nextDueDateForDay(c.dueDay, today)
    events.push({
      date,
      label: `${c.name || 'Card'} — payment`,
      amount: parseAmount(c.amount),
    })
  })
  emis.forEach((e) => {
    events.push({
      date: nextDueDateForDay(e.dueDay, today),
      label: `${e.name || 'EMI'}`,
      amount: parseAmount(e.amount),
    })
  })
  const horizon = new Date(today)
  horizon.setMonth(horizon.getMonth() + 3)
  const upcoming = events
    .filter((e) => {
      const d = new Date(`${e.date}T00:00:00`)
      return !Number.isNaN(d.getTime()) && d >= today && d <= horizon
    })
    .sort((a, b) => (a.date > b.date ? 1 : -1))

  return (
    <div className="cards-grid one-col wide">
      <div className="card">
        <h3>Prepayment simulator</h3>
        <p className="helper">Uses current outstanding and EMI from a saved loan. Extra payment is added each month.</p>
        {loans.length === 0 ? (
          <p className="helper">Add loans on the Loans page first.</p>
        ) : (
          <>
            <div className="filters-row">
              <select value={loanIndex} onChange={(e) => setLoanIndex(Number(e.target.value))}>
                {loans.map((l, i) => (
                  <option key={`loan-opt-${i}`} value={i}>
                    {l.name || `Loan ${i + 1}`}
                  </option>
                ))}
              </select>
              <input type="number" min="0" placeholder="Extra ₹ / month" value={extra} onChange={(e) => setExtra(e.target.value)} />
            </div>
            <ul className="item-list plain">
              <li>
                <span>Baseline months left (approx.)</span>
                <strong>{baseline.stuck ? '—' : baseline.months}</strong>
              </li>
              <li>
                <span>With extra — months (approx.)</span>
                <strong>{withExtra.stuck ? 'EMI too low' : withExtra.months}</strong>
              </li>
              <li>
                <span>Interest saved (approx.)</span>
                <strong>
                  {!baseline.stuck && !withExtra.stuck ? moneyFormatter.format(Math.max(0, baseline.interestTotal - withExtra.interestTotal)) : '—'}
                </strong>
              </li>
            </ul>
          </>
        )}
      </div>

      <div className="cards-grid two-col">
        <div className="card">
          <h3>Snowball (smallest balance first)</h3>
          <ol className="ordered-hints">
            {snowball.length === 0 && <li className="empty-row">No debts with balance.</li>}
            {snowball.map((d) => (
              <li key={d.name + d.balance}>
                {d.name} — <Currency value={d.balance} />
              </li>
            ))}
          </ol>
        </div>
        <div className="card">
          <h3>Avalanche (highest rate first)</h3>
          <ol className="ordered-hints">
            {avalanche.length === 0 && <li className="empty-row">No debts with balance.</li>}
            {avalanche.map((d) => (
              <li key={d.name + d.rate}>
                {d.name} — {d.rate}% — <Currency value={d.balance} />
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="card">
        <h3>Upcoming dues (next ~3 months)</h3>
        <p className="helper">Cards: set due day or put a date (yyyy-mm-dd) in notes. EMIs: set due day of month.</p>
        <ul className="item-list">
          {upcoming.length === 0 && <li className="empty-row">No upcoming items. Add due days on Credit Cards / EMIs.</li>}
          {upcoming.map((e, i) => (
            <li key={e.label + i}>
              <div>
                <strong>{e.date}</strong>
                <small>{e.label}</small>
              </div>
              <Currency value={e.amount} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function AllocationTargetRow({ cls, act, tgt, targetStr, onCommit }) {
  const [local, setLocal] = useState(targetStr ?? '')
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    setLocal(targetStr ?? '')
  }, [targetStr])

  async function handleBlur() {
    if (String(local) === String(targetStr ?? '')) return
    setSyncing(true)
    try {
      await Promise.resolve(onCommit(cls, local))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <li>
      <div>
        <strong>{cls}</strong>
        <small>
          Actual {act.toFixed(1)}% vs target {tgt.toFixed(1)}%
        </small>
      </div>
      <div className="row-actions budget-row-sync" style={{ flexWrap: 'wrap', gap: '0.35rem' }}>
        <input type="number" min="0" max="100" className="target-input" value={local} onChange={(e) => setLocal(e.target.value)} onBlur={handleBlur} />
        {syncing && <span className="helper">Syncing to cloud…</span>}
      </div>
    </li>
  )
}

function InvestmentsPage({ state, fdValueFn, targets, onTargetChange }) {
  const buckets = sumAllocationByClass(state, fdValueFn)
  const slices = Object.entries(buckets).map(([label, value]) => ({ label, value }))
  const total = slices.reduce((s, x) => s + x.value, 0)
  const rows = ASSET_CLASSES.map((cls) => {
    const tgt = parseAmount(targets[cls])
    const act = total > 0 ? (buckets[cls] / total) * 100 : 0
    const diff = act - tgt
    return { cls, tgt, act, diff, value: buckets[cls] }
  })
  const overweight = [...rows].sort((a, b) => b.diff - a.diff)[0]
  const underweight = [...rows].sort((a, b) => a.diff - b.diff)[0]

  return (
    <div className="cards-grid one-col wide">
      <div className="card">
        <h3>Allocation by class</h3>
        <p className="helper">Tag MF, Stocks, Assets, FD, RD with asset class. FD/RD default to Debt.</p>
        <AllocationPie slices={slices} />
      </div>
      <div className="card">
        <h3>Target vs actual</h3>
        <p className="helper">Set target % per class. Values save when you leave each field. Rebalance hint is simplified (largest gap).</p>
        <ul className="item-list">
          {rows.map((row) => (
            <AllocationTargetRow key={row.cls} cls={row.cls} act={row.act} tgt={row.tgt} targetStr={targets[row.cls]} onCommit={onTargetChange} />
          ))}
        </ul>
        {total > 0 && overweight && underweight && Math.abs(overweight.diff) > 1 && (
          <p className="rebalance-hint">
            Hint: <strong>{overweight.cls}</strong> is ~{overweight.diff.toFixed(1)}% above target; consider shifting toward <strong>{underweight.cls}</strong>{' '}
            (below target by ~{Math.abs(underweight.diff).toFixed(1)}%).
          </p>
        )}
      </div>
    </div>
  )
}

function SettingsPage({
  pin,
  onSetPin,
  onClearPin,
  backups,
  onCreateBackup,
  onRestore,
  onDeleteBackup,
  onExport,
  onImportFile,
  supabaseConfigured,
  authUser,
  sendingOtp,
  verifyingOtp,
  signingOut,
  cloudError,
  cloudSync,
  onSendEmailOtp,
  onVerifyEmailOtp,
  onSignOut,
}) {
  const [pinInput, setPinInput] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [backupLabel, setBackupLabel] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [restoreBusyId, setRestoreBusyId] = useState(null)
  const [deleteBusyId, setDeleteBusyId] = useState(null)
  const [emailInput, setEmailInput] = useState('')
  const [otpInput, setOtpInput] = useState('')
  const [otpSentFor, setOtpSentFor] = useState('')

  return (
    <div className="cards-grid one-col wide">
      <div className="card">
        <h3>Cloud sync (Supabase)</h3>
        {!supabaseConfigured && (
          <p className="helper">
            Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env.local</code>, then restart <code>npm run dev</code>. Run
            the SQL in <code>supabase/migrations/001_user_finance_data.sql</code> in the Supabase SQL Editor.
          </p>
        )}
        {supabaseConfigured && (
          <>
            <p className="helper">
              Sign in with your email OTP to sync the same cloud data across phone and laptop. Your <strong>app PIN</strong> below still only locks this device
              UI.
            </p>
            <p className="helper">
              The default Supabase email only shows a <strong>magic link</strong> until you edit the template: Dashboard →{' '}
              <strong>Authentication → Email Templates</strong> → <strong>Magic link</strong>, and add a line like <code>Your code: {'{{ .Token }}'}</code>{' '}
              (6-digit OTP). Same variable is documented in{' '}
              <a href="https://supabase.com/docs/guides/auth/auth-email-templates" target="_blank" rel="noreferrer">
                Email templates
              </a>
              . Then use <strong>Verify OTP</strong> below with that code. Magic links still need <strong>Authentication → URL Configuration</strong> (Site URL
              + Redirect URLs, or <code>VITE_SUPABASE_REDIRECT_URL</code> in <code>.env.local</code>).
            </p>
            <div>
              <div className="inline-form">
                <input type="email" placeholder="name@example.com" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} />
                <button
                  type="button"
                  className="add-btn"
                  disabled={sendingOtp}
                  onClick={async () => {
                    const ok = await onSendEmailOtp(emailInput)
                    if (ok) {
                      setOtpSentFor(String(emailInput).trim().toLowerCase())
                      setOtpInput('')
                    }
                  }}
                >
                  {sendingOtp ? 'Sending…' : 'Send OTP'}
                </button>
              </div>
              {(otpSentFor || !authUser) && (
                <div className="inline-form">
                  <input type="text" inputMode="numeric" placeholder="Enter OTP code" value={otpInput} onChange={(e) => setOtpInput(e.target.value)} />
                  <button
                    type="button"
                    className="add-btn"
                    disabled={verifyingOtp}
                    onClick={async () => {
                      const ok = await onVerifyEmailOtp(otpSentFor || emailInput, otpInput)
                      if (ok) {
                        setOtpInput('')
                        setOtpSentFor('')
                      }
                    }}
                  >
                    {verifyingOtp ? 'Verifying…' : 'Verify OTP'}
                  </button>
                </div>
              )}
              {authUser && (
                <div className="auth-status">
                  <p>
                    Cloud session: <strong>{authUser.email || 'Signed in'}</strong>
                  </p>
                  <p className="helper">
                    Sync: {cloudSync === 'syncing' && 'Saving…'}
                    {cloudSync === 'saved' && 'Saved to cloud'}
                    {cloudSync === 'idle' && 'Ready'}
                    {cloudSync === 'error' && 'Save failed'}
                  </p>
                  <button type="button" className="ghost-btn narrow" onClick={onSignOut} disabled={signingOut}>
                    Turn off cloud sync (sign out)
                  </button>
                </div>
              )}
              {cloudError && <p className="sync-error">{cloudError}</p>}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>App PIN</h3>
        <p className="helper">Locks this browser tab until unlocked (session). PIN is stored locally with your data.</p>
        <div className="inline-form">
          <input type="password" placeholder="New PIN (4–8 digits)" value={pinInput} onChange={(e) => setPinInput(e.target.value)} disabled={pinBusy} />
          <button
            type="button"
            className="add-btn"
            disabled={pinBusy}
            onClick={async () => {
              setPinBusy(true)
              try {
                await Promise.resolve(onSetPin(pinInput))
                setPinInput('')
              } finally {
                setPinBusy(false)
              }
            }}
          >
            {pinBusy ? 'Syncing to cloud…' : 'Save PIN'}
          </button>
        </div>
        {pin && (
          <button
            type="button"
            className="ghost-btn narrow"
            disabled={pinBusy}
            onClick={async () => {
              setPinBusy(true)
              try {
                await Promise.resolve(onClearPin())
              } finally {
                setPinBusy(false)
              }
            }}
          >
            {pinBusy ? 'Syncing…' : 'Remove PIN'}
          </button>
        )}
      </div>

      <div className="card">
        <h3>Versioned backups</h3>
        <p className="helper">Keep restore points in browser storage (last 15).</p>
        <div className="inline-form">
          <input type="text" placeholder="Label (optional)" value={backupLabel} onChange={(e) => setBackupLabel(e.target.value)} />
          <button
            type="button"
            className="add-btn"
            disabled={backupBusy || restoreBusyId !== null || deleteBusyId !== null}
            onClick={async () => {
              setBackupBusy(true)
              try {
                await Promise.resolve(onCreateBackup(backupLabel))
                setBackupLabel('')
              } finally {
                setBackupBusy(false)
              }
            }}
          >
            {backupBusy ? 'Syncing to cloud…' : 'Create backup'}
          </button>
        </div>
        <ul className="item-list">
          {backups.length === 0 && <li className="empty-row">No backups yet.</li>}
          {backups.map((b) => (
            <li key={b.id}>
              <div>
                <strong>{b.label || 'Backup'}</strong>
                <small>{new Date(b.at).toLocaleString()}</small>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={restoreBusyId !== null || deleteBusyId !== null || backupBusy}
                  onClick={async () => {
                    setRestoreBusyId(b.id)
                    try {
                      await Promise.resolve(onRestore(b.id))
                    } finally {
                      setRestoreBusyId(null)
                    }
                  }}
                >
                  {restoreBusyId === b.id ? 'Syncing…' : 'Restore'}
                </button>
                <button
                  type="button"
                  disabled={restoreBusyId !== null || deleteBusyId !== null || backupBusy}
                  onClick={async () => {
                    setDeleteBusyId(b.id)
                    try {
                      await Promise.resolve(onDeleteBackup(b.id))
                    } finally {
                      setDeleteBusyId(null)
                    }
                  }}
                >
                  {deleteBusyId === b.id ? 'Removing…' : 'Delete'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Export / import</h3>
        <p className="helper">Download JSON or import a file to replace all data.</p>
        <div className="row-actions wrap">
          <button type="button" className="add-btn" onClick={onExport}>
            Download JSON
          </button>
          <label className="file-label">
            Import JSON
            <input type="file" accept="application/json" className="sr-only" onChange={onImportFile} />
          </label>
        </div>
      </div>
    </div>
  )
}

function OnboardingPage({ onDone }) {
  const steps = [
    'Set income on Income',
    'Add spend categories and daily spends',
    'Set budgets on Budgets',
    'Add liabilities (cards, EMIs, loans)',
    'Tag investments with asset class on Investments',
  ]
  return (
    <div className="cards-grid one-col">
      <div className="card">
        <h3>Getting started</h3>
        <ol className="ordered-hints">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <button type="button" className="add-btn" onClick={onDone}>
          Mark complete
        </button>
      </div>
    </div>
  )
}

function GoalFundField({ label, goalKey, value, onBlurPersist, placeholder }) {
  const [draft, setDraft] = useState(value ?? '')
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    setDraft(value ?? '')
  }, [value])

  async function handleBlur() {
    if (String(draft) === String(value ?? '')) return
    setSyncing(true)
    try {
      await Promise.resolve(onBlurPersist(goalKey, draft))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <label className="goal-fund-field">
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
      {syncing && <span className="helper goal-sync-hint">Syncing to cloud…</span>}
    </label>
  )
}

function GoalProgressBar({ ratio, label }) {
  const pct = Math.round(Math.min(100, Math.max(0, ratio * 100)))
  return (
    <div className="goal-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="goal-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

function HomeQuickPage({ todayTotal, todayIso, categories, onQuickSpend, shortcuts }) {
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    const cleaned = category.trim()
    if (!cleaned || parseAmount(amount) <= 0 || submitting) return
    setSubmitting(true)
    try {
      await Promise.resolve(
        onQuickSpend({
          name: cleaned,
          amount,
          date: todayIso,
          tag: '',
          attachment: '',
          note: note.trim(),
        }),
      )
      setAmount('')
      setNote('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="cards-grid one-col home-quick">
      <div className="card home-hero">
        <h2>Today</h2>
        <p className="home-today-total">
          <Currency value={todayTotal} />
        </p>
        <p className="helper home-today-label">{formatTodayHeading(todayIso)}</p>
        <p className="helper">Total spends logged for this calendar date.</p>
      </div>

      <div className="card">
        <h3>Quick add spend</h3>
        <form className="home-quick-form" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="home-quick-category">
            Category
          </label>
          <select id="home-quick-category" value={category} onChange={(event) => setCategory(event.target.value)} required disabled={submitting}>
            <option value="">Select category</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="home-quick-amount">
            Amount
          </label>
          <input
            id="home-quick-amount"
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Amount"
            required
            disabled={submitting}
          />
          <label className="sr-only" htmlFor="home-quick-note">
            Note (optional)
          </label>
          <input
            id="home-quick-note"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional)"
            disabled={submitting}
          />
          <button type="submit" className="add-btn home-quick-submit" disabled={submitting}>
            {submitting ? 'Syncing to cloud…' : 'Add to today'}
          </button>
        </form>
      </div>

      <div className="card">
        <h3>Shortcuts</h3>
        <div className="home-shortcuts">
          {shortcuts.map((s) => (
            <NavLink key={s.to} to={s.to} className="home-shortcut-link">
              <span className="home-shortcut-icon" aria-hidden>
                {s.icon}
              </span>
              <span>{s.label}</span>
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  )
}

function DashboardPage({ totals, charts, budgetInsights, trendView, onTrendViewChange, goals, loans, onGoalBlurPersist }) {
  const emergencyTarget = parseAmount(goals?.emergencyFundTarget)
  const emergencySaved = parseAmount(goals?.emergencyFundSaved)
  const emergencyRatio = emergencyTarget > 0 ? Math.min(1, emergencySaved / emergencyTarget) : 0

  return (
    <>
      <section className="cards-grid two-col goals-section">
        <div className="card">
          <h3>Emergency fund</h3>
          <p className="helper">Target vs amount you have set aside (manual entry). Saves when you leave each field.</p>
          <div className="goal-inputs">
            <GoalFundField
              label="Target"
              goalKey="emergencyFundTarget"
              value={goals?.emergencyFundTarget}
              onBlurPersist={onGoalBlurPersist}
              placeholder="e.g. 500000"
            />
            <GoalFundField
              label="Saved so far"
              goalKey="emergencyFundSaved"
              value={goals?.emergencyFundSaved}
              onBlurPersist={onGoalBlurPersist}
              placeholder="e.g. 120000"
            />
          </div>
          <GoalProgressBar ratio={emergencyRatio} label="Emergency fund progress toward target" />
          <p className="goal-progress-caption">
            {emergencyTarget > 0 ? `${moneyFormatter.format(emergencySaved)} of ${moneyFormatter.format(emergencyTarget)}` : 'Set a target to see progress.'}
          </p>
        </div>

        <div className="card">
          <h3>Loan payoff</h3>
          <p className="helper">Estimated last payment date from start + tenure. Progress from principal paid down.</p>
          {loans.length === 0 && <p className="helper">No loans yet — add them under Liabilities → Loans.</p>}
          <ul className="loan-goal-list">
            {loans.map((loan, i) => {
              const payoff = loanPayoffIsoDate(loan)
              const paidRatio = loanPrincipalPaidRatio(loan)
              return (
                <li key={`loan-goal-${loan.name || i}-${i}`}>
                  <div className="loan-goal-head">
                    <strong>{loan.name || 'Loan'}</strong>
                    <span className="loan-goal-date">Payoff {payoff ? formatIsoDateReadable(payoff) : '— (add start date & tenure)'}</span>
                  </div>
                  <GoalProgressBar ratio={paidRatio} label={`${loan.name || 'Loan'} principal paid`} />
                </li>
              )
            })}
          </ul>
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat">
          <h4>Total Monthly Income</h4>
          <Currency value={totals.income} />
        </article>
        <article className="stat">
          <h4>Total Monthly Spends</h4>
          <Currency value={totals.spends} />
        </article>
        <article className="stat">
          <h4>Credit Cards Due</h4>
          <Currency value={totals.creditDue} />
        </article>
        <article className="stat">
          <h4>EMIs Due</h4>
          <Currency value={totals.emiDue} />
        </article>
        <article className="stat">
          <h4>Loans Due</h4>
          <Currency value={totals.loansDue} />
        </article>
        <article className="stat">
          <h4>Total Liabilities</h4>
          <Currency value={totals.liabilities} />
        </article>
        <article className="stat">
          <h4>Total Assets</h4>
          <Currency value={totals.totalAssets} />
        </article>
        <article className="stat">
          <h4>FD Value Used</h4>
          <Currency value={totals.fdValueUsed} />
        </article>
        <article className="stat">
          <h4>MF + Stocks Invested</h4>
          <Currency value={totals.marketInvested} />
        </article>
        <article className="stat">
          <h4>MF + Stocks Current Value</h4>
          <Currency value={totals.marketCurrentValue} />
        </article>
        <article className="stat">
          <h4>MF + Stocks Gain/Loss</h4>
          <span className={totals.marketGainLoss >= 0 ? 'gain' : 'loss'}>{moneyFormatter.format(totals.marketGainLoss)}</span>
        </article>
        <article className="stat">
          <h4>Net Worth</h4>
          <Currency value={totals.netWorth} />
        </article>
        <article className="stat">
          <h4>Income Left After Spends + EMIs</h4>
          <Currency value={totals.remainingIncome} />
        </article>
      </section>

      <section className="charts-grid">
        <article className="chart-card">
          <h4>Trend View</h4>
          <select value={trendView} onChange={(event) => onTrendViewChange(event.target.value)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </article>
        <MiniBarChart title="Spends by Category" data={charts.spendsByCategory} />
        <MiniBarChart title={`Spend Trend (${charts.trendLabel})`} data={charts.spendsTrend} />
        <MiniBarChart title="Assets Breakdown" data={charts.assetsBreakdown} />
        <MiniBarChart title="Liabilities Breakdown" data={charts.liabilitiesBreakdown} />
      </section>

      <section className="cards-grid two-col">
        <div className="card">
          <h3>Budget vs Actual</h3>
          <ul className="item-list">
            {budgetInsights.length === 0 && <li className="empty-row">Set category budgets to see over/under alerts.</li>}
            {budgetInsights.map((item) => (
              <li key={item.category}>
                <div>
                  <strong>{item.category}</strong>
                  <small>
                    Budget {moneyFormatter.format(item.budget)} vs Spent {moneyFormatter.format(item.spent)}
                  </small>
                </div>
                <span className={item.delta >= 0 ? 'gain' : 'loss'}>
                  {item.delta >= 0 ? 'Under ' : 'Over '}
                  {moneyFormatter.format(Math.abs(item.delta))}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>Top 5 Categories</h3>
          <ul className="item-list">
            {charts.spendsByCategory.slice(0, 5).map((item) => (
              <li key={item.label}>
                <strong>{item.label}</strong>
                <Currency value={item.value} />
              </li>
            ))}
            {charts.spendsByCategory.length === 0 && <li className="empty-row">No expense data yet.</li>}
          </ul>
          <h3 className="subhead">Biggest Expense Days</h3>
          <ul className="item-list">
            {charts.biggestDays.map((item) => (
              <li key={item.label}>
                <strong>{item.label}</strong>
                <Currency value={item.value} />
              </li>
            ))}
            {charts.biggestDays.length === 0 && <li className="empty-row">No dated spends yet.</li>}
          </ul>
        </div>
      </section>
    </>
  )
}

/** Keep email magic-link tokens in the URL until App can call consumeAuthHashFromUrl (Navigate to="/home" used to drop the hash). */
function RootToHome() {
  const { hash, search } = useLocation()
  return <Navigate to={{ pathname: '/home', search, hash }} replace />
}

function App() {
  const location = useLocation()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    return localStorage.getItem('finance-dash-sidebar-collapsed') === 'true'
  })
  const [trendView, setTrendView] = useState('daily')
  const [state, setState] = useState(() => {
    const fromStorage = localStorage.getItem('finance-dash-data')
    if (!fromStorage) return initialState
    try {
      return migrateLoadedState(JSON.parse(fromStorage))
    } catch {
      return initialState
    }
  })

  const [pinDraft, setPinDraft] = useState('')
  const pinEnabled = Boolean(String(state.settings?.pin || '').length > 0)
  const [sessionUnlocked, setSessionUnlocked] = useState(() => sessionStorage.getItem('finance-dash-session') === '1')

  const [authUser, setAuthUser] = useState(null)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [authReady, setAuthReady] = useState(() => !isSupabaseConfigured())
  const [remoteHydrated, setRemoteHydrated] = useState(() => !isSupabaseConfigured())
  const [cloudError, setCloudError] = useState(null)
  const [cloudSync, setCloudSync] = useState('idle')

  const stateRef = useRef(state)
  const remoteHydratedRef = useRef(remoteHydrated)
  const authUserIdRef = useRef(null)
  stateRef.current = state
  remoteHydratedRef.current = remoteHydrated
  authUserIdRef.current = authUser?.id ?? null

  const syncStateToCloud = useCallback(async (snapshot, options = {}) => {
    const cid = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const force = Boolean(options.force)
    syncLog('syncToCloud:enter', {
      cid,
      force,
      remoteHydrated: remoteHydratedRef.current,
      supabaseConfigured: isSupabaseConfigured(),
      uidFromRef: authUserIdRef.current ? `${String(authUserIdRef.current).slice(0, 8)}…` : null,
      mfCount: snapshot?.mutualFunds?.length,
      snapshotJsonLen: (() => {
        try {
          return JSON.stringify(snapshot).length
        } catch (e) {
          return `stringify-error:${e?.message}`
        }
      })(),
    })
    if (!isSupabaseConfigured() || !supabase) {
      syncLog('syncToCloud:skip', { cid, reason: 'no-supabase' })
      return
    }
    if (!force && !remoteHydratedRef.current) {
      syncLog('syncToCloud:skip', { cid, reason: 'not-hydrated' })
      return
    }

    let uid = authUserIdRef.current
    if (!uid) {
      syncLog('syncToCloud:getSession', { cid })
      try {
        const {
          data: { session },
        } = await withTimeout(supabase.auth.getSession(), 15_000, 'Sign-in check')
        uid = session?.user?.id ?? null
        syncLog('syncToCloud:getSession:ok', { cid, hasUid: Boolean(uid) })
      } catch (e) {
        const msg = e?.message || 'Could not verify sign-in'
        syncLog('syncToCloud:getSession:fail', { cid, message: msg })
        setCloudSync('error')
        setCloudError(msg)
        throw new Error(msg)
      }
    }
    if (!uid) {
      syncLog('syncToCloud:skip', { cid, reason: 'no-uid' })
      return
    }

    setCloudSync('syncing')
    syncLog('syncToCloud:upsert:start', { cid, uidPrefix: String(uid).slice(0, 8) })
    try {
      await upsertFinanceData(uid, snapshot)
      syncLog('syncToCloud:upsert:ok', { cid })
      setCloudSync('saved')
      setCloudError(null)
    } catch (e) {
      const msg = e?.message || 'Cloud save failed'
      syncLog('syncToCloud:upsert:fail', { cid, message: msg, name: e?.name, stack: e?.stack })
      setCloudSync('error')
      setCloudError(msg)
      throw new Error(msg)
    }
  }, [])

  const runPersist = useCallback(
    async (mutator) => {
      const rid = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      syncLog('runPersist:start', { rid })
      let snap
      try {
        flushSync(() => {
          setState((prev) => {
            snap = mutator(prev)
            return snap
          })
        })
      } catch (e) {
        syncLog('runPersist:flushError', { rid, message: e?.message, stack: e?.stack })
        throw e
      }
      syncLog('runPersist:flushed', {
        rid,
        mutualFundsCount: snap?.mutualFunds?.length,
        mfUnitsSample: snap?.mutualFunds?.slice(0, 8).map((m, i) => ({ i, units: m?.units })),
      })
      try {
        await syncStateToCloud(snap, { force: true })
        syncLog('runPersist:cloudDone', { rid })
      } catch (e) {
        syncLog('runPersist:cloudRejected', { rid, message: e?.message })
        throw e
      }
    },
    [syncStateToCloud],
  )

  function clearSupabaseLocalSessionKeys() {
    if (typeof window === 'undefined') return
    const keys = Object.keys(window.localStorage)
    keys.forEach((key) => {
      if (key.startsWith('sb-') && key.includes('-auth-token')) {
        window.localStorage.removeItem(key)
      }
    })
  }

  useEffect(() => {
    localStorage.setItem('finance-dash-sidebar-collapsed', String(isSidebarCollapsed))
  }, [isSidebarCollapsed])

  useEffect(() => {
    localStorage.setItem('finance-dash-data', JSON.stringify(state))
  }, [state])

  useEffect(() => {
    if (!isSupabaseConfigured() || !supabase) {
      setAuthReady(true)
      setRemoteHydrated(true)
      return
    }

    async function hydrateFromCloud(userId) {
      setRemoteHydrated(false)
      setCloudError(null)
      try {
        const row = await fetchFinanceData(userId)
        if (row?.data && cloudDataLooksComplete(row.data)) {
          setState(migrateLoadedState(row.data))
        }
      } catch (e) {
        setCloudError(e?.message || 'Could not load cloud data')
      } finally {
        setRemoteHydrated(true)
        setAuthReady(true)
      }
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      setAuthUser(session?.user ?? null)
      if (event === 'SIGNED_OUT') {
        setCloudError(null)
        setCloudSync('idle')
        setRemoteHydrated(true)
        setAuthReady(true)
        return
      }
      if (event === 'SIGNED_IN' && session?.user) {
        setSendingOtp(false)
        setVerifyingOtp(false)
        await hydrateFromCloud(session.user.id)
      }
    })

    void (async () => {
      try {
        const magic = await consumeAuthHashFromUrl()
        if (magic?.message) {
          setCloudError(formatAuthCloudError(magic.message))
        } else if (magic?.error) {
          setCloudError(formatAuthCloudError(magic.error))
        }

        const {
          data: { session },
        } = await supabase.auth.getSession()
        setAuthUser(session?.user ?? null)
        if (session?.user) {
          await hydrateFromCloud(session.user.id)
        } else {
          setRemoteHydrated(true)
          setAuthReady(true)
        }
      } catch (e) {
        setCloudError(formatAuthCloudError(e))
        setRemoteHydrated(true)
        setAuthReady(true)
      }
    })()

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured() || !authUser?.id || !remoteHydrated) return
    const timer = setTimeout(() => {
      void syncStateToCloud(state)
    }, 450)
    return () => clearTimeout(timer)
  }, [state, authUser?.id, remoteHydrated, syncStateToCloud])

  // Mobile: tab backgrounding often cancels the debounced save; flush before the page is hidden.
  useEffect(() => {
    if (!isSupabaseConfigured()) return

    function flushCloudFromRef() {
      void syncStateToCloud(stateRef.current)
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') flushCloudFromRef()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flushCloudFromRef)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flushCloudFromRef)
    }
  }, [syncStateToCloud])

  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  async function updateField(key, value) {
    await runPersist((prev) => ({ ...prev, [key]: value }))
  }

  async function updateGoalsAndPersist(patch) {
    await runPersist((prev) => ({
      ...prev,
      goals: { ...initialState.goals, ...(prev.goals || {}), ...patch },
    }))
  }

  function normalizeItem(key, item) {
    let normalized = { ...item }

    if (key === 'loans') {
      const emi = calculateLoanEmi(item.principal, item.rate, item.tenureMonths)
      const outstanding = calculateLoanOutstanding(item.principal, item.rate, item.tenureMonths, item.paymentsMade)
      normalized = {
        ...item,
        amount: String(outstanding),
        note: `EMI ${moneyFormatter.format(emi)} | Outstanding ${moneyFormatter.format(outstanding)}`,
      }
    }

    if (key === 'fds') {
      const maturityDate = addMonths(item.startDate, item.tenureMonths)
      const maturityValue = calculateFDMaturityValue(item.principal, item.rate, item.tenureMonths)
      normalized = {
        ...item,
        assetClass: item.assetClass || 'Debt',
        amount: String(parseAmount(item.principal)),
        maturityDate,
        maturityValue: String(maturityValue),
        note: `Maturity ${maturityDate || '-'} | Value ${moneyFormatter.format(maturityValue)}`,
      }
    }

    if (key === 'mutualFunds' || key === 'stocks') {
      try {
        const qtyStr = (v) =>
          v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : ''
        const unitsStr = qtyStr(item.units)
        const avgStr = qtyStr(item.avgPrice)
        const curStr = qtyStr(item.currentPrice)
        syncLog('normalizeItem:mfStock', {
          key,
          rawUnits: item.units,
          unitsStr,
          avgStr,
          curStr,
        })
        const metrics = calculateHoldingMetrics(unitsStr, avgStr, curStr)
        const userOnly = extractUserNoteFromHoldingStoredNote(item.note)
        const userSuffix =
          userOnly !== '' ? `${HOLDING_USER_NOTE_MARKER}${userOnly}` : ''
        const yearsHeld = yearsBetween(item.purchaseDate)
        const cagr = calculateCagr(metrics.invested, metrics.currentValue, yearsHeld)
        const cagrPart =
          cagr !== null && Number.isFinite(cagr) ? ` | CAGR ${(cagr * 100).toFixed(2)}%` : ''
        const realized = parseAmount(item.realizedGain)
        const realizedPart = realized !== 0 ? ` | Realized P/L ${moneyFormatter.format(realized)}` : ''
        normalized = {
          ...item,
          assetClass: item.assetClass || (key === 'stocks' ? 'Equity' : 'Equity'),
          units: unitsStr,
          avgPrice: avgStr,
          currentPrice: curStr,
          amount: String(metrics.currentValue),
          invested: String(metrics.invested),
          gainLoss: String(metrics.gainLoss),
          note: `Invested ${moneyFormatter.format(metrics.invested)} | Unrealized ${moneyFormatter.format(metrics.gainLoss)}${cagrPart}${realizedPart}${userSuffix}`,
        }
      } catch (e) {
        syncLog('normalizeItem:mfStockError', {
          key,
          message: e?.message,
          stack: e?.stack,
          rawUnits: item?.units,
        })
        throw e
      }
    }

    if (key === 'rds') {
      normalized = recomputeStoredRd(item)
    }

    if (key === 'assets') {
      normalized = {
        ...item,
        assetClass: item.assetClass || 'Others',
        amount: String(parseAmount(item.amount)),
      }
    }

    return normalized
  }

  async function addItemAndPersist(key, item) {
    const createdAt = new Date().toISOString()
    await runPersist((prev) => {
      const normalized = normalizeItem(key, { ...item, createdAt })
      const withMeta = { ...normalized, createdAt: normalized.createdAt || createdAt }
      return {
        ...prev,
        [key]: [...prev[key], withMeta],
      }
    })
  }

  async function deleteItemAndPersist(key, index) {
    await runPersist((prev) => ({
      ...prev,
      [key]: prev[key].filter((_, itemIndex) => itemIndex !== index),
    }))
  }

  async function updateItemAndPersist(key, index, item) {
    syncLog('updateItemAndPersist:start', {
      key,
      index,
      units: item?.units,
      unitsType: typeof item?.units,
    })
    await runPersist((prev) => {
      const nextItems = [...prev[key]]
      const prevRow = nextItems[index] || {}
      const normalized = normalizeItem(key, {
        ...item,
        createdAt: prevRow.createdAt || item.createdAt || new Date().toISOString(),
      })
      syncLog('updateItemAndPersist:normalized', {
        key,
        index,
        units: normalized.units,
        invested: normalized.invested,
      })
      nextItems[index] = normalized
      return { ...prev, [key]: nextItems }
    })
  }

  async function addSpendCategoryAndPersist(value) {
    await runPersist((prev) => {
      const exists = prev.spendCategories.some((category) => category.toLowerCase() === value.toLowerCase())
      if (exists) return prev
      return {
        ...prev,
        spendCategories: [...prev.spendCategories, value],
      }
    })
  }

  async function deleteSpendCategoryAndPersist(value) {
    await runPersist((prev) => ({
      ...prev,
      spendCategories: prev.spendCategories.filter((category) => category !== value),
      dailySpends: prev.dailySpends.filter((spend) => spend.name !== value),
    }))
  }

  async function saveBudgetAndPersist(category, value) {
    await runPersist((prev) => ({
      ...prev,
      categoryBudgets: {
        ...prev.categoryBudgets,
        [category]: String(parseAmount(value)),
      },
    }))
  }

  async function updateSettingsAndPersist(patch) {
    await runPersist((prev) => ({
      ...prev,
      settings: { ...prev.settings, ...patch },
    }))
  }

  async function updateAllocationTargetAndPersist(cls, value) {
    await runPersist((prev) => ({
      ...prev,
      allocationTargets: { ...prev.allocationTargets, [cls]: value },
    }))
  }

  function stripBackupsForSnapshot(s) {
    const { backups: _b, ...rest } = s
    return rest
  }

  async function createBackupAndPersist(label) {
    await runPersist((prev) => {
      const id = `bkp-${Date.now()}`
      const entry = {
        id,
        at: new Date().toISOString(),
        label: label?.trim() || 'Backup',
        data: stripBackupsForSnapshot(prev),
      }
      return {
        ...prev,
        backups: [entry, ...(prev.backups || [])].slice(0, 15),
      }
    })
  }

  async function restoreBackupAndPersist(id) {
    await runPersist((prev) => {
      const entry = prev.backups?.find((b) => b.id === id)
      if (!entry?.data) return prev
      return migrateLoadedState({
        ...entry.data,
        backups: prev.backups,
      })
    })
  }

  async function deleteBackupAndPersist(id) {
    await runPersist((prev) => ({
      ...prev,
      backups: (prev.backups || []).filter((b) => b.id !== id),
    }))
  }

  function exportData() {
    const payload = JSON.stringify({ data: stripBackupsForSnapshot(state), backups: state.backups || [] }, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `finance-dash-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function importDataFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      void (async () => {
        try {
          const parsed = JSON.parse(String(reader.result))
          const merged = parsed.data ? migrateLoadedState({ ...parsed.data, backups: parsed.backups || [] }) : migrateLoadedState(parsed)
          flushSync(() => {
            setState(merged)
          })
          await syncStateToCloud(merged, { force: true })
        } catch {
          /* ignore invalid */
        }
        event.target.value = ''
      })()
    }
    reader.readAsText(file)
  }

  const totals = useMemo(() => {
    const income = parseAmount(state.monthlySalary) + parseAmount(state.extraIncome)
    const spends = getTotal(state.dailySpends)
    const creditDue = getTotal(state.creditCards)
    const emiDue = getTotal(state.emis)
    const loansDue = getTotal(state.loans)
    const liabilities = creditDue + emiDue + loansDue
    const liquidAssets = getTotal(state.assets)
    const fdPrincipalTotal = state.fds.reduce((sum, item) => sum + parseAmount(item.principal ?? item.amount), 0)
    const fdMaturityTotal = state.fds.reduce((sum, item) => sum + parseAmount(item.maturityValue ?? item.amount), 0)
    const fdValueUsed = state.netWorthBasis === 'fdMaturity' ? fdMaturityTotal : fdPrincipalTotal
    const marketInvested =
      state.mutualFunds.reduce((sum, item) => sum + parseAmount(item.invested), 0) + state.stocks.reduce((sum, item) => sum + parseAmount(item.invested), 0)
    const marketCurrentValue = getTotal(state.mutualFunds) + getTotal(state.stocks)
    const marketGainLoss = marketCurrentValue - marketInvested
    const investments = getTotal(state.mutualFunds) + getTotal(state.stocks) + fdValueUsed + getTotal(state.rds)
    const totalAssets = liquidAssets + investments
    const netWorth = totalAssets - liabilities

    return {
      income,
      spends,
      liabilities,
      creditDue,
      emiDue,
      loansDue,
      totalAssets,
      liquidAssets,
      investments,
      fdValueUsed,
      marketInvested,
      marketCurrentValue,
      marketGainLoss,
      netWorth,
      remainingIncome: income - spends - emiDue,
    }
  }, [state])

  const charts = useMemo(() => {
    const spendsByCategoryMap = state.dailySpends.reduce((acc, spend) => {
      const key = spend.name || 'Uncategorized'
      acc[key] = (acc[key] ?? 0) + parseAmount(spend.amount)
      return acc
    }, {})

    const spendsByCategory = Object.entries(spendsByCategoryMap)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)

    const trendMap = state.dailySpends.reduce((acc, spend) => {
      if (!spend.date) return acc
      const date = new Date(`${spend.date}T00:00:00`)
      if (Number.isNaN(date.getTime())) return acc
      let key = spend.date
      if (trendView === 'weekly') {
        const first = new Date(date)
        first.setDate(first.getDate() - first.getDay())
        key = first.toISOString().slice(0, 10)
      }
      if (trendView === 'monthly') {
        key = spend.date.slice(0, 7)
      }
      acc[key] = (acc[key] ?? 0) + parseAmount(spend.amount)
      return acc
    }, {})
    const spendsTrend = Object.entries(trendMap)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => (a.label > b.label ? 1 : -1))
      .slice(-8)

    const biggestDays = Object.entries(
      state.dailySpends.reduce((acc, spend) => {
        if (!spend.date) return acc
        acc[spend.date] = (acc[spend.date] ?? 0) + parseAmount(spend.amount)
        return acc
      }, {}),
    )
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)

    const assetsBreakdown = [
      { label: 'Assets', value: getTotal(state.assets) },
      { label: 'Mutual Funds', value: getTotal(state.mutualFunds) },
      { label: 'Stocks', value: getTotal(state.stocks) },
      {
        label: 'FDs',
        value:
          state.netWorthBasis === 'fdMaturity'
            ? state.fds.reduce((sum, item) => sum + parseAmount(item.maturityValue), 0)
            : state.fds.reduce((sum, item) => sum + parseAmount(item.principal ?? item.amount), 0),
      },
      { label: 'RDs', value: getTotal(state.rds) },
    ].filter((item) => item.value > 0)

    const liabilitiesBreakdown = [
      { label: 'Credit Cards', value: getTotal(state.creditCards) },
      { label: 'EMIs', value: getTotal(state.emis) },
      { label: 'Loans', value: getTotal(state.loans) },
    ].filter((item) => item.value > 0)

    return {
      spendsByCategory,
      spendsTrend,
      trendLabel: trendView[0].toUpperCase() + trendView.slice(1),
      biggestDays,
      assetsBreakdown,
      liabilitiesBreakdown,
    }
  }, [state, trendView])

  const budgetInsights = useMemo(() => {
    return Object.entries(state.categoryBudgets ?? {})
      .map(([category, budgetValue]) => {
        const budget = parseAmount(budgetValue)
        const spent = state.dailySpends.filter((item) => item.name === category).reduce((sum, item) => sum + parseAmount(item.amount), 0)
        return {
          category,
          budget,
          spent,
          delta: budget - spent,
        }
      })
      .filter((item) => item.budget > 0)
      .sort((a, b) => a.delta - b.delta)
  }, [state.categoryBudgets, state.dailySpends])

  const todayStr = todayIsoLocal()
  const todaySpendsTotal = useMemo(
    () => state.dailySpends.filter((s) => s.date === todayStr).reduce((sum, s) => sum + parseAmount(s.amount), 0),
    [state.dailySpends, todayStr],
  )

  const homeShortcuts = [
    { to: '/dashboard', label: 'Dashboard', icon: '▣' },
    { to: '/daily-spends', label: 'All spends', icon: '≡' },
    { to: '/budgets', label: 'Budgets', icon: '⊕' },
    { to: '/loans', label: 'Loans', icon: '⌁' },
    { to: '/investments', label: 'Investments', icon: '◇' },
  ]

  const navGroups = [
    {
      title: 'Overview',
      sectionIcon: '◉',
      items: [
        { to: '/home', label: 'Home', shortLabel: 'H', icon: '⌂' },
        { to: '/dashboard', label: 'Dashboard', shortLabel: 'DB', icon: '▣' },
        { to: '/onboarding', label: 'Start', shortLabel: '★', icon: '✦' },
      ],
    },
    {
      title: 'Income & spends',
      sectionIcon: '◇',
      items: [
        { to: '/income', label: 'Income', shortLabel: 'IN', icon: '₹' },
        { to: '/daily-spends', label: 'Daily Spends', shortLabel: 'DS', icon: '≡' },
        { to: '/spend-categories', label: 'Categories', shortLabel: 'SC', icon: '#' },
        { to: '/budgets', label: 'Budgets', shortLabel: 'BG', icon: '⊕' },
      ],
    },
    {
      title: 'Liabilities',
      sectionIcon: '▸',
      items: [
        { to: '/credit-cards', label: 'Credit Cards', shortLabel: 'CC', icon: '▭' },
        { to: '/emis', label: 'EMIs', shortLabel: 'EM', icon: '⏱' },
        { to: '/loans', label: 'Loans', shortLabel: 'LN', icon: '⌁' },
        { to: '/loan-planning', label: 'Loan planning', shortLabel: 'LP', icon: '➤' },
      ],
    },
    {
      title: 'Investments',
      sectionIcon: '◆',
      items: [
        { to: '/investments', label: 'Investments', shortLabel: 'IV', icon: '◇' },
        { to: '/assets', label: 'Assets', shortLabel: 'AS', icon: '◎' },
        { to: '/mutual-funds', label: 'Mutual Funds', shortLabel: 'MF', icon: '%' },
        { to: '/stocks', label: 'Stocks', shortLabel: 'ST', icon: '∿' },
        { to: '/fds', label: 'FDs', shortLabel: 'FD', icon: '▢' },
        { to: '/rds', label: 'RDs', shortLabel: 'RD', icon: '▤' },
      ],
    },
    {
      title: 'System',
      sectionIcon: '⚙',
      items: [{ to: '/settings', label: 'Settings', shortLabel: '⚙', icon: '⚙' }],
    },
  ]
  const mobileTabs = [
    { to: '/home', label: 'Home', icon: '⌂' },
    { to: '/dashboard', label: 'Dashboard', icon: '▣' },
    { to: '/daily-spends', label: 'Spends', icon: '≡' },
    { to: '/investments', label: 'Invest', icon: '◇' },
    { to: '/settings', label: 'Settings', icon: '⚙' },
  ]

  const showLock = pinEnabled && !sessionUnlocked

  const fdValueForAllocation = (item) => (state.netWorthBasis === 'fdMaturity' ? parseAmount(item.maturityValue) : parseAmount(item.principal ?? item.amount))

  async function handleSetPin(val) {
    const p = String(val || '').trim()
    if (p.length < 4 || p.length > 12) return
    await updateSettingsAndPersist({ pin: p })
    sessionStorage.setItem('finance-dash-session', '1')
    setSessionUnlocked(true)
  }

  async function handleClearPin() {
    await updateSettingsAndPersist({ pin: '' })
    sessionStorage.removeItem('finance-dash-session')
    setSessionUnlocked(true)
  }

  function tryUnlock() {
    if (pinDraft === state.settings.pin) {
      sessionStorage.setItem('finance-dash-session', '1')
      setSessionUnlocked(true)
      setPinDraft('')
    }
  }

  function formatAuthCloudError(err) {
    const msg = String(err?.message || err || '')
    const lower = msg.toLowerCase()
    if (lower.includes('rate limit') || lower.includes('too many requests') || msg.includes('429')) {
      return 'Supabase is temporarily limiting sign-in emails (rate limit). This can happen after testing from the same network. Wait 30–60 minutes, or in Supabase open Authentication → Rate Limits and raise OTP limits. For higher volume, add custom SMTP (see Supabase Auth rate limits docs).'
    }
    return msg || 'Request failed'
  }

  async function handleSendEmailOtp(email) {
    if (!supabase) return false
    setSendingOtp(true)
    setCloudError(null)
    try {
      await Promise.race([
        sendEmailOtp(email),
        new Promise((_, reject) => setTimeout(() => reject(new Error('OTP request timed out. Please try again.')), 15000)),
      ])
      return true
    } catch (e) {
      setCloudError(formatAuthCloudError(e))
      return false
    } finally {
      setSendingOtp(false)
    }
  }

  async function handleVerifyEmailOtp(email, token) {
    if (!supabase) return false
    setVerifyingOtp(true)
    setCloudError(null)
    try {
      await Promise.race([
        verifyEmailOtp(email, token),
        new Promise((_, reject) => setTimeout(() => reject(new Error('OTP verification timed out. Please retry.')), 15000)),
      ])
      return true
    } catch (e) {
      setCloudError(formatAuthCloudError(e))
      return false
    } finally {
      setVerifyingOtp(false)
    }
  }

  async function handleSignOut() {
    setSigningOut(true)
    setCloudError(null)
    try {
      await Promise.race([signOut(), new Promise((_, reject) => setTimeout(() => reject(new Error('Sign-out timed out. Clearing local session.')), 8000))])
    } catch (e) {
      setCloudError(e?.message || 'Sign-out failed')
    } finally {
      // Make UI immediately reflect sign-out even if auth callback/session persistence is flaky.
      clearSupabaseLocalSessionKeys()
      setAuthUser(null)
      setCloudSync('idle')
      setRemoteHydrated(true)
      setSigningOut(false)
    }
  }

  if (showLock) {
    return (
      <div className="pin-overlay">
        <div className="pin-card">
          <h2>Unlock Finance App</h2>
          <p className="helper">Enter your PIN to continue.</p>
          <input
            type="password"
            autoComplete="off"
            value={pinDraft}
            onChange={(e) => setPinDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && tryUnlock()}
            placeholder="PIN"
          />
          <button type="button" className="add-btn" onClick={tryUnlock}>
            Unlock
          </button>
        </div>
      </div>
    )
  }

  return (
    <main className={`app ${isSidebarCollapsed ? 'sidebar-collapsed' : ''} ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
      <aside className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-head">
          {!isSidebarCollapsed && <h2>Finance App</h2>}
          <button
            type="button"
            className="collapse-btn"
            onClick={() => setIsSidebarCollapsed((prev) => !prev)}
            aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isSidebarCollapsed ? (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            )}
          </button>
        </div>
        <nav className="side-nav">
          {navGroups.map((group) => (
            <div key={group.title} className="nav-section">
              {!isSidebarCollapsed && (
                <div className="nav-section-title">
                  {group.sectionIcon && (
                    <span className="nav-section-icon" aria-hidden>
                      {group.sectionIcon}
                    </span>
                  )}
                  {group.title}
                </div>
              )}
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} title={item.label} onClick={() => setMobileNavOpen(false)}>
                  {!isSidebarCollapsed && item.icon && (
                    <span className="nav-item-icon" aria-hidden>
                      {item.icon}
                    </span>
                  )}
                  <span className="nav-item-text">{isSidebarCollapsed ? item.shortLabel : item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <button type="button" className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />

      <section className="content">
        <header>
          <div className="mobile-header-row">
            <button type="button" className="mobile-menu-btn" aria-label="Open navigation menu" onClick={() => setMobileNavOpen(true)}>
              ☰
            </button>
            <h1>Personal Finance Dashboard</h1>
          </div>
          <p>Track each category on its own page, with one consolidated dashboard.</p>
          {!state.onboardingComplete && (
            <div className="onboard-banner">
              New here? <NavLink to="/onboarding">Open the setup checklist</NavLink>
              {' · '}
              <button type="button" className="linkish" onClick={() => updateField('onboardingComplete', true)}>
                Dismiss
              </button>
            </div>
          )}
          <div className="header-tools">
            {location.pathname === '/dashboard' && (
              <div className="basis-switch">
                <label htmlFor="net-worth-basis">Net worth basis:</label>
                <select id="net-worth-basis" value={state.netWorthBasis} onChange={(event) => updateField('netWorthBasis', event.target.value)}>
                  <option value="fdPrincipal">Use FD Principal</option>
                  <option value="fdMaturity">Use FD Maturity Value</option>
                </select>
              </div>
            )}
            {isSupabaseConfigured() && (
              <div className="cloud-badge" title="Supabase sync status">
                {!authReady && 'Loading cloud…'}
                {authReady && !authUser && 'Local only — sign in under Settings'}
                {authReady && authUser && cloudSync === 'syncing' && 'Cloud: saving…'}
                {authReady && authUser && cloudSync === 'saved' && 'Cloud: synced'}
                {authReady && authUser && cloudSync === 'idle' && 'Cloud: ready'}
                {authReady && authUser && cloudSync === 'error' && 'Cloud: error'}
              </div>
            )}
          </div>
        </header>

        <section className="page">
          <Routes>
            <Route path="/" element={<RootToHome />} />
            <Route
              path="/home"
              element={
                <HomeQuickPage
                  todayTotal={todaySpendsTotal}
                  todayIso={todayStr}
                  categories={state.spendCategories}
                  onQuickSpend={(item) => addItemAndPersist('dailySpends', item)}
                  shortcuts={homeShortcuts}
                />
              }
            />
            <Route
              path="/dashboard"
              element={
                <DashboardPage
                  totals={totals}
                  charts={charts}
                  budgetInsights={budgetInsights}
                  trendView={trendView}
                  onTrendViewChange={setTrendView}
                  goals={state.goals}
                  loans={state.loans}
                  onGoalBlurPersist={(key, value) => updateGoalsAndPersist({ [key]: value })}
                />
              }
            />
            <Route
              path="/budgets"
              element={<BudgetPage categories={state.spendCategories} budgets={state.categoryBudgets} onSaveBudget={saveBudgetAndPersist} />}
            />
            <Route path="/onboarding" element={<OnboardingPage onDone={() => updateField('onboardingComplete', true)} />} />
            <Route path="/loan-planning" element={<LoanPlanningPage loans={state.loans} creditCards={state.creditCards} emis={state.emis} />} />
            <Route
              path="/investments"
              element={
                <InvestmentsPage
                  state={state}
                  fdValueFn={fdValueForAllocation}
                  targets={state.allocationTargets}
                  onTargetChange={updateAllocationTargetAndPersist}
                />
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  pin={state.settings?.pin}
                  onSetPin={handleSetPin}
                  onClearPin={handleClearPin}
                  backups={state.backups || []}
                  onCreateBackup={createBackupAndPersist}
                  onRestore={restoreBackupAndPersist}
                  onDeleteBackup={deleteBackupAndPersist}
                  onExport={exportData}
                  onImportFile={importDataFile}
                  supabaseConfigured={isSupabaseConfigured()}
                  authUser={authUser}
                  sendingOtp={sendingOtp}
                  verifyingOtp={verifyingOtp}
                  signingOut={signingOut}
                  cloudError={cloudError}
                  cloudSync={cloudSync}
                  onSendEmailOtp={handleSendEmailOtp}
                  onVerifyEmailOtp={handleVerifyEmailOtp}
                  onSignOut={handleSignOut}
                />
              }
            />
            <Route
              path="/income"
              element={
                <div className="cards-grid">
                  <SingleFieldCard
                    label="Monthly Salary"
                    helper="Your primary monthly take-home."
                    value={state.monthlySalary}
                    onBlurPersist={(value) => updateField('monthlySalary', value)}
                    placeholder="e.g. 100000"
                  />
                  <SingleFieldCard
                    label="Extra Monthly Income"
                    helper="Freelancing, rent, side income, etc."
                    value={state.extraIncome}
                    onBlurPersist={(value) => updateField('extraIncome', value)}
                    placeholder="e.g. 15000"
                  />
                </div>
              }
            />
            <Route
              path="/daily-spends"
              element={
                <DailySpendsPage
                  items={state.dailySpends}
                  total={totals.spends}
                  categories={state.spendCategories}
                  onAddItem={(item) => addItemAndPersist('dailySpends', item)}
                  onUpdateItem={(index, item) => updateItemAndPersist('dailySpends', index, item)}
                  onDeleteItem={(index) => deleteItemAndPersist('dailySpends', index)}
                  onAddCategory={addSpendCategoryAndPersist}
                  onDeleteCategory={deleteSpendCategoryAndPersist}
                />
              }
            />
            <Route
              path="/spend-categories"
              element={<SpendCategoriesPage categories={state.spendCategories} onAdd={addSpendCategoryAndPersist} onDelete={deleteSpendCategoryAndPersist} />}
            />
            <Route
              path="/credit-cards"
              element={
                <div className="cards-grid one-col">
                  <ListCard
                    title="Credit Cards Pending"
                    helper="Outstanding dues per card."
                    items={state.creditCards}
                    onAdd={(item) => addItemAndPersist('creditCards', item)}
                    onUpdate={(index, item) => updateItemAndPersist('creditCards', index, item)}
                    onDelete={(index) => deleteItemAndPersist('creditCards', index)}
                    total={totals.creditDue}
                    fields={[
                      { key: 'name', placeholder: 'Card name' },
                      { key: 'amount', type: 'number', placeholder: 'Pending amount' },
                      { key: 'dueDay', type: 'number', placeholder: 'Due day 1–28' },
                      { key: 'note', placeholder: 'Notes or yyyy-mm-dd due' },
                    ]}
                  />
                </div>
              }
            />
            <Route
              path="/emis"
              element={
                <div className="cards-grid one-col">
                  <ListCard
                    title="Active EMIs"
                    helper="Your monthly EMI obligations."
                    items={state.emis}
                    onAdd={(item) => addItemAndPersist('emis', item)}
                    onUpdate={(index, item) => updateItemAndPersist('emis', index, item)}
                    onDelete={(index) => deleteItemAndPersist('emis', index)}
                    total={totals.emiDue}
                    fields={[
                      { key: 'name', placeholder: 'EMI name' },
                      { key: 'amount', type: 'number', placeholder: 'Monthly EMI' },
                      { key: 'dueDay', type: 'number', placeholder: 'Due day 1–28' },
                      { key: 'note', placeholder: 'Months left (optional)' },
                    ]}
                  />
                </div>
              }
            />
            <Route
              path="/loans"
              element={
                <div className="cards-grid one-col">
                  <ListCard
                    title="Loans"
                    helper="EMI and outstanding are auto-calculated."
                    items={state.loans}
                    onAdd={(item) => addItemAndPersist('loans', item)}
                    onUpdate={(index, item) => updateItemAndPersist('loans', index, item)}
                    onDelete={(index) => deleteItemAndPersist('loans', index)}
                    total={totals.loansDue}
                    fields={[
                      { key: 'name', placeholder: 'Loan name' },
                      { key: 'principal', type: 'number', placeholder: 'Principal' },
                      { key: 'rate', type: 'number', placeholder: 'Rate % p.a.' },
                      { key: 'tenureMonths', type: 'number', placeholder: 'Tenure (months)' },
                      { key: 'startDate', type: 'date', placeholder: 'Start date' },
                      { key: 'paymentsMade', type: 'number', placeholder: 'Payments made' },
                    ]}
                  />
                </div>
              }
            />
            <Route
              path="/assets"
              element={
                <div className="cards-grid one-col">
                  <ListCard
                    title="Assets"
                    helper="Land, gold, cash, or any owned asset."
                    items={state.assets}
                    onAdd={(item) => addItemAndPersist('assets', item)}
                    onUpdate={(index, item) => updateItemAndPersist('assets', index, item)}
                    onDelete={(index) => deleteItemAndPersist('assets', index)}
                    total={totals.liquidAssets}
                    fields={[
                      { key: 'name', placeholder: 'Asset name' },
                      {
                        key: 'assetClass',
                        type: 'select',
                        placeholder: 'Asset class',
                        options: ASSET_CLASSES,
                      },
                      { key: 'amount', type: 'number', placeholder: 'Current value' },
                      { key: 'note', placeholder: 'Notes (optional)' },
                    ]}
                  />
                </div>
              }
            />
            <Route
              path="/mutual-funds"
              element={
                <div className="cards-grid one-col">
                  <ListCard
                    title="Mutual Funds"
                    helper="Auto-calculates current value and gain/loss from units and NAV."
                    items={state.mutualFunds}
                    onAdd={(item) => addItemAndPersist('mutualFunds', item)}
                    onUpdate={(index, item) => updateItemAndPersist('mutualFunds', index, item)}
                    onDelete={(index) => deleteItemAndPersist('mutualFunds', index)}
                    total={getTotal(state.mutualFunds)}
                    sanitizeEntryForEdit={(row) => ({
                      ...row,
                      note: extractUserNoteFromHoldingStoredNote(row.note),
                    })}
                    showHoldingReturnPct
                    fields={[
                      { key: 'name', placeholder: 'Fund name' },
                      {
                        key: 'assetClass',
                        type: 'select',
                        placeholder: 'Asset class',
                        options: ASSET_CLASSES,
                      },
                      { key: 'units', type: 'number', placeholder: 'Units' },
                      { key: 'avgPrice', type: 'number', placeholder: 'Avg NAV' },
                      { key: 'currentPrice', type: 'number', placeholder: 'Current NAV' },
                      { key: 'purchaseDate', type: 'date', placeholder: 'Purchase date (CAGR)' },
                      { key: 'realizedGain', type: 'number', placeholder: 'Realized P/L' },
                      { key: 'note', placeholder: 'Folio / Notes (optional)' },
                    ]}
                  />
                </div>
              }
            />
            <Route
              path="/stocks"
              element={
                <div className="cards-grid one-col">
                  <ListCard
                    title="Stocks"
                    helper="Auto-calculates current value and gain/loss from qty and prices."
                    items={state.stocks}
                    onAdd={(item) => addItemAndPersist('stocks', item)}
                    onUpdate={(index, item) => updateItemAndPersist('stocks', index, item)}
                    onDelete={(index) => deleteItemAndPersist('stocks', index)}
                    total={getTotal(state.stocks)}
                    sanitizeEntryForEdit={(row) => ({
                      ...row,
                      note: extractUserNoteFromHoldingStoredNote(row.note),
                    })}
                    showHoldingReturnPct
                    fields={[
                      { key: 'name', placeholder: 'Stock name' },
                      {
                        key: 'assetClass',
                        type: 'select',
                        placeholder: 'Asset class',
                        options: ASSET_CLASSES,
                      },
                      { key: 'units', type: 'number', placeholder: 'Qty' },
                      { key: 'avgPrice', type: 'number', placeholder: 'Avg buy price' },
                      { key: 'currentPrice', type: 'number', placeholder: 'Current price' },
                      { key: 'purchaseDate', type: 'date', placeholder: 'Purchase date (CAGR)' },
                      { key: 'realizedGain', type: 'number', placeholder: 'Realized P/L' },
                      { key: 'note', placeholder: 'Broker / Notes (optional)' },
                    ]}
                  />
                </div>
              }
            />
            <Route
              path="/fds"
              element={
                <div className="cards-grid one-col">
                  <ListCard
                    title="Fixed Deposits (FD)"
                    helper="Maturity date/value are auto-calculated."
                    items={state.fds}
                    onAdd={(item) => addItemAndPersist('fds', item)}
                    onUpdate={(index, item) => updateItemAndPersist('fds', index, item)}
                    onDelete={(index) => deleteItemAndPersist('fds', index)}
                    total={totals.fdValueUsed}
                    fields={[
                      { key: 'name', placeholder: 'FD name' },
                      {
                        key: 'assetClass',
                        type: 'select',
                        placeholder: 'Asset class',
                        options: ASSET_CLASSES,
                      },
                      { key: 'principal', type: 'number', placeholder: 'Principal' },
                      { key: 'rate', type: 'number', placeholder: 'Rate % p.a.' },
                      { key: 'tenureMonths', type: 'number', placeholder: 'Tenure (months)' },
                      { key: 'startDate', type: 'date', placeholder: 'Start date' },
                    ]}
                  />
                </div>
              }
            />
            <Route
              path="/rds"
              element={
                <div className="cards-grid one-col">
                  <ListCard
                    title="Recurring Deposits (RD)"
                    helper="List total is current accrued value; maturity date and full maturity amount are in each row note."
                    items={state.rds}
                    onAdd={(item) => addItemAndPersist('rds', item)}
                    onUpdate={(index, item) => updateItemAndPersist('rds', index, item)}
                    onDelete={(index) => deleteItemAndPersist('rds', index)}
                    total={getTotal(state.rds)}
                    fields={[
                      { key: 'name', placeholder: 'RD name' },
                      {
                        key: 'assetClass',
                        type: 'select',
                        placeholder: 'Asset class',
                        options: ASSET_CLASSES,
                      },
                      { key: 'monthlyInstallment', type: 'number', placeholder: 'Monthly installment' },
                      { key: 'rate', type: 'number', placeholder: 'Rate % p.a.' },
                      { key: 'tenureMonths', type: 'number', placeholder: 'Tenure (months)' },
                      { key: 'startDate', type: 'date', placeholder: 'Start date' },
                    ]}
                  />
                </div>
              }
            />
          </Routes>
        </section>
      </section>
      <nav className="mobile-tabbar" aria-label="Quick navigation">
        {mobileTabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className="mobile-tab-item" onClick={() => setMobileNavOpen(false)}>
            <span className="mobile-tab-icon" aria-hidden>
              {tab.icon}
            </span>
            <span className="mobile-tab-label">{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </main>
  )
}

export default App
