import { workload } from './workload';

// 基準：SDKを入れない（@opentelemetry/apiは何もしない）。子プロセスは起動するが、送り先がないので何も送らない
export const handler = async () => {
  const t0 = performance.now();
  const r = await workload('baseline');
  return { variant: 'baseline', ...r, workMs: Math.round(performance.now() - t0) };
};
