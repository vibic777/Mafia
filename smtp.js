'use strict';

const net = require('node:net');
const tls = require('node:tls');

function smtpSend(settings, recipient, subject, text) {
  return new Promise((resolve, reject) => {
    let socket;
    let buffer = '';
    let waiting = null;
    let closed = false;
    const timeout = setTimeout(() => finish(new Error('Истекло время ожидания SMTP')), 15_000);
    function finish(error) {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (socket) socket.destroy();
      error ? reject(error) : resolve();
    }
    function attach(stream) {
      socket = stream;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          if (/^\d{3} /.test(line) && waiting) {
            const callback = waiting; waiting = null; callback(null, Number(line.slice(0, 3)));
          }
        }
      });
      socket.on('error', finish);
      socket.on('close', () => { if (!closed) finish(new Error('SMTP-соединение закрыто')); });
    }
    function command(value, expected) {
      return new Promise((res, rej) => {
        waiting = (error, code) => error ? rej(error) : expected.includes(code) ? res(code) : rej(new Error(`SMTP вернул код ${code}`));
        socket.write(`${value}\r\n`);
      });
    }
    async function run() {
      attach(settings.encryption === 'ssl'
        ? tls.connect({ host: settings.host, port: settings.port, servername: settings.host })
        : net.connect({ host: settings.host, port: settings.port }));
      await new Promise((res, rej) => { waiting = (error, code) => error ? rej(error) : code === 220 ? res() : rej(new Error(`SMTP приветствие: ${code}`)); });
      await command('EHLO mafia.local', [250]);
      if (settings.encryption === 'starttls') {
        await command('STARTTLS', [220]);
        const plain = socket;
        plain.removeAllListeners();
        attach(tls.connect({ socket: plain, servername: settings.host }));
        await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
        await command('EHLO mafia.local', [250]);
      }
      if (settings.username) await command(`AUTH PLAIN ${Buffer.from(`\0${settings.username}\0${settings.password}`).toString('base64')}`, [235]);
      await command(`MAIL FROM:<${settings.from}>`, [250]);
      await command(`RCPT TO:<${recipient}>`, [250, 251]);
      await command('DATA', [354]);
      const safeSubject = String(subject).replace(/[\r\n]/g, ' ');
      const message = `From: <${settings.from}>\r\nTo: <${recipient}>\r\nSubject: ${safeSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.`;
      await command(message, [250]);
      await command('QUIT', [221]);
      finish();
    }
    run().catch(finish);
  });
}

module.exports = { smtpSend };
