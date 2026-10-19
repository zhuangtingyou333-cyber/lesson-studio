import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Actor,ImportConfig,ImportField,ImportRowPreview,ImportSummary,ImportBatch,ImportList} from '../../../packages/contracts/index.ts';
import type {Sql} from '../db.ts';
import {ensure} from '../errors.ts';
import {parseFile,csv,MAX_FILE,type Document} from './parse.ts';
type Row=Record<string,any>;
const first=async(tx:Sql,sql:string,args:unknown[])=>(await tx.query<Row>(sql,args)).rows[0];
const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex');
const id=z.string().min(1).max(100),version=z.number().int().min(1);
const fields=['studentKey','name','phone','note','grantKey','course','package','purchased','gift','expires','unit'] as const;
export const importSchemas={
 import_sheet:z.object({id,sheet:z.string().min(1).max(100)}).strict(),
 import_create:z.object({fileName:z.string().trim().min(1).max(150),base64:z.string().max(Math.ceil(MAX_FILE/3)*4).optional(),text:z.string().max(MAX_FILE).optional()}).strict().refine(x=>(x.base64!==undefined)!==(x.text!==undefined),'请选择文件或粘贴表格'),
 import_validate:z.object({id,expectedVersion:version,config:z.object({sheet:z.string().min(1).max(100),source:z.string().trim().min(1).max(80),kind:z.enum(['students','opening']),mapping:z.partialRecord(z.enum(fields),z.number().int().min(0).max(29)),targets:z.record(z.string().min(1).max(80),id).refine(v=>Object.keys(v).length<=1000,'最多1000个关联选择')}).strict()}).strict(),
 import_commit:z.object({id,expectedVersion:version,previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
};
async function batch(tx:Sql,a:Actor,id:string){ensure(a.role==='owner','FORBIDDEN','只有管理员可以导入或导出迁移资料',403);const b=await first(tx,'SELECT * FROM import_batches WHERE tenant_id=$1 AND id=$2',[a.tenantId,id]);ensure(b,'NOT_FOUND','导入批次不存在',404);return b;}
const millis=(value:string)=>/^\d+(\.\d{1,3})?$/.test(value)&&Number(value)<=10000?Number(value.split('.')[0])*1000+Number((value.split('.')[1]||'').padEnd(3,'0')):null;
const validDate=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number(s.slice(0,4))>=2000&&Number(s.slice(0,4))<=2100&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;

export async function previewImport(tx:Sql,a:Actor,b:Row,config:ImportConfig){
 const doc=b.document as Document,sheet=doc.sheets.find(s=>s.name===config.sheet);ensure(sheet,'IMPORT_SHEET','请选择文件内的工作表');
 const required:ImportField[]=config.kind==='students'?['studentKey','name']:['studentKey','name','grantKey','course','purchased','expires','unit'];
 ensure(required.every(f=>config.mapping[f]!==undefined),'IMPORT_MAPPING','请映射全部必填列');
 const usedFields:readonly ImportField[]=config.kind==='students'?['studentKey','name','phone','note']:fields;
 const indices=usedFields.filter(f=>config.mapping[f]!==undefined).map(f=>config.mapping[f]!);ensure(new Set(indices).size===indices.length&&indices.every(i=>i!<sheet.headers.length),'IMPORT_MAPPING','每个字段必须选择不同且有效的列');
 ensure(sheet.rows.length>0,'IMPORT_EMPTY','所选工作表没有数据');
 const students=(await tx.query<Row>('SELECT id,name,phone,note,active,version FROM students WHERE tenant_id=$1 ORDER BY id',[a.tenantId])).rows;
 const courses=(await tx.query<Row>('SELECT id,name,active,version FROM courses WHERE tenant_id=$1',[a.tenantId])).rows;
 const links=(await tx.query<Row>('SELECT external_key,student_id FROM import_student_links WHERE tenant_id=$1 AND source=$2',[a.tenantId,config.source])).rows;
 const prior=(await tx.query<Row>('SELECT external_key,batch_id FROM import_rows WHERE tenant_id=$1 AND source=$2 AND external_key IS NOT NULL',[a.tenantId,config.source])).rows;
 const balances=(await tx.query<{student_id:string;balance:string}>('SELECT student_id,sum(delta)::text AS balance FROM ledger WHERE tenant_id=$1 GROUP BY student_id',[a.tenantId])).rows;
 const now=Date.now(),rows:ImportRowPreview[]=[];
 for(const raw of sheet.rows){
  const errors:string[]=[],warnings:string[]=[],v={} as Record<ImportField,string>;
  for(const f of fields){const col=usedFields.includes(f)?config.mapping[f]:undefined,c=col===undefined?undefined:raw.cells[col];v[f]=c?.text.trim()||'';if(c?.issue)errors.push(`${sheet.headers[col!]}：${c.issue}`);if(['phone','studentKey','grantKey'].includes(f)&&c?.numeric&&v[f])errors.push(`${sheet.headers[col!]}是数字单元格，请在原表设为文本，避免丢失前导零`);}
  if(raw.hidden)warnings.push('这是隐藏行或隐藏工作表中的数据，确认后也会导入');
  for(const [f,n] of [['studentKey',80],['name',80],['phone',24],['note',500],['grantKey',80],['course',80],['package',80]] as [ImportField,number][])if(v[f].length>n)errors.push(`${importHeaders[fields.indexOf(f)]}超过${n}字`);
  if(v.phone&&!/^[+0-9 ()-]+$/.test(v.phone))errors.push('联系方式含无效字符或科学计数法，请按原号码填写');
  if(!v.studentKey||!v.name)errors.push('原学员编号和姓名必填');
  if(Object.values(v).some(x=>x.startsWith('=')))errors.push('含公式样式文本，请粘贴为值');
  const linked=links.find(l=>l.external_key===v.studentKey),targetChoice=Object.prototype.hasOwnProperty.call(config.targets,v.studentKey)?config.targets[v.studentKey]:undefined;
  const candidates=students.filter(s=>s.name===v.name||(v.phone&&s.phone===v.phone));let targetId:string|null=null,studentVersion:number|null=null,needsResolution=!linked&&(!!targetChoice||candidates.length>0);
  if(linked){targetId=linked.student_id;if(targetChoice&&targetChoice!==targetId)errors.push('此来源的原学员编号已经绑定，不能改绑到其他人');}
  else if(targetChoice&&targetChoice!=='new')targetId=targetChoice;
  else if(candidates.length&&!targetChoice){errors.push('已有同名或同联系方式学员，请明确关联已有学员或创建不同学员');needsResolution=true;}
  if(targetId){const s=students.find(s=>s.id===targetId);if(!s||!s.active)errors.push('关联学员不存在或已归档');else{studentVersion=s.version;if(s.name!==v.name||v.phone&&s.phone&&s.phone!==v.phone)errors.push('关联学员的姓名或联系方式不一致，请先核对原表和档案');if(v.note&&v.note!==s.note||v.phone&&!s.phone)warnings.push('复用已有学员，不覆盖其联系方式和备注');}}
  let purchased=0,gift=0,expiresAt='',courseId='',courseName='',courseVersion:number|null=null;
  if(config.kind==='opening'){
   if(!v.grantKey)errors.push('原课包编号必填，用于防止重复迁入');
   if(v.grantKey&&prior.some(p=>p.external_key===v.grantKey))errors.push('原课包编号已在此前批次导入，不能再次入账');
   if(v.unit!=='次')errors.push('本次导入单位必须为“次”，不可把分钟或期限当次数');
   const p=millis(v.purchased),g=millis(v.gift||'0');if(p===null||g===null)errors.push('剩余课时须为0–10000之间的数，最多3位小数，不接受负数、千分位或科学计数法');else{purchased=p;gift=g;}
   if(!validDate(v.expires))errors.push('到期日期须为有效的YYYY-MM-DD（2000–2100年）');else{expiresAt=new Date(Date.parse(v.expires+'T00:00:00+08:00')+86400000).toISOString();if(Date.parse(expiresAt)<=now)warnings.push('课包已到期：保留期初账面记录，不计入当前可用课时');}
   const match=courses.filter(c=>c.name===v.course);if(match.length!==1||!match[0].active)errors.push('课程名称不存在、已归档或有重名，请先在课程资料中处理');else{courseId=match[0].id;courseName=match[0].name;courseVersion=match[0].version;}
   if(p!==null&&g!==null&&p+g===0)warnings.push('余额为0：只记录学员与迁入来源，不创建课时流水');
  }
  rows.push({line:raw.line,studentKey:v.studentKey,name:v.name,phone:v.phone,note:v.note,grantKey:config.kind==='opening'?v.grantKey:'',courseId,courseName,packageName:v.package||('期初迁入 · '+v.course),purchased,gift,expiresAt,targetId,studentVersion,courseVersion,errors,warnings,needsResolution,candidateNames:candidates.slice(0,3).map(c=>c.name+'（'+(c.phone?c.phone.slice(-4):'无电话')+'）')});
 }
 const groups=new Map<string,ImportRowPreview[]>();for(const r of rows)groups.set(r.studentKey,[...(groups.get(r.studentKey)||[]),r]);
 for(const group of groups.values()){
  if(new Set(group.map(r=>JSON.stringify([r.name,r.phone,r.note,r.targetId]))).size>1)for(const r of group)r.errors.push('同一原学员编号对应了不一致的姓名、联系资料或关联选择');
  if(config.kind==='students'&&group.length>1)for(const r of group)r.errors.push('名单中同一原学员编号重复，请先去重');
 }
 for(const r of rows){
  if(r.phone&&rows.some(x=>x.studentKey!==r.studentKey&&x.phone===r.phone))r.warnings.push('文件内不同学员共用联系方式，按原学员编号分别保留');
  if(r.grantKey&&rows.filter(x=>x.grantKey===r.grantKey).length>1)r.errors.push('文件内原课包编号重复，不能重复入账');
  if(!r.targetId&&rows.some(x=>x.studentKey!==r.studentKey&&x.name===r.name)&&config.targets[r.studentKey]!=='new'){r.errors.push('文件内不同编号使用同一姓名，请明确是否为不同学员');r.needsResolution=true;}
 }
 const newKeys=new Set<string>(),existing=new Set<string>(),additions=new Map<string,number>();
 for(const r of rows){const key=r.targetId||'new:'+r.studentKey;additions.set(key,(additions.get(key)||0)+r.purchased+r.gift);if(r.targetId)existing.add(r.targetId);else newKeys.add(r.studentKey);}
 for(const r of rows){const key=r.targetId||'new:'+r.studentKey,old=balances.find(b=>b.student_id===r.targetId);if(Number(old?.balance||0)+(additions.get(key)||0)>2000000000)r.errors.push('此学员总课时超出系统上限，请核对单位和重复数据');}
 const summary:ImportSummary={rows:rows.length,errors:rows.filter(r=>r.errors.length).length,warnings:rows.filter(r=>r.warnings.length).length,newStudents:newKeys.size,existingStudents:existing.size,grants:rows.filter(r=>r.purchased+r.gift>0).length,purchased:rows.reduce((n,r)=>n+r.purchased,0),gift:rows.reduce((n,r)=>n+r.gift,0),available:rows.filter(r=>Date.parse(r.expiresAt)>now).reduce((n,r)=>n+r.purchased+r.gift,0),expired:rows.filter(r=>Date.parse(r.expiresAt)<=now).reduce((n,r)=>n+r.purchased+r.gift,0)};
 return {rows,summary,asOf:new Date(now).toISOString(),canCommit:summary.errors===0,hash:hash({fileHash:b.file_hash,config,rows,summary})};
}

export async function importMutation(tx:Sql,a:Actor,op:string,d:Row){
 ensure(a.role==='owner','FORBIDDEN','只有管理员可以导入资料',403);
 if(op==='import_create'){
  let bytes:Buffer;if(d.base64!==undefined){ensure(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(d.base64),'IMPORT_FILE','文件编码无效');bytes=Buffer.from(d.base64,'base64');}else bytes=Buffer.from(d.text,'utf8');
  ensure(bytes.length>0&&bytes.length<=MAX_FILE,'IMPORT_LIMIT','文件须为2MB以内');const fileHash=createHash('sha256').update(bytes).digest('hex');
  const old=await first(tx,'SELECT id,status,version FROM import_batches WHERE tenant_id=$1 AND file_hash=$2 ORDER BY seq LIMIT 1',[a.tenantId,fileHash]);if(old)return {...old,existing:true};
  const document=await parseFile(d.fileName,bytes),id=randomUUID();
  await tx.query('INSERT INTO import_batches(tenant_id,id,file_name,file_hash,worksheet,document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[a.tenantId,id,d.fileName,fileHash,document.sheets[0].name,JSON.stringify(document),a.userId]);return {id,version:1,status:'draft',existing:false};
 }
 const b=await batch(tx,a,d.id);
 if(op==='import_sheet'){
  ensure((b.document as Document).sheets.some(s=>s.name===d.sheet),'IMPORT_SHEET','工作表不存在');
  const prior=await first(tx,'SELECT id,status,version FROM import_batches WHERE tenant_id=$1 AND file_hash=$2 AND worksheet=$3',[a.tenantId,b.file_hash,d.sheet]);if(prior)return {...prior,existing:true};
  const id=randomUUID();await tx.query('INSERT INTO import_batches(tenant_id,id,file_name,file_hash,worksheet,document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[a.tenantId,id,b.file_name,b.file_hash,d.sheet,JSON.stringify(b.document),a.userId]);return {id,version:1,status:'draft',existing:false};
 }
 if(op==='import_commit'&&b.status==='completed'){ensure(d.previewHash===b.preview_hash,'VERSION_CONFLICT','批次已经按其他预览完成',409);return {id:b.id,status:'completed',version:b.version,summary:b.preview.summary};}
 ensure(b.version===d.expectedVersion&&b.status!=='completed','VERSION_CONFLICT','批次已变化或完成，请刷新',409);
 if(op==='import_validate'){
  ensure(d.config.sheet===b.worksheet,'IMPORT_SHEET','此批次对应另一工作表，请先选择工作表');
  const preview=await previewImport(tx,a,b,d.config),status=preview.canCommit?'ready':'invalid';
  await tx.query('UPDATE import_batches SET config=$3,preview=$4,preview_hash=$5,status=$6,version=version+1 WHERE tenant_id=$1 AND id=$2',[a.tenantId,b.id,JSON.stringify(d.config),JSON.stringify(preview),preview.hash,status]);
  return {id:b.id,version:b.version+1,status,summary:preview.summary};
 }
 ensure(op==='import_commit','UNKNOWN_COMMAND','不支持此导入操作');ensure(b.status==='ready'&&b.config&&b.preview_hash===d.previewHash,'IMPORT_NOT_READY','请先生成有效预览，再确认',409);
 const p=await previewImport(tx,a,b,b.config);ensure(p.canCommit&&p.hash===b.preview_hash,'IMPORT_STALE','学员、课程、关联或到期状态已变化，请重新预览后确认',409);
 const created=new Map<string,string>();
 for(const r of p.rows){
  let studentId=r.targetId||created.get(r.studentKey);
  if(!studentId){studentId=randomUUID();created.set(r.studentKey,studentId);await tx.query('INSERT INTO students(tenant_id,id,name,phone,note) VALUES($1,$2,$3,$4,$5)',[a.tenantId,studentId,r.name,r.phone,r.note]);}
  await tx.query('INSERT INTO import_student_links(tenant_id,source,external_key,student_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[a.tenantId,b.config.source,r.studentKey,studentId]);
  let grantId:string|null=null;
  if(r.purchased+r.gift>0){
   grantId=randomUUID();await tx.query("INSERT INTO grants(tenant_id,id,student_id,course_id,package_name,purchased,gift,source,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'opening',$8)",[a.tenantId,grantId,studentId,r.courseId,r.packageName,r.purchased,r.gift,r.expiresAt]);
   for(const [quantity,kind] of [[r.purchased,'opening'],[r.gift,'gift']] as const)if(quantity)await tx.query('INSERT INTO ledger(tenant_id,id,grant_id,student_id,delta,kind,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[a.tenantId,randomUUID(),grantId,studentId,quantity,kind,a.userId,`期初${kind==='gift'?'赠课':''}导入：${b.file_name} 第${r.line}行（${b.id}）`]);
  }
  await tx.query('INSERT INTO import_rows(tenant_id,batch_id,line,source,external_key,student_id,grant_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[a.tenantId,b.id,r.line,b.config.source,r.grantKey||null,studentId,grantId,JSON.stringify(r)]);
 }
 await tx.query("UPDATE import_batches SET status='completed',version=version+1,completed_at=now() WHERE tenant_id=$1 AND id=$2",[a.tenantId,b.id]);
 return {id:b.id,status:'completed',version:b.version+1,summary:p.summary};
}
export async function importDetail(tx:Sql,a:Actor,id:string,page=1):Promise<ImportBatch>{
 const b=await batch(tx,a,id),rows=b.preview?.rows||[];return {id:b.id,file_name:b.file_name,status:b.status,version:b.version,created_at:new Date(b.created_at).toISOString(),completed_at:b.completed_at?new Date(b.completed_at).toISOString():null,sheets:(b.document as Document).sheets.map(s=>({name:s.name,headers:s.headers,rows:s.rows.length,sample:s.rows.slice(0,2).map(r=>r.cells.map(c=>c.text))})),config:b.config||{sheet:b.worksheet,source:'原系统',kind:'opening',mapping:{},targets:{}},previewHash:b.preview_hash,summary:b.preview?.summary||null,rows:rows.slice((page-1)*50,page*50),page,totalPages:Math.ceil(rows.length/50),totalRows:rows.length};
}
export async function importList(tx:Sql,a:Actor,cursor?:string):Promise<ImportList>{
 ensure(a.role==='owner','FORBIDDEN','只有管理员可以查看导入记录',403);const rows=(await tx.query<Row>('SELECT id,file_name,worksheet,status,version,created_at,completed_at,seq::text AS cursor_seq FROM import_batches WHERE tenant_id=$1 AND ($2::bigint IS NULL OR seq<$2::bigint) ORDER BY seq DESC LIMIT 21',[a.tenantId,cursor||null])).rows;
 return {items:rows.slice(0,20).map(r=>({id:r.id,file_name:r.file_name,worksheet:r.worksheet,status:r.status,version:r.version,created_at:new Date(r.created_at).toISOString(),completed_at:r.completed_at?new Date(r.completed_at).toISOString():null})),nextCursor:rows.length>20?rows[19].cursor_seq:null};
}
export const importHeaders=['原学员编号','姓名','联系方式','备注','原课包编号','课程名称','课包名称','剩余付费次数','剩余赠送次数','到期日期','单位'];
export async function importReport(tx:Sql,a:Actor,id:string){
 const b=await batch(tx,a,id);ensure(b.preview,'IMPORT_NOT_READY','请先生成预览');const imported=(await tx.query<Row>('SELECT line,student_id,grant_id FROM import_rows WHERE tenant_id=$1 AND batch_id=$2',[a.tenantId,id])).rows;
 const sheet=(b.document as Document).sheets.find(s=>s.name===b.config.sheet)!;
 return csv([['批次','状态','核对时间','原行号',...importHeaders.map(h=>b.status==='completed'&&h.startsWith('剩余')?'迁入时'+h:h),'课间学员编号','课间权益编号','结果','提示'],...b.preview.rows.map((r:ImportRowPreview)=>{
  const saved=imported.find(x=>x.line===r.line),raw=sheet.rows.find(x=>x.line===r.line)!;
  return [id,b.status,new Date(b.completed_at||b.preview.asOf||b.created_at).toISOString(),r.line,...fields.map(f=>b.config.mapping[f]===undefined?'':raw.cells[b.config.mapping[f]]?.text||''),saved?.student_id||r.targetId||'',saved?.grant_id||'',r.errors.join('；')||(b.status==='completed'?'已导入':'校验通过'),r.warnings.join('；')];
 })]);
}
