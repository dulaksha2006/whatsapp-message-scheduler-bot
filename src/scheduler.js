const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../scheduled_messages.json');

class Scheduler {
  constructor(whatsappClient, io) {
    this.wa = whatsappClient;
    this.io = io;
    this.jobs = new Map(); // id -> cron job
    this.messages = this.loadMessages();
    this.restoreJobs();
  }

  loadMessages() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      }
    } catch (e) {}
    return [];
  }

  saveMessages() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(this.messages, null, 2));
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  schedule(phone, message, scheduledAt, repeat = 'none') {
    const id = this.generateId();
    const entry = {
      id,
      phone,
      message,
      scheduledAt, // ISO string
      repeat,      // none | daily | weekly | monthly
      status: 'pending',
      createdAt: new Date().toISOString(),
      lastSent: null,
      sendCount: 0,
    };

    this.messages.push(entry);
    this.saveMessages();
    this.createJob(entry);
    this.broadcastMessages();
    return entry;
  }

  createJob(entry) {
    const targetDate = new Date(entry.scheduledAt);
    const now = new Date();

    if (entry.repeat === 'none') {
      if (targetDate <= now) {
        // Already past - mark failed if pending
        if (entry.status === 'pending') {
          this.updateStatus(entry.id, 'failed', 'Scheduled time is in the past');
        }
        return;
      }

      const delay = targetDate.getTime() - now.getTime();
      const timer = setTimeout(async () => {
        await this.send(entry.id);
      }, delay);

      this.jobs.set(entry.id, { type: 'timeout', handle: timer });
    } else {
      // Build cron expression from scheduledAt time
      const cronExpr = this.buildCron(targetDate, entry.repeat);
      if (!cron.validate(cronExpr)) return;

      const job = cron.schedule(cronExpr, async () => {
        await this.send(entry.id);
      });

      this.jobs.set(entry.id, { type: 'cron', handle: job });
    }
  }

  buildCron(date, repeat) {
    const min = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const dow = date.getDay();

    switch (repeat) {
      case 'daily':   return `${min} ${hour} * * *`;
      case 'weekly':  return `${min} ${hour} * * ${dow}`;
      case 'monthly': return `${min} ${hour} ${day} * *`;
      default:        return `${min} ${hour} ${day} ${month} *`;
    }
  }

  async send(id) {
    const entry = this.messages.find(m => m.id === id);
    if (!entry || entry.status === 'cancelled') return;

    try {
      await this.wa.sendMessage(entry.phone, entry.message);
      entry.lastSent = new Date().toISOString();
      entry.sendCount++;
      if (entry.repeat === 'none') {
        entry.status = 'sent';
        this.jobs.delete(id);
      } else {
        entry.status = 'active';
      }
      this.saveMessages();
      this.broadcastMessages();
      this.io.emit('message_sent', { id, phone: entry.phone });
      console.log(`✅ Message sent to ${entry.phone}`);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err.message;
      this.saveMessages();
      this.broadcastMessages();
      console.error(`❌ Failed to send to ${entry.phone}:`, err.message);
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (job) {
      if (job.type === 'timeout') clearTimeout(job.handle);
      if (job.type === 'cron') job.handle.stop();
      this.jobs.delete(id);
    }
    const entry = this.messages.find(m => m.id === id);
    if (entry) {
      entry.status = 'cancelled';
      this.saveMessages();
      this.broadcastMessages();
    }
  }

  delete(id) {
    this.cancel(id);
    this.messages = this.messages.filter(m => m.id !== id);
    this.saveMessages();
    this.broadcastMessages();
  }

  getAll() {
    return [...this.messages].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  updateStatus(id, status, error = null) {
    const entry = this.messages.find(m => m.id === id);
    if (entry) {
      entry.status = status;
      if (error) entry.error = error;
      this.saveMessages();
      this.broadcastMessages();
    }
  }

  restoreJobs() {
    for (const entry of this.messages) {
      if (entry.status === 'pending' || entry.status === 'active') {
        this.createJob(entry);
      }
    }
  }

  broadcastMessages() {
    this.io.emit('messages_update', this.getAll());
  }
}

module.exports = Scheduler;
