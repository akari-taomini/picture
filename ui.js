import { ThemePublisher } from './publisher.js';
import { readCurrentTheme, readThemeFile, safeDownloadFileName } from './theme.js';

const DEFAULT_SETTINGS = Object.freeze({
    lastSource: 'current',
    panelOpen: false,
    githubConnection: null,
});

function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

function shortUrl(url) {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.length > 44 ? `…${parsed.pathname.slice(-43)}` : parsed.pathname;
        return `${parsed.hostname}${path}`;
    } catch {
        return url;
    }
}

export class ThemePublisherUI {
    constructor({ extensionId, config }) {
        this.extensionId = extensionId;
        this.config = config;
        this.publisher = new ThemePublisher(config);
        this.root = null;
        this.menuEntry = null;
        this.fileInput = null;
        this.theme = null;
        this.resultUrl = null;
        this.busy = false;
        this.abortController = null;
        this.settings = null;
        this.publishReady = false;
        this.menuRetryTimer = null;
    }

    getContext() {
        return globalThis.SillyTavern?.getContext?.() || null;
    }

    getSettings() {
        const context = this.getContext();
        if (!context?.extensionSettings) return { ...DEFAULT_SETTINGS };
        const root = context.extensionSettings;
        root[this.extensionId] ??= {};
        const settings = root[this.extensionId];
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (!Object.hasOwn(settings, key)) settings[key] = value;
        }
        return settings;
    }

    saveSettings() {
        this.getContext()?.saveSettingsDebounced?.();
    }

    mount() {
        if (document.getElementById('theme_publisher_wand_entry')) return;
        this.settings = this.getSettings();
        this.injectMenuEntry();
        this.injectPanel();
        if (this.settings.panelOpen) this.open();
    }

    unmount() {
        this.abortController?.abort();
        if (this.menuRetryTimer) clearTimeout(this.menuRetryTimer);
        this.menuRetryTimer = null;
        this.revokeResultUrl();
        this.root?.remove();
        this.menuEntry?.remove();
        this.fileInput?.remove();
        this.root = null;
        this.menuEntry = null;
        this.fileInput = null;
    }

    injectMenuEntry() {
        const menu = document.querySelector('#extensionsMenu');
        if (!menu) {
            if (!this.menuRetryTimer) {
                this.menuRetryTimer = setTimeout(() => {
                    this.menuRetryTimer = null;
                    this.injectMenuEntry();
                }, 500);
            }
            return;
        }
        if (document.getElementById('theme_publisher_wand_entry')) return;
        const entry = document.createElement('div');
        entry.id = 'theme_publisher_wand_entry';
        entry.className = 'list-group-item flex-container flexGap5 interactable';
        entry.innerHTML = '<div class="fa-solid fa-cloud-arrow-up extensionsMenuExtensionButton"></div><span>主题发布</span>';
        entry.addEventListener('click', () => this.open());
        menu.append(entry);
        this.menuEntry = entry;
    }

    injectPanel() {
        const root = document.createElement('div');
        root.id = 'theme_publisher_overlay';
        root.hidden = true;
        root.innerHTML = `
            <section id="theme_publisher_panel" role="dialog" aria-modal="true" aria-labelledby="theme_publisher_title">
                <header class="tp-header">
                    <div>
                        <h2 id="theme_publisher_title">主题发布</h2>
                        <div class="tp-subtitle">远程素材 → GitHub → 固定 Commit CDN</div>
                    </div>
                    <button class="menu_button tp-icon-button" id="tp_close" type="button" aria-label="关闭">×</button>
                </header>

                <div class="tp-body">
                    <section class="tp-section tp-source-section">
                        <div class="tp-source-line">
                            <div>
                                <div class="tp-label">主题名称</div>
                                <div id="tp_theme_name" class="tp-theme-name">尚未读取主题</div>
                            </div>
                            <div class="tp-inline-actions">
                                <button class="menu_button" id="tp_current" type="button">扫描当前主题</button>
                                <button class="menu_button" id="tp_choose" type="button">选择主题 JSON</button>
                            </div>
                        </div>
                        <div class="tp-connection-line">
                            <button class="menu_button" id="tp_test_github" type="button">测试 GitHub 连接</button>
                            <span id="tp_github_status" class="tp-muted">未检测</span>
                        </div>
                    </section>

                    <section class="tp-section tp-summary">
                        <div><span class="tp-label">素材数量</span><strong id="tp_asset_count">—</strong></div>
                        <div><span class="tp-label">素材大小</span><strong id="tp_asset_size">—</strong></div>
                        <div><span class="tp-label">状态</span><strong id="tp_scan_status">等待扫描</strong></div>
                    </section>

                    <section class="tp-section tp-list-section">
                        <div class="tp-list-title">素材列表</div>
                        <div id="tp_asset_list" class="tp-asset-list">
                            <div class="tp-empty">读取主题后点击“扫描”。</div>
                        </div>
                    </section>

                    <section class="tp-section tp-progress-section" id="tp_progress_section" hidden>
                        <div class="tp-progress-head">
                            <strong id="tp_progress_title">处理中</strong>
                            <span id="tp_progress_text"></span>
                        </div>
                        <progress id="tp_progress" max="100" value="0"></progress>
                        <div id="tp_progress_stats" class="tp-muted"></div>
                    </section>

                    <section class="tp-section tp-result" id="tp_result" hidden></section>
                </div>

                <footer class="tp-footer">
                    <button class="menu_button" id="tp_scan" type="button" disabled>扫描</button>
                    <button class="menu_button" id="tp_publish" type="button" disabled>一键发布</button>
                </footer>
            </section>
        `;
        document.body.append(root);
        this.root = root;

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.hidden = true;
        document.body.append(fileInput);
        this.fileInput = fileInput;

        root.querySelector('#tp_close').addEventListener('click', () => this.close());
        root.addEventListener('pointerdown', event => {
            if (event.target === root) this.close();
        });
        root.querySelector('#tp_current').addEventListener('click', () => this.scanCurrent());
        root.querySelector('#tp_choose').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', event => this.loadFile(event.target.files?.[0]));
        root.querySelector('#tp_scan').addEventListener('click', () => this.scan());
        root.querySelector('#tp_publish').addEventListener('click', () => this.publish());
        root.querySelector('#tp_test_github').addEventListener('click', () => this.testGitHub());
        this.restoreConnectionStatus();
        this.showCurrentThemeHint();
    }


    restoreConnectionStatus() {
        const status = this.root?.querySelector('#tp_github_status');
        const saved = this.settings?.githubConnection;
        if (!status || !saved) return;
        if (saved.ok) {
            status.textContent = `✓ ${saved.repo} / ${saved.branch} · 上次检测`;
            status.className = 'tp-ok';
        } else if (saved.message) {
            status.textContent = `✕ ${saved.message} · 上次检测`;
            status.className = 'tp-error';
        }
    }

    showCurrentThemeHint() {
        if (!this.root || this.theme) return;
        const currentName = this.getContext()?.powerUserSettings?.theme;
        if (currentName) {
            this.root.querySelector('#tp_theme_name').textContent = `当前：${currentName}`;
        }
    }

    open() {
        if (!this.root) this.injectPanel();
        this.root.hidden = false;
        this.settings.panelOpen = true;
        this.saveSettings();
    }

    close() {
        if (!this.root) return;
        this.root.hidden = true;
        this.settings.panelOpen = false;
        this.saveSettings();
    }

    setBusy(value) {
        this.busy = Boolean(value);
        for (const selector of ['#tp_current', '#tp_choose', '#tp_scan', '#tp_publish', '#tp_test_github']) {
            const button = this.root.querySelector(selector);
            button.disabled = this.busy || (selector === '#tp_scan' && !this.theme) || (selector === '#tp_publish' && !this.publishReady);
        }
    }

    setTheme(theme, source) {
        this.revokeResultUrl();
        this.theme = this.publisher.setTheme(theme);
        this.publishReady = false;
        this.settings.lastSource = source;
        this.saveSettings();
        this.root.querySelector('#tp_theme_name').textContent = this.theme.name;
        this.root.querySelector('#tp_asset_count').textContent = '—';
        this.root.querySelector('#tp_asset_size').textContent = '—';
        this.root.querySelector('#tp_scan_status').textContent = '等待扫描';
        this.root.querySelector('#tp_asset_list').innerHTML = '<div class="tp-empty">主题已读取，点击“扫描”获取远程素材。</div>';
        this.root.querySelector('#tp_result').hidden = true;
        this.root.querySelector('#tp_scan').disabled = false;
        this.root.querySelector('#tp_publish').disabled = true;
    }

    async scanCurrent() {
        try {
            this.setTheme(readCurrentTheme(), 'current');
            globalThis.toastr?.success?.('已读取当前主题');
            await this.scan();
        } catch (error) {
            this.showError(error);
        }
    }

    async loadFile(file) {
        if (!file) return;
        try {
            this.setBusy(true);
            const theme = await readThemeFile(file);
            this.setTheme(theme, 'file');
            globalThis.toastr?.success?.(`已读取：${theme.name}`);
        } catch (error) {
            this.showError(error);
        } finally {
            this.fileInput.value = '';
            this.setBusy(false);
        }
    }

    async testGitHub() {
        const status = this.root.querySelector('#tp_github_status');
        try {
            this.setBusy(true);
            status.textContent = '检测中…';
            const result = await this.publisher.testGitHub();
            status.textContent = `✓ ${result.repository} / ${result.branch}`;
            status.className = 'tp-ok';
            this.settings.githubConnection = { ok: true, at: Date.now(), repo: result.repository, branch: result.branch };
            this.saveSettings();
        } catch (error) {
            status.textContent = `✕ ${error.message}`;
            status.className = 'tp-error';
            this.settings.githubConnection = { ok: false, at: Date.now(), message: error.message };
            this.saveSettings();
        } finally {
            this.setBusy(false);
        }
    }

    async scan() {
        try {
            this.setBusy(true);
            this.abortController?.abort();
            this.abortController = new AbortController();
            this.showProgress('正在扫描', 0, 1, '获取远程图片并计算 SHA-256…');
            const state = await this.publisher.scanTheme({
                signal: this.abortController.signal,
                onProgress: ({ completed, total }) => this.showProgress('正在扫描', completed, total || 1, `${completed} / ${total}`),
            });
            this.renderScan(state);
            this.hideProgress();
        } catch (error) {
            this.showError(error);
            this.hideProgress();
        } finally {
            this.setBusy(false);
        }
    }

    renderScan(state) {
        const { summary, items } = state;
        this.publishReady = summary.failed === 0;
        this.root.querySelector('#tp_asset_count').textContent = `${summary.uniqueAssets} 张`;
        this.root.querySelector('#tp_asset_size').textContent = formatBytes(summary.totalBytes);
        const dupCount = Math.max(0, summary.references - summary.uniqueAssets - items.filter(x => x.status === 'failed').length);
        this.root.querySelector('#tp_scan_status').textContent = summary.failed
            ? `${summary.failed} 项读取失败`
            : `完成${dupCount ? ` · 去重 ${dupCount}` : ''}`;

        const list = this.root.querySelector('#tp_asset_list');
        if (!items.length) {
            list.innerHTML = '<div class="tp-empty">custom_css 中没有需要迁移的 HTTP/HTTPS 图片。</div>';
            return;
        }

        list.innerHTML = items.map((item, index) => {
            if (item.status === 'ready') {
                const badge = item.exists ? '复用' : (item.duplicateOf ? '重复' : '新增');
                return `<article class="tp-asset tp-ready" data-index="${index}">
                    <div class="tp-asset-main">
                        <span class="tp-status-icon">✓</span>
                        <div class="tp-asset-info">
                            <div class="tp-asset-url" title="${escapeHtml(item.url)}">${escapeHtml(shortUrl(item.url))}</div>
                            <div class="tp-asset-meta">${formatBytes(item.size)} · ${escapeHtml(item.mime)} · ${escapeHtml(item.shortHash)} · ${badge}</div>
                        </div>
                    </div>
                </article>`;
            }

            return `<article class="tp-asset tp-failed" data-index="${index}">
                <div class="tp-asset-main">
                    <span class="tp-status-icon">!</span>
                    <div class="tp-asset-info">
                        <div class="tp-asset-url" title="${escapeHtml(item.url)}">${escapeHtml(shortUrl(item.url))}</div>
                        <div class="tp-asset-meta tp-error">读取失败${item.keepOriginal ? ' · 将保留原链接' : ''}</div>
                        <div class="tp-asset-error" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</div>
                    </div>
                </div>
                <div class="tp-item-actions">
                    <button class="menu_button tp-retry" data-url="${encodeURIComponent(item.url)}" type="button">重新尝试</button>
                    <button class="menu_button tp-preserve" data-url="${encodeURIComponent(item.url)}" type="button">${item.keepOriginal ? '取消保留' : '保留原链接'}</button>
                </div>
            </article>`;
        }).join('');

        list.querySelectorAll('.tp-retry').forEach(button => button.addEventListener('click', () => this.retry(decodeURIComponent(button.dataset.url))));
        list.querySelectorAll('.tp-preserve').forEach(button => button.addEventListener('click', () => this.togglePreserve(decodeURIComponent(button.dataset.url))));
    }

    async retry(url) {
        try {
            this.setBusy(true);
            const state = await this.publisher.retry(url);
            this.renderScan(state);
        } catch (error) {
            this.showError(error);
        } finally {
            this.setBusy(false);
        }
    }

    togglePreserve(url) {
        try {
            const item = this.publisher.scan?.items.find(entry => entry.url === url);
            const state = this.publisher.keepOriginal(url, !item?.keepOriginal);
            this.renderScan(state);
        } catch (error) {
            this.showError(error);
        }
    }

    async publish() {
        try {
            this.setBusy(true);
            this.showProgress('正在发布', 0, 1, '准备 GitHub commit…');
            let uploadTotal = 0;
            let uploadCompleted = 0;
            const result = await this.publisher.publish({
                onProgress: event => {
                    if (event.phase === 'upload') {
                        uploadTotal = event.total;
                        uploadCompleted = event.completed;
                        this.showProgress('正在发布', uploadCompleted, uploadTotal || 1, `${uploadCompleted} / ${uploadTotal} 个新增素材`);
                    } else if (event.phase === 'retry-ref') {
                        this.showProgress('正在发布', 1, 2, 'Branch 刚刚有更新，正在安全重试…');
                    }
                },
            });
            this.hideProgress();
            this.showResult(result);
            this.publishReady = false;
        } catch (error) {
            this.showError(error);
            this.hideProgress();
        } finally {
            this.setBusy(false);
        }
    }

    showProgress(title, completed, total, detail = '') {
        const section = this.root.querySelector('#tp_progress_section');
        section.hidden = false;
        this.root.querySelector('#tp_progress_title').textContent = title;
        this.root.querySelector('#tp_progress_text').textContent = detail;
        const progress = this.root.querySelector('#tp_progress');
        progress.max = Math.max(1, total || 1);
        progress.value = Math.min(progress.max, completed || 0);
        this.root.querySelector('#tp_progress_stats').textContent = total ? `${completed} / ${total}` : '';
    }

    hideProgress() {
        this.root.querySelector('#tp_progress_section').hidden = true;
    }

    showResult(result) {
        this.revokeResultUrl();
        const blob = new Blob([result.publishedJson], { type: 'application/json;charset=utf-8' });
        this.resultUrl = URL.createObjectURL(blob);
        const resultSection = this.root.querySelector('#tp_result');
        resultSection.hidden = false;
        resultSection.innerHTML = `
            <div class="tp-result-title">发布完成</div>
            <div class="tp-result-grid">
                <span>新增素材</span><strong>${result.added}</strong>
                <span>复用素材</span><strong>${result.reused}</strong>
                <span>保留原链接</span><strong>${result.preserved}</strong>
            </div>
            <div class="tp-checks">
                <div>✓ GitHub 上传完成</div>
                <div>✓ Commit 固定 CDN 已生成</div>
                <div>✓ 发布版主题 JSON 已生成</div>
            </div>
            <div class="tp-commit">Commit: <code>${escapeHtml(result.commitSha)}</code></div>
            <button class="menu_button" id="tp_download" type="button">下载发布版 JSON</button>
        `;
        resultSection.querySelector('#tp_download').addEventListener('click', () => {
            const anchor = document.createElement('a');
            anchor.href = this.resultUrl;
            anchor.download = safeDownloadFileName(this.theme.name);
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
        });
    }

    revokeResultUrl() {
        if (this.resultUrl) URL.revokeObjectURL(this.resultUrl);
        this.resultUrl = null;
    }

    showError(error) {
        console.error('[Theme Publisher]', error);
        globalThis.toastr?.error?.(error?.message || String(error), '主题发布');
    }
}
