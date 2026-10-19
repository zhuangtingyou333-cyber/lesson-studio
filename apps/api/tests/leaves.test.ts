import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase,type Database} from '../db.ts';
import {seedDemo} from '../seed.ts';
import {StudioService} from '../service.ts';
import type {Actor} from '../../../packages/contracts/index.ts';
import type {Command} from '../schemas.ts';
let db:Database,s:StudioService;
const owner:Actor={tenantId:'studio-demo',userId:'owner-demo',role:'owner',name:'林老师'};
const guardian:Actor={...owner,userId:'guardian-demo',role:'guardian'};
const teacher:Actor={...owner,userId:'teacher-demo',role:'teacher'};
beforeEach(async()=>{db=await openDatabase();await seedDemo(db);s=new StudioService(db);});
afterEach(async()=>{await db.close();});
const cmd=(op:Command,input:unknown,a=owner,key=randomUUID())=>s.command(a,op,input,key);
const reject=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e.code===code);
const balance=async()=>(await s.snapshot(owner)).students.find(x=>x.id==='student-1')!.balance;
const mark=(bookingId:string,status='attended',expectedRevision=0)=>cmd('attendance',{bookingId,status,expectedRevision,reason:'合成点名核对'});
const apply=async(bookingId='booking-next',a=guardian)=>{const snap=await s.snapshot(owner),b=snap.bookings.find(b=>b.id===bookingId)!;return cmd('leave',{bookingId,expectedRevision:b.revision,expectedLessonVersion:snap.sessions.find(l=>l.id===b.session_id)!.version,reason:'合成请假'},a);};
const review=(id:string,approve=true,version=1,a=owner,key=randomUUID())=>cmd('leave_review',{id,expectedVersion:version,approve,reason:'合成审批'},a,key);
const policy=(charge:boolean,expectedVersion=0,cutoffMinutes=0)=>cmd('leave_policy',{charge,expectedVersion,cutoffMinutes,validDays:30,reason:'合成机构规则'});
const correct=(id:string,charge:boolean,expectedVersion=2)=>cmd('leave_correct',{id,expectedVersion,charge,reason:'核对原课扣课'});
const startMakeup=()=>db.query("UPDATE lessons SET starts_at=now()-interval '30 minutes',ends_at=now()+interval '60 minutes' WHERE id='lesson-weekend'");
const bookMakeup=(makeupId:string)=>cmd('booking',{sessionId:'lesson-weekend',studentId:'student-1',makeupId},guardian);

test('申请仅占待审批记录；并发提交不重复；通过后释放原位、一次资格和响应重试',async()=>{
 const attempts=await Promise.allSettled([apply(),apply()]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 const r=(attempts.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;
 let snap=await s.snapshot(owner);assert.equal(snap.sessions.find(l=>l.id==='lesson-next')!.booked,1);assert.equal(snap.makeups.length,0);assert.equal(await balance(),12000);
 const key=randomUUID(),approved=await review(r.id,true,1,owner,key);assert.deepEqual(await review(r.id,true,1,owner,key),approved);
 await reject(review(r.id),'VERSION_CONFLICT');snap=await s.snapshot(owner);assert.equal(snap.makeups.length,1);assert.equal(snap.makeups[0].billing_mode,'on_attendance');assert.equal(snap.sessions.find(l=>l.id==='lesson-next')!.booked,0);assert.equal(snap.leaves[0].events.length,2);
 assert.equal(snap.leaves[0].status,'approved');assert.equal(await balance(),12000);
});

test('撤回与驳回保留预约和余额；可以重新提交，旧历史不可覆盖',async()=>{
 const r=await apply();await cmd('leave_withdraw',{id:r.id,expectedVersion:1,reason:'行程恢复'},guardian);await reject(review(r.id),'VERSION_CONFLICT');
 const second=await apply();await review(second.id,false);let snap=await s.snapshot(guardian);assert.equal(snap.makeups.length,0);assert.equal(snap.bookings.find(b=>b.id==='booking-next')!.state,'confirmed');assert.equal(await balance(),12000);assert.equal(snap.leaves.length,2);
 await apply();await assert.rejects(db.query('DELETE FROM leave_events'),/append-only/);
});

test('规则版本冻结、家长截止时间、管理员超时核对；规则历史不能修改',async()=>{
 await policy(false,0,2880);await reject(apply(),'LEAVE_CLOSED');const r=await apply('booking-next',owner);
 await policy(true,1);await review(r.id);const snap=await s.snapshot(owner);assert.equal(snap.leavePolicy.version,2);assert.equal(snap.leaves[0].policy.version,1);assert.equal(snap.leaves[0].charge,false);assert.equal(await balance(),12000);
 await reject(policy(false,1),'VERSION_CONFLICT');await assert.rejects(db.query('DELETE FROM leave_policy_versions'),/append-only/);
 await reject(cmd('leave',{bookingId:'booking-1',expectedRevision:0,expectedLessonVersion:1,reason:'上课后申请'},guardian),'LEAVE_CLOSED');
});

test('点名后更正为免费请假按原课包返还11→12；重复审批不再返还',async()=>{
 await mark('booking-1');assert.equal(await balance(),11000);const expiry=(await db.query('SELECT id,expires_at FROM grants ORDER BY id')).rows;
 const r=await apply('booking-1',owner);await review(r.id);assert.equal(await balance(),12000);await reject(review(r.id),'VERSION_CONFLICT');assert.equal(await balance(),12000);
 assert.deepEqual((await db.query('SELECT id,expires_at FROM grants ORDER BY id')).rows,expiry);
 const history=(await db.query<any>("SELECT status,revision FROM attendance_history WHERE booking_id='booking-1' ORDER BY revision")).rows;assert.deepEqual(history,[{status:'attended',revision:1},{status:'leave',revision:2}]);
 await reject(mark('booking-1','unmarked',2),'INVALID_STATE');
});

test('原课已扣：保留原分摊，补课在课包已到期时仍可预约到课，不再次扣减',async()=>{
 await policy(true);await mark('booking-1');const debits=(await db.query<any>("SELECT id,delta FROM ledger WHERE kind='consume'")).rows;
 const r=await apply('booking-1',owner),approved=await review(r.id);assert.equal(await balance(),11000);assert.deepEqual((await db.query("SELECT id,delta FROM ledger WHERE kind='consume'")).rows,debits);
 // Original grant was valid for the original lesson, expires before the makeup.
 await db.query("UPDATE grants SET expires_at=now()-interval '1 minute' WHERE id='grant-1'");const b=await bookMakeup(approved.makeupId);await startMakeup();await mark(b.id);
 const snap=await s.snapshot(owner);assert.equal(snap.makeups[0].state,'used');assert.equal(snap.makeups[0].billing_mode,'prepaid');assert.equal(snap.ledger.filter(e=>e.student_id==='student-1'&&e.kind==='consume').length,1);
 await reject(correct(r.id,false),'LINKED_MAKEUP_LOCKED');await mark(b.id,'unmarked',1);await reject(correct(r.id,false),'LINKED_MAKEUP_LOCKED');await cmd('cancel',{bookingId:b.id});
 await correct(r.id,false);assert.equal(await balance(),0,'原已过期课包返还不应延长有效期');assert.equal((await db.query<any>("SELECT sum(delta)::int AS n FROM ledger WHERE student_id='student-1'")).rows[0].n,12000);
 assert.equal((await s.snapshot(owner)).leaves[0].events.at(-1)!.action,'corrected');
});

test('原课未扣：补课到课扣一次，反向更正必须先撤销补课点名并取消预约',async()=>{
 const r=await apply(),approved=await review(r.id),b=await bookMakeup(approved.makeupId);await startMakeup();await mark(b.id);assert.equal(await balance(),11000);
 await reject(correct(r.id,true),'LINKED_MAKEUP_LOCKED');await mark(b.id,'unmarked',1);assert.equal(await balance(),12000);await cmd('cancel',{bookingId:b.id});await correct(r.id,true);assert.equal(await balance(),11000);
 await reject(correct(r.id,false),'VERSION_CONFLICT');await correct(r.id,false,3);assert.equal(await balance(),12000);
});

test('审批时扣课不足整笔回滚，后续修复后可重新审批；注入失败不会留下资格或流水',async()=>{
 await policy(true);const r=await apply();await db.query("UPDATE grants SET expires_at=now()-interval '1 minute' WHERE id='grant-1'");await reject(review(r.id),'ENTITLEMENT_INSUFFICIENT');
 assert.equal((await s.snapshot(owner)).leaves[0].status,'pending');assert.equal((await s.snapshot(owner)).makeups.length,0);
 await db.query("UPDATE grants SET expires_at=now()+interval '180 days' WHERE id='grant-1'");
 await db.exec("CREATE FUNCTION fail_leave() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='approved' THEN RAISE EXCEPTION 'synthetic leave failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_leave BEFORE INSERT ON leave_events FOR EACH ROW EXECUTE FUNCTION fail_leave();");
 await assert.rejects(review(r.id),/synthetic leave failure/);assert.equal(await balance(),12000);assert.equal((await s.snapshot(owner)).makeups.length,0);assert.equal((await s.snapshot(owner)).bookings.find(b=>b.id==='booking-next')!.revision,0);
 await db.exec('DROP TRIGGER fail_leave ON leave_events');await review(r.id);assert.equal(await balance(),11000);
});

test('取消、改约和点名令旧申请失效，不能在新预约上误批',async()=>{
 let r=await apply();await cmd('cancel',{bookingId:'booking-next'},guardian);assert.equal((await s.snapshot(owner)).leaves[0].status,'superseded');await reject(review(r.id),'VERSION_CONFLICT');
 await cmd('booking',{sessionId:'lesson-next',studentId:'student-1'},guardian);r=await apply();await cmd('reschedule',{bookingId:'booking-next',sessionId:'lesson-weekend'},guardian);assert.equal((await s.snapshot(owner)).leaves.find(x=>x.id===r.id)!.status,'superseded');await reject(review(r.id),'VERSION_CONFLICT');
 r=await apply('booking-1',owner);await mark('booking-1');assert.equal((await s.snapshot(owner)).leaves.find(x=>x.id===r.id)!.status,'superseded');
});

test('课程调整失效旧申请，直接过期的依据也不能通过审批',async()=>{
 const r=await apply();const change={sessionId:'lesson-next',scope:'single',action:'cancel',reason:'合成取消'};
 const preview=await s.scheduleChangePreview(owner,change);await cmd('schedule_change',{change,previewVersion:preview.previewVersion});assert.equal((await s.snapshot(owner)).leaves[0].status,'superseded');
 const r2=await apply('booking-1',owner);await db.query("UPDATE lessons SET version=version+1 WHERE id='lesson-current'");await reject(review(r2.id),'LEAVE_STALE');await review(r2.id,false);
 await reject(cmd('leave',{bookingId:'booking-1',expectedRevision:0,expectedLessonVersion:1,reason:'旧页面'}),'VERSION_CONFLICT');
});

test('审批角色、申请人撤权、监护人关联、跨机构读取和老师范围均重新校验',async()=>{
 const r=await apply();await reject(review(r.id,true,1,guardian),'FORBIDDEN');await reject(policy(true,0).then(()=>review(r.id,true,1,teacher)),'FORBIDDEN');await reject(apply('booking-3',guardian),'FORBIDDEN');
 await db.query("DELETE FROM guardians WHERE tenant_id='studio-demo' AND student_id='student-1'");assert.equal((await s.snapshot(guardian)).leaves.length,0);await reject(review(r.id),'LEAVE_REQUESTER_REVOKED');await review(r.id,false);
 await db.query("INSERT INTO tenants VALUES('other','别的机构')");await db.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES('other','owner-demo','owner')");await reject(cmd('leave_review',{id:r.id,expectedVersion:2,approve:true,reason:'跨租户'},{...owner,tenantId:'other'}),'NOT_FOUND');assert.equal((await s.snapshot({...owner,tenantId:'other'})).leaves.length,0);
 const b=await cmd('booking',{sessionId:'lesson-weekend',studentId:'student-2'});const own=await apply(b.id,owner);assert.ok(!(await s.snapshot(teacher)).leaves.some(l=>l.id===own.id));
});

test('补课资格校验有效期与次数一致，不允许补课再生成资格或突破原账',async()=>{
 await policy(true);const r=await apply(),approved=await review(r.id);
 await db.query("UPDATE lessons SET debit=2000 WHERE id='lesson-weekend'");await reject(bookMakeup(approved.makeupId),'MAKEUP_UNITS_MISMATCH');await db.query("UPDATE lessons SET debit=1000 WHERE id='lesson-weekend'");
 await db.query("UPDATE makeup_credits SET expires_at=now() WHERE id=$1",[approved.makeupId]);await reject(bookMakeup(approved.makeupId),'MAKEUP_EXPIRED');await db.query("UPDATE makeup_credits SET expires_at=now()+interval '30 days' WHERE id=$1",[approved.makeupId]);
 const b=await bookMakeup(approved.makeupId);await reject(apply(b.id),'INVALID_STATE');
});

test('并发审批与撤回只有一个成功；不同幂等键重试没有重复资格',async()=>{
 const r=await apply();const responses=await Promise.allSettled([review(r.id),review(r.id),cmd('leave_withdraw',{id:r.id,expectedVersion:1,reason:'撤回'},guardian)]);assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);const snap=await s.snapshot(owner);assert.equal(snap.leaves[0].events.length,2);assert.ok(snap.makeups.length<=1);
});


test('已扣原课的补课改期不要求第二份有效课包，但仍检查资格和时间冲突',async()=>{
 await policy(true);const r=await apply(),approved=await review(r.id);await bookMakeup(approved.makeupId);
 await db.query("UPDATE grants SET expires_at=now()-interval '1 minute' WHERE id='grant-1'");
 const date=new Date(Date.now()+5*86400000).toISOString().slice(0,10),change={sessionId:'lesson-weekend',scope:'single',action:'reschedule',date,time:'10:00',reason:'合成补课改期'};
 const p=await s.scheduleChangePreview(owner,change);assert.equal(p.canCommit,true,JSON.stringify(p.rows));await cmd('schedule_change',{change,previewVersion:p.previewVersion});assert.equal((await s.snapshot(owner)).makeups[0].state,'reserved');
});

test('迁移保留旧请假、原补课资格和账目，不伪造审批或追认已扣课',async()=>{
 await db.exec("DROP TABLE leave_events; DROP TABLE leave_requests; DROP TABLE leave_policy_versions; ALTER TABLE makeup_credits DROP COLUMN billing_mode; ALTER TABLE makeup_credits DROP COLUMN covered_units; ALTER TABLE attendance DROP CONSTRAINT attendance_status_check; ALTER TABLE attendance ADD CHECK(status IN ('attended','absent','unmarked')); UPDATE bookings SET state='leave' WHERE id='booking-next'; INSERT INTO makeup_credits VALUES('studio-demo','legacy-makeup','student-1','course-art','booking-next','available',now()+interval '20 days');");
 const before=(await db.query('SELECT * FROM ledger ORDER BY seq')).rows;
 const {readFile}=await import('node:fs/promises');const sql=await readFile(new URL('../migrations/008-leave-review.sql',import.meta.url),'utf8');await db.exec('BEGIN;'+sql+'COMMIT;');
 const snap=await s.snapshot(owner);assert.equal(snap.leaves.length,0);assert.equal(snap.makeups[0].id,'legacy-makeup');assert.equal(snap.makeups[0].covered_units,1000);assert.equal(snap.makeups[0].billing_mode,'on_attendance');assert.deepEqual((await db.query('SELECT * FROM ledger ORDER BY seq')).rows,before);assert.equal(snap.bookings.find(b=>b.id==='booking-next')!.state,'leave');
});
