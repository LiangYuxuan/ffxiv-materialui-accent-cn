import fs from 'fs/promises';

import apiLevel from './apiLevel.js';
import getCommitDateBefore from './commit.js';

import type { BuildInfo } from './types/buildInfo.js';

const mainHandler = async () => {
    const buildInfoFile = await fs.open('buildInfo.json', 'a+');

    let buildInfo = {} as BuildInfo;
    try {
        buildInfo = JSON.parse((await buildInfoFile.readFile()).toString('ascii')) as BuildInfo;
    } catch {
        // ignore error
    }

    const { isGlobalGreater, apiLevelChangeDate } = await apiLevel();

    const masterCommit = !isGlobalGreater ? 'master' : await getCommitDateBefore('skotlex', 'ffxiv-material-ui', 'master', apiLevelChangeDate);
    const accentCommit = !isGlobalGreater ? 'master' : await getCommitDateBefore('sevii77', 'ffxiv_materialui_accent', 'master', apiLevelChangeDate);

    console.log('Commit on skotlex/ffxiv-material-ui: %s', masterCommit);
    console.log('Commit on sevii77/ffxiv_materialui_accent: %s', accentCommit);

    if (buildInfo.masterCommit !== masterCommit || buildInfo.accentCommit !== accentCommit) {
        //
    }

    await buildInfoFile.truncate(0);
    await buildInfoFile.writeFile(JSON.stringify({ masterCommit, accentCommit }));
};

mainHandler().catch((error) => {
    console.error(error);
    process.exitCode = -1;
});
