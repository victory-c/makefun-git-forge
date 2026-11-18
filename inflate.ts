// inflate.ts: a zlib (RFC 1950) / DEFLATE (RFC 1951) decoder for the small objects a push carries.
//
// node:zlib's inflateSync builds a whole stream object per call, which costs several times what inflating a
// one-kilobyte git object does; a pack of a few small objects spends most of its ingest time there. This
// decoder is plain JavaScript: canonical Huffman decoding through a lookup table, stored, fixed and dynamic
// blocks, and it reports exactly how many input bytes the stream used (the next pack entry starts there).
// git.ts uses it for objects whose declared size is small and keeps node:zlib for the rest.

const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/**
 * A canonical Huffman code. Codes up to PRIMARY bits decode through a direct lookup table over the next
 * PRIMARY input bits (LSB first, as DEFLATE packs them): entry = (symbol << 4) | codeLength, or 0 when the
 * code is longer. Longer codes take the canonical path: counts per length and the symbols in code order.
 */
interface Huffman {
  table: Int32Array;
  bits: number;
  counts: Int32Array;
  symbols: Int32Array;
}

const PRIMARY = 9;
const REVERSED = new Uint16Array(1 << PRIMARY);
for (let value = 0; value < REVERSED.length; value += 1) {
  let reversed = 0;
  for (let bit = 0; bit < PRIMARY; bit += 1) reversed = (reversed << 1) | ((value >>> bit) & 1);
  REVERSED[value] = reversed;
}

function workspace(capacity: number): Huffman {
  return { table: new Int32Array(1 << PRIMARY), bits: PRIMARY, counts: new Int32Array(16), symbols: new Int32Array(capacity) };
}
// Inflation is synchronous and non-reentrant. Separate scratch tables for the
// three dynamic alphabets eliminate per-object allocation without touching fixed tables.
const dynamicLit = workspace(288);
const dynamicDist = workspace(32);
const dynamicLength = workspace(19);
const offsets = new Int32Array(16);
const nextCodes = new Int32Array(16);

function buildHuffman(lengths: ArrayLike<number>, count: number, target?: Huffman): Huffman {
  const counts = target?.counts ?? new Int32Array(16);
  counts.fill(0);
  let maxLen = 0;
  for (let i = 0; i < count; i += 1) {
    const len = lengths[i];
    counts[len] += 1;
    if (len > maxLen) maxLen = len;
  }
  counts[0] = 0;
  const bits = Math.max(1, Math.min(maxLen, PRIMARY));
  const table = target?.table ?? new Int32Array(1 << bits);
  table.fill(0);
  // symbols in canonical order (by length, then by symbol)
  offsets.fill(0);
  for (let len = 1; len < 15; len += 1) offsets[len + 1] = offsets[len] + counts[len];
  const symbols = target?.symbols ?? new Int32Array(count);
  symbols.fill(0);
  for (let symbol = 0; symbol < count; symbol += 1) if (lengths[symbol] !== 0) symbols[offsets[lengths[symbol]]++] = symbol;
  // first canonical code of each length
  const next = nextCodes;
  next.fill(0);
  let code = 0;
  for (let len = 1; len <= 15; len += 1) {
    code = (code + counts[len - 1]) << 1;
    next[len] = code;
  }
  for (let symbol = 0; symbol < count; symbol += 1) {
    const len = lengths[symbol];
    if (len === 0 || len > bits) continue;
    const assigned = next[len];
    next[len] += 1;
    // DEFLATE sends codes most-significant bit first; the table is indexed by bits as read (LSB first)
    const reversed = REVERSED[assigned] >>> (PRIMARY - len);
    const entry = (symbol << 4) | len;
    for (let fill = reversed; fill < (1 << bits); fill += 1 << len) table[fill] = entry;
  }
  if (target !== undefined) {
    target.bits = bits;
    return target;
  }
  return { table, bits, counts, symbols };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
  if (fixedLit === null || fixedDist === null) {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    fixedLit = buildHuffman(lengths, 288);
    fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist];
}

export class InflateError extends Error {}

/**
 * Inflate the zlib stream at `input[offset]`. `expected` is the output size the caller knows (git's object
 * header); the result must match it. Returns the bytes and the offset just past the stream's Adler-32.
 */
export function inflateZlib(input: Buffer, offset: number, expected: number): { data: Buffer; next: number } {
  const cmf = input[offset];
  const flg = input[offset + 1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) throw new InflateError('not a plain zlib stream');
  let pos = offset + 2;
  let bitBuf = 0;
  let bitCount = 0;
  const out = Buffer.allocUnsafe(expected);
  let outPos = 0;

  const need = (n: number): void => {
    while (bitCount < n) {
      if (pos >= input.length) throw new InflateError('truncated deflate stream');
      bitBuf |= input[pos++] << bitCount;
      bitCount += 8;
    }
  };
  const take = (n: number): number => {
    need(n);
    const value = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return value;
  };
  const decode = (h: Huffman): number => {
    // fill up to 15 bits, tolerating the end of input (a short final code needs fewer bits)
    while (bitCount < 15 && pos < input.length) {
      bitBuf |= input[pos++] << bitCount;
      bitCount += 8;
    }
    const entry = h.table[bitBuf & ((1 << h.bits) - 1)];
    const len = entry & 15;
    if (len !== 0) {
      if (len > bitCount) throw new InflateError('truncated huffman code');
      bitBuf >>>= len;
      bitCount -= len;
      return entry >> 4;
    }
    // a code longer than the table: walk the canonical code one bit at a time (puff's method)
    let code = 0;
    let first = 0;
    let index = 0;
    for (let l = 1; l <= 15 && l <= bitCount; l += 1) {
      code |= (bitBuf >>> (l - 1)) & 1;
      const n = h.counts[l];
      if (code - n < first) {
        bitBuf >>>= l;
        bitCount -= l;
        return h.symbols[index + (code - first)];
      }
      index += n;
      first = (first + n) << 1;
      code <<= 1;
    }
    throw new InflateError('bad huffman code');
  };

  let final = 0;
  while (final === 0) {
    final = take(1);
    const type = take(2);
    if (type === 0) {
      // stored: drop to a byte boundary (the bit buffer holds whole unread bytes after that)
      bitBuf >>>= bitCount & 7;
      bitCount -= bitCount & 7;
      const len = take(16);
      const nlen = take(16);
      if ((len ^ 0xffff) !== nlen) throw new InflateError('bad stored block length');
      // the bit buffer may hold whole bytes read ahead: they are the block's first bytes, so give them back
      pos -= bitCount >> 3;
      bitBuf = 0;
      bitCount = 0;
      if (pos + len > input.length || outPos + len > expected) throw new InflateError('stored block overruns');
      input.copy(out, outPos, pos, pos + len);
      pos += len;
      outPos += len;
      continue;
    }
    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) [lit, dist] = fixedTables();
    else if (type === 2) {
      const hlit = take(5) + 257;
      const hdist = take(5) + 1;
      const hclen = take(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i += 1) codeLengths[ORDER[i]] = take(3);
      const lengthCode = buildHuffman(codeLengths, 19, dynamicLength);
      const lengths = new Uint8Array(hlit + hdist);
      let at = 0;
      while (at < hlit + hdist) {
        const symbol = decode(lengthCode);
        if (symbol < 16) lengths[at++] = symbol;
        else {
          let repeat: number;
          let value = 0;
          if (symbol === 16) {
            if (at === 0) throw new InflateError('repeat with no previous length');
            value = lengths[at - 1];
            repeat = 3 + take(2);
          } else if (symbol === 17) repeat = 3 + take(3);
          else repeat = 11 + take(7);
          if (at + repeat > hlit + hdist) throw new InflateError('too many code lengths');
          lengths.fill(value, at, at + repeat);
          at += repeat;
        }
      }
      lit = buildHuffman(lengths.subarray(0, hlit), hlit, dynamicLit);
      dist = buildHuffman(lengths.subarray(hlit), hdist, dynamicDist);
    } else throw new InflateError('reserved block type');

    for (;;) {
      const symbol = decode(lit);
      if (symbol < 256) {
        if (outPos >= expected) throw new InflateError('output longer than declared');
        out[outPos++] = symbol;
        continue;
      }
      if (symbol === 256) break;
      const li = symbol - 257;
      if (li >= 29) throw new InflateError('bad length symbol');
      const length = LENGTH_BASE[li] + take(LENGTH_EXTRA[li]);
      const di = decode(dist);
      if (di >= 30) throw new InflateError('bad distance symbol');
      const distance = DIST_BASE[di] + take(DIST_EXTRA[di]);
      if (distance > outPos) throw new InflateError('distance before the start');
      if (outPos + length > expected) throw new InflateError('output longer than declared');
      let from = outPos - distance;
      for (let i = 0; i < length; i += 1) out[outPos++] = out[from++];
    }
  }
  if (outPos !== expected) throw new InflateError('output shorter than declared');
  // give back whole bytes the bit buffer read ahead, then skip the Adler-32
  pos -= bitCount >> 3;
  const adlerAt = pos;
  if (adlerAt + 4 > input.length) throw new InflateError('missing adler-32');
  let a = 1;
  let b = 0;
  // NMAX=5552 bounds the unreduced sums below 2^32 even for 0xff bytes.
  // Two reductions per block replace two divisions for every output byte.
  for (let start = 0; start < expected; start += 5552) {
    const end = Math.min(expected, start + 5552);
    for (let i = start; i < end; i += 1) {
      a += out[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  if (((b << 16) | a) >>> 0 !== input.readUInt32BE(adlerAt)) throw new InflateError('adler-32 mismatch');
  return { data: out, next: adlerAt + 4 };
}
