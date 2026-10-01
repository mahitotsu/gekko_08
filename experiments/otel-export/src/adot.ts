import { workload } from './workload';

// B. ADOTのレイヤー（AWSOpenTelemetryDistroJs）：SDKと自動計装はレイヤーが入れる（AWS_LAMBDA_EXEC_WRAPPER）。
// 関数は@opentelemetry/apiだけを使う。子プロセスの分を受ける口はない
export const handler = async () => {
  const t0 = performance.now();
  const r = await workload('adot');
  return { variant: 'adot', ...r, workMs: Math.round(performance.now() - t0) };
};
