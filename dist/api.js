import got from 'got';
const commitCache = new Map();
const getCommitDateBefore = async (owner, repo, branch, beforeDate) => {
    const key = `${owner}/${repo}/${branch}/${beforeDate}`;
    if (commitCache.has(key)) {
        return commitCache.get(key);
    }
    const commits = await got.get(`https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&until=${beforeDate}&per_page=1`, {
        headers: {
            Authorization: process.env.GITHUB_TOKEN,
        },
    }).json();
    const { sha } = commits[0];
    commitCache.set(key, sha);
    return sha;
};
export default getCommitDateBefore;
//# sourceMappingURL=api.js.map