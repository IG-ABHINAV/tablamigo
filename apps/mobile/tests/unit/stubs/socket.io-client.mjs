// socket.io-client without a network: every io() call is recorded; tests fire events on the fake sockets.
export const created = [];
class FakeSocket {
  constructor(url, opts) { this.url = url; this.opts = opts; this.handlers = {}; this.connected = false; this.connects = 0; this.disconnected = false; }
  on(event, fn) { (this.handlers[event] ??= []).push(fn); return this; }
  fire(event, ...args) { for (const fn of this.handlers[event] ?? []) fn(...args); }
  connect() { this.connects++; return this; }
  disconnect() { this.disconnected = true; this.connected = false; return this; }
  /** The token the socket would send on its next (re)connect: auth is a callback so it is read fresh each time. */
  currentToken() { let t; this.opts.auth(v => { t = v.token; }); return t; }
}
/** socket.ts imports the Socket type by name; the transform keeps the import, so it must exist. */
export class Socket {}
export function io(url, opts) { const s = new FakeSocket(url, opts); created.push(s); return s; }
