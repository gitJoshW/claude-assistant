# My Personal Assistant — Claude Code Context

This is a proactive personal assistant web app built with Node.js + Express + PostgreSQL,
deployed on Railway, with a vanilla JS single-page frontend. It is a personal tool —
not a commercial product. Current users: 1 (expanding to 2 family members in a future phase).

---

## Project Structure

```
assistant-phase3/
├── src/
│   └── server.js          # Express backend — all API endpoints, schedulers, email
├── public/
│   ├── index.html         # Single-page frontend — all UI and JS in one file
│   ├── styles.css         # Extracted stylesheet (was inline, moved out for maintainability)
│   ├── sw.js              # Service worker for PWA — bump cache version on deploy
│   ├── manifest.json      # PWA manifest
│   └── favicon.svg        # Green rounded square with ✦ spark
├── package.json
├── .env                   # Local dev only — never commit
└── CLAUDE.md              # This file
```

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL (Railway managed) — single `store` table, key/value JSON storage
- **Frontend:** Vanilla JS SPA — no framework, no build step
- **Email:** Resend SDK (not nodemailer — Railway blocks SMTP ports)
- **Push notifications:** ntfy.sh — planned for Phase 4, not yet implemented
- **Scheduling:** node-cron — 4 scheduled jobs
- **Auth:** Simple shared secret via `x-api-secret` header, checked on every API request
- **Deployment:** Railway — auto-deploys from GitHub on push
- **PWA:** Installable on mobile/desktop via manifest.json + sw.js

---

## Environment Variables

All set in Railway dashboard. Never hardcoded.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Auto-injected by Railway PostgreSQL plugin |
| `ANTHROPIC_API_KEY` | Claude API — used for briefings, suggestions, task help |
| `API_PIN` | Auth secret — sent as `x-api-secret` header from frontend |
| `RESEND_API_KEY` | Email sending via Resend SDK |
| `NOTIFY_EMAIL` | Where notification emails are sent |
| `TZ` | Timezone — set to `America/New_York` |
| `MORNING_BRIEFING_CRON` | Optional override, default `0 8 * * *` |
| `DUE_CHECK_CRON` | Optional override, default `0 9-17 * * *` |
| `FOCUS_REMINDER_CRON` | Optional override, default `30 9-17/1 * * *` |
| `WEEKLY_SUGGESTIONS_CRON` | Optional override, default `0 8 * * 1` |

`API_SECRET` is accepted as an alias for `API_PIN` — both work.

---

## Database Design

Single table `store` with columns `(key TEXT PRIMARY KEY, value JSONB)`.
Everything is stored as a JSON blob under a string key.

| Key | Value type | Description |
|---|---|---|
| `tasks` | Task[] | All tasks |
| `goals` | Goal[] | All goals |
| `projects` | Project[] | All projects |
| `notes` | Note[] | Captured notes (last 500) |
| `completion_log` | LogEntry[] | Task completion history (last 500) |
| `notification_log` | Notification[] | Sent notifications (last 50) |
| `memory` | string | Free-text "About Me" context injected into Claude prompts |
| `paused` | boolean | Whether scheduled notifications are paused |

Helper functions `dbGet(key)` and `dbSet(key, value)` handle all DB access.

---

## Task Object Shape

```js
{
  id: number,              // integer, from newId()
  title: string,
  priority: 'high' | 'medium' | 'low',
  category: string,
  customer: string,
  done: boolean,
  dueDate: string,         // 'YYYY-MM-DD' or null
  recurrence: string,      // e.g. 'weekly', 'monthly', or null
  projectId: number | null,
  projectName: string,
  reason: string,          // description/notes field
  snoozedUntil: string,    // 'YYYY-MM-DD' or null
  completedAt: string,     // ISO timestamp or null
  createdAt: string,       // ISO timestamp
}
```

---

## API Endpoints

All endpoints require `x-api-secret` header matching `API_PIN` env var.

### Data CRUD
| Method | Path | Description |
|---|---|---|
| GET | `/api/tasks` | Get all tasks |
| POST | `/api/tasks` | Save all tasks (full replace) |
| GET | `/api/goals` | Get all goals |
| POST | `/api/goals` | Save all goals |
| GET | `/api/projects` | Get all projects |
| POST | `/api/projects` | Save all projects |
| GET | `/api/notes` | Get all notes |
| POST | `/api/notes` | Save all notes |
| GET | `/api/completion-log` | Get completion log |
| POST | `/api/completion-log` | Save completion log |
| GET | `/api/memory` | Get memory string |
| POST | `/api/memory` | Save memory string |
| GET | `/api/notifications` | Get notification log (last 20) |
| POST | `/api/notifications/save` | Save/overwrite notification log |

### AI & Actions
| Method | Path | Description |
|---|---|---|
| POST | `/api/claude` | Single-turn Claude call |
| POST | `/api/claude-convo` | Multi-turn conversation (accepts messages array) |
| POST | `/api/ask` | Ask Claude with full task/goal/completion context injected |
| POST | `/api/notes/parse` | Parse freeform note text → structured JSON |
| POST | `/api/trigger/:job` | Manual trigger — only `morning` supported |
| GET | `/api/pause` | Get paused state |
| POST | `/api/pause` | Set paused state `{ paused: boolean }` |
| GET | `/api/health` | Health check |

---

## Scheduled Jobs

All jobs check the `paused` flag and skip if true.

| Job | Default schedule | What it does |
|---|---|---|
| Morning briefing | 8am daily | Sends HTML email + logs to inbox |
| Due/overdue check | 9am–5pm hourly | Checks for overdue/due-soon tasks, emails if found |
| Focus reminder | Every 90min 9am–5pm | Picks 1-3 priority tasks, sends focused reminder |
| Weekly suggestions | Monday 8am | Reviews completion history, suggests improvements |

---

## Frontend Architecture

`public/index.html` is a ~1,700 line single-file SPA. Key globals:

```js
let tasks = [], goals = [], projects = [], notes = [];
let notifLog = [], completionLog = [];
let activeFilter = 'open';   // default filter — done tasks hidden by default
let activeTab = 'tasks';
let notesFilter = 'all';
let serverUrl = '';          // stored in localStorage as 'p3_url'
let secret = '';             // stored in localStorage as 'p3_sec'
```

### Key Frontend Functions
- `syncNow()` — fetches all data from server, calls `renderAll()`
- `renderTasks()` — main task list render, respects `activeFilter`
- `renderNotes()` — notes list with search + filter
- `taskCard(t)` — returns HTML string for a full task card
- `taskRow(t)` — returns HTML string for condensed view row
- `setFilter(f)` — updates `activeFilter`, re-renders
- `switchTab(tab)` — shows/hides tab views
- `mobileTab(tab)` — mobile nav version of switchTab
- `exportData()` — downloads full JSON backup
- `importData(input)` — restores from JSON backup file
- `parseNote()` — sends note text to `/api/notes/parse`, shows results
- `autoResizeTextarea(el)` — auto-expands textareas as user types
- `togglePause()` / `setPause(bool)` — pause/resume notifications

### Auth Flow
1. On load, reads `p3_url` and `p3_sec` from localStorage
2. If either missing, shows setup modal
3. All `apiFetch()` calls include `x-api-secret: secret` header

### PWA / Service Worker
- Cache version is `assistant-v5` in `sw.js`
- **Always bump the cache version string when deploying CSS/JS changes**
  otherwise users get stale cached files

---

## Email — Resend

Using Resend SDK (not nodemailer). SMTP is blocked on Railway.

```js
from: 'My Personal Assistant <assistant@updates.bettercustomerexperiences.com>'
to: process.env.NOTIFY_EMAIL
```

Domain `updates.bettercustomerexperiences.com` is verified in Resend dashboard.

---

## Deployment

```bash
# Standard deploy
git add .
git commit -m "description"
git push
# Railway auto-deploys on push to main
```

**After any CSS or JS change:** bump cache version in `public/sw.js`:
```js
const CACHE = 'assistant-v6'; // increment this
```

---

## Completed Feature History

- ✅ Tasks — CRUD, priorities, categories, customers, projects, due dates
- ✅ Recurring tasks with completion log
- ✅ Task snooze (1d / 3d / 1w / 1mo) with 💤 Snoozed filter
- ✅ Inline editing of all task fields
- ✅ Condensed view mode with expand-on-click
- ✅ Goals with progress tracking
- ✅ Projects with task grouping and progress bar
- ✅ Notes tab — freeform capture, Claude parses into tasks/logs/ideas
- ✅ Notes search + filter (All / Has tasks / Has ideas / Raw)
- ✅ Inbox tab — notification log with delete
- ✅ Morning briefing (scheduled + manual trigger)
- ✅ Due/overdue check notifications
- ✅ Focus reminders
- ✅ Weekly suggestions
- ✅ Notification pause/resume
- ✅ "About Me" memory injected into all Claude prompts
- ✅ Ask Claude panel with full task/goal context
- ✅ Multi-turn "Help me" conversations per task
- ✅ PWA — installable, service worker caching
- ✅ PIN authentication
- ✅ Mobile-responsive with bottom nav, slide-up drawers
- ✅ Mobile filter drawer
- ✅ Export/import JSON backup
- ✅ Delete confirmations on all destructive actions
- ✅ Default filter shows Open tasks only (done tasks hidden)
- ✅ Favicon + renamed to "My Personal Assistant"
- ✅ Migrated from Render to Railway
- ✅ Migrated email from nodemailer/Gmail SMTP to Resend SDK

---

## Planned — Phase 4

- [ ] ntfy.sh push notifications (Railway-compatible, works over HTTPS)
- [ ] Persist "Help me" task conversations to DB (currently reset on reload)
- [ ] Smarter morning briefings using completion history patterns
- [ ] Second user support (family member)

## Planned — Phase 5 (Intelligence)

- [ ] Pattern detection — Claude notices when tasks stall, customers go quiet, etc.
- [ ] Completion history analytics driving weekly suggestions
- [ ] Proactive nudges based on user behaviour patterns

## Planned — Phase 6 (Capture)

- [ ] Mobile share sheet integration
- [ ] Email-to-task forwarding

---

## Known Quirks / Watch Out For

- **Full replace on save** — all POST endpoints replace the entire array. There is no
  partial update. Always send the complete current array when saving.
- **IDs are integers** — generated by `newId()` which uses `Date.now()`. Don't use
  floats or UUIDs — existing data has integer IDs.
- **`parseJSON()` helper** — Claude API responses sometimes wrap JSON in markdown
  fences. Use `parseJSON(raw)` in server.js instead of `JSON.parse(raw)` directly.
- **Paused flag** — all 4 schedulers check `await dbGet('paused')` before running.
  If notifications stop working, check this flag first.
- **notes filter resets** — `notesFilter` resets to `'all'` on every `syncNow()` call
  to prevent stale filter state across sessions.
