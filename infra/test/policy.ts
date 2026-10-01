/**
 * 合成したテンプレートのポリシーを、比べやすい形に直す。
 * 1つの文を（Effect, Principal, Action, Resource, Condition）の組（atom）に分けるので、文のまとめ方や並び順が変わっても結果は変わらない
 */

export type Json = any;

export interface Atom {
  effect: string;
  principal?: string;
  action: string;
  resource?: string;
  condition?: string;
}

const list = (v: Json): Json[] => (v === undefined ? [undefined] : Array.isArray(v) ? v : [v]);

/** 配列の要素の順序をそろえ、文字列にする（条件や組込み関数の比較用） */
export function canonical(v: Json): string {
  const sort = (x: Json): Json => {
    if (Array.isArray(x)) return x.map(sort).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
}

function principals(p: Json): (string | undefined)[] {
  if (p === undefined) return [undefined];
  if (p === '*') return ['*'];
  return Object.entries(p).flatMap(([kind, v]) => list(v).map((x) => `${kind}:${canonical(x)}`));
}

export function atoms(statements: Json[]): Atom[] {
  return statements.flatMap((s) =>
    principals(s.Principal).flatMap((principal) =>
      list(s.Action).flatMap((action) =>
        list(s.Resource).map((resource) => ({
          effect: s.Effect,
          ...(principal !== undefined ? { principal } : {}),
          action,
          ...(resource !== undefined ? { resource: canonical(resource) } : {}),
          ...(s.Condition !== undefined ? { condition: canonical(s.Condition) } : {}),
        })),
      ),
    ),
  );
}

/** atomの集合として比べる。一致すれば空、違えば足りないものと余計なものを返す */
export function diffAtoms(label: string, actual: Atom[], expected: Atom[]): string[] {
  const key = (a: Atom) => canonical(a);
  const a = new Set(actual.map(key));
  const e = new Set(expected.map(key));
  return [
    ...[...e].filter((k) => !a.has(k)).map((k) => `${label}: missing ${k}`),
    ...[...a].filter((k) => !e.has(k)).map((k) => `${label}: unexpected ${k}`),
  ];
}

/** roleに付いている文（インラインのポリシーと、roleを指すAWS::IAM::Policy）をすべて集める */
export function roleStatements(template: Json, roleLogicalId: string): Json[] {
  const resources: Record<string, Json> = template.Resources;
  const inline = (resources[roleLogicalId].Properties.Policies ?? []).flatMap((p: Json) => p.PolicyDocument.Statement);
  const attached = Object.values(resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && (r.Properties.Roles ?? []).some((x: Json) => x.Ref === roleLogicalId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement);
  return [...inline, ...attached];
}
