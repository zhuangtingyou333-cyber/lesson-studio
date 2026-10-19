import {afterEach,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase,type Database} from '../db.ts';
import {seedDemo} from '../seed.ts';
import {StudioService} from '../service.ts';
import type {Actor,ScheduleChangeDraft} from '../../../packages/contracts/index.ts';
import type {Command} from '../schemas.ts';

const owner:Actor={tenantId:'studio-demo',userId:'owner-demo',role:'owner',name:'林老师'};
const teacher:Actor={...owner,userId:'teacher-demo',role:'teacher'};
const guardian:Actor={...owner,userId:'guardian-demo',role:'guardian'};
let db:Database,service:StudioService;
beforeEach(async()=>{db=await openDatabase();await seedDemo(db);await db.query("INSERT INTO rooms(tenant_id,id,name,capacity) SELECT 'studio-demo',name,name,200 FROM unnest($1::text[]) AS name",[["变更验收画室", "改期画室", "冲突画室", "新抢占画室"]]);service=new StudioService(db);});
afterEach(async()=>{await db.close();});
const command=(op:Command,input:unknown,actor=owner,key=randomUUID())=>service.command(actor,op,input,key);
const reject=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e.code===code);
const date=(days:number)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const local=(value:string)=>new Date(Date.parse(value)+8*3600000).toISOString().slice(0,10);
const shift=(value:string,days:number)=>new Date(Date.parse(local(value)+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const move=(sessionId='lesson-next',rest:object={}):ScheduleChangeDraft=>({sessionId,scope:'single',action:'reschedule',date:date(7),time:'09:00',reason:'合成验收：调整课程',...rest});
const cancel=(sessionId:string,rest:object={}):ScheduleChangeDraft=>({sessionId,scope:'single',action:'cancel',reason:'合成验收：取消课程',...rest});
const commit=async(change:ScheduleChangeDraft)=>{const p=await service.scheduleChangePreview(owner,change);return command('schedule_change',{change,previewVersion:p.previewVersion});};
const state=()=>service.snapshot(owner);
const counts=async()=>Promise.all(['lessons','bookings','lesson_changes','audit_events','outbox','ledger','commands'].map(async table=>(await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n));
async function series(){
  const c=await command('class_save',{name:'变更验收班',courseId:'course-art',teacherId:'teacher-demo',room:'变更验收画室',capacity:3,studentIds:['student-1','student-3']});
  const schedule={classId:c.id,startDate:date(10),endDate:date(24),time:'10:00',weekdays:[new Date(date(10)+'T00:00:00Z').getUTCDay()],excludeDates:[]};
  const p=await service.schedulePreview(owner,schedule),result=await command('schedule_series',{schedule,previewVersion:p.previewVersion});
  return (await state()).sessions.filter(l=>l.series_id===result.id);
}

test('单节改期保留预约ID与账目，记录前后快照；重试不产生第二次变更',async()=>{
  const before=await state(),change=move('lesson-next',{teacherId:'owner-demo',room:'改期画室',capacity:4});
  const preview=await service.scheduleChangePreview(owner,change);assert.equal(preview.canCommit,true);assert.equal(preview.affectedBookings,1);
  const key=randomUUID(),input={change,previewVersion:preview.previewVersion};
  const r=await command('schedule_change',input,owner,key);assert.deepEqual(await command('schedule_change',input,owner,key),r);
  const after=await state(),l=after.sessions.find(l=>l.id==='lesson-next')!;
  assert.equal(l.starts_at,new Date(date(7)+'T09:00:00+08:00').toISOString());assert.equal(l.version,2);assert.equal(l.teacher_id,'owner-demo');
  assert.deepEqual(after.bookings,before.bookings);assert.deepEqual(after.ledger,before.ledger);
  assert.equal(after.lessonChanges.length,1);assert.equal(after.lessonChanges[0].before_state.startsAt,before.sessions.find(l=>l.id==='lesson-next')!.starts_at);
  assert.equal(after.lessonChanges[0].after_state.startsAt,l.starts_at);
  assert.equal((await service.snapshot(guardian)).lessonChanges.length,1);
  assert.equal((await service.snapshot(teacher)).lessonChanges.length,0,'原老师失去该未来课次的访问权');
  await assert.rejects(db.query('DELETE FROM lesson_changes'),/append-only/);
});

test('未来系列平移可以使用本批释放的旧时段；已完成课程不被改写',async()=>{
  const lessons=await series();
  await db.query("UPDATE lessons SET starts_at=now()-interval '1 hour',ends_at=now()+interval '30 minutes' WHERE id=$1",[lessons[0].id]);
  const booking=(await state()).bookings.find(b=>b.session_id===lessons[0].id)!;
  await command('attendance',{bookingId:booking.id,expectedRevision:0,status:'attended',reason:'合成数据：已完成的历史课'});
  const before=await state();
  const change=move(lessons[1].id,{scope:'future',date:shift(lessons[1].starts_at,7),time:'10:00'});
  const preview=await service.scheduleChangePreview(owner,change);assert.equal(preview.canCommit,true);assert.equal(preview.rows.length,2);
  await command('schedule_change',{change,previewVersion:preview.previewVersion});
  const after=await state();
  assert.deepEqual(after.sessions.find(l=>l.id===lessons[0].id),before.sessions.find(l=>l.id===lessons[0].id));
  assert.equal(after.sessions.find(l=>l.id===lessons[1].id)!.starts_at,lessons[2].starts_at);
  assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.bookings,before.bookings);
  assert.equal(after.lessonChanges.length,2);
});

test('指定范围只处理目标系列的日期；已取消课次明确列为保持不变',async()=>{
  const lessons=await series();
  const middle=local(lessons[1].starts_at);
  const change=cancel(lessons[0].id,{scope:'range',fromDate:middle,toDate:middle});
  await commit(change);
  let s=await state();assert.equal(s.sessions.find(l=>l.id===lessons[1].id)!.status,'cancelled');assert.equal(s.sessions.find(l=>l.id===lessons[0].id)!.status,'scheduled');
  const remaining=cancel(lessons[0].id,{scope:'future'}),preview=await service.scheduleChangePreview(owner,remaining);
  assert.equal(preview.rows.length,2);assert.equal(preview.unchanged.length,1);assert.equal(preview.unchanged[0].id,lessons[1].id);
  await command('schedule_change',{change:remaining,previewVersion:preview.previewVersion});
  s=await state();assert.equal(s.sessions.filter(l=>l.series_id===lessons[0].series_id&&l.status==='cancelled').length,3);
  await reject(service.scheduleChangePreview(owner,cancel('lesson-next',{scope:'future'})),'INVALID_SCOPE');
  await reject(service.scheduleChangePreview(owner,cancel(lessons[0].id,{scope:'range',fromDate:date(200),toDate:date(201)})),'EMPTY_SELECTION');
});

test('改期校验老师、教室、学员冲突、人数上限及课包到期，失败保留原位',async()=>{
  await command('booking',{sessionId:'lesson-next',studentId:'student-3'});
  const newStart=new Date(date(7)+'T09:00:00+08:00').toISOString();
  const other=await command('lesson',{courseId:'course-art',teacherId:'owner-demo',room:'冲突画室',startsAt:newStart,capacity:4});
  await command('booking',{sessionId:other.id,studentId:'student-1'});
  await db.query("UPDATE grants SET expires_at=$1 WHERE id='grant-3'",[newStart]);
  const before=await state(),change=move('lesson-next',{teacherId:'owner-demo',room:'冲突画室',capacity:1});
  const p=await service.scheduleChangePreview(owner,change),errors=p.rows[0].conflicts.join('|');
  for(const text of ['老师','教室','小禾','人数上限','小满'])assert.ok(errors.includes(text),errors);
  await reject(command('schedule_change',{change,previewVersion:p.previewVersion}),'RESOURCE_CONFLICT');
  const after=await state();assert.deepEqual(after.sessions,before.sessions);assert.deepEqual(after.bookings,before.bookings);assert.equal(after.lessonChanges.length,0);
});

test('改期重新检查补课有效期；取消课次释放补课资格与教室，但不删除记录',async()=>{
  const request=await command('leave',{bookingId:'booking-next',expectedRevision:0,expectedLessonVersion:1,reason:'合成请假'},guardian);
  const approved=await command('leave_review',{id:request.id,expectedVersion:1,approve:true,reason:'核对通过'});const makeup={id:approved.makeupId};
  const booked=await command('booking',{sessionId:'lesson-weekend',studentId:'student-1',makeupId:makeup.id},guardian);
  const p=await service.scheduleChangePreview(owner,move('lesson-weekend',{date:date(33)}));
  assert.ok(p.rows[0].conflicts.some(x=>x.includes('补课资格')));
  const before=await state(),change=cancel('lesson-weekend'),preview=await service.scheduleChangePreview(owner,change);
  assert.equal(preview.releasedMakeups,1);await command('schedule_change',{change,previewVersion:preview.previewVersion});
  const after=await state(),lesson=after.sessions.find(l=>l.id==='lesson-weekend')!;
  assert.equal(lesson.status,'cancelled');assert.equal(after.bookings.find(b=>b.id===booked.id)!.state,'cancelled');assert.equal(after.makeups[0].state,'available');
  assert.deepEqual(after.ledger,before.ledger);assert.equal(after.bookings.find(b=>b.id==='booking-next')!.state,'leave');
  await reject(command('booking',{sessionId:lesson.id,studentId:'student-1'},guardian),'LESSON_CANCELLED');
  const replacement=await command('lesson',{courseId:lesson.course_id,teacherId:lesson.teacher_id,room:lesson.room,startsAt:lesson.starts_at,capacity:6});
  await command('booking',{sessionId:replacement.id,studentId:'student-1',makeupId:makeup.id},guardian);
  assert.equal((await state()).makeups[0].state,'reserved');
});

test('已开始或存在点名历史的课程不允许改期取消，即使曾撤销点名',async()=>{
  const started=await service.scheduleChangePreview(owner,cancel('lesson-current'));assert.equal(started.canCommit,false);
  await command('attendance',{bookingId:'booking-1',expectedRevision:0,status:'attended',reason:'合成点名'});
  await command('attendance',{bookingId:'booking-1',expectedRevision:1,status:'unmarked',reason:'合成撤销'});
  await db.query("UPDATE lessons SET starts_at=now()+interval '1 day',ends_at=now()+interval '1 day 90 minutes' WHERE id='lesson-current'");
  const before=await state(),change=cancel('lesson-current'),p=await service.scheduleChangePreview(owner,change);
  assert.ok(p.rows[0].conflicts.some(x=>x.includes('点名历史')));await reject(command('schedule_change',{change,previewVersion:p.previewVersion}),'RESOURCE_CONFLICT');
  assert.deepEqual((await state()).ledger,before.ledger);
});

test('旧预览会因新增预约、课程版本、新冲突或停用老师失效',async()=>{
  const change=move('lesson-next',{time:'11:00'});let p=await service.scheduleChangePreview(owner,change);
  await command('booking',{sessionId:'lesson-next',studentId:'student-2'});
  await reject(command('schedule_change',{change,previewVersion:p.previewVersion}),'PREVIEW_STALE');
  p=await service.scheduleChangePreview(owner,change);
  await commit(move('lesson-next',{time:'08:00'}));
  await reject(command('schedule_change',{change,previewVersion:p.previewVersion}),'PREVIEW_STALE');
  p=await service.scheduleChangePreview(owner,change);
  await command('lesson',{courseId:'course-art',teacherId:'teacher-demo',room:'新抢占画室',startsAt:p.rows[0].after.startsAt,capacity:6});
  await reject(command('schedule_change',{change,previewVersion:p.previewVersion}),'PREVIEW_STALE');
  const available=move('lesson-next',{time:'16:00'});p=await service.scheduleChangePreview(owner,available);
  await db.query("UPDATE memberships SET active=false WHERE user_id='teacher-demo'");
  await reject(command('schedule_change',{change:available,previewVersion:p.previewVersion}),'PREVIEW_STALE');
});

test('同批调课的新课次互相冲突时被拦截，不能只检查旧课表',async()=>{
  const lessons=await series();
  await db.query('UPDATE lessons SET starts_at=$2,ends_at=$3 WHERE id=$1',[lessons[1].id,local(lessons[0].starts_at)+'T13:00:00+08:00',local(lessons[0].starts_at)+'T14:30:00+08:00']);
  const change=move(lessons[0].id,{scope:'future',date:shift(lessons[0].starts_at,1),time:'11:00'});
  const p=await service.scheduleChangePreview(owner,change);assert.ok(p.rows.slice(0,2).every(r=>r.conflicts.some(x=>x.includes('课次之间'))));
  await reject(command('schedule_change',{change,previewVersion:p.previewVersion}),'RESOURCE_CONFLICT');
});

test('批量取消中途出错时课次、预约、历史、消息全回滚；同时提交最多一次成功',async()=>{
  const lessons=await series(),change=cancel(lessons[0].id,{scope:'future'}),p=await service.scheduleChangePreview(owner,change);
  await db.exec(`CREATE FUNCTION fail_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${lessons[1].id}' THEN RAISE EXCEPTION 'injected change failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_change_failure BEFORE UPDATE ON lessons FOR EACH ROW EXECUTE FUNCTION fail_change();`);
  const before=await state(),n=await counts();
  await assert.rejects(command('schedule_change',{change,previewVersion:p.previewVersion}),/injected change failure/);
  assert.deepEqual(await counts(),n);assert.deepEqual((await state()).bookings,before.bookings);assert.deepEqual((await state()).sessions,before.sessions);
  await db.exec('DROP TRIGGER test_change_failure ON lessons; DROP FUNCTION fail_change();');
  const r=await Promise.allSettled([1,2].map(()=>command('schedule_change',{change,previewVersion:p.previewVersion})));
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await state()).lessonChanges.length,3);
});

test('变更预览和提交拒绝跨机构与越权；家长不能读取其他孩子的课程变更历史',async()=>{
  const change=move(),p=await service.scheduleChangePreview(owner,change);
  for(const actor of [teacher,guardian]){await reject(service.scheduleChangePreview(actor,change),'FORBIDDEN');await reject(command('schedule_change',{change,previewVersion:p.previewVersion},actor),'FORBIDDEN');}
  await db.query("INSERT INTO tenants VALUES('other','另一机构')");await db.query("INSERT INTO memberships(tenant_id,user_id,role,active) VALUES('other','owner-demo','owner',true)");
  const other={...owner,tenantId:'other'};
  await reject(service.scheduleChangePreview(other,change),'NOT_FOUND');await reject(command('schedule_change',{change,previewVersion:p.previewVersion},other),'NOT_FOUND');
  await command('booking',{sessionId:'lesson-weekend',studentId:'student-3'});
  await commit(cancel('lesson-weekend'));
  assert.equal((await state()).lessonChanges.length,1);assert.equal((await service.snapshot(guardian)).lessonChanges.length,0);assert.equal((await service.snapshot(other)).lessonChanges.length,0);
});
