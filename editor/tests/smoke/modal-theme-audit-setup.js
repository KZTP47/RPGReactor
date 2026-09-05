// Freeze transitions so snapshots measure settled palettes, not intermediate colors.
const auditStyle=document.createElement('style');auditStyle.textContent='*,*::before,*::after { transition:none !important; animation:none !important; }';document.head.append(auditStyle);
// Computed-style sampling complements source checks; asset pixels are excluded.
window.__auditTheme = function () {
 const visible=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
 const rgb=text=>{const n=text.match(/[\d.]+/g)?.map(Number)||[];return [n[0]||0,n[1]||0,n[2]||0,n[3]??1];};
 const blend=(front,back)=>[0,1,2].map(i=>front[i]*front[3]+back[i]*(1-front[3])).concat(1);
 const background=e=>{const chain=[];for(let p=e;p;p=p.parentElement)chain.push(p);let color=[255,255,255,1];for(const p of chain.reverse())color=blend(rgb(getComputedStyle(p).backgroundColor),color);return color;};
 const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const low=[],missing=[];let sampled=0;
 for(const e of document.querySelectorAll('[class*="modal"] input,[class*="modal"] textarea,[class*="modal"] select,[class*="modal"] button,[class*="modal"] label,[class*="modal"] p,[class*="modal"] span,.rr-database-action-menu button,.rr-database-action-menu span')){
  if(!visible(e)||e.disabled||e.closest('button:disabled')||e.matches('input[type="checkbox"],input[type="radio"],input[type="range"],input[type="color"]'))continue;
  const text=(e.value||e.textContent||e.placeholder||'').trim();if(!text)continue;
  const style=getComputedStyle(e);if(Number(style.opacity)<1)continue;
  const bg=background(e),fg=blend(rgb(style.color),bg),a=lum(bg),b=lum(fg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);sampled++;
  if(ratio<3)low.push({tag:e.tagName,id:e.id,className:e.className,text:text.slice(0,70),color:style.color,background:bg.slice(0,3),ratio:Math.round(ratio*100)/100});
 }
 // Probe semantic text tokens on the input surface used by nested dialogs.
 const probe=document.createElement('div');probe.style.background='var(--color-bg-input)';document.body.append(probe);
 const tokens={};for(const token of ['--color-text','--color-text-muted','--color-danger-bright','--color-warning-text']){
  probe.style.color=`var(${token})`;const fg=rgb(getComputedStyle(probe).color),bg=background(probe),a=lum(bg),b=lum(fg);tokens[token]=Math.round(((Math.max(a,b)+.05)/(Math.min(a,b)+.05))*100)/100;
  if(!getComputedStyle(document.documentElement).getPropertyValue(token).trim())missing.push(token);
 }probe.remove();
 return {sampled,low,tokens,missing};
};
