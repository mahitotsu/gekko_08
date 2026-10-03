import type { DelegationDefinition } from '@gekko08/authz-context/types';
import { describe, expect, it } from 'vitest';
import { DELEGATION_DEFINITIONS } from '../lib/app-stack';
import { checkDefinitions } from '../lib/delegation';
import { PURPOSES } from '@gekko08/bff/authz';

/** 委任の範囲の定義（目的の一覧、提供側、利用側）の突き合わせ（設計書§4） */

const PURPOSE_LIST = ['p-read', 'p-write'];
// 利用側（entry）→ 中継（api）→ 提供側（store）の3つ
const valid = (): [DelegationDefinition, DelegationDefinition, DelegationDefinition] => [
  { hop: 'entry', consumes: { api: ['api:read', 'api:write'] } },
  { hop: 'api', provides: { 'api:read': {}, 'api:write': { purposes: ['p-write'], callers: ['entry'] } }, consumes: { store: ['store:get'] } },
  { hop: 'store', provides: { 'store:get': {} } },
];

describe('checkDefinitions', () => {
  it('整合している定義は通る', () => {
    expect(checkDefinitions(PURPOSE_LIST, valid())).toEqual([]);
  });

  it('参照実装の定義は整合している', () => {
    expect(checkDefinitions(Object.values(PURPOSES), DELEGATION_DEFINITIONS)).toEqual([]);
  });

  it('参照実装で目的に縛るのは、凍結の解除の2つのscopeだけ', () => {
    const bound = DELEGATION_DEFINITIONS.flatMap((d) => Object.entries(d.provides ?? {}).filter(([, r]) => r.purposes).map(([s, r]) => [d.hop, s, r]));
    expect(bound).toEqual([
      ['case-service', 'case:unfreeze', { purposes: ['account-unfreeze'] }],
      ['account-service', 'account:unfreeze', { purposes: ['account-unfreeze'], callers: ['case-service'] }],
    ]);
  });

  const broken: [string, (d: DelegationDefinition[]) => void, RegExp][] = [
    ['提供側にないscopeを求める', (d) => { d[0]!.consumes!.api!.push('api:delete'); }, /does not provide/],
    ['目的の一覧にない目的を名指しする', (d) => { d[1]!.provides!['api:write']!.purposes = ['p-admin']; }, /unknown purpose p-admin/],
    ['何も提供しないホップを呼ぶ', (d) => { d[2]!.consumes = { entry: ['entry:x'] }; }, /provides nothing/],
    ['利用側のいない提供側', (d) => { d[0]!.consumes = { api: ['api:read'] }; d[1]!.consumes = {}; }, /store provides scopes but has no consumers/],
    ['同じホップを2回定義する', (d) => { d.push({ hop: 'store', provides: { 'store:get': {} } }); }, /defined more than once/],
    ['空のscopeの一覧', (d) => { d[0]!.consumes!.api = []; }, /no scopes/],
    ['目的の制限を空にする', (d) => { d[1]!.provides!['api:write']!.purposes = []; }, /for no purpose/],
  ];

  it.each(broken)('%s → 失敗する', (_name, mutate, message) => {
    const d = valid();
    mutate(d);
    const errors = checkDefinitions(PURPOSE_LIST, d);
    expect(errors.join('\n')).toMatch(message);
  });

  it('呼び出し元の制限があるscopeを、許されていない利用側が求めると失敗する', () => {
    const d = valid();
    d.push({ hop: 'other', consumes: { api: ['api:write'] } });
    expect(checkDefinitions(PURPOSE_LIST, d)).toEqual(['other consumes api api:write, which api does not allow other to use']);
  });
});
