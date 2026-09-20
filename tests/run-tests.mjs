import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCssUrls, replaceCssUrls, sanitizeThemeDirectory, makePublishedTheme, THEME_FIELDS, validateTheme } from '../src/theme.js';
import { sniffImageType, sha256Hex, JSDELIVR_GITHUB_FILE_LIMIT } from '../src/assets.js';
import { GitHubClient, makeJsDelivrUrl } from '../src/github.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function u8(...nums) { return new Uint8Array(nums).buffer; }

async function testCssScanAndReplace() {
    const css = `
/* url("https://ignored.example/comment.png") */
.x::after { content: 'url(https://ignored.example/string.png)'; }
@import url("https://fonts.example/font.css");
:root { --img-a: url("https://a.example/a.png"); --img-b:url('https://b.example/b.webp'); }
.x{background-image:url(https://c.example/c.jpg);mask-image: url( "https://a.example/a.png" );}
`;
    const found = scanCssUrls(css).map(x => x.url);
    assert.deepEqual(found, [
        'https://a.example/a.png',
        'https://b.example/b.webp',
        'https://c.example/c.jpg',
        'https://a.example/a.png',
    ]);
    const out = replaceCssUrls(css, new Map([
        ['https://a.example/a.png', 'https://cdn.example/a.png'],
        ['https://b.example/b.webp', 'https://cdn.example/b.webp'],
    ]));
    assert.match(out, /@import url\("https:\/\/fonts\.example\/font\.css"\)/);
    assert.equal((out.match(/https:\/\/cdn\.example\/a\.png/g) || []).length, 2);
    assert.match(out, /url\('https:\/\/cdn\.example\/b\.webp'\)/);
    assert.match(out, /url\(https:\/\/c\.example\/c\.jpg\)/);
}

async function testThemePreservation() {
    const theme = { name: '测试 / Theme:*?', custom_css: '.a{background:url("https://x/a.png")}', future_field: { ok: true } };
    const pub = makePublishedTheme(theme, new Map([['https://x/a.png', 'https://cdn/x.png']]));
    assert.equal(theme.custom_css, '.a{background:url("https://x/a.png")}');
    assert.deepEqual(pub.future_field, { ok: true });
    assert.equal(pub.custom_css, '.a{background:url("https://cdn/x.png")}');
    assert.equal(sanitizeThemeDirectory(theme.name), '测试 - Theme---');
}

async function testSniffersAndHash() {
    assert.equal(sniffImageType(u8(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))?.ext, 'png');
    assert.equal(sniffImageType(u8(0xff,0xd8,0xff,0x00))?.ext, 'jpg');
    assert.equal(sniffImageType(new TextEncoder().encode('GIF89a').buffer)?.ext, 'gif');
    assert.equal(sniffImageType(new TextEncoder().encode('RIFFxxxxWEBP').buffer)?.ext, 'webp');
    assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>').buffer)?.ext, 'svg');
    const avif = new Uint8Array(24);
    avif.set(new TextEncoder().encode('ftyp'), 4);
    avif.set(new TextEncoder().encode('avif'), 8);
    assert.equal(sniffImageType(avif.buffer)?.ext, 'avif');
    const hash = await sha256Hex(new TextEncoder().encode('same bytes').buffer);
    assert.equal(hash, '58100dc8fc06562ce3e578231dc948e083520ee49c4b4ee5a5a28bb4b4003feb');
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}


async function testFetchReceiverBinding() {
    const strictFetch = async function(url) {
        assert.equal(this, globalThis);
        return jsonResponse({ ok: true, url });
    };
    const client = new GitHubClient({
        githubOwner: 'owner',
        githubRepo: 'repo',
        githubBranch: 'main',
        githubToken: 'token',
    }, strictFetch);
    const result = await client.request('/receiver-test');
    assert.equal(result.ok, true);
}

async function testGitDataOneCommit() {
    const calls = [];
    let blobCounter = 0;
    const baseSha = 'basecommit';
    const baseTree = 'basetree';
    const newTree = 'newtree';
    const newCommit = 'abcdef1234567890abcdef1234567890abcdef12';

    const fetchMock = async (url, options = {}) => {
        const method = options.method || 'GET';
        calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
        if (url.endsWith('/git/ref/heads/main') && method === 'GET') return jsonResponse({ object: { sha: baseSha } });
        if (url.endsWith(`/git/commits/${baseSha}`)) return jsonResponse({ tree: { sha: baseTree } });
        if (url.includes(`/git/trees/${baseTree}?recursive=1`)) return jsonResponse({ truncated: false, tree: [{ path: 'Theme/aaaaaaaaaaaaaaaa.png' }] });
        if (url.endsWith('/git/blobs') && method === 'POST') return jsonResponse({ sha: `blob${++blobCounter}` }, 201);
        if (url.endsWith('/git/trees') && method === 'POST') return jsonResponse({ sha: newTree }, 201);
        if (url.endsWith('/git/commits') && method === 'POST') return jsonResponse({ sha: newCommit }, 201);
        if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') return jsonResponse({ object: { sha: newCommit } });
        throw new Error(`Unexpected mock call: ${method} ${url}`);
    };

    const config = { githubOwner: 'owner', githubRepo: 'repo', githubBranch: 'main', githubToken: 'token' };
    const client = new GitHubClient(config, fetchMock);
    const assets = [
        { hash: 'a', repoPath: 'Theme/aaaaaaaaaaaaaaaa.png', blob: new Blob(['old']) },
        { hash: 'b', repoPath: 'Theme/bbbbbbbbbbbbbbbb.webp', blob: new Blob(['new']) },
    ];
    const result = await client.commitAssets({ themeName: 'Theme', assets });
    assert.equal(result.added, 1);
    assert.equal(result.reused, 1);
    assert.equal(result.commitSha, newCommit);
    assert.equal(calls.filter(x => x.url.endsWith('/git/blobs')).length, 1);
    assert.equal(calls.filter(x => x.url.endsWith('/git/commits') && x.method === 'POST').length, 1);
    assert.equal(calls.filter(x => x.method === 'PATCH').length, 1);
    const commitCall = calls.find(x => x.url.endsWith('/git/commits') && x.method === 'POST');
    assert.equal(commitCall.body.message, 'Publish theme: Theme');
    assert.equal(makeJsDelivrUrl(config, newCommit, '测试 Theme/bbbbbbbbbbbbbbbb.webp'), `https://cdn.jsdelivr.net/gh/owner/repo@${newCommit}/%E6%B5%8B%E8%AF%95%20Theme/bbbbbbbbbbbbbbbb.webp`);
}


async function testPublishedJsonImportCompatibility() {
    const source = {
        name: '兼容测试',
        main_text_color: 'rgba(255,255,255,1)',
        custom_css: '.hero{background:url("https://origin.example/a.png")}',
        future_field: { keep: true },
    };
    const published = makePublishedTheme(source, new Map([
        ['https://origin.example/a.png', 'https://cdn.jsdelivr.net/gh/o/r@abc/兼容测试/hash.png'],
    ]));
    const serialized = JSON.stringify(published, null, 4);
    const parsed = validateTheme(JSON.parse(serialized));

    // Mirrors SillyTavern 1.19.0 getNewTheme(): only recognized runtime theme fields
    // are consumed, while the JSON itself may safely contain future/unknown fields.
    const runtimeTheme = { name: parsed.name };
    for (const key of THEME_FIELDS) {
        if (Object.hasOwn(parsed, key)) runtimeTheme[key] = parsed[key];
    }
    assert.equal(runtimeTheme.name, '兼容测试');
    assert.match(runtimeTheme.custom_css, /cdn\.jsdelivr\.net\/gh\/o\/r@abc/);
    assert.equal(runtimeTheme.main_text_color, 'rgba(255,255,255,1)');
    assert.deepEqual(parsed.future_field, { keep: true });
}

async function testPrivateRepoRejectedForJsDelivr() {
    const fetchMock = async (url) => {
        if (url.endsWith('/repos/owner/repo')) return jsonResponse({ full_name: 'owner/repo', private: true, permissions: { push: true } });
        throw new Error(`Unexpected mock call: ${url}`);
    };
    const client = new GitHubClient({ githubOwner: 'owner', githubRepo: 'repo', githubBranch: 'main', githubToken: 'token' }, fetchMock);
    await assert.rejects(() => client.testConnection(), /私有仓库/);
}

async function testJsDelivrLimitConstant() {
    assert.equal(JSDELIVR_GITHUB_FILE_LIMIT, 20 * 1024 * 1024);
}

async function testResponsiveCss() {
    const css = await fs.readFile(path.join(__dirname, '..', 'style.css'), 'utf8');
    assert.match(css, /position:\s*fixed/);
    assert.match(css, /max-height:[^;]*100dvh/);
    assert.match(css, /overflow-y:\s*auto/);
    assert.match(css, /@media\s*\(max-width:\s*600px\)/);
    assert.match(css, /min-height:\s*44px/);
}

await testCssScanAndReplace();
await testThemePreservation();
await testSniffersAndHash();
await testFetchReceiverBinding();
await testGitDataOneCommit();
await testPublishedJsonImportCompatibility();
await testPrivateRepoRejectedForJsDelivr();
await testJsDelivrLimitConstant();
await testResponsiveCss();
console.log('All theme-publisher tests passed.');
