import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const read=name=>fs.readFileSync(new URL('../js/'+name,import.meta.url),'utf8');
const normalizer=require('../js/data-normalizer.js');
const modules=['api.js','data-normalizer.js','energy-flow.js','dashboard.js','history.js'];
const cyrillic=/[А-Яа-яІіЇїЄєҐґ]/;

function createLocale(lang='en') {
  const win={
    navigator:{language:lang==='en'?'en-US':'uk-UA'},
    location:{search:''},
    localStorage:{getItem:()=>lang,setItem(){}}
  };
  const ctx={window:win,URLSearchParams};
  vm.createContext(ctx);
  for(const f of ['i18n.js','i18n-uk.js','i18n-en.js']){
    vm.runInContext(read(f),ctx);
    if(f==='i18n.js')ctx.WattPostI18n=win.WattPostI18n;
  }
  return {ctx,win,i18n:win.WattPostI18n};
}

test('core runtime state modules carry no Ukrainian UI literals or source-translation bridge',()=>{
  const {i18n}=createLocale('en');
  const main=read('i18n.js');
  assert.doesNotMatch(main,/sourceToKey|registerPatterns|MutationObserver|translateText|NodeFilter/);
  assert.doesNotMatch(read('i18n-en.js'),/registerPatterns/);
  for(const file of modules){
    const source=read(file);
    for(const line of source.split('\n')){
      if(line.trimStart().startsWith('//')||line.trimStart().startsWith('*'))continue;
      assert.doesNotMatch(line,cyrillic,file+' contains language-dependent code');
    }
    for(const [,key] of source.matchAll(/(?:tr|\.t)\(['"]([a-z][a-z0-9_.]*)['"]/g)){
      if (key === 'history.records_') continue; // plural suffix is computed.
      assert.notEqual(i18n.t(key),key,file+' missing key '+key);
    }
  }
});

test('DataNormalizer keeps locale-independent sensor identities and status keys',()=>{
  const sensors=[
    {id:'t1',supported:true,present:true,enabled:true,value_valid:true,alias_of:null,val_c:28},
    {id:'ext256',supported:true,present:true,enabled:true,value_valid:true,alias_of:null,val_c:30},
    {id:'custom1',name:'Налаштування',supported:true,present:true,enabled:true,value_valid:true,alias_of:null,val_c:22}
  ];
  const output=normalizer.filterValidSensors(sensors);
  assert.deepEqual(output.map(x=>x.name),['T1','T3','Налаштування']);
  assert.deepEqual(output.map(x=>x.nameKey),['sensor.t1','sensor.t3',null]);
  const empty=normalizer.normalizeLive(null);
  assert.equal(empty.messageKey,'text.no_data');
  const offline=normalizer.normalizeLive({online:false});
  assert.equal(offline.messageKey,'text.no_bms_connection');
  assert.equal(offline.message,null);
  const unknown=normalizer.normalizeLive({online:false,message:'Налаштування'});
  assert.equal(unknown.message,'Налаштування');
  assert.equal(unknown.messageKey,'text.no_bms_connection');
});

test('Dashboard resolves sensor labels in UA and EN and escapes untrusted names',()=>{
  for(const lang of ['uk','en']){
    const {ctx,win,i18n}=createLocale(lang);
    const cards=[];
    const grid={innerHTML:'',querySelectorAll:()=>[],appendChild:card=>cards.push(card)};
    ctx.document={
      getElementById:id=>id==='sensor-grid'?grid:null,
      createElement:()=>({dataset:{},innerHTML:''})
    };
    win.BatteryColors={getSocColors:()=>({}),getCellRelativeColors:()=>({})};
    win.EnergyFlow=class{};
    win.STATE_COLORS={idle:{primary:'#777',bg:'',glow:''}};
    win.WattCharts={updateChartPreservingZoom(){},hideTooltip(){}};
    vm.runInContext(read('dashboard.js'),ctx);
    assert.equal(typeof win.Dashboard,'function');
    const view=new win.Dashboard();
    view._renderLiveSensors([
      {id:'t1',name:'T1',nameKey:'sensor.t1',color:'#58A6FF',val_c:22},
      {id:'custom',name:'<img onerror=alert(1)> Налаштування',nameKey:null,color:'#58A6FF',val_c:21}
    ]);
    assert.equal(cards.length,2);
    assert.match(cards[0].innerHTML,new RegExp(i18n.t('sensor.t1')));
    assert.match(cards[1].innerHTML,/&lt;img onerror=alert\(1\)&gt; Налаштування/);
    assert.doesNotMatch(cards[1].innerHTML,/<img onerror/);
  }
});

test('History uses language-neutral names for recovered sensors and does not translate custom names',()=>{
  for(const lang of ['uk','en']){
    const {ctx,win,i18n}=createLocale(lang);
    win.WattCharts={};
    win.DataNormalizer=normalizer;
    win.ApiClient={liveData:{temperatures:{sensors:[
      {id:'t2',name:'T2',nameKey:'sensor.t2',color:'#56D4C8'},
      {id:'custom',name:'Налаштування',nameKey:null,color:'#58A6FF'}
    ]}}};
    vm.runInContext(read('history.js'),ctx);
    const view=new win.HistoryView();
    const metrics=view._getActiveMetrics();
    assert.equal(metrics.find(x=>x.key==='sensor_t2').label,i18n.t('sensor.t2'));
    assert.equal(metrics.find(x=>x.key==='sensor_custom').label,'Налаштування');
    win.ApiClient.liveData.temperatures.sensors=[];
    view.rawHistory=[{temps:{t2:25.3}}];
    assert.equal(view._getActiveMetrics().find(x=>x.key==='sensor_t2').label,i18n.t('sensor.t2'));
  }
});

test('explicit DOM attributes translate while unbound user text never changes',()=>{
  const {ctx,i18n}=createLocale('en');
  const attrs=new Map([['data-i18n-aria-label','nav.settings']]);
  const label={nodeType:1,textContent:'Налаштування',
    closest:()=>null,getAttribute:key=>attrs.get(key)||null,
    setAttribute:(key,value)=>attrs.set(key,value),
    querySelectorAll:()=>[]
  };
  const unknown={nodeType:1,textContent:'Налаштування',closest:()=>null,
    getAttribute:()=>null,setAttribute:()=>{},querySelectorAll:()=>[]};
  ctx.window.document={};
  i18n.apply(label);
  i18n.apply(unknown);
  assert.equal(attrs.get('aria-label'),'Settings');
  assert.equal(unknown.textContent,'Налаштування');
});
