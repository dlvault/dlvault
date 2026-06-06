import zlib from 'zlib';

/**
 * Minimal POSIX (ustar) tar writer + gzip, so a backup can be ONE self-contained
 * file containing the database, the encryption key and the installed plugins.
 *
 * Hand-rolled rather than pulled from npm: tar is a genuinely simple format
 * (512-byte header, padded content, two zero blocks to close), the project keeps
 * a deliberately small dependency set, and shelling out to `tar` would tie
 * backups to a binary that isn't guaranteed on every host the app runs on.
 * The output is a completely standard `.tar.gz` — openable with tar, 7-Zip,
 * Windows Explorer, anything.
 */

const BLOCK_SIZE = 512;

export interface ArchiveEntry {
  /** Path inside the archive, e.g. "plugins/example-source.dlvault.js". */
  name: string;
  content: Buffer;
  /** Unix mode; defaults to 0644. Use 0600 for the key file. */
  mode?: number;
  mtime?: Date;
}

/** Write `value` into `buf` at `offset` as a NUL-terminated ASCII string. */
function writeString(buf: Buffer, value: string, offset: number, length: number): void {
  buf.write(value.slice(0, length - 1), offset, length - 1, 'ascii');
}

/**
 * tar stores numbers as zero-padded OCTAL strings with a trailing NUL.
 * Field width includes that terminator, hence `length - 1` digits.
 */
function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const digits = Math.max(0, length - 1);
  buf.write(value.toString(8).padStart(digits, '0').slice(-digits), offset, digits, 'ascii');
  buf.writeUInt8(0, offset + digits);
}

function buildHeader(entry: ArchiveEntry): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  // ustar splits long paths into prefix(155) + name(100). Our names are short,
  // so reject anything that would need splitting rather than truncate silently.
  if (Buffer.byteLength(entry.name) > 99) {
    throw new Error(`Archive entry name too long for ustar: ${entry.name}`);
  }

  writeString(header, entry.name, 0, 100);
  writeOctal(header, entry.mode ?? 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);                                  // uid
  writeOctal(header, 0, 116, 8);                                  // gid
  writeOctal(header, entry.content.length, 124, 12);
  writeOctal(header, Math.floor((entry.mtime ?? new Date()).getTime() / 1000), 136, 12);
  header.write('        ', 148, 8, 'ascii');                      // checksum placeholder
  header.write('0', 156, 1, 'ascii');                             // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeString(header, 'root', 265, 32);                           // uname
  writeString(header, 'root', 297, 32);                           // gname

  // Checksum = unsigned sum of every header byte, with the checksum field
  // itself counted as eight spaces (which is why it was pre-filled above).
  let sum = 0;
  for (const byte of header) sum += byte;
  writeOctal(header, sum, 148, 7);
  header.writeUInt8(0x20, 155);                                   // trailing space, per spec

  return header;
}

/** Zero-padding that rounds `size` up to the next 512-byte boundary. */
function padding(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder, 0);
}

/** Build an uncompressed tar image from the given entries. */
export function buildTar(entries: ArchiveEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(buildHeader(entry), entry.content, padding(entry.content.length));
  }
  // Two zero blocks mark end-of-archive.
  parts.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(parts);
}

/** Build a gzipped tar image — the `.tar.gz` a backup is written as. */
export function buildTarGz(entries: ArchiveEntry[]): Buffer {
  return zlib.gzipSync(buildTar(entries), { level: 6 });
}

/**
 * Read a tar image back into its entries. Used by the restore path and by the
 * tests that prove an archive round-trips.
 */
export function readTarGz(archive: Buffer): ArchiveEntry[] {
  const tar = zlib.gunzipSync(archive);
  const entries: ArchiveEntry[] = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    // A zero block means end-of-archive.
    if (header.every(b => b === 0)) break;

    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const modeField = header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim();

    offset += BLOCK_SIZE;
    entries.push({
      name,
      content: Buffer.from(tar.subarray(offset, offset + size)),
      mode: parseInt(modeField, 8) || 0o644,
    });
    offset += size + padding(size).length;
  }

  return entries;
}
