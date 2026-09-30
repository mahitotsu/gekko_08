import { describe, expect, it } from 'vitest';
import { decodeSession, encodeSession } from '../src/outbound';

describe('session header', () => {
  it('往復できる', () => {
    const c = { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' };
    expect(decodeSession(encodeSession(c))).toEqual(c);
  });

  it('不正な値はセッションなしとして扱う', () => {
    expect(decodeSession(undefined)).toBeUndefined();
    expect(decodeSession('not-base64-json')).toBeUndefined();
    expect(decodeSession(Buffer.from('{"accessKeyId":1}').toString('base64url'))).toBeUndefined();
  });
});
