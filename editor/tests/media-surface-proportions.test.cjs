const test = require('node:test');
const assert = require('node:assert/strict');
const Editor = require('../src/event/commands/MediaSurfaceEditor.js');

function fixture() {
    const editor = new Editor({}, {});
    editor.data = Editor.defaults();
    editor.data.movie = 'poster.png';
    editor.movies = [{relativePath:'poster.png',absolutePath:'/poster.png'}];
    editor._updatePreviews = () => {};
    return editor;
}

async function probes(run) {
    const old = global.document, elements = [];
    global.document = { createElement() {
        const callbacks = new Map();
        const element = { addEventListener(type, callback) { callbacks.set(type,callback); },
            removeEventListener(type) { callbacks.delete(type); }, removeAttribute() {}, load() {},
            emit(type) { callbacks.get(type)?.(); } };
        elements.push(element); return element;
    } };
    try { await run(elements); } finally { global.document = old; }
}

test('media selection sizes portrait, square and landscape surfaces from decoded dimensions', async () => {
    await probes(async elements => {
        for (const [width,height] of [[600,1200],[800,800],[1920,1080]]) {
            const e=fixture(),ready=e._loadMediaDimensions(true),p=elements.at(-1);
            Object.assign(p,{naturalWidth:width,naturalHeight:height});p.emit('load');
            assert.equal(await ready,true);assert.equal(e.data.width/e.data.height,width/height);
            assert.equal(Math.max(e.data.width,e.data.height),320);
            assert.equal(e.data.corners[1].x-e.data.corners[0].x,e.data.width);
            assert.equal(e.data.corners[2].y-e.data.corners[1].y,e.data.height);
            const restored=Editor.parse(Editor.build('ShowVideoSurface',e.data));
            assert.equal(restored.width/restored.height,width/height);
        }
    });
});

test('opening saved media and opting out of proportions preserve authored geometry', async () => {
    await probes(async elements => {
        for(const fit of [false,true]) {
            const e=fixture();e.keepProportions=false;e.data.width=275;e.data.height=123;
            const before=JSON.stringify(e.data),ready=e._loadMediaDimensions(fit),p=elements.at(-1);
            Object.assign(p,{naturalWidth:400,naturalHeight:800});p.emit('load');await ready;
            assert.equal(JSON.stringify(e.data),before);
            e.keepProportions=true;e._fitMediaProportions();assert.equal(e.data.width/e.data.height,.5);
        }
    });
});

test('late or failed metadata cannot overwrite newer media or manual sizing', async () => {
    await probes(async elements => {
        const e=fixture(),first=e._loadMediaDimensions(true),old=elements.at(-1);
        const second=e._loadMediaDimensions(true),current=elements.at(-1);
        assert.equal(await first,false);
        Object.assign(old,{naturalWidth:20,naturalHeight:100});old.emit('load');
        e.data.width=250;
        Object.assign(current,{naturalWidth:600,naturalHeight:900});current.emit('load');await second;
        assert.equal(e.data.width,250);assert.equal(e.data.height,180);
        const failed=e._loadMediaDimensions(true);elements.at(-1).emit('error');assert.equal(await failed,false);
        const cancelled=e._loadMediaDimensions(true);e._cancelMediaDimensions();assert.equal(await cancelled,false);
        assert.equal(e.data.width,250);
    });
});

test('portrait video metadata works without a local workspace preview', async () => {
    await probes(async elements => {
        const e=fixture();e.data.movie='portrait.webm';e.movies=[{relativePath:e.data.movie,absolutePath:'/portrait.webm'}];
        const ready=e._loadMediaDimensions(true),p=elements.at(-1);
        Object.assign(p,{videoWidth:720,videoHeight:1280});p.emit('loadedmetadata');await ready;
        assert.equal(e.video,null);assert.equal(e.data.width/e.data.height,720/1280);
    });
});

test('size controls preserve proportions and limits, while unlocked and sparse transforms stay independent', () => {
    const e=fixture();e.mediaDimensions={width:600,height:1200};e._fitMediaProportions();
    e.data.width=320;e._resizeDimension('width',160);assert.equal(e.data.height,640);
    e.data.height=20000;e._resizeDimension('height',640);assert.equal(e.data.height,8192);assert.equal(e.data.width,4096);
    e.keepProportions=false;e.data.width=100;e._resizeDimension('width',4096);assert.equal(e.data.height,8192);
    e.keepProportions=true;e.operation='TransformVideoSurface';
    e.data=Editor.parse({code:357,parameters:['RPGReactor','TransformVideoSurface','',{id:1,width:100}]});
    e.changedFields=new Set(['width']);e.data.width=200;e._resizeDimension('width',100);
    assert.equal(e.changedFields.has('height'),false);assert.equal(e.changedFields.has('corners'),false);
});
