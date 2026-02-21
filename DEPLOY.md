# Phase 3 Deploy Guide
## From zero to running proactive notifications in ~20 minutes

---

## Recommended hosting: Render (free tier)

Render is the right choice for this phase — it's free, deploys directly
from GitHub in a few clicks, and requires zero server administration.

The one limitation of the free tier is that instances spin down after
15 minutes of inactivity, which means a scheduled notification may arrive
30-60 seconds late if the server was asleep. For testing and building,
this is completely fine. See the "When you're ready to upgrade" section
at the bottom for options when you want always-on reliability.

---

## What you're deploying

A small Node.js server on Render's free tier that:
- Stores your tasks and goals server-side (accessible 24/7)
- Runs Claude on a schedule without you doing anything
- Sends you email notifications when Claude decides you need them
- Proxies all Claude API calls so your API key never touches the browser

---

## Step 1 — Set up Gmail for sending notifications

You need a Gmail "App Password" — separate from your real password,
can be revoked any time, takes 2 minutes to create.

1. Go to myaccount.google.com/security
2. Enable 2-Step Verification if not already on
3. Go to myaccount.google.com/apppasswords
4. Create a new app password — name it "Claude Assistant"
5. Copy the 16-character password — you'll need it in Step 3

---

## Step 2 — Push your code to GitHub

Render deploys from GitHub. You need a free account at github.com.

```bash
# In the assistant-phase3 folder:
git init
git add .
git commit -m "Phase 3 Claude assistant"

# Create a new repo on github.com (click "New repository"), then:
git remote add origin https://github.com/YOUR_USERNAME/claude-assistant.git
git push -u origin main
```

---

## Step 3 — Deploy to Render

1. Go to render.com and sign up for a free account
2. Click "New +" → "Web Service"
3. Connect your GitHub account and select your repo
4. Configure the service:
   - **Name:** claude-assistant (or anything you like)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free

5. Click "Advanced" → "Add Environment Variable" and add ALL of these:

| Key | Value |
|-----|-------|
| ANTHROPIC_API_KEY | sk-ant-your-key-here |
| API_SECRET | make up a long random string — 32+ characters |
| GMAIL_USER | your@gmail.com |
| GMAIL_APP_PASSWORD | the 16-char app password from Step 1 |
| NOTIFY_EMAIL | where to send notifications (can be same as above) |
| TZ | America/New_York (or your timezone) |
| MORNING_BRIEFING_CRON | 0 8 * * * |
| DUE_CHECK_CRON | 0 9-17 * * * |
| FOCUS_REMINDER_CRON | 30 9-17/1 * * * |

6. Click "Create Web Service"
7. Wait 2-3 minutes for the first deploy to finish
8. Copy your server URL — it looks like: https://claude-assistant-xxxx.onrender.com

---

## Step 4 — Keep the server awake (free workaround)

Render's free tier spins down after 15 minutes of inactivity. To prevent
late notifications, use cron-job.org (free) to ping your server every
10 minutes — this keeps it awake at no cost.

1. Go to cron-job.org and create a free account
2. Click "Create cronjob"
3. Set the URL to: https://your-server.onrender.com/health
4. Set schedule to: every 10 minutes
5. Save — that's it

Your server will now stay awake and notifications will fire on time.

---

## Step 5 — Connect your browser app

1. Open the Phase 3 `public/index.html` file in your browser
2. In the setup modal, enter:
   - **Server URL:** your Render URL from Step 3 (no trailing slash)
   - **API Secret:** the same API_SECRET you set in Render
3. Click "Connect & Sync"

You should see "Synced" in the top bar. Your tasks now live on the server.

---

## Step 6 — Test it

1. Add a few tasks in the app
2. Click "Send Morning Briefing Now" in the right sidebar
3. Check your email — you should receive a briefing within 30 seconds
4. The "Notifications Sent" log in the sidebar will update

If the first attempt is slow (60+ seconds), that's the server waking up.
After cron-job.org is running it stays warm and responds immediately.

---

## Customizing your notification schedule

Edit the cron values in Render's environment variables any time.
Render automatically redeploys when you save environment changes.

Cron format: `minute hour day month weekday`
- `0 8 * * *`       = 8:00am every day
- `0 8 * * 1-5`     = 8:00am weekdays only
- `0 7,12,17 * * *` = 7am, noon, and 5pm daily
- `*/30 9-17 * * *` = every 30 minutes during work hours

---

## Troubleshooting

**"Could not connect" in setup modal:**
- Make sure the Render URL has no trailing slash
- Verify your API_SECRET matches exactly (copy-paste, don't retype)
- Visit your-server.onrender.com/health directly — if it loads, the server is up

**Not receiving emails:**
- Double-check your Gmail App Password (not your regular Gmail password)
- Check Render's logs: Dashboard → your service → Logs tab
- Confirm NOTIFY_EMAIL is set in environment variables

**Notifications arriving late or not at all:**
- Set up cron-job.org as described in Step 4 to keep server warm
- Check Render logs for "[JOB]" entries to confirm jobs are running

---

## When you're ready to upgrade

Once this becomes a tool you rely on daily, the free-tier spin-down
will start to feel annoying even with cron-job.org. At that point,
your upgrade options from cheapest to most control:

| Option | Cost | Notes |
|--------|------|-------|
| Render Starter | $7/month | Easiest — just change instance type in dashboard |
| Railway | ~$5/month | Similar to Render, slightly different pricing model |
| Hetzner or DigitalOcean VPS | $4-6/month | Full server control, most flexibility |

There's no rush — build through the remaining phases on the free tier
first, then upgrade once you know you're going to use this daily.

---

## What's next — Phase 4 (Scheduling & Calendar Integration)

With the server running, Phase 4 will connect to Google Calendar via OAuth,
letting Claude see your schedule and give context-aware suggestions like
"you have 3 meetings tomorrow — here are the things worth prepping."
