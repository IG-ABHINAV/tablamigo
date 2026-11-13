import { api, ApiError } from './api';
import { uploadDirect, toJpeg, imageType } from './upload.web';
import { C } from './theme';

/** Selfie in the pose we ask for; the API compares it with the profile photo automatically.
 *  Camera first: phones open the front camera (capture="user"), computers show the webcam.
 *  Only a computer with no camera at all may pick a file instead. */
export async function shootAndUpload(hint?: string): Promise<string | null> {
  const photo = await (matchMedia('(pointer: coarse)').matches ? pickFile(true) : webcam(hint));
  if (!photo) return null;
  const file = await toJpeg(photo);
  const contentType = imageType(file);
  const { key } = await uploadDirect('avatar', file, contentType); // selfies live under avatar/<uid>/, like native
  return key;
}

// Must run inside the tap (no await before it), or Safari ignores the click.
function pickFile(camera: boolean): Promise<File | null> {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  if (camera) input.setAttribute('capture', 'user');
  return new Promise(resolve => {
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string) => {
  const e = document.createElement(tag); e.style.cssText = css; if (text) e.textContent = text; return e;
};
const btn = (text: string, primary: boolean) => el('button', `height:48px;padding:0 22px;border:0;border-radius:999px;cursor:pointer;font:700 15px PlusJakartaSans_700Bold,system-ui,sans-serif;background:${primary ? C.primary : C.bgSoft};color:${primary ? '#fff' : C.ink}`, text);

/** Webcam overlay. Resolves with a JPEG, or null if cancelled. */
async function webcam(hint?: string): Promise<Blob | null> {
  const stream = await navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false })
    .catch((e: DOMException) => (e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? null : Promise.reject(new ApiError(0, 'camera_needed'))));
  const shade = el('div', `position:fixed;inset:0;z-index:9999;background:${C.overlay};display:flex;align-items:center;justify-content:center;padding:16px`);
  const card = el('div', `background:#fff;border-radius:28px;padding:20px;width:min(460px,100%);display:flex;flex-direction:column;gap:14px;font:500 15px PlusJakartaSans_500Medium,system-ui,sans-serif;color:${C.ink}`);
  const row = el('div', 'display:flex;gap:10px;justify-content:flex-end');
  const cancel = btn('Cancel', false);
  card.append(el('div', 'font:800 20px PlusJakartaSans_800ExtraBold,system-ui,sans-serif', hint ? `Selfie: ${hint.toLowerCase()}` : 'Take your selfie'));
  shade.append(card); document.body.append(shade);
  return new Promise<Blob | null>(resolve => {
    const done = (b: Blob | null) => { stream?.getTracks().forEach(t => t.stop()); shade.remove(); resolve(b); };
    cancel.onclick = () => done(null);
    if (stream) {
      const video = el('video', 'width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:16px;background:#000;transform:scaleX(-1)');
      video.autoplay = true; video.muted = true; video.playsInline = true; video.srcObject = stream;
      const shoot = btn('Take photo', true);
      shoot.onclick = () => {
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        if (!c.width) return;
        c.getContext('2d')!.drawImage(video, 0, 0);
        c.toBlob(b => done(b), 'image/jpeg', 0.85);
      };
      row.append(cancel, shoot);
      card.append(video, el('div', `color:${C.ink2};font-size:13px`, 'Your whole face in the frame'), row);
    } else {
      // No camera on this computer: a recent photo is the only option. It is still matched against the profile photo.
      const choose = btn('Choose a photo', true);
      choose.onclick = async () => { const f = await pickFile(false); if (f) done(f); };
      row.append(cancel, choose);
      card.append(el('div', `color:${C.ink2};line-height:21px`, "We couldn't find a camera on this computer. Choose a clear, recent photo of you doing the pose. It's matched against your profile photo, so it has to be you. Or verify from your phone, where the camera opens directly."), row);
    }
  });
}
