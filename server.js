'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store ──────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'data/schedules.json');
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (_) {}
  return { schedules: [] };
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── WhatsApp Client ──────────────────────────────────────────────────────────
let qrCodeData = null;
let connectionStatus = 'disconnected'; // disconnected | qr | connecting | connected
let clientReady = false;
let statusMessage = 'Not started';
const logs = [];

function addLog(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

client.on('qr', async (qr) => {
  connectionStatus = 'qr';
  statusMessage = 'Scan the QR code with WhatsApp';
  addLog('QR code generated — scan with WhatsApp', 'info');
  try {
    qrCodeData = await qrcode.toDataURL(qr);
  } catch (e) {
    addLog('QR generation failed: ' + e.message, 'error');
  }
});

client.on('loading_screen', (percent) => {
  connectionStatus = 'connecting';
  statusMessage = `Loading WhatsApp… ${percent}%`;
  addLog(`Loading: ${percent}%`, 'info');
});

client.on('authenticated', () => {
  connectionStatus = 'connecting';
  statusMessage = 'Authenticated — loading chats…';
  qrCodeData = null;
  addLog('Authenticated successfully', 'success');
});

client.on('auth_failure', (msg) => {
  connectionStatus = 'disconnected';
  statusMessage = 'Authentication failed';
  addLog('Auth failure: ' + msg, 'error');
});

client.on('ready', () => {
  connectionStatus = 'connected';
  clientReady = true;
  statusMessage = 'Connected & ready';
  qrCodeData = null;
  addLog('WhatsApp client ready!', 'success');
});

client.on('disconnected', (reason) => {
  connectionStatus = 'disconnected';
  clientReady = false;
  statusMessage = 'Disconnected: ' + reason;
  addLog('Disconnected: ' + reason, 'warn');
});

// ── Message Scheduler ────────────────────────────────────────────────────────
async function sendScheduledMessage(schedule) {
  if (!clientReady) {
    addLog(`Skipping "${schedule.name}" — client not ready`, 'warn');
    return;
  }

  try {
    const chatId = schedule.phone.includes('@') ? schedule.phone : `${schedule.phone}@c.us`;
    await client.sendMessage(chatId, schedule.message);

    const db = loadDB();
    const s = db.schedules.find(x => x.id === schedule.id);
    if (s) {
      s.lastSentAt = new Date().toISOString();
      s.sentCount = (s.sentCount || 0) + 1;
      if (s.type === 'once') {
        s.status = 'completed';
        s.cronJob = null;
      }
      saveDB(db);
    }
    addLog(`✓ Sent "${schedule.name}" to ${schedule.phone}`, 'success');
  } catch (err) {
    addLog(`✗ Failed "${schedule.name}": ${err.message}`, 'error');
  }
}

// Active cron jobs map
const activeJobs = {};

function buildCronExpression(schedule) {
  const d = new Date(schedule.scheduledAt);
  const min = d.getMinutes();
  const hr = d.getHours();
  const day = d.getDate();
  const month = d.getMonth() + 1;

  switch (schedule.recurrence) {
    case 'once':      return `${min} ${hr} ${day} ${month} *`;
    case 'daily':     return `${min} ${hr} * * *`;
    case 'weekly':    return `${min} ${hr} * * ${d.getDay()}`;
    case 'monthly':   return `${min} ${hr} ${day} * *`;
    default:          return null;
  }
}

function startJob(schedule) {
  if (activeJobs[schedule.id]) {
    activeJobs[schedule.id].stop();
    delete activeJobs[schedule.id];
  }
  if (schedule.status !== 'active') return;

  const expr = schedule.cronExpression || buildCronExpression(schedule);
  if (!expr || !cron.validate(expr)) {
    addLog(`Invalid cron for "${schedule.name}": ${expr}`, 'error');
    return;
  }

  addLog(`Scheduling "${schedule.name}" → ${expr}`, 'info');
  activeJobs[schedule.id] = cron.schedule(expr, () => sendScheduledMessage(schedule), {
    timezone: schedule.timezone || 'UTC',
  });
}

function initJobs() {
  const db = loadDB();
  db.schedules.filter(s => s.status === 'active').forEach(startJob);
  addLog(`Restored ${db.schedules.filter(s => s.status === 'active').length} active jobs`, 'info');
}

// ── API Routes ───────────────────────────────────────────────────────────────

// Status
app.get('/api/status', (req, res) => {
  res.json({ status: connectionStatus, message: statusMessage, qr: qrCodeData, clientReady });
});

// Logs
app.get('/api/logs', (req, res) => {
  res.json(logs.slice(0, 50));
});

// Start client
app.post('/api/start', (req, res) => {
  if (connectionStatus === 'connected') return res.json({ ok: true, message: 'Already connected' });
  if (connectionStatus === 'qr' || connectionStatus === 'connecting') return res.json({ ok: true, message: 'Already starting' });
  addLog('Starting WhatsApp client…', 'info');
  connectionStatus = 'connecting';
  statusMessage = 'Starting…';
  client.initialize().catch(e => {
    connectionStatus = 'disconnected';
    statusMessage = 'Start failed: ' + e.message;
    addLog('Initialize error: ' + e.message, 'error');
  });
  res.json({ ok: true, message: 'Client starting' });
});

// Logout
app.post('/api/logout', async (req, res) => {
  try {
    await client.logout();
    clientReady = false;
    connectionStatus = 'disconnected';
    statusMessage = 'Logged out';
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Get schedules
app.get('/api/schedules', (req, res) => {
  const db = loadDB();
  res.json(db.schedules);
});

// Create schedule
app.post('/api/schedules', (req, res) => {
  const { name, phone, message, scheduledAt, recurrence, timezone, cronExpression } = req.body;
  if (!name || !phone || !message || !scheduledAt) {
    return res.status(400).json({ error: 'name, phone, message, scheduledAt are required' });
  }

  const db = loadDB();
  const schedule = {
    id: uuidv4(),
    name, phone, message, scheduledAt,
    recurrence: recurrence || 'once',
    timezone: timezone || 'UTC',
    cronExpression: cronExpression || null,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastSentAt: null,
    sentCount: 0,
  };

  db.schedules.push(schedule);
  saveDB(db);
  startJob(schedule);
  addLog(`Created schedule "${name}"`, 'success');
  res.json(schedule);
});

// Update schedule status
app.patch('/api/schedules/:id', (req, res) => {
  const db = loadDB();
  const s = db.schedules.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  Object.assign(s, req.body);
  saveDB(db);

  if (s.status === 'active') startJob(s);
  else if (activeJobs[s.id]) {
    activeJobs[s.id].stop();
    delete activeJobs[s.id];
  }

  res.json(s);
});

// Delete schedule
app.delete('/api/schedules/:id', (req, res) => {
  const db = loadDB();
  const idx = db.schedules.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [removed] = db.schedules.splice(idx, 1);
  saveDB(db);

  if (activeJobs[removed.id]) {
    activeJobs[removed.id].stop();
    delete activeJobs[removed.id];
  }
  addLog(`Deleted schedule "${removed.name}"`, 'info');
  res.json({ ok: true });
});

// Send test message
app.post('/api/send-test', async (req, res) => {
  const { phone, message } = req.body;
  if (!clientReady) return res.status(400).json({ error: 'WhatsApp not connected' });
  try {
    const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
    await client.sendMessage(chatId, message || 'Test message from WhatsApp Scheduler ✅');
    addLog(`Test message sent to ${phone}`, 'success');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  WhatsApp Scheduler running at http://localhost:${PORT}\n`);
  initJobs();
});
