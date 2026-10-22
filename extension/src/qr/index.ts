// Fullscreen QR code for projecting (popup → "Fullscreen QR").

import QRCode from 'qrcode';
import { effectiveConfig, viewerLink, type Settings } from '../config';

async function main() {
  const pin = new URLSearchParams(location.search).get('pin') ?? '';
  const settings = (await chrome.storage.local.get()) as Settings;
  const link = viewerLink(effectiveConfig(settings).viewerUrl, pin);

  (document.getElementById('pin') as HTMLElement).textContent = pin;
  (document.getElementById('link') as HTMLElement).textContent = link;
  await QRCode.toCanvas(document.getElementById('qr') as HTMLCanvasElement, link, {
    width: 1024,
    margin: 2,
  });
}

void main();
