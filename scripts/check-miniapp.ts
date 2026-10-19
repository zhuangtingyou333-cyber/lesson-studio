import { readFile, access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=path.resolve('dist/miniapp');
const config=JSON.parse(await readFile(path.join(root,'app.json'),'utf8'));
const pages=config.pages as string[];
for(const page of pages){
  for(const extension of ['.js','.wxml'])await access(path.join(root,page+extension));
  const template=await readFile(path.join(root,page+'.wxml'),'utf8');
  if(/wx:if="(?!\{\{)/.test(template))throw new Error(page+': wx:if 必须绑定表达式');
}
const compilerRoot=path.join(homedir(),'Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec');
const wcc=process.env.WCC_PATH??path.join(compilerRoot,'wcc'),wcsc=process.env.WCSC_PATH??path.join(compilerRoot,'wcsc');
await access(wcc);await access(wcsc);
const temp=await mkdtemp(path.join(tmpdir(),'lesson-compile-'));
try{
  for(const [file,args] of [[wcc,['-o',path.join(temp,'wxml.js'),...pages.map(p=>p+'.wxml')]],[wcsc,['-o',path.join(temp,'wxss.js'),'app.wxss']]] as [string,string[]][]){
    const result=spawnSync(file,args,{cwd:root,encoding:'utf8'});
    if(result.error||result.status!==0)throw new Error(result.error?.message??result.stderr??result.stdout);
  }
  await mkdir('artifacts',{recursive:true});
  console.log(`微信原生编译器通过：${pages.length}个页面WXML、全局WXSS；产物入口完整。`);
}finally{await rm(temp,{recursive:true,force:true});}
