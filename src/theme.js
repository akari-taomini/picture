/** Fields used by SillyTavern 1.19.0's official getThemeObject(). */
export const THEME_FIELDS = Object.freeze([
    'blur_strength',
    'main_text_color',
    'italics_text_color',
    'underline_text_color',
    'quote_text_color',
    'blur_tint_color',
    'chat_tint_color',
    'user_mes_blur_tint_color',
    'bot_mes_blur_tint_color',
    'shadow_color',
    'shadow_width',
    'border_color',
    'font_scale',
    'fast_ui_mode',
    'waifuMode',
    'avatar_style',
    'chat_display',
    'toastr_position',
    'noShadows',
    'chat_width',
    'timer_enabled',
    'timestamps_enabled',
    'timestamp_model_icon',
    'mesIDDisplay_enabled',
    'hideChatAvatars_enabled',
    'message_token_count_enabled',
    'expand_message_actions',
    'enableZenSliders',
    'enableLabMode',
    'hotswap_enabled',
    'custom_css',
    'bogus_folders',
    'zoomed_avatar_magnification',
    'reduced_motion',
    'compact_input_area',
    'show_swipe_num_all_messages',
    'click_to_edit',
    'media_display',
]);

export function cloneJson(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function validateTheme(theme) {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
        throw new Error('主题 JSON 必须是一个对象。');
    }
    if (typeof theme.name !== 'string' || !theme.name.trim()) {
        throw new Error('主题 JSON 缺少有效的 name 字段。');
    }
    if (theme.custom_css !== undefined && typeof theme.custom_css !== 'string') {
        throw new Error('主题 JSON 的 custom_css 必须是字符串。');
    }
    return theme;
}

export async function readThemeFile(file) {
    if (!(file instanceof Blob)) throw new Error('没有选择有效的 JSON 文件。');
    const text = await file.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`主题 JSON 解析失败：${error.message}`);
    }
    return validateTheme(parsed);
}

export function readCurrentTheme() {
    const context = globalThis.SillyTavern?.getContext?.();
    const powerUser = context?.powerUserSettings;
    if (!powerUser) throw new Error('无法读取 SillyTavern 当前主题设置。');

    const theme = { name: String(powerUser.theme || 'Current Theme') };
    for (const field of THEME_FIELDS) {
        if (Object.hasOwn(powerUser, field)) theme[field] = cloneJson(powerUser[field]);
    }
    if (typeof theme.custom_css !== 'string') theme.custom_css = '';
    return validateTheme(theme);
}

/**
 * Keep Chinese/English names while removing path-hostile characters.
 */
export function sanitizeThemeDirectory(name) {
    let value = String(name || '').normalize('NFC');
    value = value.replace(/[\u0000-\u001F\u007F]/g, '');
    value = value.replace(/[\\/<>:"|?*]/g, '-');
    value = value.replace(/\.{2,}/g, '.');
    value = value.replace(/[. ]+$/g, '').trim();
    if (!value || value === '.' || value === '..') value = 'Unnamed-Theme';
    return Array.from(value).slice(0, 120).join('');
}

function isImportStatement(css, functionStart) {
    const prevSemicolon = css.lastIndexOf(';', functionStart - 1);
    const prevOpen = css.lastIndexOf('{', functionStart - 1);
    const prevClose = css.lastIndexOf('}', functionStart - 1);
    const start = Math.max(prevSemicolon, prevOpen, prevClose) + 1;
    return /@import\b/i.test(css.slice(start, functionStart));
}

function isNameBoundary(ch) {
    return !ch || !/[\w-]/.test(ch);
}

/**
 * Lightweight CSS url() scanner. It preserves exact source offsets so replacement
 * changes only the URL text, not quote style or surrounding formatting.
 */
export function scanCssUrls(css) {
    const text = String(css || '');
    const found = [];
    let i = 0;

    while (i < text.length) {
        if (text[i] === '"' || text[i] === "'") {
            const quote = text[i++];
            let escaped = false;
            while (i < text.length) {
                const ch = text[i++];
                if (!escaped && ch === quote) break;
                if (!escaped && ch === '\\') escaped = true;
                else escaped = false;
            }
            continue;
        }

        if (text[i] === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }

        if (text.slice(i, i + 3).toLowerCase() !== 'url' || !isNameBoundary(text[i - 1])) {
            i += 1;
            continue;
        }

        let p = i + 3;
        while (/\s/.test(text[p] || '')) p += 1;
        if (text[p] !== '(') {
            i += 3;
            continue;
        }

        const functionStart = i;
        p += 1;
        while (/\s/.test(text[p] || '')) p += 1;

        let urlStart = p;
        let urlEnd = p;
        let quote = '';

        if (text[p] === '"' || text[p] === "'") {
            quote = text[p];
            urlStart = ++p;
            let escaped = false;
            while (p < text.length) {
                const ch = text[p];
                if (!escaped && ch === quote) break;
                if (!escaped && ch === '\\') escaped = true;
                else escaped = false;
                p += 1;
            }
            if (p >= text.length) {
                i += 3;
                continue;
            }
            urlEnd = p;
            p += 1;
            while (/\s/.test(text[p] || '')) p += 1;
            if (text[p] !== ')') {
                i += 3;
                continue;
            }
        } else {
            let escaped = false;
            while (p < text.length) {
                const ch = text[p];
                if (!escaped && ch === ')') break;
                if (!escaped && ch === '\\') escaped = true;
                else escaped = false;
                p += 1;
            }
            if (p >= text.length) {
                i += 3;
                continue;
            }
            urlEnd = p;
            while (urlEnd > urlStart && /\s/.test(text[urlEnd - 1])) urlEnd -= 1;
        }

        const functionEnd = p + 1;
        const rawUrl = text.slice(urlStart, urlEnd).trim();
        const isImport = isImportStatement(text, functionStart);

        if (!isImport && /^https?:\/\//i.test(rawUrl)) {
            try {
                const parsed = new URL(rawUrl);
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                    found.push({
                        url: rawUrl,
                        start: urlStart,
                        end: urlEnd,
                        quote,
                        functionStart,
                        functionEnd,
                    });
                }
            } catch {
                // Ignore malformed URLs; CSS stays untouched.
            }
        }

        i = functionEnd;
    }

    return found;
}

export function getUniqueRemoteUrls(css) {
    return [...new Set(scanCssUrls(css).map(item => item.url))];
}

export function replaceCssUrls(css, replacements) {
    const source = String(css || '');
    const occurrences = scanCssUrls(source)
        .filter(item => replacements.has(item.url))
        .sort((a, b) => b.start - a.start);

    let output = source;
    for (const item of occurrences) {
        output = output.slice(0, item.start) + replacements.get(item.url) + output.slice(item.end);
    }
    return output;
}

export function makePublishedTheme(theme, replacements) {
    const result = cloneJson(theme);
    result.custom_css = replaceCssUrls(result.custom_css || '', replacements);
    return result;
}

export function safeDownloadFileName(themeName) {
    return `${sanitizeThemeDirectory(themeName)}_发布版.json`;
}
