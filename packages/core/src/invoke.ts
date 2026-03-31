import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AgentConfig, CustomProvider, TeamConfig } from './types';
import { SCRIPT_DIR, USAGE_FILE, resolveClaudeModel, resolveCodexModel, resolveOpenCodeModel, getSettings } from './config';

interface UsageRecord {
    timestamp: number;
    agentId: string;
    agentName: string;
    provider: string;
    model: string;
    harness: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
}

function appendUsage(record: UsageRecord): void {
    try {
        fs.appendFileSync(USAGE_FILE, JSON.stringify(record) + '\n', 'utf8');
    } catch (e) {
        // ignore
    }
}
import { log } from './logging';
import { ensureAgentDirectory, buildSystemPrompt } from './agent';
import { memosSearch, memosAdd } from './memos';

export class CommandExecutionError extends Error {
    command: string;
    args: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;

    constructor(command: string, args: string[], exitCode: number | null, stdout: string, stderr: string) {
        const errorMessage = stderr.trim() || stdout.trim() || `Command exited with code ${exitCode ?? 'unknown'}`;
        super(errorMessage);
        this.name = 'CommandExecutionError';
        this.command = command;
        this.args = args;
        this.exitCode = exitCode;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}

export class AgentInvocationError extends Error {
    userMessage: string;

    constructor(userMessage: string, message: string) {
        super(message);
        this.name = 'AgentInvocationError';
        this.userMessage = userMessage;
    }
}

export async function runCommand(command: string, args: string[], cwd?: string, envOverrides?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, ...envOverrides };
        // Only delete CLAUDECODE if not explicitly set via envOverrides (needed for OAuth auth)
        if (!envOverrides?.CLAUDECODE) {
            delete env.CLAUDECODE;
        }

        // Handle __DELETE_ prefixed keys — remove the target env var entirely
        const deletedKeys: string[] = [];
        for (const key of Object.keys(env)) {
            if (key.startsWith('__DELETE_')) {
                const targetKey = key.slice('__DELETE_'.length);
                delete env[targetKey];
                delete env[key];
                deletedKeys.push(targetKey);
            }
        }
        if (deletedKeys.length > 0) {
            log('DEBUG', `Env cleanup: deleted ${deletedKeys.join(', ')}; ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL ?? '(unset)'}`);
        }

        const child = spawn(command, args, {
            cwd: cwd || SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });

        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }

            const errorMessage = stderr.trim() || `Command exited with code ${code}`;
            log('ERROR', `runCommand failed: code=${code}, stderr=${stderr.trim().slice(0, 500)}, stdout=${stdout.trim().slice(0, 200)}`);
            const err = new CommandExecutionError(command, args, code, stdout, stderr);
            err.message = errorMessage;
            reject(err);
        });
    });
}

function isTransientCodexError(message: string): boolean {
    const text = message.toLowerCase();
    return text.includes('stream disconnected')
        || text.includes('reconnecting...')
        || text.includes('connection reset')
        || text.includes('econnreset')
        || text.includes('socket hang up')
        || text.includes('timed out')
        || text.includes('io error');
}

function isTransientProviderError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return isTransientCodexError(error.message);
}

function normalizeErrorText(error: unknown): string {
    if (error instanceof CommandExecutionError) {
        return [error.stderr, error.stdout].filter(Boolean).join('\n');
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function buildCodexArgs(message: string, systemPrompt: string, modelId: string, shouldResume: boolean): string[] {
    const codexArgs = ['exec'];
    if (shouldResume) {
        codexArgs.push('resume', '--last');
    }
    if (modelId) {
        codexArgs.push('--model', modelId);
    }
    if (systemPrompt) {
        codexArgs.push('-c', `developer_instructions=${systemPrompt}`);
    }
    codexArgs.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', message);
    return codexArgs;
}

function parseCodexOutput(output: string, usageMeta: {
    agentId: string;
    agentName: string;
    provider: string;
    model: string;
    harness: string;
}): string {
    let response = '';
    const lines = output.trim().split('\n').filter(Boolean);
    for (const line of lines) {
        try {
            const json = JSON.parse(line);
            if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
                response = json.item.text;
            }
            if (json.type === 'turn.completed' && json.usage) {
                appendUsage({
                    timestamp: Date.now(),
                    agentId: usageMeta.agentId,
                    agentName: usageMeta.agentName,
                    provider: usageMeta.provider,
                    model: usageMeta.model,
                    harness: usageMeta.harness,
                    input_tokens: json.usage.input_tokens || 0,
                    output_tokens: json.usage.output_tokens || 0,
                    cache_read_tokens: json.usage.cached_input_tokens || 0,
                    cache_write_tokens: 0,
                    cost_usd: 0,
                });
            }
        } catch {
            // Ignore lines that aren't valid JSON
        }
    }
    return response;
}

function parseOpenCodeOutput(output: string, usageMeta: {
    agentId: string;
    agentName: string;
    provider: string;
    model: string;
    harness: string;
}): string {
    let response = '';
    const lines = output.trim().split('\n').filter(Boolean);
    for (const line of lines) {
        try {
            const json = JSON.parse(line);
            if (json.type === 'text' && json.part?.text) {
                response = json.part.text;
            }
            if (json.type === 'step_finish' && json.part?.tokens) {
                const t = json.part.tokens;
                appendUsage({
                    timestamp: Date.now(),
                    agentId: usageMeta.agentId,
                    agentName: usageMeta.agentName,
                    provider: usageMeta.provider,
                    model: usageMeta.model,
                    harness: usageMeta.harness,
                    input_tokens: t.input || 0,
                    output_tokens: t.output || 0,
                    cache_read_tokens: t.cache?.read || 0,
                    cache_write_tokens: t.cache?.write || 0,
                    cost_usd: json.part.cost || 0,
                });
            }
        } catch {
            // Ignore lines that aren't valid JSON
        }
    }
    return response;
}

function getProviderLabel(provider: string): string {
    return provider === 'openai' ? 'Codex'
        : provider === 'opencode' ? 'OpenCode'
        : 'Claude';
}

function getFirstUsefulLine(text: string): string {
    const line = text
        .split('\n')
        .map(entry => entry.trim())
        .find(entry => entry.length > 0 && !entry.startsWith('{') && !entry.startsWith('['));
    return (line || text.trim() || '未知错误').slice(0, 160);
}

export function getUserFacingAgentErrorMessage(agentName: string, provider: string, error: unknown): string {
    const raw = normalizeErrorText(error).toLowerCase();
    const providerLabel = getProviderLabel(provider);

    if (raw.includes('failed to load skill') || raw.includes('invalid yaml') || raw.includes('frontmatter')) {
        return `${agentName} 当前不可用：${providerLabel} 的 skills 配置加载失败，请先修复本机 skills 配置。`;
    }
    if (raw.includes('api key') || raw.includes('oauth') || raw.includes('auth') || raw.includes('unauthorized') || raw.includes('forbidden')) {
        return `${agentName} 当前不可用：${providerLabel} 鉴权失败，请检查本机登录状态或密钥配置。`;
    }
    if (raw.includes('enoent') || raw.includes('command not found') || raw.includes('not found')) {
        return `${agentName} 当前不可用：本机缺少 ${providerLabel} CLI 或相关依赖。`;
    }
    if (isTransientCodexError(raw)) {
        return `${agentName} 暂时不可用：${providerLabel} 连接中断，系统已自动重试但仍失败，请稍后再试。`;
    }
    return `${agentName} 执行失败：${getFirstUsefulLine(normalizeErrorText(error))}`;
}

function toAgentInvocationError(agent: AgentConfig, provider: string, error: unknown): AgentInvocationError {
    const providerLabel = getProviderLabel(provider);
    const rawMessage = getFirstUsefulLine(normalizeErrorText(error));
    return new AgentInvocationError(
        getUserFacingAgentErrorMessage(agent.name || agent.provider || 'Agent', provider, error),
        `${providerLabel} invocation failed for ${agent.name || 'agent'}: ${rawMessage}`,
    );
}

async function runCodexWithRetry(args: string[], cwd: string, envOverrides: Record<string, string>, maxAttempts = 3): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt > 1) {
                log('WARN', `Retrying Codex command after transient failure (attempt ${attempt}/${maxAttempts})`);
            }
            return await runCommand('codex', args, cwd, envOverrides);
        } catch (error) {
            const err = error as Error;
            lastError = err;
            if (attempt >= maxAttempts || !isTransientCodexError(err.message)) {
                throw err;
            }
            const backoffMs = 1500 * attempt;
            log('WARN', `Transient Codex failure detected: ${err.message.split('\n')[0]}. Backing off ${backoffMs}ms before retry.`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
    }

    throw lastError || new Error('Codex command failed');
}

/**
 * Invoke a single agent with a message. Contains all Claude/Codex invocation logic.
 * Returns the raw response text.
 */
export async function invokeAgent(
    agent: AgentConfig,
    agentId: string,
    message: string,
    workspacePath: string,
    shouldReset: boolean,
    agents: Record<string, AgentConfig> = {},
    teams: Record<string, TeamConfig> = {},
    topicId?: string,
    topicWorkingDir?: string,
    messageId?: string,
): Promise<string> {
    // Ensure agent directory exists with config files
    const agentDir = path.join(workspacePath, agentId);
    const isNewAgent = !fs.existsSync(agentDir);
    ensureAgentDirectory(agentDir);
    if (isNewAgent) {
        log('INFO', `Initialized agent directory with config files: ${agentDir}`);
    }

    // Build system prompt in-memory (built-in instructions + teammates + memory + user customization)
    const systemPrompt = buildSystemPrompt(agentId, agentDir, agents, teams, agent.system_prompt, agent.prompt_file);

    // Resolve working directory — topic projects override the default
    let workingDir: string;
    if (topicId && topicWorkingDir) {
        // Topic-based session isolation: use the project's directory
        workingDir = topicWorkingDir;
        log('INFO', `Topic session isolation: topic=${topicId}, workingDir=${workingDir}`);
    } else if (topicId) {
        // Topic without explicit project mapping: isolate by subdirectory
        const topicDir = path.join(agentDir, 'topics', topicId);
        if (!fs.existsSync(topicDir)) fs.mkdirSync(topicDir, { recursive: true });
        workingDir = topicDir;
        log('INFO', `Topic session isolation (fallback): topic=${topicId}, workingDir=${workingDir}`);
    } else {
        workingDir = agent.working_directory
            ? (path.isAbsolute(agent.working_directory)
                ? agent.working_directory
                : path.join(workspacePath, agent.working_directory))
            : agentDir;
    }

    // ── MemOS Cloud memory recall ──────────────────────────────────────────────
    const memSettings = getSettings().memory;
    const memosKey = memSettings?.memos_api_key;
    const memosUserId = memSettings?.user_id ?? 'cyrus';
    const rawMessage = message; // keep original for saving later

    if (memosKey) {
        const recalled = await memosSearch(memosKey, memosUserId, message, agentId, messageId);
        if (recalled) {
            message = `[Relevant memories from previous conversations]\n${recalled}\n\n[Current message]\n${message}`;
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const rawProvider = agent.provider || 'anthropic';

    // Resolve custom provider if using "custom:<id>" prefix
    let provider = rawProvider;
    let customProvider: CustomProvider | undefined;
    let envOverrides: Record<string, string> = {
        TINYCLAW_AGENT_ID: agentId,
    };

    if (rawProvider.startsWith('custom:')) {
        const customId = rawProvider.slice('custom:'.length);
        const settings = getSettings();
        customProvider = settings.custom_providers?.[customId];
        if (!customProvider) {
            throw new Error(`Custom provider '${customId}' not found in settings.custom_providers`);
        }
        // Map harness back to built-in provider for CLI selection
        provider = customProvider.harness === 'codex' ? 'openai'
            : customProvider.harness === 'opencode' ? 'opencode'
            : 'anthropic';

        // Build env overrides based on harness
        if (customProvider.harness === 'claude') {
            envOverrides.ANTHROPIC_BASE_URL = customProvider.base_url;
            envOverrides.ANTHROPIC_AUTH_TOKEN = customProvider.api_key;
            envOverrides.ANTHROPIC_API_KEY = '';
        } else if (customProvider.harness === 'codex') {
            envOverrides.OPENAI_API_KEY = customProvider.api_key;
            envOverrides.OPENAI_BASE_URL = customProvider.base_url;
        } else if (customProvider.harness === 'opencode') {
            // opencode uses provider-specific env vars; set key for Google/Gemini
            envOverrides.GOOGLE_GENERATIVE_AI_API_KEY = customProvider.api_key;
        }

        log('INFO', `Using custom provider '${customId}' (harness: ${customProvider.harness})`);
    } else {
        // For built-in providers, check if auth is configured in settings
        const settings = getSettings();
        if (provider === 'anthropic' && settings.models?.anthropic?.oauth_token) {
            // Use OAuth subscription — requires CLAUDECODE=1 for CLI to recognize the token
            envOverrides.CLAUDE_CODE_OAUTH_TOKEN = settings.models.anthropic.oauth_token;
            envOverrides.CLAUDECODE = '1';
            // Clear any stale relay env vars
            envOverrides.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
            envOverrides.ANTHROPIC_AUTH_TOKEN = '';
            envOverrides.ANTHROPIC_API_KEY = '';
        } else if (provider === 'anthropic' && settings.models?.anthropic?.auth_token) {
            envOverrides.ANTHROPIC_API_KEY = settings.models.anthropic.auth_token;
        }
        if (provider === 'openai' && settings.models?.openai?.auth_token) {
            envOverrides.OPENAI_API_KEY = settings.models.openai.auth_token;
        }
    }

    // Use model from custom provider if agent doesn't specify one
    const effectiveModel = agent.model || customProvider?.model || '';
    const harness = customProvider?.harness || (provider === 'openai' ? 'codex' : provider === 'opencode' ? 'opencode' : 'claude');

    if (provider === 'openai') {
        log('INFO', `Using Codex CLI (agent: ${agentId})`);

        const shouldResume = !shouldReset;

        if (shouldReset) {
            log('INFO', `Resetting Codex conversation for agent: ${agentId}`);
        }

        // Isolate Codex sessions per agent to prevent model conflicts
        // (e.g. codex-agent using gpt-5.3-codex vs gemini-agent using gemini-2.5-flash)
        const agentCodexHome = path.join(workspacePath, agentId, '.codex');
        if (!fs.existsSync(agentCodexHome)) fs.mkdirSync(agentCodexHome, { recursive: true });
        // Symlink global auth.json so OAuth tokens are always available in the isolated dir
        const globalAuth = path.join(process.env.HOME || '', '.codex', 'auth.json');
        const agentAuth = path.join(agentCodexHome, 'auth.json');
        if (fs.existsSync(globalAuth) && !fs.existsSync(agentAuth)) {
            fs.symlinkSync(globalAuth, agentAuth);
        }
        envOverrides.CODEX_HOME = agentCodexHome;

        const modelId = customProvider ? effectiveModel : resolveCodexModel(effectiveModel);
        const modelIdCodex = customProvider ? effectiveModel : resolveCodexModel(effectiveModel);
        let response = '';

        try {
            const codexOutput = await runCodexWithRetry(
                buildCodexArgs(message, systemPrompt, modelId, shouldResume),
                workingDir,
                envOverrides,
            );
            response = parseCodexOutput(codexOutput, {
                agentId,
                agentName: agent.name || agentId,
                provider: rawProvider,
                model: modelIdCodex || effectiveModel,
                harness,
            });
        } catch (error) {
            if (error instanceof CommandExecutionError && error.stdout.trim()) {
                response = parseCodexOutput(error.stdout, {
                    agentId,
                    agentName: agent.name || agentId,
                    provider: rawProvider,
                    model: modelIdCodex || effectiveModel,
                    harness,
                });
                if (response) {
                    log('WARN', `Using partial Codex response after command failure (agent: ${agentId})`);
                }
            }

            if (!response && shouldResume && isTransientProviderError(error)) {
                log('WARN', `Codex resume failed for ${agentId}; retrying with a fresh session`);
                try {
                    const freshOutput = await runCodexWithRetry(
                        buildCodexArgs(message, systemPrompt, modelId, false),
                        workingDir,
                        envOverrides,
                    );
                    response = parseCodexOutput(freshOutput, {
                        agentId,
                        agentName: agent.name || agentId,
                        provider: rawProvider,
                        model: modelIdCodex || effectiveModel,
                        harness,
                    });
                } catch (freshError) {
                    throw toAgentInvocationError(agent, provider, freshError);
                }
            } else if (!response) {
                throw toAgentInvocationError(agent, provider, error);
            }
        }

        if (memosKey && response) {
            memosAdd(memosKey, memosUserId, messageId ?? agentId, agentId, rawMessage, response);
        }
        return response || 'Sorry, I could not generate a response from Codex.';
    } else if (provider === 'opencode') {
        // OpenCode CLI — non-interactive mode via `opencode run`.
        // Outputs JSONL with --format json; extract "text" type events for the response.
        // Model passed via --model in provider/model format (e.g. opencode/claude-sonnet-4-5).
        // Supports -c flag for conversation continuation (resumes last session).
        const modelId = resolveOpenCodeModel(effectiveModel);
        log('INFO', `Using OpenCode CLI (agent: ${agentId}, model: ${modelId})`);

        const continueConversation = !shouldReset && !customProvider;

        if (shouldReset) {
            log('INFO', `Resetting OpenCode conversation for agent: ${agentId}`);
        }

        // Pass system prompt via OPENCODE_CONFIG_CONTENT env var using a custom agent
        if (systemPrompt) {
            const configContent = JSON.stringify({
                agent: {
                    [agentId]: {
                        prompt: systemPrompt
                    }
                }
            });
            envOverrides.OPENCODE_CONFIG_CONTENT = configContent;
        }

        const opencodeArgs = ['run', '--format', 'json'];
        if (modelId) {
            opencodeArgs.push('--model', modelId);
        }
        if (systemPrompt) {
            opencodeArgs.push('--agent', agentId);
        }
        if (continueConversation) {
            opencodeArgs.push('-c');
        }
        opencodeArgs.push(message);

        let response = '';
        try {
            const opencodeOutput = await runCommand('opencode', opencodeArgs, workingDir, envOverrides);
            response = parseOpenCodeOutput(opencodeOutput, {
                agentId,
                agentName: agent.name || agentId,
                provider: rawProvider,
                model: modelId || effectiveModel,
                harness,
            });
        } catch (error) {
            if (error instanceof CommandExecutionError && error.stdout.trim()) {
                response = parseOpenCodeOutput(error.stdout, {
                    agentId,
                    agentName: agent.name || agentId,
                    provider: rawProvider,
                    model: modelId || effectiveModel,
                    harness,
                });
                if (response) {
                    log('WARN', `Using partial OpenCode response after command failure (agent: ${agentId})`);
                }
            }

            if (!response) {
                throw toAgentInvocationError(agent, provider, error);
            }
        }

        if (memosKey && response) {
            memosAdd(memosKey, memosUserId, messageId ?? agentId, agentId, rawMessage, response);
        }
        return response || 'Sorry, I could not generate a response from OpenCode.';
    } else {
        // Default to Claude (Anthropic)
        log('INFO', `Using Claude provider (agent: ${agentId})`);

        const continueConversation = !shouldReset;

        if (shouldReset) {
            log('INFO', `Resetting conversation for agent: ${agentId}`);
        }

        const modelId = customProvider ? effectiveModel : resolveClaudeModel(effectiveModel);
        const claudeArgs = ['--dangerously-skip-permissions'];
        if (modelId) {
            claudeArgs.push('--model', modelId);
        }
        if (systemPrompt) {
            claudeArgs.push('--system-prompt', systemPrompt);
        }
        if (continueConversation) {
            claudeArgs.push('-c');
        }
        // Apply per-agent tool restrictions (Claude CLI only)
        if (agent.allowedTools && agent.allowedTools.length > 0) {
            claudeArgs.push('--allowedTools', ...agent.allowedTools);
        }
        if (agent.disallowedTools && agent.disallowedTools.length > 0) {
            claudeArgs.push('--disallowedTools', ...agent.disallowedTools);
        }

        claudeArgs.push('--output-format', 'json');
        claudeArgs.push('-p', message);

        let response = '';
        try {
            const claudeOutput = await runCommand('claude', claudeArgs, workingDir, envOverrides);
            try {
                const json = JSON.parse(claudeOutput.trim());
                response = json.result || '';
                if (json.usage) {
                    appendUsage({
                        timestamp: Date.now(),
                        agentId,
                        agentName: agent.name || agentId,
                        provider: rawProvider,
                        model: modelId || effectiveModel,
                        harness,
                        input_tokens: json.usage.input_tokens || 0,
                        output_tokens: json.usage.output_tokens || 0,
                        cache_read_tokens: json.usage.cache_read_input_tokens || 0,
                        cache_write_tokens: json.usage.cache_creation_input_tokens || 0,
                        cost_usd: json.total_cost_usd || 0,
                    });
                }
            } catch {
                response = claudeOutput.trim();
            }
        } catch (error) {
            throw toAgentInvocationError(agent, provider, error);
        }

        if (memosKey && response) {
            memosAdd(memosKey, memosUserId, messageId ?? agentId, agentId, rawMessage, response);
        }
        return response || 'Sorry, I could not generate a response.';
    }
}
