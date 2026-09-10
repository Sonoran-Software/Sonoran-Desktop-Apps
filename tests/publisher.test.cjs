const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {GitHub,HUB,META,compareVersions,assetName,validateMetadata,centralMetadata,checkVersion,prepareStudio,commitFeed,mirrorLegacy,publish} = require('../scripts/desktop-release.cjs');
const sha = (v,a='sha256',e='hex') => crypto.createHash(a).update(v).digest(e);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'desktop-publisher-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('signed installer fixture');
  fs.writeFileSync(path.join(dir,'App.exe'),bytes);
  const metadata={version:'1.2.3',files:[{url:'App.exe',sha512:sha(bytes,'sha512','base64'),size:bytes.length}],path:'App.exe',sha512:sha(bytes,'sha512','base64')};
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({version:'1.2.3'}));
  fs.writeFileSync(path.join(dir,'latest.yml'),JSON.stringify(metadata));
  return {dir,bytes,metadata};
}
test('metadata validation detects modified signed installers, version and traversal',t=>{
  const {dir,metadata}=fixture(t);
  validateMetadata(metadata,dir,'1.2.3');
  assert.throws(()=>validateMetadata(metadata,dir,'1.2.4'),/version/);
  for(const name of ['../App.exe','..%2FApp.exe','a\\b','a\nb']) assert.throws(()=>assetName(name));
  fs.appendFileSync(path.join(dir,'App.exe'),'tamper');
  assert.throws(()=>validateMetadata(metadata,dir,'1.2.3'),/SHA-512/);
});
test('central manifests isolate product releases without changing hashes',t=>{
  const {metadata}=fixture(t);
  const converted=centralMetadata(metadata,'cms','1.2.3');
  assert.equal(converted.files[0].url,`https://github.com/${HUB}/releases/download/cms-v1.2.3/App.exe`);
  assert.equal(converted.files[0].sha512,metadata.files[0].sha512);
  assert.equal(metadata.path,'App.exe');
  assert.equal(compareVersions('1.2.10','1.2.9'),1);
});
test('Linux recovery accepts only its own immutable release URLs',t=>{
  const {metadata}=fixture(t);
  const {localLinuxMetadata}=require('../scripts/desktop-release.cjs');
  const final=centralMetadata(metadata,'cms','1.2.3');
  assert.deepEqual(localLinuxMetadata(final,'cms','1.2.3'),metadata);
  assert.throws(()=>localLinuxMetadata(final,'cad','1.2.3'));
  assert.throws(()=>localLinuxMetadata(final,'cms','1.2.4'));
});
test('staging verifies artifacts without network writes',async t=>{
  const {dir}=fixture(t);
  fs.mkdirSync(path.join(dir,'win-unpacked/resources'),{recursive:true});
  fs.writeFileSync(path.join(dir,'win-unpacked/resources/app-update.yml'),JSON.stringify({provider:'generic',url:'https://sonoran-software.github.io/Sonoran-Desktop-Apps/updates/cms/windows/',useMultipleRangeRequest:false}));
  await publish(null,'cms','windows',dir,path.join(dir,'package.json'),true);
  fs.writeFileSync(path.join(dir,'win-unpacked/resources/app-update.yml'),JSON.stringify({provider:'github',repo:'old'}));
  await assert.rejects(publish(null,'cms','windows',dir,path.join(dir,'package.json'),true),/destination is incorrect/);
});
test('migration requires a higher version and permits same-version bridge recovery',async()=>{
  let latest={tag_name:'v1.2.3',body:''};
  const gh={optional:async()=>latest};
  await assert.rejects(checkVersion(gh,'cms','windows','1.2.3'),/newer/);
  await checkVersion(gh,'cms','windows','1.2.4');
  latest.body='Desktop update bridge for Sonoran CMS.';
  await checkVersion(gh,'cms','windows','1.2.3');
  await assert.rejects(checkVersion(gh,'cms','windows','1.2.2'),/newer/);
});
test('Studio shares one source version above legacy high-water mark',async t=>{
  const {dir}=fixture(t),pkg=path.join(dir,'package.json');
  fs.writeFileSync(pkg,JSON.stringify({version:'0.1.0'}));
  fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify({version:'0.1.0',packages:{'':{version:'0.1.0'}}}));
  const central=[];
  const gh={releases:async repo=>repo===HUB?central:[{tag_name:'v0.1.104'}],release:async(repo,tag,name,body)=>{const value={tag_name:tag,body};central.push(value);return value;}};
  assert.equal(await prepareStudio(gh,pkg,'a'.repeat(40)),'0.1.105');
  assert.equal(await prepareStudio(gh,pkg,'a'.repeat(40)),'0.1.105');
  assert.equal(await prepareStudio(gh,pkg,'b'.repeat(40)),'0.1.106');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'package-lock.json'))).packages[''].version,'0.1.106');
});
test('asset upload checks server digests and never replaces different bytes',async()=>{
  const bytes=Buffer.from('artifact');
  const gh=new GitHub('test-only',async()=>({ok:true,json:async()=>({size:bytes.length,digest:`sha256:${sha(bytes)}`})}));
  gh.api=async()=>[];
  await gh.upload(HUB,{id:1},'app.exe',bytes);
  gh.api=async()=>[{name:'app.exe',digest:'sha256:different'}];
  await assert.rejects(gh.upload(HUB,{id:1},'app.exe',bytes),/Refusing/);
});
test('feed retry preserves concurrent product changes and refuses downgrade',async()=>{
  let catalog={radio:{linux:{version:'2.0.0',url:'radio',central:true,metadataSha256:sha('radio')}}},attempts=0,changes;
  const gh={api:async(route,method,body)=>{
    if(route.includes('/git/ref/')) return {object:{sha:'head'}};
    if(route.endsWith('/git/commits/head')) return {tree:{sha:'tree'}};
    if(route.includes('/contents/catalog.json')) return {content:Buffer.from(JSON.stringify(catalog)).toString('base64')};
    if(route.endsWith('/git/trees')) {changes=body.tree;return {sha:'tree2'};}
    if(route.endsWith('/git/commits')) return {sha:'next'};
    if(method==='PATCH') {
      if(attempts++===0) {catalog.studio={windows:{version:'0.1.105',url:'studio'}};throw Object.assign(new Error('conflict'),{status:422});}
      catalog=JSON.parse(changes.find(x=>x.path==='catalog.json').content);return {};
    }
    throw new Error(route);
  }};
  await commitFeed(gh,'cad','linux','3.0.0',{'latest-linux.yml':'cad'},'cad');
  assert.equal(catalog.studio.windows.url,'studio');
  assert.equal(catalog.radio.linux.url,'radio');
  await assert.rejects(commitFeed(gh,'cad','linux','2.0.0',{'latest-linux.yml':'older'},'older'),/downgrade/);
  await assert.rejects(commitFeed(gh,'cad','linux','3.0.0',{'latest-linux.yml':'different'},'different'),/same-version/);
});
test('Studio legacy bridge stays draft until both platform manifests exist',async t=>{
  const {dir}=fixture(t); let release,assets=[],published=0;
  const gh={locked:async(name,task)=>task(),optional:async()=>({tag_name:'v0.1.104'}),releases:async()=>release?[release]:[],upload:async(repo,r,name)=>{assets.push({name});},api:async(route,method,body)=>{
    if(method==='POST') return release={id:1,tag_name:'v0.1.105',draft:body.draft};
    if(method==='PATCH') {published++;return {};}
    if(route.includes('/assets?')) return assets;
    return {default_branch:'master'};
  }};
  await mirrorLegacy(gh,'studio','windows','0.1.105',['App.exe'],dir,'windows');
  assert.equal(release.draft,true);assert.equal(published,0);
  await mirrorLegacy(gh,'studio','macos','0.1.105',[],dir,'mac');
  assert.equal(published,1);
});
test('legacy lock is released when publishing fails',async()=>{
  const calls=[];const gh=new GitHub('test-only');
  gh.api=async(route,method)=>{calls.push(method);return {object:{sha:'head'}};};
  await assert.rejects(gh.locked('test',async()=>{throw new Error('upload failed');}),/upload failed/);
  assert.deepEqual(calls,[undefined,'POST','DELETE']);
});
