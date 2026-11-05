// Diagnostics are allowlisted representations, never best-effort masking of
// arbitrary text. Credentials can occur in a hostname, path, query or prose.
import { createHash } from 'node:crypto';
export function sourceId(value) {
  if (typeof value !== 'string' || !value) return 'source-unknown';
  return 'source-' + createHash('sha256').update(value).digest('hex').slice(0, 12);
}
const CODES = new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT','ECONNRESET',
  'EACCES','ENOSPC','ENOENT','ABORT_ERR','ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const MESSAGES = new Set(['Request failed','Request cancelled','Upstream timed out',
  'private-network target refused','Input too large','Invalid URL','Invalid input data',
  'EPG parser busy','EPG parsing deadline exceeded','Unsupported XMLTV declaration',
  'Capture process unavailable','Recording input refused or unavailable','Recording input stalled',
  'Capture required a forced stop','Capture was interrupted','AAC audio could not be copied into MP4',
  'Media could not be written to MP4','Recording input timed out','Capture produced no data',
  'Recording capacity reached','Failed to start recording','Failed to start scheduled recording',
  'Invalid stored recording schedule','Scheduled channel is unavailable or ambiguous']);
export function safeDiagnostic(error) {
  const status = error?.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `upstream ${status}`;
  for (const code of [error?.code, error?.cause?.code]) {
    if (CODES.has(code)) return `Network/filesystem ${code}`;
  }
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  if (MESSAGES.has(message)) return message;
  if (/^Network\/filesystem [A-Z0-9_]+$/.test(message) && CODES.has(message.split(' ')[1])) return message;
  if (/^Capture failed \(exit code (?:\d{1,3}|unknown)\)$/.test(message)) return message;
  const text = message.slice(0, 2048);
  const upstream = text.match(/\bupstream ([45]\d\d)\b/i);
  if (upstream) return `upstream ${upstream[1]}`;
  if (/private-network|private.network url/i.test(text)) return 'private-network target refused';
  if (/too large|maxOutputLength/i.test(text)) return 'Input too large';
  if (/invalid url/i.test(text)) return 'Invalid URL';
  if (/parser busy/i.test(text)) return 'EPG parser busy';
  if (/parsing deadline/i.test(text)) return 'EPG parsing deadline exceeded';
  if (/Unsupported XMLTV DTD/i.test(text)) return 'Unsupported XMLTV declaration';
  if (error?.name === 'TimeoutError' || /timed out/i.test(text)) return 'Upstream timed out';
  if (error?.name === 'AbortError') return 'Request cancelled';
  if (error?.name === 'SyntaxError') return 'Invalid input data';
  return 'Request failed';
}

export function requestDiagnostic(req, error) {
  const method = ['GET','HEAD','POST','PUT','DELETE','PATCH','OPTIONS'].includes(req.method) ? req.method : 'OTHER';
  return {
    method,
    // Express supplies this registered template, never interpolate req.path or
    // originalUrl (which can contain even multiply-encoded provider URLs).
    route: typeof req.route?.path === 'string' ? req.route.path : 'unmatched API',
    sourceId: sourceId(req.query?.url || req.body?.url || req.originalUrl),
    error: safeDiagnostic(error),
  };
}
export function sourceHealthDiagnostic(entry) {
  const stamp = Date.parse(entry.fetchedAt);
  return {
    sourceId: /^source-(?:[a-f0-9]{12}|unknown)$/.test(entry.sourceId || '') ? entry.sourceId : sourceId(entry.url), ok: !!entry.ok,
    error: entry.error ? safeDiagnostic(entry.error) : '',
    fetchedAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null,
    channelCount: Number.isSafeInteger(entry.channelCount) && entry.channelCount >= 0 ? entry.channelCount : 0,
  };
}
