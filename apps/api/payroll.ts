import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Actor,PayrollRule,PayrollLine,PayrollCalculation,PayrollDetail,PayrollOverview} from '../../packages/contracts/index.ts';
import type {Sql} from './db.ts';
import {ensure} from './errors.ts';
import {csv} from './imports/parse.ts';
type Row=Record<string,any>;
const id=z.string().min(1).max(100),reason=z.string().trim().min(1).max(300),version=z.number().int().min(0);
const date=z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;},'日期无效');
const month=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/,'账期格式应为YYYY-MM');
export const payrollLookupSchema=z.object({teacherId:id,month}).strict();
export const payrollSchemas={
 payroll_rule:z.object({teacherId:id,courseId:id,expectedVersion:version,effectiveFrom:date,mode:z.enum(['lesson','student']),rate:z.number().int().min(0).max(100000000),countAbsent:z.boolean(),countMakeup:z.boolean(),reason}).strict(),
 payroll_calculate:z.object({teacherId:id,month,expectedVersion:version}).strict(),
 payroll_freeze:z.object({id,expectedVersion:version.min(1),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason}).strict(),
};
const first=async(tx:Sql,q:string,v:unknown[])=>(await tx.query<Row>(q,v)).rows[0];
const iso=(v:string)=>new Date(v).toISOString();
const localDate=(v:string|number)=>new Date(new Date(v).getTime()+8*3600000).toISOString().slice(0,10);
export function nextPayrollMonth(m:string){return m.slice(5)==='12'?`${Number(m.slice(0,4))+1}-01`:`${m.slice(0,4)}-${String(Number(m.slice(5))+1).padStart(2,'0')}`;}
const bounds=(m:string)=>({start:m+'-01T00:00:00+08:00',end:nextPayrollMonth(m)+'-01T00:00:00+08:00'});
const ruleView=(r:Row):PayrollRule=>({id:r.id,teacherId:r.teacher_id,courseId:r.course_id,version:r.version,effectiveFrom:String(r.effective_from).slice(0,10),mode:r.mode,rate:r.rate,countAbsent:r.count_absent,countMakeup:r.count_makeup,reason:r.reason});
// JSONB reorders object keys; fingerprints use canonical keys at every depth.
const stable=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
function access(a:Actor,teacherId?:string){ensure(a.role!=='guardian'&&(a.role==='owner'||teacherId===undefined||teacherId===a.userId),'FORBIDDEN','只能查看本人课酬；管理员可核对机构课酬',403);}
async function teacher(tx:Sql,t:string,teacherId:string){const m=await first(tx,"SELECT u.name,m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.role IN ('owner','teacher')",[t,teacherId]);ensure(m,'NOT_FOUND','该机构没有此授课成员',404);return m;}
async function lessonRecords(tx:Sql,t:string,ids:string[]){
 if(!ids.length)return [];
 return (await tx.query<Row>(`SELECT b.id,b.session_id,b.student_id,b.state,b.makeup_id,s.name AS student_name,COALESCE(a.revision,0) AS revision,a.status
 FROM bookings b JOIN students s ON(s.tenant_id=b.tenant_id AND s.id=b.student_id) LEFT JOIN attendance a ON(a.tenant_id=b.tenant_id AND a.booking_id=b.id)
 WHERE b.tenant_id=$1 AND b.session_id=ANY($2::text[]) ORDER BY b.id`,[t,ids])).rows;
}
function lessonLine(l:Row,records:Row[],rule:PayrollRule|null):PayrollLine{
 const students=records.map(b=>({id:b.student_id,name:b.student_name,bookingId:b.id,revision:b.revision,status:b.state==='cancelled'?'cancelled':b.status|| (b.state==='leave'?'leave':'unmarked'),makeup:!!b.makeup_id}));
 const eligible=students.filter(s=>(s.status==='attended'||s.status==='absent'&&rule?.countAbsent)&&(!s.makeup||rule?.countMakeup)).length;
 const pending=students.filter(s=>s.status==='unmarked').length;
 const amount=l.status==='cancelled'||!rule?0:rule.rate*(rule.mode==='lesson'?(eligible>0?1:0):eligible);
 return {key:l.id,kind:'lesson',lessonId:l.id,courseId:l.course_id,courseName:l.course_name,startsAt:iso(l.starts_at),endsAt:iso(l.ends_at),room:l.room,lessonStatus:l.status,rule,eligible,pending,amount,students,note:l.status==='cancelled'?'课程已取消，不计课酬':rule?'':'尚未配置生效规则'};
}
async function calculate(tx:Sql,a:Actor,teacherId:string,m:string):Promise<PayrollCalculation>{
 access(a,teacherId);const person=await teacher(tx,a.tenantId,teacherId),t=a.tenantId,b= bounds(m);
 ensure(m<=localDate(Date.now()).slice(0,7),'PAYROLL_FUTURE','不能生成未来账期');
 const lessons=(await tx.query<Row>('SELECT l.*,c.name AS course_name FROM lessons l JOIN courses c ON(c.tenant_id=l.tenant_id AND c.id=l.course_id) WHERE l.tenant_id=$1 AND l.teacher_id=$2 AND l.starts_at>=$3 AND l.starts_at<$4 ORDER BY l.starts_at,l.id',[t,teacherId,b.start,b.end])).rows;
 const rules=(await tx.query<Row>('SELECT *,effective_from::text AS effective_from FROM payroll_rules WHERE tenant_id=$1 AND teacher_id=$2 ORDER BY payroll_rules.effective_from DESC,version DESC',[t,teacherId])).rows.map(ruleView);
 const records=await lessonRecords(tx,t,lessons.map(l=>l.id));
 const rows=lessons.map(l=>lessonLine(l,records.filter(b=>b.session_id===l.id),rules.find(r=>r.courseId===l.course_id&&r.effectiveFrom<=localDate(l.starts_at))||null));
 const blockers:string[]=[];
 if(Date.parse(b.end)>Date.now())blockers.push('账期尚未结束，只能保存草稿');
 for(const l of rows){if(l.lessonStatus==='cancelled')continue;if(!l.rule)blockers.push(`${localDate(l.startsAt)} ${l.courseName}：缺少课酬规则`);if(l.pending)blockers.push(`${localDate(l.startsAt)} ${l.courseName}：${l.pending}人尚未完成点名`);if(Date.parse(l.endsAt)>Date.now())blockers.push(`${localDate(l.startsAt)} ${l.courseName}：课程尚未结束`);}
 const adjustments=(await tx.query<Row>(`SELECT a.*,p.month AS source_month FROM payroll_adjustments a JOIN payroll_periods p ON(p.tenant_id=a.tenant_id AND p.id=a.source_period_id)
 WHERE a.tenant_id=$1 AND a.teacher_id=$2 AND a.eligible_month<=$3 AND NOT EXISTS(SELECT 1 FROM payroll_applied_adjustments x WHERE x.tenant_id=a.tenant_id AND x.adjustment_id=a.id) ORDER BY a.seq`,[t,teacherId,m])).rows;
 for(const adj of adjustments){const source=adj.snapshot as PayrollLine;rows.push({...source,key:adj.id,kind:'adjustment',amount:Number(adj.amount),sourcePeriodId:adj.source_period_id,sourceMonth:adj.source_month,beforeAmount:Number(adj.before_amount),afterAmount:Number(adj.after_amount),eligibleMonth:adj.eligible_month,note:adj.reason});}
 const pendingSources=[...new Set(adjustments.map(a=>a.lesson_id))];
 for(const record of await lessonRecords(tx,t,pendingSources))if(record.state==='confirmed'&&(!record.status||record.status==='unmarked'))blockers.push('历史课次的点名更正尚未完成，请先处理后再结算差额');
 const baseAmount=rows.filter(r=>r.kind==='lesson').reduce((sum,r)=>sum+r.amount,0),adjustmentAmount=rows.filter(r=>r.kind==='adjustment').reduce((sum,r)=>sum+r.amount,0),total=baseAmount+adjustmentAmount;
 ensure(Number.isSafeInteger(total),'PAYROLL_LIMIT','金额超出可安全计算范围，请联系管理员');
 const result={teacherId,teacherName:person.name,month:m,rows,baseAmount,adjustmentAmount,total,blockers:[...new Set(blockers)]};
 return {...result,fingerprint:hash(result),calculatedAt:new Date().toISOString()};
}
export async function payrollMutation(tx:Sql,a:Actor,op:string,d:Row){
 ensure(a.role==='owner','FORBIDDEN','只有管理员可以配置和结算课酬',403);const t=a.tenantId;
 if(op==='payroll_rule'){
  await teacher(tx,t,d.teacherId);ensure(await first(tx,'SELECT 1 FROM courses WHERE tenant_id=$1 AND id=$2',[t,d.courseId]),'NOT_FOUND','课程不存在',404);
  const last=await first(tx,'SELECT max(version)::int AS version FROM payroll_rules WHERE tenant_id=$1 AND teacher_id=$2 AND course_id=$3',[t,d.teacherId,d.courseId]);ensure((last.version||0)===d.expectedVersion,'VERSION_CONFLICT','规则已更新，请重新加载',409);
  const frozen=await first(tx,"SELECT month FROM payroll_periods WHERE tenant_id=$1 AND teacher_id=$2 AND status='frozen' ORDER BY month DESC LIMIT 1",[t,d.teacherId]);
  ensure(!frozen||d.effectiveFrom>=nextPayrollMonth(frozen.month)+'-01','PAYROLL_RULE_FROZEN','生效日期不能覆盖已冻结账期，请设置后续日期',409);
  const key=randomUUID(),version=d.expectedVersion+1;
  await tx.query('INSERT INTO payroll_rules(tenant_id,id,teacher_id,course_id,version,effective_from,mode,rate,count_absent,count_makeup,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[t,key,d.teacherId,d.courseId,version,d.effectiveFrom,d.mode,d.rate,d.countAbsent,d.countMakeup,d.reason,a.userId]);return {id:key,version};
 }
 if(op==='payroll_calculate'){
  const existing=await first(tx,'SELECT id,status,version FROM payroll_periods WHERE tenant_id=$1 AND teacher_id=$2 AND month=$3',[t,d.teacherId,d.month]);
  ensure(!existing||existing.status==='draft','PAYROLL_FROZEN','账期已冻结，后续更正计入调整，不能覆盖原账',409);ensure((existing?.version||0)===d.expectedVersion,'VERSION_CONFLICT','草稿已更新，请重新加载',409);
  const snapshot=await calculate(tx,a,d.teacherId,d.month),key=existing?.id||randomUUID(),version=(existing?.version||0)+1;
  if(existing)await tx.query('UPDATE payroll_periods SET snapshot=$3,fingerprint=$4,version=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2',[t,key,JSON.stringify(snapshot),snapshot.fingerprint,version]);
  else await tx.query("INSERT INTO payroll_periods(tenant_id,id,teacher_id,month,status,snapshot,fingerprint) VALUES($1,$2,$3,$4,'draft',$5,$6)",[t,key,d.teacherId,d.month,JSON.stringify(snapshot),snapshot.fingerprint]);
  return {id:key,version,status:'draft',total:snapshot.total};
 }
 const p=await first(tx,'SELECT * FROM payroll_periods WHERE tenant_id=$1 AND id=$2',[t,d.id]);ensure(p,'NOT_FOUND','账期不存在',404);
 ensure(p.status==='draft','PAYROLL_FROZEN','账期已冻结，不能再次确认',409);ensure(p.version===d.expectedVersion&&p.fingerprint===d.fingerprint,'VERSION_CONFLICT','草稿已变化，请重新加载',409);
 const current=await calculate(tx,a,p.teacher_id,p.month);ensure(current.fingerprint===p.fingerprint,'PAYROLL_STALE','点名、规则或待调整项已变化，请重新计算后审核',409);ensure(!current.blockers.length,'PAYROLL_NOT_READY','仍有未完成事项，不能冻结账期',409);
 await tx.query("UPDATE payroll_periods SET status='frozen',version=version+1,frozen_at=now(),frozen_by=$3,freeze_reason=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",[t,p.id,a.userId,d.reason]);
 for(const row of current.rows){
  if(row.kind==='lesson')await tx.query('INSERT INTO payroll_sources(tenant_id,lesson_id,period_id,teacher_id,amount,snapshot) VALUES($1,$2,$3,$4,$5,$6)',[t,row.lessonId,p.id,p.teacher_id,row.amount,JSON.stringify(row)]);
  else await tx.query('INSERT INTO payroll_applied_adjustments(tenant_id,adjustment_id,period_id) VALUES($1,$2,$3)',[t,row.key,p.id]);
 }
 return {id:p.id,version:p.version+1,status:'frozen',total:current.total};
}
// Called after each attendance revision inside the existing tenant transaction.
// Frozen rules are used; a later rule edit cannot reprice already settled teaching.
export async function syncPayroll(tx:Sql,a:Actor,bookingId:string,revision:number,reason:string){
 const t=a.tenantId;
 const source=await first(tx,`SELECT x.*,p.month FROM payroll_sources x JOIN bookings b ON(b.tenant_id=x.tenant_id AND b.session_id=x.lesson_id) JOIN payroll_periods p ON(p.tenant_id=x.tenant_id AND p.id=x.period_id) WHERE b.tenant_id=$1 AND b.id=$2`,[t,bookingId]);
 if(!source)return;
 const frozen=source.snapshot as PayrollLine;
 const l=await first(tx,'SELECT l.*,c.name AS course_name FROM lessons l JOIN courses c ON(c.tenant_id=l.tenant_id AND c.id=l.course_id) WHERE l.tenant_id=$1 AND l.id=$2',[t,source.lesson_id]);
 const current=lessonLine(l,await lessonRecords(tx,t,[l.id]),frozen.rule);
 const previous=await first(tx,'SELECT COALESCE(sum(amount),0)::text AS total FROM payroll_adjustments WHERE tenant_id=$1 AND lesson_id=$2',[t,l.id]);
 const before=Number(source.amount)+Number(previous.total),delta=current.amount-before;if(!delta)return;
 const eligible=[nextPayrollMonth(source.month),localDate(Date.now()).slice(0,7)].sort().at(-1)!;
 await tx.query('INSERT INTO payroll_adjustments(tenant_id,id,lesson_id,source_period_id,teacher_id,amount,before_amount,after_amount,eligible_month,trigger_booking,trigger_revision,snapshot,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[t,randomUUID(),l.id,source.period_id,source.teacher_id,delta,before,current.amount,eligible,bookingId,revision,JSON.stringify(current),reason,a.userId]);
}
export async function payrollOverview(tx:Sql,a:Actor,cursor?:string):Promise<PayrollOverview>{
 access(a);const t=a.tenantId;
 const teachers=(await tx.query<Row>("SELECT m.user_id AS id,u.name,m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.role IN ('owner','teacher') AND ($2 OR m.user_id=$3) ORDER BY u.name,m.user_id",[t,a.role==='owner',a.userId])).rows;
 const rules=(await tx.query<Row>('SELECT *,effective_from::text AS effective_from FROM payroll_rules WHERE tenant_id=$1 AND ($2 OR teacher_id=$3) ORDER BY teacher_id,course_id,version DESC',[t,a.role==='owner',a.userId])).rows.map(ruleView);
 const periods=(await tx.query<Row>('SELECT id,teacher_id,month,status,version,snapshot,seq::text AS cursor_seq FROM payroll_periods WHERE tenant_id=$1 AND ($2 OR teacher_id=$3) AND ($4::bigint IS NULL OR seq<$4::bigint) ORDER BY seq DESC LIMIT 21',[t,a.role==='owner',a.userId,cursor||null])).rows;
 const courses=(await tx.query<{id:string;name:string}>('SELECT id,name FROM courses WHERE tenant_id=$1 ORDER BY name,id',[t])).rows;
 const pending=(await tx.query<Row>(`SELECT a.id,a.lesson_id,a.source_period_id,a.amount,a.eligible_month,a.reason,a.teacher_id,a.snapshot,p.month AS source_month FROM payroll_adjustments a JOIN payroll_periods p ON(p.tenant_id=a.tenant_id AND p.id=a.source_period_id) WHERE a.tenant_id=$1 AND ($2 OR a.teacher_id=$3) AND NOT EXISTS(SELECT 1 FROM payroll_applied_adjustments x WHERE x.tenant_id=a.tenant_id AND x.adjustment_id=a.id) ORDER BY a.seq`,[t,a.role==='owner',a.userId])).rows;
 return {role:a.role,teachers:teachers.map(x=>({id:x.id,name:x.name,active:x.active})),courses,rules,periods:periods.slice(0,20).map(p=>({id:p.id,teacherId:p.teacher_id,teacherName:p.snapshot.teacherName,month:p.month,status:p.status,version:p.version,total:p.snapshot.total})),nextCursor:periods.length>20?periods[19].cursor_seq:null,pending:pending.map(p=>({id:p.id,teacherId:p.teacher_id,lessonId:p.lesson_id,sourcePeriodId:p.source_period_id,sourceMonth:p.source_month,eligibleMonth:p.eligible_month,amount:Number(p.amount),reason:p.reason,courseName:p.snapshot.courseName}))};
}
async function period(tx:Sql,a:Actor,id:string){access(a);const p=await first(tx,'SELECT * FROM payroll_periods WHERE tenant_id=$1 AND id=$2',[a.tenantId,id]);ensure(p,'NOT_FOUND','账期不存在',404);access(a,p.teacher_id);return p;}
export async function payrollLookup(tx:Sql,a:Actor,input:{teacherId:string;month:string}){
 access(a,input.teacherId);await teacher(tx,a.tenantId,input.teacherId);
 return await first(tx,'SELECT id,version,status FROM payroll_periods WHERE tenant_id=$1 AND teacher_id=$2 AND month=$3',[a.tenantId,input.teacherId,input.month])||null;
}
export async function payrollDetail(tx:Sql,a:Actor,id:string,page=1):Promise<PayrollDetail>{
 const p=await period(tx,a,id),s=p.snapshot as PayrollCalculation;
 const stale=p.status==='draft'&&(await calculate(tx,a,p.teacher_id,p.month)).fingerprint!==p.fingerprint;
 const pages=Math.max(1,Math.ceil(s.rows.length/50));ensure(page<=pages,'VALIDATION','页码超出范围');
 return {...s,rows:s.rows.slice((page-1)*50,page*50),id:p.id,status:p.status,version:p.version,stale,frozenAt:p.frozen_at?iso(p.frozen_at):null,freezeReason:p.freeze_reason,page,totalPages:pages,totalRows:s.rows.length,canFreeze:p.status==='draft'&&!stale&&!s.blockers.length};
}
export async function payrollReport(tx:Sql,a:Actor,id:string){
 const p=await period(tx,a,id),s=p.snapshot as PayrollCalculation;
 if(p.status==='draft')ensure((await calculate(tx,a,p.teacher_id,p.month)).fingerprint===p.fingerprint,'PAYROLL_STALE','草稿已过时，请重新计算后导出',409);
 const rows:unknown[][]=[['账期','老师','状态','计算时间','类型','课次编号','原账期','课程','开始时间(北京时间)','规则版本','计费方式','单价(元)','计费人数','金额(元)','调整前(元)','调整后(元)','说明','出勤依据','账期基础(元)','调整合计(元)','账期合计(元)','阻塞事项']];
 const status=p.status==='frozen'?'已冻结（非付款凭证）':'草稿（非付款凭证）';
 for(const r of s.rows)rows.push([s.month,s.teacherName,status,s.calculatedAt,r.kind==='lesson'?'本期课次':'历史调整',r.lessonId,r.sourceMonth||'',r.courseName,new Date(Date.parse(r.startsAt)+8*3600000).toISOString().slice(0,16).replace('T',' '),r.rule?.version??'',r.rule?.mode==='lesson'?'按课次':r.rule?.mode==='student'?'按人数':'',r.rule?(r.rule.rate/100).toFixed(2):'',r.eligible,(r.amount/100).toFixed(2),r.beforeAmount===undefined?'':(r.beforeAmount/100).toFixed(2),r.afterAmount===undefined?'':(r.afterAmount/100).toFixed(2),r.note,r.students.map(x=>`${x.name}:${x.status}:修订${x.revision}${x.makeup?':补课':''}`).join('；'),(s.baseAmount/100).toFixed(2),(s.adjustmentAmount/100).toFixed(2),(s.total/100).toFixed(2),s.blockers.join('；')]);
 if(!s.rows.length)rows.push([s.month,s.teacherName,status,s.calculatedAt,'空账期','','','','','','','','','0.00','','','','','0.00','0.00','0.00',s.blockers.join('；')]);
 return csv(rows);
}
