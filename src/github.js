import { mapLimit } from './assets.js';

const API_VERSION = '2022-11-28';

export function validateGitHubConfig(config) {
    const missing = [];
    if (!config?.githubOwner || config.githubOwner === 'GITHUB_OWNER') missing.push('GITHUB_OWNER');
    if (!config?.githubRepo || config.githubRepo === 'GITHUB_REPO') missing.push('GITHUB_REPO');
    if (!config?.githubBranch || config.githubBranch === 'GITHUB_BRANCH') missing.push('GITHUB_BRANCH');
    if (!config?.githubToken || config.githubToken === 'GITHUB_TOKEN') missing.push('GITHUB_TOKEN');
    if (missing.length) throw new Error(`请先在 index.js 顶部填写：${missing.join(', ')}`);
}

function encodePath(path) {
    return String(path).split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function encodeRef(ref) {
    return String(ref).split('/').map(segment => encodeURIComponent(segment)).join('/');
}

async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

export class GitHubClient {
    constructor(config, fetchImpl = fetch) {
        validateGitHubConfig(config);
        this.config = config;
        this.fetch = fetchImpl;
        this.base = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}`;
    }

    async request(path, options = {}) {
        const response = await this.fetch(`${this.base}${path}`, {
            ...options,
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${this.config.githubToken}`,
                'X-GitHub-Api-Version': API_VERSION,
                ...(options.headers || {}),
            },
        });

        let body = null;
        const text = await response.text();
        if (text) {
            try { body = JSON.parse(text); } catch { body = text; }
        }

        if (!response.ok) {
            const detail = typeof body === 'object' ? (body?.message || JSON.stringify(body)) : body;
            const error = new Error(`GitHub API ${response.status}: ${detail || response.statusText}`);
            error.status = response.status;
            error.body = body;
            throw error;
        }
        return body;
    }

    async testConnection() {
        const repo = await this.request('');
        if (repo?.private === true) {
            throw new Error('GitHub 仓库是私有仓库。jsDelivr 不支持私有 GitHub 仓库，请将素材仓库设为 Public。');
        }
        const branch = await this.getBranchState();
        const canPush = repo?.permissions?.push === true || repo?.permissions?.admin === true || repo?.permissions?.maintain === true;
        if (!canPush) throw new Error('仓库可以读取，但当前 Token/账号没有检测到写入权限（permissions.push=false）。');
        return {
            ok: true,
            repository: repo.full_name,
            branch: this.config.githubBranch,
            head: branch.commitSha,
            canPush,
        };
    }

    async getBranchState() {
        const ref = await this.request(`/git/ref/heads/${encodeRef(this.config.githubBranch)}`);
        const commitSha = ref?.object?.sha;
        if (!commitSha) throw new Error('无法读取 branch HEAD。');
        const commit = await this.request(`/git/commits/${commitSha}`);
        const treeSha = commit?.tree?.sha;
        if (!treeSha) throw new Error('无法读取 branch tree。');
        return { commitSha, treeSha };
    }

    async getTree(treeSha) {
        const result = await this.request(`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
        return {
            paths: new Set((result?.tree || []).map(entry => entry.path)),
            truncated: Boolean(result?.truncated),
        };
    }

    async fileExists(path) {
        try {
            await this.request(`/contents/${encodePath(path)}?ref=${encodeURIComponent(this.config.githubBranch)}`);
            return true;
        } catch (error) {
            if (error.status === 404) return false;
            throw error;
        }
    }

    async createBlob(blob) {
        const content = await blobToBase64(blob);
        const result = await this.request('/git/blobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, encoding: 'base64' }),
        });
        if (!result?.sha) throw new Error('GitHub create blob 未返回 SHA。');
        return result.sha;
    }

    async createTree(baseTreeSha, entries) {
        if (!entries.length) return baseTreeSha;
        const result = await this.request('/git/trees', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
        });
        if (!result?.sha) throw new Error('GitHub create tree 未返回 SHA。');
        return result.sha;
    }

    async createCommit(message, treeSha, parentSha) {
        const result = await this.request('/git/commits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
        });
        if (!result?.sha) throw new Error('GitHub create commit 未返回 SHA。');
        return result.sha;
    }

    async updateBranchRef(commitSha) {
        return await this.request(`/git/refs/heads/${encodeRef(this.config.githubBranch)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sha: commitSha, force: false }),
        });
    }

    async resolveExisting(paths, treeState = null) {
        const branch = treeState || await this.getBranchState();
        const tree = await this.getTree(branch.treeSha);
        const exists = new Map();
        if (!tree.truncated) {
            for (const path of paths) exists.set(path, tree.paths.has(path));
            return { ...branch, exists, truncated: false };
        }
        const checks = await mapLimit(paths, 4, path => this.fileExists(path));
        paths.forEach((path, index) => exists.set(path, checks[index]));
        return { ...branch, exists, truncated: true };
    }

    /**
     * Commit all new assets in one tree/commit and then fast-forward the branch.
     * Existing files are reused. A no-op asset set still gets a new commit so each
     * exported theme can pin a unique immutable commit SHA.
     */
    async commitAssets({ themeName, assets, onProgress = () => {} }) {
        const blobShas = new Map();
        let lastConflict = null;

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const branch = await this.getBranchState();
            const paths = assets.map(asset => asset.repoPath);
            const state = await this.resolveExisting(paths, branch);
            const missing = assets.filter(asset => !state.exists.get(asset.repoPath));

            const toUpload = missing.filter(asset => !blobShas.has(asset.hash));
            let completed = 0;
            await mapLimit(toUpload, 3, async (asset) => {
                const sha = await this.createBlob(asset.blob);
                blobShas.set(asset.hash, sha);
                completed += 1;
                onProgress({ phase: 'upload', completed, total: toUpload.length, asset });
            });

            const entries = missing.map(asset => ({
                path: asset.repoPath,
                mode: '100644',
                type: 'blob',
                sha: blobShas.get(asset.hash),
            }));

            const treeSha = await this.createTree(state.treeSha, entries);
            const commitSha = await this.createCommit(`Publish theme: ${themeName}`, treeSha, state.commitSha);

            try {
                await this.updateBranchRef(commitSha);
                return {
                    commitSha,
                    added: missing.length,
                    reused: assets.length - missing.length,
                    uploadedBlobs: blobShas.size,
                    treeTruncated: state.truncated,
                };
            } catch (error) {
                lastConflict = error;
                if (attempt >= 2 || ![409, 422].includes(error.status)) throw error;
                onProgress({ phase: 'retry-ref', completed: attempt, total: 2 });
            }
        }
        throw lastConflict || new Error('GitHub branch 更新失败。');
    }
}

export function makeJsDelivrUrl(config, commitSha, repoPath) {
    const encodedPath = encodePath(repoPath);
    return `https://cdn.jsdelivr.net/gh/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}@${encodeURIComponent(commitSha)}/${encodedPath}`;
}
