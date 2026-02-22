// ════════════════════════════════════════════════════════════
//  PHASE 3 — Proactive Claude Assistant Backend
//  (Updated: PostgreSQL storage — data survives redeploys)
//
//  WHAT'S NEW vs the original Phase 3:
//  - Replaced in-memory store with PostgreSQL via Render's
//    free managed database. Tasks, goals, memory, and the
//    notification log all persist permanently now.
//
//  LEARNING NOTE — Why this matters:
//  The original Phase 3 stored everything in a JS variable.
//  That variable lives in RAM — when the server process
//  restarts (deploys, crashes, sleep/wake), RAM is wiped.
//  A database writes to disk. Disk survives restarts.
//  This is the fundamental difference between ephemeral
//  state and persistent state — one of the most important
//  concepts in backend development.
// ════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const path       = require('path');
const { Pool }   = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── DATABASE ───────────────────────────────────────────────
/*
  LEARNING NOTE — PostgreSQL connection pool

  DATABASE_URL is automatically set by Render when you attach
  a PostgreSQL database to your web service. It contains the
  host, port, username, password, and database name all in
  one connection string.

  A "pool" manages multiple connections efficiently — instead
  of opening a new connection for every query (slow), it keeps
  a few connections open and reuses them (fast).

  ssl: { rejectUnauthorized: false } is required for Render's
  managed PostgreSQL — it uses self-signed certificates.
*/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Create tables on startup — safe to run every time because
// of "IF NOT EXISTS" and "ON CONFLICT DO NOTHING"
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    INSERT INTO store (key, value) VALUES
      ('tasks',            '[]'),
      ('goals',            '[]'),
      ('memory',           '""'),
      ('notification_log', '[]')
    ON CONFLICT (key) DO NOTHING;
  `);

  console.log('   Database ready ✓');
}

// ── DB HELPERS ─────────────────────────────────────────────
/*
  LEARNING NOTE — Simple key-value database pattern

  Rather than a full relational schema (separate tasks table,
  goals table, etc.), we use a single key-value table and
  store JSON strings. This is the simplest approach and works
  perfectly for a single-user personal app.

  For a multi-user app you would use proper normalized tables
  with user IDs, foreign keys, and indexes.
*/
async function dbGet(key) {
  const result = await pool.query(
    'SELECT value FROM store WHERE key = $1', [key]
  );
  if (!result.rows[0]) return null;
  return JSON.parse(result.rows[0].value);
}

async function dbSet(key, value) {
  await pool.query(
    `INSERT INTO store (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, JSON.stringify(value)]
  );
}

// ── AUTH MIDDLEWARE ────────────────────────────────────────
function requireAuth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!secret || secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── CLAUDE API CALL ────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  const memory = await dbGet('memory') || '';
  const fullSystem = memory
    ? `${systemPrompt}\n\nAbout the user:\n${memory}`
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

// ── EMAIL ──────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

async function sendEmail(subject, htmlBody) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('[EMAIL SKIPPED - not configured]\n', subject);
    return;
  }

  await transporter.sendMail({
    from: `"My Assistant" <${process.env.GMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject,
    html: htmlBody
  });

  console.log(`[EMAIL SENT] ${subject}`);

  // Persist notification log to DB so it survives redeploys
  const log = await dbGet('notification_log') || [];
  log.push({ type: subject, sentAt: new Date().toISOString() });
  await dbSet('notification_log', log.slice(-50));
}

function emailTemplate(title, body, color = '#2d5016') {
  return `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
      <div style="background:${color};color:white;padding:16px 20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:16px;font-weight:500">${title}</h2>
      </div>
      <div style="background:#fff;border:1px solid #e8e2d8;border-top:none;padding:20px;border-radius:0 0 8px 8px;line-height:1.65;font-size:14px;color:#1a1a14">
        ${body}
      </div>
      <p style="font-size:11px;color:#9a9a84;margin-top:12px;text-align:center">Sent by your Claude Assistant</p>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  SCHEDULED JOBS
//
//  LEARNING NOTE — The agentic loop
//  schedule → load from DB → call Claude → Claude decides
//  → send email (or not) → persist log to DB
//
//  Because data now comes from the DB rather than RAM,
//  these jobs work correctly after any redeploy.
// ══════════════════════════════════════════════════════════

// ── JOB 1: MORNING BRIEFING ────────────────────────────────
function scheduleMorningBriefing() {
  const schedule = process.env.MORNING_BRIEFING_CRON || '0 8 * * *';
  console.log(`[SCHEDULER] Morning briefing: ${schedule}`);

  cron.schedule(schedule, async () => {
    console.log('[JOB] Running morning briefing...');
    try {
      const tasks     = await dbGet('tasks') || [];
      const goals     = await dbGet('goals') || [];
      const openTasks = tasks.filter(t => !t.done);
      const openGoals = goals.filter(g => !g.achieved);

      if (openTasks.length === 0 && openGoals.length === 0) {
        console.log('[JOB] No tasks or goals — skipping');
        return;
      }

      const today       = new Date();
      const taskContext = openTasks.map(t =>
        `- [${t.priority.toUpperCase()}] ${t.title} (${t.category})${t.dueDate ? `, due ${t.dueDate}` : ''}`
      ).join('\n') || 'None';
      const goalContext = openGoals.map(g => {
        const pct = g.target ? ` (${Math.round((g.saved / g.target) * 100)}% funded)` : '';
        return `- ${g.title}${pct}`;
      }).join('\n') || 'None';

      const systemPrompt = `You are a proactive personal assistant writing a morning briefing email.
Be warm and practical. Format as HTML using <p>, <strong>, <ul>, <li> tags. Keep under 200 words.
Today is ${today.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}.`;

      const briefing = await callClaude(systemPrompt,
        `Write a morning briefing.\n\nOpen tasks:\n${taskContext}\n\nLong-term goals:\n${goalContext}`, 512);

      await sendEmail(
        `☀️ Morning Briefing — ${today.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' })}`,
        emailTemplate('Your Morning Briefing', briefing)
      );
    } catch (err) {
      console.error('[JOB ERROR] Morning briefing:', err.message);
    }
  }, { timezone: process.env.TZ || 'America/New_York' });
}

// ── JOB 2: DUE / OVERDUE CHECK ─────────────────────────────
function scheduleDueCheck() {
  const schedule = process.env.DUE_CHECK_CRON || '0 9-17 * * *';
  console.log(`[SCHEDULER] Due check: ${schedule}`);

  cron.schedule(schedule, async () => {
    console.log('[JOB] Running due/overdue check...');
    try {
      const tasks = await dbGet('tasks') || [];
      const log   = await dbGet('notification_log') || [];

      const today     = new Date(); today.setHours(0,0,0,0);
      const threeDays = new Date(today); threeDays.setDate(today.getDate() + 3);

      const urgentTasks = tasks.filter(t => {
        if (t.done || !t.dueDate) return false;
        return new Date(t.dueDate + 'T00:00:00') <= threeDays;
      });

      if (urgentTasks.length === 0) { console.log('[JOB] No urgent tasks'); return; }

      const recentlySent = log.some(n =>
        n.type.includes('Due') && (Date.now() - new Date(n.sentAt)) < 4 * 60 * 60 * 1000
      );
      if (recentlySent) { console.log('[JOB] Due check sent recently — skipping'); return; }

      const taskList = urgentTasks.map(t => {
        const diff  = Math.round((new Date(t.dueDate + 'T00:00:00') - today) / 86400000);
        const label = diff < 0 ? `OVERDUE by ${Math.abs(diff)}d` : diff === 0 ? 'DUE TODAY' : `due in ${diff}d`;
        return `- [${t.priority.toUpperCase()}] ${t.title} — ${label}`;
      }).join('\n');

      const systemPrompt = `You are a personal assistant deciding whether to send an urgent notification.
Return ONLY valid JSON: {"shouldNotify": boolean, "subject": "string", "message": "HTML string under 100 words"}`;

      const raw      = await callClaude(systemPrompt,
        `These tasks are due soon or overdue:\n${taskList}\n\nShould I interrupt the user? Only yes if something is truly urgent.`, 256);
      const decision = JSON.parse(raw);

      console.log(`[JOB] Claude decision — shouldNotify: ${decision.shouldNotify}`);
      if (decision.shouldNotify) {
        await sendEmail(`⚠️ ${decision.subject || 'Tasks Need Attention'}`,
          emailTemplate('Tasks Due Soon', decision.message, '#c0392b'));
      }
    } catch (err) {
      console.error('[JOB ERROR] Due check:', err.message);
    }
  }, { timezone: process.env.TZ || 'America/New_York' });
}

// ── JOB 3: FOCUS REMINDER ──────────────────────────────────
function scheduleFocusReminder() {
  const schedule = process.env.FOCUS_REMINDER_CRON || '30 9-17/1 * * *';
  console.log(`[SCHEDULER] Focus reminder: ${schedule}`);

  cron.schedule(schedule, async () => {
    console.log('[JOB] Running focus reminder check...');
    try {
      const tasks = await dbGet('tasks') || [];
      const log   = await dbGet('notification_log') || [];

      const openTasks = tasks.filter(t => !t.done && t.priority !== 'low');
      if (openTasks.length === 0) return;

      const day = new Date().getDay();
      if (day === 0 || day === 6) return;

      const recentlySent = log.some(n =>
        n.type.includes('Focus') && (Date.now() - new Date(n.sentAt)) < 2 * 60 * 60 * 1000
      );
      if (recentlySent) return;

      const taskList    = openTasks.slice(0, 5).map(t => `- [${t.priority}] ${t.title}`).join('\n');
      const hour        = new Date().getHours();
      const timeContext = hour < 12 ? 'morning' : hour < 15 ? 'early afternoon' : 'late afternoon';

      const systemPrompt = `You are a focus coach. Return ONLY valid JSON:
{"shouldSend": boolean, "message": "HTML string under 80 words"}
Be encouraging, not nagging. Vary your tone.`;

      const raw      = await callClaude(systemPrompt,
        `It's ${timeContext}. Tasks:\n${taskList}\n\nSend a brief focus nudge?`, 200);
      const decision = JSON.parse(raw);

      if (decision.shouldSend) {
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        await sendEmail(`🎯 Focus Check-in — ${timeStr}`,
          emailTemplate('Stay Focused', decision.message, '#4a7c28'));
      }
    } catch (err) {
      console.error('[JOB ERROR] Focus reminder:', err.message);
    }
  }, { timezone: process.env.TZ || 'America/New_York' });
}

// ══════════════════════════════════════════════════════════
//  REST API
// ══════════════════════════════════════════════════════════

app.get('/health', async (req, res) => {
  try {
    const tasks = await dbGet('tasks') || [];
    const goals = await dbGet('goals') || [];
    res.json({ status: 'ok', tasks: tasks.length, goals: goals.length, uptime: Math.round(process.uptime()) + 's' });
  } catch (err) {
    res.status(500).json({ status: 'db-error', message: err.message });
  }
});

app.get('/api/tasks',        requireAuth, async (req, res) => res.json(await dbGet('tasks') || []));
app.post('/api/tasks',       requireAuth, async (req, res) => { await dbSet('tasks', req.body.tasks || []); res.json({ ok: true }); });

app.get('/api/goals',        requireAuth, async (req, res) => res.json(await dbGet('goals') || []));
app.post('/api/goals',       requireAuth, async (req, res) => { await dbSet('goals', req.body.goals || []); res.json({ ok: true }); });

app.get('/api/memory',       requireAuth, async (req, res) => res.json({ memory: await dbGet('memory') || '' }));
app.post('/api/memory',      requireAuth, async (req, res) => { await dbSet('memory', req.body.memory || ''); res.json({ ok: true }); });

app.get('/api/notifications', requireAuth, async (req, res) => {
  const log = await dbGet('notification_log') || [];
  res.json(log.slice(-20));
});

app.post('/api/claude', requireAuth, async (req, res) => {
  try {
    const response = await callClaude(req.body.systemPrompt, req.body.userMessage, req.body.maxTokens || 1024);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual test trigger — runs the morning briefing immediately
app.post('/api/trigger/:job', requireAuth, async (req, res) => {
  const { job } = req.params;
  console.log(`[MANUAL TRIGGER] ${job}`);
  if (job !== 'morning') return res.json({ ok: false, message: `Unknown job: ${job}` });

  res.json({ ok: true, message: 'Morning briefing triggered — check your email in ~30s' });

  try {
    const tasks     = await dbGet('tasks') || [];
    const goals     = await dbGet('goals') || [];
    const openTasks = tasks.filter(t => !t.done);
    const openGoals = goals.filter(g => !g.achieved);
    const today     = new Date();
    const taskCtx   = openTasks.map(t => `- [${t.priority.toUpperCase()}] ${t.title}${t.dueDate ? `, due ${t.dueDate}` : ''}`).join('\n') || 'None';
    const goalCtx   = openGoals.map(g => `- ${g.title}`).join('\n') || 'None';
    const systemPrompt = `You are a personal assistant writing a test morning briefing. Format as HTML. Keep under 200 words. Today is ${today.toLocaleDateString()}.`;
    const briefing  = await callClaude(systemPrompt, `Tasks:\n${taskCtx}\n\nGoals:\n${goalCtx}`, 512);
    await sendEmail(`☀️ Test Briefing — ${today.toLocaleTimeString()}`, emailTemplate('Test Morning Briefing', briefing));
  } catch (err) {
    console.error('[TRIGGER ERROR]', err.message);
  }
});

// ── START ──────────────────────────────────────────────────
async function start() {
  try {
    await initDb();
  } catch (err) {
    console.warn('\n   ⚠ Database unavailable:', err.message);
    console.warn('   Set DATABASE_URL to enable persistence.\n');
  }

  app.listen(PORT, () => {
    console.log(`\n🤖 Claude Assistant Phase 3`);
    console.log(`   Port:     ${PORT}`);
    console.log(`   Timezone: ${process.env.TZ || 'America/New_York'}`);
    console.log(`   Claude:   ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
    console.log(`   Email:    ${process.env.GMAIL_USER ? '✓' : '⚠ not configured'}`);
    console.log(`   Database: ${process.env.DATABASE_URL ? '✓' : '⚠ not configured — data will not persist'}`);
    console.log('');
    scheduleMorningBriefing();
    scheduleDueCheck();
    scheduleFocusReminder();
    console.log('   All schedulers running.\n');
  });
}

start();

// ══════════════════════════════════════════════════════════
//  GOOGLE HOME WEBHOOK
//
//  LEARNING NOTE — How Google Actions webhooks work:
//  When you say "Hey Google, talk to my assistant", Google's
//  servers send a POST request to this endpoint with a JSON
//  body describing what the user said (an "intent"). Your
//  server processes it, optionally calls Claude, and returns
//  a JSON response with what Google should say back.
//
//  The flow is:
//  1. User speaks → Google speech-to-text → intent detected
//  2. Google POSTs to /webhook/google with the intent + session
//  3. This handler reads tasks/goals from DB, calls Claude
//  4. Returns { prompt: { firstSimple: { speech: "..." } } }
//  5. Google reads that text aloud on the Home device
//
//  No auth header here — Google Actions signs requests with
//  a JWT token we verify using the GOOGLE_ACTION_SECRET env var.
//  For simplicity during development we skip verification,
//  but the endpoint URL itself is secret enough for personal use.
// ══════════════════════════════════════════════════════════

app.post('/webhook/google', async (req, res) => {
  console.log('[GOOGLE] Incoming intent:', JSON.stringify(req.body?.intent, null, 2));

  try {
    const handler   = req.body?.handler?.name || '';
    const intentName = req.body?.intent?.name || '';
    const session   = req.body?.session || {};
    const scene     = req.body?.scene || {};

    // Extract what the user said from slots/params
    const params = req.body?.intent?.params || {};
    const taskText = params?.task?.resolved || params?.task?.original || '';
    const query    = params?.query?.resolved || params?.query?.original || '';

    console.log(`[GOOGLE] Handler: ${handler} | Intent: ${intentName} | Task: "${taskText}" | Query: "${query}"`);

    let speech = '';
    let endConversation = false;

    // ── WELCOME ────────────────────────────────────────────
    if (handler === 'welcome' || intentName === 'actions.intent.MAIN') {
      const tasks = await dbGet('tasks') || [];
      const open  = tasks.filter(t => !t.done).length;
      const high  = tasks.filter(t => !t.done && t.priority === 'high').length;

      if (open === 0) {
        speech = "Your assistant is ready. You have no open tasks right now. Would you like to add one, or shall I tell you about your goals?";
      } else if (high > 0) {
        speech = `Your assistant is ready. You have ${open} open task${open !== 1 ? 's' : ''}, including ${high} high priority. You can say: add a task, what are my tasks, what should I focus on, or how are my goals.`;
      } else {
        speech = `Your assistant is ready. You have ${open} open task${open !== 1 ? 's' : ''}. You can say: add a task, what are my tasks, what should I focus on, or how are my goals.`;
      }
    }

    // ── ADD TASK ───────────────────────────────────────────
    else if (handler === 'add_task' || intentName === 'ADD_TASK') {
      if (!taskText) {
        speech = "What task would you like to add?";
      } else {
        // Use Claude to categorize and prioritize the spoken task
        const systemPrompt = `You are a task organizer. Return ONLY valid JSON — no markdown, no backticks.
Format: {"title": "string", "priority": "high"|"medium"|"low", "category": "string", "reason": "string"}`;

        const raw    = await callClaude(systemPrompt, `Categorize this task: "${taskText}"`, 256);
        const parsed = JSON.parse(raw);

        const tasks = await dbGet('tasks') || [];
        tasks.push({
          id:        Date.now() + Math.random(),
          title:     parsed.title,
          priority:  parsed.priority,
          category:  parsed.category,
          reason:    parsed.reason,
          dueDate:   null,
          done:      false,
          createdAt: new Date().toISOString()
        });
        await dbSet('tasks', tasks);

        speech = `Got it. I've added "${parsed.title}" as a ${parsed.priority} priority ${parsed.category} task. Anything else?`;
        console.log(`[GOOGLE] Task added: ${parsed.title}`);
      }
    }

    // ── LIST TASKS ─────────────────────────────────────────
    else if (handler === 'list_tasks' || intentName === 'LIST_TASKS') {
      const tasks    = await dbGet('tasks') || [];
      const openHigh = tasks.filter(t => !t.done && t.priority === 'high');
      const openMed  = tasks.filter(t => !t.done && t.priority === 'medium');
      const open     = [...openHigh, ...openMed].slice(0, 5);

      if (open.length === 0) {
        speech = "You have no open high or medium priority tasks right now. Nice work!";
        endConversation = true;
      } else {
        const list = open.map((t, i) => `${i + 1}: ${t.title}`).join('. ');
        speech = `Here are your top tasks. ${list}. Would you like to add a task, or hear what to focus on?`;
      }
    }

    // ── WHAT TO FOCUS ON ───────────────────────────────────
    else if (handler === 'focus' || intentName === 'FOCUS') {
      const tasks    = await dbGet('tasks') || [];
      const openTasks = tasks.filter(t => !t.done).slice(0, 8);

      if (openTasks.length === 0) {
        speech = "You have no open tasks. You're all caught up!";
        endConversation = true;
      } else {
        const taskList = openTasks.map(t =>
          `- [${t.priority}] ${t.title}${t.dueDate ? `, due ${t.dueDate}` : ''}`
        ).join('\n');

        const systemPrompt = `You are a voice assistant answering through a smart speaker.
Give a SHORT spoken recommendation — 2-3 sentences maximum, no lists, no bullet points.
Speak naturally as if talking to someone. Today is ${new Date().toLocaleDateString()}.`;

        speech = await callClaude(systemPrompt,
          `The user asked what to focus on. Their tasks:\n${taskList}\n\nGive a brief spoken recommendation of what to tackle next and why.`, 200);

        endConversation = false;
      }
    }

    // ── GOALS ──────────────────────────────────────────────
    else if (handler === 'goals' || intentName === 'GOALS') {
      const goals      = await dbGet('goals') || [];
      const openGoals  = goals.filter(g => !g.achieved);

      if (openGoals.length === 0) {
        speech = "You haven't added any long-term goals yet. You can add them in the app.";
        endConversation = true;
      } else {
        const goalSummaries = openGoals.slice(0, 3).map(g => {
          if (g.target && g.saved) {
            const pct = Math.round((g.saved / g.target) * 100);
            return `${g.title} is ${pct}% funded`;
          }
          return g.title;
        });

        if (goalSummaries.length === 1) {
          speech = `Your long-term goal: ${goalSummaries[0]}. Keep at it!`;
        } else {
          const last = goalSummaries.pop();
          speech = `Your long-term goals: ${goalSummaries.join(', ')}, and ${last}. Is there anything you'd like to add?`;
        }
      }
    }

    // ── ASK CLAUDE (free-form) ─────────────────────────────
    else if (handler === 'ask_claude' || intentName === 'ASK_CLAUDE') {
      const question = query || taskText;
      if (!question) {
        speech = "What would you like to ask?";
      } else {
        const tasks    = await dbGet('tasks') || [];
        const goals    = await dbGet('goals') || [];
        const taskCtx  = tasks.filter(t => !t.done).slice(0, 8)
          .map(t => `- [${t.priority}] ${t.title}`).join('\n') || 'None';
        const goalCtx  = goals.filter(g => !g.achieved)
          .map(g => g.title).join(', ') || 'None';

        const systemPrompt = `You are a voice assistant on a smart speaker. Answer in 2-3 spoken sentences maximum.
No lists, no bullet points, no markdown. Natural conversational speech only.
Today is ${new Date().toLocaleDateString()}.`;

        speech = await callClaude(systemPrompt,
          `Tasks: ${taskCtx}\nGoals: ${goalCtx}\n\nUser asked: "${question}"`, 200);
      }
    }

    // ── GOODBYE ────────────────────────────────────────────
    else if (handler === 'goodbye' || intentName === 'actions.intent.CANCEL') {
      speech = "Got it. I'll keep an eye on your tasks. Goodbye!";
      endConversation = true;
    }

    // ── UNKNOWN ────────────────────────────────────────────
    else {
      speech = "I can help you add tasks, list your tasks, tell you what to focus on, or give you a goal update. What would you like?";
    }

    // ── RESPONSE FORMAT ────────────────────────────────────
    /*
      LEARNING NOTE — Actions on Google response format
      Google expects a specific JSON structure. The key fields:
      - prompt.firstSimple.speech: what Google reads aloud
      - scene.next.name: which scene to go to next
      - session.params: data to carry through the conversation
    */
    const response = {
      session: { id: session.id, params: session.params || {} },
      prompt: {
        override: false,
        firstSimple: { speech, text: speech }
      },
      scene: endConversation
        ? { name: scene.name, next: { name: 'actions.scene.END_CONVERSATION' } }
        : { name: scene.name }
    };

    console.log(`[GOOGLE] Responding: "${speech.substring(0, 80)}..."`);
    res.json(response);

  } catch (err) {
    console.error('[GOOGLE WEBHOOK ERROR]', err.message);
    res.json({
      prompt: {
        firstSimple: {
          speech: "Sorry, I ran into a problem. Please try again in a moment.",
          text: "Sorry, I ran into a problem. Please try again in a moment."
        }
      }
    });
  }
});
