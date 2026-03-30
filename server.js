'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const cron = require('node-cron');
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
  return { scheduled: [], sent: [], failed: [] };
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

// Auto-start on boot
client.initialize().catch(e => {
  connectionStatus = 'disconnected';
  io.emit('status', { state: 'disconnected', message: 'Start failed: ' + e.message });
  console.error('Initialize error:', e.message);
});

// ── Socket: send current state to new connections ────────────────────────────
io.on('connection', (socket) => {
  if (connectionStatus === 'connected' && clientReady) {
    const info = client.info;
    socket.emit('connected', { phone: info?.wid?.user || '', name: info?.pushname || 'Connected' });
  }
  socket.emit('status', { state: connectionStatus, message: connectionStatus });

  // Push current data
  const db = loadDB();
  socket.emit('schedule_update', db.scheduled);
  socket.emit('sent_update', db.sent);
});

// ── Scheduler ─────────────────────────────────────────────────────────────────
const activeJobs = {};

async function sendScheduledMessage(schedule) {
  if (!clientReady) {
    console.warn(`Skipping "${schedule.label}" — client not ready`);
    return;
  }
  const db = loadDB();
  try {
    const chatId = schedule.phone.includes('@') ? schedule.phone : `${schedule.phone}@c.us`;
    await client.sendMessage(chatId, schedule.message);

    const idx = db.scheduled.findIndex(s => s.id === schedule.id);
    if (idx !== -1) db.scheduled.splice(idx, 1);

    const sent = { ...schedule, status: 'sent', sentAt: new Date().toISOString() };
    db.sent.unshift(sent);
    saveDB(db);

    io.emit('schedule_update', db.scheduled);
    io.emit('sent_update', db.sent);
    io.emit('message_sent', sent);
  } catch (err) {
    const idx = db.scheduled.findIndex(s => s.id === schedule.id);
    if (idx !== -1) {
      db.scheduled[idx].status = 'failed';
      db.scheduled[idx].error = err.message;
    }
    saveDB(db);
    io.emit('schedule_update', db.scheduled);
    io.emit('message_failed', { ...schedule, error: err.message });
    console.error(`Failed "${schedule.label}":`, err.message);
  }
}

function startJob(schedule) {
  if (activeJobs[schedule.id]) { activeJobs[schedule.id].stop(); delete activeJobs[schedule.id]; }
  if (schedule.status !== 'pending') return;

  const d = new Date(schedule.scheduledAt);
  const expr = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;

  if (!cron.validate(expr)) { console.error('Invalid cron:', expr); return; }

  activeJobs[schedule.id] = cron.schedule(expr, () => {
    sendScheduledMessage(schedule);
    activeJobs[schedule.id]?.stop();
    delete activeJobs[schedule.id];
  }, { timezone: schedule.timezone || 'UTC' });
}

function initJobs() {
  const db = loadDB();
  db.scheduled.filter(s => s.status === 'pending').forEach(startJob);
}

// ── REST API ──────────────────────────────────────────────────────────────────

// GET /api/messages — initial page load data
app.get('/api/messages', (req, res) => {
  const db = loadDB();
  res.json({ scheduled: db.scheduled, sent: db.sent, failed: db.failed || [] });
});

// POST /api/schedule — create
app.post('/api/schedule', (req, res) => {
  const { phone, message, scheduledAt, label } = req.body;
  if (!phone || !message || !scheduledAt)
    return res.status(400).json({ success: false, error: 'phone, message, scheduledAt required' });

  const db = loadDB();
  const schedule = {
    id: uuidv4(), phone, message, scheduledAt,
    label: label || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    timezone: 'UTC',
  };

  db.scheduled.push(schedule);
  saveDB(db);
  startJob(schedule);

  io.emit('schedule_update', db.scheduled);
  res.json({ success: true, schedule });
});

// DELETE /api/schedule/:id — cancel
app.delete('/api/schedule/:id', (req, res) => {
  const db = loadDB();
  const idx = db.scheduled.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });

  db.scheduled.splice(idx, 1);
  saveDB(db);

  if (activeJobs[req.params.id]) { activeJobs[req.params.id].stop(); delete activeJobs[req.params.id]; }
  io.emit('schedule_update', db.scheduled);
  res.json({ success: true });
});

// POST /api/send-now — instant send
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

// DELETE /api/history — clear sent/failed
app.delete('/api/history', (req, res) => {
  const db = loadDB();
  db.sent = [];
  db.failed = [];
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
