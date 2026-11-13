import { io, Socket } from 'socket.io-client';
import { API_URL } from './config';
import { useSession } from './session';
import { api } from './api';

// One socket for the whole session. Screens attach their listeners to it and keep them, so it must never be swapped
// for a new one while signed in: the access token refreshes every 30 minutes, and replacing the socket then (as this
// used to on the next keystroke) left every open screen listening to a dead socket, with no live messages.
let socket: Socket | null = null;
let authRetries = 0;

export function getSocket() {
  if (!useSession.getState().tokens?.accessToken) return null;
  if (socket) return socket;
  // auth as a function: every (re)connect sends the current token, not the one from when the socket was made.
  const s = socket = io(API_URL, { path: '/rt', auth: cb => cb({ token: useSession.getState().tokens?.accessToken ?? '' }), transports: ['websocket'] });
  s.on('connect', () => { authRetries = 0; });
  // The server checks the token only when connecting, and does not retry a refused one. If it had expired (the app sat
  // idle, or the network dropped past the 30 minutes), any API call refreshes it; then connect again.
  s.on('connect_error', e => {
    if (e.message !== 'unauthorized' || authRetries >= 3) return;
    authRetries++;
    api('/me').catch(() => {}).finally(() => setTimeout(() => {
      if (socket === s && !s.connected && useSession.getState().tokens) s.connect();
    }, 1000 * authRetries));
  });
  return s;
}

export const closeSocket = () => { socket?.disconnect(); socket = null; authRetries = 0; };

// Signed out (logout, delete, or the session expired): drop the socket so the next account never inherits it.
useSession.subscribe((now, before) => { if (before.tokens && !now.tokens) closeSocket(); });
