// Deterministic differential tests: no external packages or network.
import assert from 'node:assert/strict';
import { deflateSync, constants } from 'node:zlib';
import { inflateZlib } from '../inflate.ts';

let seed = 0x2b57a921;
function random() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return seed >>> 0;
}
let cases = 0;
for (const size of [0,1,2,7,31,255,1024,4096,5551,5552,5553,32768,65536,100000]) {
  for (let pattern = 0; pattern < 5; pattern++) {
    const data = Buffer.alloc(size);
    for (let i=0; i<size; i++) data[i] = pattern === 0 ? random() & 255 : pattern === 1 ? 255 : pattern === 2 ? i % 13 : pattern === 3 ? 97 + random() % 26 : (i % 129 === 0 ? random() : 0);
    for (const level of [0,1,6,9]) {
      for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED, constants.Z_HUFFMAN_ONLY]) {
        const compressed = deflateSync(data, { level, strategy });
        const prefix = Buffer.from('pack-prefix');
        const input = Buffer.concat([prefix,compressed,Buffer.from('next-object-trailer')]);
        const result = inflateZlib(input,prefix.length,size);
        assert.deepEqual(result.data,data);
        assert.equal(result.next,prefix.length+compressed.length);
        const damaged = Buffer.from(compressed); damaged[damaged.length-1] ^= 1;
        assert.throws(()=>inflateZlib(damaged,0,size));
        cases++;
      }
    }
  }
}
console.log(`inflate differential: ${cases} valid streams and ${cases} corrupted checksums passed`);
