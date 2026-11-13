/** `detail` is a human sentence for the app to show; without one the app maps `code` to its own copy. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: string, public extra?: Record<string, unknown>) { super(detail ?? code); }
}
export const bad = (code: string, msg?: string) => new HttpError(400, code, msg);
export const forbidden = (code = 'forbidden', msg?: string) => new HttpError(403, code, msg);
export const notFound = (code = 'not_found') => new HttpError(404, code);
export const needsPlus = (feature: string) => new HttpError(402, 'plus_required', undefined, { feature });
/** Voice notes are switched off (config.features.voiceNotes): no audio upload and no voice/audio messages. */
export const voiceNotesOff = () => new HttpError(404, 'voice_notes_unavailable', 'Voice notes are not available yet.');
