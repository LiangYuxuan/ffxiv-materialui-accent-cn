/* eslint-disable no-console */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import stream from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import got from 'got';
import { extract } from 'tar';
import _7z from '7zip-min';

import getCommitDateBefore from './api.js';

import type { BuildInfo } from './types/buildInfo.js';
import { Manifest } from './types/manifest.js';

interface VersionInfo {
    version: string,
    global: Date,
    cn?: Date,
}

// https://ffxiv.fandom.com/wiki/Patch_notes
// https://ff.web.sdo.com/web8/index.html#/newstab/newslist
const versions: VersionInfo[] = [
    {
        version: '7.0',
        global: new Date('2024-06-28T08:00:00Z'),
    },
    {
        version: '6.5',
        global: new Date('2023-10-03T08:00:00Z'),
        cn: new Date('2024-03-05T08:00:00Z'),
    },
    {
        version: '6.4',
        global: new Date('2023-05-23T08:00:00Z'),
        cn: new Date('2023-09-19T08:00:00Z'),
    },
    {
        version: '6.3',
        global: new Date('2023-01-10T08:00:00Z'),
        cn: new Date('2023-05-09T08:00:00Z'),
    },
];

const patchUpdaterMap = new Map<string, string>([
    ['7285096079bbc65e0fc1f01165c56afe3f39d996871b47f41e6a87db8d62ceb5', 'Updater_1_4_12.cs'],
    ['a53cd0bd4a98f7d5b9f89b2486ad0fe5e28c69818cd92e3f7b67eaafdd7c098c', 'Updater_1_4_13.cs'],
]);

const today = new Date();
const versionCNIndex = versions
    .findIndex((version) => version.cn && today >= version.cn);

assert(versionCNIndex !== -1, 'Unknown CN version');

const versionGlobalDate = versionCNIndex > 0
    && today >= versions[versionCNIndex - 1].global
    ? versions[versionCNIndex - 1].global.toISOString()
    : today.toISOString();

const finals: Promise<unknown>[] = [];
const buildInfoFile = await fs.open('buildInfo.json', 'a+');

let buildInfo = {} as BuildInfo;
try {
    buildInfo = JSON.parse((await buildInfoFile.readFile()).toString('utf-8')) as BuildInfo;
} catch {
    // ignore error
}

const masterCommit = await getCommitDateBefore('skotlex', 'ffxiv-material-ui', 'master', versionGlobalDate);
const accentCommit = await getCommitDateBefore('sevii77', 'ffxiv_materialui_accent', 'master', versionGlobalDate);

console.log('Commit on skotlex/ffxiv-material-ui: %s', masterCommit);
console.log('Commit on sevii77/ffxiv_materialui_accent: %s', accentCommit);

if (buildInfo.masterCommit !== masterCommit || buildInfo.accentCommit !== accentCommit) {
    // Step 1: Download accent and dalamud resource and extract plugin
    console.log('Download sevii77/ffxiv_materialui_accent and extract');

    const tempDir = await fs.mkdtemp(path.resolve(os.tmpdir(), 'mui'));
    const [manifest] = await Promise.all([
        (async () => {
            const archiveFileName = 'accent.tar.gz';
            const archive = got.stream(`https://api.github.com/repos/sevii77/ffxiv_materialui_accent/tarball/${accentCommit}`, {
                headers: {
                    Authorization: process.env.GITHUB_TOKEN,
                },
            });
            const archiveFile = await fs.open(path.resolve(tempDir, archiveFileName), 'a+');
            await stream.pipeline(archive, archiveFile.createWriteStream());
            await archiveFile.close();

            await fs.rm('./plugin', { recursive: true, force: true });
            await fs.rm('./plugin_gh', { recursive: true, force: true });
            await extract({
                file: path.resolve(tempDir, archiveFileName),
                cwd: tempDir,
                strip: 1,
            });
            await Promise.all([
                fs.cp(path.resolve(tempDir, 'plugin'), './plugin', { recursive: true }),
                fs.cp(path.resolve(tempDir, 'plugin'), './plugin_gh', { recursive: true }),
            ]);
            const manifestText = await fs.readFile(path.resolve(tempDir, 'repo.json'));
            return JSON.parse(manifestText.toString('utf-8')) as Manifest[];
        })(),
        (async () => {
            const dalamudFileName = 'latest.7z';
            const dalamud = got.stream('https://raw.githubusercontent.com/ottercorp/dalamud-distrib/main/latest.7z');
            const dalamudFile = await fs.open(path.resolve(tempDir, dalamudFileName), 'a+');
            await stream.pipeline(dalamud, dalamudFile.createWriteStream());
            await dalamudFile.close();

            try {
                await fs.stat('./dalamud');
            } catch {
                await fs.mkdir('./dalamud', { recursive: true });
            }

            await new Promise<void>((resolve, reject) => {
                _7z.unpack(path.resolve(tempDir, dalamudFileName), './dalamud', (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        })(),
    ]);

    // final clean up
    finals.push(fs.rm(tempDir, { recursive: true, force: true }));

    // Step 2: Cache GitHub API tree result
    console.log('Fetch skotlex/ffxiv-material-ui and sevii77/ffxiv_materialui_accent tree info');

    const [masterTree, accentTree] = await Promise.all([
        got.get(`https://api.github.com/repos/skotlex/ffxiv-material-ui/git/trees/${masterCommit}?recursive=1`, {
            headers: {
                Authorization: process.env.GITHUB_TOKEN,
            },
        }).text(),
        got.get(`https://api.github.com/repos/sevii77/ffxiv_materialui_accent/git/trees/${accentCommit}?recursive=1`, {
            headers: {
                Authorization: process.env.GITHUB_TOKEN,
            },
        }).text(),
    ]);

    try {
        await fs.stat('./tree/skotlex/ffxiv-material-ui');
    } catch {
        await fs.mkdir('./tree/skotlex/ffxiv-material-ui', { recursive: true });
    }

    try {
        await fs.stat('./tree/sevii77/ffxiv_materialui_accent');
    } catch {
        await fs.mkdir('./tree/sevii77/ffxiv_materialui_accent', { recursive: true });
    }

    // final writes
    finals.push(fs.writeFile(path.resolve('./tree/skotlex/ffxiv-material-ui', masterCommit), masterTree));
    finals.push(fs.writeFile(path.resolve('./tree/sevii77/ffxiv_materialui_accent', accentCommit), accentTree));

    // Step 3: Apply patch and build
    const updaterBuffer = await fs.readFile('./plugin/Updater.cs');
    const updaterHash = crypto.createHash('sha256').update(updaterBuffer).digest('hex');
    const patchFileName = patchUpdaterMap.get(updaterHash);
    assert(patchFileName, `Failed to find patch file for Updater.cs hash ${updaterHash}`);

    const patchText = await fs.readFile(`./patch/${patchFileName}`);

    await Promise.all([
        (async () => {
            // plugin with ghproxy
            await fs.writeFile(
                './plugin/Updater.cs',
                patchText.toString('utf-8')
                    .replace('https://raw.githubusercontent.com/', 'https://ghproxy.com/https://raw.githubusercontent.com/')
                    .replace('https://api.github.com/repos/{0}/git/trees/{1}?recursive=1', 'https://ghproxy.com/https://raw.githubusercontent.com/LiangYuxuan/ffxiv-materialui-accent-cn/tree/{0}/{1}')
                    .replace('$MASTERCOMMIT$', masterCommit)
                    .replace('$ACCENTCOMMIT$', accentCommit),
            );

            const res = spawnSync('dotnet', ['build', './plugin/MaterialUI.csproj', '-c', 'Release'], {
                env: { ...process.env, GITHUB_TOKEN: undefined, DALAMUD_HOME: path.resolve('./dalamud') },
            });
            if (res.error ?? res.status !== 0) {
                console.error('.NET Build for plugin with ghproxy failed with status code %d', res.status);
                console.error(res.error);
                console.error(res.stdout.toString('utf-8'));
                console.error(res.stderr.toString('utf-8'));

                throw new Error('.NET Build Failed');
            }

            console.log('.NET Build for plugin with ghproxy completed');

            finals.push(fs.cp('./plugin/bin/Release/MaterialUI/latest.zip', './release.zip'));
        })(),
        (async () => {
            // plugin without ghproxy
            await fs.writeFile(
                './plugin_gh/Updater.cs',
                patchText.toString('utf-8')
                    .replace('$MASTERCOMMIT$', masterCommit)
                    .replace('$ACCENTCOMMIT$', accentCommit),
            );

            const res = spawnSync('dotnet', ['build', './plugin_gh/MaterialUI.csproj', '-c', 'Release'], {
                env: { ...process.env, GITHUB_TOKEN: undefined, DALAMUD_HOME: path.resolve('./dalamud') },
            });
            if (res.error ?? res.status !== 0) {
                console.error('.NET Build for plugin without ghproxy failed with status code %d', res.status);
                console.error(res.error);
                console.error(res.stdout.toString('utf-8'));
                console.error(res.stderr.toString('utf-8'));

                throw new Error('.NET Build Failed');
            }

            console.log('.NET Build for plugin without ghproxy completed');

            finals.push(fs.cp('./plugin_gh/bin/Release/MaterialUI/latest.zip', './release_gh.zip'));
        })(),
    ]);

    // Step 4: Release
    console.log('Generate manifest');

    const version = manifest[0].AssemblyVersion;
    if (version === buildInfo.accentVersion) {
        buildInfo.accentRevision = (buildInfo.accentRevision ?? -1) + 1;
    } else {
        buildInfo.accentRevision = 0;
    }
    const fullVersion = `${version}.${buildInfo.accentRevision.toString()}`;
    const downloadLink = 'https://ghproxy.com/https://raw.githubusercontent.com/LiangYuxuan/ffxiv-materialui-accent-cn/master/release.zip';
    const downloadLinkGH = 'https://raw.githubusercontent.com/LiangYuxuan/ffxiv-materialui-accent-cn/master/release_gh.zip';

    console.log('Origin plugin version: %s', version);
    console.log('Revision: %s', buildInfo.accentRevision);

    manifest[0].AssemblyVersion = fullVersion;
    manifest[0].TestingAssemblyVersion = fullVersion;
    manifest[0].DownloadLinkInstall = downloadLink;
    manifest[0].DownloadLinkUpdate = downloadLink;
    manifest[0].DownloadLinkTesting = downloadLink;
    manifest[0].LastUpdate = Math.floor(Date.now() / 1000);

    // final write
    finals.push(fs.writeFile('repo.json', JSON.stringify(manifest, undefined, 4)));

    manifest[0].DownloadLinkInstall = downloadLinkGH;
    manifest[0].DownloadLinkUpdate = downloadLinkGH;
    manifest[0].DownloadLinkTesting = downloadLinkGH;

    // final write
    finals.push(fs.writeFile('repo_gh.json', JSON.stringify(manifest, undefined, 4)));

    buildInfo.masterCommit = masterCommit;
    buildInfo.accentCommit = accentCommit;
    buildInfo.accentVersion = version;

    await buildInfoFile.truncate(0);
    await buildInfoFile.writeFile(JSON.stringify(buildInfo));

    // check GitHub action output
    if (process.env.GITHUB_OUTPUT) {
        // final write
        finals.push(fs.writeFile(process.env.GITHUB_OUTPUT, `updated=true\nmaster=${masterCommit}\naccent=${accentCommit}\nversion=${fullVersion}\n`, { flag: 'a' }));
    }
}

// final clean up
finals.push(buildInfoFile.close());

await Promise.all(finals);
