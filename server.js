'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Persistent store ──────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'schedules.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (_) {}
  return { scheduled: [], sent: [] };
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ── WhatsApp client ───────────────────────────────────────────────────────────
let connectionStatus = 'disconnected';
let clientReady = false;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

client.on('qr', async (qr) => {
  connectionStatus = 'qr';
  try {
    const dataUrl = await qrcode.toDataURL(qr);
    io.emit('qr', { qr: dataUrl });
    io.emit('status', { state: 'qr', message: 'Scan QR code' });
  } catch (e) { console.error('QR gen failed:', e.message); }
});

client.on('loading_screen', (percent) => {
  io.emit('status', { state: 'connecting', message: `Loading WhatsApp… ${percent}%` });
});

client.on('authenticated', () => {
  connectionStatus = 'connecting';
  io.emit('status', { state: 'connecting', message: 'Authenticated — loading chats…' });
});

client.on('auth_failure', (msg) => {
  connectionStatus = 'disconnected';
  io.emit('status', { state: 'disconnected', message: 'Auth failed: ' + msg });
});

client.on('ready', () => {
  connectionStatus = 'connected';
  clientReady = true;
  const info = client.info;
  io.emit('connected', { phone: info?.wid?.user || '', name: info?.pushname || 'Connected' });
  io.emit('status', { state: 'connected', message: 'Connected & ready' });
  initJobs();
});

client.on('disconnected', (reason) => {
  connectionStatus = 'disconnected';
  clientReady = false;
  io.emit('status', { state: 'disconnected', message: 'Disconnected: ' + reason });
});

client.initialize().catch(e => {
  connectionStatus = 'disconnected';
  console.error('Initialize error:', e.message);
});

// ── Socket: send current state to new connections ────────────────────────────
io.on('connection', (socket) => {
  if (connectionStatus === 'connected' && clientReady) {
    const info = client.info;
    socket.emit('connected', { phone: info?.wid?.user || '', name: info?.pushname || 'Connected' });
  }
  socket.emit('status', { state: connectionStatus, message: connectionStatus });

  const db = loadDB();
  socket.emit('schedule_update', db.scheduled);
  socket.emit('sent_update', db.sent);
});

// ── Scheduler — uses setTimeout so no timezone math needed ───────────────────
// activeTimers: id -> { timer, schedule }
const activeTimers = {};

async function sendScheduledMessage(id) {
  delete activeTimers[id];

  const db = loadDB();
  const schedule = db.scheduled.find(s => s.id === id);
  if (!schedule || schedule.status !== 'pending') return;

  if (!clientReady) {
    console.warn(`Skipping "${schedule.label}" — client not ready`);
    // Retry in 30s
    activeTimers[id] = setTimeout(() => sendScheduledMessage(id), 30000);
    return;
  }

  try {
    const chatId = schedule.phone.includes('@') ? schedule.phone : `${schedule.phone}@c.us`;
    await client.sendMessage(chatId, schedule.message);

    db.scheduled = db.scheduled.filter(s => s.id !== id);
    const sent = { ...schedule, status: 'sent', sentAt: new Date().toISOString() };
    db.sent.unshift(sent);
    saveDB(db);

    io.emit('schedule_update', db.scheduled);
    io.emit('sent_update', db.sent);
    io.emit('message_sent', sent);
    console.log(`✓ Sent "${schedule.label}" to ${schedule.phone}`);
  } catch (err) {
    const s = db.scheduled.find(x => x.id === id);
    if (s) { s.status = 'failed'; s.error = err.message; }
    saveDB(db);
    io.emit('schedule_update', db.scheduled);
    io.emit('message_failed', { ...schedule, error: err.message });
    console.error(`✗ Failed "${schedule.label}":`, err.message);
  }
}

function scheduleTimer(schedule) {
  if (activeTimers[schedule.id]) {
    clearTimeout(activeTimers[schedule.id]);
    delete activeTimers[schedule.id];
  }
  if (schedule.status !== 'pending') return;

  // scheduledAt is stored as ISO string (UTC) — Date.parse gives ms since epoch
  const delay = Date.parse(schedule.scheduledAt) - Date.now();

  if (delay <= 0) {
    // Already past — send immediately
    sendScheduledMessage(schedule.id);
  } else {
    console.log(`Scheduling "${schedule.label}" in ${Math.round(delay/1000)}s`);
    activeTimers[schedule.id] = setTimeout(() => sendScheduledMessage(schedule.id), delay);
  }
}

function initJobs() {
  const db = loadDB();
  db.scheduled.filter(s => s.status === 'pending').forEach(scheduleTimer);
}

// ── REST API ──────────────────────────────────────────────────────────────────

// GET /api/messages
app.get('/api/messages', (req, res) => {
  const db = loadDB();
  res.json({ scheduled: db.scheduled, sent: db.sent, failed: [] });
});

// POST /api/schedule
app.post('/api/schedule', (req, res) => {
  const { phone, message, scheduledAt, label } = req.body;
  if (!phone || !message || !scheduledAt)
    return res.status(400).json({ success: false, error: 'phone, message, scheduledAt required' });

  // scheduledAt from browser datetime-local is like "2026-03-30T18:00"
  // We must treat it as UTC to match server time.
  // Frontend should send ISO with offset — accept both.
  const scheduledMs = Date.parse(scheduledAt);
  if (isNaN(scheduledMs))
    return res.status(400).json({ success: false, error: 'Invalid scheduledAt format' });

  if (scheduledMs <= Date.now())
    return res.status(400).json({ success: false, error: 'Schedule time must be in the future' });

  const db = loadDB();
  const schedule = {
    id: uuidv4(),
    phone,
    message,
    scheduledAt: new Date(scheduledMs).toISOString(), // Store as proper UTC ISO
    label: label || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  db.scheduled.push(schedule);
  saveDB(db);
  scheduleTimer(schedule);

  io.emit('schedule_update', db.scheduled);
  res.json({ success: true, schedule });
});

// DELETE /api/schedule/:id
app.delete('/api/schedule/:id', (req, res) => {
  const db = loadDB();
  const idx = db.scheduled.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });

  db.scheduled.splice(idx, 1);
  saveDB(db);

  if (activeTimers[req.params.id]) {
    clearTimeout(activeTimers[req.params.id]);
    delete activeTimers[req.params.id];
  }

  io.emit('schedule_update', db.scheduled);
  res.json({ success: true });
});

// POST /api/send-now
app.post('/api/send-now', async (req, res) => {
  const { phone, message } = req.body;
  if (!clientReady) return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  try {
    const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
    await client.sendMessage(chatId, message);
    const db = loadDB();
    const sent = { id: uuidv4(), phone, message, label: 'instant', status: 'sent', sentAt: new Date().toISOString() };
    db.sent.unshift(sent);
    saveDB(db);
    io.emit('sent_update', db.sent);
    io.emit('message_sent', sent);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/history
app.delete('/api/history', (req, res) => {
  const db = loadDB();
  db.sent = [];
  saveDB(db);
  io.emit('sent_update', []);
  res.json({ success: true });
});

// POST /api/disconnect
app.post('/api/disconnect', async (req, res) => {
  try {
    await client.logout();
    clientReady = false;
    connectionStatus = 'disconnected';
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  WhatsApp Scheduler running at http://localhost:${PORT}\n`);
});
