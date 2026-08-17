import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OAN_REST_PATHS } from '../rest-paths.js';

// docs/oan-protocol.md is the frozen protocol v1 text; this test prevents anyone from adding
// a new endpoint to OAN_REST_PATHS while forgetting to update the document — it does not check
// wording, only that the "shape" of every endpoint path actually appears in the document body.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_DOC_PATH = path.resolve(__dirname, '../../../../docs/oan-protocol.md');
const protocolDoc = readFileSync(PROTOCOL_DOC_PATH, 'utf-8');

// Placeholder literal for path parameters: passed uniformly when invoking parameterized path
// builders, then loosely matched against however the document names its path parameters
// (:id / :goferId / :apiKeyId, ...), so differing parameter names between code and document
// never produce false "missing endpoint" reports
const PLACEHOLDER = '__PARAM__';

// Recursively expand OAN_REST_PATHS: strings are collected as-is; functions are invoked once
// with one placeholder per declared parameter (fn.length) to obtain the path template — this
// also covers multi-parameter endpoints (e.g. conversationId + attachmentId two-level paths);
// basePath is skipped (it is a prefix, not a standalone endpoint)
function flattenPathTemplates(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
  } else if (typeof node === 'function') {
    const fn = node as (...params: string[]) => string;
    const args = Array.from({ length: fn.length }, () => PLACEHOLDER);
    acc.push(fn(...args));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'basePath') continue;
      flattenPathTemplates(value, acc);
    }
  }
  return acc;
}

// Convert a path template into a lenient regex: placeholder segments may match any :xxx
// parameter spelling used in the document, while the remaining static fragments are escaped
// and required verbatim (not necessarily adjacent, allowing query-string suffixes in between)
function templateToRegex(template: string): RegExp {
  const escaped = template
    .split(PLACEHOLDER)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[:a-zA-Z]+');
  return new RegExp(escaped);
}

describe('协议文档端点覆盖性（docs/oan-protocol.md vs OAN_REST_PATHS）', () => {
  const templates = flattenPathTemplates(OAN_REST_PATHS);

  it('OAN_REST_PATHS 穷举端点数（新增/删除端点需同步更新此断言与文档）', () => {
    // auth 5 + apiKeys 2 + events 3 + gofers 9 + threads 5 + matchRequests 2 + conversations 3
    expect(templates.length).toBe(29);
  });

  it.each(templates)('文档收录端点路径形状：%s', (template) => {
    const regex = templateToRegex(template);
    expect(regex.test(protocolDoc)).toBe(true);
  });

  it('文档提及全部八种事件类型', () => {
    const eventTypes = [
      'gofer_message', 'gofer_question', 'session_summary', 'pair_proposed',
      'match_request', 'match_decided', 'relay_message', 'system_notice',
    ];
    for (const type of eventTypes) {
      expect(protocolDoc.includes(type)).toBe(true);
    }
  });

  it('文档提及全部四种消息来源', () => {
    const sources = ['platform', 'own_gofer', 'counterpart_gofer', 'counterpart_party'];
    for (const source of sources) {
      expect(protocolDoc.includes(source)).toBe(true);
    }
  });
});
