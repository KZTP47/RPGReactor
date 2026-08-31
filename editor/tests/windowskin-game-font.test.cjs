const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Windowskin = require(path.resolve(__dirname, '..', 'src', 'utils', 'Windowskin.js'));

test('loadGameFont registers the project font instead of falling back', async () => {
    // readFileBytes is async; forgetting to await it handed FontFace a
    // Promise, threw inside the try, and every message preview silently ran
    // on sans-serif while claiming to use the project font.
    let registered = null;
    global.FontFace = class {
        constructor(family, buffer) {
            if (!(buffer instanceof ArrayBuffer)) {
                throw new TypeError('FontFace needs a real ArrayBuffer');
            }
            this.family = family;
        }
        async load() { return this; }
    };
    global.document = global.document || {};
    global.document.fonts = { add: face => { registered = face; } };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-font-'));
    const filename = 'Main Font.woff';
    fs.writeFileSync(path.join(dir, filename), Buffer.from([0x77, 0x4f, 0x46, 0x46]));

    try {
        const family = await Windowskin.loadGameFont(dir, filename);
        assert.notEqual(family, 'sans-serif', 'the font actually loads');
        assert.equal(family, 'rr-preview-Main-Font-woff');
        assert.ok(registered, 'the face is added to document.fonts');
        assert.equal(registered.family, family);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a missing font file still resolves to the generic fallback', async () => {
    global.FontFace = global.FontFace || class { async load() { return this; } };
    global.document = global.document || {};
    global.document.fonts = global.document.fonts || { add() {} };
    const family = await Windowskin.loadGameFont(
        path.join(os.tmpdir(), 'rr-font-none'), 'Absent.woff');
    assert.equal(family, 'sans-serif');
});
