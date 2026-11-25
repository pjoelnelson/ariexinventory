# Barcode Inventory (self-hosted)

A free inventory system that runs on your own PC. Scan an item's barcode or QR code to **check it in**, scan it again t.
**check it out**. Every scan is saved with who did it and when, and the responsible party can sign in from a browser
to see stock levels and the full history.

- No monthly fees and no outside services. The database is one file on this PC (`data\inventory.db`).
- Works with any USB or Bluetooth barcode/QR scanner that acts as a keyboard (almost all do), **or a phone's camera**.
- Only needs Node.js (already installed). No other packages.

## Files

| File | What it is |
|---|---|
| `server.js` | The server and database (Node.js, built-in SQLite) |
| `public\` | The web pages (scan station, dashboard, items, history, labels, users) |
| `start.bat` | Double-click to start the server |
| `make-certificate.ps1` | Creates the https certificate phones need for the camera (already done; rerun if the PC's IP changes) |
| `certs\` | The https certificate. Keep it private. |
| `data\inventory.db` | Your data. Created on first start. **Back this up.** |

## 1. Start it

Double-click **`start.bat`**, or run:

```powershell
node server.js
```

Open **http://localhost:3000** on this PC. The first time, you'll be asked to create the **admin** account.

Keep the black server window open. Closing it stops the system.

## 2. Daily use

**Scan page (scanning station)**
1. Pick **CHECK IN** (items arriving) or **CHECK OUT** (items leaving). Shortcuts: **F2** = in, **F4** = out.
2. Scan. The scanner types the code and presses Enter, so it's recorded right away with a beep.
3. For several of the same item, type the number in the **Qty** box first, then scan once.
4. If you scan a **new barcode** while checking in, a form pops up to name the item. It's registered and checked in.
5. Checking out more than is in stock is blocked, so stock never goes negative.

**Labels page.** Items without a barcode get one automatically (`INV-000001`...). Tick the items, choose the number of
copies and print QR stickers. Tick "Include MODE-IN / MODE-OUT cards" to print two cards; scanning one switches
the station between check-in and check-out without touching the keyboard.

**Dashboard / History.** Today's movements, low-stock alerts (set "Low-stock alert at" on an item), and the full
history with search, date filters and **Export CSV** (opens in Excel).

**Items page.** Edit items. Admins can also do a **Count**, which sets stock after a physical count and records it in
history, and can delete items.

## 3. Users and roles

Go to **Users** (admin only) and create an account for each person:

| Role | Can do |
|---|---|
| **viewer** | See dashboard, items, history, CSV exports. Can't change anything. **Use this for the responsible party.** |
| **operator** | Also scan in/out, add/edit items, print labels. For staff at the scanner. |
| **admin** | Everything, including stock counts, deleting items, users and backups. |

## 4. Using it from other devices on the same network

The server window shows an address like `http://192.168.1.50:3000`. Other PCs, tablets or phones on the same Wi-Fi
can open it. If they can't connect, allow the port through Windows Firewall (run PowerShell **as administrator**):

```powershell
New-NetFirewallRule -DisplayName "Barcode Inventory" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

Tip: give this PC a fixed IP address in your router settings so the address doesn't change.

## 4b. Scanning with a phone camera

Phones only allow websites to use the camera over **https**, so the server also runs a secure address on port
**3443**. The server window lists it as `Phones (camera): https://10.0.0.241:3443`.

**One-time PC setup** (PowerShell **as administrator**):

1. Windows currently treats this PC's Wi-Fi as a **Public** network, which blocks phones. If it's your own
   business or home network, mark it as private: Settings → Network & internet → Wi-Fi → (your network) → Network
   profile type → **Private network**.
2. Allow the two ports through the firewall:
   ```powershell
   New-NetFirewallRule -DisplayName "Barcode Inventory" -Direction Inbound -Protocol TCP -LocalPort 3000,3443 -Action Allow -Profile Private
   ```

**On each phone** (connected to the same Wi-Fi):

1. Open `https://10.0.0.241:3443` in Chrome (Android) or Safari (iPhone).
2. The first time, the browser warns "Your connection is not private". That's expected for a private site
   on your own network. Tap **Advanced → Proceed** (Chrome) or **Show Details → visit this website** (Safari).
3. Sign in, go to **Scan**, pick **CHECK IN** or **CHECK OUT**, and tap **📷 Scan with camera**. Allow the camera.
4. Point at a barcode or QR code. It buzzes or beeps and records the scan. To scan the **same** item twice, move the
   camera away for a second first, or set **Qty** before scanning.

Tip: add it to the home screen (Share → Add to Home Screen) so staff can open it like an app.

If the PC's IP address changes, run `make-certificate.ps1` again and restart the server:

```powershell
powershell -ExecutionPolicy Bypass -File .\make-certificate.ps1
```

## 5. Letting the responsible party see it online (from anywhere)

Don't open a port on your router. That puts the PC directly on the internet. Use one of these free options instead.
Each gives a secure **https** address:

### Option A (recommended): Tailscale Funnel. Free, stable address, about 10 minutes
1. Install Tailscale and sign in (free personal plan):
   ```powershell
   winget install Tailscale.Tailscale
   ```
2. Publish the inventory site:
   ```powershell
   tailscale funnel --bg 3000
   ```
   The first time, it shows a link to turn Funnel on for your account. Open it, approve, and run the command again.
3. It prints an address like `https://your-pc.your-tailnet.ts.net`. Send it to the responsible party with their
   **viewer** login. The address stays the same after restarts.

*More private alternative:* skip Funnel. Invite the responsible party to your Tailscale network instead (they install
Tailscale too) and run `tailscale serve --bg 3000`. Then only invited people can even reach the page.

### Option B: Cloudflare Tunnel
- Quick test (address changes every time):
  ```powershell
  winget install Cloudflare.cloudflared
  ```
  ```powershell
  cloudflared tunnel --url http://localhost:3000
  ```
- Permanent address: needs your own domain name added to a free Cloudflare account (about $10/year for the domain).
  Follow Cloudflare's "Create a tunnel" guide and point it at `http://localhost:3000`.

Whatever you choose: give each person their own account, use strong passwords, and give the responsible party the
**viewer** role. After 10 wrong passwords, logins from that address are blocked for 15 minutes.

## 6. Keep it running

- **Start automatically when you log in.** Open Task Scheduler, choose *Create Basic Task*, set the trigger to
  *When I log on* and the action to *Start a program*, and pick `start.bat` from this folder.
- **Stop the PC from sleeping.** Settings → System → Power → Screen and sleep → set "Make my device sleep after" to
  **Never** (when plugged in). Otherwise the site goes offline when the PC sleeps.

## 7. Backups (important)

All data is in `data\inventory.db`. Admins can click **Users → Download backup** at any time. That copy is safe
to make while the system is running. Save backups somewhere other than this PC (USB drive, OneDrive, Google
Drive). To restore, stop the server, replace `data\inventory.db` with the backup file, and start it again.

## Settings

Optional environment variables: `PORT` (default `3000`), `DATA_DIR` (default `.\data`), `HOST` (default all network
interfaces). Example:

```powershell
$env:PORT = "8080"; node server.js
```

## Scanner tips

- The scanner must be in **keyboard (HID) mode** with an **Enter** (or Tab) suffix. That's the factory default
  on most models.
- If a scan shows wrong characters, set the scanner's keyboard language to match Windows (usually "US English").
- Keep the browser on the Scan page with nothing else focused. The scan box grabs focus automatically.
