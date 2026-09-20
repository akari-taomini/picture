import { fetchRemoteAsset, scanThemeAssets, summarizeAssets, deduplicateReadyItems } from './assets.js';
import { GitHubClient, makeJsDelivrUrl, validateGitHubConfig } from './github.js';
import { makePublishedTheme, sanitizeThemeDirectory, validateTheme } from './theme.js';

export class ThemePublisher {
    constructor(config) {
        this.config = config;
        this.github = null;
        this.theme = null;
        this.scan = null;
    }

    getGitHub() {
        validateGitHubConfig(this.config);
        if (!this.github) this.github = new GitHubClient(this.config);
        return this.github;
    }

    setTheme(theme) {
        this.theme = validateTheme(theme);
        this.scan = null;
        return this.theme;
    }

    async testGitHub() {
        return await this.getGitHub().testConnection();
    }

    async scanTheme({ onProgress = () => {}, signal } = {}) {
        if (!this.theme) throw new Error('请先读取当前主题或选择主题 JSON。');
        const themeDir = sanitizeThemeDirectory(this.theme.name);
        const scan = await scanThemeAssets(this.theme, { onProgress, signal });
        const readyUnique = [...scan.canonical.values()];
        for (const asset of readyUnique) asset.repoPath = `${themeDir}/${asset.fileName}`;

        if (readyUnique.length) {
            const github = this.getGitHub();
            const state = await github.resolveExisting(readyUnique.map(asset => asset.repoPath));
            for (const asset of readyUnique) asset.exists = Boolean(state.exists.get(asset.repoPath));
            for (const item of scan.items) {
                if (item.status === 'ready') {
                    const canonical = scan.canonical.get(item.hash);
                    item.repoPath = canonical.repoPath;
                    item.exists = canonical.exists;
                }
            }
            scan.githubTreeTruncated = state.truncated;
        }

        this.scan = { ...scan, themeDir };
        return this.getScanState();
    }

    getScanState() {
        if (!this.scan) return null;
        return {
            ...this.scan,
            summary: summarizeAssets(this.scan.items),
        };
    }

    async retry(url) {
        if (!this.scan) throw new Error('请先扫描主题。');
        const index = this.scan.items.findIndex(item => item.url === url);
        if (index === -1) throw new Error('找不到该素材。');

        const previous = this.scan.items[index];
        const retried = await fetchRemoteAsset(url);
        if (retried.status === 'failed') retried.keepOriginal = Boolean(previous.keepOriginal);
        this.scan.items[index] = retried;
        this.scan.canonical = deduplicateReadyItems(this.scan.items);

        if (retried.status === 'ready') {
            const canonical = this.scan.canonical.get(retried.hash);
            canonical.repoPath = `${this.scan.themeDir}/${canonical.fileName}`;
            canonical.exists = await this.getGitHub().fileExists(canonical.repoPath);
            for (const item of this.scan.items) {
                if (item.status === 'ready' && item.hash === canonical.hash) {
                    item.repoPath = canonical.repoPath;
                    item.exists = canonical.exists;
                }
            }
        }
        return this.getScanState();
    }

    keepOriginal(url, keep = true) {
        if (!this.scan) throw new Error('请先扫描主题。');
        const item = this.scan.items.find(entry => entry.url === url);
        if (!item) throw new Error('找不到该素材。');
        item.keepOriginal = Boolean(keep);
        return this.getScanState();
    }

    async publish({ onProgress = () => {} } = {}) {
        if (!this.theme || !this.scan) throw new Error('请先完成主题扫描。');
        const summary = summarizeAssets(this.scan.items);
        if (summary.failed > 0) throw new Error('仍有读取失败素材。请重新尝试，或选择“保留原链接”。');

        const canonical = deduplicateReadyItems(this.scan.items);
        const assets = [...canonical.values()];
        for (const asset of assets) asset.repoPath = `${this.scan.themeDir}/${asset.fileName}`;

        const githubResult = await this.getGitHub().commitAssets({
            themeName: this.theme.name,
            assets,
            onProgress,
        });

        const replacements = new Map();
        for (const item of this.scan.items) {
            if (item.status !== 'ready' || item.keepOriginal) continue;
            const asset = canonical.get(item.hash);
            replacements.set(item.url, makeJsDelivrUrl(this.config, githubResult.commitSha, asset.repoPath));
        }

        const publishedTheme = makePublishedTheme(this.theme, replacements);
        const publishedJson = JSON.stringify(publishedTheme, null, 4);

        // Release image bytes after publication. The UI keeps only metadata + JSON.
        for (const asset of assets) asset.blob = null;
        for (const item of this.scan.items) item.blob = null;

        return {
            ...githubResult,
            preserved: this.scan.items.filter(item => item.keepOriginal).length,
            publishedTheme,
            publishedJson,
            replacements,
        };
    }
}
