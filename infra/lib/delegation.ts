import type { DelegationDefinition } from '@gekko08/authz-context/types';
import type { Bff } from './constructs/bff';
import type { Hop } from './constructs/hop';

/**
 * 委任の範囲の定義（目的の一覧、提供側、利用側）を突き合わせる（設計書§4）。整合していなければ、理由の一覧を返す
 */
export function checkDefinitions(purposes: string[], definitions: DelegationDefinition[]): string[] {
  const errors: string[] = [];
  const byHop = new Map<string, DelegationDefinition>();
  for (const d of definitions) {
    if (byHop.has(d.hop)) errors.push(`${d.hop}: defined more than once`);
    byHop.set(d.hop, d);
  }
  const consumers = new Map<string, string[]>();

  for (const d of definitions) {
    for (const [scope, rule] of Object.entries(d.provides ?? {})) {
      for (const p of rule.purposes ?? []) {
        if (!purposes.includes(p)) errors.push(`${d.hop} provides ${scope} for unknown purpose ${p}`);
      }
      if (rule.purposes?.length === 0) errors.push(`${d.hop} provides ${scope} for no purpose`);
      for (const c of rule.callers ?? []) {
        if (!byHop.has(c)) errors.push(`${d.hop} provides ${scope} to unknown caller ${c}`);
      }
    }
    for (const [target, scopes] of Object.entries(d.consumes ?? {})) {
      const provider = byHop.get(target);
      if (!provider?.provides) {
        errors.push(`${d.hop} consumes ${target}, which provides nothing`);
        continue;
      }
      consumers.set(target, [...(consumers.get(target) ?? []), d.hop]);
      if (scopes.length === 0) errors.push(`${d.hop} consumes ${target} with no scopes`);
      if (new Set(scopes).size !== scopes.length) errors.push(`${d.hop} consumes ${target} with duplicate scopes`);
      for (const scope of scopes) {
        const rule = provider.provides[scope];
        if (!rule) errors.push(`${d.hop} consumes ${target} ${scope}, which ${target} does not provide`);
        else if (rule.callers && !rule.callers.includes(d.hop)) errors.push(`${d.hop} consumes ${target} ${scope}, which ${target} does not allow ${d.hop} to use`);
      }
    }
  }
  for (const d of definitions) {
    if (d.provides && !consumers.has(d.hop)) errors.push(`${d.hop} provides scopes but has no consumers`);
  }
  return errors;
}

/**
 * 委任の範囲の定義を突き合わせ、整合していれば、利用側と提供側の組ごとに`Hop#allowCaller`を呼び、提供側に受信時の照合の設定を渡す。
 * 整合していなければ合成を失敗させる
 */
export function connectHops(purposes: string[], definitions: DelegationDefinition[], nodes: Record<string, Hop | Bff>): void {
  const errors = checkDefinitions(purposes, definitions);
  for (const d of definitions) {
    if (!nodes[d.hop]) errors.push(`${d.hop}: no such hop in the stack`);
    for (const target of Object.keys(d.consumes ?? {})) {
      if (nodes[target] && !('allowCaller' in nodes[target])) errors.push(`${d.hop} consumes ${target}, which is not a hop`);
    }
  }
  if (errors.length > 0) throw new Error(`delegation definitions do not match:\n${errors.join('\n')}`);

  // ここから先は、上の突き合わせを通った定義だけを扱う
  const byHop = new Map(definitions.map((d) => [d.hop, d]));
  const nodeOf = (name: string): Hop | Bff => {
    const node = nodes[name];
    if (!node) throw new Error(`${name}: no such hop in the stack`);
    return node;
  };
  const hopOf = (name: string): Hop => {
    const node = nodeOf(name);
    if (!('allowCaller' in node)) throw new Error(`${name} is not a hop`);
    return node;
  };
  for (const d of definitions) {
    if (d.provides) hopOf(d.hop).provide(d.provides);
  }
  for (const d of definitions) {
    for (const [target, scopes] of Object.entries(d.consumes ?? {})) {
      const provides = byHop.get(target)?.provides ?? {};
      hopOf(target).allowCaller(nodeOf(d.hop).asCaller(), scopes.map((scope) => ({ scope, purposes: provides[scope]?.purposes })));
    }
  }
}
