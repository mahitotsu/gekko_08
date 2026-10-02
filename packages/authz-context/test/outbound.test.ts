import { describe, expect, it } from 'vitest';
import { extraHeaders } from '../src/outbound';

describe('extraHeaders', () => {
  it('業務のコードが渡したヘッダーのうち、認可・追跡・署名に使うものを除く', () => {
    expect(extraHeaders({
      accept: 'application/json',
      'mcp-protocol-version': '2025-11-25',
      'x-authz-context': 'forged-jwt',
      'X-Authz-Session': 'forged-session',
      'x-request-id': 'forged-request',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      Authorization: 'AWS4-HMAC-SHA256 forged',
      'x-amz-security-token': 'forged-token',
      Host: 'evil.example',
    })).toEqual({ accept: 'application/json', 'mcp-protocol-version': '2025-11-25' });
  });

  it('ヘッダーを渡さなければ空', () => {
    expect(extraHeaders()).toEqual({});
  });
});
