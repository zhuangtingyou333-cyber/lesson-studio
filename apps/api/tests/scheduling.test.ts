import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { openDatabase, type Database } from '../db.ts';
import { seedDemo } from '../seed.ts';
import { StudioService } from '../service.ts';
import { occurrences } from '../scheduling.ts';
import { scheduleSchema, type Command } from '../schemas.ts';
import type { Actor, ScheduleDraft } from '../../../packages/contracts/index.ts';

const owner:Actor={tenantId:'studio-demo',userId:'owner-demo',role:'owner',name:'林老师'};
const teacher:Actor={...owner,userId:'teacher-demo',role:'teacher'};
const guardian:Actor={...owner,userId:'guardian-demo',role:'guardian'};
let db:Database,service:StudioService;
beforeEach(async()=>{db=await openDatabase();await seedDemo(db);await db.query("INSERT INTO rooms(tenant_id,id,name,capacity) SELECT 'studio-demo',name,name,200 FROM unnest($1::text[]) AS name",[["班级验收画室", "其他画室", "老师占用画室", "抢占老师"]]);service=new StudioService(db);});
afterEach(async()=>{await db.close();});
const command=(op:Command,input:unknown,actor=owner,key=randomUUID())=>service.command(actor,op,input,key);
const reject=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e.code===code);
const config={name:'周末素描班',courseId:'course-art',teacherId:'teacher-demo',room:'班级验收画室',capacity:3,studentIds:['student-1','student-3']};
const date=(days:number)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const draft=(classId:string):ScheduleDraft=>({classId,startDate:date(7),endDate:date(21),time:'10:00',weekdays:[new Date(date(7)+'T00:00:00Z').getUTCDay()],excludeDates:[]});
const counts=async()=>Promise.all(['lessons','bookings','schedule_series','audit_events','outbox','ledger','commands'].map(async table=>(await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n));

test('周期日期按北京时间跨月、跨年、闰日生成；排除日与批次上限不静默忽略',()=>{
  const raw={classId:'class',startDate:'2028-02-28',endDate:'2028-03-01',time:'23:30',weekdays:[0,1,2,3,4,5,6],excludeDates:['2028-02-29']};
  const rows=occurrences(raw,90);
  assert.deepEqual(rows.map(r=>r.date),['2028-02-28','2028-03-01']);
  assert.equal(rows[0].startsAt,'2028-02-28T15:30:00.000Z');
  assert.equal(rows[0].endsAt,'2028-02-28T17:00:00.000Z');
  assert.deepEqual(occurrences({...raw,startDate:'2028-12-31',endDate:'2029-01-01',excludeDates:[]},60).map(r=>r.date),['2028-12-31','2029-01-01']);
  assert.throws(()=>occurrences({...raw,excludeDates:['2028-03-02']},60),/排除日期/);
  assert.throws(()=>occurrences({...raw,endDate:'2028-05-31',excludeDates:[]},60),/最多60/);
  assert.throws(()=>occurrences({...raw,endDate:'2030-01-01'},60),/最多366/);
  assert.equal(scheduleSchema.safeParse({...raw,startDate:'2027-02-29'}).success,false);
  assert.equal(scheduleSchema.safeParse({...raw,weekdays:[1,1]}).success,false);
});

test('班级权限、人数、版本与名单隔离；归档可恢复且旧版本不能覆盖',async()=>{
  await reject(command('class_save',config,teacher),'FORBIDDEN');
  await reject(command('class_save',config,guardian),'FORBIDDEN');
  await reject(command('class_save',{...config,capacity:1}),'CLASS_FULL');
  await reject(command('class_save',{...config,studentIds:['missing']}),'NOT_FOUND');
  const c=await command('class_save',config);
  assert.deepEqual((await service.snapshot(teacher)).classes[0].member_ids,['student-1','student-3']);
  assert.deepEqual((await service.snapshot(guardian)).classes[0].member_ids,['student-1']);
  await command('class_save',{...config,id:c.id,expectedVersion:1,studentIds:['student-2']});
  await reject(command('class_save',{...config,id:c.id,expectedVersion:1}),'VERSION_CONFLICT');
  await command('class_active',{classId:c.id,expectedVersion:2,active:false});
  await reject(service.schedulePreview(owner,draft(c.id)),'INVALID_STATE');
  await command('class_active',{classId:c.id,expectedVersion:3,active:true});
  assert.equal((await service.snapshot(owner)).classes[0].version,4);
});

test('周期排课预览、整批建课和预约、幂等重试；名单变化不改历史',async()=>{
  const c=await command('class_save',config),input=draft(c.id);
  const before=await counts(),preview=await service.schedulePreview(owner,input);
  assert.equal(preview.canCommit,true);assert.equal(preview.occurrences.length,3);
  assert.deepEqual(await counts(),before,'预览不能写入业务数据');
  const key=randomUUID(),body={schedule:input,previewVersion:preview.previewVersion};
  const result=await command('schedule_series',body,owner,key);
  assert.equal(result.count,3);assert.equal(result.bookingCount,6);
  assert.deepEqual(await command('schedule_series',body,owner,key),result);
  const state=await service.snapshot(owner);
  assert.equal(state.sessions.filter(s=>s.series_id===result.id).length,3);
  assert.ok(state.students.every(s=>s.balance===12000),'排课预约不扣课');
  await command('class_save',{...config,id:c.id,expectedVersion:1,studentIds:['student-2']});
  const booked=(await service.snapshot(owner)).bookings.filter(b=>result.sessionIds.includes(b.session_id));
  assert.equal(booked.length,6);assert.ok(booked.every(b=>['student-1','student-3'].includes(b.student_id)));
  await reject(command('class_save',{...config,id:c.id,expectedVersion:2,courseId:'course-water'}),'CLASS_HAS_LESSONS');
  await command('class_active',{classId:c.id,expectedVersion:2,active:false});
  assert.equal((await service.snapshot(owner)).sessions.filter(s=>s.series_id===result.id).length,3);
});

test('老师、教室、学员冲突和课包到期逐节展示；任何冲突都不落部分课程',async()=>{
  const c=await command('class_save',config),input=draft(c.id);
  const clean=await service.schedulePreview(owner,input),middle=clean.occurrences[1].startsAt;
  const l=await command('lesson',{courseId:'course-art',teacherId:'owner-demo',room:config.room,startsAt:middle,capacity:3});
  await command('booking',{sessionId:l.id,studentId:'student-1'});
  await db.query("UPDATE grants SET expires_at=$1 WHERE id='grant-3'",[clean.occurrences[2].startsAt]);
  const preview=await service.schedulePreview(owner,input);
  assert.equal(preview.canCommit,false);assert.deepEqual(preview.occurrences[0].conflicts,[]);
  assert.ok(preview.occurrences[1].conflicts.some(c=>c.includes('教室')));
  assert.ok(preview.occurrences[1].conflicts.some(c=>c.includes('小禾')));
  assert.ok(preview.occurrences[2].conflicts.some(c=>c.includes('小满')));
  const before=await counts();await reject(command('schedule_series',{schedule:input,previewVersion:preview.previewVersion}),'RESOURCE_CONFLICT');
  assert.deepEqual(await counts(),before);
  const teacherClass=await command('class_save',{...config,room:'其他画室',studentIds:['student-2']});
  const teacherDraft={...input,classId:teacherClass.id};
  await command('lesson',{courseId:'course-art',teacherId:'teacher-demo',room:'老师占用画室',startsAt:clean.occurrences[0].startsAt,capacity:3});
  assert.ok((await service.schedulePreview(owner,teacherDraft)).occurrences[0].conflicts.some(c=>c.includes('老师')));
});

test('提交重新检查：新增冲突、名单变化、额度变化和请求篡改使旧预览失效',async()=>{
  const c=await command('class_save',config),input=draft(c.id);
  let preview=await service.schedulePreview(owner,input);
  await command('class_save',{...config,id:c.id,expectedVersion:1,studentIds:['student-2']});
  await reject(command('schedule_series',{schedule:input,previewVersion:preview.previewVersion}),'PREVIEW_STALE');
  preview=await service.schedulePreview(owner,input);
  await command('enrollment',{studentId:'student-2',packageId:'pack-art',source:'opening',received:0});
  await reject(command('schedule_series',{schedule:input,previewVersion:preview.previewVersion}),'PREVIEW_STALE');
  preview=await service.schedulePreview(owner,input);
  await reject(command('schedule_series',{schedule:{...input,time:'11:00'},previewVersion:preview.previewVersion}),'PREVIEW_STALE');
  await command('lesson',{courseId:'course-art',teacherId:'teacher-demo',room:'抢占老师',startsAt:preview.occurrences[1].startsAt,capacity:3});
  const before=await counts();await reject(command('schedule_series',{schedule:input,previewVersion:preview.previewVersion}),'PREVIEW_STALE');
  assert.deepEqual(await counts(),before);
});

test('周期提交中途数据库错误整批回滚；两个并发系列最多一个成功',async()=>{
  const c=await command('class_save',config),input=draft(c.id),preview=await service.schedulePreview(owner,input);
  await db.exec(`CREATE FUNCTION fail_schedule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.starts_at='${preview.occurrences[1].startsAt}'::timestamptz THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_schedule_failure BEFORE INSERT ON lessons FOR EACH ROW EXECUTE FUNCTION fail_schedule();`);
  const before=await counts();
  await assert.rejects(command('schedule_series',{schedule:input,previewVersion:preview.previewVersion}),/injected failure/);
  assert.deepEqual(await counts(),before);
  await db.exec('DROP TRIGGER test_schedule_failure ON lessons; DROP FUNCTION fail_schedule();');
  const outcomes=await Promise.allSettled([1,2].map(()=>command('schedule_series',{schedule:input,previewVersion:preview.previewVersion})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await service.snapshot(owner)).sessions.filter(s=>s.class_id===c.id).length,3);
});

test('排课的机构、身份及停用成员在预览和提交端均校验',async()=>{
  const c=await command('class_save',config),input=draft(c.id),preview=await service.schedulePreview(owner,input);
  await reject(service.schedulePreview(teacher,input),'FORBIDDEN');
  await reject(service.schedulePreview(guardian,input),'FORBIDDEN');
  await reject(command('schedule_series',{schedule:input,previewVersion:preview.previewVersion},guardian),'FORBIDDEN');
  await db.query("INSERT INTO tenants VALUES('other','别的机构')");
  await db.query("INSERT INTO memberships(tenant_id,user_id,role,active) VALUES('other','owner-demo','owner',true)");
  const other={...owner,tenantId:'other'};
  await reject(service.schedulePreview(other,input),'NOT_FOUND');
  await reject(command('class_save',{...config,id:c.id,expectedVersion:1},other),'NOT_FOUND');
  assert.deepEqual((await service.snapshot(other)).classes,[]);
  await db.query("UPDATE memberships SET active=false WHERE user_id='teacher-demo'");
  await reject(service.schedulePreview(owner,input),'NOT_FOUND');
  await reject(command('schedule_series',{schedule:input,previewVersion:preview.previewVersion}),'NOT_FOUND');
});

test('迁移2可以应用在已有v1数据上，保留原账与预约',async()=>{
  // Exercise the real additive SQL against the old schema, not an empty v2 schema.
  const old=await PGlite.create();
  try{
    await old.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
    await seedDemo({query:(s,v)=>old.query(s,v),exec:s=>old.exec(s),transaction:fn=>old.transaction(fn),close:()=>old.close()});
    const before=await old.query('SELECT * FROM ledger ORDER BY seq');
    await old.exec(await readFile(new URL('../migrations/002-classes-schedules.sql',import.meta.url),'utf8'));
    assert.deepEqual((await old.query('SELECT * FROM ledger ORDER BY seq')).rows,before.rows);
    assert.equal((await old.query<{n:number}>('SELECT count(*)::int AS n FROM bookings')).rows[0].n,4);
    assert.equal((await old.query<{n:number}>('SELECT count(*)::int AS n FROM classes')).rows[0].n,0);
  }finally{await old.close();}
});
