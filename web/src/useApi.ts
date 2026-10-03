import { useEffect, useState } from 'react';
import { get, type ApiResult } from './api';

/**
 * bffのGETの経路を読み、結果と、読み直す関数を返す。Reactの文書の、Effectでデータを取得するときの書き方に従い、
 * 経路が変わったあとに届いた古い応答は捨てる
 */
export function useApi<T>(path: string): { result?: ApiResult<T>; loading: boolean; reload: () => void } {
  // 読み直すたびに増やす。経路と合わせて、どの読み込みの結果かを見分ける
  const [version, setVersion] = useState(0);
  const key = `${version}:${path}`;
  const [loaded, setLoaded] = useState<{ key: string; result: ApiResult<T> }>();

  useEffect(() => {
    let ignore = false;
    get<T>(path).then(
      (result) => { if (!ignore) setLoaded({ key, result }); },
      // 通信できなかったときは、ステータス0として見せる
      (e: unknown) => { if (!ignore) setLoaded({ key, result: { status: 0, body: { error: e instanceof Error ? e.message : String(e) } as T } }); },
    );
    return () => { ignore = true; };
  }, [key, path]);

  return { result: loaded?.result, loading: loaded?.key !== key, reload: () => setVersion((v) => v + 1) };
}
