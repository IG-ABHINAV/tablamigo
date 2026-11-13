// expo-file-system/legacy's native uploader without a phone: records each upload and answers with `state.status`.
export const FileSystemUploadType = { BINARY_CONTENT: 0, MULTIPART: 1 };
export const uploads = [];
export const state = { status: 200 };
export function reset() { uploads.length = 0; state.status = 200; }
export async function uploadAsync(url, uri, opts) { uploads.push({ url, uri, opts }); return { status: state.status, body: '', headers: {} }; }
