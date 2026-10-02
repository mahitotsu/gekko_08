import { LAYER_LABELS, PURPOSE_LABELS, REASONS } from './labels';

export function PurposeChip({ purpose }: { purpose: string }) {
  return (
    <span className="purpose" title="リクエストの目的。bffが入口で刻み、途中のホップは変えられない">
      <span className="purpose-k">目的</span>
      <span className="purpose-v">{PURPOSE_LABELS[purpose] ?? purpose}</span>
      <code>{purpose}</code>
    </span>
  );
}

export function Denial({ reason, compact }: { reason: string; compact?: boolean }) {
  const known = REASONS[reason];
  if (!known) return <span className="denial unknown"><code>{reason}</code></span>;
  return (
    <div className={`denial layer-${known.layer} ${compact ? 'compact' : ''}`}>
      <span className="denial-layer">{LAYER_LABELS[known.layer]}で{known.layer === 'state' ? '止まった' : '拒否'}</span>
      {!compact && <span className="denial-text">{known.text}</span>}
      <code>{reason}</code>
    </div>
  );
}
