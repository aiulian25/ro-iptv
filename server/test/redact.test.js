import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceId, safeDiagnostic, requestDiagnostic, sourceHealthDiagnostic } from '../lib/redact.js';
const secret = 'synthetic-provider-secret';
const url = `https://user:${secret}@${secret}.invalid/live/${secret}?token=${secret}`;
for (const value of [url, encodeURIComponent(url), encodeURIComponent(encodeURIComponent(url)), secret, '\u001b[31m'+url]) {
  test('untrusted diagnostic content becomes a fixed safe representation', () => {
    const output = JSON.stringify([safeDiagnostic(new Error(value)), safeDiagnostic({code:value,cause:{code:value},message:value}), sourceId(value), requestDiagnostic({method:'POST',originalUrl:'/api/proxy?url='+value,route:{path:'/api/proxy'}},new Error(value))]);
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(encodeURIComponent(secret)), false);
    assert.equal(output.includes('https://'), false);
  });
}
test('source correlation is stable, distinct and does not expose paths or hostnames', () => {
  assert.equal(sourceId(url), sourceId(url));assert.notEqual(sourceId(url), sourceId(url+'2'));
  assert.match(sourceId(url), /^source-[0-9a-f]{12}$/);assert.equal(sourceId({}), 'source-unknown');
});
test('known reason/status/code remains useful and repeated formatting is idempotent', () => {
  for (const [error,expected] of [[{status:503},'upstream 503'],[{cause:{code:'ENOTFOUND'}},'Network/filesystem ENOTFOUND'],[new Error('refusing a private-network url '+url),'private-network target refused'],[new Error('EPG parsing deadline exceeded '+url),'EPG parsing deadline exceeded'],[new SyntaxError(url),'Invalid input data'],[new Error('Capture failed (exit code 7)'),'Capture failed (exit code 7)']]) {
    assert.equal(safeDiagnostic(error),expected);assert.equal(safeDiagnostic(expected),expected);
  }
});
test('legacy source health is sanitized on read without changing the original record', () => {
  const legacy={url,error:url,ok:false,fetchedAt:'2026-11-04T00:00:00.000Z',channelCount:0};
  const safe=sourceHealthDiagnostic(legacy);assert.equal(JSON.stringify(safe).includes(secret),false);
  assert.equal(safe.sourceId,sourceId(url));assert.equal(legacy.error,url);
  assert.deepEqual(sourceHealthDiagnostic(safe),safe);
});
