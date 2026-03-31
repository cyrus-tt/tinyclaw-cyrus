#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyclaw-smoke-'));
  const tinyclawHome = path.join(tempRoot, '.tinyclaw');
  fs.mkdirSync(tinyclawHome, { recursive: true });

  process.env.TINYCLAW_HOME = tinyclawHome;
  process.env.TINYCLAW_API_PORT = '39777';

  const core = require('../packages/core/dist');
  const server = require('../packages/server/dist');
  const invoke = require('../packages/core/dist/invoke');
  const projectCommand = require('../packages/channels/dist/project-command');

  core.initQueueDb();
  const httpServer = server.startApiServer(new Map());

  try {
    const baseUrl = `http://127.0.0.1:${process.env.TINYCLAW_API_PORT}`;

    assert.equal(projectCommand.validateRepoName('saas-phase2'), null);
    assert.notEqual(projectCommand.validateRepoName('../escape'), null);
    assert.throws(() => projectCommand.resolveProjectLocalPath('/tmp/root', '../escape'));
    assert.equal(projectCommand.sanitizeTopicDisplayName('  SaaS 二期   @tinyclaw0_bot ').includes('@'), false);

    let res = await fetch(`${baseUrl}/api/usage`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);

    res = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'telegram',
        sender: 'Smoke Test',
        senderId: 'smoke-user',
        message: 'hello smoke',
        messageId: 'smoke_msg_1',
        topicId: '285',
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(core.getPendingAgents().includes('default'), true);

    await core.streamResponse('smoke response', {
      channel: 'telegram',
      sender: 'Smoke Test',
      senderId: 'smoke-user',
      messageId: 'smoke_msg_1',
      originalMessage: 'hello smoke',
      agentId: 'assistant',
      topicId: '285',
    });

    const pendingResponses = core.getResponsesForChannel('telegram');
    assert.equal(pendingResponses.length > 0, true);
    const metadata = JSON.parse(pendingResponses[0].metadata || '{}');
    assert.equal(metadata.topicId, '285');

    const friendlyTransient = invoke.getUserFacingAgentErrorMessage(
      'Engineer',
      'openai',
      new Error('stream disconnected before completion'),
    );
    assert.match(friendlyTransient, /暂时不可用|连接中断/);

    const friendlyConfig = invoke.getUserFacingAgentErrorMessage(
      'Engineer',
      'openai',
      new Error('failed to load skill /Users/cyrus/.agents/skills/foo/SKILL.md'),
    );
    assert.match(friendlyConfig, /技能|配置/);

    console.log('TinyClaw smoke checks passed');
  } finally {
    httpServer.close();
    core.closeQueueDb();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
