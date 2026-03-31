import { captureGitStateBefore, isGitRepo, getHeadCommit } from './src/git-utils.js';

const testPath = process.env.TEST_PATH || process.env.HOME + '/projects';

async function main() {
    console.log('Testing git utilities...');
    console.log(`Test path: ${testPath}`);

    const isRepo = await isGitRepo(testPath);
    console.log(`Is git repo: ${isRepo}`);

    const headCommit = await getHeadCommit(testPath);
    console.log(`HEAD commit: ${headCommit}`);

    const gitState = await captureGitStateBefore(testPath);
    console.log(`Git state before:`, JSON.stringify(gitState, null, 2));
}

main().catch(console.error);
