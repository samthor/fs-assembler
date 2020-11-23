import fs from 'fs';
import test from 'ava';
import * as assembler from './assembler.js';
import {pipeline} from 'stream/promises';
import glob from 'fast-glob';
const {Assembler} = assembler;

function checkFile(t, p, expected, info) {
  const actual = fs.readFileSync(p, 'utf-8');
  t.deepEqual(actual, expected, info);
}

function finallyAll(...promises) {
  const noop = () => {};
  promises = promises.map((p) => p.catch(noop));
  return Promise.all(promises);
}

test('duplicates', async (t) => {
  const a = new Assembler('test/dup', {clear: true});
  const p1 = a.write('foo', 'hello');
  const p2 = a.write('foo', 'hello');
  try {
    await a.done();
    throw new Error('expected dup error');
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw new Error('expected EEXIST error, was: ' + e.code);
    }
  }

  // We'll throw in an unpredictable order, so wait until both files have been written to check.
  await finallyAll(p1, p2);
  checkFile(t, 'test/dup/foo', 'hello');
});

test('can\'t write outside root', async (t) => {
  const a = new Assembler('test/root', {clear: true});
  await t.throwsAsync(a.write('../blah', 'foo'));
  await a.write('../root/blah', 'hello');  // should pass
});

test('validate', async (t) => {
  const a = new Assembler('test/validate', {
    clear: true,
    validate(p) {
      if (p === 'x') {
        throw new Error('x is disallowed');
      } else if (p === 'y') {
        return 'x';  // write x instead
      }
    }
  });

  await t.throwsAsync(a.write('x'), undefined, 'should not write');
  await a.write('y', 'should write');
  checkFile(t, 'test/validate/x', 'should write');
});

test('loader', async (t) => {
  const a = new Assembler('test/loader', {
    clear: true,
    async loader(p) {
      if (p === 'foo.json') {
        return JSON.stringify({hi: 'there'});
      }
    },
  });

  await a.write('foo.json');
  checkFile(t, 'test/loader/foo.json', '{"hi":"there"}')
});

test('pipe', async (t) => {
  const a = new Assembler('test/pipe', {clear: true});

  const f = new assembler.File();
  f.contents = Buffer.from('hello');
  f.path = 'x';

  const dest = a.dest('to/inner/dir');
  dest.write(f);

  await a.done();
  checkFile(t, 'test/pipe/to/inner/dir/x', 'hello')

  f.path = '../foo';

  const target = a.dest('.');
  target.write(f);
  // TODO(samthor): We need to catch 'error' here or Node barfs.
  target.on('error', () => {});
  await t.throwsAsync(a.done());  // but writing does

  const a2 = new Assembler('test/pipe');

  const files = glob('test/pipe/to/inner/dir/*');
  const readable = assembler.src(files, {base: 'test/pipe/to/inner/dir'});
  await pipeline(readable, a2.dest('.'));
  await a2.done();
  checkFile(t, 'test/pipe/x', 'hello')

  const readable2 = assembler.src(files, {base: 'test/pipe/to/inner/dir'});
  await pipeline(readable2, a2.dest('new'));
  await a2.done();
  checkFile(t, 'test/pipe/new/x', 'hello')
});