import fs from 'fs';
import { Hono } from 'hono';
import { USAGE_FILE } from '@tinyclaw/core';

const app = new Hono();

// GET /api/usage — return all usage records
app.get('/api/usage', (c) => {
    const records: unknown[] = [];
    if (fs.existsSync(USAGE_FILE)) {
        const lines = fs.readFileSync(USAGE_FILE, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
            try { records.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
    }
    return c.json(records);
});

// DELETE /api/usage — clear all records
app.delete('/api/usage', (c) => {
    if (fs.existsSync(USAGE_FILE)) {
        fs.writeFileSync(USAGE_FILE, '', 'utf8');
    }
    return c.json({ ok: true });
});

export default app;
