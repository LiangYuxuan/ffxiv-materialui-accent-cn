import fs from 'fs/promises';
import stream from 'stream/promises';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

import got from 'got';
import tar from 'tar';

import apiLevel from './apiLevel.js';
import getCommitDateBefore from './api.js';

import type { BuildInfo } from './types/buildInfo.js';
import { Manifest } from './types/manifest.js';

const mainHandler = async () => {
    const buildInfoFile = await fs.open('buildInfo.json', 'a+');

    let buildInfo = {} as BuildInfo;
    try {
        buildInfo = JSON.parse((await buildInfoFile.readFile()).toString('utf-8')) as BuildInfo;
    } catch {
        // ignore error
    }

    const { apiLevelChangeDate } = await apiLevel();

    const nowText = (new Date()).toISOString();
    const masterCommit = await getCommitDateBefore('skotlex', 'ffxiv-material-ui', 'master', apiLevelChangeDate ?? nowText);
    const accentCommit = await getCommitDateBefore('sevii77', 'ffxiv_materialui_accent', 'master', apiLevelChangeDate ?? nowText);

    console.log('Commit on skotlex/ffxiv-material-ui: %s', masterCommit);
    console.log('Commit on sevii77/ffxiv_materialui_accent: %s', accentCommit);

    if (buildInfo.masterCommit !== masterCommit || buildInfo.accentCommit !== accentCommit) {
        // Step 1: Download accent and extract plugin
        console.log('Download sevii77/ffxiv_materialui_accent and extract');

        const tempDir = await fs.mkdtemp(path.resolve(os.tmpdir(), 'mui'));
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
        await tar.extract({
            file: path.resolve(tempDir, archiveFileName),
            cwd: tempDir,
            strip: 1,
        });
        await fs.cp(path.resolve(tempDir, 'plugin'), './plugin', { recursive: true });
        const manifestText = await fs.readFile(path.resolve(tempDir, 'repo.json'));
        const manifest = JSON.parse(manifestText.toString('utf-8')) as Manifest[];

        // final clean up
        fs.rm(tempDir, { recursive: true, force: true });

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
        fs.writeFile(path.resolve('./tree/skotlex/ffxiv-material-ui', masterCommit), masterTree);
        fs.writeFile(path.resolve('./tree/sevii77/ffxiv_materialui_accent', accentCommit), accentTree);

        // Step 3: Apply patch and build
        const patchText = await fs.readFile('./patch/Updater.cs');

        // with proxy and cache
        console.log('Patch plugin with proxy and build');

        await fs.writeFile(
            './plugin/Updater.cs',
            patchText.toString('utf-8')
                .replace('https://raw.githubusercontent.com/', 'https://ghproxy.com/https://raw.githubusercontent.com/')
                .replace('https://api.github.com/repos/{0}/git/trees/{1}?recursive=1', 'https://ghproxy.com/https://raw.githubusercontent.com/LiangYuxuan/ffxiv-materialui-accent-cn/tree/{0}/{1}')
                .replace('$MASTERCOMMIT$', masterCommit)
                .replace('$ACCENTCOMMIT$', accentCommit),
        );

        const res = spawnSync('dotnet', ['build', './plugin/MaterialUI.csproj']);
        if (res.error) {
            console.error('.NET Build failed with status code %d', res.status);
            console.error(res.stdout);
            console.error(res.stderr);
            throw res.error;
        }

        await fs.cp('./plugin/bin/Release/MaterialUI/latest.zip', './release.zip');

        // only hash tag lock
        console.log('Patch plugin without proxy and build');

        await fs.writeFile(
            './plugin/Updater.cs',
            patchText.toString('utf-8')
                .replace('$MASTERCOMMIT$', masterCommit)
                .replace('$ACCENTCOMMIT$', accentCommit),
        );

        const resGH = spawnSync('dotnet', ['build', './plugin/MaterialUI.csproj']);
        if (resGH.error) {
            console.error('.NET Build failed with status code %d', resGH.status);
            console.error(resGH.stdout);
            console.error(resGH.stderr);
            throw resGH.error;
        }

        // final copy
        fs.cp('./plugin/bin/Release/MaterialUI/latest.zip', './release_gh.zip');

        // Step 4: Release
        console.log('Generate manifest');

        const version = manifest[0].AssemblyVersion;
        if (version === buildInfo.accentVersion) {
            buildInfo.accentRevision = (buildInfo.accentRevision ?? -1) + 1;
        } else {
            buildInfo.accentRevision = 0;
        }
        const fullVersion = `${version}.${buildInfo.accentRevision}`;
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
        fs.writeFile('repo.json', JSON.stringify(manifest, undefined, 4));

        manifest[0].DownloadLinkInstall = downloadLinkGH;
        manifest[0].DownloadLinkUpdate = downloadLinkGH;
        manifest[0].DownloadLinkTesting = downloadLinkGH;

        // final write
        fs.writeFile('repo_gh.json', JSON.stringify(manifest, undefined, 4));

        buildInfo.masterCommit = masterCommit;
        buildInfo.accentCommit = accentCommit;
        buildInfo.accentVersion = version;

        await buildInfoFile.truncate(0);
        await buildInfoFile.writeFile(JSON.stringify(buildInfo));

        // check GitHub action output
        if (process.env.GITHUB_OUTPUT) {
            // final write
            fs.writeFile(process.env.GITHUB_OUTPUT, `updated=true\nmaster=${masterCommit}\naccent=${accentCommit}\nversion=${fullVersion}\n`, { flag: 'a' });
        }
    }

    // final clean up
    buildInfoFile.close();
};

mainHandler().catch((error) => {
    console.error(error);
    process.exitCode = -1;
});
