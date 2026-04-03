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
        // Email OTP is verified in-app; URL fragment parsing competes with other auth work.
        detectSessionInUrl: false,
        lock: createSerializedAuthLock(),
      },
    })
  : null
