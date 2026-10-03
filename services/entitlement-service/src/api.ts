import type { Call } from '@gekko08/authz-context';

// 属性サービスの応答の型と、呼び出し側の関数。属性サービスを呼ぶホップ（account-service、case-service、audit-service）が使う

/** JWTのsubject本人の、業務上のアクセス権 */
export interface Entitlements {
  userId: string;
  branch: string;
  title: string;
  permissions: string[];
}

/** 業務上のアクセス権を属性サービスから得る。得られなければundefinedを返し、呼び出し側は拒否する（fail closed） */
export async function fetchEntitlements(call: Call): Promise<Entitlements | undefined> {
  const r = await call('entitlement-service', {}, { scope: 'entitlements:read' });
  return r.status === 200 ? (r.body as Entitlements) : undefined;
}
