import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { ApiError } from '../lib/api';
import { GOOGLE_WEB_CLIENT_ID } from '../lib/config';
import { useSession } from '../lib/session';
import { R } from '../lib/theme';

// The web app uses Google Identity Services: Google draws its own "Continue with Google" button, and the credential it
// hands back is an ID token for our web client id, the same audience the Android app's token has. On the sign-in screen
// it also asks for Google's One Tap card, through FedCM where the browser has it.
declare global { interface Window { google?: any } }

let gis: Promise<any> | null = null;
function loadGis(): Promise<any> {
  gis ??= new Promise((ok, no) => {
    if (window.google?.accounts?.id) return ok(window.google);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => (window.google?.accounts?.id ? ok(window.google) : no(new Error('gis')));
    s.onerror = () => { gis = null; no(new Error('gis')); };   // blocked or offline: try again next mount
    document.head.appendChild(s);
  });
  return gis;
}

// Google's "large" button is 40px tall and at most 400px wide; the welcome screen caps the email button to match.
const GIS_MAX = 400;
const GIS_HEIGHT = 40;

// GIS keeps one callback per page, so it forwards to whichever button is on screen. The One Tap card ("Continue as
// <name>", top right) hands its credential to the same callback, so both go through onToken the same way.
let deliver: ((credential: string) => void) | null = null;
let initialized = false;
// One Tap is asked for once per page load. Google itself stops showing it for a while after a visitor closes it.
let prompted = false;

/** `prominent`: the welcome screen's main button (since 1.4.4), Google's own filled_black theme instead of the outline. */
export function GoogleButton({ onToken, onError, disabled, style, prominent }: {
  onToken: (idToken: string) => Promise<void>; onError: (e: unknown) => void; disabled?: boolean; style?: ViewStyle; prominent?: boolean;
}) {
  const box = useRef<View>(null);
  // Google draws its button at a fixed pixel width (200-400), so it is sized from our container and redrawn, debounced,
  // when the window resizes. The stand-in below uses the same width and height, so nothing moves when Google's arrives.
  const [width, setWidth] = useState(0);
  const resize = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLayout = (w: number) => {
    const next = Math.max(200, Math.min(GIS_MAX, Math.floor(w)));
    if (resize.current) clearTimeout(resize.current);
    if (!width) setWidth(next);   // first measurement: draw straight away
    else resize.current = setTimeout(() => setWidth(next), 200);
  };
  useEffect(() => () => { if (resize.current) clearTimeout(resize.current); }, []);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    deliver = async credential => {
      setBusy(true);
      try { await onToken(credential); } catch (e) { onError(e); } finally { setBusy(false); }
    };
    return () => { deliver = null; };
  }, [onToken, onError]);

  useEffect(() => {
    if (!width) return;
    let live = true;
    loadGis().then(google => {
      if (!live) return;
      if (!initialized) {
        google.accounts.id.initialize({
          client_id: GOOGLE_WEB_CLIENT_ID, callback: (r: { credential?: string }) => { if (r.credential) deliver?.(r.credential); },
          ux_mode: 'popup', auto_select: false, context: 'signin', itp_support: true, use_fedcm_for_button: true,
          use_fedcm_for_prompt: true,
        });
        initialized = true;
      }
      const el = box.current as unknown as HTMLElement;
      el.innerHTML = '';
      google.accounts.id.renderButton(el, {
        type: 'standard', theme: prominent ? 'filled_black' : 'outline', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'center',
        width,
      });
      setState('ready');
      // The welcome screen can flash for a signed-in visitor while their profile loads, so check the session first.
      // auto_select stays off: the card always waits for a tap.
      if (!prompted && !useSession.getState().tokens) {
        prompted = true;
        try { google.accounts.id.prompt(); } catch { /* the button still works without the card */ }
      }
    }).catch(() => { if (live) setState('failed'); });
    return () => { live = false; };
  }, [width, prominent]);

  // Leaving the sign-in screen (signed in, or gone elsewhere) closes the card.
  useEffect(() => () => { window.google?.accounts?.id?.cancel?.(); }, []);
  // Signing in by email does not always unmount this screen (code.tsx replaces only the top of the auth stack on the
  // way to onboarding), so close the card as soon as there is a session. Otherwise a tap on it would swap the new
  // account for a Google one.
  const signedIn = useSession(s => !!s.tokens);
  useEffect(() => { if (signedIn) window.google?.accounts?.id?.cancel?.(); }, [signedIn]);

  return (
    <View style={[{ height: GIS_HEIGHT, justifyContent: 'center', alignItems: 'center', opacity: disabled ? 0.45 : 1 }, style]} pointerEvents={disabled || busy ? 'none' : 'auto'}
      onLayout={e => onLayout(e.nativeEvent.layout.width)}>
      <View ref={box} style={{ width: width || '100%', height: GIS_HEIGHT, alignItems: 'center', justifyContent: 'center', display: state === 'ready' && !busy ? 'flex' : 'none' }} />
      {busy ? <ActivityIndicator color={prominent ? '#131314' : '#1F1F1F'} /> : null}
      {/* Until Google's button arrives, and if its script is blocked (content blocker, offline), a look-alike keeps the
          layout still; pressed after a failure it says why Google can't be used. */}
      {state !== 'ready' && !busy ? (
        <Pressable onPress={() => { if (state === 'failed') onError(new ApiError(0, 'google_unavailable')); }} accessibilityRole="button" accessibilityLabel="Continue with Google"
          style={{ width: width || '100%', height: GIS_HEIGHT, borderRadius: R.pill, borderWidth: 1, borderColor: prominent ? '#8E918F' : '#DADCE0', backgroundColor: prominent ? '#131314' : '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <Image source={require('../../assets/images/google-g.png')} style={{ width: 18, height: 18 }} contentFit="contain" />
          <Text style={{ color: prominent ? '#E3E3E3' : '#1F1F1F', fontSize: 14, fontWeight: '500', fontFamily: 'Roboto, Arial, sans-serif' }}>Continue with Google</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
