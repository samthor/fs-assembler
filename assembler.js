import path from 'path';
import {promises as fs, default as fsBase} from 'fs';
import stream from 'stream';


const copyFlags = fsBase.constants.COPYFILE_EXCL | fsBase.constants.COPYFILE_FICLONE;
const writeOptions = Object.freeze({encoding: 'utf8', flag: 'wx'});


/**
 * @param {!Array<string>|!Promise<!Array<string>>} all files to match
 * @param {{base: string|undefined}=}
 * @return {!stream.Readable}
 */
export function src(all, options={}) {
  const generate = async function *() {
    all = await all;
    if (typeof all === 'string') {
      all = [all];
    }

    const files = all.map((p) => File.fs(p));

    if (options.base) {
      for (const f of files) {
        f.path = path.relative(options.base, f.path);
      }
    }

    for (const f of files) {
      yield f;
    }
  };
  return stream.Readable.from(generate());
}


export class File {
  #path;
  #contents;

  constructor() {
    this.#path = '';
    this.#contents = null;
  }

  /**
   * @param {string} p to load
   * @param {!Object=} options to pass to createReadStream
   * @return {!File}
   */
  static fs(p, options={}) {
    const f = new File();
    f.#path = p;
    f.#contents = fsBase.createReadStream(p, options);
    return f;
  }

  /**
   * Reads the entire contents of this File, mutating its contents if nessecary. Useful to mitigate
   * stream vs non-stream access.
   * 
   * @param {string=} encoding to generate with (converts to string for convenience)
   * @return {string|!Buffer}
   */
  async read(encoding=undefined) {
    if (this.#contents instanceof stream.Readable) {
      const chunks = [];
      for await (const chunk of this.#contents) {
        chunks.push(chunk);
      }
      this.#contents = Buffer.concat(chunks);
    } else if (!(this.#contents instanceof Buffer)) {
      if (encoding !== undefined) {
        throw new TypeError(`non-file cannot be converted to ${encoding}`);
      }
      return null;
    }

    if (encoding !== undefined) {
      return this.contents.toString(encoding);
    }
    return this.#contents;
  }

  /**
   * @return {boolean} does this file have null contents
   */
  isNull() {
    return this.#contents === null;
  }

  /**
   * @return {boolean} is this a Buffer instance
   */
  isBuffer() {
    return this.#contents instanceof Buffer;
  }

  /**
   * @return {boolean} is this a stream.Readable instance
   */
  isStream() {
    return this.#contents instanceof stream.Readable;
  }

  /**
   * @return {!stream.Readable|!Buffer|null}
   */
  get contents() {
    return this.#contents;
  }

  /**
   * @param {!stream.Readable|!Buffer|null}
   */
  set contents(v) {
    if (v == null) {
      v = null;  // null-ish
    } else if (v instanceof stream.Readable) {
      // ok
    } else if (typeof v === 'string') {
      v = Buffer.from(v);
    } else if (!(v instanceof Buffer)) {
      throw new TypeError(`unsupported contents: ${v}`);
    }
    this.#contents = v;
  }

  /**
   * @return {string}
   */
  get path() {
    return this.#path;
  }

  /**
   * @param {string} v
   */
  set path(v) {
    v = path.normalize(v);
    if (v.endsWith(path.sep)) {
      v = v.slice(0, -path.sep.length);  // normalize guarantees there won't be more than one
    }
    this.#path = v;
  }
}


/**
 * @typedef {{
 *   clear?: boolean,
 *   loader?: function(string): any,
 *   validate?: function(string): string|undefined,
 * }}
 */
var AssemblerOptions;


/**
 * Assembles filesystem output into a shared root.
 *
 * Disallows duplicate file output, and provides a shared Promise for completion.
 */
export class Assembler {
  #root;
  #prework;
  #work = [];
  #activeWork = 0;
  #loader;
  #validate;

  /**
   * @param {string} root to root output to, not normalized
   * @param {AssemblerOptions=} options
   */
  constructor(root, options={}) {
    options = Object.assign({
      clear: false,
      loader: () => undefined,
      validate: () => undefined,
    }, options);

    this.#loader = options.loader;
    this.#validate = options.validate;

    if (process.version < 'v12') {
      throw new Error(`Assembler requires Node v12+`);
    }

    // When a stream is piped to us, make sure we keep track of its completion in a new Promise. As
    // of Node v13+, 'unpipe' is emitted when the pipe is finished (without explicitly calling
    // `.unpipe()`), so we can resolve it then.

    this.#root = root;
    this.#prework = this.constructor._prework(root, options);
  }

  static async _prework(root, options) {
    if (options.clear) {
      await fs.rmdir(root, {recursive: true});
    }
  }

  get prework() {
    return this.#prework;
  }

  /**
   * Returns a stream.Writable where {@link File} instances can be passed.
   *
   * @param {string=} to write to inside of dest
   * @param {{emitError: boolean}=} options whether to emit an error (true default)
   * @return {!stream.Writable}
   */
  dest(to = '.', options) {
    options = Object.assign({emitError: true}, options);
    const outer = this;

    return new class extends stream.Writable {
      constructor() {
        super({objectMode: true});

        const endHandlers = new Map();

        this.on('pipe', (src, ...arg) => {
          const p = new Promise((resolve, reject) => {
            const r = resolve;
            resolve = (arg) => r(arg || 'default');
            endHandlers.set(src, {resolve, reject});
            src.on('end', resolve);
            src.on('error', reject);
          });
          outer.#work.push(p);
        });

        this.on('unpipe', (src) => {
          const {resolve, reject} = endHandlers.get(src);
          endHandlers.delete(src);
          src.off('end', resolve);
          src.off('error', reject);
          resolve('unpipe');
          // We don't remove from this.#work, as this might already be waited on. In practice, this
          // is unlikely because unpiping is a rare thing to do in a build system.
        });
      }

      end(chunk, encoding, callback) {
        if (chunk) {
          throw new Error(`unsupported .end(chunk) for dest stream`);
        }
        // We close this writable (unfortunately).
        // TODO(samthor): We'd like not to, so that stream destinations can be reused, but this
        // breaks a bunch of built-in Node stuff.
        super.end();
        callback && this.on('finish', callback);
        return this;
      }

      _writev(chunks, callback) {
        const work = chunks.map(({chunk}) => {
          if (!(chunk instanceof File)) {
            throw new TypeError(`got non-File: ${chunk}`);
          }
          const target = path.join(to, chunk.path);
          return outer.write(target, chunk.contents);
        });
        Promise.all(work).then(() => callback()).catch((err) => {
          if (options.emitError) {
            callback(err)
          }
        });
      }
    };
  }

  /**
   * Normalizes and checks destination. Must not be async.
   *
   * @param {string} dest to normalize
   * @return {string} normalized dest including root
   */
  target(dest) {
    dest = path.normalize(dest);
    dest = this.#validate(dest) ?? dest;
    if (dest instanceof Promise) {
      throw new Error(`validate option cannot return Promise`);
    }

    const out = path.join(this.#root, dest);

    if (out === this.#root || out.startsWith(this.#root + path.sep)) {
      return out;
    }
    throw new Error(`can't write outside root: ${dest}`);
  }

  _work(method) {
    ++this.#activeWork;
    const p = this.#prework.then(() => method()).then(() => --this.#activeWork);
    this.#work.push(p);
    return p;
  }

  /**
   * Writes something file-like to the destination path. Accepts a Buffer, string, or a Promise,
   * or a function which returns any of the prior.
   *
   * Failures will be caught and rethrown in done.
   *
   * @param {string|!Promise<string>} maybePromiseDest to write to within the root
   * @param {*} raw to write
   * @return {!Promise<void>}
   */
  write(maybePromiseDest, raw) {
    if (typeof raw === 'function') {
      raw = raw();  // if this is a function, invoke immediately
    }

    return this._work(async () => {
      const dest = this.target(await maybePromiseDest);

      let unknown = await raw;

      await fs.mkdir(path.dirname(dest), {recursive: true});

      if (!(unknown instanceof stream.Stream)) {
        let data;

        if (unknown == null) {
          const rel = path.relative(this.#root, dest);
          unknown = await this.#loader(rel);
        }

        // This ensures we support Buffer, string, or object-like JSON.
        if (unknown instanceof Buffer || typeof unknown === 'string') {
          data = unknown;
        } else if (!unknown || typeof unknown !== 'object') {
          throw new TypeError(`unknown object to write: ${unknown}`);
        } else {
          data = JSON.stringify(unknown);
        }

        await fs.writeFile(dest, data, writeOptions);
        return undefined;
      }

      // Wrap, as there's no implicit promises for streams as they're naturally async.
      const ws = fsBase.createWriteStream(dest, writeOptions)
      await new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('finish', resolve);
        unknown.pipe(ws, {end: true});  // option is default, list explicit anyway
      });
    });
  }

  /**
   * Touches a file in the destination path.
   *
   * @param {string|!Promise<string>} dest to write to within the root
   * @return {!Promise<void>}
   */
  touch(dest) {
    return this.write(dest, Buffer.from(''));
  }

  /**
   * Makes the target directory. This is redundant if files are being copied, but can be useful to
   * ensure empty directories.
   * 
   * @param {string|!Promise<string>} maybePromiseDest to create within the root
   * @return {!Promise<void>} when done
   */
  mkdir(maybePromiseDest) {
    return this._work(async () => {
      const dest = this.target(await maybePromiseDest, true);
      await fs.mkdir(dest, {recursive: true});
    });
  }

  /**
   * Copies source file(s) to the destination path within the root.
   *
   * The destination is treated as a directory if the passed src is an Array, or the directory ends
   * with the path separator (e.g. "foo/").
   *
   * @param {*} src to copy, either string-like or array
   * @param {(string|!Promise<string>)=} maybePromiseDest to copy to, within the root
   * @param {{base: string|undefined}=} options
   * @return {!Promise<void>} when done
   */
  copy(src, maybePromiseDest, options) {
    if (options === undefined && maybePromiseDest && typeof maybePromiseDest === 'object' && !(maybePromiseDest instanceof Promise)) {
      // allow optional 'dest'
      options = maybePromiseDest;
      maybePromiseDest = undefined;
    }
    options = Object.assign({base: '.'}, options);

    return this._work(async () => {
      src = await src;
      const dest = this.target(await maybePromiseDest || '.');

      // This is a single file, copy it directly to the target.
      const treatAsDir = Array.isArray(src) || dest.endsWith(path.sep);
      if (!treatAsDir) {
        if (typeof src !== 'string') {
          throw new TypeError(`unsupported src: ${src}`);
        } else if (options.base !== '.') {
          throw new TypeError(`unsupported options.base for copy: ${options.base}, ${src}`);
        }
        await fs.mkdir(path.dirname(dest), {recursive: true});
        await fs.copyFile(src, dest, copyFlags);
        return undefined;
      }

      // We're treating this as a dir copy. Ensure src is an array.
      if (!Array.isArray(src)) {
        src = [src];
      }

      // Allow duplicates within a single call.
      const srcSet = new Set(src);
      src = [...srcSet];

      // Otherwise, copy everything from the src to the target dir.
      const copies = src.map(async (p) => {
        const target = this.target(path.relative(options.base, p));
        await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.copyFile(p, target, copyFlags);
      });
      return Promise.all(copies);
    });
  }

  /**
   * Creates a link in dest pointing to target.
   *
   * @param {string} target to symlink to
   * @param {string} dest where to create symlink
   * @return {!Promise<void>} when done
   */
  symlink(target, dest) {
    return this._work(async () => {
      await fs.mkdir(path.dirname(dest), {recursive: true});
      await fs.symlink(target, dest);
    });
  }

  /**
   * Returns whether there is any active work. This method checks how many outstanding Promises
   * remain, and may transition quickly from true => false.
   *
   * @return {boolean} whether there's any active work
   */
  get hasActiveWork() {
    return this.#activeWork !== 0;
  }

  /**
   * @param {{stable: boolean}=} options if stable, must not add more tasks
   * @return {!Promise<number>} a done promise as the Assembler stands right now
   */
  async done(options) {
    options = Object.assign({stable: false}, options);

    for (;;) {
      const work = this.#work.slice();
      await Promise.all(work);

      if (this.#work.length === work.length) {
        return work.length;
      }

      if (options.stable) {
        throw new Error(`assembler was not stable: started with ${work.length} tasks, ` +
                        `finished with ${this.#work.length}`);
      }
    }
  }

}
