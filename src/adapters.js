// Outbound adapters: who gets told, and what touches the machine.
// Real and mock versions share one interface so the sandbox can never reach the real ones.

// Notifier interface: async-free send({ user, issue, text }) -> { status, note }
class InAppNotifier {
  channel = 'in_app';
  send() { return { status: 'delivered', note: 'Shown in the person\'s inbox' }; }   // the stored notification row is the inbox
}

class TelegramNotifier {
  channel = 'telegram';
  constructor(token = process.env.TELEGRAM_BOT_TOKEN) { this.token = token; }
  send({ user, text }) {
    if (!this.token) return { status: 'not_sent', note: 'No Telegram bot token configured; message recorded only' };
    if (!user.telegram_id) return { status: 'not_sent', note: 'This person has no Telegram chat id' };
    fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: user.telegram_id, text }) }).catch(() => {});
    return { status: 'sent', note: 'Handed to Telegram' };
  }
}

class MockNotifier {
  constructor(channel = 'in_app') { this.channel = channel; this.sent = []; }
  send(msg) { this.sent.push(msg); return { status: 'delivered', note: 'mock' }; }
}

// Actuator interface: execute(kind, machineId) / revert(kind, machineId) -> { ok, note }
// There is no control link to the AP800, so the only implementation is a mock that records the command.
class MockActuator {
  constructor() { this.commands = []; }
  execute(kind, machineId) { this.commands.push({ op: 'execute', kind, machineId, at: Date.now() }); return { ok: true, note: 'Mock actuator: command recorded, no real machine connected' }; }
  revert(kind, machineId) { this.commands.push({ op: 'revert', kind, machineId, at: Date.now() }); return { ok: true, note: 'Mock actuator: revert recorded' }; }
}

module.exports = { InAppNotifier, TelegramNotifier, MockNotifier, MockActuator };
