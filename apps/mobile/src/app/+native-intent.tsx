// Android App Links (https://tablamigo.hookstep.in/app/activity/<id> and the other prefixes in app.json) reach the app with
// the web app's /app base still on the path. Strip it so a shared plan opens the plan screen, not an unmatched route.
import { inAppPath } from '../lib/app-links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try { return inAppPath(path); } catch { return path; }
}
