/**
 * MemOS Cloud memory client for TinyClaw.
 * Docs: https://memos.memtensor.cn/api/openmem/v1
 *
 * Two operations:
 *  - searchMemory: recall relevant memories before agent invocation (max 2s timeout)
 *  - addMessage:   save conversation after agent responds (fire-and-forget)
 */
import { log } from './logging';

const MEMOS_BASE_URL = 'https://memos.memtensor.cn/api/openmem/v1';
const SEARCH_TIMEOUT_MS = 2000;

export async function memosSearch(
    apiKey: string,
    userId: string,
    query: string,
    agentId: string,
    conversationId?: string,
): Promise<string> {
    try {
        const body: Record<string, unknown> = {
            user_id: userId,
            query,
            agent_id: agentId,
        };
        if (conversationId) body.conversation_id = conversationId;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

        const res = await fetch(`${MEMOS_BASE_URL}/search/memory`, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
            log('WARN', `MemOS search failed: ${res.status}`);
            return '';
        }

        const data = await res.json() as any;
        const memories: any[] = data?.results ?? data?.memories ?? data?.data ?? [];
        if (!Array.isArray(memories) || memories.length === 0) return '';

        const lines = memories
            .slice(0, 6)
            .map((m: any) => `- ${m.memory ?? m.content ?? m.text ?? JSON.stringify(m)}`);

        log('INFO', `MemOS recalled ${lines.length} memories for @${agentId}`);
        return lines.join('\n');
    } catch (err: any) {
        if (err?.name === 'AbortError') {
            log('WARN', `MemOS search timeout (>${SEARCH_TIMEOUT_MS}ms) — skipping`);
        } else {
            log('WARN', `MemOS search error: ${err?.message}`);
        }
        return '';
    }
}

export function memosAdd(
    apiKey: string,
    userId: string,
    conversationId: string,
    agentId: string,
    userMessage: string,
    agentResponse: string,
): void {
    // Fire-and-forget — never blocks agent response
    fetch(`${MEMOS_BASE_URL}/add/message`, {
        method: 'POST',
        headers: {
            'Authorization': `Token ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            user_id: userId,
            conversation_id: conversationId,
            agent_id: agentId,
            messages: [
                { role: 'user', content: userMessage },
                { role: 'assistant', content: agentResponse },
            ],
        }),
    }).then(async res => {
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            log('WARN', `MemOS add failed: ${res.status} ${body.slice(0, 100)}`);
        } else {
            log('INFO', `MemOS saved conversation for @${agentId}`);
        }
    }).catch(err => {
        log('WARN', `MemOS add error: ${err?.message}`);
    });
}
