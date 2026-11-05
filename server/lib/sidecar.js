// One activation contract for guide registration, boot jobs and the exact LAN
// exception. An old URL alone must not enable work after an upgrade.
const flag = process.env.EPG_SIDECAR_ENABLED || '0';
if (!['0', '1'].includes(flag)) throw new Error('EPG_SIDECAR_ENABLED must be 0 or 1');
const url = (process.env.EPG_SIDECAR_URL || '').trim();
if (flag === '1') {
  let valid = false;
  try { valid = ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* rejected below */ }
  if (!valid) throw new Error('EPG_SIDECAR_ENABLED=1 requires a valid HTTP(S) EPG_SIDECAR_URL');
}
export const sidecarUrl = flag === '1' ? url : '';
