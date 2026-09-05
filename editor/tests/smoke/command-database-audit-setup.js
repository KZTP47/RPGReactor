const done=arguments[arguments.length-1], options=arguments[0] || {};
if(options.theme) document.documentElement.setAttribute('data-theme',options.theme);
(async()=>{
 const pc=reactor.projectController,wait=ms=>new Promise(r=>setTimeout(r,ms));
 if(!reactor.databaseManager.data.quests?.some(q=>q?.id>0))reactor.databaseManager.data.quests=[null,DatabaseQuestEditor.normalize({id:1,name:'Audit quest',objectives:[{text:'Audit objective'}],rewards:[{text:'Audit reward'}]})];
 const host={databaseManager:reactor.databaseManager,projectController:pc,mapEditor:reactor.mapEditor,currentEvent:{id:1,x:1,y:1,pages:[]}};
 const list=new EventCommandList(host);list.refreshCommandList=()=>{};
 const catalog=Object.values(list.commandPicker.commandData).flatMap(t=>t.columns.flatMap(c=>c.sections.flatMap(s=>s.commands)));
 const commands=catalog;
 const results=[],alerts=[];window.alert=message=>alerts.push(String(message));
 let opened;
 for(const [key,editor] of Object.entries(list))if(editor && typeof editor.show==='function' && key!=='commandPicker'){
  const show=editor.show;editor.show=function(...args){opened={key,editor};return show.apply(this,args);};
 }
 list.commandPicker.show=callback=>{list._choose=callback;};
 for(const item of commands){
  const page={list:[{code:0,indent:0,parameters:[]}]};list.selectedIndices=[];opened=null;
  const startErrors=__previewErrors.length,startAlerts=alerts.length;
  const result={...item};
  try{
   list.newCommand(page,0);list._choose(item);await wait(35);
   result.editor=opened?.key||null;result.inserted=page.list.length>1;
   const editor=opened?.editor;
   if(editor){
    if(window.__auditTheme) result.theme=window.__auditTheme();
    result.controls=[...document.querySelectorAll('input,select,textarea')].filter(e=>e.getClientRects().length).length;
    let built;
    if(!options.themeOnly){
    if(item.reactor==='ShowVideoSurface')editor.data.movie='img/system/IconSet.png';
    if(editor.buildCommand)built=editor.buildCommand();
    else if(editor.buildCommands)built=editor.buildCommands();
    if (!built) {
     const buttons=[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length && !b.disabled);
     const ok=buttons.filter(b=>/^(OK|Insert)$/.test(b.textContent.trim())).at(-1);
     if(ok){ok.click();await wait(20);result.savedThroughButton=page.list.length>1;built=page.list.length>1?page.list.slice(0,-1):null;}
     else result.disabledOrNoOK=true;
    }
    result.built=built||null;
    if(built){
     const block=Array.isArray(built)?built:[built];
     result.summary=block.map(c=>list.getCommandInfo(c).name);
     page.list=[...block,{code:0,indent:0,parameters:[]}];
     editor.close?.();list.editCommand(0,page,0);await wait(20);
     const reopened=opened?.editor;
     let rebuilt=reopened?.buildCommand?.()||reopened?.buildCommands?.();
     if(!rebuilt && result.savedThroughButton){
      const ok=[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.disabled&&/^(OK|Insert)$/.test(b.textContent.trim())).at(-1);
      if(ok){ok.click();await wait(20);rebuilt=page.list.slice(0,-1);}
     }
     result.roundTrip=JSON.stringify(built)===JSON.stringify(rebuilt);
     if(!result.roundTrip)result.rebuilt=rebuilt;
    }
    }
    editor.close?.();opened?.editor.close?.();
   }
  }catch(e){result.error=String(e.stack);}
  // Audio pickers use an unclassified backdrop; close through their real
  // button to release listeners instead of leaving a hidden helper behind.
  for(const picker of document.querySelectorAll('.rr-audio-picker-modal'))picker.querySelector('button[aria-label]')?.click();
  result.alerts=alerts.slice(startAlerts);result.errors=__previewErrors.slice(startErrors);results.push(result);
  for(const modal of document.querySelectorAll('[class*="modal"]'))if(modal.parentElement===document.body)modal.style.display='none';
 }
 if(options.themeOnly) return {commands:results};
 const db=reactor.databaseEditorUI;db.setCurrentProject(pc.currentProject);const sections=['actors','classes','skills','items','weapons','armors','enemies','troops','states','animations','tilesets','commonEvents','userInterfaces','quests','system1','system2','types','terms','reactor3d'];
 const database=[];
 for(const type of sections){
  const start=__previewErrors.length;const row={type};
  try{db.openDatabase(type);await wait(100);const entry=reactor.databaseManager.data[type]?.find?.(e=>e&&e.id>0);if(entry)db.showDatabaseDetail(entry,type);if(type==='quests'&&!entry)db.showDatabaseDetail(DatabaseQuestEditor.normalize({id:1,name:'Audit quest'}),type);await wait(80);row.controls=[...document.querySelectorAll('#database-detail input,#database-detail select,#database-detail textarea')].length;row.text=document.querySelector('#database-detail')?.textContent?.trim().slice(0,80);}
  catch(e){row.error=String(e.stack);}row.errors=__previewErrors.slice(start);database.push(row);
 }
 window.__auditDatabase=db;
 return {commands:results,database};
})().then(done,e=>done({error:String(e.stack)}));
