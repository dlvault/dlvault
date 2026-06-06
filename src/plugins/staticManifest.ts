import vm from 'vm';

/**
 * Read a plugin's manifest WITHOUT executing the plugin.
 *
 * Why this exists: a plugin bundle is untrusted third-party code, and the only
 * thing standing between "a file appeared in data/plugins/" and "that file runs
 * inside the host process" is the user's accept click. Anything that has to know
 * a plugin's identity *before* that click — the loader's accept gate, the install
 * dialog's preview — must therefore be able to read the manifest without calling
 * `require()` on the bundle. Previously both did the opposite: require first, ask
 * questions after, which made the disclaimer and the file-hash check decorative.
 *
 * How: the manifest is a plain object literal in every bundle (esbuild emits
 * `var manifest = { id: "...", ... }`). We locate that literal, cut it out by
 * brace matching, and evaluate ONLY that expression in a fresh `vm` context with
 * an empty sandbox and a hard timeout. An object literal of primitives, arrays
 * and nested objects has nothing to reach for — no `require`, no `process`, no
 * globals of any kind — and the timeout bounds anything that tries (e.g. a
 * getter that loops). The plugin's own code is never entered.
 */

const DECLARATION_RE = /(?:^|[\s;{])(?:var|let|const)\s+manifest\s*=\s*\{/;
const ASSIGNMENT_RE = /(?:^|[\s;{])(?:module\.)?exports\.manifest\s*=\s*\{/;

/**
 * Index of the `{` that opens the manifest literal, or -1.
 */
function findManifestBrace(src: string): number {
  for (const re of [DECLARATION_RE, ASSIGNMENT_RE]) {
    const m = src.match(re);
    if (m && m.index !== undefined) {
      // The regex ends at the opening brace, so back up to it.
      return m.index + m[0].length - 1;
    }
  }
  return -1;
}

/**
 * Given the index of an opening `{`, return the index just past its matching
 * `}`, skipping over string literals, template literals and comments so a brace
 * inside `description: "a { here"` doesn't throw off the count. Returns -1 when
 * the literal is unterminated.
 */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    // Comments
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }

    // Strings and template literals — scan to the matching quote, honouring
    // backslash escapes. Template substitutions could nest braces, but a
    // manifest literal never contains one; if it did we'd bail out below.
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i++;
        i++;
      }
      if (i >= src.length) return -1;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Extract and evaluate the manifest literal from plugin source text.
 * Returns the raw object (still unvalidated) or null when it can't be read
 * statically — callers must treat null as "refuse", never as "assume harmless".
 */
export function extractManifestFromSource(source: string): unknown | null {
  const open = findManifestBrace(source);
  if (open === -1) return null;
  const close = matchBrace(source, open);
  if (close === -1) return null;

  const literal = source.slice(open, close);
  // Guard against pathological input before handing it to the VM.
  if (literal.length > 256 * 1024) return null;

  try {
    // A context whose every lookup resolves to `undefined`. Two jobs:
    //
    //  - Nothing is reachable. `require`, `process`, `global`, `fetch` — all
    //    undefined, so the expression has no way to act on this process.
    //  - Real manifests still parse. Bundles routinely reference a module-level
    //    constant from inside the literal (`options: HOSTER_OPTIONS`); an empty
    //    context throws ReferenceError on those, which would have made every
    //    such plugin unreadable. Resolving them to `undefined` keeps the fields
    //    we can read and simply drops the ones we can't — the full manifest is
    //    validated later, after the file is cleared to execute.
    const unresolved = new Proxy(Object.create(null), {
      has: () => true,
      get: () => undefined,
    });
    const context = vm.createContext(unresolved);
    const value = vm.runInContext(`(${literal})`, context, {
      timeout: 1000,
      displayErrors: false,
    });
    if (!value || typeof value !== 'object') return null;
    // Cross-realm object: copy through JSON so callers get a plain host object
    // with no exotic prototypes or getters attached. Unresolved fields are
    // `undefined` and JSON drops them, which is the behaviour we want.
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/** Convenience: just the declared id, or null when it isn't a plain string. */
export function extractManifestId(source: string): string | null {
  const raw = extractManifestFromSource(source) as { id?: unknown } | null;
  return raw && typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
}
