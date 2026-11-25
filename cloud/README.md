# Barcode Inventory: cloud version (GitHub Pages + Supabase)

Same features as the PC version (scan in/out, phone camera, dashboard, history, CSV, QR labels, roles), but:

- **The website** is hosted free on **GitHub Pages**, at an address like `https://yourname.github.io/inventory/`.
- **The data** is stored in a free **Supabase** database (in the cloud, not on your PC).
- **No PC needs to stay on**, there are no certificate warnings, and the responsible party can view from anywhere.

## Files

| File | What it is | Goes on GitHub? |
|---|---|---|
| `index.html` | Page skeleton | ✅ |
| `app.js` | All screens and buttons; talks to Supabase | ✅ |
| `app.css` | The look | ✅ |
| `config.js` | Your Supabase address + **publishable** key (safe to be public) | ✅ |
| `supabase-setup.sql` | Creates the database tables and security rules. Run once in Supabase. | not needed |
| `README.md` | This guide | optional |

> The security does **not** depend on hiding the website code. It's enforced inside the database by
> `supabase-setup.sql`: strangers get no access, viewers can't change anything, stock can't go negative,
> and history can't be edited. Never put the Supabase **secret / service_role** key anywhere in these files.

---

## Step 1: Create the Supabase database (about 10 minutes)

1. Go to **https://supabase.com** → **Start your project** → sign up (free). Signing in with GitHub is easiest.
2. Click **New project**:
   - Name: `inventory`
   - Database password: click **Generate**, then **save it somewhere safe** (a password manager).
   - Region: the one closest to you.
   - Plan: **Free**.
3. Wait 1–2 minutes for it to finish setting up.
4. Left menu → **SQL Editor** → **New query**. Open `supabase-setup.sql` in Notepad, copy **everything**, paste it in,
   and click **Run**. You should see "Success. No rows returned".
5. Left menu → **Authentication** → **Sign In / Providers** → **Email** → turn **off** "Confirm email" → **Save**.
   (Recommended: new accounts can't do anything until an admin approves them anyway, and Supabase's free
   email sending is limited to a few emails per hour.)
6. Left menu → **Project Settings** → **API Keys** (or **Data API**). Copy:
   - the **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - the **publishable** key (`sb_publishable_…`) or, on older projects, the **anon public** key.
7. Put those two values in `config.js`.

## Step 2: Put the website on GitHub Pages (about 10 minutes)

1. Sign up at **https://github.com** (free).
2. Top-right **+** → **New repository** → name it `inventory` → **Public** → **Create repository**.
3. Click **uploading an existing file**, then drag in `index.html`, `app.js`, `app.css` and `config.js`
   → **Commit changes**.
4. Repository **Settings** → **Pages** → Source: **Deploy from a branch** → Branch: **main**, folder **/ (root)** → **Save**.
5. After about a minute the page shows your address: `https://YOUR-NAME.github.io/inventory/`.
6. Back in Supabase → **Authentication** → **URL Configuration** → set **Site URL** to that address → **Save**
   (needed for "Forgot password" emails).

## Step 3: First sign-in

1. Open your GitHub Pages address → **Create an account**. **The first account becomes the admin.** Do this
   straight away.
2. Send the address to staff and the responsible party. They click **Create an account** and show up in
   **Users** as *pending*. Give each a role: **viewer** for the responsible party, **operator** for scanning staff.

## Step 4: Keep-alive, so the free database never pauses (about 5 minutes)

Supabase pauses free projects after about a week without use. A free scheduler pings it every 2 days:

1. Sign up at **https://cron-job.org** (free).
2. **Create cronjob**:
   - Title: `Inventory keep-alive`
   - URL: `https://YOUR-PROJECT.supabase.co/rest/v1/rpc/keep_alive`
   - Schedule: **Custom**, every **2 days** (e.g. at 03:00)
   - **Advanced** tab:
     - Request method: **POST**
     - Headers: `apikey` = your publishable key, and `Content-Type` = `application/json`
     - Request body: `{}`
3. Save, then click **Test run**. The response should be `"ok"`.

If it ever does pause anyway, your data is safe: sign in at supabase.com → open the project → **Restore**.

## Updating the website later

Edit the file, then in your GitHub repository click the file → ✏️ (edit) → paste → **Commit changes**,
or use **Add file → Upload files** to replace it. The site updates within a minute or two.

## Backups

Admins: **Users → Download backup** saves everything (items, history, users) as one file. Do it regularly.
The free Supabase plan doesn't give you downloadable backups, so this button is your safety net.

## Limits of the free plans (as of late 2026)

- Supabase Free: 500 MB of data (well over a million scans), 2 projects, pauses after about a week idle
  (the keep-alive prevents that).
- GitHub Pages: free for public repositories. GitHub's terms say Pages isn't meant mainly for running
  a business; a small internal tool is generally fine.
