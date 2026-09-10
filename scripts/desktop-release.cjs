'use strict';

// Canonical copy: Sonoran-Software/Sonoran-Desktop-Apps/scripts/desktop-release.cjs.
// Vendored in app source repositories so a build never executes mutable remote code.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const HUB = 'Sonoran-Software/Sonoran-Desktop-Apps';
const FEEDS = 'https://sonoran-software.github.io/Sonoran-Desktop-Apps';
const PRODUCTS = {
  cad: { name: 'Sonoran CAD', legacy: { windows: 'SonoranCAD_Windows', macos: 'SonoranCAD_MacOS' }, signing: 'A68FD56D1215267B85D4E003B12C9DE7DCF8C6C3' },
  cms: { name: 'Sonoran CMS', legacy: { windows: 'SonoranCMS_Windows', macos: 'SonoranCMS_MacOS' }, signing: '7B50F7ED2D6CFECCEE75973089894646D4D995B1' },
  radio: { name: 'Sonoran Radio', legacy: { windows: 'SonoranRadio_Windows', macos: 'SonoranRadio_MacOS' }, signing: 'F5B8B47E0FA02671BC350DBD505399F2561AAA4D' },
  studio: { name: 'Sonoran Studio', legacy: { windows: 'Sonoran-Studio-Releases', macos: 'Sonoran-Studio-Releases' }, signing: '0AD1D95550F0EA7E5F10CA9C027262B07EA2FF98' },
};
const META = { windows: 'latest.yml', macos: 'latest-mac.yml', linux: 'latest-linux.yml' };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (value, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(value).digest(encoding);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function versionParts(v) {
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Expected stable numeric version, received ${v}`);
  return v.split('.').map(Number);
}
function compareVersions(a, b) {
  const av = versionParts(a), bv = versionParts(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return Math.sign(av[i] - bv[i]);
  return 0;
}
function assetName(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid artifact URL');
  const name = decodeURIComponent(value);
  if (name !== path.basename(name) || /[/\\]/.test(name) || name === '.' || name === '..') throw new Error(`Expected a local artifact filename: ${value}`);
  return name;
}
function releaseAssetUrl(tag, name) {
  return `https://github.com/${HUB}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}
function validateMetadata(metadata, directory, expectedVersion) {
  if (metadata.version !== expectedVersion) throw new Error('Artifact version does not match package.json');
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) throw new Error('Updater files[] is missing');
  for (const item of metadata.files) {
    const name = assetName(item.url), bytes = fs.readFileSync(path.join(directory, name));
    if (hash(bytes, 'sha512', 'base64') !== item.sha512) throw new Error(`SHA-512 mismatch: ${name}`);
    if (item.size != null && bytes.length !== item.size) throw new Error(`Size mismatch: ${name}`);
  }
  if (metadata.path) {
    const bytes = fs.readFileSync(path.join(directory, assetName(metadata.path)));
    if (hash(bytes, 'sha512', 'base64') !== metadata.sha512) throw new Error('Legacy metadata SHA-512 mismatch');
  }
}
function centralMetadata(original, product, version) {
  const result = structuredClone(original), tag = `${product}-v${version}`;
  for (const file of result.files) file.url = releaseAssetUrl(tag, assetName(file.url));
  if (result.path) result.path = releaseAssetUrl(tag, assetName(result.path));
  // Old Windows web-installer metadata is not supported by these NSIS builds.
  if (result.packages) throw new Error('Unexpected web-installer package metadata');
  return result;
}
function verifyPackagedFeed(product, platform, directory) {
  const expected = `${FEEDS}/updates/${product}/${platform}/`;
  const candidates = [];
  function visit(folder, depth) {
    if (depth > 5) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isFile() && entry.name === 'app-update.yml') candidates.push(file);
      else if (entry.isDirectory() && !['squashfs-root', 'app.asar.unpacked', 'node_modules'].includes(entry.name)) visit(file, depth + 1);
    }
  }
  visit(directory, 0);
  if (!candidates.length) throw new Error('Packaged app-update.yml was not found');
  for (const file of candidates) {
    const config = yaml.load(fs.readFileSync(file, 'utf8'));
    if (config.provider !== 'generic' || config.url !== expected || config.useMultipleRangeRequest !== false) throw new Error(`Packaged update destination is incorrect: ${file}`);
  }
}
function renderReadme(catalog) {
  const lines = ['# Sonoran Desktop Apps', '', 'Download the latest desktop apps from Sonoran Software.', ''];
  for (const [product, info] of Object.entries(PRODUCTS)) {
    lines.push(`## ${info.name}`, '');
    for (const [platform, label] of Object.entries({ windows: 'Windows', macos: 'macOS', linux: 'Linux (AppImage, x64)' })) {
      const item = catalog[product]?.[platform];
      lines.push(item?.url ? `- [${label}](${item.url})${item.version ? ` — ${item.version}` : ''}` : `- ${label}: release coming soon.`);
    }
    lines.push('');
  }
  lines.push(`[Linux signing keys and verification](${FEEDS}/signing.html)`, '', '[Sonoran Software Support](https://support.sonoransoftware.com)', '');
  return lines.join('\n');
}
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout;
}
function signLinux(product, directory, metadataText) {
  const fp = process.env.LINUX_GPG_FINGERPRINT?.trim().toUpperCase();
  if (fp !== PRODUCTS[product].signing) throw new Error('Linux signing fingerprint does not match the product signing key');
  const privateKey = process.env.LINUX_GPG_PRIVATE_KEY, passphrase = process.env.LINUX_GPG_PASSPHRASE;
  if (!privateKey || !passphrase) throw new Error('Linux signing key/passphrase is missing');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sonoran-sign-'));
  fs.chmodSync(temporary, 0o700);
  const passFile = path.join(temporary, 'passphrase');
  fs.writeFileSync(passFile, passphrase, { mode: 0o600 });
  const env = { ...process.env, GNUPGHOME: temporary };
  delete env.LINUX_GPG_PRIVATE_KEY;
  delete env.LINUX_GPG_PASSPHRASE;
  const gpg = (args, input) => run('gpg', ['--homedir', temporary, '--batch', '--yes', ...args], { env, input });
  try {
    gpg(['--import'], privateKey);
    fs.writeFileSync(path.join(directory, META.linux), metadataText);
    const images = fs.readdirSync(directory).filter(name => name.endsWith('.AppImage'));
    if (images.length !== 1) throw new Error('Expected exactly one AppImage');
    const sums = [...images, META.linux].map(name => `${hash(fs.readFileSync(path.join(directory, name)))}  ${name}\n`).join('');
    fs.writeFileSync(path.join(directory, 'SHA256SUMS-linux'), sums);
    for (const name of ['SHA256SUMS-linux', META.linux]) {
      gpg(['--pinentry-mode', 'loopback', '--passphrase-file', passFile, '--local-user', `${fp}!`, '--armor', '--detach-sign', '--output', path.join(directory, `${name}.asc`), path.join(directory, name)]);
      gpg(['--verify', path.join(directory, `${name}.asc`), path.join(directory, name)]);
    }
    gpg(['--armor', '--output', path.join(directory, `sonoran-${product}-linux-public.asc`), '--export', fp]);
  } finally {
    spawnSync('gpgconf', ['--homedir', temporary, '--kill', 'gpg-agent'], { env });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

class GitHub {
  constructor(token, fetcher = fetch) {
    if (!token) throw new Error('GH_TOKEN is missing');
    this.token = token;
    this.fetcher = fetcher;
  }
  async api(route, method = 'GET', body) {
    const response = await this.fetcher(`https://api.github.com/${route}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'sonoran-desktop-publisher' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${route} returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  async optional(route) {
    try { return await this.api(route); } catch (error) { if (error.status === 404) return null; throw error; }
  }
  async releases(repo) {
    const releases = [];
    for (let page = 1; ; page++) {
      const part = await this.api(`repos/${repo}/releases?per_page=100&page=${page}`);
      releases.push(...part);
      if (part.length < 100) return releases;
    }
  }
  async release(repo, tag, title, body) {
    const route = `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    let release = await this.optional(route);
    if (release) return release;
    const repository = await this.api(`repos/${repo}`);
    try {
      // Published, non-latest release reserves the tag uniquely across platforms.
      // Clients only see a release after its platform feed is promoted below.
      return await this.api(`repos/${repo}/releases`, 'POST', { tag_name: tag, target_commitish: repository.default_branch, name: title, body, draft: false, prerelease: false, make_latest: 'false' });
    } catch (error) {
      if (error.status !== 422) throw error;
      release = await this.optional(route);
      if (!release) throw error;
      return release;
    }
  }
  async upload(repo, release, name, bytes) {
    const digest = `sha256:${hash(bytes)}`;
    let current = await this.api(`repos/${repo}/releases/${release.id}/assets?per_page=100`);
    const existing = current.find(asset => asset.name === name);
    if (existing) {
      if (existing.digest !== digest) throw new Error(`Refusing to replace a different existing artifact: ${repo}/${release.tag_name}/${name}. Build a higher version.`);
      return existing;
    }
    const response = await this.fetcher(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream', 'User-Agent': 'sonoran-desktop-publisher' }, body: bytes,
    });
    if (!response.ok) throw new Error(`Artifact upload failed for ${name}: ${response.status}`);
    const asset = await response.json();
    if (asset.digest !== digest || asset.size !== bytes.length) throw new Error(`GitHub artifact digest/size verification failed: ${name}`);
    return asset;
  }
  async locked(name, task) {
    const ref = `tags/desktop-publish-lock-${name}`;
    const head = await this.api(`repos/${HUB}/git/ref/heads/master`);
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await this.api(`repos/${HUB}/git/refs`, 'POST', { ref: `refs/${ref}`, sha: head.object.sha });
      } catch (error) {
        if (error.status !== 422 || !await this.optional(`repos/${HUB}/git/ref/${ref}`)) throw error;
        await sleep(10000);
        continue;
      }
      try { return await task(); }
      finally { await this.api(`repos/${HUB}/git/refs/${ref}`, 'DELETE'); }
    }
    throw new Error(`Publishing lock ${ref} is busy. If its owning build was terminated, remove only that stale lock tag after confirming no publisher is running.`);
  }
}

async function mirrorLegacy(gh, product, platform, version, names, directory, raw) {
  const repo = `Sonoran-Software/${PRODUCTS[product].legacy[platform]}`;
  return gh.locked(PRODUCTS[product].legacy[platform], async () => {
    const latest = await gh.optional(`repos/${repo}/releases/latest`);
    if (latest && compareVersions(version, latest.tag_name.replace(/^v/, '')) < 0) throw new Error('A newer legacy bridge is already published');
    const tag = `v${version}`;
    // Keep incomplete bridges invisible to old GitHubProvider clients, including
    // clients that discover releases through Atom instead of the latest API.
    let release = (await gh.releases(repo)).find(item => item.tag_name === tag);
    if (!release) {
      const repository = await gh.api(`repos/${repo}`);
      release = await gh.api(`repos/${repo}/releases`, 'POST', {
        tag_name: tag, target_commitish: repository.default_branch, name: version,
        body: `Desktop update bridge for ${PRODUCTS[product].name}. New installations use the Sonoran Desktop Apps update feed.`,
        draft: true, prerelease: false,
      });
    }
    for (const name of names) await gh.upload(repo, release, name, fs.readFileSync(path.join(directory, name)));
    await gh.upload(repo, release, META[platform], Buffer.from(raw));
    const assets = await gh.api(`repos/${repo}/releases/${release.id}/assets?per_page=100`);
    const required = product === 'studio' ? [META.windows, META.macos] : [META[platform]];
    if (!required.every(name => assets.some(asset => asset.name === name))) {
      console.log('Legacy bridge remains a draft until both Studio Windows and macOS finish.');
      return;
    }
    await gh.api(`repos/${repo}/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'true' });
  });
}

async function checkVersion(gh, product, platform, version) {
  versionParts(version);
  const legacyName = PRODUCTS[product].legacy[platform];
  if (!legacyName) return;
  const latest = await gh.optional(`repos/Sonoran-Software/${legacyName}/releases/latest`);
  if (latest) {
    const published = latest.tag_name.replace(/^v/, '');
    const bridgeRetry = version === published && latest.body?.includes(`Desktop update bridge for ${PRODUCTS[product].name}.`);
    if (compareVersions(version, published) <= 0 && !bridgeRetry) throw new Error(`Build a version newer than the existing ${product}/${platform} release ${published}. Select a patch or higher promotion bump.`);
  }
}

async function prepareStudio(gh, packageFile, source) {
  if (!/^[0-9a-f]{40}$/i.test(source || '')) throw new Error('CM_COMMIT is required to allocate a Studio release version');
  const marker = `<!-- sonoran-studio-source:Sonoran-Software/Sonoran-Studio@${source} -->`;
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const [major, minor, floor] = versionParts(pkg.version);
  for (let attempt = 0; attempt < 8; attempt++) {
    const central = await gh.releases(HUB);
    const existing = central.find(release => release.body?.includes(marker));
    let version;
    if (existing) version = existing.tag_name.replace(/^studio-v/, '');
    else {
      const legacy = await gh.releases('Sonoran-Software/Sonoran-Studio-Releases');
      const pattern = new RegExp(`^(?:studio-)?v${major}\\.${minor}\\.(\\d+)$`);
      const highest = [...central, ...legacy].reduce((max, release) => { const match = pattern.exec(release.tag_name); return match ? Math.max(max, Number(match[1])) : max; }, floor);
      version = `${major}.${minor}.${highest + 1}`;
      const reserved = await gh.release(HUB, `studio-v${version}`, `Sonoran Studio ${version}`, marker);
      if (!reserved.body?.includes(marker)) { await sleep(500); continue; }
    }
    versionParts(version);
    pkg.version = version;
    fs.writeFileSync(packageFile, json(pkg));
    const lockFile = path.join(path.dirname(packageFile), 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    fs.writeFileSync(lockFile, json(lock));
    return version;
  }
  throw new Error('Unable to reserve a shared Studio release version');
}

async function commitFeed(gh, product, platform, version, files, downloadUrl) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = await gh.api(`repos/${HUB}/git/ref/heads/master`);
    const head = ref.object.sha;
    const commit = await gh.api(`repos/${HUB}/git/commits/${head}`);
    const catalogFile = await gh.api(`repos/${HUB}/contents/catalog.json?ref=${head}`);
    const catalog = JSON.parse(Buffer.from(catalogFile.content, 'base64').toString('utf8'));
    const previous = catalog[product]?.[platform];
    if (previous?.central && compareVersions(version, previous.version) < 0) throw new Error('Refusing to downgrade the published update feed');
    const metadataSha = hash(files[META[platform]]);
    if (previous?.central && version === previous.version && previous.metadataSha256 !== metadataSha) throw new Error('Refusing to replace the same-version update feed with different artifacts');
    catalog[product] ||= {};
    catalog[product][platform] = { version, url: downloadUrl, central: true, metadataSha256: metadataSha };
    const changes = { 'catalog.json': json(catalog), 'README.md': renderReadme(catalog) };
    for (const [name, content] of Object.entries(files)) changes[`docs/updates/${product}/${platform}/${name}`] = content;
    const tree = await gh.api(`repos/${HUB}/git/trees`, 'POST', { base_tree: commit.tree.sha, tree: Object.entries(changes).map(([file, content]) => ({ path: file, mode: '100644', type: 'blob', content: String(content) })) });
    const next = await gh.api(`repos/${HUB}/git/commits`, 'POST', { message: `Publish ${product} ${platform} ${version} update feed`, tree: tree.sha, parents: [head] });
    try {
      await gh.api(`repos/${HUB}/git/refs/heads/master`, 'PATCH', { sha: next.sha, force: false });
      return next.sha;
    } catch (error) {
      if (![409, 422].includes(error.status)) throw error;
      await sleep(250 * (attempt + 1));
    }
  }
  throw new Error('Concurrent feed updates did not settle; retry publishing');
}
async function waitForFeed(product, platform, expected, fetcher = fetch) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const response = await fetcher(`${FEEDS}/updates/${product}/${platform}/${META[platform]}?verify=${hash(expected).slice(0,16)}-${attempt}`, { cache: 'no-store' });
    if (response.ok && hash(Buffer.from(await response.arrayBuffer())) === hash(expected)) return;
    await sleep(15000);
  }
  throw new Error('Pages has not served the verified update manifest yet; legacy latest was not advanced');
}

async function publish(gh, product, platform, directory, packageFile, preview = false) {
  const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
  const metaName = META[platform], raw = fs.readFileSync(path.join(directory, metaName), 'utf8');
  const original = yaml.load(raw);
  validateMetadata(original, directory, version);
  verifyPackagedFeed(product, platform, directory);
  const normalized = yaml.dump(centralMetadata(original, product, version), { lineWidth: -1 });
  if (platform === 'linux') signLinux(product, directory, normalized);
  const extensions = { windows: /\.(exe|blockmap)$/, macos: /\.(dmg|zip|blockmap)$/, linux: /\.(AppImage|blockmap)$/ }[platform];
  const names = fs.readdirSync(directory).filter(name => extensions.test(name) && fs.statSync(path.join(directory, name)).isFile());
  if (names.length === 0) throw new Error('No publishable artifacts');
  for (const file of original.files) if (!names.includes(assetName(file.url))) throw new Error('Updater references an artifact outside the platform upload set');
  let download = platform === 'windows' ? names.find(n => n.endsWith('.exe')) : platform === 'linux' ? names.find(n => n.endsWith('.AppImage')) : names.find(n => /universal.*\.dmg$/.test(n)) || names.find(n => n.endsWith('.dmg'));
  if (!download) throw new Error('Missing user download installer');
  if (preview) { console.log(`Verified ${product} ${platform} ${version}; staging artifacts only${platform === 'linux' ? ', Linux signatures created' : ''}.`); return; }
  await checkVersion(gh, product, platform, version);
  const tag = `${product}-v${version}`;
  const release = await gh.release(HUB, tag, `${PRODUCTS[product].name} ${version}`, `Desktop release for ${PRODUCTS[product].name}. See the repository README for available platform downloads.`);
  for (const name of names) await gh.upload(HUB, release, name, fs.readFileSync(path.join(directory, name)));
  await gh.upload(HUB, release, metaName, Buffer.from(normalized));
  const feedFiles = { [metaName]: normalized };
  if (platform === 'linux') {
    for (const name of ['SHA256SUMS-linux', 'SHA256SUMS-linux.asc', `${metaName}.asc`, `sonoran-${product}-linux-public.asc`]) {
      const bytes = fs.readFileSync(path.join(directory, name));
      await gh.upload(HUB, release, name, bytes);
      if (name === `${metaName}.asc`) feedFiles[name] = bytes.toString('utf8');
    }
  }
  await commitFeed(gh, product, platform, version, feedFiles, releaseAssetUrl(tag, download));
  await waitForFeed(product, platform, Buffer.from(normalized));
  const legacyName = PRODUCTS[product].legacy[platform];
  if (legacyName) {
    await mirrorLegacy(gh, product, platform, version, names, directory, raw);
  }
  console.log(`Published and verified ${product} ${platform} ${version}; ${legacyName ? 'legacy bridge updated' : 'signed Linux release ready'}.`);
}
async function main(args) {
  const [command, product, platform, directory, packageFile = 'package.json'] = args;
  if (!PRODUCTS[product] || (command !== 'prepare' && !META[platform])) throw new Error('Usage: desktop-release.cjs <preflight|publish|prepare> <product> <platform> <artifact-dir> <package.json>');
  const preview = process.env.CM_BRANCH !== 'master';
  if (command === 'prepare' && preview) { console.log('Staging Studio build: version reservation disabled.'); return; }
  if (command === 'publish' && preview) return publish(null, product, platform, path.resolve(directory), path.resolve(packageFile), true);
  if (command === 'preflight' && preview) { console.log('Staging build: publish disabled.'); return; }
  const gh = new GitHub(process.env.GH_TOKEN);
  const access = await gh.api(`repos/${HUB}`);
  if (!access.permissions?.push) throw new Error('GH_TOKEN needs Contents write access to Sonoran-Desktop-Apps');
  if (command === 'prepare') {
    console.log(`Reserved Studio ${await prepareStudio(gh, path.resolve(platform || 'package.json'), process.env.CM_COMMIT)}`);
  } else if (command === 'preflight') {
    await checkVersion(gh, product, platform, JSON.parse(fs.readFileSync(packageFile, 'utf8')).version);
    console.log('Publishing access and migration version verified.');
  } else if (command === 'publish') {
    await publish(gh, product, platform, path.resolve(directory), path.resolve(packageFile));
  } else throw new Error('Unknown publisher command');
}
module.exports = { PRODUCTS, HUB, FEEDS, META, GitHub, compareVersions, assetName, validateMetadata, centralMetadata, renderReadme, checkVersion, prepareStudio, commitFeed, waitForFeed, publish, signLinux, mirrorLegacy, verifyPackagedFeed };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
