import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode';

export const QR_SIZE_MIN = 120;
export const QR_SIZE_MAX = 400;
export const QR_SIZE_DEFAULT = 220;
export const QR_EC_DEFAULT: QRCodeErrorCorrectionLevel = 'M';

export function clampQrSize(raw: string | null): number {
  // Number(null) is 0, not NaN — a missing ?size= must fall through to the
  // default rather than clamping a phantom 0 up to QR_SIZE_MIN.
  if (raw === null || raw.trim() === '') return QR_SIZE_DEFAULT;
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed)) return QR_SIZE_DEFAULT;
  return Math.min(Math.max(parsed, QR_SIZE_MIN), QR_SIZE_MAX);
}

const EC_LEVELS = new Set(['L', 'M', 'Q', 'H']);

export function parseEcLevel(raw: string | null): QRCodeErrorCorrectionLevel {
  const upper = (raw ?? '').toUpperCase();
  return (EC_LEVELS.has(upper) ? upper : QR_EC_DEFAULT) as QRCodeErrorCorrectionLevel;
}

/**
 * Draws `text` onto `canvas` and reports success — or clears it and reports
 * failure, which covers both an empty string and text too long for a QR
 * symbol at this error-correction level to hold.
 */
export async function renderQr(
  canvas: HTMLCanvasElement,
  text: string,
  size: number,
  ec: QRCodeErrorCorrectionLevel,
): Promise<boolean> {
  if (text === '') {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    return false;
  }
  try {
    await QRCode.toCanvas(canvas, text, { width: size, margin: 1, errorCorrectionLevel: ec });
    return true;
  } catch {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    return false;
  }
}
