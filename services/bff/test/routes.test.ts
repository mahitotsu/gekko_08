import { describe, expect, it } from 'vitest';
import { PURPOSES } from '../authz';
import { INVALID, resolveRoute } from '../src/routes';

/** bffの経路の単体テスト。目的は経路ごとにbffが決め、ブラウザからは受け取らないこと（FR-6）を確かめる */
describe('resolveRoute', () => {
  it('経路ごとに、目的、最初のホップ、scopeを決める', () => {
    expect(resolveRoute('GET', '/api/cases/C-1001/summary', {})).toMatchObject({
      name: 'case-summary', purpose: PURPOSES.caseSummary, target: 'case-service', scope: 'case:summary', body: { action: 'summary', caseId: 'C-1001' },
    });
    expect(resolveRoute('POST', '/api/cases/C-1001/unfreeze', {})).toMatchObject({
      name: 'case-unfreeze', purpose: PURPOSES.accountUnfreeze, scope: 'case:unfreeze',
    });
    expect(resolveRoute('POST', '/api/agent', { caseId: 'C-1001' })).toMatchObject({
      name: 'agent', purpose: PURPOSES.agentAnalysis, target: 'fraud-agent', scope: 'agent:analyze', body: { caseId: 'C-1001' },
    });
    expect(resolveRoute('GET', '/api/audit/requests/0b7c2b3e-4a5f-4e8a-9c1d-2f3e4a5b6c7d', {})).toMatchObject({
      name: 'audit-reconcile', purpose: PURPOSES.audit, auditTarget: '0b7c2b3e-4a5f-4e8a-9c1d-2f3e4a5b6c7d',
    });
  });

  it('本文で目的やユーザーを指定しても、最初のホップへの本文には入らない', () => {
    const route = resolveRoute('POST', '/api/agent', { caseId: 'C-1001', purpose: PURPOSES.accountUnfreeze, user: 'yamada' });
    expect(route).toMatchObject({ purpose: PURPOSES.agentAnalysis, body: { caseId: 'C-1001' } });
    expect((route as { body: Record<string, unknown> }).body).toEqual({ caseId: 'C-1001' });
  });

  it('凍結の解除の目的は、解除の経路でだけ刻む', () => {
    const purposes = [
      resolveRoute('GET', '/api/me', {}), resolveRoute('GET', '/api/cases/C-1/summary', {}), resolveRoute('POST', '/api/agent', { caseId: 'C-1' }),
      resolveRoute('GET', '/api/audit/requests', {}),
    ].map((r) => (r as { purpose: string }).purpose);
    expect(purposes).not.toContain(PURPOSES.accountUnfreeze);
  });

  it('エージェントの経路で案件IDが不正なら、経路は合っているが不正（400）とする', () => {
    expect(resolveRoute('POST', '/api/agent', {})).toBe(INVALID);
    expect(resolveRoute('POST', '/api/agent', { caseId: '../x' })).toBe(INVALID);
    expect(resolveRoute('POST', '/api/agent', undefined)).toBe(INVALID);
  });

  it('どの経路にも当たらなければundefined（404）', () => {
    expect(resolveRoute('GET', '/api/agent', {})).toBeUndefined();
    expect(resolveRoute('POST', '/api/cases/C-1001/summary', {})).toBeUndefined();
    expect(resolveRoute('GET', '/api/cases/../summary', {})).toBeUndefined();
  });
});
