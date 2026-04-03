import { supabase, isSupabaseConfigured } from './supabaseClient'

export { isSupabaseConfigured }

/**
 * @param {string} userId
 * @returns {Promise<{ data: object, updated_at: string } | null>}
 */
export async function fetchFinanceData(userId) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('user_finance_data')
    .select('data, updated_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * @param {string} userId
 * @param {object} payload — full app state (same shape as localStorage)
 */
export async function upsertFinanceData(userId, payload) {
  if (!supabase) return
  const { error } = await supabase.from('user_finance_data').upsert(
    {
      user_id: userId,
      data: payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (error) throw error
}

export async function sendEmailOtp(email) {
  if (!supabase) throw new Error('Supabase is not configured')
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanEmail) throw new Error('Enter an email address')
  const { error } = await supabase.auth.signInWithOtp({
    email: cleanEmail,
    options: { shouldCreateUser: true },
  })
  if (error) throw error
}

export async function verifyEmailOtp(email, token) {
  if (!supabase) throw new Error('Supabase is not configured')
  const cleanEmail = String(email || '').trim().toLowerCase()
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
