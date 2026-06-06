import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, sent } = vi.hoisted(() => ({
  mockSettings: {} as Record<string, string>,
  sent: [] as { chat: number; text: string }[],
}));
vi.mock('axios', () => ({
  default: {
    post: vi.fn(async (url: string, body: any) => {
      if (String(url).endsWith('/sendMessage')) sent.push({ chat: Number(body.chat_id), text: String(body.text) });
      return { data: { ok: true, result: { message_id: 1 } } };
    }),
    get: vi.fn(async () => ({ data: { ok: true, result: [] } })),
    create: vi.fn(),
    isAxiosError: () => false,
  },
}));
vi.mock('../../src/database/index', () => ({
  getSetting: (k: string) => mockSettings[k] ?? '',
  setSetting: vi.fn(),
  default: { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) },
}));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendTelegramSystemAlert } from '../../src/services/telegram';

beforeEach(() => {
  sent.length = 0;
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  mockSettings['telegram.bot_token'] = 'x:y';
  mockSettings['telegram.enabled'] = 'true';
  mockSettings['telegram.allowed_chat_ids'] = '111,222,333';
});

describe('system alerts per chat', () => {
  it('goes to every allowed chat by default', async () => {
    await sendTelegramSystemAlert('alarm');
    expect(sent.map(s => s.chat).sort()).toEqual([111, 222, 333]);
  });
  it('goes to the admin chat only when asked', async () => {
    mockSettings['telegram.system_alerts_admin_only'] = 'true';
    await sendTelegramSystemAlert('alarm');
    expect(sent.map(s => s.chat)).toEqual([111]);
  });
  it('skips limited chats, never the admin', async () => {
    mockSettings['telegram.limited_chat_ids'] = '222, 333, 111';
    await sendTelegramSystemAlert('alarm');
    expect(sent.map(s => s.chat)).toEqual([111]);
  });
});
