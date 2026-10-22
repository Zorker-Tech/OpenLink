import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/workflows/stat-keyed-parse-cache.ts';
const NOW = 1_000_000;
const makeFile = (root: string, name: string, mtimeMs: number): string => { const file = path.join(root, name); fs.writeFileSync(file, name); fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs)); return file; };
describe('the stat-keyed parse cache', () => {
  it('parses once, answers from the cache, and parses again when a file changed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-cache-'));
    try {
      const file = makeFile(root, 'a.txt', NOW - 10_000);
      const cache = new mod.StatKeyedParseCache(4, () => NOW);
      let parses = 0; const parse = () => { parses += 1; return 'parsed-' + parses; };
      assert.equal(cache.read([file], parse), 'parsed-1');
      assert.equal(cache.read([file], parse), 'parsed-1');
      assert.equal(parses, 1, 'an unchanged file is not parsed twice');
      fs.utimesSync(file, new Date(NOW - 5_000), new Date(NOW - 5_000));
      assert.equal(cache.read([file], parse), 'parsed-2');
      assert.equal(parses, 2, 'a touched file is parsed again');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('answers a file whose tick could still hide an edit, but does not cache it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-cache-'));
    try {
      const file = makeFile(root, 'b.txt', NOW);
      const cache = new mod.StatKeyedParseCache(4, () => NOW);
      let parses = 0; const parse = () => { parses += 1; return 'p' + parses; };
      assert.equal(cache.read([file], parse), 'p1');
      assert.equal(cache.read([file], parse), 'p2', 'a racy parse is not kept');
      assert.equal(parses, 2);
      // Half the window old is still racy.
      const halfWindow = makeFile(root, 'h.txt', NOW - mod.RACY_MTIME_TICK_WINDOW_MS / 2);
      const halfWindowParse = 'p' + (parses + 1);
      assert.equal(cache.read([halfWindow], parse), halfWindowParse);
      assert.equal(cache.read([halfWindow], parse), 'p' + (parses + 1), 'a racy parse is not kept');
      // Exactly the window old is old enough to cache.
      const settled = makeFile(root, 'c.txt', NOW - mod.RACY_MTIME_TICK_WINDOW_MS);
      assert.equal(cache.read([settled], parse), 'p3');
      assert.equal(cache.read([settled], parse), 'p3');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('drops the entry of a file that is gone, and does not parse for it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-cache-'));
    try {
      const file = makeFile(root, 'd.txt', NOW - 10_000);
      const cache = new mod.StatKeyedParseCache(4, () => NOW);
      let parses = 0; const parse = () => { parses += 1; return 'p'; };
      cache.read([file], parse);
      fs.rmSync(file);
      assert.equal(cache.read([file], parse), null);
      assert.equal(parses, 1, 'a missing file is not parsed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('parses a file set it cannot fingerprint, and keeps at most its capacity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-cache-'));
    try {
      const a = makeFile(root, 'a.txt', NOW - 10_000); const b = makeFile(root, 'b.txt', NOW - 10_000); const c = makeFile(root, 'c.txt', NOW - 10_000);
      const cache = new mod.StatKeyedParseCache(2, () => NOW);
      let parses = 0; const parse = () => { parses += 1; return 'p' + parses; };
      cache.read([a], parse); cache.read([b], parse); cache.read([c], parse);
      const before = parses;
      cache.read([a], parse);
      assert.equal(parses, before + 1, 'the first entry was evicted');
      cache.read([c], parse);
      assert.equal(parses, before + 1, 'the newest entry is still cached');
      const unfingerprintable = 'p' + (parses + 1);
      assert.equal(cache.read(['bad\u0000path'], parse), unfingerprintable, 'an unfingerprintable set is parsed without caching');
      assert.equal(mod.DEFAULT_STAT_PARSE_CACHE_CAPACITY, 2_048);
      assert.equal(mod.RACY_MTIME_TICK_WINDOW_MS, 2_000);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});