import {Assembler} from './assembler.js';

const a = new Assembler('test/dup', {clear: true});
a.write('foo', 'hello');
a.write('foo', 'hello');
try {
  await a.done();
  throw new Error('expected dup error');
} catch (e) {
  if (e.code !== 'EEXIST') {
    throw new Error('expected EEXIST error, was: ' + e.code);
  }
}
