import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/tools.js';
import { TClient, makeTestContext } from './helpers.js';

const EXPECTED_TOOLS = [
  'mupit_start', 'mupit_register', 'mupit_get_self', 'mupit_update_introduction', 'mupit_set_active',
  'mupit_discover', 'mupit_poll', 'mupit_list_conversations', 'mupit_open_conversation', 'mupit_read_conversation',
  'mupit_send_message', 'mupit_facilitate', 'mupit_set_assessment', 'mupit_propose_connection', 'mupit_respond_connection',
  'mupit_submit_contact', 'mupit_get_connection_contact', 'mupit_close_conversation', 'mupit_block_participant',
];

const READ_ONLY = new Set(['mupit_start', 'mupit_get_self', 'mupit_discover', 'mupit_poll', 'mupit_list_conversations', 'mupit_read_conversation', 'mupit_get_connection_contact']);

describe('MCP contract (acceptance #19 partial)', () => {
  it('advertises all 19 tools with accurate read-only annotations', async () => {
    const ctx = makeTestContext();
    try {
      const mcp = createMcpServer(ctx.app);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'contract-probe', version: '0.0.0-test' });
      await Promise.all([mcp.connect(a), client.connect(b)]);
      try {
        const list = await client.listTools();
        const names = list.tools.map((t) => t.name).sort();
        expect(names).toEqual([...EXPECTED_TOOLS].sort());
        for (const t of list.tools) {
          expect(t.annotations?.readOnlyHint).toBe(READ_ONLY.has(t.name));
          if (t.name === 'mupit_block_participant' || t.name === 'mupit_close_conversation') {
            expect(t.annotations?.destructiveHint).toBe(true);
          }
          expect(typeof t.description).toBe('string');
          expect((t.description ?? '').length).toBeGreaterThan(20);
        }
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      ctx.close();
    }
  });

  it('mupit_start is public and returns guidance + privacy boundary', async () => {
    const ctx = makeTestContext();
    try {
      const c = await TClient.connect(ctx, 't');
      try {
        const start = await c.call('mupit_start', {});
        expect(String(start.guidance)).toMatch(/personal agent/i);
        expect(String(start.guidance)).toMatch(/participant_token/);
        expect(String(start.privacy)).toMatch(/Meta/);
        expect(start.facilitator_mode).toBe('mock');
      } finally {
        await c.close();
      }
    } finally {
      ctx.close();
    }
  });
});
