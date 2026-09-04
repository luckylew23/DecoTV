/**
 * 弹弹play / 托管弹幕中继的「无 Node 依赖」共享定义。
 *
 * 单独拆出来是因为 `src/proxy.ts`（中间件，Edge 运行时）也需要判断中继请求，
 * 而 `src/lib/dandanplay.ts` 顶部 import 了 node:crypto，无法在 Edge 中加载。
 */

export const DANDANPLAY_RELAY_REQUEST_HEADER = 'x-decotv-dandanplay-relay';

/** 允许免鉴权转发的中继端点（弹幕接口及其子路由，均为只读） */
export const DANDANPLAY_RELAY_PATH_PREFIX = '/api/danmu-external';

/** 本实例是否对外提供弹幕中继服务（默认开启，设为 false 关闭） */
export function isDandanplayPublicRelayEnabled(): boolean {
  return process.env.DANDANPLAY_PUBLIC_RELAY_ENABLED !== 'false';
}

/** 判断请求是否带有中继标记头 */
export function isDandanplayRelayRequest(request: Request): boolean {
  return request.headers.get(DANDANPLAY_RELAY_REQUEST_HEADER) === '1';
}

/** 判断路径是否为允许免鉴权中继的端点（弹幕接口及其子路由） */
export function isDandanplayRelayPath(pathname: string): boolean {
  return (
    pathname === DANDANPLAY_RELAY_PATH_PREFIX ||
    pathname.startsWith(`${DANDANPLAY_RELAY_PATH_PREFIX}/`)
  );
}
