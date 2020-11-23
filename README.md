Library to help with assembling build artifacts in-place.
Install with `fs-assembler`.

# Use

```js
import {Assembler} from 'fs-assembler';

const build = new Assembler('dist', {clean: true});

build.write('foo.json', async () => {
  const someObject = /* get from somewhere async */;
  return JSON.stringify(someObject);
});

build.copy('path/to/real/file.css', 'target.css');  // copies to target.css
build.copy(['x/file1', 'x/file2'], {base: 'x'});    // creates file1/file2

await build.touch('zero-file');  // touches zero-file, can optionally await

await build.done();  // waits on all jobs sofar

build.write('extraFile.js', 'its content');

await build.done();  // can wait a 2nd time
```

The code will throw if files are duplicated or you try to write outside the initial root.

The constructor accepts options:

- `clean`: whether to remove the target dir before starting
- `loader`: async method to load content when `.write()` called without content
- `validate`: method to validate or update target path (cannot be async)
