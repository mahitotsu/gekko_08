// 受信側。呼ばれたら200を返す（入口のIAMを通ったかだけを見る）
export const handler = async () => ({ statusCode: 200, body: 'ok' });
