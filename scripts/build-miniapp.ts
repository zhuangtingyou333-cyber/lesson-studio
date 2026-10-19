import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { transform } from 'esbuild';
const source=path.resolve('apps/miniapp'),destination=path.resolve('dist/miniapp');
const files=new Map<string,string>();
// Compile before publishing. Never remove an open project directory: the IDE can
// otherwise observe an empty app.js during hot reload and cache a broken bundle.
async function collect(dir:string){
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const input=path.join(dir,entry.name),relative=path.relative(source,input);
    if(entry.isDirectory()){await collect(input);continue;}
    if(entry.name==='tsconfig.json'||entry.name.endsWith('.d.ts')||entry.name==='project.private.config.json')continue;
    if(entry.name.endsWith('.ts')){
      const result=await transform(await readFile(input,'utf8'),{loader:'ts',format:'cjs',target:'es2017',charset:'utf8'});
      files.set(relative.slice(0,-3)+'.js',result.code);
    }else if(/\.(json|wxml|wxss)$/.test(entry.name))files.set(relative,await readFile(input,'utf8'));
  }
}
await collect(source);
const previousConfig=await readFile(path.join(destination,'project.config.json'),'utf8').catch(()=>null);
if(previousConfig){
  const previous=JSON.parse(previousConfig),current=JSON.parse(files.get('project.config.json')!);
  if(previous.appid&&previous.appid!=='touristappid')current.appid=previous.appid;
  files.set('project.config.json',JSON.stringify(current,null,2));
}
// Publish changed files atomically; unchanged files and private IDE settings are untouched.
let changed=0;
for(const relative of [...files.keys()].sort((a,b)=>Number(a==='app.json')-Number(b==='app.json'))){
  const output=path.join(destination,relative),content=files.get(relative)!;
  if(await readFile(output,'utf8').catch(()=>null)===content)continue;
  await mkdir(path.dirname(output),{recursive:true});
  const temporary=output+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,content);await rename(temporary,output);changed++;}
  finally{await rm(temporary,{force:true});}
}
console.log(`微信开发者工具导入目录：${destination}（更新${changed}个文件，保留运行目录和私有设置）`);
