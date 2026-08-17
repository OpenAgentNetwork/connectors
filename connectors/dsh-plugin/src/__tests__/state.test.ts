// State paths: the three-level resolveDshHome precedence (including the trim rule) and ~ expansion.
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHomePath, oanStatePaths, resolveDshHome } from '../state.js';

describe('resolveDshHome', () => {
  it('显式配置最高优先', () => {
    expect(resolveDshHome('/opt/dsh', { DSH_HOME: '/env/dsh' })).toBe(path.resolve('/opt/dsh'));
  });

  it('$DSH_HOME 次之', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '/env/dsh' })).toBe(path.resolve('/env/dsh'));
  });

  it('空/纯空白 $DSH_HOME 视为未设置（绝不解析到 cwd）', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(path.join(homedir(), '.dsh'));
    expect(resolveDshHome(undefined, {})).toBe(path.join(homedir(), '.dsh'));
  });

  it('~ 展开：~、~/、~\\ 三种形态', () => {
    expect(expandHomePath('~')).toBe(homedir());
    expect(expandHomePath('~/x')).toBe(path.join(homedir(), 'x'));
    expect(expandHomePath('~\\x')).toBe(path.join(homedir(), 'x'));
    expect(expandHomePath('/abs')).toBe('/abs');
  });
});

describe('oanStatePaths', () => {
  it('全部状态文件位于 <dshHome>/oan/ 下', () => {
    const paths = oanStatePaths({ DSH_HOME: '/env/dsh' });
    const stateDir = path.resolve('/env/dsh/oan');
    expect(paths.stateDir).toBe(stateDir);
    expect(paths.inboxPath).toBe(path.join(stateDir, 'inbox.json'));
    expect(paths.cursorPath).toBe(path.join(stateDir, 'cursor.json'));
    expect(paths.takeoverPath).toBe(path.join(stateDir, 'takeover.json'));
    expect(paths.ledgerPath).toBe(path.join(stateDir, 'ledger.json'));
    expect(paths.wakePath).toBe(path.join(stateDir, 'wake.json'));
    expect(paths.advisoryPath).toBe(path.join(stateDir, 'advisory.json'));
    expect(paths.lockPath).toBe(path.join(stateDir, 'lock.json'));
    expect(paths.mediaDir).toBe(path.join(stateDir, 'media'));
  });
});
