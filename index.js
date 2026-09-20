import { ThemePublisherUI } from './src/ui.js';

/**
 * ================================================================
 * 只需要填写这里。不要把配置好的插件公开发布，因为 Token 会在源码中可见。
 * ================================================================
 */
export const CONFIG = Object.freeze({
    githubOwner: 'akari-taomini',
    githubRepo: 'picture',
    githubBranch: 'main', // 例如 main
    githubToken: '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',
});

const EXTENSION_ID = 'theme-publisher';
let ui = null;

function ensureUI() {
    if (ui) return ui;
    ui = new ThemePublisherUI({ extensionId: EXTENSION_ID, config: CONFIG });
    ui.mount();
    return ui;
}

export async function init() {
    ensureUI();
}

export async function onEnable() {
    ensureUI();
}

export async function onDisable() {
    ui?.unmount();
    ui = null;
}

export async function onUpdate() {
    ui?.unmount();
    ui = null;
    ensureUI();
}

export async function onClean() {
    ui?.unmount();
    ui = null;
}
