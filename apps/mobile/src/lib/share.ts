import { Alert, Platform, Share } from 'react-native';

// Same links as the emails: the web app opens them, and on Android they hand off to the app.
export const SITE = 'https://tablamigo.hookstep.in';
export const planLink = (id: string) => `${SITE}/app/activity/${id}`;
// A shared moment: a public, read-only page in the web app (the site itself has no /m page). Safety links come from the API.
export const momentLink = (id: string) => `${SITE}/app/m/${id}`;

/** Opens the share sheet. Returns 'copied' when the browser has no share sheet and the link went to the clipboard instead. */
export async function shareLink(message: string, url: string): Promise<'shared' | 'copied' | 'failed'> {
  if (Platform.OS === 'web') {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) { try { await nav.share({ text: message, url }); return 'shared'; } catch { return 'failed'; } }
    try { await nav?.clipboard?.writeText(`${message} ${url}`); return 'copied'; } catch { return 'failed'; }
  }
  try { await Share.share({ message: `${message} ${url}` }); return 'shared'; } catch { return 'failed'; }
}

// Inviting a friend. Android friends get the Play listing, tagged so installs from invites show up under utm_source=invite in
// Play Console; anyone else (iPhone, a computer) gets the website, where the web app opens in the browser.
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.tablamigo.app';
export const INVITE_PLAY_URL = `${PLAY_URL}&referrer=utm_source%3Dinvite%26utm_medium%3Dapp`;
export const INVITE_WEB_URL = `${SITE}/?utm_source=invite&utm_medium=app`;
export const INVITE_MESSAGE = `I'm meeting other travelers on Tablamigo. Get it on Google Play: ${INVITE_PLAY_URL}\n\nOn an iPhone or a computer, open it in your browser: ${INVITE_WEB_URL}`;

/**
 * The invite with the person's own link (GET /me/referral, the website's /invite?code= page): installs and sign-ups through it are
 * credited to them and both get the invite days. Without a personal link (signed out, offline) it is the generic message above.
 */
export const personalInviteMessage = (link: string, rewardDays: number) =>
  `I'm meeting other travelers on Tablamigo. Join with my link and we both get ${rewardDays} days of Tablamigo Plus: ${link}`;

/**
 * Opens the share sheet with the invite. A browser without a share sheet copies it instead ('copied'). If the phone can't open a
 * share sheet at all, the link is shown so it can still be sent by hand.
 */
export async function shareInvite(personal?: { link: string; rewardDays: number } | null): Promise<'shared' | 'copied' | 'failed'> {
  const message = personal?.link ? personalInviteMessage(personal.link, personal.rewardDays) : INVITE_MESSAGE;
  const fallback = personal?.link ?? INVITE_WEB_URL;
  if (Platform.OS === 'web') {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) { try { await nav.share({ text: message }); return 'shared'; } catch { return 'failed'; } }
    try { await nav?.clipboard?.writeText(message); return 'copied'; } catch { return 'failed'; }
  }
  try { await Share.share({ message }); return 'shared'; }
  catch { Alert.alert('Invite a friend', `We couldn't open the share sheet. Send them this link: ${fallback}`); return 'failed'; }
}
