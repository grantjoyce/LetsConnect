# RECOVERY.md: Let's Connect

How to get Let's Connect back after a bad day: the live server is gone, the laptop is gone, GitHub locks you out, a deploy breaks the site, or you can't sign in to the admin. Each scenario is a list of numbered steps. For routine deploy details see `CLAUDE.md` section 4.

This file is committed to GitHub: it says where secrets live, never what they are.

Last checked: 9 October 2026 (app v1.25.0).

---

## Where everything lives

| Piece | Lives on | Backed up to |
|---|---|---|
| **Code** | GitHub `grantjoyce/LetsConnect` (private) and this folder | OneDrive sync, the nightly encrypted laptop backup, and the Plesk server's own Git copy |
| **Live database** (real couples, codes, buyer emails and phone numbers, owner accounts, every question, every setting). Name: see the checklist | NOIZ Plesk server, subscription launchyourlife.co.za | **No Plesk backup schedule.** Only NOIZ's own server backups: a restore means asking NOIZ support. Grant decided to keep it this way. By hand: **Admin → Import → Export everything to Excel** (questions only), or Plesk **Databases** → **Export Dump** (everything) |
| **Live uploads** | None. The logo, favicon and watermark images are stored in the database | Travel with the database |
| **Live secrets**: the server `.env` (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `SESSION_SECRET`, `SECRET_KEY`, `NODE_ENV`) and any Node.js custom environment variables | NOIZ server only, in `/connect.launchyourlife.co.za` | Your password manager. Check this is done |
| **SMTP password, Anthropic API key, shop key** | The `settings` table in the live database. The first two are encrypted under `SECRET_KEY` | Travel with the database. The shop key also sits wherever the launchyourlife.co.za shop is set up to call this app |
| **Owner login** for `/admin/` | The `users` table in the live database | Your password manager. Check this is done |
| **Plesk settings** | NOIZ server | Written down in Scenario A below |
| **Dev database** `lets_connect` (test data only) | Laptop MariaDB 11.4 | Nightly encrypted laptop backup (`OneDrive\Backups\claudecode-restic`). Not production data |
| **Dev `.env`** and `.claude/launch.json` | Laptop | OneDrive sync and the nightly laptop backup |
| **Laptop push key** `~/.ssh/letsconnect_deploy` | Laptop | Not backed up (only `~\.ssh\config` is). Make a new one if lost |
| **What Claude knows** | `CLAUDE.md` (in git) and per-user memory (8 notes) | GitHub, and the private `dotclaude` repo |

---

## Scenario A: the live server is gone or broken

### Option 1: ask NOIZ to restore (try this first)

There is no Plesk backup for this subscription, so the restore has to come from NOIZ.

1. Log in to the noiz.co.za client area and open a support ticket.
2. Ask them to restore, from their newest server backup:
   - the `connect.launchyourlife.co.za` folder, and
   - the Let's Connect database (name from the checklist below).
   The main WordPress site is in the same subscription. Say whether it needs restoring too.
3. Ask which date the backup is from, so you know what was lost.
4. When NOIZ says it's done, log in to Plesk (noiz.co.za client area → **Manage** → **Log in to Plesk**).
5. Go to **Websites & Domains** → **connect.launchyourlife.co.za** → **Node.js**. Check the settings match the table in Option 2 step 7, then click **Restart App**.
6. Check:
   - Open https://connect.launchyourlife.co.za/api/health. It shows `"ok":true` and the version.
   - Sign in at https://connect.launchyourlife.co.za/admin/ and open **Codes** and **Questions**.
   - On a phone, open the app and type a code from **Codes**.

### Option 2: rebuild by hand

Use this if NOIZ cannot restore it.

1. **Site:** in Plesk, under launchyourlife.co.za, add the subdomain `connect.launchyourlife.co.za` with its **own folder** `/connect.launchyourlife.co.za`. Never `httpdocs`: WordPress lives there and swallows every `/api` request. Issue a Let's Encrypt certificate (**SSL/TLS Certificates**) and force HTTPS.
2. **Database:** **Databases** → **Add Database**, with a user and a new password. Use the same name as before if you can (see the checklist).
   - If you have a dump (from NOIZ, or an **Export Dump** you made), use **Import Dump**.
   - If you have none, leave it empty.
3. **Code:** **Git** → add the repository with the SSH address `git@github.com:grantjoyce/LetsConnect.git`.
   - Set the **Server path** to `/connect.launchyourlife.co.za`. Plesk suggests `/httpdocs/public`, which is wrong.
   - Copy the public key Plesk shows. On GitHub, open the repo's **Settings → Deploy keys**, add it (read-only), and name it "Plesk".
   - Click **Pull Updates**.
4. **Clean the folder:** in **Files**, open `/connect.launchyourlife.co.za`. Delete Plesk's placeholder `index.html`. Make sure there is **no `.htaccess`** in that folder.
5. **Secrets:** in the same folder, create `.env` from your password manager.
   - It holds `DB_HOST=localhost`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (the new one from step 2), `SESSION_SECRET`, `SECRET_KEY` and `NODE_ENV=production`, and **no `PORT` line**.
   - Use the **same `SECRET_KEY`** as before. With a new one, the saved email password and Anthropic key can't be read back, and you retype them in **Admin → Email** and **Admin → Develop**.
6. **Hosting Settings:** set **Document root** to `connect.launchyourlife.co.za/public`.
7. **Node.js settings** (do this last, once the files are in place):

   | Setting | Value |
   |---|---|
   | Node.js version | the one written in the checklist below |
   | Application Root | `/connect.launchyourlife.co.za` |
   | **Document Root** | **`connect.launchyourlife.co.za/public`** (the repo root gives a 403) |
   | Application Startup File | `server.js` |
   | Application Mode | production |

   Then click **Enable Node.js**, then **NPM install**.
8. **Database tables:** **Run script** → type `run init-db`, then **Run script** → `run migrate`. If Plesk answers "Unknown command", type `init-db` and `migrate` instead. Both are safe on any dump age. On an empty database, `migrate` also loads the starter questions.
9. Click **Restart App**. If the server's IP address changed, update DNS for connect.launchyourlife.co.za.
10. **Only if you started from an empty database:**
    1. Open https://connect.launchyourlife.co.za/admin/. It shows a setup screen. Create your owner account.
    2. **Admin → Import**: upload your newest Excel export. It shows a dry run first; confirm.
    3. **Admin → Email**: re-enter the SMTP details. **Admin → Develop**: re-enter the Anthropic key.
    4. **Admin → Settings**: re-upload the logo, favicon and watermark, and create a new shop key if the shop uses one. Give the new key to the shop.
11. Check as in Option 1 step 6.

What you lose: with a NOIZ restore, anything since their last backup. From an empty database: every couple's code and progress, the owner accounts and all settings. The questions come back only as far as your newest Excel export.

---

## Scenario B: this laptop is gone

The live site is not affected. First, from your phone:

1. Change your passwords and sign out of all sessions.
2. On GitHub, open `grantjoyce/LetsConnect` → **Settings → Deploy keys** and delete the laptop's key (it has write access). **Keep the Plesk key**, or deploys stop.

Then on the new laptop:

1. Install Git, Node 24, MariaDB 11.4 and Claude Code.
2. Get the code back: let OneDrive sync this folder, or `git clone https://github.com/grantjoyce/LetsConnect.git` and sign in to GitHub when asked.
3. To push again: make a new SSH key, add it under the repo's **Settings → Deploy keys** with **Allow write access**, and point the `github-letsconnect` entry in `~\.ssh\config` at it. Ask Claude to do this part. The `~\.ssh\config` file itself is in the nightly backup.
4. Run `npm install` in the folder.
5. `.env`: OneDrive brings it back, or restore it from the nightly backup (`ClaudeCode\nightly-backup\README.md`):
   `restic -r <OneDrive>\Backups\claudecode-restic restore latest --target C:\Restore --include "*/Lets Connect/.env"`
6. Dev database, either way:
   - Import last night's dump: restore `*/staging/databases/lets_connect.sql` the same way, then `mariadb -u root -p < lets_connect.sql`.
   - Or start clean: `npm run init-db`, then `npm run migrate`, then create a new owner account at http://localhost:3200/admin/.
7. Claude's memory: run `restore.ps1` in `ClaudeCode\dotclaude`. `CLAUDE.md` comes back with the code.
8. Run `npm start` (or the `lets-connect` preview) and open http://localhost:3200.

---

## Scenario C: GitHub locks you out

The live site keeps running, and Plesk keeps its last pulled code.

1. The code is still on the laptop, in OneDrive and in the nightly backups.
2. Create a new private repository (on GitHub under a new account, or GitLab).
3. In this folder: `git remote set-url origin <new address>`, then `git push --all`. The laptop needs a new key for the new host (Scenario B step 3).
4. In Plesk **Git**, change the repository address and add Plesk's new deploy key to the new repository. Check the **Server path** is still `/connect.launchyourlife.co.za`.

---

## Scenario D: a deploy broke the live site

1. Check the usual causes first:
   - **A bare 403:** the Document Root reset. Fix it in **Hosting Settings**, then **Node.js** → **Disable** → **Enable**.
   - **Pages load but nothing works, or errors about missing columns:** `run migrate` was skipped. Run it, then **Restart App**.
   - **Every `/api` request fails with 404 or 500:** look for a stray `.htaccess` in `/connect.launchyourlife.co.za`, and check the Git **Server path** has not moved to `httpdocs`.
   - **Someone started the app from Run script:** **Run script** → `run kill-stray`, then **Restart App**.
   - **The footer shows "server vY":** press Ctrl+F5. If it stays, **Restart App** was skipped.
2. Still broken: roll back the code. There are no restore-point tags yet, so ask Claude to `git revert` the bad commit (never a force-push), bump the version and push. Then **Pull Updates** and **Restart App**.
3. A bad migration is not undone by reverting code. Restore the database from your own **Export Dump** if you made one, otherwise ask NOIZ (Scenario A Option 1).

---

## Scenario E: locked out of the admin

Couples are never locked out for long: they type their code again. If they lost it, find it in **Admin → Codes** and resend it by email or WhatsApp.

An owner who forgets the `/admin/` password has **no working way back in today**:
- The admin sign-in has no "Forgot password" link.
- Reset links (from **Admin → People → Reset link**, or by email) point at an address neither app reads any more.
- There is no `reset-password` script like the CRM's.

So:
1. Keep the owner password in your password manager.
2. If you are locked out, ask Claude to add a `reset-password` script (as in the CRM), push it, and deploy it as in `CLAUDE.md` section 4.
3. Then **Node.js** → **Run script** → `run reset-password`, and sign in with the temporary password it prints.

---

## Check these before you need them

- [ ] The live `.env` and any Node.js custom environment variables are saved in your password manager. `SECRET_KEY` matters most.
- [ ] The `/admin/` owner login is saved in your password manager.
- [ ] Write the live database name and user here: Plesk → **Databases** (the same as `DB_NAME` and `DB_USER` in the live `.env`). Name: ________ User: ________
- [ ] Write the live Node.js version here: Plesk → connect.launchyourlife.co.za → **Node.js**. Version: ________
- [ ] Plesk shows Git **Server path** `/connect.launchyourlife.co.za`, **Document root** `connect.launchyourlife.co.za/public`, Application Root `/connect.launchyourlife.co.za`, Startup File `server.js`, mode production.
- [ ] Ask NOIZ support how often they back up the server, how long they keep backups, and whether they can restore one database on its own. Write the answer here: ________
- [ ] Monthly, and before any risky deploy: **Admin → Import → Export everything to Excel**, and save the file in OneDrive. It is the only copy of the questions outside the server.
- [ ] Ask Claude to fix the owner password reset (Scenario E) before you need it.
- [ ] GitHub → `grantjoyce/LetsConnect` → **Settings → Deploy keys**: give each key a clear name so you can tell the laptop's from Plesk's. The laptop has two keys made for this project (`letsconnect_deploy`, which the repo uses, and `connect_launchyourlife_deploy`). Remove any key GitHub lists that is not in use.
- [ ] The first deploy (16 August 2026) went into `/httpdocs`. Check that folder holds no leftover Let's Connect files, especially a `.env`. Ask Claude before deleting anything there, because WordPress lives in it.
- [ ] If the launchyourlife.co.za shop mints codes, note where its copy of the shop key is kept.
- [ ] Once: Plesk **Databases** → **Export Dump**, import it into a spare local database, and open the app against it. That's the only proof a dump restores.
