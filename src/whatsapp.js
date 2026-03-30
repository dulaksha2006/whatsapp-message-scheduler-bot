const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '../auth_info');

class WhatsAppClient {
  constructor(io) {
    this.io = io;
    this.sock = null;
    this.isConnected = false;
    this.qrCode = null;
    this.store = makeInMemoryStore({});
  }

  async initialize() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: ['WhatsApp Scheduler', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.store.bind(this.sock.ev);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = await qrcode.toDataURL(qr);
        this.io.emit('qr', this.qrCode);
        this.io.emit('status', { connected: false, message: 'Scan QR code to connect' });
      }

      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
            : true;

        this.isConnected = false;
        this.io.emit('status', { connected: false, message: 'Disconnected. Reconnecting...' });

        if (shouldReconnect) {
          setTimeout(() => this.initialize(), 3000);
        } else {
          // Logged out - clear auth
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          this.io.emit('status', { connected: false, message: 'Logged out. Please scan QR again.' });
          setTimeout(() => this.initialize(), 1000);
        }
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.qrCode = null;
        const user = this.sock.user;
        this.io.emit('connected', {
          phone: user?.id?.split(':')[0] || 'Unknown',
          name: user?.name || 'WhatsApp User',
        });
        this.io.emit('status', { connected: true, message: 'Connected successfully!' });
        console.log('✅ WhatsApp connected:', user?.id);
      }
    });

    this.sock.ev.on('creds.update', saveCreds);
  }

  async sendMessage(phone, message) {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp not connected');
    }

    // Normalize phone number
    let jid = phone.replace(/[\s\-\(\)\+]/g, '');
    if (!jid.includes('@')) {
      if (!jid.startsWith('94') && !jid.startsWith('1') && jid.length === 10) {
        jid = '94' + jid.slice(1);
      }
      jid = jid + '@s.whatsapp.net';
    }

    await this.sock.sendMessage(jid, { text: message });
    return true;
  }

  getStatus() {
    return {
      connected: this.isConnected,
      qr: this.qrCode,
      phone: this.sock?.user?.id?.split(':')[0] || null,
      name: this.sock?.user?.name || null,
    };
  }

  async logout() {
    if (this.sock) {
      await this.sock.logout();
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    this.isConnected = false;
    this.sock = null;
  }
}

module.exports = WhatsAppClient;
