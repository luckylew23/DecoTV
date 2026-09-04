import { createHash } from 'crypto';

// 中继相关常量与判断统一放在 dandanplay-shared.ts（Edge 安全，供 proxy.ts 复用），
// 这里保持原有的导出名，调用方无需改动。
export {
  DANDANPLAY_RELAY_REQUEST_HEADER,
  isDandanplayPublicRelayEnabled,
  isDandanplayRelayRequest,
} from './dandanplay-shared';

export const DANDANPLAY_API_BASE = 'https://api.dandanplay.net';
export const DEFAULT_DANDANPLAY_RELAY_ORIGIN = 'https://tv.katelya.eu.org';
export const DANDANPLAY_NOT_CONFIGURED_MESSAGE =
  '弹弹play官方弹幕暂不可用：当前实例未配置有效的服务端凭证，且未启用或无法连接托管中继。Docker 可改用自定义弹幕节点或配置自有凭证。';

export interface DandanplayCredentials {
  appId: string;
  appSecret: string;
}

export function getDandanplayCredentials(): DandanplayCredentials {
  return {
    appId: (process.env.DANDANPLAY_APP_ID || '').trim(),
    appSecret: (process.env.DANDANPLAY_APP_SECRET || '').trim(),
  };
}

/**
 * Non-Docker web deployments use the maintainer-operated DecoTV instance as a
 * relay. The published Docker image sets DOCKER_ENV=true and does not use it
 * implicitly, because public image usage should not consume the maintainer's
 * Vercel Hobby quota.
 */
export function getDandanplayRelayOrigin(): string | null {
  const configured = (process.env.DANDANPLAY_RELAY_URL || '').trim();
  if (/^(disabled|false|off|none)$/i.test(configured)) {
    return null;
  }

  if (!configured && process.env.DOCKER_ENV === 'true') {
    return null;
  }

  const rawOrigin = configured || DEFAULT_DANDANPLAY_RELAY_ORIGIN;

  try {
    const url = new URL(rawOrigin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function buildDandanplayRelayRequestUrl(
  request: Request,
): string | null {
  const relayOrigin = getDandanplayRelayOrigin();
  if (!relayOrigin) {
    return null;
  }

  const inputUrl = new URL(request.url);
  if (inputUrl.origin === relayOrigin) {
    return null;
  }

  return new URL(
    `${inputUrl.pathname}${inputUrl.search}`,
    relayOrigin,
  ).toString();
}

/**
 * Signs a dandanplay API path without placing the AppSecret in the request.
 * The secret must only be read by server-side route handlers.
 */
export function generateDandanplaySignature(
  appId: string,
  appSecret: string,
  path: string,
  timestamp: number,
): string {
  return createHash('sha256')
    .update(appId + timestamp + path + appSecret)
    .digest('base64');
}

export function buildDandanplayHeaders(
  appId: string,
  appSecret: string,
  path: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'DecoTV/1.4',
  };

  if (!appId || !appSecret) return headers;

  headers['X-AppId'] = appId;
  headers['X-Timestamp'] = String(timestamp);
  headers['X-Signature'] = generateDandanplaySignature(
    appId,
    appSecret,
    path,
    timestamp,
  );
  return headers;
}

export function buildDandanplayEpisodeSearchUrl(options: {
  anime?: string;
  tmdbId?: number;
  episode?: number;
}): string {
  const params = new URLSearchParams();
  const anime = options.anime?.trim();

  if (anime) params.set('anime', anime);
  if (options.tmdbId && options.tmdbId > 0) {
    params.set('tmdbId', String(options.tmdbId));
  }
  if (options.episode && options.episode > 0) {
    params.set('episode', String(options.episode));
  }

  return `${DANDANPLAY_API_BASE}/api/v2/search/episodes?${params.toString()}`;
}
