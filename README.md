# WhatsApp Message Scheduler

A WhatsApp bot with a web dashboard to schedule and send messages using **Baileys** library.

## Features
- 📱 Scan QR code from browser to connect WhatsApp
- ⏰ Schedule messages to any phone number
- ⚡ Send messages instantly
- 📋 Live dashboard with countdowns
- 💾 Persists scheduled messages across restarts
- 🔄 Auto-reconnects if connection drops

## Requirements
- Node.js 18+
- A WhatsApp account

## Setup

```bash
npm install
npm start
# Open: http://localhost:3000
```

## How to Use

1. Open http://localhost:3000 in your browser
2. Scan the QR code with WhatsApp -> Linked Devices -> Link a Device
3. Fill in the form: phone (with country code, no +), message, schedule time
4. Click Schedule or ⚡ to send immediately

## Phone Format
No + or spaces. Example: 94771234567 (Sri Lanka)

## API
POST /api/schedule  { phone, message, scheduledAt, label }
POST /api/send-now  { phone, message }
DELETE /api/schedule/:id
DELETE /api/history
POST /api/disconnect

## Notes
- Sessions stored in ./sessions/ — delete to re-login
- Messages stored in ./data.json
