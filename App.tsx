import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    ActivityIndicator,
    FlatList,
    ListRenderItemInfo,
    LogBox,
    Platform,
    StatusBar,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type {
    FileDownloadEvent,
    ShouldStartLoadRequest,
    WebViewMessageEvent,
    WebViewOpenWindowEvent,
} from 'react-native-webview/lib/WebViewTypes';
import {
    setAudioModeAsync,
    useAudioPlayer,
    useAudioPlayerStatus,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

type Tab = 'browser' | 'library';

interface LocalTrack {
    id: string;
    filename: string;
    uri: string;
    name: string;
}

/** Дополнительные данные о скачиваемой ссылке (приходят со страницы или из навигации). */
interface DownloadMeta {
    referrer?: string;
    cookie?: string;
    userAgent?: string;
    mimeType?: string;
}

interface SaveDownloadedFileOptions {
    title?: string;
    mimeType?: string | null;
    headers?: Record<string, unknown> | null;
    sourceUrl?: string;
    extension?: string;
    contentDisposition?: string;
}

interface BlobTransfer {
    id: string;
    title: string;
    mimeType: string;
    contentDisposition: string;
    chunks: string[];
    received: number;
    size: number;
    lastPercent: number;
}

// Сообщения, которые инжектированные скрипты отправляют из WebView через postMessage.
// Данные приходят со стороннего сайта, поэтому почти все поля необязательные,
// а в коде они по-прежнему проверяются во время выполнения.
type WebViewIncomingMessage =
    | {
    type: 'download';
    url?: string;
    title?: string;
    referrer?: string;
    cookie?: string;
    userAgent?: string;
    mimeType?: string;
}
    | {
    type: 'blobCandidate';
    token?: string;
    title?: string;
    mimeType?: string;
    size?: number;
    contentDisposition?: string;
}
    | { type: 'blobStart'; id: string; title?: string; mimeType?: string; size?: number }
    | { type: 'blobChunk'; id: string; data?: unknown }
    | { type: 'blobEnd'; id: string }
    | { type: 'blobError'; id: string; message?: string }
    | { type: 'downloadIntent'; href?: string; title?: string; sourceUrl?: string }
    | { type: 'notice'; message?: string };

type BlobCandidateMessage = Extract<WebViewIncomingMessage, { type: 'blobCandidate' }>;
type BlobStartMessage = Extract<WebViewIncomingMessage, { type: 'blobStart' }>;
type BlobChunkMessage = Extract<WebViewIncomingMessage, { type: 'blobChunk' }>;
type BlobErrorMessage = Extract<WebViewIncomingMessage, { type: 'blobError' }>;

const AUDIO_EXTENSIONS: readonly string[] = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac'];
const MUSIC_DIR = `${FileSystem.documentDirectory}music/`;

// blob:-ссылки WebView не умеет открывать сам, но приложение перехватывает их
// и сохраняет файл. В dev-сборке это предупреждение закрывало бы экран.
LogBox.ignoreLogs(["Can't open url: blob:"]);

const MIME_AUDIO_EXTENSIONS: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/x-mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/aacp': 'aac',
    'audio/x-aac': 'aac',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/oga': 'oga',
    'audio/opus': 'ogg',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
};

// Известные рекламные/трекерные домены. Список можно расширить позже.
// Не добавляй сюда основной домен сайта, иначе можешь заблокировать сам сайт.
const BLOCKED_AD_DOMAINS: readonly string[] = [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'adservice.google.com',
    'adnxs.com',
    'taboola.com',
    'outbrain.com',
    'popads.net',
    'popcash.net',
    'adsterra.com',
    'adriver.ru',
    'exoclick.com',
    'trafficjunky.net',
];

// Имена последнего сегмента пути, которые обычно означают файл, а не HTML-страницу.
// Нужны для ссылок вида /download.php?id=... и /getfile/123.
const FILE_DOWNLOAD_SEGMENTS: readonly string[] = [
    'download',
    'dl',
    'get',
    'getfile',
    'get_file',
    'file',
    'save',
    'downloadfile',
    'download_file',
];

function isBlockedAdUrl(rawUrl: string): boolean {
    try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.toLowerCase();
        const blockedHost = BLOCKED_AD_DOMAINS.some(
            (domain) => host === domain || host.endsWith(`.${domain}`)
        );
        if (blockedHost) return true;

        // Часть рекламных переходов Google использует такие адреса.
        const googleHost = host === 'google.com' || host.endsWith('.google.com');
        if (googleHost && (/^\/aclk(?:\/|$)/i.test(parsed.pathname) || /^\/pagead\//i.test(parsed.pathname))) {
            return true;
        }
        return false;
    } catch (_error) {
        return false;
    }
}

function getAudioExtension(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);

        // Сначала проверяем расширение самого пути. Не ищем .mp3 в произвольной
        // query-строке: рекламная/промежуточная страница может содержать вложенный
        // URL на MP3 (например, параметр wpdlf=https://site/file.mp3), но сама
        // при этом остаётся HTML-страницей, которую нужно открыть в модальном окне.
        let pathname = parsed.pathname;
        try {
            pathname = decodeURIComponent(pathname);
        } catch (_decodeError) {}
        const pathMatch = pathname.match(/\.([a-z0-9]{2,5})$/i);
        if (pathMatch && AUDIO_EXTENSIONS.includes(pathMatch[1].toLowerCase())) {
            return pathMatch[1].toLowerCase();
        }

        // Поддерживаем обычные filename/file/download параметры, если в них указано
        // простое имя файла. Не разбираем параметры, которые содержат вложенный URL.
        for (const key of ['filename', 'file', 'download', 'name']) {
            const value = parsed.searchParams.get(key);
            if (!value || /^(?:https?:\/\/|blob:|data:)/i.test(value.trim())) continue;
            let decoded = value;
            try {
                decoded = decodeURIComponent(value);
            } catch (_decodeError) {}
            const match = decoded.match(/\.([a-z0-9]{2,5})(?:[?#&]|$)/i);
            if (match && AUDIO_EXTENSIONS.includes(match[1].toLowerCase())) {
                return match[1].toLowerCase();
            }
        }
        return '';
    } catch (_error) {
        return '';
    }
}

function getFileNameFromUrl(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        const named = ['file', 'filename', 'name', 'title', 'song', 'track']
            .map((key) => parsed.searchParams.get(key))
            .find(Boolean);
        const pathname = decodeURIComponent(parsed.pathname);
        const lastPart = pathname.split('/').filter(Boolean).pop() || '';
        const candidate = named || lastPart || 'audio';
        return candidate.replace(/\.[^.]+$/, '') || 'audio';
    } catch (_error) {
        return 'audio';
    }
}

function makeSafeFileName(value: unknown): string {
    return String(value || 'audio')
        .replace(/\.(mp3|m4a|aac|wav|ogg|oga|flac)$/i, '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\u0000-\u001f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90) || 'audio';
}

function cleanTrackTitle(value: unknown): string {
    return String(value || '')
        .replace(/^\s*скачать\s+(?:песню|трек|музыку)?\s*/i, '')
        .replace(/\s+скачать\s+бесплатно.*$/i, '')
        .replace(/\s*[-–—|]\s*(?:скачать|слушать|mp3|музыка).*$/i, '')
        .trim();
}

function isGenericAudioName(value: unknown): boolean {
    const normalized = String(value || '')
        .toLowerCase()
        .replace(/[^a-zа-я0-9]+/gi, '');
    return !normalized || [
        'audio',
        'download',
        'file',
        'track',
        'song',
        'music',
        'mp3',
        'скачать',
        'скачатьпесню',
        'скачатьмузыку',
    ].includes(normalized);
}

function formatFileSize(bytes: unknown): string {
    const size = Number(bytes) || 0;
    if (size < 1024) return '';
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
    return `${Math.round(size / 1024)} КБ`;
}

function getHeaderValue(headers: Record<string, unknown> | null | undefined, name: string): string {
    if (!headers) return '';
    const target = name.toLowerCase();
    const key = Object.keys(headers).find((header) => header.toLowerCase() === target);
    return key ? String(headers[key] || '') : '';
}

function getAudioExtensionFromMime(mimeType: unknown): string {
    const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
    return MIME_AUDIO_EXTENSIONS[normalized] || '';
}

function parseContentDispositionFileName(value: unknown): string {
    const header = String(value || '');
    if (!header) return '';
    let filename = '';
    const encoded = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
    if (encoded) {
        filename = encoded[1].trim().replace(/^["']|["']$/g, '');
        try {
            filename = decodeURIComponent(filename);
        } catch (_error) {}
    }
    if (!filename) {
        const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
        if (plain) filename = plain[1].trim();
    }
    return filename;
}

function getAudioExtensionFromContentDisposition(value: unknown): string {
    const filename = parseContentDispositionFileName(value);
    const match = filename.match(/\.([a-z0-9]{2,5})$/i);
    if (!match) return '';
    const extension = match[1].toLowerCase();
    return AUDIO_EXTENSIONS.includes(extension) ? extension : '';
}

function base64ToBytes(base64: unknown): number[] {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = String(base64 || '').replace(/[^A-Za-z0-9+/]/g, '');
    const bytes: number[] = [];
    for (let index = 0; index < clean.length; index += 4) {
        const chunk = clean.slice(index, index + 4);
        const a = alphabet.indexOf(chunk[0]);
        const b = alphabet.indexOf(chunk[1]);
        const c = chunk.length > 2 ? alphabet.indexOf(chunk[2]) : -1;
        const d = chunk.length > 3 ? alphabet.indexOf(chunk[3]) : -1;
        if (a < 0 || b < 0) continue;
        bytes.push(((a << 2) | (b >> 4)) & 0xff);
        if (c >= 0) bytes.push(((b << 4) | (c >> 2)) & 0xff);
        if (d >= 0) bytes.push(((c << 6) | d) & 0xff);
    }
    return bytes;
}

function getAudioExtensionFromBytes(bytes: number[] | null | undefined): string {
    if (!bytes || bytes.length < 4) return '';
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3';
    if (
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
    ) return 'wav';
    if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'ogg';
    if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return 'flac';
    if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'm4a';
    if (bytes[0] === 0xff && bytes.length > 1 && (bytes[1] & 0xf6) === 0xf0) return 'aac';
    if (bytes[0] === 0xff && bytes.length > 1 && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
    return '';
}

function isLikelyWebResponse(mimeType: unknown): boolean {
    const normalized = String(mimeType || '').toLowerCase();
    return normalized.startsWith('text/')
        || normalized.includes('html')
        || normalized.includes('json')
        || normalized.includes('xml');
}

function isLikelyFileDownloadUrl(rawUrl: string): boolean {
    if (getAudioExtension(rawUrl)) return true;
    try {
        const parsed = new URL(rawUrl);
        const path = parsed.pathname.toLowerCase();
        const search = parsed.search.toLowerCase();
        const lastSegment = path.split('/').filter(Boolean).pop() || '';
        const baseName = lastSegment.replace(/\.[a-z0-9]+$/i, '');
        if (FILE_DOWNLOAD_SEGMENTS.includes(baseName)) return true;
        return /\/(?:download|dl|getfile|get_file|downloadfile|download_file)(?:\/|$)/.test(path)
            || /(?:^|[?&])(?:download|dl|file|filename|save)=/.test(search);
    } catch (_error) {
        return false;
    }
}

async function ensureMusicFolder(): Promise<void> {
    if (!FileSystem.documentDirectory) {
        throw new Error('Не удалось получить внутреннюю папку приложения. Перезапусти приложение.');
    }
    const info = await FileSystem.getInfoAsync(MUSIC_DIR);
    if (!info.exists) {
        await FileSystem.makeDirectoryAsync(MUSIC_DIR, { intermediates: true });
    }
}

function getCurrentTime(): number {
    return Date.now();
}

function getErrorMessage(error: unknown, fallback: string): string {
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const { message } = error as { message?: unknown };
        if (typeof message === 'string' && message) return message;
    }
    return fallback;
}

// Выполняется внутри открытой страницы.
// 1) перехватывает клики по прямым ссылкам на распространённые аудиофайлы;
// 2) переводит обычные ссылки target=_blank в текущую вкладку;
// 3) блокирует известные рекламные iframe и часть рекламных блоков;
// 4) пытается запретить window.open.
// Это не полноценный системный AdBlock и может не поймать рекламу с самого сайта.
const WEB_FILTER_SCRIPT = `
(function () {
  // Этот скрипт назначен и на раннюю, и на обычную инъекцию.
  // Не регистрируем обработчики повторно в одном и том же frame.
  if (window.__MUSIKA_WEB_FILTER_INSTALLED__) return true;
  window.__MUSIKA_WEB_FILTER_INSTALLED__ = true;
  try {
    var audioRe = /\\.(mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#]|$)/i;
    var blockedDomains = ${JSON.stringify(BLOCKED_AD_DOMAINS)};
    var downloadSegments = ${JSON.stringify(FILE_DOWNLOAD_SEGMENTS)};

    function isBlocked(url) {
      try {
        var u = new URL(url, location.href);
        var host = u.hostname.toLowerCase();
        if (blockedDomains.some(function (d) { return host === d || host.endsWith('.' + d); })) return true;
        if ((host === 'google.com' || host.endsWith('.google.com')) &&
            (/^\\/aclk(?:\\/|$)/i.test(u.pathname) || /^\\/pagead\\//i.test(u.pathname))) return true;
      } catch (e) {}
      return false;
    }

    function tellApp(data) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(data)); } catch (e) {}
    }

    function absoluteUrl(rawUrl) {
      try {
        if (rawUrl && String(rawUrl).trim()) {
          return new URL(String(rawUrl), location.href).href;
        }
      } catch (e) {}
      return '';
    }

    function baseHost(host) {
      var parts = String(host || '').toLowerCase().split('.').filter(Boolean);
      return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
    }

    function isSameSite(url) {
      try {
        var target = new URL(url, location.href);
        var targetHost = target.hostname.toLowerCase();
        var currentHost = location.hostname.toLowerCase();
        return targetHost === currentHost
          || targetHost.endsWith('.' + currentHost)
          || currentHost.endsWith('.' + targetHost)
          || baseHost(targetHost) === baseHost(currentHost);
      } catch (e) {
        return false;
      }
    }

    // --- Файлы, которые сайт создаёт внутри браузера (blob/data) или получает POST-запросом ---
    var blobStore = {};
    var announcedBlobUrls = {};
    var lastUserGestureAt = 0;
    // Обновляется, когда обработчик страницы или window.open уже инициировал
    // открытие окна/скачивание. Это не даёт резервному обработчику дублировать действие.
    var lastPopupActivityAt = 0;
    var BLOB_CHUNK_SIZE = 96 * 1024; // кратно 3, чтобы куски base64 склеивались без потерь

    function isWebMime(type) {
      var value = String(type || '').toLowerCase();
      return value.indexOf('text/') === 0
        || value.indexOf('html') !== -1
        || value.indexOf('json') !== -1
        || value.indexOf('xml') !== -1;
    }

    function isProbablyAudio(type) {
      var value = String(type || '').toLowerCase();
      return !value
        || value.indexOf('audio/') === 0
        || value.indexOf('application/octet-stream') === 0
        || value.indexOf('binary/octet-stream') === 0
        || value.indexOf('application/mpeg') === 0;
    }

    function newBlobToken() {
      return 'blob-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    }

    function announcedRecently(url) {
      var at = announcedBlobUrls[url] || 0;
      return Date.now() - at < 10000;
    }

    function rememberBlob(blob, title, contentDisposition) {
      var token = newBlobToken();
      blobStore[token] = {
        blob: blob,
        title: title || document.title || '',
        mimeType: blob.type || '',
        contentDisposition: contentDisposition || ''
      };
      var keys = Object.keys(blobStore);
      while (keys.length > 5) delete blobStore[keys.shift()];
      return token;
    }

    function announceBlob(blob, title, contentDisposition, mimeType) {
      if (!blob || !blob.size) {
        tellApp({ type: 'notice', message: 'Сайт сформировал пустой файл. Попробуй другую ссылку «Скачать».' });
        return;
      }
      var type = String(mimeType || blob.type || '');
      if (isWebMime(type)) {
        tellApp({ type: 'notice', message: 'Сайт вернул страницу вместо аудиофайла. Попробуй другую ссылку «Скачать».' });
        return;
      }
      if (!isProbablyAudio(type)) {
        tellApp({ type: 'notice', message: 'Сайт сформировал файл ' + type + ', а не аудио. Попробуй другую ссылку «Скачать».' });
        return;
      }
      var token = rememberBlob(blob, title, contentDisposition);
      tellApp({
        type: 'blobCandidate',
        token: token,
        title: title || document.title || '',
        mimeType: type,
        size: blob.size,
        contentDisposition: contentDisposition || ''
      });
    }

    function readBlobSlice(slice) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var result = String(reader.result || '');
          var comma = result.indexOf(',');
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = function () {
          reject(reader.error || new Error('Не удалось прочитать файл.'));
        };
        reader.readAsDataURL(slice);
      });
    }

    function sendStoredBlob(token) {
      var entry = blobStore[token];
      if (!entry || !entry.blob) {
        tellApp({ type: 'blobError', id: token, message: 'Браузер уже потерял этот файл. Попробуй скачать ещё раз.' });
        return;
      }
      var blob = entry.blob;
      tellApp({
        type: 'blobStart',
        id: token,
        title: entry.title,
        mimeType: entry.mimeType,
        size: blob.size
      });
      var offset = 0;
      function next() {
        if (offset >= blob.size) {
          tellApp({ type: 'blobEnd', id: token });
          delete blobStore[token];
          return;
        }
        var slice = blob.slice(offset, Math.min(offset + BLOB_CHUNK_SIZE, blob.size));
        offset += slice.size;
        readBlobSlice(slice).then(function (base64) {
          tellApp({ type: 'blobChunk', id: token, data: base64 });
          setTimeout(next, 0);
        }).catch(function (error) {
          tellApp({
            type: 'blobError',
            id: token,
            message: error && error.message ? error.message : 'Не удалось прочитать файл.'
          });
          delete blobStore[token];
        });
      }
      next();
    }
    window.__musikaSendBlob = sendStoredBlob;

    async function announceBlobUrl(url, title, contentDisposition) {
      if (!url || announcedRecently(url)) return;
      announcedBlobUrls[url] = Date.now();
      try {
        var response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error('сервер ответил HTTP ' + response.status);
        var blob = await response.blob();
        var headerType = '';
        try { headerType = response.headers.get('content-type') || ''; } catch (e) {}
        var headerDisposition = contentDisposition || '';
        if (!headerDisposition) {
          try { headerDisposition = response.headers.get('content-disposition') || ''; } catch (e) {}
        }
        announceBlob(blob, title, headerDisposition, blob.type || headerType);
      } catch (error) {
        tellApp({
          type: 'notice',
          message: 'Не удалось получить файл из браузера: '
            + (error && error.message ? error.message : 'неизвестная ошибка')
            + '. Попробуй другую ссылку «Скачать».'
        });
      }
    }

    async function startFormPostDownload(form, action) {
      tellApp({ type: 'notice', message: 'Сайт отправляет POST-запрос. Получаю файл…' });
      try {
        var enctype = String(form.getAttribute('enctype') || '').toLowerCase();
        var body;
        if (enctype.indexOf('multipart/form-data') !== -1) {
          body = new FormData(form);
        } else {
          body = new URLSearchParams();
          new FormData(form).forEach(function (value, key) {
            if (typeof value === 'string') body.append(key, value);
          });
        }
        var response = await fetch(action, {
          method: 'POST',
          body: body,
          credentials: 'include'
        });
        if (!response.ok) throw new Error('сервер ответил HTTP ' + response.status);
        var headerType = '';
        try { headerType = response.headers.get('content-type') || ''; } catch (e) {}
        var headerDisposition = '';
        try { headerDisposition = response.headers.get('content-disposition') || ''; } catch (e) {}
        var blob = await response.blob();
        announceBlob(blob, getDownloadTitle(null) || document.title || '', headerDisposition, blob.type || headerType);
      } catch (error) {
        tellApp({
          type: 'notice',
          message: 'Не удалось получить файл по POST-запросу: '
            + (error && error.message ? error.message : 'неизвестная ошибка')
            + '. Попробуй другую ссылку «Скачать».'
        });
      }
    }

    function isLikelyFileDownload(url) {
      if (audioRe.test(url)) return true;
      try {
        var parsed = new URL(url, location.href);
        var path = parsed.pathname.toLowerCase();
        var search = parsed.search.toLowerCase();
        var lastSegment = path.split('/').filter(Boolean).pop() || '';
        var baseName = lastSegment.replace(/\\.[a-z0-9]+$/i, '');
        if (downloadSegments.indexOf(baseName) !== -1) return true;
        return /\\/(?:download|dl|getfile|get_file|downloadfile|download_file)(?:\\/|$)/.test(path)
          || /(?:^|[?&])(?:download|dl|file|filename|save)=/.test(search);
      } catch (e) {
        return false;
      }
    }

    function isBrowserMadeFile(url) {
      return /^(blob:|data:)/i.test(String(url || ''));
    }

    function getDownloadTitle(anchor) {
      if (anchor && anchor.getAttribute) {
        var explicit = anchor.getAttribute('download');
        if (explicit && explicit !== 'true') return explicit;
        var text = (anchor.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text.length > 2 && text.length < 120) return text;
      }
      return document.title || '';
    }

    function sendDownload(url, title) {
      lastPopupActivityAt = Date.now();
      var cookie = '';
      try { cookie = document.cookie || ''; } catch (e) {}
      tellApp({
        type: 'download',
        url: url,
        title: title || document.title || '',
        referrer: location.href,
        cookie: cookie,
        userAgent: navigator.userAgent || ''
      });
    }

    function openInCurrentPage(url) {
      // Отдельные окна не создаём. Обычные страницы открываем в текущем WebView,
      // а прямые аудиофайлы отправляем в загрузчик приложения.
      handlePopupUrl(url, '');
    }

    function handlePopupUrl(rawUrl, title) {
      var resolvedUrl = absoluteUrl(rawUrl);
      if (!resolvedUrl) return;
      if (isBlocked(resolvedUrl)) {
        tellApp({ type: 'notice', message: 'Рекламный переход заблокирован.' });
        return;
      }
      lastPopupActivityAt = Date.now();
      if (isBrowserMadeFile(resolvedUrl)) {
        announceBlobUrl(resolvedUrl, title || '', '');
        return;
      }
      if (isLikelyFileDownload(resolvedUrl)) {
        sendDownload(resolvedUrl, title || '');
        return;
      }
      // Ссылки target=_blank и window.open открываем в текущей странице,
      // не создавая попап и не блокируя обычную навигацию на другой домен.
      if (/^https?:\\/\\//i.test(resolvedUrl)) {
        if (resolvedUrl !== location.href) window.location.assign(resolvedUrl);
        return;
      }
      tellApp({ type: 'notice', message: 'Эта ссылка не поддерживается во встроенном браузере.' });
    }

    // Некоторые сайты сначала открывают пустое окно, а адрес задают позже:
    // var w = window.open(); w.location = '...';
    // Возвращаем безопасную заглушку, чтобы такой сценарий не ломался.
    function scanPopupHtml(html) {
      var text = String(html || '');
      if (!text) return;
      var urls = [];
      var match;
      var attrRe = /(?:href|src)\\s*=\\s*["']([^"']+)["']/gi;
      while ((match = attrRe.exec(text))) urls.push(match[1]);
      var rawRe = /https?:\\/\\/[^\\s"'<>]+/gi;
      while ((match = rawRe.exec(text))) urls.push(match[0]);
      for (var i = 0; i < urls.length; i += 1) {
        var resolvedUrl = absoluteUrl(urls[i]);
        if (!resolvedUrl || isBlocked(resolvedUrl)) continue;
        if (isBrowserMadeFile(resolvedUrl)) {
          announceBlobUrl(resolvedUrl, document.title || '', '');
          return;
        }
        if (isLikelyFileDownload(resolvedUrl)) {
          sendDownload(resolvedUrl, document.title || '');
          return;
        }
      }
    }

    function createPopupProxy() {
      var proxy = { closed: false, opener: window, name: '' };
      var loc = {};
      function navigate(value) {
        handlePopupUrl(value, '');
      }
      Object.defineProperty(loc, 'href', {
        get: function () { return location.href; },
        set: navigate
      });
      loc.assign = navigate;
      loc.replace = navigate;
      loc.reload = function () {};
      Object.defineProperty(proxy, 'location', {
        get: function () { return loc; },
        set: navigate
      });
      proxy.document = {
        write: scanPopupHtml,
        writeln: scanPopupHtml,
        open: function () { return proxy.document; },
        close: function () {},
        body: {},
        location: loc
      };
      Object.defineProperty(proxy.document.body, 'innerHTML', {
        get: function () { return ''; },
        set: scanPopupHtml
      });
      proxy.focus = function () {};
      proxy.blur = function () {};
      proxy.close = function () { proxy.closed = true; };
      proxy.postMessage = function () {};
      proxy.addEventListener = function () {};
      proxy.removeEventListener = function () {};
      proxy.self = proxy;
      proxy.window = proxy;
      proxy.top = proxy;
      return proxy;
    }

    // Не позволяем странице создавать отдельные окна. Нативный onOpenWindow — второй рубеж.
    window.open = function (rawUrl) {
      var value = rawUrl === undefined || rawUrl === null ? '' : String(rawUrl).trim();
      if (value && !/^about:blank/i.test(value)) {
        handlePopupUrl(value, '');
      }
      // Всегда возвращаем заглушку: некоторые сайты сразу обращаются
      // к результату window.open(), и null ломал бы их сценарий скачивания.
      return createPopupProxy();
    };

    function findAnchor(event) {
      var path = [];
      try { path = event.composedPath ? event.composedPath() : []; } catch (e) {}
      for (var i = 0; i < path.length; i += 1) {
        if (path[i] && path[i].tagName === 'A') return path[i];
      }
      var node = event.target;
      while (node) {
        if (node.tagName === 'A') return node;
        node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      }
      return null;
    }

    // На muzpro кнопка «Скачать трек» имеет href="javascript:void(0)",
    // а прямой MP3 URL находится в data-track у соседнего .fplay-wr.js-item.
    // Получаем URL напрямую, не открываем промежуточную рекламную страницу.
    function findTrackForDownloadButton(button) {
      function directTrack(element) {
        if (!element || element.nodeType !== 1) return null;
        if (element.matches && element.matches('.js-item[data-track]')) return element;
        return null;
      }
      function tracksInside(element) {
        if (!element || !element.querySelectorAll) return [];
        var found = [];
        var own = directTrack(element);
        if (own) found.push(own);
        var nested = element.querySelectorAll('.js-item[data-track]');
        for (var i = 0; i < nested.length; i += 1) {
          if (found.indexOf(nested[i]) === -1) found.push(nested[i]);
        }
        return found;
      }

      // Сначала ищем соседний плеер: в карточке трека он обычно стоит перед .fdl.
      var current = button;
      for (var depth = 0; current && depth < 6; depth += 1) {
        var sibling = current.previousElementSibling;
        var siblingDepth = 0;
        while (sibling && siblingDepth < 5) {
          var siblingTracks = tracksInside(sibling);
          if (siblingTracks.length === 1) return siblingTracks[0];
          if (siblingTracks.length > 1) break;
          sibling = sibling.previousElementSibling;
          siblingDepth += 1;
        }

        var parent = current.parentElement;
        if (!parent) break;
        var parentTracks = tracksInside(parent);
        if (parentTracks.length === 1) return parentTracks[0];
        current = parent;
      }

      // Безопасный запасной путь: используем единственный трек на странице,
      // но не выбираем случайный трек, если их несколько.
      var pageTracks = document.querySelectorAll('.fplay-wr.js-item[data-track], .js-item[data-track]');
      if (pageTracks.length === 1) return pageTracks[0];
      return null;
    }

    function getTrackDownloadTitle(track) {
      if (!track) return document.title || 'audio';
      var artist = track.getAttribute('data-artist') || '';
      var title = track.getAttribute('data-title') || '';
      if (!title) {
        var titleNode = track.querySelector('.fbtn-title');
        title = titleNode ? String(titleNode.textContent || '').trim() : '';
      }
      var combined = [artist.trim(), title.trim()].filter(Boolean).join(' - ');
      return combined || document.title || 'audio';
    }

    // Перехватываем клики на этапе capture. Специальный обработчик для .fdl
    // выполняется раньше скрипта сайта, потому что его href — javascript:void(0).
    window.addEventListener('click', function (event) {
      lastUserGestureAt = Date.now();

      var targetNode = event.target;
      var downloadButton = null;
      try {
        var path = event.composedPath ? event.composedPath() : [];
        for (var pathIndex = 0; pathIndex < path.length; pathIndex += 1) {
          var pathNode = path[pathIndex];
          if (pathNode && pathNode.nodeType === 1 && pathNode.matches && pathNode.matches('a.fdl, button.fdl, .fbtn.fdl')) {
            downloadButton = pathNode;
            break;
          }
        }
      } catch (e) {}
      if (!downloadButton && targetNode && targetNode.closest) {
        downloadButton = targetNode.closest('a.fdl, button.fdl, .fbtn.fdl');
      }

      if (downloadButton) {
        var trackElement = findTrackForDownloadButton(downloadButton);
        var trackUrl = trackElement ? absoluteUrl(trackElement.getAttribute('data-track') || '') : '';
        if (trackUrl && /^https?:\\/\\//i.test(trackUrl)) {
          var trackTitle = getTrackDownloadTitle(trackElement);
          event.preventDefault();
          event.stopImmediatePropagation();
          sendDownload(trackUrl, trackTitle);
          return;
        }
        tellApp({
          type: 'notice',
          message: 'Не удалось найти data-track рядом с кнопкой скачивания. Проверь структуру карточки трека на сайте.'
        });
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      var node = findAnchor(event);
      if (!node) return;

      var rawHref = '';
      try { rawHref = node.getAttribute('href') || ''; } catch (e) {}
      if (!rawHref || /^(#|javascript:)/i.test(rawHref)) return;

      var href = absoluteUrl(rawHref) || node.href || '';
      if (!href) return;

      var label = '';
      try {
        label = [
          node.textContent || '',
          node.getAttribute('aria-label') || '',
          node.getAttribute('title') || '',
          node.getAttribute('download') || ''
        ].join(' ').replace(/\s+/g, ' ').trim();
      } catch (e) {}
      var isDownloadAction = /скач|download|загрузить|сохранить/i.test(label);
      var target = String(node.getAttribute('target') || node.target || '').toLowerCase();
      var opensNewWindow = target === '_blank';

      if (isBlocked(href)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        tellApp({ type: 'notice', message: 'Рекламный переход заблокирован.' });
        return;
      }

      // target=_blank переводим в текущую вкладку. Обработчику сайта даём
      // выполнить onclick, чтобы он мог вычислить фактический адрес назначения.
      // downloadIntent отправляем только для ссылок, похожих на скачивание:
      // обычные ссылки на другие сайты не должны попадать под блокировку загрузки.
      if (opensNewWindow || isDownloadAction) {
        event.preventDefault();
        var activityAtClick = lastPopupActivityAt;
        var title = getDownloadTitle(node);
        if (isDownloadAction) {
          tellApp({
            type: 'downloadIntent',
            href: href,
            title: title,
            sourceUrl: location.href
          });
        }
        setTimeout(function () {
          if (lastPopupActivityAt !== activityAtClick) return;
          if (isBlocked(href)) return;
          if (isBrowserMadeFile(href)) {
            announceBlobUrl(href, title, '');
          } else if (audioRe.test(href) || node.hasAttribute('download') || isLikelyFileDownload(href)) {
            sendDownload(href, title);
          } else {
            handlePopupUrl(href, title);
          }
        }, 900);
        // Не вызываем stopImmediatePropagation(): скрипт сайта может вычислять URL.
        return;
      }

      // Файлы, созданные внутри браузера (blob/data), скачиваем напрямую.
      if (isBrowserMadeFile(href)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        announceBlobUrl(href, getDownloadTitle(node), '');
        return;
      }

      // Обычные ссылки на аудиофайлы сохраняем в библиотеку приложения.
      if (audioRe.test(href) || node.hasAttribute('download') || isLikelyFileDownload(href)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        sendDownload(href, getDownloadTitle(node));
      }
    }, true);

    // Формы со скачиванием: GET превращаем в обычную ссылку, POST повторяем через fetch.
    window.addEventListener('submit', function (event) {
      lastUserGestureAt = Date.now();
      var form = event.target;
      if (!form || form.tagName !== 'FORM') return;
      var resolvedAction = absoluteUrl(form.getAttribute('action') || location.href);
      if (!resolvedAction) return;
      if (isBlocked(resolvedAction)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        tellApp({ type: 'notice', message: 'Рекламная отправка формы заблокирована.' });
        return;
      }
      if (!isLikelyFileDownload(resolvedAction)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      var method = String(form.getAttribute('method') || 'get').toLowerCase();
      if (method !== 'get') {
        startFormPostDownload(form, resolvedAction);
        return;
      }

      var url = resolvedAction.split('#')[0];
      try {
        var params = [];
        new FormData(form).forEach(function (value, key) {
          if (typeof value === 'string') {
            params.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
          }
        });
        if (params.length) {
          url += (url.indexOf('?') === -1 ? '?' : '&') + params.join('&');
        }
      } catch (e) {}
      sendDownload(url, document.title || '');
    }, true);

    // Некоторые сайты не используют ссылку, а делают:
    // location.href = URL.createObjectURL(new Blob([...], { type: 'audio/mpeg' })).
    // Такой переход WebView не отдаёт в onShouldStartLoadWithRequest, поэтому
    // запоминаем аудио-blob и после короткой паузы предлагаем его скачать.
    // Если blob успели подключить к <audio>/<video>, это обычное воспроизведение — не трогаем.
    try {
      var nativeCreateObjectURL = URL.createObjectURL;
      if (nativeCreateObjectURL) {
        URL.createObjectURL = function (object) {
          var objectUrl = nativeCreateObjectURL.call(URL, object);
          try {
            var isAudioBlob = object instanceof Blob
              && object.size >= 96 * 1024
              && /^audio\//i.test(object.type || '');
            if (isAudioBlob) {
              setTimeout(function () {
                if (announcedRecently(objectUrl)) return;
                if (Date.now() - lastUserGestureAt > 6000) return;
                var usedForPlayback = false;
                try {
                  document.querySelectorAll('audio, video, source').forEach(function (element) {
                    var src = element.currentSrc || element.src || element.getAttribute('src') || '';
                    if (src === objectUrl) usedForPlayback = true;
                  });
                } catch (e) {}
                if (usedForPlayback) return;
                announceBlobUrl(objectUrl, document.title || '', '');
              }, 800);
            }
          } catch (e) {}
          return objectUrl;
        };
      }
    } catch (e) {}

    function removeKnownAds() {
      document.querySelectorAll('iframe[src], script[src]').forEach(function (element) {
        if (isBlocked(element.src)) element.remove();
      });
      if (!document.getElementById('musika-ad-filter-style')) {
        var style = document.createElement('style');
        style.id = 'musika-ad-filter-style';
        style.textContent = [
          'iframe[src*="doubleclick.net"], iframe[src*="googlesyndication.com"],',
          'iframe[src*="adnxs.com"], [data-ad-slot], [data-google-query-id],',
          '[id^="google_ads_"], [aria-label="Реклама"], [aria-label="Sponsored"]',
          '{ display:none !important; visibility:hidden !important; }'
        ].join(' ');
        (document.head || document.documentElement).appendChild(style);
      }
    }

    function startAdObserver() {
      try {
        removeKnownAds();
        if (document.documentElement && typeof MutationObserver !== 'undefined') {
          var observer = new MutationObserver(removeKnownAds);
          observer.observe(document.documentElement, { childList: true, subtree: true });
        }
      } catch (e) {}
    }
    if (document.documentElement) startAdObserver();
    else document.addEventListener('DOMContentLoaded', startAdObserver, { once: true });
  } catch (e) {}
})();
true;
`;

const INSPECT_PAGE_AUDIO_SCRIPT = `
(function () {
  var audioRe = /\\.(mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#]|$)/i;
  var urls = [];
  function add(url) {
    if (url && urls.indexOf(url) === -1) urls.push(url);
  }
  Array.from(document.querySelectorAll('audio, audio source')).forEach(function (item) {
    add(item.currentSrc || item.src || item.getAttribute('src') || '');
  });
  Array.from(document.querySelectorAll('a[href]')).forEach(function (item) {
    var href = item.href;
    if (href && audioRe.test(href)) add(href);
  });
  try {
    performance.getEntriesByType('resource').forEach(function (entry) {
      if (entry && entry.name) add(entry.name);
    });
  } catch (e) {}
  var url = urls.find(function (item) { return audioRe.test(item); });
  var cookie = '';
  try { cookie = document.cookie || ''; } catch (e) {}
  window.ReactNativeWebView.postMessage(JSON.stringify(
    url ? {
      type: 'download',
      url: url,
      title: document.title || '',
      referrer: location.href,
      cookie: cookie,
      userAgent: navigator.userAgent || ''
    } :
      { type: 'notice', message: 'Не удалось обнаружить прямую ссылку на аудиофайл в этой странице. Попробуй нажать именно ссылку на MP3 или страницу с HTML5-аудиоплеером.' }
  ));
})();
true;
`;

const PAUSE_PAGE_AUDIO_SCRIPT = `
(function () {
  document.querySelectorAll('audio, video').forEach(function (element) {
    try { element.pause(); } catch (e) {}
  });
})();
true;
`;

export default function App() {
    const webViewRef = useRef<WebView>(null);
    const player = useAudioPlayer(null);
    const playbackStatus = useAudioPlayerStatus(player);
    const currentPageUrlRef = useRef<string>('http://10.0.2.2:8765/');
    const lastDownloadPromptRef = useRef({ url: '', at: 0 });
    const pendingDownloadIntentRef = useRef<{ at: number; sourceUrl: string; href: string; title: string } | null>(null);
    const downloadingRef = useRef(false);
    const blobTransferRef = useRef<BlobTransfer | null>(null);
    const blobTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [tab, setTab] = useState<Tab>('browser');
    const [query, setQuery] = useState('');
    const [browserSourceUrl, setBrowserSourceUrl] = useState('http://10.0.2.2:8765/');
    const [canGoBack, setCanGoBack] = useState(false);
    const [pageTitle, setPageTitle] = useState('Musika Download Test');
    const [notice, setNotice] = useState('Введи название песни или исполнителя. К запросу добавится «скачать бесплатно».');
    const [loadingPage, setLoadingPage] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [localTracks, setLocalTracks] = useState<LocalTrack[]>([]);
    const [currentTrack, setCurrentTrack] = useState<LocalTrack | null>(null);

    // useMemo сохраняет source-объект, чтобы перерисовка кнопок не перезагружала страницу.
    const webSource = useMemo(() => ({ uri: browserSourceUrl }), [browserSourceUrl]);

    const loadLocalTracks = useCallback(async () => {
        try {
            await ensureMusicFolder();
            const filenames = await FileSystem.readDirectoryAsync(MUSIC_DIR);
            const tracks: LocalTrack[] = filenames
                .filter((filename) => AUDIO_EXTENSIONS.includes((filename.split('.').pop() ?? '').toLowerCase()))
                .map((filename) => ({
                    id: filename,
                    filename,
                    uri: `${MUSIC_DIR}${filename}`,
                    name: filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
            setLocalTracks(tracks);
        } catch (error) {
            console.warn('Не удалось прочитать папку музыки:', error);
            setNotice('Не удалось прочитать локальную музыку. Проверь папку приложения и перезапусти его.');
        }
    }, []);

    useEffect(() => {
        setAudioModeAsync({ playsInSilentMode: true }).catch((error) => {
            console.warn('Не получилось настроить аудио:', error);
        });
        const timer = setTimeout(loadLocalTracks, 0);
        return () => clearTimeout(timer);
    }, [loadLocalTracks]);

    function handleSearch() {
        const term = query.trim();
        if (!term) {
            Alert.alert('Что искать?', 'Введи название песни или исполнителя.');
            return;
        }
        const fullQuery = `${term} скачать бесплатно`;
        const url = `https://www.google.com/search?q=${encodeURIComponent(fullQuery)}`;
        setBrowserSourceUrl(url);
        setTab('browser');
        setNotice(`Поиск Google: ${fullQuery}`);
    }

    async function saveDownloadedFile(
        tempUri: string,
        options: SaveDownloadedFileOptions = {}
    ): Promise<string> {
        const {
            title = '',
            mimeType = '',
            headers = {},
            sourceUrl = '',
            extension = '',
        } = options;

        const info = await FileSystem.getInfoAsync(tempUri);
        if (!info.exists || info.size < 128) {
            throw new Error('Сервер вернул пустой файл.');
        }

        const responseMime = mimeType || getHeaderValue(headers, 'content-type');
        if (isLikelyWebResponse(responseMime)) {
            throw new Error(`По ссылке пришла веб-страница (${responseMime}), а не аудиофайл.`);
        }

        const contentDisposition = options.contentDisposition
            || getHeaderValue(headers, 'content-disposition');
        const headerExtension = getAudioExtensionFromContentDisposition(contentDisposition);
        let detectedExtension = getAudioExtensionFromMime(responseMime)
            || headerExtension
            || getAudioExtension(sourceUrl)
            || extension;

        if (!detectedExtension) {
            const head = await FileSystem.readAsStringAsync(tempUri, {
                encoding: 'base64',
                position: 0,
                length: 64,
            });
            detectedExtension = getAudioExtensionFromBytes(base64ToBytes(head));
        }

        if (!detectedExtension || !AUDIO_EXTENSIONS.includes(detectedExtension)) {
            throw new Error(
                `Сервер вернул ${responseMime || 'файл неизвестного формата'}, а не поддерживаемый аудиофайл.`
            );
        }

        const headerFilename = parseContentDispositionFileName(contentDisposition);
        const headerBaseName = headerFilename ? makeSafeFileName(headerFilename) : '';
        const urlBaseName = makeSafeFileName(getFileNameFromUrl(sourceUrl || ''));
        const titleBaseName = makeSafeFileName(cleanTrackTitle(title) || '');
        const baseName = !isGenericAudioName(headerBaseName)
            ? headerBaseName
            : (!isGenericAudioName(urlBaseName)
                ? urlBaseName
                : (!isGenericAudioName(titleBaseName) ? titleBaseName : 'audio'));

        let filename = `${baseName}.${detectedExtension}`;
        let destination = `${MUSIC_DIR}${filename}`;
        const existing = await FileSystem.getInfoAsync(destination);
        if (existing.exists) {
            filename = `${baseName.slice(0, 70)}-${Date.now()}.${detectedExtension}`;
            destination = `${MUSIC_DIR}${filename}`;
        }

        await FileSystem.moveAsync({ from: tempUri, to: destination });
        await loadLocalTracks();
        setNotice(`Файл сохранён: ${filename}. Открой вкладку «Моя музыка».`);
        Alert.alert('Скачивание завершено', `Сохранено в папку приложения:\n${filename}`);
        return filename;
    }

    function askToDownload(rawUrl: unknown, suggestedTitle: string = '', meta: DownloadMeta = {}): void {
        const url = String(rawUrl || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            setNotice('Не удалось получить прямую HTTP(S)-ссылку на файл.');
            return;
        }

        // Сайт может отправить одно и то же событие несколько раз (click + window.open
        // + навигация). Не показываем из-за этого несколько окон подряд.
        const now = getCurrentTime();
        if (
            lastDownloadPromptRef.current.url === url &&
            now - lastDownloadPromptRef.current.at < 2000
        ) {
            return;
        }
        lastDownloadPromptRef.current = { url, at: now };

        const extension = getAudioExtension(url) || getAudioExtensionFromMime(meta.mimeType);
        const fromUrl = getFileNameFromUrl(url);
        const title = makeSafeFileName(cleanTrackTitle(suggestedTitle) || fromUrl || 'audio');

        setNotice(
            extension
                ? `Найдена ссылка на ${extension.toUpperCase()}-файл. Подтверди скачивание.`
                : 'Сайт отдаёт файл без расширения. Формат определю после загрузки.'
        );

        Alert.alert(
            'Скачать аудиофайл?',
            `${title}${extension ? `.${extension}` : ''}\n\nСохраняй только файлы, которые ты вправе скачивать. Файл попадёт во внутреннюю папку MUSIKA Player.`,
            [
                { text: 'Отмена', style: 'cancel' },
                { text: 'Скачать', onPress: () => downloadAudio(url, title, extension, meta) },
            ]
        );
    }

    async function downloadAudio(
        rawUrl: string,
        title: string,
        extension: string,
        meta: DownloadMeta = {}
    ): Promise<void> {
        if (downloadingRef.current) {
            setNotice('Другая загрузка уже идёт. Дождись её завершения.');
            return;
        }
        downloadingRef.current = true;
        setDownloading(true);
        let tempUri = '';
        try {
            await ensureMusicFolder();
            setNotice('Скачиваю файл…');

            const headers: Record<string, string> = {};
            if (meta.referrer) headers.Referer = meta.referrer;
            if (meta.cookie) headers.Cookie = meta.cookie;
            if (meta.userAgent) headers['User-Agent'] = meta.userAgent;
            headers.Accept = 'audio/*,application/octet-stream,*/*;q=0.8';

            const tempDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
            tempUri = `${tempDir}musika-${Date.now()}-${Math.random().toString(36).slice(2)}.part`;
            const result = await FileSystem.downloadAsync(rawUrl, tempUri, { headers });
            if (typeof result.status === 'number' && result.status >= 400) {
                throw new Error(`Сервер ответил HTTP ${result.status}.`);
            }

            await saveDownloadedFile(tempUri, {
                title,
                mimeType: result.mimeType,
                headers: result.headers,
                sourceUrl: rawUrl,
                extension,
            });
            tempUri = '';
        } catch (error) {
            if (tempUri) {
                try {
                    await FileSystem.deleteAsync(tempUri, { idempotent: true });
                } catch (_cleanupError) {}
            }
            Alert.alert(
                'Не удалось скачать файл',
                `${getErrorMessage(error, 'Ошибка загрузки.')}\n\nНекоторые сайты запрещают прямую загрузку или требуют авторизацию/cookies, которые недоступны загрузчику приложения.`
            );
        } finally {
            downloadingRef.current = false;
            setDownloading(false);
        }
    }

    // --- Файлы, которые сайт сформировал в браузере (blob) или получил POST-запросом ---

    function clearBlobTimeout(): void {
        if (blobTimeoutRef.current) {
            clearTimeout(blobTimeoutRef.current);
            blobTimeoutRef.current = null;
        }
    }

    function askToDownloadBlob(message: BlobCandidateMessage): void {
        const token = String(message.token || '').trim();
        if (!token) return;

        const size = Number(message.size) || 0;
        if (size > 250 * 1024 * 1024) {
            setNotice('Файл больше 250 МБ — такой файл не буду скачивать.');
            return;
        }

        const mimeType = String(message.mimeType || '');
        const extension = getAudioExtensionFromMime(mimeType);
        const now = getCurrentTime();
        const promptKey = `blob:${token}`;
        if (
            lastDownloadPromptRef.current.url === promptKey &&
            now - lastDownloadPromptRef.current.at < 2000
        ) {
            return;
        }
        lastDownloadPromptRef.current = { url: promptKey, at: now };

        const headerFilename = parseContentDispositionFileName(message.contentDisposition);
        const title = makeSafeFileName(
            cleanTrackTitle(message.title) || (headerFilename ? headerFilename : '') || 'audio'
        );
        const sizeText = formatFileSize(size);

        setNotice('Сайт сформировал аудиофайл в браузере. Подтверди сохранение.');

        Alert.alert(
            'Скачать аудиофайл?',
            `${title}${extension ? `.${extension}` : ''}${sizeText ? ` (${sizeText})` : ''}\n\n`
            + 'Файл создан внутри браузера. Он будет сохранён во внутреннюю папку MUSIKA Player.',
            [
                { text: 'Отмена', style: 'cancel' },
                {
                    text: 'Скачать',
                    onPress: () => startBlobTransfer(
                        token,
                        title,
                        mimeType,
                        String(message.contentDisposition || '')
                    ),
                },
            ]
        );
    }

    function startBlobTransfer(
        token: string,
        title: string,
        mimeType: string,
        contentDisposition: string
    ): void {
        if (downloadingRef.current) {
            setNotice('Другая загрузка уже идёт. Дождись её завершения.');
            return;
        }
        downloadingRef.current = true;
        setDownloading(true);
        blobTransferRef.current = {
            id: token,
            title,
            mimeType,
            contentDisposition,
            chunks: [],
            received: 0,
            size: 0,
            lastPercent: -1,
        };
        setNotice('Получаю файл из браузера…');

        clearBlobTimeout();
        blobTimeoutRef.current = setTimeout(() => {
            const transfer = blobTransferRef.current;
            if (!transfer || transfer.id !== token) return;
            blobTransferRef.current = null;
            downloadingRef.current = false;
            setDownloading(false);
            setNotice('Браузер не передал файл вовремя. Попробуй скачать ещё раз.');
        }, 180000);

        try {
            webViewRef.current?.injectJavaScript(
                `window.__musikaSendBlob && window.__musikaSendBlob(${JSON.stringify(token)}); true;`
            );
        } catch (_error) {
            clearBlobTimeout();
            blobTransferRef.current = null;
            downloadingRef.current = false;
            setDownloading(false);
            setNotice('Не удалось попросить браузер передать файл. Попробуй ещё раз.');
        }
    }

    function handleBlobStart(message: BlobStartMessage): void {
        const transfer = blobTransferRef.current;
        if (!transfer || transfer.id !== message.id) return;
        transfer.mimeType = message.mimeType || transfer.mimeType;
        transfer.size = Number(message.size) || transfer.size;
    }

    function handleBlobChunk(message: BlobChunkMessage): void {
        const transfer = blobTransferRef.current;
        if (!transfer || transfer.id !== message.id) return;
        const data = typeof message.data === 'string' ? message.data : '';
        if (!data) return;

        transfer.chunks.push(data);
        transfer.received += data.length;

        // ~255 МБ в base64. Ограничение защищает память телефона от огромных файлов.
        if (transfer.received > 340 * 1024 * 1024) {
            clearBlobTimeout();
            blobTransferRef.current = null;
            downloadingRef.current = false;
            setDownloading(false);
            Alert.alert('Файл слишком большой', 'Не буду сохранять файл такого размера.');
            return;
        }

        if (transfer.size > 0) {
            const bytesReceived = Math.floor((transfer.received * 3) / 4);
            const percent = Math.min(99, Math.floor((bytesReceived / transfer.size) * 100));
            if (percent >= transfer.lastPercent + 10) {
                transfer.lastPercent = percent;
                setNotice(`Получаю файл из браузера… ${percent}%`);
            }
        }
    }

    async function finishBlobTransfer(id: string): Promise<void> {
        const transfer = blobTransferRef.current;
        if (!transfer || transfer.id !== id) return;
        blobTransferRef.current = null;
        clearBlobTimeout();

        const tempDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
        const tempUri = `${tempDir}musika-blob-${Date.now()}-${Math.random().toString(36).slice(2)}.part`;
        try {
            const base64 = transfer.chunks.join('');
            if (!base64 || base64.length < 100) {
                throw new Error('Браузер передал пустой файл.');
            }
            setNotice('Сохраняю файл…');
            await FileSystem.writeAsStringAsync(tempUri, base64, { encoding: 'base64' });
            await saveDownloadedFile(tempUri, {
                title: transfer.title,
                mimeType: transfer.mimeType,
                contentDisposition: transfer.contentDisposition,
            });
        } catch (error) {
            try {
                await FileSystem.deleteAsync(tempUri, { idempotent: true });
            } catch (_cleanupError) {}
            Alert.alert(
                'Не удалось сохранить файл',
                getErrorMessage(error, 'Браузер передал повреждённый файл.')
            );
        } finally {
            downloadingRef.current = false;
            setDownloading(false);
        }
    }

    function handleBlobError(message: BlobErrorMessage): void {
        const transfer = blobTransferRef.current;
        if (!transfer || transfer.id !== message.id) return;
        blobTransferRef.current = null;
        clearBlobTimeout();
        downloadingRef.current = false;
        setDownloading(false);
        Alert.alert(
            'Не удалось получить файл',
            message.message || 'Сайт не смог передать файл в приложение.'
        );
    }

    function handleWebViewMessage(event: WebViewMessageEvent): void {
        let message: WebViewIncomingMessage;
        try {
            message = JSON.parse(event.nativeEvent.data);
        } catch (_error) {
            return;
        }
        if (message.type === 'downloadIntent') {
            pendingDownloadIntentRef.current = {
                at: Date.now(),
                sourceUrl: message.sourceUrl || currentPageUrlRef.current,
                href: message.href || '',
                title: message.title || '',
            };
        } else if (message.type === 'download') {
            askToDownload(message.url, message.title || '', {
                referrer: message.referrer || currentPageUrlRef.current,
                cookie: message.cookie || '',
                userAgent: message.userAgent || '',
                mimeType: message.mimeType || '',
            });
        } else if (message.type === 'blobCandidate') {
            askToDownloadBlob(message);
        } else if (message.type === 'blobStart') {
            handleBlobStart(message);
        } else if (message.type === 'blobChunk') {
            handleBlobChunk(message);
        } else if (message.type === 'blobEnd') {
            finishBlobTransfer(message.id);
        } else if (message.type === 'blobError') {
            handleBlobError(message);
        } else if (message.type === 'notice' && message.message) {
            setNotice(message.message);
        }
    }

    function handleRequestNavigation(request: ShouldStartLoadRequest): boolean {
        const targetUrl = request.url || '';
        if (isBlockedAdUrl(targetUrl)) {
            setNotice('Рекламный переход заблокирован.');
            return false;
        }
        if (request.isTopFrame !== false && /^(blob:|data:)/i.test(targetUrl)) {
            setNotice('Сайт пытается открыть файл, созданный внутри браузера (blob). Такой тип скачивания пока не поддерживается.');
            return false;
        }
        // Если пользователь перешёл прямо на MP3 или на адрес вида
        // /download.php?id=..., предлагаем сохранить его в библиотеку.
        if (
            request.isTopFrame !== false &&
            (getAudioExtension(targetUrl) || isLikelyFileDownloadUrl(targetUrl))
        ) {
            pendingDownloadIntentRef.current = null;
            askToDownload(targetUrl, '', { referrer: currentPageUrlRef.current });
            return false;
        }

        // Обычная навигация разрешена. Известные рекламные домены и прямые
        // аудиофайлы обработаны выше; новые страницы открываем в этом WebView.
        pendingDownloadIntentRef.current = null;
        return true;
    }

    function handleOpenWindow(event: WebViewOpenWindowEvent): void {
        const targetUrl = event.nativeEvent?.targetUrl || '';
        // about:blank бывает временной заглушкой, которой сайт пользуется перед
        // назначением настоящего адреса. Не показываем ложное сообщение об ошибке.
        if (!targetUrl || /^about:blank(?:$|#)/i.test(targetUrl)) {
            return;
        }

        if (isBlockedAdUrl(targetUrl)) {
            setNotice('Рекламный переход заблокирован.');
            return;
        }
        if (/^(blob:|data:)/i.test(targetUrl)) {
            setNotice('Сайт пытается открыть файл, созданный внутри браузера (blob). Попробуй нажать саму ссылку скачивания ещё раз.');
            return;
        }
        if (getAudioExtension(targetUrl) || isLikelyFileDownloadUrl(targetUrl)) {
            pendingDownloadIntentRef.current = null;
            askToDownload(targetUrl, '', { referrer: currentPageUrlRef.current });
            return;
        }
        if (/^https?:\/\//i.test(targetUrl)) {
            // Резервный маршрут, если нативный WebView сообщил о новом окне раньше JS.
            // Меняем адрес существующего WebView вместо открытия отдельного окна.
            pendingDownloadIntentRef.current = null;
            setNotice('');
            setTab('browser');
            setBrowserSourceUrl(targetUrl);
            return;
        }
        setNotice('Эта ссылка не поддерживается во встроенном браузере.');
    }

    function inspectPageAudio(): void {
        if (webViewRef.current) {
            webViewRef.current.injectJavaScript(INSPECT_PAGE_AUDIO_SCRIPT);
        }
    }

    function playLocalTrack(track: LocalTrack): void {
        if (currentTrack?.id === track.id) {
            if (playbackStatus.playing) player.pause();
            else player.play();
            return;
        }
        // Стараемся остановить HTML5 audio/video в основной странице браузера,
        // чтобы скачанный трек не играл одновременно с сайтом.
        try {
            webViewRef.current?.injectJavaScript(PAUSE_PAGE_AUDIO_SCRIPT);
        } catch (_error) {}
        try {
            setCurrentTrack(track);
            player.replace(track.uri);
            player.play();
        } catch (error) {
            Alert.alert('Ошибка плеера', getErrorMessage(error, 'Не получилось запустить этот файл.'));
        }
    }

    function renderLocalTrack({ item }: ListRenderItemInfo<LocalTrack>) {
        const isCurrent = currentTrack?.id === item.id;
        return (
            <View style={styles.trackCard}>
                <TouchableOpacity style={styles.trackPlay} onPress={() => playLocalTrack(item)}>
                    <Text style={styles.trackPlayText}>{isCurrent && playbackStatus.playing ? 'Ⅱ' : '▶'}</Text>
                </TouchableOpacity>
                <View style={styles.trackDetails}>
                    <Text style={styles.trackName} numberOfLines={2}>{item.name}</Text>
                    <Text style={styles.trackSub} numberOfLines={1}>{item.filename}</Text>
                </View>
            </View>
        );
    }

    return (
        <SafeAreaProvider>
            <SafeAreaView style={styles.safeArea}>
                <StatusBar barStyle="light-content" backgroundColor="#0A0E18" />
                <View style={styles.header}>
                    <View>
                        <Text style={styles.logo}>MUSIKA</Text>
                        <Text style={styles.subtitle}>BROWSER · PLAYER</Text>
                    </View>
                    <View style={styles.headerDot} />
                </View>

                <View style={styles.tabs}>
                    <TouchableOpacity style={[styles.tab, tab === 'browser' && styles.tabActive]} onPress={() => setTab('browser')}>
                        <Text style={[styles.tabText, tab === 'browser' && styles.tabTextActive]}>Поиск / браузер</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.tab, tab === 'library' && styles.tabActive]} onPress={() => { setTab('library'); loadLocalTracks(); }}>
                        <Text style={[styles.tabText, tab === 'library' && styles.tabTextActive]}>Моя музыка ({localTracks.length})</Text>
                    </TouchableOpacity>
                </View>

                <View style={[styles.panel, { display: tab === 'browser' ? 'flex' : 'none' }]}>
                    <View style={styles.searchRow}>
                        <TextInput
                            style={styles.searchInput}
                            value={query}
                            onChangeText={setQuery}
                            placeholder="Название песни или исполнитель"
                            placeholderTextColor="#7C879D"
                            returnKeyType="search"
                            onSubmitEditing={handleSearch}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
                            <Text style={styles.searchButtonText}>НАЙТИ</Text>
                        </TouchableOpacity>
                    </View>

                    <View style={styles.browserToolbar}>
                        <TouchableOpacity style={[styles.smallButton, !canGoBack && styles.disabledButton]} disabled={!canGoBack} onPress={() => webViewRef.current?.goBack()}>
                            <Text style={styles.smallButtonText}>‹ Назад</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.smallButton} onPress={() => webViewRef.current?.reload()}>
                            <Text style={styles.smallButtonText}>↻ Обновить</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.smallButton, styles.downloadPageButton]} onPress={inspectPageAudio} disabled={downloading}>
                            <Text style={styles.downloadPageText}>{downloading ? 'Загрузка…' : 'Найти аудио'}</Text>
                        </TouchableOpacity>
                    </View>

                    <Text style={styles.pageTitle} numberOfLines={1}>{pageTitle || 'Браузер'}</Text>
                    {loadingPage && <ActivityIndicator size="small" color="#B9F56D" style={styles.spinner} />}
                    <WebView
                        ref={webViewRef}
                        style={styles.webView}
                        source={webSource}
                        javaScriptEnabled={true}
                        domStorageEnabled={true}
                        webviewDebuggingEnabled={true}
                        mediaPlaybackRequiresUserAction={false}
                        allowsInlineMediaPlayback={true}
                        onMessage={handleWebViewMessage}
                        injectedJavaScriptBeforeContentLoaded={WEB_FILTER_SCRIPT}
                        injectedJavaScript={WEB_FILTER_SCRIPT}
                        javaScriptCanOpenWindowsAutomatically={true}
                        onOpenWindow={handleOpenWindow}
                        onShouldStartLoadWithRequest={handleRequestNavigation}
                        {...(Platform.OS === 'ios'
                            ? {
                                onFileDownload: (event: FileDownloadEvent) => {
                                    const targetUrl = event.nativeEvent?.downloadUrl || '';
                                    if (targetUrl) {
                                        askToDownload(targetUrl, '', {
                                            referrer: currentPageUrlRef.current,
                                        });
                                    }
                                },
                            }
                            : {})}
                        onNavigationStateChange={(navState) => {
                            if (navState.url) currentPageUrlRef.current = navState.url;
                            setCanGoBack(Boolean(navState.canGoBack));
                            setPageTitle(navState.title || navState.url || 'Браузер');
                        }}
                        onLoadStart={() => setLoadingPage(true)}
                        onLoadEnd={() => setLoadingPage(false)}
                        onError={() => {
                            setLoadingPage(false);
                            setNotice('Не удалось открыть страницу. Проверь интернет или попробуй обновить её.');
                        }}
                        onHttpError={(event) => {
                            const status = event.nativeEvent?.statusCode;
                            if (status >= 400) setNotice(`Страница вернула HTTP ${status}. Сайт мог ограничить встроенный браузер.`);
                        }}
                        setSupportMultipleWindows={true}
                        originWhitelist={['http://*', 'https://*']}
                    />
                    <Text style={styles.notice} numberOfLines={3}>{notice}</Text>
                </View>

                <View style={[styles.panel, { display: tab === 'library' ? 'flex' : 'none' }]}>
                    <View style={styles.libraryHeader}>
                        <View style={styles.libraryHeadingWrap}>
                            <Text style={styles.sectionTitle}>Моя музыка</Text>
                            <Text style={styles.sectionHint}>Скачанные аудиофайлы из папки приложения</Text>
                        </View>
                        <TouchableOpacity style={styles.smallButton} onPress={loadLocalTracks}>
                            <Text style={styles.smallButtonText}>↻ Обновить</Text>
                        </TouchableOpacity>
                    </View>
                    {localTracks.length === 0 ? (
                        <View style={styles.emptyState}>
                            <Text style={styles.emptyTitle}>Пока здесь пусто</Text>
                            <Text style={styles.emptyText}>Открой «Поиск / браузер», найди прямую ссылку на разрешённый аудиофайл и скачай его.</Text>
                        </View>
                    ) : (
                        <FlatList
                            data={localTracks}
                            keyExtractor={(item) => item.id}
                            renderItem={renderLocalTrack}
                            contentContainerStyle={styles.listContent}
                        />
                    )}
                </View>

                {currentTrack && (
                    <View style={styles.nowPlaying}>
                        <View style={styles.nowPlayingInfo}>
                            <Text style={styles.nowPlayingLabel}>СЕЙЧАС ИГРАЕТ</Text>
                            <Text style={styles.nowPlayingName} numberOfLines={1}>{currentTrack.name}</Text>
                        </View>
                        <TouchableOpacity style={styles.mainPlayButton} onPress={() => playbackStatus.playing ? player.pause() : player.play()}>
                            <Text style={styles.mainPlayText}>{playbackStatus.playing ? 'Ⅱ' : '▶'}</Text>
                        </TouchableOpacity>
                    </View>
                )}


            </SafeAreaView>
        </SafeAreaProvider>

    );
}

const styles = StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: '#0A0E18' },
    header: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    logo: { color: '#F4F6FC', fontSize: 27, fontWeight: '900', letterSpacing: 3 },
    subtitle: { color: '#8792A9', marginTop: 2, fontSize: 10, letterSpacing: 1.2 },
    headerDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#B9F56D' },
    tabs: { flexDirection: 'row', marginHorizontal: 14, marginBottom: 10, padding: 4, borderRadius: 13, backgroundColor: '#151B2B' },
    tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 5, borderRadius: 10 },
    tabActive: { backgroundColor: '#B9F56D' },
    tabText: { color: '#A5ADC0', fontSize: 12, fontWeight: '800' },
    tabTextActive: { color: '#111827' },
    panel: { flex: 1, paddingHorizontal: 12, paddingBottom: 5 },
    searchRow: { flexDirection: 'row', gap: 7, marginBottom: 8 },
    searchInput: { flex: 1, minWidth: 0, backgroundColor: '#151B2B', borderRadius: 11, color: '#F4F6FC', paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#283149', fontSize: 13 },
    searchButton: { paddingHorizontal: 13, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#B9F56D' },
    searchButtonText: { color: '#111827', fontSize: 11, fontWeight: '900' },
    browserToolbar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 7 },
    smallButton: { borderRadius: 9, backgroundColor: '#242D42', paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
    smallButtonText: { color: '#DCE3F2', fontSize: 11, fontWeight: '700' },
    disabledButton: { opacity: 0.35 },
    downloadPageButton: { backgroundColor: '#B9F56D', flex: 1 },
    downloadPageText: { color: '#111827', fontSize: 11, fontWeight: '900' },
    pageTitle: { color: '#8994A8', fontSize: 10, marginBottom: 5 },
    spinner: { position: 'absolute', right: 20, top: 86, zIndex: 2 },
    webView: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 10, overflow: 'hidden' },
    notice: { color: '#8D98AE', fontSize: 10, lineHeight: 14, paddingTop: 5, paddingBottom: 2 },
    libraryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
    libraryHeadingWrap: { flex: 1, paddingRight: 10 },
    sectionTitle: { color: '#F4F6FC', fontSize: 22, fontWeight: '900' },
    sectionHint: { color: '#8792A9', marginTop: 4, fontSize: 11, lineHeight: 15 },
    listContent: { paddingBottom: 12 },
    trackCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#151B2B', borderRadius: 13, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: '#242D42' },
    trackPlay: { width: 42, height: 42, borderRadius: 12, backgroundColor: '#242D42', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    trackPlayText: { color: '#B9F56D', fontSize: 17, fontWeight: '900' },
    trackDetails: { flex: 1 },
    trackName: { color: '#F4F6FC', fontSize: 13, fontWeight: '800', lineHeight: 18 },
    trackSub: { color: '#929CB0', fontSize: 10, marginTop: 3 },
    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
    emptyTitle: { color: '#F4F6FC', fontSize: 18, fontWeight: '800', marginBottom: 7 },
    emptyText: { color: '#8D98AE', fontSize: 12, textAlign: 'center', lineHeight: 18 },
    nowPlaying: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#283149', backgroundColor: '#101625' },
    nowPlayingInfo: { flex: 1, paddingRight: 10 },
    nowPlayingLabel: { color: '#B9F56D', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
    nowPlayingName: { color: '#F4F6FC', fontSize: 12, fontWeight: '700', marginTop: 3 },
    mainPlayButton: { width: 42, height: 42, borderRadius: 15, backgroundColor: '#B9F56D', alignItems: 'center', justifyContent: 'center' },
    mainPlayText: { color: '#111827', fontSize: 17, fontWeight: '900' },
});
