import { Alert, type AlertButton } from 'react-native';
import { create } from 'zustand';

// Service worker: app shell cache and web push. Scoped to the app, not the marketing site.
// Its install precaches every route chunk (~4 MB), so wait for the page's own load to finish first.
if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  const register = () => { navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {}); };
  if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
}

// react-native-web's Alert.alert does nothing; confirmations (delete account, cancel plan) would silently never fire.
Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
  const text = message ? `${title}\n\n${message}` : title;
  const acts = (buttons ?? []).filter(b => b.style !== 'cancel');
  const cancel = (buttons ?? []).find(b => b.style === 'cancel') ?? (acts.length > 1 ? acts[0] : undefined);
  const ok = acts[acts.length - 1];
  if (!buttons || buttons.length < 2) { window.alert(text); ok?.onPress?.(); return; }
  (window.confirm(text) ? ok : cancel)?.onPress?.();
};

type Prompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const HINT = 'tablamigo.iosHintSeen';
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const seen = () => { try { return !!localStorage.getItem(HINT); } catch { return false; } };

const useStore = create<{ prompt: Prompt | null; iosHint: boolean }>(() => ({ prompt: null, iosHint: ios && !standalone() && !seen() }));
// Chrome (Android, desktop) fires this when the app is installable; keep it for our own button.
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); useStore.setState({ prompt: e as Prompt }); });
window.addEventListener('appinstalled', () => useStore.setState({ prompt: null }));

export const useInstall = () => {
  const { prompt, iosHint } = useStore();
  return {
    canInstall: !!prompt && !standalone(),
    // iOS Safari has no install prompt: tell people once how to add it to the home screen.
    iosHint,
    install: async () => { if (!prompt) return; await prompt.prompt(); await prompt.userChoice.catch(() => null); useStore.setState({ prompt: null }); },
    dismissHint: () => { try { localStorage.setItem(HINT, '1'); } catch {} useStore.setState({ iosHint: false }); },
  };
};
