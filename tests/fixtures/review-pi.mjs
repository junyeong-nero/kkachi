#!/usr/bin/env bun
// Offline RPC stand-in for the review integration tests. No credentials or model calls.
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const send = e => console.log(JSON.stringify(e));
const data = process.env.KKACHI_DATA_DIR;
if (!process.argv.includes('--no-session')) writeFileSync(join(data, 'test-pi.pid'), String(process.pid));
for await (const line of createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line);
  send({ type: 'response', id: cmd.id, success: true });
  if (cmd.type !== 'prompt') continue;
  let answer = 'answer';
  if (process.argv.includes('--tools')) {
    const turns = readFileSync(join(data, 'conversation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    if (turns.some(t => t.user.includes('green tea'))) writeFileSync('tea.md', '# Tea\nGreen tea.\n');
    if (turns.some(t => t.issue === 'search_rate_limit')) writeFileSync('search.md', '# Search\nProvider limit interrupted search.\n');
    writeFileSync(join(data, 'review-started'), process.cwd());
    if (existsSync(join(data, 'hold'))) continue; // leave the worker mid-edit until cancelled
    if (existsSync(join(data, 'invalid'))) writeFileSync('AGENTS.md', 'not a note');
    answer = '차 취향 검토';
  } else if (process.argv.includes('--no-session')) {
    writeFileSync('README.md', '# Catalog\n[Tea](tea.md)\n');
  }
  send({ type: 'message_start', message: { role: 'assistant' } });
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: answer } });
  if (!process.argv.includes('--no-session') && cmd.message.includes('[test 429]')) {
    send({ type: 'tool_execution_start', toolName: 'mcp__kitsune_browser', toolCallId: 'test', args: {} });
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '429: private provider detail' } });
  } else {
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
  }
  send({ type: 'agent_settled' });
}
