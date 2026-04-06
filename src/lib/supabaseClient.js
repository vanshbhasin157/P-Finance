import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = () =>
  Boolean(url && anonKey && url.startsWith('http'))

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
let magicLinkFromHashPromise = null

/**
 * If the URL hash contains Supabase implicit flow tokens (email magic link), exchange them for a session.
 * Clears the hash on success. Safe to call multiple times (deduped).
 */
export function consumeAuthHashFromUrl() {
  if (!supabase || typeof window === 'undefined') {
    return Promise.resolve({ ok: false, reason: 'no-client' })
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
    window.history.replaceState(
      {},
      document.title,
      `${window.location.pathname}${window.location.search}`,
    )
    return Promise.resolve({ ok: false, reason: 'hash-error', message: msg })
  }

  if (!accessToken || !refreshToken) {
    return Promise.resolve({ ok: false, reason: 'no-tokens' })
  }

  if (!magicLinkFromHashPromise) {
    magicLinkFromHashPromise = supabase.auth
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
        window.history.replaceState(
          {},
          document.title,
          `${window.location.pathname}${window.location.search}`,
        )
        return { ok: true, session: data.session }
      })
      .finally(() => {
        magicLinkFromHashPromise = null
      })
  }

  return magicLinkFromHashPromise
}
