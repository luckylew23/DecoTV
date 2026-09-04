/* eslint-disable no-console */
import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import {
  buildDandanplayEpisodeSearchUrl,
  buildDandanplayHeaders,
  buildDandanplayRelayRequestUrl,
  DANDANPLAY_NOT_CONFIGURED_MESSAGE,
  DANDANPLAY_RELAY_REQUEST_HEADER,
  getDandanplayCredentials,
  isDandanplayPublicRelayEnabled,
  isDandanplayRelayRequest,
} from '@/lib/dandanplay';

export const runtime = 'nodejs';

const SEARCH_TIMEOUT_MS = 20_000;
const CUSTOM_SEARCH_ANIME_LIMIT = 10;
const OFFICIAL_SEARCH_CACHE_CONTROL =
  'public, max-age=300, s-maxage=7200, stale-while-revalidate=86400';

interface SearchEpisodeItem {
  episodeId: number;
  episodeTitle: string;
}

interface SearchAnimeItem {
  animeId: number;
  animeTitle: string;
  type: string;
  typeDescription?: string;
  imageUrl?: string;
  episodes: SearchEpisodeItem[];
}

interface SearchAnimeBase {
  animeId: number;
  animeTitle: string;
  type: string;
  typeDescription?: string;
  imageUrl?: string;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function formatSearchErrorMessage(prefix: string, err: unknown): string {
  if (err instanceof Error) {
    const lowerMsg = err.message.toLowerCase();
    if (
      err.name === 'TimeoutError' ||
      lowerMsg.includes('aborted due to timeout')
    ) {
      return `${prefix}: 请求超时（${Math.round(SEARCH_TIMEOUT_MS / 1000)}秒）`;
    }
    return `${prefix}: ${err.message}`;
  }
  return `${prefix}: ${String(err)}`;
}

function normalizeEpisodes(value: unknown): SearchEpisodeItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;

      const episodeId = parsePositiveInt(row.episodeId);
      if (!episodeId) return null;

      return {
        episodeId,
        episodeTitle:
          readString(row.episodeTitle) ||
          readString(row.title) ||
          readString(row.name) ||
          readString(row.ep_name) ||
          `episodeId:${episodeId}`,
      };
    })
    .filter((item): item is SearchEpisodeItem => item !== null);
}

function readImageUrl(row: Record<string, unknown>): string | undefined {
  return (
    readString(row.imageUrl) ||
    readString(row.animeImageUrl) ||
    readString(row.cover) ||
    readString(row.poster)
  );
}

function normalizeAnimeBaseList(value: unknown): SearchAnimeBase[] {
  if (!Array.isArray(value)) return [];
  const normalized: SearchAnimeBase[] = [];

  for (const item of value) {
    const row = readRecord(item);
    if (!row) continue;

    const animeId = parsePositiveInt(row.animeId) || parsePositiveInt(row.id);
    if (!animeId) continue;

    const anime: SearchAnimeBase = {
      animeId,
      animeTitle:
        readString(row.animeTitle) ||
        readString(row.title) ||
        readString(row.name) ||
        `animeId:${animeId}`,
      type: readString(row.type) || readString(row.category) || 'unknown',
    };

    const typeDescription =
      readString(row.typeDescription) || readString(row.desc);
    if (typeDescription) {
      anime.typeDescription = typeDescription;
    }

    const imageUrl = readImageUrl(row);
    if (imageUrl) {
      anime.imageUrl = imageUrl;
    }

    normalized.push(anime);
  }

  return normalized;
}

function normalizeAnimes(value: unknown): SearchAnimeItem[] {
  if (!Array.isArray(value)) return [];

  const normalized: SearchAnimeItem[] = [];
  for (const anime of normalizeAnimeBaseList(value)) {
    const row = value.find((raw) => {
      const record = readRecord(raw);
      if (!record) return false;
      const rowAnimeId =
        parsePositiveInt(record.animeId) || parsePositiveInt(record.id);
      return rowAnimeId === anime.animeId;
    });
    const rowRecord = readRecord(row);
    const episodes = normalizeEpisodes(rowRecord?.episodes);
    if (episodes.length === 0) continue;
    normalized.push({ ...anime, episodes });
  }

  return normalized;
}

function normalizeBangumiEpisodes(value: unknown): SearchEpisodeItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const episodeId =
        parsePositiveInt(row.episodeId) ||
        parsePositiveInt(row.id) ||
        parsePositiveInt(row.commentId);
      if (!episodeId) return null;
      return {
        episodeId,
        episodeTitle:
          readString(row.episodeTitle) ||
          readString(row.title) ||
          readString(row.name) ||
          readString(row.ep_name) ||
          `episodeId:${episodeId}`,
      };
    })
    .filter((item): item is SearchEpisodeItem => item !== null);
}

async function searchFromDandanplay(keyword: string) {
  const { appId, appSecret } = getDandanplayCredentials();
  if (!appId || !appSecret) {
    return {
      ok: false,
      status: 503,
      message: DANDANPLAY_NOT_CONFIGURED_MESSAGE,
      animes: [] as SearchAnimeItem[],
    };
  }

  const path = '/api/v2/search/episodes';
  const url = buildDandanplayEpisodeSearchUrl({ anime: keyword });
  const headers = buildDandanplayHeaders(appId, appSecret, path);

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        message: `弹弹play 搜索失败: HTTP ${response.status}`,
        animes: [] as SearchAnimeItem[],
      };
    }

    const data = await response.json();
    if (data?.success === false) {
      return {
        ok: false,
        status: 502,
        message: `弹弹play 搜索返回错误: ${data?.errorMessage || 'unknown'}`,
        animes: [] as SearchAnimeItem[],
      };
    }

    return {
      ok: true,
      status: 200,
      message: '获取成功',
      animes: normalizeAnimes(data?.animes),
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: formatSearchErrorMessage('弹弹play 搜索异常', err),
      animes: [] as SearchAnimeItem[],
    };
  }
}

async function searchFromManagedRelay(request: Request) {
  const relayUrl = buildDandanplayRelayRequestUrl(request);
  if (!relayUrl) {
    return null;
  }

  try {
    const response = await fetch(relayUrl, {
      headers: {
        Accept: 'application/json',
        [DANDANPLAY_RELAY_REQUEST_HEADER]: '1',
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    // 上游中继非 2xx：不要原样透传状态码。
    // 401/403 说明该实例开启了访问鉴权，中继请求（无 cookie）必然被拒，
    // 此时给出可操作的提示而不是把 401 抛给前端。
    if (!response.ok) {
      const isAuthError = response.status === 401 || response.status === 403;
      const message = isAuthError
        ? 'DecoTV 托管弹幕中继要求鉴权，暂时无法搜索弹幕。请配置自有弹弹play凭证（DANDANPLAY_APP_ID / DANDANPLAY_APP_SECRET），或将 DANDANPLAY_RELAY_URL 指向开启了免登录（NEXT_PUBLIC_AUTH_MODE=public）的实例。'
        : `DecoTV 托管弹幕中继不可用: HTTP ${response.status}`;

      if (isAuthError) {
        console.warn(
          '[danmu-relay] 托管弹幕中继拒绝了搜索中继请求: HTTP ' +
            response.status,
        );
      }

      return {
        responseStatus: isAuthError ? 503 : 502,
        headers: {
          'Cache-Control': 'no-store',
          'X-DecoTV-Danmu-Source': 'managed-relay',
        },
        data: {
          code: isAuthError ? 503 : 502,
          message,
          source: 'managed-relay',
          animes: [],
          relayUnauthorized: isAuthError,
        },
      };
    }

    const data = await response.json();

    return {
      responseStatus: response.status,
      headers: {
        'Cache-Control':
          response.headers.get('cache-control') ||
          (response.ok ? OFFICIAL_SEARCH_CACHE_CONTROL : 'no-store'),
        'X-DecoTV-Danmu-Source': 'managed-relay',
      },
      data,
    };
  } catch (err) {
    return {
      responseStatus: 502,
      headers: {
        'Cache-Control': 'no-store',
        'X-DecoTV-Danmu-Source': 'managed-relay',
      },
      data: {
        code: 502,
        message: formatSearchErrorMessage('DecoTV 托管弹幕中继请求失败', err),
        source: 'managed-relay',
        animes: [],
      },
    };
  }
}

async function searchFromCustomServer(
  keyword: string,
  dc: NonNullable<Awaited<ReturnType<typeof getConfig>>['DanmuConfig']>,
) {
  const baseUrl = dc.serverUrl.replace(/\/+$/, '');
  const tokenSegment = dc.token ? `/${dc.token}` : '';
  const serverBase = `${baseUrl}${tokenSegment}`;
  const headers = { Accept: 'application/json' };
  const episodeSearchPaths = [
    `/api/v2/search/episodes?anime=${encodeURIComponent(keyword)}&episode=`,
    `/api/v2/search/episodes?anime=${encodeURIComponent(keyword)}`,
    // 兼容少数非标准实现（官方 danmu_api 仍然使用 anime 参数）
    `/api/v2/search/episodes?keyword=${encodeURIComponent(keyword)}`,
  ];

  let lastErrorMessage: string | null = null;

  for (const path of episodeSearchPaths) {
    try {
      const response = await fetch(`${serverBase}${path}`, {
        headers,
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        lastErrorMessage = `自定义弹幕搜索失败: HTTP ${response.status}`;
        continue;
      }

      const data = await response.json();
      const animes = normalizeAnimes(data?.animes || data?.bangumiList || []);
      if (animes.length > 0) {
        return {
          ok: true,
          status: 200,
          message: '获取成功',
          animes,
        };
      }
    } catch (err) {
      lastErrorMessage = formatSearchErrorMessage('自定义弹幕搜索异常', err);
    }
  }

  // fallback: 某些部署仅暴露 /search/anime，再按 animeId 拉 bangumi 详情拿集数
  try {
    const animeResp = await fetch(
      `${serverBase}/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`,
      {
        headers,
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      },
    );

    if (!animeResp.ok) {
      return {
        ok: false,
        status: 502,
        message:
          lastErrorMessage || `自定义弹幕搜索失败: HTTP ${animeResp.status}`,
        animes: [] as SearchAnimeItem[],
      };
    }

    const animeData = await animeResp.json();
    const animeBases = normalizeAnimeBaseList(
      animeData?.animes || animeData?.bangumiList || [],
    ).slice(0, CUSTOM_SEARCH_ANIME_LIMIT);

    if (animeBases.length === 0) {
      return {
        ok: true,
        status: 200,
        message: '获取成功',
        animes: [] as SearchAnimeItem[],
      };
    }

    const enriched = await Promise.all(
      animeBases.map(async (anime): Promise<SearchAnimeItem | null> => {
        try {
          const bangumiResp = await fetch(
            `${serverBase}/api/v2/bangumi/${anime.animeId}`,
            {
              headers,
              signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
            },
          );
          if (!bangumiResp.ok) return null;
          const bangumiData = await bangumiResp.json();
          const episodes = normalizeBangumiEpisodes(
            bangumiData?.bangumi?.episodes || bangumiData?.episodes,
          );
          if (episodes.length === 0) return null;
          return { ...anime, episodes };
        } catch {
          return null;
        }
      }),
    );

    const animes = enriched.filter(
      (item): item is SearchAnimeItem => item !== null,
    );

    return {
      ok: true,
      status: 200,
      message: '获取成功',
      animes,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message:
        lastErrorMessage || formatSearchErrorMessage('自定义弹幕搜索异常', err),
      animes: [] as SearchAnimeItem[],
    };
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const keyword = (searchParams.get('keyword') || '').trim();
  const isRelayRequest = isDandanplayRelayRequest(request);

  if (isRelayRequest && !isDandanplayPublicRelayEnabled()) {
    return NextResponse.json(
      {
        code: 503,
        message: 'DecoTV 托管弹幕中继已暂停服务',
        source: 'managed-relay',
        keyword,
        animes: [],
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!keyword) {
    return NextResponse.json(
      { code: 400, message: '缺少必要参数: keyword', animes: [] },
      { status: 400 },
    );
  }

  let danmuConfig: Awaited<ReturnType<typeof getConfig>>['DanmuConfig'] =
    undefined;
  if (!isRelayRequest) {
    try {
      const adminConfig = await getConfig();
      danmuConfig = adminConfig.DanmuConfig;
    } catch (err) {
      console.warn(
        '[danmu-search] Failed to read DanmuConfig, fallback to dandanplay:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const customConfig =
    danmuConfig?.enabled === true && !!danmuConfig.serverUrl
      ? (danmuConfig as NonNullable<
          Awaited<ReturnType<typeof getConfig>>['DanmuConfig']
        >)
      : null;

  if (!customConfig && !isRelayRequest) {
    const { appId, appSecret } = getDandanplayCredentials();
    if (!appId || !appSecret) {
      const relayResult = await searchFromManagedRelay(request);
      if (relayResult) {
        return NextResponse.json(relayResult.data, {
          status: relayResult.responseStatus,
          headers: relayResult.headers,
        });
      }
    }
  }

  const searchResult = customConfig
    ? await searchFromCustomServer(keyword, customConfig)
    : await searchFromDandanplay(keyword);

  const source = customConfig ? 'custom-danmu-api' : 'dandanplay';

  if (!searchResult.ok) {
    return NextResponse.json(
      {
        code: searchResult.status,
        message: searchResult.message,
        source,
        keyword,
        animes: [],
      },
      { status: searchResult.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    {
      code: 200,
      message: '获取成功',
      source,
      keyword,
      animes: searchResult.animes,
      count: searchResult.animes.length,
    },
    {
      headers: {
        'Cache-Control': customConfig
          ? 'no-store, max-age=0'
          : OFFICIAL_SEARCH_CACHE_CONTROL,
      },
    },
  );
}
