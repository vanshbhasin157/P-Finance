import { supabase, isSupabaseConfigured } from './supabaseClient'

export { isSupabaseConfigured }

function fdLog(...args) {
  if (typeof window !== 'undefined' && window.localStorage?.getItem('finance-dash-sync-log') === '0') return
  console.log(...args)
}

/** Reject if `promise` does not settle in time (mobile networks often stall without failing). */
export function withTimeout(promise, ms, label = 'Request') {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s. Check your connection and try again.`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(id)
        resolve(value)
      },
      (err) => {
        clearTimeout(id)
        reject(err)
      },
    )
  })
}

const UPSERT_TIMEOUT_MS = 45_000

/** Where email magic links should send the user (must be listed in Supabase Auth → URL Configuration). */
function getEmailRedirectTo() {
  const fromEnv = import.meta.env.VITE_SUPABASE_REDIRECT_URL
  if (fromEnv && String(fromEnv).trim().startsWith('http')) {
    return String(fromEnv).trim().replace(/\/$/, '') + '/'
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/`
  }
  return undefined
}

/**
 * @param {string} userId
 * @returns {Promise<{ data: object, updated_at: string } | null>}
 */
export async function fetchFinanceData(userId) {
  if (!supabase) return null
  const { data, error } = await supabase.from('user_finance_data').select('data, updated_at').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return data
}

/**
 * @param {string} userId
 * @param {object} payload — full app state (same shape as localStorage)
 */
export async function upsertFinanceData(userId, payload) {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
  let jsonLen = 0
  try {
    jsonLen = JSON.stringify(payload).length
  } catch (e) {
    fdLog('[finance-dash] upsert:stringify-fail', uid, e?.message)
  }
  fdLog('[finance-dash] upsert:start', {
    uid,
    userIdPrefix: userId ? String(userId).slice(0, 8) : null,
    payloadJsonLen: jsonLen,
    timeoutMs: UPSERT_TIMEOUT_MS,
  })
  if (!supabase) {
    fdLog('[finance-dash] upsert:skip', uid, 'no-client')
    return
  }
  try {
    const { error } = await withTimeout(
      supabase.from('user_finance_data').upsert(
        {
          user_id: userId,
          data: payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      ),
      UPSERT_TIMEOUT_MS,
      'Cloud save',
    )
    if (error) {
      fdLog('[finance-dash] upsert:postgrest-error', uid, error.message, error.code, error.details)
      throw error
    }
    fdLog('[finance-dash] upsert:ok', uid)
  } catch (e) {
    fdLog('[finance-dash] upsert:threw', uid, e?.message, e?.name)
    throw e
  }
}

export async function sendEmailOtp(email) {
  if (!supabase) throw new Error('Supabase is not configured')
  const cleanEmail = String(email || '')
    .trim()
    .toLowerCase()
  if (!cleanEmail) throw new Error('Enter an email address')
  const emailRedirectTo = getEmailRedirectTo()
  const { error } = await supabase.auth.signInWithOtp({
    email: cleanEmail,
    options: {
      shouldCreateUser: true,
      ...(emailRedirectTo ? { emailRedirectTo } : {}),
    },
  })
  if (error) throw error
}

export async function verifyEmailOtp(email, token) {
  if (!supabase) throw new Error('Supabase is not configured')
  const cleanEmail = String(email || '')
    .trim()
    .toLowerCase()
  const cleanToken = String(token || '').trim()
  if (!cleanEmail) throw new Error('Enter an email address')
  if (!cleanToken) throw new Error('Enter the OTP code')
  const { error } = await supabase.auth.verifyOtp({
    email: cleanEmail,
    token: cleanToken,
    type: 'email',
  })
  if (error) throw error
}

export async function signOut() {
  if (!supabase) return
  const { error } = await supabase.auth.signOut({ scope: 'local' })
  if (error) throw error
}
