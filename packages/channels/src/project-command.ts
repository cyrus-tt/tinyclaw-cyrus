import path from 'path';

export const DEFAULT_GITHUB_BASE = '/Volumes/tyj/Cyrus/GitHub';
const REPO_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export function validateRepoName(repoName: string): string | null {
    if (!repoName) {
        return '仓库名不能为空';
    }
    if (!REPO_NAME_PATTERN.test(repoName)) {
        return '仓库名只能包含字母、数字、点、下划线、短横线，且不能以符号开头或结尾';
    }
    return null;
}

export function sanitizeTopicDisplayName(rawTopicName: string): string {
    const clean = rawTopicName.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) {
        throw new Error('Topic 名称不能为空');
    }
    return clean.slice(0, 128);
}

export function resolveProjectLocalPath(githubBase: string, repoName: string): string {
    const baseDir = path.resolve(githubBase);
    const localPath = path.resolve(baseDir, repoName);
    if (localPath !== baseDir && !localPath.startsWith(baseDir + path.sep)) {
        throw new Error('仓库路径非法，超出 GitHub 根目录');
    }
    return localPath;
}
