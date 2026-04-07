import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = () =>
  Boolean(url && anonKey && url.startsWith('http'))

/** Hard cap so a stalled TCP connection does not hang forever (esp. mobile). */
const SUPABASE_FETCH_BUDGET_MS = 95_000

const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : fetch

function fetchWithBudgetTimeout(reqUrl, options = {}) {
  const timer = new AbortController()
  const tid = setTimeout(() => timer.abort(), SUPABASE_FETCH_BUDGET_MS)
  const incoming = options.signal
  let signal = timer.signal
  if (incoming) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([incoming, timer.signal])
    } else {
      if (incoming.aborted) {
        clearTimeout(tid)
        return Promise.reject(incoming.reason ?? new Error('Aborted'))
      }
      incoming.addEventListener(
        'abort',
        () => {
          clearTimeout(tid)
          timer.abort()
        },
        { once: true },
      )
    }
  }
  return nativeFetch(reqUrl, { ...options, signal }).finally(() => clearTimeout(tid))
}

/**
 * Serialize all Supabase Auth storage operations in this tab.
 * Avoids Navigator Lock API races ("another request stole it") from concurrent
 * getSession / refresh / OTP / signOut (common with React Strict Mode).
 */
function createSerializedAuthLock() {
  let chain = Promise.resolve()
  return async (_name, _acquireTimeout, fn) => {
    const run = () => fn()
    const p = chain.then(run, run)
    chain = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }
}

export const supabase = isSupabaseConfigured()
  ? createClient(url, anonKey, {
      global: {
        fetch: fetchWithBudgetTimeout,
      },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Magic-link tokens are applied manually via consumeAuthHashFromUrl (see below).
        detectSessionInUrl: false,
        lock: createSerializedAuthLock(),
      },
    })
  : null

/** Single-flight: React Strict Mode runs effects twice; avoid duplicate setSession / hash clear races. */
let authRedirectConsumePromise = null

function stripAuthFromUrl() {
  const url = new URL(window.location.href)
  url.hash = ''
  ;['code', 'error', 'error_code', 'error_description', 'state'].forEach((k) => url.searchParams.delete(k))
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}`)
}

/**
 * Apply Supabase email / OAuth redirect: PKCE `?code=`, implicit `#access_token=`, or hash errors.
 * Clears auth params on success. Safe to call multiple times (deduped).
 */
export function consumeAuthHashFromUrl() {
  if (!supabase || typeof window === 'undefined') {
    return Promise.resolve({ ok: false, reason: 'no-client' })
  }

  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')

  if (code) {
    if (!authRedirectConsumePromise) {
      authRedirectConsumePromise = supabase.auth
        .exchangeCodeForSession(code)
        .then(({ data, error }) => {
          if (error) {
            return { ok: false, reason: 'exchange-code', error }
          }
          if (!data?.session) {
            return { ok: false, reason: 'no-session', error: new Error('No session returned') }
          }
          stripAuthFromUrl()
          return { ok: true, session: data.session }
        })
        .finally(() => {
          authRedirectConsumePromise = null
        })
    }
    return authRedirectConsumePromise
  }

  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!raw) {
    return Promise.resolve({ ok: false, reason: 'no-hash' })
  }

  const params = new URLSearchParams(raw)
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  const errCode = params.get('error_code')
  const errDesc = params.get('error_description')

  if (errCode || errDesc) {
    let msg = errCode || 'Auth error'
    if (errDesc) {
      try {
        msg = decodeURIComponent(String(errDesc).replace(/\+/g, ' '))
      } catch {
        msg = errDesc
      }
    }
    stripAuthFromUrl()
    return Promise.resolve({ ok: false, reason: 'hash-error', message: msg })
  }

  if (!accessToken || !refreshToken) {
    return Promise.resolve({ ok: false, reason: 'no-tokens' })
  }

  if (!authRedirectConsumePromise) {
    authRedirectConsumePromise = supabase.auth
      .setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
      .then(({ data, error }) => {
        if (error) {
          return { ok: false, reason: 'set-session', error }
        }
        if (!data?.session) {
          return { ok: false, reason: 'no-session', error: new Error('No session returned') }
        }
        stripAuthFromUrl()
        return { ok: true, session: data.session }
      })
      .finally(() => {
        authRedirectConsumePromise = null
      })
  }

  return authRedirectConsumePromise
}
