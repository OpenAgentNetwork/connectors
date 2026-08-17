import { describe, it, expect, vi } from 'vitest';
import { decodeEnvelope } from '../envelope.js';
import { OanProtocolError } from '../errors.js';

// Event envelope decoding/validation (see the OAN protocol document, openagentnetwork.ai/docs):
// seq/eventId are required for the backfill cursor and dedup; a version mismatch or unknown
// type does not block delivery and is only flagged through onWarning.
describe('decodeEnvelope', () => {
  const baseEnvelope = {
    v: 1,
    seq: '1',
    eventId: 'evt-1',
    type: 'system_notice',
    source: 'platform',
    payload: {},
    createdAt: new Date().toISOString(),
  };

  it('合法信封原样返回，不触发告警', () => {
    const onWarning = vi.fn();
    const envelope = decodeEnvelope(baseEnvelope, onWarning);
    expect(envelope.seq).toBe('1');
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('缺少 seq 时抛出 OanProtocolError', () => {
    const { seq: _seq, ...rest } = baseEnvelope;
    expect(() => decodeEnvelope(rest)).toThrow(OanProtocolError);
  });

  it('缺少 eventId 时抛出 OanProtocolError', () => {
    const { eventId: _eventId, ...rest } = baseEnvelope;
    expect(() => decodeEnvelope(rest)).toThrow(OanProtocolError);
  });

  it('版本不一致时仍返回信封，但触发 version_mismatch 告警', () => {
    const onWarning = vi.fn();
    const envelope = decodeEnvelope({ ...baseEnvelope, v: 2 }, onWarning);
    expect(envelope.v).toBe(2);
    expect(onWarning).toHaveBeenCalledWith({
      kind: 'version_mismatch',
      envelope: expect.objectContaining({ v: 2 }),
    });
  });

  it('未知事件类型时仍返回信封，但触发 unknown_event_type 告警（透传不丢弃）', () => {
    const onWarning = vi.fn();
    const envelope = decodeEnvelope({ ...baseEnvelope, type: 'future_event_type' }, onWarning);
    expect(envelope.type).toBe('future_event_type');
    expect(onWarning).toHaveBeenCalledWith({
      kind: 'unknown_event_type',
      envelope: expect.objectContaining({ type: 'future_event_type' }),
    });
  });

  it('非对象输入直接抛出 OanProtocolError', () => {
    expect(() => decodeEnvelope('not-an-object')).toThrow(OanProtocolError);
    expect(() => decodeEnvelope(null)).toThrow(OanProtocolError);
  });
});
