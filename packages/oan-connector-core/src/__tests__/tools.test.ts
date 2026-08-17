// tools.ts: behavior and copy of the neutral tool layer. Host guidance assertions target the
// injected hostHints copy, results are plain strings, and the tool-result budget is an
// injected parameter (with a dedicated budget-truncation test).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOanTools,
  type OanCoreToolDeps,
  type OanHostHints,
  type OanInboxItemView,
} from '../tools.js';

const createGofer = vi.fn();
const deleteGofer = vi.fn();
const getGoferChatMessages = vi.fn();
const listGofers = vi.fn();
const sendGoferMessage = vi.fn();

// Test-injected host guidance (deliberately recognizable neutral copy, verifying guidance can only come from injection)
const hostHints: OanHostHints = {
  howToPair: 'HOW-TO-PAIR: ask your operator to run the pairing flow on this host.',
  howToRecover: 'HOW-TO-RECOVER: reuse the already-redeemed key via the host recovery path.',
  howToRestart: 'restart the connector per HOW-TO-RESTART',
};

function toolsWith(overrides: Partial<OanCoreToolDeps> = {}) {
  const tools = createOanTools({
    readCredentials: () => ({ baseUrl: 'https://api.example', apiKey: 'test-key-1' }),
    createGofer,
    listGofers,
    sendGoferMessage,
    deleteGofer,
    getGoferChatMessages,
    toolResultBudget: 14_000,
    hostHints,
    ...overrides,
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

describe('createOanTools（声明形状）', () => {
  it('产出 8 个工具，参数是纯字符串声明（宿主适配层据此编译成自己的工具形状）', () => {
    const tools = toolsWith();
    expect([...tools.keys()].sort()).toEqual([
      'oan_ask_user',
      'oan_create_gofer',
      'oan_delete_gofer',
      'oan_gofer_history',
      'oan_inbox',
      'oan_list_gofers',
      'oan_reply',
      'oan_status',
    ]);
    const reply = tools.get('oan_reply')!;
    expect(reply.parameters.contactId).toMatchObject({ type: 'string', required: true });
    expect(reply.parameters.message).toMatchObject({ type: 'string', required: true });
    expect(reply.parameters.filePath).toMatchObject({ type: 'string' });
    expect(reply.parameters.filePath.required).toBeUndefined();
  });
});

describe('oan_create_gofer', () => {
  beforeEach(() => {
    createGofer.mockReset();
    listGofers.mockReset();
    sendGoferMessage.mockReset();
    createGofer.mockResolvedValue({ goferId: 'g1', chatId: 'c1', greeting: 'hi' });
    sendGoferMessage.mockResolvedValue({ accepted: true });
  });

  it('描述里锁死任务颗粒度规则：N 个独立任务 = N 个 Gofer，逐任务调用，禁止捆绑', () => {
    // A defect observed in production: the agent reasonably read "N parallel tasks" as one
    // goal — the description must state the primary rule (one Gofer per independent task)
    // + the explicit action (call this tool once per task) + the mechanical reason
    const tool = toolsWith().get('oan_create_gofer')!;
    expect(tool.description).toContain('Each distinct task is its own Gofer');
    expect(tool.description).toContain('call this tool once per task');
    expect(tool.description).toContain('must not share a Gofer');
  });

  it('creates the Gofer and opens its profile chat with the stated goal', async () => {
    const tool = toolsWith().get('oan_create_gofer')!;

    const text = await tool.run({ goal: 'find a co-founder', offer: 'ten years of ops work' });

    expect(createGofer).toHaveBeenCalledWith('https://api.example', { kind: 'apiKey', apiKey: 'test-key-1' }, {});
    expect(sendGoferMessage).toHaveBeenCalledWith(
      'https://api.example',
      { kind: 'apiKey', apiKey: 'test-key-1' },
      'g1',
      expect.stringContaining('find a co-founder'),
    );
    expect(sendGoferMessage.mock.calls[0][3]).toContain('ten years of ops work');
    expect(text).toContain('g1');
    // Follow-up conversation goes through the inbox; the tool result must spell out the contact address
    expect(text).toContain('oan:g1');
    expect(text).toContain('inbox items');
  });

  it('目标陈述创建后立即直发（问候由服务端先落库，顺序天然正确），文案指引收件箱续谈', async () => {
    const tool = toolsWith().get('oan_create_gofer')!;
    const text = await tool.run({ goal: 'find a co-founder', offer: 'ops experience' });
    expect(sendGoferMessage).toHaveBeenCalledWith(
      'https://api.example',
      { kind: 'apiKey', apiKey: 'test-key-1' },
      'g1',
      expect.stringContaining('find a co-founder'),
    );
    expect(text).toContain('opened with the stated goal');
    expect(text).toContain('needs no reply');
    expect(text).toContain('oan_inbox');
  });


  it('passes an explicit locale through to the API', async () => {
    const tool = toolsWith().get('oan_create_gofer')!;
    await tool.run({ goal: 'find a co-founder', locale: 'zh-CN' });
    expect(createGofer).toHaveBeenCalledWith(expect.anything(), expect.anything(), { locale: 'zh-CN' });
  });

  it('refuses to create anything when no goal was stated', async () => {
    const tool = toolsWith().get('oan_create_gofer')!;

    await expect(tool.run({ goal: '   ' })).rejects.toThrow(/goal/i);
    expect(createGofer).not.toHaveBeenCalled();
  });

  it('fails with the injected pairing hint when the channel is not paired', async () => {
    const tool = toolsWith({ readCredentials: () => undefined }).get('oan_create_gofer')!;

    // Injection acceptance: pairing guidance must come from the injected hostHints (including the recovery path); the core encodes no host command
    await expect(tool.run({ goal: 'find a co-founder' })).rejects.toThrow(/HOW-TO-PAIR/);
    await expect(tool.run({ goal: 'find a co-founder' })).rejects.toThrow(/HOW-TO-RECOVER/);
    expect(createGofer).not.toHaveBeenCalled();
  });
});

describe('oan_status', () => {
  it('reports NOT PAIRED without throwing, with the injected pairing hint', async () => {
    const tool = toolsWith({ readCredentials: () => undefined }).get('oan_status')!;
    const text = await tool.run({});
    expect(text).toContain('NOT PAIRED');
    expect(text).toContain('HOW-TO-PAIR');
  });

  it('连接不可观测时绝不断言"没有连接"（可能是按需加载实例的假阴性），且绝不诱导轮询/重启', async () => {
    const tool = toolsWith({ readConnectionStatus: () => undefined }).get('oan_status')!;
    const text = await tool.run({});
    expect(text).toContain('PAIRED');
    expect(text).toContain('No channel connection is observable from this process');
    expect(text).toContain('outside the process');
    expect(text).toContain('Do NOT restart anything based on this alone');
    expect(text).toContain('End your turn');
    expect(text).toContain('never kill the process');
    // The restart guidance comes from the injected fragment
    expect(text).toContain('HOW-TO-RESTART');
    expect(text).not.toContain('call this tool again');
  });

  it('reports CONNECTED with event counters', async () => {
    const tool = toolsWith({
      readConnectionStatus: () => ({ connected: true, eventCount: 3, lastEventAt: '2026-08-05T10:00:00Z' }),
    }).get('oan_status')!;
    const text = await tool.run({});
    expect(text).toContain('CONNECTED');
    expect(text).toContain('3');
  });

  it('reports a terminal stop with its reason and recovery hint', async () => {
    const tool = toolsWith({
      readConnectionStatus: () => ({ connected: false, stoppedReason: 'reconnection-attempts-exhausted', eventCount: 0 }),
    }).get('oan_status')!;
    const text = await tool.run({});
    expect(text).toContain('STOPPED');
    expect(text).toContain('reconnection-attempts-exhausted');
    expect(text).toContain('HOW-TO-RESTART');
  });

  it('hostHints.howToRestart 缺省时使用中性重启片段', async () => {
    const tool = toolsWith({
      hostHints: { howToPair: hostHints.howToPair },
      readConnectionStatus: () => ({ connected: false, stoppedReason: 'retries_exhausted', eventCount: 0 }),
    }).get('oan_status')!;
    const text = await tool.run({});
    expect(text).toContain('restart the connector runtime once');
  });
});

describe('oan_status 冷实例活性兜底', () => {
  it('进程内快照不可见但活性记录新鲜：给出权威 CONNECTED 回答，明示告知用户已连上', async () => {
    const tool = toolsWith({
      readConnectionStatus: () => undefined,
      readConnectionLiveness: async () => ({
        record: { state: 'connected' as const, baseUrl: 'https://api.example', lastAliveAt: new Date(Date.now() - 40_000).toISOString() },
        fresh: true,
      }),
    }).get('oan_status')!;
    const result = await tool.run({});
    expect(result).toContain('CONNECTED');
    expect(result).toContain('alive 40s ago');
    expect(result).toContain('connection is up');
  });

  it('活性记录为 stopped：如实报告终态与出路', async () => {
    const tool = toolsWith({
      readConnectionStatus: () => undefined,
      readConnectionLiveness: async () => ({
        record: { state: 'stopped' as const, lastAliveAt: new Date().toISOString(), stoppedReason: 'unauthorized' },
        fresh: true,
      }),
    }).get('oan_status')!;
    const result = await tool.run({});
    expect(result).toContain('STOPPED');
    expect(result).toContain('re-pair');
  });

  it('无活性记录/过期：保持诚实的"观察不到"，并明令禁止向用户断言断连', async () => {
    const tool = toolsWith({
      readConnectionStatus: () => undefined,
      readConnectionLiveness: async () => undefined,
    }).get('oan_status')!;
    const result = await tool.run({});
    expect(result).toContain('No channel connection is observable');
    expect(result).toContain('do NOT tell your user the channel is disconnected');
  });
});

describe('oan_gofer_history', () => {
  beforeEach(() => {
    getGoferChatMessages.mockReset();
  });

  it('fetches the two-sided record with readable role labels', async () => {
    getGoferChatMessages.mockResolvedValue([
      { id: 'm1', role: 'assistant', content: 'What are you looking for?', createdAt: '2026-08-05T10:00:00Z' },
      { id: 'm2', role: 'user', content: 'Early-stage funding.', createdAt: '2026-08-05T10:01:00Z' },
    ]);
    const tool = toolsWith().get('oan_gofer_history')!;

    const text = await tool.run({ goferId: 'g1' });

    expect(getGoferChatMessages).toHaveBeenCalledWith('https://api.example', { kind: 'apiKey', apiKey: 'test-key-1' }, 'g1', undefined);
    expect(text).toContain('Gofer: What are you looking for?');
    expect(text).toContain('Your side: Early-stage funding.');
  });

  it('passes since through and reports an empty record plainly', async () => {
    getGoferChatMessages.mockResolvedValue([]);
    const tool = toolsWith().get('oan_gofer_history')!;
    const text = await tool.run({ goferId: 'g1', since: '2026-08-05T00:00:00Z' });
    expect(getGoferChatMessages).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'g1', '2026-08-05T00:00:00Z');
    expect(text).toMatch(/No recorded conversation/);
  });

  // Injection acceptance: the budget is an injected host contract — under a small budget, keep the newest messages from the tail and hint how to read on
  it('超出注入的 toolResultBudget 时截掉最旧消息并给出 since 续读指引', async () => {
    getGoferChatMessages.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`,
        role: 'assistant' as const,
        content: `message number ${i} ${'x'.repeat(40)}`,
        createdAt: `2026-08-05T10:0${i}:00Z`,
      })),
    );
    const tool = toolsWith({ toolResultBudget: 200 }).get('oan_gofer_history')!;
    const text = await tool.run({ goferId: 'g1' });
    // The newest messages are present, the oldest are cut
    expect(text).toContain('message number 9');
    expect(text).not.toContain('message number 0');
    expect(text).toContain('omitted to fit the tool-result limit');
    expect(text).toContain('`since`');
  });

  it('requires a goferId', async () => {
    const tool = toolsWith().get('oan_gofer_history')!;
    await expect(tool.run({})).rejects.toThrow(/goferId/);
  });
});

describe('oan_delete_gofer', () => {
  beforeEach(() => {
    deleteGofer.mockReset();
    deleteGofer.mockResolvedValue({ deleted: true, goferId: 'g1' });
  });

  it('deletes the Gofer and reports its contact will go silent', async () => {
    const tool = toolsWith().get('oan_delete_gofer')!;
    const text = await tool.run({ goferId: ' g1 ' });
    expect(deleteGofer).toHaveBeenCalledWith('https://api.example', { kind: 'apiKey', apiKey: 'test-key-1' }, 'g1');
    expect(text).toContain('oan:g1');
    expect(text).toContain('will produce no further inbox items');
  });

  it('requires a goferId', async () => {
    const tool = toolsWith().get('oan_delete_gofer')!;
    await expect(tool.run({ goferId: '  ' })).rejects.toThrow(/goferId/);
    expect(deleteGofer).not.toHaveBeenCalled();
  });

  it('fails with the injected pairing hint when not paired', async () => {
    const tool = toolsWith({ readCredentials: () => undefined }).get('oan_delete_gofer')!;
    await expect(tool.run({ goferId: 'g1' })).rejects.toThrow(/HOW-TO-PAIR/);
  });
});

describe('oan_list_gofers', () => {
  beforeEach(() => {
    listGofers.mockReset();
  });

  it('summarizes the existing Gofers with their contact ids', async () => {
    listGofers.mockResolvedValue([
      { goferId: 'g1', name: 'Alpha', description: 'looking for X', discoveryStatus: 'in_discovery', createdAt: 't' },
    ]);
    const tool = toolsWith().get('oan_list_gofers')!;

    const text = await tool.run({});

    expect(text).toContain('g1');
    expect(text).toContain('Alpha');
    expect(text).toContain('contact oan:g1');
  });

  it('says so plainly when the account has no Gofer yet', async () => {
    listGofers.mockResolvedValue([]);
    const tool = toolsWith().get('oan_list_gofers')!;
    expect(await tool.run({})).toMatch(/no gofer/i);
  });
});

describe('oan_inbox（收件箱读取口：即取即销）', () => {
  /** Build one inbox item view (override fields as needed) */
  function inboxItem(overrides: Partial<OanInboxItemView> = {}): OanInboxItemView {
    return {
      eventId: 'e1',
      contactId: 'oan:g1',
      kind: 'message',
      body: 'hello',
      receivedAt: '2026-08-08T10:00:00Z',
      ...overrides,
    };
  }

  it('空收件箱时如实说明无事可做', async () => {
    const fetchInbox = vi.fn(async () => []);
    const tool = toolsWith({ fetchInbox }).get('oan_inbox')!;
    const text = await tool.run({});
    expect(text).toContain('No pending OAN items');
  });

  it('逐条列出条目（kind/联系人/正文/附件路径），消费全部 eventId，并给出处理指引', async () => {
    const fetchInbox = vi.fn(async () => [
      inboxItem({ eventId: 'e1', contactId: 'oan:g1', kind: 'message', body: 'What is your budget?' }),
      inboxItem({
        eventId: 'e2',
        contactId: 'oan:g2',
        kind: 'decision',
        body: 'Accept this match?',
        mediaPaths: ['/tmp/media/pic.png'],
      }),
    ]);
    const consumeInbox = vi.fn(async () => undefined);
    const tool = toolsWith({ fetchInbox, consumeInbox }).get('oan_inbox')!;

    const text = await tool.run({});

    expect(text).toContain('[message]');
    expect(text).toContain('oan:g1');
    expect(text).toContain('What is your budget?');
    expect(text).toContain('[decision]');
    expect(text).toContain('oan:g2');
    expect(text).toContain('Accept this match?');
    expect(text).toContain('attachments:');
    expect(text).toContain('/tmp/media/pic.png');
    expect(consumeInbox).toHaveBeenCalledWith(['e1', 'e2']);
    // Handling guidance (two-way disposition): answer what you can via oan_reply, bring the
    // rest to the user (ask or brief); decisions default to the user's yes/no, with the sole
    // exception of explicit prior authorization (receiver sovereignty)
    expect(text).toContain('oan_reply');
    expect(text).toContain('relay to your user');
    expect(text).toContain('unless they explicitly pre-authorized you to decide');
    // The three anti-mistriage guards: no third option, "just context" is not a disposition, and an idle close-out is allowed only after everything is disposed (neutral default)
    expect(text).toContain('reply-or-escalate, no third option');
    expect(text).toContain('not a disposition');
    expect(text).toContain('only valid after every item has its disposition');
  });

  it('注入 hostHints.idleSentinel 后收尾规则用宿主文案替换中性缺省', async () => {
    const fetchInbox = vi.fn(async () => [inboxItem()]);
    const tool = toolsWith({
      fetchInbox,
      consumeInbox: vi.fn(async () => undefined),
      hostHints: { ...hostHints, idleSentinel: 'HOST-IDLE-SENTINEL-RULE.' },
    }).get('oan_inbox')!;
    const text = await tool.run({});
    expect(text).toContain('HOST-IDLE-SENTINEL-RULE.');
    expect(text).not.toContain('only valid after every item has its disposition');
  });

  it('超过分页上限时只消费前一页，并提示剩余待取数量', async () => {
    // Build 13 items against a cap of 12: the 13th waits for the next call
    const items = Array.from({ length: 13 }, (_, i) =>
      inboxItem({ eventId: `e${i + 1}`, body: `msg ${i + 1}` }),
    );
    const fetchInbox = vi.fn(async () => items);
    const consumeInbox = vi.fn(async () => undefined);
    const tool = toolsWith({ fetchInbox, consumeInbox }).get('oan_inbox')!;

    const text = await tool.run({});

    expect(consumeInbox).toHaveBeenCalledWith(items.slice(0, 12).map((item) => item.eventId));
    expect(text).toContain('1 more pending');
    expect(text).toContain('msg 12');
    expect(text).not.toContain('msg 13');
  });

  it('消费标记失败不影响返回（最坏下次重复一次，不上抛）', async () => {
    const fetchInbox = vi.fn(async () => [inboxItem()]);
    const consumeInbox = vi.fn(async () => { throw new Error('disk full'); });
    const tool = toolsWith({ fetchInbox, consumeInbox }).get('oan_inbox')!;
    const text = await tool.run({});
    expect(text).toContain('hello');
  });

  it('读取面未接线（渠道未运行）时如实说明不可用', async () => {
    const tool = toolsWith().get('oan_inbox')!;
    const text = await tool.run({});
    expect(text).toContain('not available');
  });
});

describe('oan_ask_user（登记薄层：问题由 agent 在回合输出里转述，工具只记台账）', () => {
  it('登记成功：以规范化联系人 id 记账，并指引用自己的话向主人转述 + oan_reply 送达', async () => {
    const markEscalated = vi.fn(() => true);
    const tool = toolsWith({ markEscalated }).get('oan_ask_user')!;
    const result = await tool.run({ goferId: 'g1', question: 'Co-investment stance?' });
    expect(markEscalated).toHaveBeenCalledWith('oan:g1');
    expect(result).toContain('Registered');
    expect(result).toContain('in your own words');
    expect(result).toContain('oan_reply');
    expect(result).toContain('oan:g1');
  });

  it('goferId 已带 oan: 前缀时原样使用', async () => {
    const markEscalated = vi.fn(() => true);
    const tool = toolsWith({ markEscalated }).get('oan_ask_user')!;
    await tool.run({ goferId: 'oan:g1', question: 'q?' });
    expect(markEscalated).toHaveBeenCalledWith('oan:g1');
  });

  it('登记不可达（markEscalated 返回 false）：如实说明跳过，但转述指引不变', async () => {
    const tool = toolsWith({ markEscalated: vi.fn(() => false) }).get('oan_ask_user')!;
    const result = await tool.run({ goferId: 'g1', question: 'q?' });
    expect(result).toContain('Registration skipped');
    expect(result).toContain('in your own words');
    expect(result).toContain('oan_reply');
  });

  it('markEscalated 未注入（渠道未运行）：同样走跳过分支且指引完整', async () => {
    const tool = toolsWith().get('oan_ask_user')!;
    const result = await tool.run({ goferId: 'g1', question: 'q?' });
    expect(result).toContain('Registration skipped');
    expect(result).toContain('in your own words');
    expect(result).toContain('oan_reply');
  });

  it('缺参数时报错', async () => {
    const tool = toolsWith({ markEscalated: vi.fn(() => true) }).get('oan_ask_user')!;
    await expect(tool.run({ goferId: '', question: 'q' })).rejects.toThrow('required');
    await expect(tool.run({ goferId: 'g1' })).rejects.toThrow('required');
  });
});

describe('oan_reply（回程通道：把消息送达 Gofer 联系人）', () => {
  it('经活跃连接投递成功：报告已送达并禁止重发', async () => {
    const deliverToContact = vi.fn(async () => ({ via: 'connection' as const }));
    const tool = toolsWith({ deliverToContact }).get('oan_reply')!;
    const result = await tool.run({ contactId: 'g1', message: 'Six months.' });
    expect(deliverToContact).toHaveBeenCalledWith('oan:g1', 'Six months.');
    expect(result).toContain('Delivered to oan:g1');
    expect(result).toContain('conversation page');
    expect(result).toContain('Do not resend');
  });

  it('REST 直连投递成功：结果文案一致（不区分通路形态）', async () => {
    const deliverToContact = vi.fn(async () => ({ via: 'rest' as const }));
    const tool = toolsWith({ deliverToContact }).get('oan_reply')!;
    const result = await tool.run({ contactId: 'oan:conv:c1', message: 'hello' });
    expect(deliverToContact).toHaveBeenCalledWith('oan:conv:c1', 'hello');
    expect(result).toContain('Delivered to oan:conv:c1');
    expect(result).toContain('Do not resend');
  });

  it('带 filePath 时走文件投递：真实附件送达，文案含文件名', async () => {
    const deliverFileToContact = vi.fn(async () => ({ fileName: 'resume.pdf' }));
    const deliverToContact = vi.fn(async () => ({ via: 'connection' as const }));
    const tool = toolsWith({ deliverFileToContact, deliverToContact }).get('oan_reply')!;
    const result = await tool.run({ contactId: 'g1', message: 'Here it is.', filePath: '/tmp/resume.pdf' });
    expect(deliverFileToContact).toHaveBeenCalledWith('oan:g1', '/tmp/resume.pdf', 'Here it is.');
    expect(deliverToContact).not.toHaveBeenCalled();
    expect(result).toContain('resume.pdf');
    expect(result).toContain('real attachment');
  });

  it('投递失败时异常原样上抛（错误文案即给模型的指引）', async () => {
    const deliverToContact = vi.fn().mockRejectedValue(new Error('contact not reachable right now'));
    const tool = toolsWith({ deliverToContact }).get('oan_reply')!;
    await expect(tool.run({ contactId: 'g1', message: 'yes' })).rejects.toThrow('not reachable');
  });

  it('缺参数时报错', async () => {
    const tool = toolsWith({ deliverToContact: vi.fn() }).get('oan_reply')!;
    await expect(tool.run({ contactId: '', message: 'x' })).rejects.toThrow('required');
    await expect(tool.run({ contactId: 'g1', message: '  ' })).rejects.toThrow('required');
  });

  it('deliverToContact 未注入（回程未接线）：报错指引查看 oan_status', async () => {
    const tool = toolsWith().get('oan_reply')!;
    await expect(tool.run({ contactId: 'g1', message: 'x' })).rejects.toThrow(/oan_status/);
  });
});
