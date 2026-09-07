/* JSON file boundary: decode Unicode BOMs before parsing, without changing JSON.parse. */
(function(root) {
    'use strict';
    function decode(source) {
        if (typeof source === 'string') return source.replace(/^\uFEFF/, '');
        const bytes = ArrayBuffer.isView(source)
            ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
            : source instanceof ArrayBuffer ? new Uint8Array(source) : null;
        if (!bytes) throw new TypeError('JSON input must be text or bytes.');
        let encoding = 'utf-8', offset = 0;
        if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
        else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
        const Decoder = typeof TextDecoder !== 'undefined' ? TextDecoder : require('util').TextDecoder;
        // Malformed bytes must remain errors, rather than corrupting names or event text.
        return new Decoder(encoding, {fatal:true, ignoreBOM:true}).decode(bytes.subarray(offset));
    }
    function parse(source) { return JSON.parse(decode(source)); }
    function read(fs, filePath) { return parse(fs.readFileSync(filePath)); }
    const api = {decode, parse, read};
    root.RRJson = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
