import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '../db.ts';
import { seedDemo } from '../seed.ts';
import { StudioService } from '../service.ts';
import { createApp } from '../server.ts';
import type { Actor } from '../../../packages/contracts/index.ts';
import type { Command } from '../schemas.ts';

const owner: Actor = { tenantId:'studio-demo', userId:'owner-demo', role:'owner', name:'林老师' };
const teacher: Actor = { ...owner, userId:'teacher-demo', role:'teacher' };
const guardian: Actor = { ...owner, userId:'guardian-demo', role:'guardian' };
let db: Database, service: StudioService;
beforeEach(async()=>{db=await openDatabase();await seedDemo(db);await db.query("INSERT INTO rooms(tenant_id,id,name,capacity) SELECT 'studio-demo',name,name,200 FROM unnest($1::text[]) AS name",[["验收画室", "另一个教室", "另一教室"]]);service=new StudioService(db);});
afterEach(async()=>{await db.close();});
const command=(op:Command,input:unknown,actor=owner,key=randomUUID())=>service.command(actor,op,input,key);
const rejects=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(e:any)=>e.code===code);
const balance=async(student='student-1')=>(await service.snapshot(owner)).students.find(s=>s.id===student)!.balance;
const mark=(status='attended',revision=0,bookingId='booking-1')=>({bookingId,expectedRevision:revision,status,reason:'自动验收 · 合成数据'});
const count=async(table:string)=>(await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const future=(days=4)=>new Date(Date.now()+days*86400000).toISOString();
const lesson=(input:Record<string,unknown>={})=>command('lesson',{courseId:'course-art',teacherId:'owner-demo',room:'验收画室',startsAt:future(),capacity:6,...input});

test('到课 12→11，重试不重复扣课；撤销 11→12，流水保留原分摊',async()=>{
  const key=randomUUID();
  const first=await command('attendance',mark(),teacher,key);
  assert.equal(await balance(),11000);
  assert.deepEqual(await command('attendance',mark(),teacher,key),first);
  assert.equal(await balance(),11000);
  await rejects(command('attendance',mark(),teacher),'VERSION_CONFLICT');
  await command('attendance',mark('unmarked',1),teacher);
  assert.equal(await balance(),12000);
  const entries=(await service.snapshot(owner)).ledger.filter(e=>e.student_id==='student-1');
  assert.equal(entries.filter(e=>e.kind==='consume').length,1);
  assert.equal(entries.filter(e=>e.kind==='reversal').length,1);
  assert.equal(await count('attendance_history'),2);
  await command('attendance',mark('attended',2),teacher);
  await command('attendance',mark('absent',3),teacher);
  assert.equal(await balance(),12000);
  await rejects(command('attendance',mark('absent',4),teacher),'NO_CHANGE');
});

test('同一幂等键不能提交不同内容；无效命令和字段被拒绝',async()=>{
  const key=randomUUID();await command('attendance',mark(),owner,key);
  await rejects(command('attendance',mark('absent',1),owner,key),'IDEMPOTENCY_MISMATCH');
  await rejects(command('toString' as Command,{}),'UNKNOWN_COMMAND');
  await rejects(command('student',{name:'新学员',tenantId:'other'}),'VALIDATION');
  await rejects(command('course',{name:'错误课',duration:60,debit:0}),'VALIDATION');
});

test('余额不足时点名、流水、通知和审计整笔回滚',async()=>{
  await db.query("UPDATE lessons SET debit=13000 WHERE id='lesson-current'");
  const before=await Promise.all(['ledger','attendance','attendance_history','outbox','commands','audit_events'].map(count));
  await rejects(command('attendance',mark()),'ENTITLEMENT_INSUFFICIENT');
  assert.deepEqual(await Promise.all(['ledger','attendance','attendance_history','outbox','commands','audit_events'].map(count)),before);
  assert.equal(await balance(),12000);
});

test('未来课程禁止提前点名；过期或其他课程的课包不能扣课',async()=>{
  await rejects(command('attendance',mark('attended',0,'booking-next')),'ATTENDANCE_NOT_OPEN');
  await db.query("UPDATE grants SET expires_at=now()-interval '2 days' WHERE id='grant-1'");
  await rejects(command('attendance',mark()),'ENTITLEMENT_INSUFFICIENT');
  await command('enrollment',{studentId:'student-1',packageId:'pack-water',source:'opening',received:0});
  await rejects(command('attendance',mark()),'ENTITLEMENT_INSUFFICIENT');
  await rejects(command('booking',{sessionId:'lesson-weekend',studentId:'student-1'}),'ENTITLEMENT_INSUFFICIENT');
});

test('按到期时间分摊，撤销返还原课包并保留到期日',async()=>{
  await db.query("UPDATE lessons SET debit=12500 WHERE id='lesson-current'");
  const g=await command('enrollment',{studentId:'student-1',packageId:'pack-art',source:'opening',received:0});
  await db.query("UPDATE grants SET created_at=now()-interval '3 days' WHERE id=$1",[g.id]);
  await command('attendance',mark());
  const debits=(await db.query<{grant_id:string;delta:number}>("SELECT grant_id,delta FROM ledger WHERE kind='consume' ORDER BY delta")).rows;
  assert.deepEqual(debits,[{grant_id:'grant-1',delta:-12000},{grant_id:g.id,delta:-500}]);
  const expiry=(await db.query('SELECT id,expires_at FROM grants ORDER BY id')).rows;
  await command('attendance',mark('unmarked',1));
  assert.deepEqual((await db.query('SELECT id,expires_at FROM grants ORDER BY id')).rows,expiry);
  assert.equal(await balance(),24000);
});

test('老师只能点自己课程，角色以数据库为准，停用会话立即失效',async()=>{
  const b=await command('booking',{sessionId:'lesson-weekend',studentId:'student-2'});
  await rejects(command('attendance',mark('attended',0,b.id),teacher),'FORBIDDEN');
  await rejects(command('student',{name:'伪造管理员'},{...teacher,role:'owner'}),'FORBIDDEN');
  const snapshot=await service.snapshot(teacher);
  assert.ok(snapshot.sessions.every(s=>s.teacher_id===teacher.userId));
  assert.ok(snapshot.students.every(s=>s.phone===''&&s.note===''));
  const token=await service.login('teacher');
  await db.query("UPDATE memberships SET active=false WHERE user_id='teacher-demo'");
  await rejects(service.auth(token),'UNAUTHENTICATED');
  await rejects(command('attendance',mark(),teacher),'FORBIDDEN');
});

test('家长只能读取和预约关联孩子，不能增课或点名',async()=>{
  const s=await service.snapshot(guardian);
  assert.deepEqual(s.students.map(x=>x.id),['student-1','student-2']);
  assert.ok(s.ledger.every(e=>['student-1','student-2'].includes(e.student_id)));
  await rejects(command('booking',{sessionId:'lesson-weekend',studentId:'student-3'},guardian),'FORBIDDEN');
  await rejects(command('cancel',{bookingId:'booking-3'},guardian),'FORBIDDEN');
  await rejects(command('attendance',mark(),guardian),'FORBIDDEN');
  await rejects(command('enrollment',{studentId:'student-1',packageId:'pack-art',source:'opening',received:0},guardian),'FORBIDDEN');
  assert.ok(!(await service.exportLedger(guardian)).includes('小满'));
});

test('租户隔离：相同学员ID也不能引用其他机构课程或导出其记录',async()=>{
  await db.query("INSERT INTO tenants VALUES('other','另一机构')");
  await db.query("INSERT INTO users VALUES('other-owner','另一个老师')");
  await db.query("INSERT INTO memberships(tenant_id,user_id,role,active) VALUES('other','other-owner','owner',true)");
  await db.query("INSERT INTO students(tenant_id,id,name) VALUES('other','student-1','隔离学员')");
  const other={...owner,tenantId:'other',userId:'other-owner'};
  const s=await service.snapshot(other);assert.equal(s.students[0].name,'隔离学员');assert.equal(s.sessions.length,0);
  await rejects(command('booking',{sessionId:'lesson-weekend',studentId:'student-1'},other),'NOT_FOUND');
  await rejects(command('attendance',mark(),other),'NOT_FOUND');
  await rejects(command('student',{name:'非法机构'},{...owner,tenantId:'other'}),'FORBIDDEN');
  assert.ok(!(await service.exportLedger(owner)).includes('隔离学员'));
});

test('100个同时提交的预约抢最后一个名额，只成功一个',async()=>{
  const l=await lesson({capacity:1});
  await db.transaction(async tx=>{
    for(let i=0;i<100;i++){
      await tx.query("INSERT INTO students(tenant_id,id,name) VALUES('studio-demo',$1,$2)",['race-'+i,'并发学员'+i]);
      await tx.query("INSERT INTO grants(tenant_id,id,student_id,course_id,package_name,purchased,gift,source,expires_at) VALUES('studio-demo',$1,$2,'course-art','并发测试课包',1000,0,'opening',now()+interval '30 days')",['race-g-'+i,'race-'+i]);
      await tx.query("INSERT INTO ledger(tenant_id,id,grant_id,student_id,delta,kind,actor_id,reason) VALUES('studio-demo',$1,$2,$3,1000,'opening','owner-demo','并发测试')",['race-e-'+i,'race-g-'+i,'race-'+i]);
    }
  });
  const results=await Promise.allSettled(Array.from({length:100},(_,i)=>command('booking',{sessionId:l.id,studentId:'race-'+i})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.ok(results.filter(x=>x.status==='rejected').every(x=>x.reason.code==='SESSION_FULL'));
  assert.equal((await service.snapshot(owner)).sessions.find(s=>s.id===l.id)!.booked,1);
});

test('重复预约无重复名额；取消后同一学员可以重新预约',async()=>{
  const d={sessionId:'lesson-weekend',studentId:'student-2'},key=randomUUID();
  const b=await command('booking',d,guardian,key);
  assert.deepEqual(await command('booking',d,guardian,key),b);
  await rejects(command('booking',d,guardian),'ALREADY_BOOKED');
  await command('cancel',{bookingId:b.id},guardian);
  assert.equal((await command('booking',d,guardian)).id,b.id);
});

test('老师、教室与学员时间冲突被拦截；首尾相邻允许',async()=>{
  const start=future();const l=await lesson({startsAt:start});
  await rejects(lesson({startsAt:start,room:'另一个教室'}),'RESOURCE_CONFLICT');
  await rejects(lesson({startsAt:start,teacherId:'teacher-demo'}),'RESOURCE_CONFLICT');
  const simultaneous=await lesson({startsAt:start,teacherId:'teacher-demo',room:'另一教室'});
  await command('booking',{sessionId:l.id,studentId:'student-1'});
  await rejects(command('booking',{sessionId:simultaneous.id,studentId:'student-1'}),'RESOURCE_CONFLICT');
  await lesson({startsAt:new Date(new Date(start).getTime()+90*60000).toISOString()});
});

test('改约失败保留原位；有点名历史的预约不能移动历史归属',async()=>{
  const l=await lesson({capacity:1});
  await command('booking',{sessionId:l.id,studentId:'student-3'});
  await rejects(command('reschedule',{bookingId:'booking-next',sessionId:l.id}),'SESSION_FULL');
  assert.equal((await service.snapshot(owner)).bookings.find(b=>b.id==='booking-next')!.session_id,'lesson-next');
  await command('attendance',mark());await command('attendance',mark('unmarked',1));
  await rejects(command('reschedule',{bookingId:'booking-1',sessionId:'lesson-weekend'}),'INVALID_STATE');
});

test('请假不扣课，补课资格取消释放，完成与撤销各只记一次',async()=>{
  const request=await command('leave',{bookingId:'booking-next',expectedRevision:0,expectedLessonVersion:1,reason:'家庭安排'},guardian);
  const approved=await command('leave_review',{id:request.id,expectedVersion:1,approve:true,reason:'核对通过'});const m={id:approved.makeupId};
  assert.equal(await balance(),12000);
  await rejects(command('leave',{bookingId:'booking-next',expectedRevision:0,expectedLessonVersion:1,reason:'再次请假'},guardian),'INVALID_STATE');
  const input={sessionId:'lesson-weekend',studentId:'student-1',makeupId:m.id};
  const b=await command('booking',input,guardian);
  await command('cancel',{bookingId:b.id},guardian);
  assert.equal((await service.snapshot(owner)).makeups[0].state,'available');
  await command('booking',input,guardian);
  const another=await lesson();
  await rejects(command('booking',{...input,sessionId:another.id},guardian),'MAKEUP_ALREADY_USED');
  await db.query("UPDATE lessons SET starts_at=now()-interval '60 minutes',ends_at=now()+interval '30 minutes' WHERE id='lesson-weekend'");
  await command('attendance',mark('attended',0,b.id));
  assert.equal(await balance(),11000);assert.equal((await service.snapshot(owner)).makeups[0].state,'used');
  await command('attendance',mark('unmarked',1,b.id));
  assert.equal(await balance(),12000);assert.equal((await service.snapshot(owner)).makeups[0].state,'reserved');
  await rejects(command('attendance',mark('attended',0,'booking-next')),'INVALID_STATE');
});

test('期初迁入不计收入，实收分开登记；CSV包含全部流水并防公式执行',async()=>{
  const student=await command('student',{name:'=SUM(1,2)'});
  await command('enrollment',{studentId:student.id,packageId:'pack-art',source:'opening',received:0});
  assert.equal((await service.snapshot(owner)).metrics.received,0);
  await rejects(command('enrollment',{studentId:student.id,packageId:'pack-art',source:'opening',received:100}),'VALIDATION');
  await command('enrollment',{studentId:student.id,packageId:'pack-water',source:'receipt',received:96000,method:'cash'});
  assert.equal((await service.snapshot(owner)).metrics.received,96000);
  const csv=await service.exportLedger(owner);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("\"'=SUM(1,2)\""));
  assert.equal(csv.split('\r\n').length,await count('ledger')+1);
});

test('流水和点名历史无法覆盖或删除；通知记录如实标为未配置',async()=>{
  await command('attendance',mark());
  await assert.rejects(db.query("UPDATE ledger SET delta=999 WHERE id='entry-1-opening'"),/append-only/);
  await assert.rejects(db.query('DELETE FROM attendance_history'),/append-only/);
  assert.ok((await db.query<{status:string}>('SELECT status FROM outbox')).rows.every(x=>x.status==='not_configured'));
});

const batch=(items=[{bookingId:'booking-1',expectedRevision:0,status:'attended'},{bookingId:'booking-2',expectedRevision:0,status:'attended'},{bookingId:'booking-3',expectedRevision:0,status:'attended'}])=>({sessionId:'lesson-current',items,reason:'批量点名验收'});

test('全班点名同批支持到课和缺席，响应重试不重复扣课',async()=>{
  const input=batch([{bookingId:'booking-1',expectedRevision:0,status:'attended'},{bookingId:'booking-2',expectedRevision:0,status:'absent'},{bookingId:'booking-3',expectedRevision:0,status:'attended'}]);
  const key=randomUUID();const first=await command('batch_attendance',input,teacher,key);
  assert.equal(first.count,3);assert.deepEqual(await command('batch_attendance',input,teacher,key),first);
  assert.equal(await balance('student-1'),11000);assert.equal(await balance('student-2'),12000);assert.equal(await balance('student-3'),11000);
  assert.equal(await count('attendance_history'),3);assert.equal(await count('outbox'),3);
  await rejects(command('batch_attendance',input,teacher),'INVALID_STATE');
});

test('批量中第二人余额不足，第一人的点名、流水、通知也全部回滚',async()=>{
  await db.query("UPDATE grants SET expires_at=now()-interval '2 days' WHERE id='grant-2'");
  const tables=['ledger','attendance','attendance_history','outbox','audit_events','commands'];
  const before=await Promise.all(tables.map(count));
  await assert.rejects(command('batch_attendance',batch(),teacher),(e:any)=>e.code==='ENTITLEMENT_INSUFFICIENT'&&e.details.row===2&&e.details.studentName==='小予'&&e.message.includes('本批全部未保存'));
  assert.deepEqual(await Promise.all(tables.map(count)),before);
  assert.equal(await balance('student-1'),12000);
  assert.ok((await service.snapshot(owner)).bookings.filter(b=>b.session_id==='lesson-current').every(b=>b.state==='confirmed'&&b.revision===0));
});

test('批量点名拒绝重复、跨课、家长和其他老师，均不留下前序写入',async()=>{
  const repeated=batch();repeated.items[1]={...repeated.items[0]};
  await rejects(command('batch_attendance',repeated),'VALIDATION');
  const cross=batch();cross.items[1].bookingId='booking-next';await rejects(command('batch_attendance',cross,teacher),'INVALID_BATCH');
  assert.equal(await count('attendance'),0);assert.equal(await balance(),12000);
  await rejects(command('batch_attendance',batch(),guardian),'FORBIDDEN');
  await rejects(command('batch_attendance',{...batch(),sessionId:'lesson-weekend'},teacher),'FORBIDDEN');
});

test('批量点名遇到旧版本会完整回滚，可刷新后重试',async()=>{
  await command('attendance',mark('attended',0,'booking-2'));await command('attendance',mark('unmarked',1,'booking-2'));
  const before=await count('ledger');await rejects(command('batch_attendance',batch(),teacher),'VERSION_CONFLICT');
  assert.equal(await count('ledger'),before);assert.equal(await balance(),12000);
  const updated=batch();updated.items[1].expectedRevision=2;await command('batch_attendance',updated,teacher);
  assert.equal(await balance(),11000);assert.equal(await balance('student-2'),11000);
});

test('HTTP会话、幂等请求、来源检查与登出可用',async()=>{
  const app=await createApp(service);await app.listen(0,'127.0.0.1');
  const url=await app.getUrl();
  try{
    assert.equal((await fetch(url+'/api/state')).status,401);
    assert.equal((await fetch(url+'/api/dev-login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://unrelated.example'},body:'{"role":"owner"}'})).status,403);
    const login=await fetch(url+'/api/dev-login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"role":"owner"}'});
    assert.equal(login.status,201);
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const state=await fetch(url+'/api/state',{headers:{Cookie:cookie}});assert.equal(state.status,200);
    const request={method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({operation:'attendance',input:mark()})};
    assert.equal((await fetch(url+'/api/commands',request)).status,201);
    assert.equal((await fetch(url+'/api/commands',request)).status,201);assert.equal(await balance(),11000);
    const exported=await fetch(url+'/api/ledger.csv',{headers:{Cookie:cookie}});assert.equal(exported.status,200);assert.ok((await exported.text()).includes('小禾'));
    await fetch(url+'/api/logout',{method:'POST',headers:{Cookie:cookie}});
    assert.equal((await fetch(url+'/api/state',{headers:{Cookie:cookie}})).status,401);
  }finally{await app.close();}
});

test('落盘数据库关闭重开后仍保留学员、点名和流水',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lesson-studio-'));let disk:Database|undefined;
  try{
    disk=await openDatabase(dir);await seedDemo(disk);const first=new StudioService(disk);
    await first.command(owner,'attendance',mark(),randomUUID());await disk.close();disk=undefined;
    disk=await openDatabase(dir);const s=await new StudioService(disk).snapshot(owner);
    assert.equal(s.students.find(x=>x.id==='student-1')!.balance,11000);
    assert.equal(s.bookings.find(x=>x.id==='booking-1')!.revision,1);
  }finally{if(disk)await disk.close();await rm(dir,{recursive:true,force:true});}
});
