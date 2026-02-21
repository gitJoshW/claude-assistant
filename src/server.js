// ════════════════════════════════════════════════════════════
//  PHASE 3 — Proactive Claude Assistant Backend
//
//  WHAT'S NEW vs Phase 2:
//  1. A real server (Express) that runs 24/7 on Render
//  2. node-cron schedules tasks that run without user action
//  3. Claude reviews your data on a schedule and decides
//     whether to send a notification — that's the agentic part
//  4. Email delivery so notifications reach you on any device
//  5. Task storage moves from localStorage to the server
//     so data is accessible from anywhere
//
//  LEARNING NOTE — What "agentic" means here:
//  In Phase 1-2, Claude only acted when YOU sent a message.
//  In Phase 3, Claude acts on its own schedule. The scheduler
//  wakes up, gives Claude your task list, and Claude DECIDES
//  whether something is worth notifying you about. That
//  decision-making loop running independently is what makes
//  this agentic behavior.
// ════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── IN-MEMORY STORE ───────────────────────────────────────
/*
  LEARNING NOTE — Server-side storage

  In Phase 2, tasks lived in localStorage (browser only).
  Now they live on the server so:
  1. The scheduler can access them without a browser open
  2. Any device can read/write the same data

  This is still in-memory (lost on server restart) to keep
  Phase 3 simple. In Phase 5 you'd swap this for a real
  database like PostgreSQL or MongoDB.
*/
let store = {
  tasks:  [],
  goals:  [],
  memory: '',
  notificationLog: []   // tracks what was sent to avoid spam
};

// ── AUTH MIDDLEWARE ───────────────────────────────────────
/*
  LEARNING NOTE — Simple API authentication

  Since this server is public on the internet, we protect
  all write endpoints with a shared secret. The browser app
  sends this secret in every request header.

  In a real multi-user app you'd use JWT tokens or sessions.
  For a personal single-user app, a shared secret is fine.
*/
function requireAuth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!secret || secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── CLAUDE API CALL ───────────────────────────────────────
/*
  LEARNING NOTE — Server-side Claude calls

  In Phase 2, Claude was called directly from the browser.
  Now ALL Claude calls go through this server. This means:
  - Your API key is never exposed to the browser
  - The scheduler can call Claude on any schedule
  - You can add rate limiting, logging, and caching here

  This is the production pattern for Claude-powered apps.
*/
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  const fullSystem = store.memory
    ? `${systemPrompt}\n\nAbout the user:\n${store.memory}`
    : systemPrompt;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: fullSystem,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Claude API error');
  }

  const data = await response.json();
  return data.content[0].text;
}

// ── EMAIL ─────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

async function sendEmail(subject, htmlBody) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('[EMAIL SKIPPED - not configured]\n', subject, '\n', htmlBody);
    return;
  }

  await transporter.sendMail({
    from: `"My Assistant" <${process.env.GMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject,
    html: htmlBody
  });

  console.log(`[EMAIL SENT] ${subject}`);

  // Log it so we don't spam
  store.notificationLog.push({
    type: subject,
    sentAt: new Date().toISOString()
  });
}

// Format notification emails with a clean HTML template
function emailTemplate(title, body, color = '#2d5016') {
  return `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
      <div style="background:${color};color:white;padding:16px 20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:16px;font-weight:500;letter-spacing:0.02em">${title}</h2>
      </div>
      <div style="background:#ffffff;border:1px solid #e8e2d8;border-top:none;padding:20px;border-radius:0 0 8px 8px;line-height:1.65;font-size:14px;color:#1a1a14">
        ${body}
      </div>
      <p style="font-size:11px;color:#9a9a84;margin-top:12px;text-align:center">
        Sent by your Claude Assistant · <a href="#" style="color:#4a7c28">Manage notifications</a>
      </p>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  SCHEDULED JOBS — The heart of Phase 3
//
//  LEARNING NOTE — node-cron
//  node-cron runs functions on a schedule using cron syntax.
//  Each job calls Claude with the current task/goal state,
//  and Claude decides what (if anything) to say.
//
//  This is the key agentic pattern:
//  schedule → gather context → call Claude → Claude decides → act
// ══════════════════════════════════════════════════════════

// ── JOB 1: MORNING BRIEFING ───────────────────────────────
/*
  Every morning, Claude reviews all open tasks + goals and
  writes a personalized briefing: what to focus on today,
  what's coming up, any nudges about long-term goals.
*/
function scheduleMorningBriefing() {
  const schedule = process.env.MORNING_BRIEFING_CRON || '0 8 * * *';
  console.log(`[SCHEDULER] Morning briefing: ${schedule}`);

  cron.schedule(schedule, async () => {
    console.log('[JOB] Running morning briefing...');
    try {
      const openTasks = store.tasks.filter(t => !t.done);
      const openGoals = store.goals.filter(g => !g.achieved);

      if (openTasks.length === 0 && openGoals.length === 0) {
        console.log('[JOB] No tasks or goals — skipping morning briefing');
        return;
      }

      const today = new Date();
      const taskContext = openTasks.map(t =>
        `- [${t.priority.toUpperCase()}] ${t.title} (${t.category})${t.dueDate ? `, due ${t.dueDate}` : ''}`
      ).join('\n') || 'None';

      const goalContext = openGoals.map(g => {
        const pct = g.target ? ` (${Math.round((g.saved/g.target)*100)}% funded)` : '';
        return `- ${g.title}${pct}`;
      }).join('\n') || 'None';

      const systemPrompt = `You are a proactive personal assistant writing a morning briefing email.
Be warm, direct, and practical. Format your response as HTML paragraphs (use <p>, <strong>, <ul>, <li> tags).
Keep it concise — under 200 words. Focus on what matters most today.
Today is ${today.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}.`;

      const userMessage = `Write a morning briefing based on these open tasks and goals.
Highlight what's most urgent, any due dates coming up, and one brief mention of long-term goals if relevant.

Open tasks:
${taskContext}

Long-term goals:
${goalContext}`;

      const briefing = await callClaude(systemPrompt, userMessage, 512);

      await sendEmail(
        `☀️ Morning Briefing — ${today.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' })}`,
        emailTemplate('Your Morning Briefing', briefing)
      );
    } catch (err) {
      console.error('[JOB ERROR] Morning briefing:', err.message);
    }
  }, { timezone: process.env.TZ || 'America/New_York' });
}

// ── JOB 2: DUE / OVERDUE CHECK ────────────────────────────
/*
  LEARNING NOTE — Claude as a decision-maker

  This job is more interesting than the briefing because Claude
  isn't just summarizing — it's DECIDING whether to notify you.
  We ask Claude to return JSON: { shouldNotify: bool, message: string }
  Claude evaluates urgency and only sends an email if it judges
  the situation warrants interrupting you.

  This is the core of agentic behavior: Claude acting on judgment,
  not just executing instructions.
*/
function scheduleDueCheck() {
  const schedule = process.env.DUE_CHECK_CRON || '0 9-17 * * *';
  console.log(`[SCHEDULER] Due check: ${schedule}`);

  cron.schedule(schedule, async () => {
    console.log('[JOB] Running due/overdue check...');
    try {
      const today = new Date(); today.setHours(0,0,0,0);
      const threeDays = new Date(today); threeDays.setDate(today.getDate() + 3);

      const urgentTasks = store.tasks.filter(t => {
        if (t.done || !t.dueDate) return false;
        const due = new Date(t.dueDate + 'T00:00:00');
        return due <= threeDays;
      });

      if (urgentTasks.length === 0) {
        console.log('[JOB] No urgent tasks — skipping due check');
        return;
      }

      // Check if we already sent a due-check recently (within 4 hours)
      const recentlySent = store.notificationLog.some(n => {
        if (!n.type.includes('Due')) return false;
        const sentAt = new Date(n.sentAt);
        return (Date.now() - sentAt) < 4 * 60 * 60 * 1000;
      });
      if (recentlySent) {
        console.log('[JOB] Due check notification sent recently — skipping');
        return;
      }

      const taskList = urgentTasks.map(t => {
        const due = new Date(t.dueDate + 'T00:00:00');
        const diff = Math.round((due - today) / (1000*60*60*24));
        const label = diff < 0 ? `OVERDUE by ${Math.abs(diff)} day(s)` : diff === 0 ? 'DUE TODAY' : `due in ${diff} day(s)`;
        return `- [${t.priority.toUpperCase()}] ${t.title} — ${label}`;
      }).join('\n');

      // Claude decides whether this is worth an interruption
      const systemPrompt = `You are a personal assistant deciding whether to send an urgent notification.
Return ONLY valid JSON — no explanation, no markdown, no backticks.
Format: {"shouldNotify": boolean, "subject": "string", "message": "string (HTML)"}
The message field should use <p>, <strong>, <ul>, <li> HTML tags. Keep it under 100 words.`;

      const userMessage = `These tasks are due soon or overdue:
${taskList}

Should I interrupt the user with a notification right now? 
Consider: Are any truly urgent? Is this actionable information?
If yes, write a concise, helpful alert message. If not critical, return shouldNotify: false.`;

      const raw = await callClaude(systemPrompt, userMessage, 256);
      const decision = JSON.parse(raw);

      console.log(`[JOB] Claude decision — shouldNotify: ${decision.shouldNotify}`);

      if (decision.shouldNotify) {
        await sendEmail(
          `⚠️ ${decision.subject || 'Tasks Need Attention'}`,
          emailTemplate('Tasks Due Soon', decision.message, '#c0392b')
        );
      }
    } catch (err) {
      console.error('[JOB ERROR] Due check:', err.message);
    }
  }, { timezone: process.env.TZ || 'America/New_York' });
}

// ── JOB 3: FOCUS / DISTRACTION REMINDER ──────────────────
/*
  Claude looks at your open tasks, the time of day, and decides
  whether to send a gentle focus nudge. It varies the message
  so it doesn't feel repetitive — rotating between motivation,
  task suggestions, and distraction warnings.
*/
function scheduleFocusReminder() {
  const schedule = process.env.FOCUS_REMINDER_CRON || '30 9-17/1 * * *';
  console.log(`[SCHEDULER] Focus reminder: ${schedule}`);

  cron.schedule(schedule, async () => {
    console.log('[JOB] Running focus reminder check...');
    try {
      const openTasks = store.tasks.filter(t => !t.done && t.priority !== 'low');
      if (openTasks.length === 0) return;

      // Don't send focus reminders on weekends
      const dayOfWeek = new Date().getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return;

      // Limit: max 1 focus reminder per 2 hours
      const recentlySent = store.notificationLog.some(n => {
        if (!n.type.includes('Focus')) return false;
        const sentAt = new Date(n.sentAt);
        return (Date.now() - sentAt) < 2 * 60 * 60 * 1000;
      });
      if (recentlySent) return;

      const taskList = openTasks.slice(0, 5).map(t =>
        `- [${t.priority}] ${t.title}`
      ).join('\n');

      const hour = new Date().getHours();
      const timeContext = hour < 12 ? 'morning' : hour < 15 ? 'early afternoon' : 'late afternoon';

      const systemPrompt = `You are a focus coach sending a brief mid-${timeContext} check-in.
Return ONLY valid JSON — no markdown, no backticks.
Format: {"shouldSend": boolean, "message": "string (HTML, under 80 words)"}
Be encouraging, not nagging. Vary your tone. Sometimes suggest one specific task to focus on.
Sometimes warn gently about doomscrolling or distraction. Keep it human.`;

      const userMessage = `It's ${timeContext}. The user has these open tasks:
${taskList}

Should I send a brief focus check-in? If yes, write a short, varied nudge. 
Suggest one task to focus on next, or give an encouraging focus reminder.`;

      const raw = await callClaude(systemPrompt, userMessage, 200);
      const decision = JSON.parse(raw);

      if (decision.shouldSend) {
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        await sendEmail(
          `🎯 Focus Check-in — ${timeStr}`,
          emailTemplate('Stay Focused', decision.message, '#4a7c28')
        );
      }
    } catch (err) {
      console.error('[JOB ERROR] Focus reminder:', err.message);
    }
  }, { timezone: process.env.TZ || 'America/New_York' });
}

// ══════════════════════════════════════════════════════════
//  REST API — Endpoints the browser app calls
// ══════════════════════════════════════════════════════════

// Health check (no auth — used by Render to verify server is up)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tasks: store.tasks.length,
    goals: store.goals.length,
    uptime: Math.round(process.uptime()) + 's'
  });
});

// ── TASKS ─────────────────────────────────────────────────
app.get('/api/tasks', requireAuth, (req, res) => {
  res.json(store.tasks);
});

app.post('/api/tasks', requireAuth, (req, res) => {
  store.tasks = req.body.tasks || [];
  res.json({ ok: true, count: store.tasks.length });
});

// ── GOALS ─────────────────────────────────────────────────
app.get('/api/goals', requireAuth, (req, res) => {
  res.json(store.goals);
});

app.post('/api/goals', requireAuth, (req, res) => {
  store.goals = req.body.goals || [];
  res.json({ ok: true, count: store.goals.length });
});

// ── MEMORY ────────────────────────────────────────────────
app.get('/api/memory', requireAuth, (req, res) => {
  res.json({ memory: store.memory });
});

app.post('/api/memory', requireAuth, (req, res) => {
  store.memory = req.body.memory || '';
  res.json({ ok: true });
});

// ── CLAUDE PROXY ──────────────────────────────────────────
/*
  LEARNING NOTE — API Key Security

  In Phase 2, the browser called Claude directly (and exposed
  your API key in network requests). Now the browser calls
  THIS endpoint, which calls Claude server-side.
  Your API key never leaves the server.
*/
app.post('/api/claude', requireAuth, async (req, res) => {
  const { systemPrompt, userMessage, maxTokens } = req.body;
  try {
    const response = await callClaude(systemPrompt, userMessage, maxTokens || 1024);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── NOTIFICATION LOG ──────────────────────────────────────
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(store.notificationLog.slice(-20)); // last 20
});

// Manual trigger for testing (lets you test without waiting for schedule)
app.post('/api/trigger/:job', requireAuth, async (req, res) => {
  const { job } = req.params;
  console.log(`[MANUAL TRIGGER] ${job}`);

  try {
    if (job === 'morning') {
      // Temporarily override cron to run immediately
      const saved = process.env.MORNING_BRIEFING_CRON;
      process.env.MORNING_BRIEFING_CRON = '* * * * *';
      res.json({ ok: true, message: 'Morning briefing triggered — check your email in ~30s' });
      process.env.MORNING_BRIEFING_CRON = saved;
    } else {
      res.json({ ok: false, message: `Unknown job: ${job}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 Claude Assistant Phase 3`);
  console.log(`   Server running on port ${PORT}`);
  console.log(`   Timezone: ${process.env.TZ || 'America/New_York'}`);
  console.log(`   Claude API: ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ MISSING'}`);
  console.log(`   Email: ${process.env.GMAIL_USER ? '✓ configured' : '⚠ not configured (logs only)'}`);
  console.log('');

  // Start all scheduled jobs
  scheduleMorningBriefing();
  scheduleDueCheck();
  scheduleFocusReminder();

  console.log('   All schedulers running.\n');
});
