// toolSpecToDshTool: JSON Schema compilation, argument self-validation (the host validates
// nothing), render emitting a text block, execute returning a
// string (the safety face of strict output.schema validation).
import { describe, expect, it } from 'vitest';
import type { OanToolSpec } from '@openagentnetwork/connector-core';
import { toolSpecToDshTool, validateToolArgs } from '../tools.js';

const spec: OanToolSpec = {
  name: 'oan_demo',
  description: 'demo tool',
  parameters: {
    target: { type: 'string', description: 'the target', required: true },
    note: { type: 'string', description: 'optional note' },
  },
  run: async (args) => `ran:${args.target}:${args.note ?? '-'}`,
};

const exec = { signal: new AbortController().signal };

describe('toolSpecToDshTool', () => {
  it('把参数声明编译成 object JSON Schema（required + additionalProperties:false）', () => {
    const tool = toolSpecToDshTool(spec);
    expect(tool.name).toBe('oan_demo');
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        target: { type: 'string', description: 'the target' },
        note: { type: 'string', description: 'optional note' },
      },
      required: ['target'],
      additionalProperties: false,
    });
  });

  it('无必填参数时不产出空 required 数组', () => {
    const tool = toolSpecToDshTool({ ...spec, parameters: { note: { type: 'string', description: 'n' } } });
    expect('required' in (tool.parameters as Record<string, unknown>)).toBe(false);
  });

  it('output 声明满足注册硬门槛：schema=string，render 产 text block', () => {
    const tool = toolSpecToDshTool(spec);
    expect(tool.output.schema).toEqual({ type: 'string' });
    expect(tool.output.render({}, 'hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('execute 透传参数并返回 run 的 string', async () => {
    const tool = toolSpecToDshTool(spec);
    await expect(tool.execute({ target: 'g1', note: 'x' }, exec)).resolves.toBe('ran:g1:x');
  });

  it('缺必填参数：抛带字段名的错误', async () => {
    const tool = toolSpecToDshTool(spec);
    await expect(tool.execute({ note: 'x' }, exec)).rejects.toThrow(/required parameter "target"/);
  });

  it('参数类型不符：抛带字段名的错误', async () => {
    const tool = toolSpecToDshTool(spec);
    await expect(tool.execute({ target: 42 }, exec)).rejects.toThrow(/"target" of oan_demo must be a string/);
  });

  it('非对象入参（模型 misbehave 输出裸值）按空对象处理，缺参错误可学', async () => {
    const tool = toolSpecToDshTool(spec);
    await expect(tool.execute('bare string', exec)).rejects.toThrow(/required parameter "target"/);
  });

  it('validateToolArgs 忽略未声明的多余字段', () => {
    expect(validateToolArgs(spec, { target: 'g1', extra: 'ignored' })).toEqual({ target: 'g1' });
  });
});
