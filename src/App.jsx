import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import {
  fetchFinanceData,
  isSupabaseConfigured,
  sendEmailOtp,
  signOut,
  upsertFinanceData,
  verifyEmailOtp,
} from './lib/financeRemote'
import { consumeAuthHashFromUrl, supabase } from './lib/supabaseClient'
import './App.css'

const moneyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

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

function calculateLoanOutstanding(
  principal,
  annualRatePercent,
  tenureMonths,
  paymentsMade,
) {
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
  const outstanding = calculateLoanOutstanding(
    loan.principal,
    loan.rate,
    loan.tenureMonths,
    loan.paymentsMade,
  )
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
  return p * (((1 + r) ** n - 1) / (1 - (1 + r) ** (-1)))
}

/** Count of monthly installments credited as of asOfIso (same calendar day rule as typical RD). */
function completedRdInstallmentMonths(startDate, asOfIso) {
  if (!startDate || !asOfIso) return 0
  const start = new Date(`${startDate}T12:00:00`)
  const asOf = new Date(`${asOfIso}T12:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(asOf.getTime())) return 0
  if (asOf < start) return 0
  let months =
    (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth())
  if (asOf.getDate() >= start.getDate()) months += 1
  return Math.max(0, months)
}

/** Accrued RD value today: same formula as maturity but only for installments paid so far. */
function calculateRDCurrentValue(
  monthlyInstallment,
  annualRatePercent,
  tenureMonths,
  startDate,
  maturityDateIso,
) {
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
  const maturityValue = calculateRDMaturityValue(
    row.monthlyInstallment,
    row.rate,
    row.tenureMonths,
  )
  const currentValue = calculateRDCurrentValue(
    row.monthlyInstallment,
    row.rate,
    row.tenureMonths,
    row.startDate,
    maturityDate,
  )
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
  return (currentValue / invested) ** (1 / years) - 1
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
    const v =
      typeof fdValuePerItem === 'function'
        ? fdValuePerItem(i)
        : parseAmount(i.principal ?? i.amount)
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

function SingleFieldCard({ label, value, onChange, placeholder, helper }) {
  return (
    <div className="card">
      <h3>{label}</h3>
      {helper && <p className="helper">{helper}</p>}
      <input
        type="number"
        min="0"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
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

function ListCard({ title, items, onAdd, onDelete, onUpdate, fields, total, helper, pageSize = 10 }) {
  const [entry, setEntry] = useState(
    Object.fromEntries(fields.map((field) => [field.key, ''])),
  )
  const [query, setQuery] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [editingIndex, setEditingIndex] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [page, setPage] = useState(1)

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

  function handleSubmit() {
    const hasAmountField = fields.some((field) => field.key === 'amount')
    if ('name' in entry && !String(entry.name).trim()) return
    if (hasAmountField && (!entry.amount || parseAmount(entry.amount) <= 0)) return
    if (editingIndex !== null && onUpdate) {
      onUpdate(editingIndex, entry)
    } else {
      onAdd(entry)
    }
    resetEntry()
    setDialogOpen(false)
  }

  function openAddDialog() {
    resetEntry()
    setDialogOpen(true)
  }

  function beginEdit(originalIndex) {
    setEditingIndex(originalIndex)
    setEntry({ ...items[originalIndex] })
    setDialogOpen(true)
  }

  const filteredItems = items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .filter(({ item }) => {
      const q = query.trim().toLowerCase()
      const haystack = collectSearchText(item).toLowerCase()
      const matchesQuery = !q || haystack.includes(q)
      const itemDate =
        item.date || item.purchaseDate || item.startDate || item.maturityDate || ''
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
      ? [
          ...panel.querySelectorAll(
            'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((el) => !el.disabled)
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
  }, [dialogOpen, fields])

  const dialogTitleId = `list-form-${title.replace(/\s+/g, '-')}`

  return (
    <div className="card list-card">
      <div className="card-head card-head-with-actions">
        <h3>{title}</h3>
        <div className="card-head-actions">
          <p className="card-total">
            Total: <Currency value={total} />
          </p>
          <button type="button" className="btn-add-new" onClick={openAddDialog}>
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
        {items.length > 0 && totalFiltered === 0 && (
          <div className="list-card-mobile-empty">
            No matching entries. Clear search or date filters.
          </div>
        )}
        {pagedItems.map(({ item, originalIndex }) => (
          <div key={`card-${originalIndex}`} className="list-card-row">
            <div className="list-card-row-head">
              <strong className="list-card-row-title">{item.name || 'Untitled'}</strong>
              <span className="list-card-row-amount">
                <Currency value={parseAmount(item.amount)} />
              </span>
            </div>
            <p className="list-card-row-meta">{listItemDetailsCell(item)}</p>
            <div className="list-card-row-actions">
              {onUpdate && (
                <button type="button" onClick={() => beginEdit(originalIndex)}>
                  Edit
                </button>
              )}
              <button type="button" onClick={() => onDelete(originalIndex)}>
                Remove
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
                  <Currency value={parseAmount(item.amount)} />
                </td>
                <td className="list-table-actions">
                  <div className="table-row-actions">
                    {onUpdate && (
                      <button type="button" onClick={() => beginEdit(originalIndex)}>
                        Edit
                      </button>
                    )}
                    <button type="button" onClick={() => onDelete(originalIndex)}>
                      Remove
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
        <div className="modal-backdrop" role="presentation" onClick={closeDialog}>
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
              <button type="button" className="modal-close" onClick={closeDialog} aria-label="Close">
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="entry-grid modal-entry-grid">
                {fields.map((field) =>
                  field.type === 'select' ? (
                    <select
                      key={field.key}
                      value={entry[field.key] ?? ''}
                      onChange={(event) => updateEntry(field.key, event.target.value)}
                    >
                      <option value="">{field.placeholder}</option>
                      {field.options?.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      key={field.key}
                      type={field.type ?? 'text'}
                      min={field.type === 'number' ? '0' : undefined}
                      placeholder={field.placeholder}
                      value={field.type === 'file' ? undefined : (entry[field.key] ?? '')}
                      onChange={(event) =>
                        updateEntry(
                          field.key,
                          field.type === 'file'
                            ? event.target.files?.[0]?.name ?? ''
                            : event.target.value,
                        )
                      }
                    />
                  ),
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="ghost-btn modal-footer-btn" onClick={closeDialog}>
                Cancel
              </button>
              <button type="button" className="add-btn modal-footer-btn" onClick={handleSubmit}>
                {editingIndex !== null ? 'Save changes' : 'Add entry'}
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

  function handleAddCategory() {
    const cleaned = newCategory.trim()
    if (!cleaned) return
    onAdd(cleaned)
    setNewCategory('')
  }

  return (
    <div className="cards-grid one-col">
      <div className="card">
        <div className="card-head">
          <h3>Spend Category Enums</h3>
        </div>
        <p className="helper">Manage values used in Daily Spends category dropdown.</p>
        <div className="inline-form">
          <input
            type="text"
            value={newCategory}
            onChange={(event) => setNewCategory(event.target.value)}
            placeholder="e.g. Travel"
          />
          <button className="add-btn" type="button" onClick={handleAddCategory}>
            Add Category
          </button>
        </div>

        <ul className="item-list">
          {categories.length === 0 && (
            <li className="empty-row">No categories yet. Add one above.</li>
          )}
          {categories.map((category) => (
            <li key={category}>
              <div>
                <strong>{category}</strong>
              </div>
              <div className="row-actions">
                <button type="button" onClick={() => onDelete(category)}>
                  Remove
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

function DailySpendsPage({
  items,
  total,
  categories,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
  onAddCategory,
  onDeleteCategory,
}) {
  const [newCategory, setNewCategory] = useState('')

  function handleAddCategory() {
    const cleaned = newCategory.trim()
    if (!cleaned) return
    onAddCategory(cleaned)
    setNewCategory('')
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
          />
          <button className="add-btn" type="button" onClick={handleAddCategory}>
            Add Category
          </button>
        </div>
        <ul className="item-list">
          {categories.map((category) => (
            <li key={category}>
              <strong>{category}</strong>
              <div className="row-actions">
                <button type="button" onClick={() => onDeleteCategory(category)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function BudgetPage({ categories, budgets, onSaveBudget }) {
  return (
    <div className="cards-grid one-col">
      <div className="card">
        <h3>Monthly Category Budgets</h3>
        <p className="helper">Set monthly limits used for dashboard over/under alerts.</p>
        <ul className="item-list">
          {categories.map((category) => (
            <li key={category}>
              <strong>{category}</strong>
              <div className="row-actions">
                <input
                  type="number"
                  min="0"
                  placeholder="Monthly budget"
                  value={budgets[category] ?? ''}
                  onChange={(event) => onSaveBudget(category, event.target.value)}
                />
              </div>
            </li>
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
      const el = (
        <path
          key={slice.label}
          d={d}
          fill={colors[i % colors.length]}
          stroke="var(--bg)"
          strokeWidth="1"
        />
      )
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
              {slice.label}{' '}
              <strong>{((slice.value / total) * 100).toFixed(1)}%</strong>
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
  const baseline = selected
    ? simulateLoanPayoff(outstanding, rate, emi, 0)
    : { months: 0, interestTotal: 0, stuck: false }
  const withExtra = selected
    ? simulateLoanPayoff(outstanding, rate, emi, parseAmount(extra))
    : { months: 0, interestTotal: 0, stuck: false }

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
        <p className="helper">
          Uses current outstanding and EMI from a saved loan. Extra payment is added each month.
        </p>
        {loans.length === 0 ? (
          <p className="helper">Add loans on the Loans page first.</p>
        ) : (
          <>
            <div className="filters-row">
              <select
                value={loanIndex}
                onChange={(e) => setLoanIndex(Number(e.target.value))}
              >
                {loans.map((l, i) => (
                  <option key={`loan-opt-${i}`} value={i}>
                    {l.name || `Loan ${i + 1}`}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                placeholder="Extra ₹ / month"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
              />
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
                  {!baseline.stuck && !withExtra.stuck
                    ? moneyFormatter.format(Math.max(0, baseline.interestTotal - withExtra.interestTotal))
                    : '—'}
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
        <p className="helper">
          Cards: set due day or put a date (yyyy-mm-dd) in notes. EMIs: set due day of month.
        </p>
        <ul className="item-list">
          {upcoming.length === 0 && (
            <li className="empty-row">No upcoming items. Add due days on Credit Cards / EMIs.</li>
          )}
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
        <p className="helper">
          Tag MF, Stocks, Assets, FD, RD with asset class. FD/RD default to Debt.
        </p>
        <AllocationPie slices={slices} />
      </div>
      <div className="card">
        <h3>Target vs actual</h3>
        <p className="helper">Set target % per class. Rebalance hint is simplified (largest gap).</p>
        <ul className="item-list">
          {rows.map((row) => (
            <li key={row.cls}>
              <div>
                <strong>{row.cls}</strong>
                <small>
                  Actual {row.act.toFixed(1)}% vs target {row.tgt.toFixed(1)}%
                </small>
              </div>
              <input
                type="number"
                min="0"
                max="100"
                className="target-input"
                value={targets[row.cls] ?? ''}
                onChange={(e) => onTargetChange(row.cls, e.target.value)}
              />
            </li>
          ))}
        </ul>
        {total > 0 && overweight && underweight && Math.abs(overweight.diff) > 1 && (
          <p className="rebalance-hint">
            Hint: <strong>{overweight.cls}</strong> is ~{overweight.diff.toFixed(1)}% above target;
            consider shifting toward <strong>{underweight.cls}</strong> (below target by ~
            {Math.abs(underweight.diff).toFixed(1)}%).
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
  const [backupLabel, setBackupLabel] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [otpInput, setOtpInput] = useState('')
  const [otpSentFor, setOtpSentFor] = useState('')

  return (
    <div className="cards-grid one-col wide">
      <div className="card">
        <h3>Cloud sync (Supabase)</h3>
        {!supabaseConfigured && (
          <p className="helper">
            Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to{' '}
            <code>.env.local</code>, then restart <code>npm run dev</code>. Run the SQL in{' '}
            <code>supabase/migrations/001_user_finance_data.sql</code> in the Supabase SQL Editor.
          </p>
        )}
        {supabaseConfigured && (
          <>
            <p className="helper">
              Sign in with your email OTP to sync the same cloud data across phone and laptop.
              Your <strong>app PIN</strong> below still only locks this device UI.
            </p>
            <p className="helper">
              Supabase may email a magic link and/or a one-time code. Prefer entering the code here.
              Magic links use this site’s address (e.g. Vite <code>http://localhost:5173</code>); in the
              Supabase dashboard open <strong>Authentication → URL Configuration</strong> and set{' '}
              <strong>Site URL</strong> to match, and add the same origin under{' '}
              <strong>Redirect URLs</strong> (e.g. <code>http://localhost:5173/**</code>). If links pointed
              at <code>localhost:3000</code>, update those settings or set{' '}
              <code>VITE_SUPABASE_REDIRECT_URL</code> in <code>.env.local</code>.
            </p>
            <div>
              <div className="inline-form">
                <input
                  type="email"
                  placeholder="name@example.com"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                />
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
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Enter OTP code"
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value)}
                  />
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
                    Sync:{' '}
                    {cloudSync === 'syncing' && 'Saving…'}
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
        <p className="helper">
          Locks this browser tab until unlocked (session). PIN is stored locally with your data.
        </p>
        <div className="inline-form">
          <input
            type="password"
            placeholder="New PIN (4–8 digits)"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
          />
          <button type="button" className="add-btn" onClick={() => { onSetPin(pinInput); setPinInput('') }}>
            Save PIN
          </button>
        </div>
        {pin && (
          <button type="button" className="ghost-btn narrow" onClick={onClearPin}>
            Remove PIN
          </button>
        )}
      </div>

      <div className="card">
        <h3>Versioned backups</h3>
        <p className="helper">Keep restore points in browser storage (last 15).</p>
        <div className="inline-form">
          <input
            type="text"
            placeholder="Label (optional)"
            value={backupLabel}
            onChange={(e) => setBackupLabel(e.target.value)}
          />
          <button type="button" className="add-btn" onClick={() => { onCreateBackup(backupLabel); setBackupLabel('') }}>
            Create backup
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
                <button type="button" onClick={() => onRestore(b.id)}>
                  Restore
                </button>
                <button type="button" onClick={() => onDeleteBackup(b.id)}>
                  Delete
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

function GoalProgressBar({ ratio, label }) {
  const pct = Math.round(Math.min(100, Math.max(0, ratio * 100)))
  return (
    <div
      className="goal-progress"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="goal-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

function HomeQuickPage({ todayTotal, todayIso, categories, onQuickSpend, shortcuts }) {
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  function handleSubmit(event) {
    event.preventDefault()
    const cleaned = category.trim()
    if (!cleaned || parseAmount(amount) <= 0) return
    onQuickSpend({
      name: cleaned,
      amount,
      date: todayIso,
      tag: '',
      attachment: '',
      note: note.trim(),
    })
    setAmount('')
    setNote('')
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
          <select
            id="home-quick-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            required
          >
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
          />
          <button type="submit" className="add-btn home-quick-submit">
            Add to today
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

function DashboardPage({
  totals,
  charts,
  budgetInsights,
  trendView,
  onTrendViewChange,
  goals,
  loans,
  onGoalFieldChange,
}) {
  const emergencyTarget = parseAmount(goals?.emergencyFundTarget)
  const emergencySaved = parseAmount(goals?.emergencyFundSaved)
  const emergencyRatio = emergencyTarget > 0 ? Math.min(1, emergencySaved / emergencyTarget) : 0

  return (
    <>
      <section className="cards-grid two-col goals-section">
        <div className="card">
          <h3>Emergency fund</h3>
          <p className="helper">Target vs amount you have set aside (manual entry).</p>
          <div className="goal-inputs">
            <label>
              <span>Target</span>
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={goals?.emergencyFundTarget ?? ''}
                onChange={(event) => onGoalFieldChange('emergencyFundTarget', event.target.value)}
                placeholder="e.g. 500000"
              />
            </label>
            <label>
              <span>Saved so far</span>
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={goals?.emergencyFundSaved ?? ''}
                onChange={(event) => onGoalFieldChange('emergencyFundSaved', event.target.value)}
                placeholder="e.g. 120000"
              />
            </label>
          </div>
          <GoalProgressBar
            ratio={emergencyRatio}
            label="Emergency fund progress toward target"
          />
          <p className="goal-progress-caption">
            {emergencyTarget > 0
              ? `${moneyFormatter.format(emergencySaved)} of ${moneyFormatter.format(emergencyTarget)}`
              : 'Set a target to see progress.'}
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
                    <span className="loan-goal-date">
                      Payoff {payoff ? formatIsoDateReadable(payoff) : '— (add start date & tenure)'}
                    </span>
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
          <span className={totals.marketGainLoss >= 0 ? 'gain' : 'loss'}>
            {moneyFormatter.format(totals.marketGainLoss)}
          </span>
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
            {budgetInsights.length === 0 && (
              <li className="empty-row">Set category budgets to see over/under alerts.</li>
            )}
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
            {charts.spendsByCategory.length === 0 && (
              <li className="empty-row">No expense data yet.</li>
            )}
          </ul>
          <h3 className="subhead">Biggest Expense Days</h3>
          <ul className="item-list">
            {charts.biggestDays.map((item) => (
              <li key={item.label}>
                <strong>{item.label}</strong>
                <Currency value={item.value} />
              </li>
            ))}
            {charts.biggestDays.length === 0 && (
              <li className="empty-row">No dated spends yet.</li>
            )}
          </ul>
        </div>
      </section>
    </>
  )
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
  const [sessionUnlocked, setSessionUnlocked] = useState(
    () => sessionStorage.getItem('finance-dash-session') === '1',
  )

  const [authUser, setAuthUser] = useState(null)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [authReady, setAuthReady] = useState(() => !isSupabaseConfigured())
  const [remoteHydrated, setRemoteHydrated] = useState(() => !isSupabaseConfigured())
  const [cloudError, setCloudError] = useState(null)
  const [cloudSync, setCloudSync] = useState('idle')

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

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
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

        const { data: { session } } = await supabase.auth.getSession()
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
    setCloudSync('syncing')
    const timer = setTimeout(() => {
      upsertFinanceData(authUser.id, state)
        .then(() => {
          setCloudSync('saved')
          setCloudError(null)
        })
        .catch((e) => {
          setCloudSync('error')
          setCloudError(e?.message || 'Cloud save failed')
        })
    }, 1000)
    return () => clearTimeout(timer)
  }, [state, authUser?.id, remoteHydrated])

  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  function updateField(key, value) {
    setState((prev) => ({ ...prev, [key]: value }))
  }

  function updateGoals(patch) {
    setState((prev) => ({
      ...prev,
      goals: { ...initialState.goals, ...(prev.goals || {}), ...patch },
    }))
  }

  function normalizeItem(key, item) {
    let normalized = { ...item }

    if (key === 'loans') {
      const emi = calculateLoanEmi(item.principal, item.rate, item.tenureMonths)
      const outstanding = calculateLoanOutstanding(
        item.principal,
        item.rate,
        item.tenureMonths,
        item.paymentsMade,
      )
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
      const metrics = calculateHoldingMetrics(item.units, item.avgPrice, item.currentPrice)
      const userNote = item.note ? ` | ${item.note}` : ''
      const yearsHeld = yearsBetween(item.purchaseDate)
      const cagr = calculateCagr(metrics.invested, metrics.currentValue, yearsHeld)
      const cagrPart =
        cagr !== null && yearsHeld >= 0.25 ? ` | CAGR ${(cagr * 100).toFixed(2)}%` : ''
      const realized = parseAmount(item.realizedGain)
      const realizedPart =
        realized !== 0 ? ` | Realized P/L ${moneyFormatter.format(realized)}` : ''
      normalized = {
        ...item,
        assetClass: item.assetClass || (key === 'stocks' ? 'Equity' : 'Equity'),
        amount: String(metrics.currentValue),
        invested: String(metrics.invested),
        gainLoss: String(metrics.gainLoss),
        note: `Invested ${moneyFormatter.format(metrics.invested)} | Unrealized ${moneyFormatter.format(metrics.gainLoss)}${cagrPart}${realizedPart}${userNote}`,
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

  function addItem(key, item) {
    setState((prev) => {
      const normalized = normalizeItem(key, item)

      const next = {
        ...prev,
        [key]: [...prev[key], normalized],
      }
      return next
    })
  }

  function deleteItem(key, index) {
    setState((prev) => {
      const next = {
        ...prev,
        [key]: prev[key].filter((_, itemIndex) => itemIndex !== index),
      }
      return next
    })
  }

  function updateItem(key, index, item) {
    setState((prev) => {
      const nextItems = [...prev[key]]
      nextItems[index] = normalizeItem(key, item)
      const next = { ...prev, [key]: nextItems }
      return next
    })
  }

  function addSpendCategory(value) {
    setState((prev) => {
      const exists = prev.spendCategories.some(
        (category) => category.toLowerCase() === value.toLowerCase(),
      )
      if (exists) return prev
      const next = {
        ...prev,
        spendCategories: [...prev.spendCategories, value],
      }
      return next
    })
  }

  function deleteSpendCategory(value) {
    setState((prev) => {
      const next = {
        ...prev,
        spendCategories: prev.spendCategories.filter((category) => category !== value),
        dailySpends: prev.dailySpends.filter((spend) => spend.name !== value),
      }
      return next
    })
  }

  function saveBudget(category, value) {
    setState((prev) => {
      const next = {
        ...prev,
        categoryBudgets: {
          ...prev.categoryBudgets,
          [category]: String(parseAmount(value)),
        },
      }
      return next
    })
  }

  function updateSettings(patch) {
    setState((prev) => {
      const next = { ...prev, settings: { ...prev.settings, ...patch } }
      return next
    })
  }

  function updateAllocationTarget(cls, value) {
    setState((prev) => {
      const next = {
        ...prev,
        allocationTargets: { ...prev.allocationTargets, [cls]: value },
      }
      return next
    })
  }

  function stripBackupsForSnapshot(s) {
    const { backups: _b, ...rest } = s
    return rest
  }

  function createBackup(label) {
    setState((prev) => {
      const id = `bkp-${Date.now()}`
      const entry = {
        id,
        at: new Date().toISOString(),
        label: label?.trim() || 'Backup',
        data: stripBackupsForSnapshot(prev),
      }
      const next = {
        ...prev,
        backups: [entry, ...(prev.backups || [])].slice(0, 15),
      }
      return next
    })
  }

  function restoreBackup(id) {
    setState((prev) => {
      const entry = prev.backups?.find((b) => b.id === id)
      if (!entry?.data) return prev
      const next = migrateLoadedState({
        ...entry.data,
        backups: prev.backups,
      })
      return next
    })
  }

  function deleteBackup(id) {
    setState((prev) => {
      const next = {
        ...prev,
        backups: (prev.backups || []).filter((b) => b.id !== id),
      }
      return next
    })
  }

  function exportData() {
    const payload = JSON.stringify(
      { data: stripBackupsForSnapshot(state), backups: state.backups || [] },
      null,
      2,
    )
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
      try {
        const parsed = JSON.parse(String(reader.result))
        const merged = parsed.data
          ? migrateLoadedState({ ...parsed.data, backups: parsed.backups || [] })
          : migrateLoadedState(parsed)
        setState(merged)
      } catch {
        /* ignore invalid */
      }
      event.target.value = ''
    }
    reader.readAsText(file)
  }

  const totals = useMemo(() => {
    const income =
      parseAmount(state.monthlySalary) + parseAmount(state.extraIncome)
    const spends = getTotal(state.dailySpends)
    const creditDue = getTotal(state.creditCards)
    const emiDue = getTotal(state.emis)
    const loansDue = getTotal(state.loans)
    const liabilities = creditDue + emiDue + loansDue
    const liquidAssets = getTotal(state.assets)
    const fdPrincipalTotal = state.fds.reduce(
      (sum, item) => sum + parseAmount(item.principal ?? item.amount),
      0,
    )
    const fdMaturityTotal = state.fds.reduce(
      (sum, item) => sum + parseAmount(item.maturityValue ?? item.amount),
      0,
    )
    const fdValueUsed =
      state.netWorthBasis === 'fdMaturity' ? fdMaturityTotal : fdPrincipalTotal
    const marketInvested =
      state.mutualFunds.reduce((sum, item) => sum + parseAmount(item.invested), 0) +
      state.stocks.reduce((sum, item) => sum + parseAmount(item.invested), 0)
    const marketCurrentValue = getTotal(state.mutualFunds) + getTotal(state.stocks)
    const marketGainLoss = marketCurrentValue - marketInvested
    const investments =
      getTotal(state.mutualFunds) +
      getTotal(state.stocks) +
      fdValueUsed +
      getTotal(state.rds)
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
        const spent = state.dailySpends
          .filter((item) => item.name === category)
          .reduce((sum, item) => sum + parseAmount(item.amount), 0)
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
    () =>
      state.dailySpends
        .filter((s) => s.date === todayStr)
        .reduce((sum, s) => sum + parseAmount(s.amount), 0),
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

  const fdValueForAllocation = (item) =>
    state.netWorthBasis === 'fdMaturity'
      ? parseAmount(item.maturityValue)
      : parseAmount(item.principal ?? item.amount)

  function handleSetPin(val) {
    const p = String(val || '').trim()
    if (p.length < 4 || p.length > 12) return
    updateSettings({ pin: p })
    sessionStorage.setItem('finance-dash-session', '1')
    setSessionUnlocked(true)
  }

  function handleClearPin() {
    updateSettings({ pin: '' })
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
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OTP request timed out. Please try again.')), 15000),
        ),
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
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OTP verification timed out. Please retry.')), 15000),
        ),
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
      await Promise.race([
        signOut(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Sign-out timed out. Clearing local session.')), 8000),
        ),
      ])
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
    <main
      className={`app ${isSidebarCollapsed ? 'sidebar-collapsed' : ''} ${
        mobileNavOpen ? 'mobile-nav-open' : ''
      }`}
    >
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
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 18l6-6-6-6" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
                <NavLink
                  key={item.to}
                  to={item.to}
                  title={item.label}
                  onClick={() => setMobileNavOpen(false)}
                >
                  {!isSidebarCollapsed && item.icon && (
                    <span className="nav-item-icon" aria-hidden>
                      {item.icon}
                    </span>
                  )}
                  <span className="nav-item-text">
                    {isSidebarCollapsed ? item.shortLabel : item.label}
                  </span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <button
        type="button"
        className="sidebar-backdrop"
        aria-label="Close navigation"
        onClick={() => setMobileNavOpen(false)}
      />

      <section className="content">
        <header>
          <div className="mobile-header-row">
            <button
              type="button"
              className="mobile-menu-btn"
              aria-label="Open navigation menu"
              onClick={() => setMobileNavOpen(true)}
            >
              ☰
            </button>
            <h1>Personal Finance Dashboard</h1>
          </div>
          <p>Track each category on its own page, with one consolidated dashboard.</p>
          {!state.onboardingComplete && (
            <div className="onboard-banner">
              New here?{' '}
              <NavLink to="/onboarding">Open the setup checklist</NavLink>
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
                <select
                  id="net-worth-basis"
                  value={state.netWorthBasis}
                  onChange={(event) => updateField('netWorthBasis', event.target.value)}
                >
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
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route
            path="/home"
            element={
              <HomeQuickPage
                todayTotal={todaySpendsTotal}
                todayIso={todayStr}
                categories={state.spendCategories}
                onQuickSpend={(item) => addItem('dailySpends', item)}
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
                onGoalFieldChange={(key, value) => updateGoals({ [key]: value })}
              />
            }
          />
          <Route
            path="/budgets"
            element={
              <BudgetPage
                categories={state.spendCategories}
                budgets={state.categoryBudgets}
                onSaveBudget={saveBudget}
              />
            }
          />
          <Route
            path="/onboarding"
            element={
              <OnboardingPage onDone={() => updateField('onboardingComplete', true)} />
            }
          />
          <Route
            path="/loan-planning"
            element={
              <LoanPlanningPage
                loans={state.loans}
                creditCards={state.creditCards}
                emis={state.emis}
              />
            }
          />
          <Route
            path="/investments"
            element={
              <InvestmentsPage
                state={state}
                fdValueFn={fdValueForAllocation}
                targets={state.allocationTargets}
                onTargetChange={updateAllocationTarget}
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
                onCreateBackup={createBackup}
                onRestore={restoreBackup}
                onDeleteBackup={deleteBackup}
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
                  onChange={(value) => updateField('monthlySalary', value)}
                  placeholder="e.g. 100000"
                />
                <SingleFieldCard
                  label="Extra Monthly Income"
                  helper="Freelancing, rent, side income, etc."
                  value={state.extraIncome}
                  onChange={(value) => updateField('extraIncome', value)}
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
                onAddItem={(item) => addItem('dailySpends', item)}
                onUpdateItem={(index, item) => updateItem('dailySpends', index, item)}
                onDeleteItem={(index) => deleteItem('dailySpends', index)}
                onAddCategory={addSpendCategory}
                onDeleteCategory={deleteSpendCategory}
              />
            }
          />
          <Route
            path="/spend-categories"
            element={
              <SpendCategoriesPage
                categories={state.spendCategories}
                onAdd={addSpendCategory}
                onDelete={deleteSpendCategory}
              />
            }
          />
          <Route
            path="/credit-cards"
            element={
              <div className="cards-grid one-col">
                <ListCard
                  title="Credit Cards Pending"
                  helper="Outstanding dues per card."
                  items={state.creditCards}
                  onAdd={(item) => addItem('creditCards', item)}
                  onUpdate={(index, item) => updateItem('creditCards', index, item)}
                  onDelete={(index) => deleteItem('creditCards', index)}
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
                  onAdd={(item) => addItem('emis', item)}
                  onUpdate={(index, item) => updateItem('emis', index, item)}
                  onDelete={(index) => deleteItem('emis', index)}
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
                  onAdd={(item) => addItem('loans', item)}
                  onUpdate={(index, item) => updateItem('loans', index, item)}
                  onDelete={(index) => deleteItem('loans', index)}
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
                  onAdd={(item) => addItem('assets', item)}
                  onUpdate={(index, item) => updateItem('assets', index, item)}
                  onDelete={(index) => deleteItem('assets', index)}
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
                  onAdd={(item) => addItem('mutualFunds', item)}
                  onUpdate={(index, item) => updateItem('mutualFunds', index, item)}
                  onDelete={(index) => deleteItem('mutualFunds', index)}
                  total={getTotal(state.mutualFunds)}
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
                  onAdd={(item) => addItem('stocks', item)}
                  onUpdate={(index, item) => updateItem('stocks', index, item)}
                  onDelete={(index) => deleteItem('stocks', index)}
                  total={getTotal(state.stocks)}
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
                  onAdd={(item) => addItem('fds', item)}
                  onUpdate={(index, item) => updateItem('fds', index, item)}
                  onDelete={(index) => deleteItem('fds', index)}
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
                  onAdd={(item) => addItem('rds', item)}
                  onUpdate={(index, item) => updateItem('rds', index, item)}
                  onDelete={(index) => deleteItem('rds', index)}
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
          <NavLink
            key={tab.to}
            to={tab.to}
            className="mobile-tab-item"
            onClick={() => setMobileNavOpen(false)}
          >
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
