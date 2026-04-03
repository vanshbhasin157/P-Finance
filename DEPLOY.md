# Deployment Guide (Vercel + Supabase)

## 1) Push code to GitHub

1. Create a GitHub repository.
2. Push this project.

## 2) Deploy on Vercel

1. Open [Vercel](https://vercel.com).
2. Click **Add New -> Project** and import your GitHub repo.
3. Confirm:
   - Framework Preset: **Vite**
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. Add environment variables in Vercel Project Settings:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Click **Deploy**.

`vercel.json` is included to ensure SPA routes (`/dashboard`, `/stocks`, etc.) resolve to `index.html`.

## 3) Supabase checklist

1. Run SQL migration: `supabase/migrations/001_user_finance_data.sql`.
2. Enable **Authentication -> Email** (OTP).
3. Confirm `user_finance_data` table exists with RLS policies.

## 4) Verify cloud sync

1. Open deployed URL.
2. Go to **Settings** and enable cloud sync.
2. Go to **Settings**, enter email, send OTP, and verify.
3. Make a change (e.g., add a spend entry).
4. Confirm header shows **Cloud: synced**.
5. In Supabase Table Editor, verify `user_finance_data.updated_at` changed.

## 5) iPhone usage

1. Open deployed URL in Safari.
2. Use **Share -> Add to Home Screen**.
3. Launch as an app icon for quick access.

## PIN note (important)

The app PIN currently protects local UI access only. It is **not** a cloud identity.  
Use the same email OTP login on each device to access the same cloud data row.
