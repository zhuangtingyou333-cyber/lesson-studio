import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import {openDatabase,type Database} from '../db.ts';
import {StudioService} from '../service.ts';
import {seedDemo} from '../seed.ts';
import {createApp} from '../server.ts';
import {parseDelimited,parseFile,csv,MAX_ROWS} from '../imports/parse.ts';
import {importHeaders} from '../imports/service.ts';
import type {Actor,ImportConfig,ImportBatch} from '../../../packages/contracts/index.ts';
import type {Command} from '../schemas.ts';
let db:Database,s:StudioService;
const owner:Actor={tenantId:'studio-demo',userId:'owner-demo',role:'owner',name:'林老师'};
const teacher={...owner,userId:'teacher-demo',role:'teacher'} as Actor;
beforeEach(async()=>{db=await openDatabase();await seedDemo(db);s=new StudioService(db);});
afterEach(async()=>{await db.close();});
const cmd=(op:Command,input:unknown,actor=owner,key=randomUUID())=>s.command(actor,op,input,key);
const reject=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(e:any)=>e.code===code);
const cfg=(changes:Partial<ImportConfig>={}):ImportConfig=>({sheet:'表格',source:'合成原系统',kind:'opening',mapping:{studentKey:0,name:1,phone:2,note:3,grantKey:4,course:5,package:6,purchased:7,gift:8,expires:9,unit:10},targets:{},...changes});
const row=(n=1,over:Record<number,string|number>={})=>{const r:any[]=['S'+n,'迁入学员'+n,'','中文备注','G'+n,'创意素描','原课包','8.125','1.25','2030-12-31','次'];for(const [i,v] of Object.entries(over))r[Number(i)]=v;return r;};
const create=(rows:unknown[][])=>cmd('import_create',{fileName:'名单.csv',text:csv([importHeaders,...rows])});
const detail=(id:string,page=1)=>s.imports(owner,'detail',id,page) as Promise<ImportBatch>;
async function validate(id:string,config=cfg()){const b=await detail(id);await cmd('import_validate',{id,expectedVersion:b.version,config});return detail(id);}
const commit=(b:ImportBatch,key=randomUUID())=>cmd('import_commit',{id:b.id,expectedVersion:b.version,previewHash:b.previewHash},owner,key);
const count=async(table:string)=>(await db.query<{n:number}>('SELECT count(*)::int AS n FROM '+table)).rows[0].n;

test('CSV/TSV保留中文、引号、换行与原行号；格式错误、超限不截断',async()=>{
 const d=parseDelimited('\uFEFF编号,备注\r\na,"中文,带逗号\n和""引号"""\r\nb,正常\r\n');assert.equal(d.sheets[0].rows.length,2);assert.equal(d.sheets[0].rows[0].cells[1].text,'中文,带逗号\n和"引号"');assert.equal(d.sheets[0].rows[1].line,4);
 assert.equal(parseDelimited('id\t姓名\nx\t小禾','\t').sheets[0].rows[0].cells[1].text,'小禾');
 for(const bad of ['姓名,姓名\na,b','姓名,\na,b','姓名\n"未闭合','姓名\n"a"x','姓名\na,b'])assert.throws(()=>parseDelimited(bad));
 assert.throws(()=>parseDelimited('编号\n'+Array.from({length:MAX_ROWS+1},(_,i)=>i).join('\n')),/1000/);
 await reject(parseFile('legacy.xls',Buffer.from('bad')),'IMPORT_FILE');await reject(parseFile('gbk.csv',Buffer.from([0xff,0xfe,0xff])),'IMPORT_ENCODING');
});

test('Excel多工作表、日期、隐藏行和公式按实际值处理，数字联系方式不能猜测',async()=>{
 const w=new ExcelJS.Workbook();const a=w.addWorksheet('名单甲');a.addRow(importHeaders);a.addRow(row(1,{2:13800138000,9:''}));a.getCell('J2').value=new Date('2030-12-31T00:00:00Z');a.getCell('H2').value={formula:'8+1',result:9};a.getRow(2).hidden=true;w.addWorksheet('名单乙').addRows([importHeaders,row(2)]);
 const b=await cmd('import_create',{fileName:'名单.xlsx',base64:Buffer.from(await w.xlsx.writeBuffer() as any).toString('base64')});let p=await validate(b.id,cfg({sheet:'名单甲'}));assert.equal(p.sheets.length,2);assert.match(p.rows[0].errors.join(','),/公式/);assert.match(p.rows[0].errors.join(','),/数字单元格/);assert.match(p.rows[0].warnings.join(','),/隐藏/);assert.equal(p.rows[0].expiresAt,'2030-12-31T16:00:00.000Z');
 const other=await cmd('import_sheet',{id:b.id,sheet:'名单乙'});p=await validate(other.id,cfg({sheet:'名单乙'}));assert.equal(p.status,'ready');await commit(p);assert.equal((await cmd('import_sheet',{id:b.id,sheet:'名单乙'})).id,other.id);
 assert.equal((await detail(b.id)).status,'invalid','一张表的完成不会把另一张表标成已完成');
});

test('损坏或伪造解压长度的Excel在解析前拒绝',async()=>{
 const w=new ExcelJS.Workbook();w.addWorksheet('名单').addRows([importHeaders,row()]);const b=Buffer.from(await w.xlsx.writeBuffer() as any);
 let at=b.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));assert.ok(at>0);b.writeUInt32LE(9*1024*1024,at+24);await reject(parseFile('bad.xlsx',b),'IMPORT_FILE');
 await reject(parseFile('bad.xlsx',Buffer.from('not zip')),'IMPORT_FILE');
});

test('100行混合10类问题逐行返回，分页不漏行，完整错误表保留原值',async()=>{
 const data=Array.from({length:100},(_,i)=>row(i+1));data[0][1]='';data[1][9]='2030-02-30';data[2][7]='-1';data[3][10]='小时';data[4][4]=data[5][4];data[6][5]='不存在的课程';data[7][0]='';data[8][8]='1.1234';data[9][2]='1.3800E+10';data[10][3]='a'.repeat(501);
 const {id}=await create(data);const p=await validate(id);assert.equal(p.totalRows,100);assert.equal(p.totalPages,2);assert.equal(p.rows.length,50);assert.equal((await detail(id,2)).rows.length,50);assert.equal(p.summary!.errors,11);assert.equal(p.status,'invalid');await reject(commit(p),'IMPORT_NOT_READY');assert.equal(await count('import_rows'),0);
 const report=await s.imports(owner,'report',id) as string;assert.ok(report.includes('不存在的课程'));assert.ok(report.includes('小时'));assert.equal(parseDelimited(report).sheets[0].rows.length,100);assert.equal(await count('students'),4);
});

test('期初付费/赠送精确到千分次，同一孩子多个包仅建一档，不增加收入',async()=>{
 const {id}=await create([row(1),row(1,{4:'G2',7:'0',8:'2.001',6:'纯赠送包'})]);const p=await validate(id);assert.equal(p.summary!.newStudents,1);assert.equal(p.summary!.purchased,8125);assert.equal(p.summary!.gift,3251);assert.equal(p.status,'ready');
 const before=await s.snapshot(owner),key=randomUUID();const r=await commit(p,key);assert.deepEqual(await commit(p,key),r);await commit(p);assert.equal(await count('students'),5);assert.equal(await count('import_rows'),2);
 const after=await s.snapshot(owner),student=after.students.find(x=>x.name==='迁入学员1')!;assert.equal(student.balance,11376);assert.equal(after.metrics.received,before.metrics.received);assert.equal(after.grants.filter(x=>x.student_id===student.id).length,2);assert.ok(after.grants.filter(x=>x.student_id===student.id).every(x=>x.source==='opening'&&x.template_id===null));
 await assert.rejects(db.query('DELETE FROM import_rows WHERE batch_id=$1',[id]));await assert.rejects(db.query("UPDATE import_batches SET file_name='覆盖' WHERE id=$1",[id]));
});

test('过期和零余额仍有逐行结果，过期权益不计当前可用课时',async()=>{
 const {id}=await create([row(1,{9:'2020-12-31'}),row(2,{7:'0',8:'0'})]);const p=await validate(id);assert.equal(p.summary!.expired,9375);assert.equal(p.summary!.available,0);assert.equal(p.summary!.grants,1);await commit(p);assert.equal(await count('import_rows'),2);assert.equal((await s.snapshot(owner)).students.find(x=>x.name==='迁入学员1')!.balance,0);
});

test('同名/同电话需要明确选择，关联已有学生不覆盖档案；同监护人两孩子保留两档',async()=>{
 const {id}=await create([row(1,{1:'小禾',3:'不覆盖已有备注'})]);let p=await validate(id);assert.equal(p.rows[0].needsResolution,true);p=await validate(id,cfg({targets:{S1:'student-1'}}));assert.equal(p.status,'ready');const before=(await s.snapshot(owner)).students.find(x=>x.id==='student-1')!;await commit(p);const after=(await s.snapshot(owner)).students.find(x=>x.id==='student-1')!;assert.equal(after.note,before.note);assert.equal(after.balance,before.balance+9375);assert.equal(await count('students'),4);
 const second=await create([row(2,{2:'13800138000'}),row(3,{2:'13800138000'})]);p=await validate(second.id);assert.equal(p.summary!.newStudents,2);assert.ok(p.rows.every(r=>r.warnings.some(w=>w.includes('共用'))));await commit(p);assert.equal(await count('students'),6);
});

test('文件内同名不同编号须确认新建，相同编号不一致与重复课包全部阻止',async()=>{
 const {id}=await create([row(1),row(2,{1:'迁入学员1'})]);let p=await validate(id);assert.ok(p.rows.every(r=>r.needsResolution));p=await validate(id,cfg({targets:{S1:'new',S2:'new'}}));assert.equal(p.status,'ready');await commit(p);assert.equal((await s.snapshot(owner)).students.filter(s=>s.name==='迁入学员1').length,2);
 const bad=await create([row(3),row(3,{1:'另一个人',4:'不同课包'})]);p=await validate(bad.id);assert.ok(p.rows.every(r=>r.errors.some(e=>e.includes('不一致'))));
});

test('来源编号防止跨文件重复余额，换文件名/幂等键仍复用原批次，绑定不可改人',async()=>{
 const original=[row(1)];const {id}=await create(original),p=await validate(id);await commit(p);
 const duplicate=await cmd('import_create',{fileName:'换名字.csv',text:csv([importHeaders,...original])});assert.equal(duplicate.id,id);assert.equal(duplicate.status,'completed');
 const other=await create([row(1,{3:'修改了无关备注'})]);let preview=await validate(other.id);assert.match(preview.rows[0].errors.join(','),/已在此前批次导入/);
 preview=await validate(other.id,cfg({targets:{S1:'student-2'}}));assert.match(preview.rows[0].errors.join(','),/不能改绑/);
 const next=await create([row(1,{4:'新原课包'})]);preview=await validate(next.id);assert.equal(preview.summary!.existingStudents,1);assert.equal(preview.summary!.newStudents,0);assert.equal(preview.status,'ready');
});

test('更改映射旧版本不能提交；预览后资料变更必须重新核对',async()=>{
 const {id}=await create([row(1,{1:'小禾'})]),config=cfg({targets:{S1:'student-1'}});const old=await validate(id,config);const current=await validate(id,config);await reject(commit(old),'VERSION_CONFLICT');
 await cmd('student',{id:'student-1',expectedVersion:1,name:'小禾',phone:'',note:'更新后的备注'});await reject(commit(current),'IMPORT_STALE');assert.equal(await count('import_rows'),0);
 const refreshed=await validate(id,config);assert.equal(refreshed.status,'ready');await commit(refreshed);
});

test('并发提交仅入账一次，审批角色/跨租户和撤权不能绕过',async()=>{
 const {id}=await create([row()]),p=await validate(id);await Promise.all([commit(p),commit(p)]);assert.equal(await count('import_rows'),1);
 await reject(s.imports(teacher,'detail',id),'FORBIDDEN');await reject(cmd('import_create',{fileName:'x.csv',text:'id\na'},teacher),'FORBIDDEN');
 await db.query("INSERT INTO tenants VALUES('other','另一机构')");await db.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES('other','owner-demo','owner')");await reject(s.imports({...owner,tenantId:'other'},'detail',id),'NOT_FOUND');
 await db.query("UPDATE memberships SET active=false WHERE tenant_id='studio-demo' AND user_id='owner-demo'");await reject(s.imports(owner,'report',id),'FORBIDDEN');
});

test('故障发生在后续行时，学员、权益、流水、来源和批次状态全部回滚',async()=>{
 const {id}=await create([row(1),row(2)]),p=await validate(id),before=await count('ledger');
 await db.exec("CREATE FUNCTION fail_import_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.line=3 THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_import_row BEFORE INSERT ON import_rows FOR EACH ROW EXECUTE FUNCTION fail_import_row();");
 await assert.rejects(commit(p),/synthetic failure/);assert.equal(await count('students'),4);assert.equal(await count('ledger'),before);assert.equal(await count('import_rows'),0);assert.equal(await count('import_student_links'),0);assert.equal((await detail(id)).status,'ready');
});

test('只导入名单无需课包字段，100行成功后数量与汇总一致，CSV输出防公式执行',async()=>{
 const {id}=await create(Array.from({length:100},(_,i)=>row(i+1,{3:'+cmd'})));const p=await validate(id,cfg({kind:'students'}));assert.equal(p.status,'ready');assert.equal(p.summary!.grants,0);await commit(p);assert.equal(await count('students'),104);assert.equal(await count('import_rows'),100);const report=await s.imports(owner,'report',id) as string;assert.ok(report.includes("'+cmd"));
});

test('HTTP接收超过旧100KB限制的文件；模板、详情和导出均重新鉴权',async()=>{
 const app=await createApp(s);await app.listen(0,'127.0.0.1');try{
  const base=await app.getUrl(),token=await s.login('owner'),headers={'Content-Type':'application/json',Authorization:'Bearer '+token,'Idempotency-Key':randomUUID()},text=csv([importHeaders,...Array.from({length:100},(_,i)=>row(i+1,{3:'注'.repeat(480)}))]);assert.ok(Buffer.byteLength(text)>100000);
  let r=await fetch(base+'/api/commands',{method:'POST',headers,body:JSON.stringify({operation:'import_create',input:{fileName:'大名单.csv',text}})});assert.equal(r.status,201);const {id}=await r.json();assert.equal((await fetch(base+'/api/imports/'+id,{headers})).status,200);
  assert.equal((await fetch(base+'/api/import-template.csv')).status,401);
  r=await fetch(base+'/api/commands',{method:'POST',headers,body:'{"bad":'});assert.equal(r.status,400);
  r=await fetch(base+'/api/commands',{method:'POST',headers,body:JSON.stringify({x:'a'.repeat(3*1024*1024)})});assert.equal(r.status,413);
 }finally{await app.close();}
});

test('1000行上限整批迁入并完整导出，最后一页/最后一行不被截断',async()=>{
 const data=Array.from({length:1000},(_,i)=>row(i+1,{7:'1.001',8:i%2?'0':'0.009',9:i%5?'2030-12-31':'2020-12-31'}));
 const {id}=await create(data),p=await validate(id);assert.equal(p.summary!.rows,1000);assert.equal(p.summary!.purchased,1001000);assert.equal(p.summary!.gift,4500);assert.equal(p.summary!.available,804400);assert.equal(p.totalPages,20);
 await commit(p);assert.equal(await count('students'),1004);assert.equal(await count('import_rows'),1000);assert.equal((await detail(id,20)).rows.at(-1)!.line,1001);
 const report=await s.imports(owner,'report',id) as string;assert.equal(parseDelimited(report).sheets[0].rows.length,1000);assert.ok(report.includes('迁入学员1000'));
});

test('导入批次列表的游标能遍历全部记录且不重复',async()=>{
 for(let n=1;n<=25;n++)await create([row(n)]);
 const first=await s.imports(owner,'list') as any;assert.equal(first.items.length,20);assert.ok(first.nextCursor);const second=await s.imports(owner,'list','',1,first.nextCursor) as any;assert.equal(second.items.length,5);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.items,...second.items].map(b=>b.id)).size,25);assert.ok(first.items.every((b:any)=>b.worksheet==='表格'));
});

test('工作表迁移为既有已完成批次补充标识，保留入账历史并恢复不可修改约束',async()=>{
 const {id}=await create([row()]);await commit(await validate(id));const before=await db.query('SELECT * FROM import_rows WHERE batch_id=$1',[id]);
 await db.exec('DROP INDEX import_batch_sheet_unique; ALTER TABLE import_batches DROP COLUMN worksheet; ALTER TABLE import_batches ADD UNIQUE(tenant_id,file_hash);');
 const {readFile}=await import('node:fs/promises');const sql=await readFile(new URL('../migrations/007-import-sheets.sql',import.meta.url),'utf8');await db.exec('BEGIN;'+sql+'COMMIT;');
 assert.deepEqual((await db.query('SELECT * FROM import_rows WHERE batch_id=$1',[id])).rows,before.rows);assert.equal((await db.query<any>('SELECT worksheet,status FROM import_batches WHERE id=$1',[id])).rows[0].worksheet,'表格');await assert.rejects(db.query("UPDATE import_batches SET file_name='仍不允许覆盖' WHERE id=$1",[id]));
});
