// Native checks for the September 6 PR integration, using in-memory fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { WebDriverClient } = require('./webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pr-integration-'));
const driver = new WebDriverClient(path.join(process.env.NWJS_SDK_ROOT || path.join(root, 'nwjs-linux'), 'chromedriver'));
(async () => {
    try {
        await driver.start();
        await driver.createSession({ browserName: 'chrome', 'goog:chromeOptions': { args: [
            `nwapp=${path.join(root, 'editor')}`, `user-data-dir=${path.join(temp, 'profile')}`, 'no-first-run'
        ] } });
        await driver.waitForScript('return !!window.reactor?.databaseEditorUI;', [], { timeout: 90000 });
        await driver.waitForScript("return getComputedStyle(document.getElementById('splash-screen')).display === 'none';", [], { timeout: 15000 });
        await driver.execute(`
            nw.Window.get().resizeTo(1280,720);
            window.__prErrors=[];addEventListener('error',e=>__prErrors.push(String(e.error||e.message)));
            window.__prDB={getStates:()=>[null,{id:1,name:'Poison',note:'',iconIndex:0},{id:2,name:'Guard',note:'',iconIndex:0}],
                getSystem:()=>({elements:['','Physical','Fire']}),getClasses:()=>[],getSkills:()=>[]};
            window.__prHost=document.createElement('div');
            __prHost.style.cssText='position:fixed;inset:40px;z-index:10000;padding:20px;background:var(--color-bg-base);overflow:auto;';
            document.body.appendChild(__prHost);
            window.__prRecord={id:999,name:'Fixture',note:'Keep this note.',traits:[]};
            window.__prChanges=[];
            window.__prSection=RRPassiveStates.createSection({objectType:'actor',record:__prRecord,databaseManager:__prDB,
                manifest:[{name:'VisuMZ_1_SkillsStatesCore',status:true,parameters:{}}],onNoteChange:note=>__prChanges.push(note)});
            __prHost.appendChild(__prSection);
            __prSection.querySelector('.passive-btn-add').click();
        `);
        assert.equal(await driver.execute(`
            const m=document.querySelector('.passive-state-dialog'),r=m.getBoundingClientRect();
            return r.top>=0&&r.bottom<=innerHeight&&getComputedStyle(m).backgroundColor!=='rgba(0, 0, 0, 0)';
        `), true);
        const passive = await driver.execute(`
            document.querySelector('.passive-dialog-row[data-state-id="1"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
            const added=__prRecord.note;
            __prSection.querySelector('tbody tr[data-entry-index]').click();
            __prSection.querySelector('.passive-btn-delete').click();
            return {added,removed:__prRecord.note,changes:__prChanges.length};
        `);
        assert.match(passive.added, /Keep this note\.[\s\S]*<Passive State: 1>/);
        assert.equal(passive.removed.trim(), 'Keep this note.'); assert.equal(passive.changes, 2);
        await driver.execute(`
            __prHost.replaceChildren();
            window.__prArray=RRPluginParamWidgets.create({schema:{type:'state[]'},value:['1','2'],context:{database:{data:{states:__prDB.getStates()}}},
                onChange:value=>window.__prArrayValue=value});
            __prHost.appendChild(__prArray);__prArray.style.width='280px';
        `);
        const layout = await driver.execute(`
            const row=__prArray.querySelector('.rr-plugin-choice-array-row'), cell=row.querySelector('.rr-plugin-choice-array-cell'), actions=row.querySelector('.rr-plugin-choice-array-actions');
            const c=cell.getBoundingClientRect(),a=actions.getBoundingClientRect(),r=row.getBoundingClientRect();
            const buttons=[...row.querySelectorAll('button')];
            const clickable=buttons.filter(b=>!b.disabled).every(b=>{const q=b.getBoundingClientRect();return b.contains(document.elementFromPoint(q.x+q.width/2,q.y+q.height/2));});
            actions.querySelectorAll('button')[1].click();
            return {separate:a.top>=c.bottom-1||a.left>=c.right-1,fits:row.scrollWidth<=r.width+1,clickable,value:__prArrayValue};
        `);
        assert.deepEqual(layout,{separate:true,fits:true,clickable:true,value:['2','1']});
        await driver.execute(`
            __prHost.replaceChildren();
            const field=document.createElement('input');field.value='Hello';
            __prHost.appendChild(RRPluginParamWidgets.attachTextCodes(field,{}));
            field.value=String.fromCharCode(92)+'C[2]Hello';field.dispatchEvent(new Event('input'));
            window.__prTrait=new DatabaseTraitEditor(__prDB,{});__prTrait.showTraitEditorModal(__prRecord);
        `);
        assert.equal(await driver.execute("return document.querySelector('.rr-plugin-text-codes-preview').hidden;"), false);
        const point=await driver.execute(`const r=document.querySelector('.trait-editor-modal [data-rr-help]').getBoundingClientRect();return {x:Math.round(r.x+40),y:Math.round(r.y+r.height/2)};`);
        await driver.sessionRequest('POST','/actions',{actions:[{type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',duration:100,origin:'viewport',...point}]}]});
        await driver.waitForScript("return !!document.querySelector('.rr-hover-help:not([hidden])');");
        assert.match(await driver.execute("return document.querySelector('.rr-hover-help').textContent;"), /Multiplies.*element/);
        await driver.sessionRequest('POST','/actions',{actions:[{type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',duration:100,origin:'viewport',x:10,y:10}]}]});
        assert.equal(await driver.execute("return document.querySelector('.rr-hover-help').hidden;"),true);
        assert.deepEqual(await driver.execute('return __prErrors;'),[]);
        console.log('PR integration passed: passive-state add/delete, narrow array controls, text-code preview and real-pointer trait help.');
    } finally {
        await driver.close(); fs.rmSync(temp,{recursive:true,force:true});
    }
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
