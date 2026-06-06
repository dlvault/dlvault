import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { audioLanguageTags } from '../../src/utils/ffprobe';
import { logger } from '../../src/utils/logger';

/** A stand-in for the ffprobe child process. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const JSON_OUT = JSON.stringify({ streams: [{ tags: { language: 'ger' } }, { tags: { language: 'eng' } }] });

describe('ffprobe — audioLanguageTags (spawn wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('returns the tags when ffprobe exits cleanly', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = audioLanguageTags('/movies/x.mkv');
    child.stdout.emit('data', Buffer.from(JSON_OUT));
    child.emit('close', 0);

    expect(await p).toEqual(['ger', 'eng']);
  });

  it('reassembles output that arrives in several chunks', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = audioLanguageTags('/movies/x.mkv');
    child.stdout.emit('data', Buffer.from(JSON_OUT.slice(0, 20)));
    child.stdout.emit('data', Buffer.from(JSON_OUT.slice(20)));
    child.emit('close', 0);

    expect(await p).toEqual(['ger', 'eng']);
  });

  it('asks ffprobe only for audio-stream language tags', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = audioLanguageTags('/movies/x.mkv');
    child.emit('close', 0);
    await p;

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-select_streams', 'a', 'stream_tags=language']));
    expect(args.at(-1)).toBe('/movies/x.mkv');
  });

  it('answers null — not [] — on a non-zero exit', async () => {
    // The distinction matters: callers must read null as "cannot judge". Treating
    // it as "no language present" would flag every file.
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = audioLanguageTags('/movies/x.mkv');
    child.emit('close', 1);

    expect(await p).toBeNull();
  });

  it('answers null when spawn itself throws', async () => {
    spawnMock.mockImplementation(() => { throw new Error('EPERM'); });

    expect(await audioLanguageTags('/movies/x.mkv')).toBeNull();
  });

  it('answers null and warns exactly once when ffprobe is not installed', async () => {
    const first = fakeChild();
    spawnMock.mockReturnValueOnce(first);
    const p1 = audioLanguageTags('/movies/a.mkv');
    const enoent: NodeJS.ErrnoException = new Error('spawn ffprobe ENOENT');
    enoent.code = 'ENOENT';
    first.emit('error', enoent);
    expect(await p1).toBeNull();

    const warnings = vi.mocked(logger.warn).mock.calls.filter(c => String(c[0]).includes('ffprobe not found'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toMatch(/FFPROBE_PATH/);

    // A second miss stays quiet — otherwise every scan spams the log.
    const second = fakeChild();
    spawnMock.mockReturnValueOnce(second);
    const p2 = audioLanguageTags('/movies/b.mkv');
    second.emit('error', enoent);
    expect(await p2).toBeNull();

    expect(vi.mocked(logger.warn).mock.calls.filter(c => String(c[0]).includes('ffprobe not found')))
      .toHaveLength(1);
  });

  it('kills a hung ffprobe and answers null', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = audioLanguageTags('/movies/x.mkv', 5000);
    await vi.advanceTimersByTimeAsync(5001);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await p).toBeNull();
  });

  it('ignores a late close after the timeout already answered', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = audioLanguageTags('/movies/x.mkv', 5000);
    await vi.advanceTimersByTimeAsync(5001);
    child.stdout.emit('data', Buffer.from(JSON_OUT));
    child.emit('close', 0);

    expect(await p).toBeNull();
  });
});
