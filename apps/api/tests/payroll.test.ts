import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase,type Database} from '../db.ts';
import {seedDemo} from '../seed.ts';
import {StudioService} from '../service.ts';
import {parseDelimited} from '../imports/parse.ts';
import {nextPayrollMonth} from '../payroll.ts';
import type {Actor,PayrollDetail,PayrollOverview} from '../../../packages/contracts/index.ts';
import type {Command} from '../schemas.ts';
let db:Database,s:StudioService,current:string,old:string;
const owner:Actor={tenantId:'studio-demo',userId:'owner-demo',role:'owner',name:'林老师'},teacher:Actor={...owner,userId:'teacher-demo',role:'teacher'},guardian:Actor={...owner,userId:'guardian-demo',role:'guardian'};
beforeEach(async()=>{
 db=await openDatabase();await seedDemo(db);s=new StudioService(db);current=new Date(Date.now()+8*3600000).toISOString().slice(0,7);const date=new Date(current+'-15T00:00:00Z');date.setUTCMonth(date.getUTCMonth()-2);old=date.toISOString().slice(0,7);
 await db.query("UPDATE lessons SET starts_at=$1,ends_at=$2 WHERE id='lesson-current'",[old+'-15T01:00:00Z',old+'-15T02:30:00Z']);
 await db.query("UPDATE lessons SET starts_at=starts_at+interval '2 years',ends_at=ends_at+interval '2 years' WHERE id<>'lesson-current'");
 await db.query("UPDATE grants SET created_at=$1,expires_at=now()+interval '10 years'",[old+'-01T00:00:00+08:00']);
});
afterEach(async()=>{await db.close();});
const cmd=(op:Command,input:unknown,a=owner,key=randomUUID())=>s.command(a,op,input,key);
const reject=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e.code===code);
const rule=(over:Record<string,unknown>={})=>cmd('payroll_rule',{teacherId:teacher.userId,courseId:'course-art',expectedVersion:0,effectiveFrom:old+'-01',mode:'student',rate:1250,countAbsent:false,countMakeup:true,reason:'合成课酬规则',...over});
const mark=(id='booking-1',status='attended',expectedRevision=0,key=randomUUID())=>cmd('attendance',{bookingId:id,status,expectedRevision,reason:'合成出勤核对'},owner,key);
const prepare=async()=>{await mark();await mark('booking-2','absent');await mark('booking-3','absent');};
const calc=(month=old,expectedVersion=0,teacherId=teacher.userId)=>cmd('payroll_calculate',{teacherId,month,expectedVersion});
const detail=(id:string,a=owner,page=1)=>s.payroll(a,'detail',id,page) as Promise<PayrollDetail>;
const overview=(a=owner,cursor?:string)=>s.payroll(a,'list','',1,cursor) as Promise<PayrollOverview>;
const freeze=async(id:string,key=randomUUID())=>{const p=await detail(id);return cmd('payroll_freeze',{id,expectedVersion:p.version,fingerprint:p.fingerprint,reason:'逐项审核合成账期'},owner,key);};
async function settled(){await rule();await prepare();const r=await calc();await freeze(r.id);return r.id;}

test('缺规则、漏点名、未结束账期都明确阻止冻结；当前月只能算草稿',async()=>{
 let p=await detail((await calc()).id);assert.equal(p.total,0);assert.ok(p.blockers.some(x=>x.includes('缺少')));assert.ok(p.blockers.some(x=>x.includes('3人')));await reject(freeze(p.id),'PAYROLL_NOT_READY');
 await rule();p=await detail(p.id);assert.equal(p.stale,true);await reject(freeze(p.id),'PAYROLL_STALE');await prepare();await calc(old,p.version);p=await detail(p.id);assert.equal(p.total,1250);assert.equal(p.canFreeze,true);
 const now=await detail((await calc(current)).id);assert.equal(now.canFreeze,false);assert.ok(now.blockers.some(x=>x.includes('尚未结束')));await reject(calc('2099-12'),'PAYROLL_FUTURE');
});

test('按人数与按课次的金额、缺席开关可复算；规则按原课北京时间生效',async()=>{
 await rule({countAbsent:true,rate:1501});await prepare();let p=await detail((await calc()).id);assert.equal(p.total,4503);assert.equal(p.rows[0].eligible,3);
 await rule({expectedVersion:1,mode:'lesson',rate:9901,countAbsent:false});await calc(old,1);p=await detail(p.id);assert.equal(p.total,9901);assert.equal(p.rows[0].eligible,1);
 await rule({expectedVersion:2,effectiveFrom:old+'-16',rate:100});await calc(old,2);p=await detail(p.id);assert.equal(p.rows[0].rule!.version,2);assert.equal(p.total,9901);
});

test('冻结再次校验实时依据；重复命令与同时冻结不重复写入，账单/来源/规则不可覆盖',async()=>{
 await rule();await prepare();const p=await detail((await calc()).id),input={id:p.id,expectedVersion:p.version,fingerprint:p.fingerprint,reason:'复核'};const key=randomUUID(),one=await cmd('payroll_freeze',input,owner,key);assert.deepEqual(await cmd('payroll_freeze',input,owner,key),one);await reject(cmd('payroll_freeze',input),'PAYROLL_FROZEN');
 assert.equal((await db.query('SELECT * FROM payroll_sources')).rows.length,1);await reject(calc(old,2),'PAYROLL_FROZEN');
 for(const q of ['DELETE FROM payroll_periods','UPDATE payroll_sources SET amount=1','DELETE FROM payroll_rules'])await assert.rejects(db.query(q));
 const empty=await detail((await calc(old,0,owner.userId)).id);const results=await Promise.allSettled([freeze(empty.id),freeze(empty.id)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
});

test('冻结前点名变化使旧预览和旧导出失效，重新计算后恢复',async()=>{
 await rule();await prepare();const p=await detail((await calc()).id);await mark('booking-2','attended',1);assert.equal((await detail(p.id)).stale,true);await reject(freeze(p.id),'PAYROLL_STALE');await reject(s.payroll(owner,'report',p.id),'PAYROLL_STALE');
 await calc(old,p.version);assert.equal((await detail(p.id)).total,2500);await freeze(p.id);
});

test('冻结后更正追加负/正差额，冻结金额和规则不变；重试不重复调整',async()=>{
 const id=await settled(),before=await detail(id);await rule({expectedVersion:1,effectiveFrom:nextPayrollMonth(old)+'-01',rate:9999});const key=randomUUID();await mark('booking-1','absent',1,key);await mark('booking-1','absent',1,key);
 let o=await overview();assert.equal(o.pending.length,1);assert.equal(o.pending[0].amount,-1250);assert.equal(o.pending[0].eligibleMonth,current);assert.deepEqual(await detail(id),before);
 await mark('booking-1','attended',2);o=await overview();assert.equal(o.pending.length,2);assert.equal(o.pending[1].amount,1250);assert.equal((await detail((await calc(current)).id)).total,0);
 await assert.rejects(db.query('DELETE FROM payroll_adjustments'));
 await reject(rule({expectedVersion:2,effectiveFrom:old+'-01'}),'PAYROLL_RULE_FROZEN');
});

test('跨月差额按更正月进入后续账期，冻结只核销一次且仍能追溯原月',async t=>{
 await settled();await mark('booking-1','absent',1);const next=nextPayrollMonth(old);assert.equal((await detail((await calc(next)).id)).adjustmentAmount,0,'不能把本月刚发生的更正塞进已过去账期');
 t.mock.timers.enable({apis:['Date'],now:Date.parse(nextPayrollMonth(current)+'-02T00:00:00+08:00')});
 const p=await detail((await calc(current)).id);assert.equal(p.total,-1250);assert.equal(p.rows[0].sourceMonth,old);assert.equal(p.canFreeze,true);await freeze(p.id);assert.equal((await overview()).pending.length,0);
 assert.equal((await db.query('SELECT * FROM payroll_applied_adjustments')).rows.length,1);await assert.rejects(db.query('DELETE FROM payroll_applied_adjustments'));assert.equal((await detail((await calc(nextPayrollMonth(current))).id)).adjustmentAmount,0);
});

test('撤销点名后的差额须完成出勤核对，取消后可结算而不重复计提',async t=>{
 await settled();await mark('booking-1','unmarked',1);t.mock.timers.enable({apis:['Date'],now:Date.parse(nextPayrollMonth(current)+'-02T00:00:00+08:00')});
 let p=await detail((await calc(current)).id);assert.ok(p.blockers.some(x=>x.includes('历史课次')));await reject(freeze(p.id),'PAYROLL_NOT_READY');
 await cmd('cancel',{bookingId:'booking-1'});await calc(current,p.version);p=await detail(p.id);assert.equal(p.total,-1250);assert.equal(p.blockers.length,0);await freeze(p.id);
});

test('请假审批与课酬更正在同一事务；原课扣课不代表仍有授课课酬',async()=>{
 const id=await settled();await cmd('leave_policy',{expectedVersion:0,cutoffMinutes:0,validDays:30,charge:true,reason:'保留原课扣减'});
 const r=await cmd('leave',{bookingId:'booking-1',expectedRevision:1,expectedLessonVersion:1,reason:'核对为请假'});await cmd('leave_review',{id:r.id,expectedVersion:1,approve:true,reason:'合成核对'});
 assert.equal((await overview()).pending[0].amount,-1250);assert.equal((await detail(id)).total,1250);assert.equal((await s.snapshot(owner)).students.find(s=>s.id==='student-1')!.balance,11000);
});

test('计提故障使点名、课时流水和课酬差额全部回滚',async()=>{
 await settled();const before=await s.snapshot(owner);
 await db.exec("CREATE FUNCTION fail_payroll_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic payroll failure'; END $$; CREATE TRIGGER fail_payroll_adjustment BEFORE INSERT ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION fail_payroll_adjustment();");
 await assert.rejects(mark('booking-1','absent',1),/synthetic payroll failure/);const after=await s.snapshot(owner);assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.bookings,before.bookings);assert.equal((await overview()).pending.length,0);
});

test('按课次更正多人时只改变一次应计金额，同批出错不留下中间差额',async()=>{
 await rule({mode:'lesson'});await prepare();await mark('booking-2','attended',1);const id=(await calc()).id;await freeze(id);await mark('booking-1','absent',1);assert.equal((await overview()).pending.length,0);await mark('booking-2','absent',2);assert.equal((await overview()).pending[0].amount,-1250);
});

test('老师只能看自己课酬，家长无入口权限，跨机构及停用成员不可读写导出',async()=>{
 const id=await settled();assert.equal((await detail(id,teacher)).total,1250);await reject(s.payroll(guardian,'list'),'FORBIDDEN');await reject(s.payroll(guardian,'report',id),'FORBIDDEN');await reject(cmd('payroll_calculate',{month:old,teacherId:teacher.userId,expectedVersion:2},teacher),'FORBIDDEN');
 const own=(await calc(old,0,owner.userId)).id;await reject(detail(own,teacher),'FORBIDDEN');assert.ok((await overview(teacher)).periods.every(p=>p.teacherId===teacher.userId));
 await db.query("INSERT INTO tenants VALUES('other','另一机构');");await db.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES('other','owner-demo','owner')");await reject(detail(id,{...owner,tenantId:'other'}),'NOT_FOUND');
 await db.query("UPDATE memberships SET active=false WHERE user_id='teacher-demo'");await reject(s.payroll(teacher,'report',id),'FORBIDDEN');assert.equal((await detail(id)).teacherName,'陈老师');
});

test('分页与全量CSV不漏课次，中文和公式值导出安全，金额可复算',async()=>{
 await rule();await prepare();await db.transaction(async tx=>{for(let i=0;i<55;i++)await tx.query("INSERT INTO lessons(tenant_id,id,course_id,teacher_id,room,room_id,starts_at,ends_at,capacity,debit) VALUES('studio-demo',$1,'course-art','teacher-demo','一号画室','room-1',$2,$3,6,1000)",['report-'+i,old+'-02T01:00:00Z',old+'-02T02:00:00Z']);});
 await db.query("UPDATE users SET name='=SUM(1,2)' WHERE id='teacher-demo'");const id=(await calc()).id,one=await detail(id),two=await detail(id,owner,2);assert.equal(one.totalRows,56);assert.equal(one.rows.length,50);assert.equal(two.rows.length,6);assert.equal(new Set([...one.rows,...two.rows].map(r=>r.key)).size,56);
 const csv=await s.payroll(owner,'report',id) as string;assert.ok(csv.includes("'=SUM(1,2)"));const rows=parseDelimited(csv).sheets[0].rows;assert.equal(rows.length,56);assert.equal(rows.reduce((n,r)=>n+Number(r.cells[13].text)*100,0),1250);await reject(detail(id,owner,3),'VALIDATION');
});

test('列表游标覆盖超过20个账期，停用老师历史保留并可由管理员核对',async()=>{
 for(let i=0;i<25;i++)await calc(`${2020+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`);
 const one=await overview(),two=await overview(owner,one.nextCursor!);assert.equal(one.periods.length,20);assert.equal(two.periods.length,5);assert.equal(new Set([...one.periods,...two.periods].map(p=>p.id)).size,25);assert.equal(two.nextCursor,null);
 await db.query("UPDATE memberships SET active=false WHERE user_id='teacher-demo'");assert.equal((await overview()).teachers.find(t=>t.id===teacher.userId)!.active,false);await freeze(one.periods[0].id);
});

test('规则与命令参数严格校验；同一版本两个编辑只允许一项生效',async()=>{
 for(const changes of [{effectiveFrom:'2026-02-30'},{rate:12.34},{rate:-1},{mode:'hour'}])await reject(rule(changes),'VALIDATION');
 const attempts=await Promise.allSettled([rule(),rule({rate:9900})]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);await reject(calc(old,3),'VERSION_CONFLICT');
});
