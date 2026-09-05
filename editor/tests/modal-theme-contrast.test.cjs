const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const css = fs.readFileSync(path.join(__dirname,'../css/theme.css'),'utf8');
function tokens(theme) {
    const values = {};
    for(const [,selectors,body] of css.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
        if(!selectors.split(',').some(s=>s.trim()===':root'||s.trim()===`:root[data-theme="${theme}"]`))continue;
        for(const [,name,value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))values[name]=value.trim();
    }
    return values;
}
function luminance(hex) {
    assert.match(hex,/^#[0-9a-f]{6}$/i);
    return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255)
        .map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4)
        .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
}
function contrast(a,b) {a=luminance(a);b=luminance(b);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);}
for(const palette of ['gold','bubblegum','ocean','cascadia','underworld','creamsicle','royalty'])for(const mode of ['dark','light']) {
    const theme=palette==='gold'?mode:`${palette}-${mode}`;
    test(`${theme}: modal body, warning and error text remain readable on nested input surfaces`,()=>{
        const colors=tokens(theme);
        for(const token of ['--color-text','--color-warning-text','--color-danger-bright']) {
            const ratio=contrast(colors[token],colors['--color-bg-input']);
            assert.ok(ratio>=4.5,`${token} on --color-bg-input: ${ratio.toFixed(2)}:1`);
        }
    });
}

test('editor theme references resolve instead of silently using unrelated fallback colors', () => {
    const sources=[];
    function visit(dir) {for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        if(entry.name==='vendor'||entry.name==='node_modules')continue;
        const file=path.join(dir,entry.name);
        if(entry.isDirectory())visit(file);else if(/\.(js|css)$/.test(file))sources.push({file,text:fs.readFileSync(file,'utf8')});
    }}
    visit(path.join(__dirname,'../src'));visit(path.join(__dirname,'../css'));
    const defined=new Set(sources.flatMap(({text})=>[...text.matchAll(/(--color-[\w-]+)\s*:/g)].map(m=>m[1])));
    // An optional custom background for pixel/asset previews, with a fixed fallback.
    defined.add('--color-checker');
    const missing=[];
    for(const {file,text} of sources)for(const [,name] of text.matchAll(/var\((--color-[\w-]+)/g))if(!defined.has(name))missing.push(`${path.relative(__dirname,file)}: ${name}`);
    assert.deepEqual(missing,[]);
});
