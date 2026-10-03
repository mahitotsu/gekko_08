import { PURPOSES } from '../authz';

// ブラウザからのリクエストを、最初のホップの呼び出しに対応づける。ブラウザから受け取るのは案件IDと監査対象のリクエストIDだけで、
// ユーザーの情報も目的も受け取らない。目的は経路ごとにbffが決める

export interface HopRoute {
  name: string;
  /** リクエストの目的。bffが経路ごとに決める */
  purpose: string;
  target: string;
  /** 最初のホップに付けるscope */
  scope: string;
  body: Record<string, unknown>;
  /** 監査のログに出す、経路のパスから得た値（表示用） */
  caseId?: string;
  auditTarget?: string;
}

/** 経路は合っているが、パラメーターが不正 */
export const INVALID = 'invalid';

const ID = /^[\w-]{1,64}$/;
const CASE_SUMMARY = /^\/api\/cases\/([\w-]{1,64})\/summary$/;
const CASE_UNFREEZE = /^\/api\/cases\/([\w-]{1,64})\/unfreeze$/;
const AUDIT_REQUEST = /^\/api\/audit\/requests\/([0-9a-f-]{36})$/;

/**
 * 経路を決める。どの経路にも当たらなければundefined。bodyは、本文をJSONのオブジェクトとして読んだもの（読めなければundefined）
 */
export function resolveRoute(method: string, path: string, body: Record<string, unknown> | undefined): HopRoute | typeof INVALID | undefined {
  if (method === 'GET' && path === '/api/me') {
    return { name: 'me', purpose: PURPOSES.profile, target: 'entitlement-service', scope: 'entitlements:read', body: {} };
  }
  const summary = method === 'GET' ? CASE_SUMMARY.exec(path)?.[1] : undefined;
  if (summary) {
    return { name: 'case-summary', purpose: PURPOSES.caseSummary, target: 'case-service', scope: 'case:summary', body: { action: 'summary', caseId: summary }, caseId: summary };
  }
  // 凍結の解除は、この経路でだけ目的`account-unfreeze`を刻む。エージェントのリクエストからは解除のscopeを発行できない
  const unfreeze = method === 'POST' ? CASE_UNFREEZE.exec(path)?.[1] : undefined;
  if (unfreeze) {
    return { name: 'case-unfreeze', purpose: PURPOSES.accountUnfreeze, target: 'case-service', scope: 'case:unfreeze', body: { action: 'unfreeze', caseId: unfreeze }, caseId: unfreeze };
  }
  // 監査。監査サービスが、監査の権限（属性サービス）を確かめる
  if (method === 'GET' && path === '/api/audit/requests') {
    return { name: 'audit-list', purpose: PURPOSES.audit, target: 'audit-service', scope: 'audit:read', body: { action: 'list' } };
  }
  const audited = method === 'GET' ? AUDIT_REQUEST.exec(path)?.[1] : undefined;
  if (audited) {
    return { name: 'audit-reconcile', purpose: PURPOSES.audit, target: 'audit-service', scope: 'audit:read', body: { action: 'reconcile', requestId: audited }, auditTarget: audited };
  }
  if (method === 'POST' && path === '/api/agent') {
    const caseId = body?.caseId;
    if (typeof caseId !== 'string' || !ID.test(caseId)) return INVALID;
    return { name: 'agent', purpose: PURPOSES.agentAnalysis, target: 'fraud-agent', scope: 'agent:analyze', body: { caseId }, caseId };
  }
  return undefined;
}
