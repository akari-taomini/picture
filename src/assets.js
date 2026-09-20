import { getUniqueRemoteUrls } from './theme.js';

export const JSDELIVR_GITHUB_FILE_LIMIT = 20 * 1024 * 1024;

function browserFetch(...args) {
    if (typeof globalThis.fetch !== 'function') throw new Error('当前浏览器环境不支持 fetch。');
    return globalThis.fetch.call(globalThis, ...args);
}

function ascii(bytes, start, length) {
    return String.fromCharCode(...bytes.slice(start, start + length));
}

export function sniffImageType(buffer) {
    const bytes = new Uint8Array(buffer);

    if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0D && bytes[5] === 0x0A) {
        return { mime: 'image/png', ext: 'png' };
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { mime: 'image/jpeg', ext: 'jpg' };
    }
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
        return { mime: 'image/webp', ext: 'webp' };
    }
    if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
        return { mime: 'image/gif', ext: 'gif' };
    }
    if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
        const brandBytes = bytes.slice(8, Math.min(bytes.length, 64));
        const brands = ascii(brandBytes, 0, brandBytes.length);
        if (brands.includes('avif') || brands.includes('avis')) {
            return { mime: 'image/avif', ext: 'avif' };
        }
    }

    const sampleBytes = bytes.slice(0, Math.min(bytes.length, 4096));
    let sample = new TextDecoder('utf-8', { fatal: false }).decode(sampleBytes);
    sample = sample.replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(sample) || /^<svg\b/i.test(sample)) {
        return { mime: 'image/svg+xml', ext: 'svg' };
    }

    return null;
}

export async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function buildProxyUrl(url) {
    return `/proxy/${encodeURIComponent(url)}`;
}

async function responseToAnalyzedAsset(response, url, source) {
    if (!response.ok) throw new Error(`${source} HTTP ${response.status}`);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const type = sniffImageType(buffer);
    if (!type) throw new Error('资源不是受支持的 PNG/JPG/WebP/GIF/SVG/AVIF 图片');
    if (buffer.byteLength > JSDELIVR_GITHUB_FILE_LIMIT) {
        throw new Error(`图片大小 ${Math.ceil(buffer.byteLength / 1024 / 1024)} MB，超过 jsDelivr GitHub 单文件默认 20 MB 限制`);
    }
    const hash = await sha256Hex(buffer);
    const normalizedBlob = new Blob([buffer], { type: type.mime });
    return {
        url,
        status: 'ready',
        source,
        mime: type.mime,
        ext: type.ext,
        size: normalizedBlob.size,
        hash,
        shortHash: hash.slice(0, 16),
        fileName: `${hash.slice(0, 16)}.${type.ext}`,
        blob: normalizedBlob,
        keepOriginal: false,
        exists: false,
        error: '',
    };
}

export async function fetchRemoteAsset(url, { signal } = {}) {
    const directOptions = {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        signal,
    };

    let directError = null;
    try {
        const response = await browserFetch(url, directOptions);
        return await responseToAnalyzedAsset(response, url, 'direct');
    } catch (error) {
        directError = error;
    }

    try {
        const response = await browserFetch(buildProxyUrl(url), {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            signal,
        });
        return await responseToAnalyzedAsset(response, url, 'st-proxy');
    } catch (proxyError) {
        return {
            url,
            status: 'failed',
            source: '',
            mime: '',
            ext: '',
            size: 0,
            hash: '',
            shortHash: '',
            fileName: '',
            blob: null,
            keepOriginal: false,
            exists: false,
            error: `直连失败：${directError?.message || directError}; ST 代理失败：${proxyError?.message || proxyError}`,
        };
    }
}

export async function mapLimit(values, limit, mapper) {
    const items = Array.from(values);
    const results = new Array(items.length);
    let cursor = 0;

    async function worker() {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            results[index] = await mapper(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
    return results;
}

export function deduplicateReadyItems(items) {
    const canonical = new Map();
    for (const item of items) {
        if (item.status !== 'ready') continue;
        const key = item.hash;
        if (!canonical.has(key)) {
            canonical.set(key, item);
            item.duplicateOf = null;
        } else {
            const original = canonical.get(key);
            item.duplicateOf = original.url;
            item.blob = original.blob;
            item.fileName = original.fileName;
            item.mime = original.mime;
            item.ext = original.ext;
            item.size = original.size;
        }
    }
    return canonical;
}

export async function scanThemeAssets(theme, { concurrency = 4, onProgress = () => {}, signal } = {}) {
    const urls = getUniqueRemoteUrls(theme.custom_css || '');
    let completed = 0;
    const items = await mapLimit(urls, concurrency, async (url) => {
        const item = await fetchRemoteAsset(url, { signal });
        completed += 1;
        onProgress({ completed, total: urls.length, item });
        return item;
    });
    const canonical = deduplicateReadyItems(items);
    return { urls, items, canonical };
}

export function summarizeAssets(items) {
    const canonical = new Map();
    let failed = 0;
    let preserved = 0;
    for (const item of items) {
        if (item.status === 'failed' && !item.keepOriginal) failed += 1;
        if (item.keepOriginal) preserved += 1;
        if (item.status === 'ready' && !canonical.has(item.hash)) canonical.set(item.hash, item);
    }
    return {
        references: items.length,
        uniqueAssets: canonical.size,
        totalBytes: [...canonical.values()].reduce((sum, item) => sum + item.size, 0),
        failed,
        preserved,
    };
}
