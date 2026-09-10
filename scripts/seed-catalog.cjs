// Bootstrap the hub from existing public releases. Does not publish binaries.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {PRODUCTS,renderReadme,META}=require('./desktop-release.cjs');
const yaml=require('js-yaml');
async function main(){
  if(fs.existsSync('catalog.json')) throw new Error('Catalog already exists; refusing to replace published feeds');
  const catalog={};
  for(const [product,info] of Object.entries(PRODUCTS)) {
    catalog[product]={};
    for(const [platform,legacy] of Object.entries(info.legacy)) {
      const release=JSON.parse(execFileSync('gh',['api',`repos/Sonoran-Software/${legacy}/releases/latest`],{encoding:'utf8'}));
      const installer=release.assets.find(x=>platform==='windows'?x.name.endsWith('.exe'):/universal.*\.dmg$/.test(x.name)) || release.assets.find(x=>x.name.endsWith('.dmg'));
      if(!installer) throw new Error(`Missing installer: ${product}/${platform}`);
      catalog[product][platform]={version:release.tag_name.replace(/^v/,''),url:installer.browser_download_url,central:false};
      const meta=release.assets.find(x=>x.name===META[platform]);
      if(!meta) throw new Error('Missing existing metadata');
      const response=await fetch(meta.browser_download_url);
      if(!response.ok) throw new Error(`Metadata fetch ${response.status}`);
      const data=yaml.load(await response.text());
      const lookup=name=>{
        const asset=release.assets.find(x=>x.name===decodeURIComponent(name));
        if(!asset) throw new Error(`Missing existing asset ${name}`);
        return asset.browser_download_url;
      };
      for(const item of data.files) item.url=lookup(item.url);
      if(data.path) data.path=lookup(data.path);
      const dir=`docs/updates/${product}/${platform}`;
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,META[platform]),yaml.dump(data,{lineWidth:-1}));
    }
  }
  fs.writeFileSync('catalog.json',JSON.stringify(catalog,null,2)+'\n');
  fs.writeFileSync('README.md',renderReadme(catalog));
  console.log('Seeded download catalog and eight Windows/macOS feeds from current public releases.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
