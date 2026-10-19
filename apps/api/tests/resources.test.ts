import {afterEach,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {openDatabase,type Database} from '../db.ts';
import {seedDemo} from '../seed.ts';
import {StudioService} from '../service.ts';
import type {Actor,ScheduleChangeDraft} from '../../../packages/contracts/index.ts';
import type {Command} from '../schemas.ts';

const owner:Actor={tenantId:'studio-demo',userId:'owner-demo',role:'owner',name:'林老师'};
const guardian:Actor={...owner,userId:'guardian-demo',role:'guardian'};
const teacher:Actor={...owner,userId:'teacher-demo',role:'teacher'};
let db:Database,service:StudioService;
beforeEach(async()=>{db=await openDatabase();await seedDemo(db);service=new StudioService(db);});
afterEach(async()=>{await db.close();});
const command=(op:Command,input:unknown,a=owner,key=randomUUID())=>service.command(a,op,input,key);
const reject=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e.code===code);
const snapshot=()=>service.snapshot(owner);
const active=(kind:string,id:string,expectedVersion:number,value=false)=>command('resource_active',{kind,id,expectedVersion,active:value});
const future=(days=8)=>new Date(Date.now()+days*86400000).toISOString();
const lesson=(rest:object={})=>({courseId:'course-art',teacherId:'owner-demo',roomId:'room-1',startsAt:future(),capacity:6,...rest});
const course={name:'素描新设置',duration:60,debit:2000,color:'#487969'};
const pack={name:'新版课包',courseId:'course-art',purchased:5000,gift:1000,price:80000,validDays:30};

test('学员编辑同手机号不合并；版本冲突和幂等重试不重复保存',async()=>{
  const a=await command('student',{name:'同名孩子',phone:'13800000000'}),b=await command('student',{name:'同名孩子',phone:'13800000000'});assert.notEqual(a.id,b.id);
  const input={id:a.id,expectedVersion:1,name:'新姓名',phone:'13900000000',note:'新备注'},key=randomUUID();
  const result=await command('student',input,owner,key);assert.deepEqual(await command('student',input,owner,key),result);
  await reject(command('student',input),'VERSION_CONFLICT');
  const s=await snapshot();assert.equal(s.students.find(x=>x.id===a.id)?.version,2);assert.equal(s.students.find(x=>x.id===b.id)?.name,'同名孩子');
  await reject(command('student',{id:a.id,name:'不带版本'}),'VALIDATION');
});

test('归档学员保留账本、家长关联与历史更正；新增开包预约被拒，恢复后可继续',async()=>{
  const before=await snapshot();await active('student','student-1',1);
  await reject(command('enrollment',{studentId:'student-1',packageId:'pack-art',source:'opening',received:0}),'NOT_FOUND');
  await reject(command('booking',{sessionId:'lesson-weekend',studentId:'student-1'},guardian),'NOT_FOUND');
  await command('attendance',{bookingId:'booking-1',expectedRevision:0,status:'attended',reason:'归档后核对已有课程'},teacher);
  await command('attendance',{bookingId:'booking-1',expectedRevision:1,status:'unmarked',reason:'归档后纠正误点'},teacher);
  await command('cancel',{bookingId:'booking-next'},guardian);
  const after=await snapshot();assert.equal(after.students.find(x=>x.id==='student-1')!.balance,before.students[0].balance);
  assert.equal(after.students.find(x=>x.id==='student-1')!.active,false);
  assert.ok((await service.snapshot(guardian)).students.some(s=>s.id==='student-1'&&!s.active));
  assert.equal(after.ledger.length,before.ledger.length+2);
  await active('student','student-1',2,true);await command('booking',{sessionId:'lesson-next',studentId:'student-1'},guardian);
});

test('课程模板编辑只影响新课；归档不影响已有课次的预约与点名',async()=>{
  const before=await snapshot();await command('course',{...course,id:'course-art',expectedVersion:1});
  const created=await command('lesson',lesson());let s=await snapshot();
  assert.equal(s.sessions.find(l=>l.id===created.id)?.debit,2000);
  assert.equal(Date.parse(s.sessions.find(l=>l.id===created.id)!.ends_at)-Date.parse(s.sessions.find(l=>l.id===created.id)!.starts_at),60*60000);
  for(const l of before.sessions){const now=s.sessions.find(x=>x.id===l.id)!;assert.equal(now.debit,l.debit);assert.equal(now.ends_at,l.ends_at);}
  await active('course','course-art',2);
  await reject(command('lesson',lesson({startsAt:future(9)})),'COURSE_ARCHIVED');
  await reject(command('package',pack),'COURSE_ARCHIVED');
  await reject(command('enrollment',{studentId:'student-1',packageId:'pack-art',source:'opening',received:0}),'COURSE_ARCHIVED');
  await command('booking',{sessionId:'lesson-weekend',studentId:'student-1'});
  await command('attendance',{bookingId:'booking-1',expectedRevision:0,status:'attended',reason:'旧课仍扣原来的1次'});
  s=await snapshot();assert.equal(s.students[0].balance,11000);
  await active('course','course-art',3,true);await command('lesson',lesson({startsAt:future(9)}));
});

test('课包修改生成不可变版本；已开通权益、实收和到期保持原快照',async()=>{
  const first=await command('enrollment',{studentId:'student-1',packageId:'pack-art',source:'receipt',received:120000});
  const before=(await db.query('SELECT * FROM grants WHERE id=$1',[first.id])).rows[0];
  await command('package',{...pack,id:'pack-art',expectedVersion:1,courseId:'course-water'});
  const second=await command('enrollment',{studentId:'student-2',packageId:'pack-art',source:'receipt',received:75000});
  assert.deepEqual((await db.query('SELECT * FROM grants WHERE id=$1',[first.id])).rows[0],before);
  const changed=(await db.query<any>('SELECT * FROM grants WHERE id=$1',[second.id])).rows[0];
  assert.equal(changed.course_id,'course-water');assert.equal(changed.purchased,5000);assert.equal(changed.gift,1000);assert.equal(changed.template_version,2);assert.equal(changed.template_snapshot.price,80000);
  assert.equal((await snapshot()).metrics.received,195000);
  await active('package','pack-art',2);await reject(command('enrollment',{studentId:'student-2',packageId:'pack-art',source:'opening',received:0}),'PACKAGE_ARCHIVED');
  await active('package','pack-art',3,true);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::int AS n FROM package_versions WHERE package_id='pack-art'")).rows[0].n,4);
  await assert.rejects(db.query("UPDATE package_versions SET definition='{}'"),/append-only/);
});

test('未知教室不会被隐式创建；固定编号在改名后仍检查同一资源冲突',async()=>{
  await reject(command('lesson',lesson({roomId:'missing'})),'ROOM_NOT_FOUND');
  await reject(command('lesson',{courseId:'course-art',teacherId:'owner-demo',room:'随便填的教室',startsAt:future(),capacity:1}),'ROOM_NOT_FOUND');
  const first=await command('lesson',lesson());
  await command('room',{id:'room-1',expectedVersion:1,name:'更名后的画室',capacity:12});
  await reject(command('lesson',lesson({teacherId:'teacher-demo'})),'RESOURCE_CONFLICT');
  const old=(await snapshot()).sessions.find(l=>l.id===first.id)!;assert.equal(old.room,'一号画室');assert.equal(old.room_id,'room-1');
  const second=await command('lesson',lesson({startsAt:old.ends_at}));assert.ok(second.id,'相邻课程不冲突');
  await reject(command('room',{name:'更名后的画室',capacity:10}),'DUPLICATE_ROOM');
});

test('教室容量在创建、降低与调整课次时校验；不能压低未结束课次容量',async()=>{
  const r=await command('room',{name:'小教室',capacity:2});
  await reject(command('lesson',lesson({roomId:r.id,capacity:3})),'ROOM_CAPACITY');
  await reject(command('class_save',{name:'超额班',courseId:'course-art',teacherId:'owner-demo',roomId:r.id,capacity:3,studentIds:[]}),'ROOM_CAPACITY');
  await reject(command('room',{id:'room-1',expectedVersion:1,name:'一号画室',capacity:5}),'ROOM_IN_USE');
  const change:ScheduleChangeDraft={sessionId:'lesson-next',scope:'single',action:'reschedule',date:future().slice(0,10),time:'10:00',roomId:r.id,reason:'验收换小教室'};
  const preview=await service.scheduleChangePreview(owner,change);assert.equal(preview.canCommit,false);assert.ok(preview.rows[0].conflicts.some(x=>x.includes('教室容量')));
  await reject(command('schedule_change',{change,previewVersion:preview.previewVersion}),'RESOURCE_CONFLICT');
});

test('停用教室拦截新增业务，旧预约可取消点名；可以把旧课转移到可用教室',async()=>{
  const before=await snapshot();await active('room','room-1',1);
  await reject(command('lesson',lesson()),'ROOM_DISABLED');await reject(command('booking',{sessionId:'lesson-next',studentId:'student-3'}),'ROOM_DISABLED');
  await command('attendance',{bookingId:'booking-1',expectedRevision:0,status:'absent',reason:'核对历史出勤'});
  const s=await snapshot();assert.equal(s.sessions.length,before.sessions.length);assert.equal(s.sessions.find(l=>l.id==='lesson-next')?.room_active,false);
  const change:ScheduleChangeDraft={sessionId:'lesson-next',scope:'single',action:'reschedule',date:future().slice(0,10),time:'10:00',roomId:'room-2',reason:'停用后换教室'};
  const p=await service.scheduleChangePreview(owner,change);assert.equal(p.canCommit,true);await command('schedule_change',{change,previewVersion:p.previewVersion});
  await command('booking',{sessionId:'lesson-next',studentId:'student-3'});
  assert.equal((await snapshot()).sessions.find(l=>l.id==='lesson-next')?.room_id,'room-2');
});

test('周期排课与调整提交重查教室状态/版本，旧预览不能绕过停用',async()=>{
  const c=await command('class_save',{name:'资源验证班',courseId:'course-art',teacherId:'owner-demo',roomId:'room-1',capacity:2,studentIds:['student-1']});
  const day=future(10).slice(0,10),schedule={classId:c.id,startDate:day,endDate:day,time:'10:00',weekdays:[new Date(day).getUTCDay()],excludeDates:[]};
  const p=await service.schedulePreview(owner,schedule);
  const change:ScheduleChangeDraft={sessionId:'lesson-next',scope:'single',action:'reschedule',date:day,time:'11:00',reason:'资源状态变化'};
  const changePreview=await service.scheduleChangePreview(owner,change);
  await active('room','room-1',1);
  await reject(command('schedule_series',{schedule,previewVersion:p.previewVersion}),'ROOM_DISABLED');
  await reject(command('schedule_change',{change,previewVersion:changePreview.previewVersion}),'PREVIEW_STALE');
  await active('room','room-1',2,true);
  await reject(command('schedule_series',{schedule,previewVersion:p.previewVersion}),'PREVIEW_STALE');
  await active('course','course-art',1);
  await reject(service.schedulePreview(owner,schedule),'COURSE_ARCHIVED');
});

test('所有资料维护服务端校验机构、角色和版本，老师与家长不能更新',async()=>{
  await db.query("INSERT INTO tenants VALUES('other','另一机构')");await db.query("INSERT INTO memberships(tenant_id,user_id,role,active) VALUES('other','owner-demo','owner',true)");
  for(const [kind,id,input] of [['student','student-1',{name:'新'}],['course','course-art',course],['package','pack-art',pack],['room','room-1',{name:'新教室',capacity:12}]] as const){
    for(const actor of [teacher,guardian]){await reject(command(kind,{...input,id,expectedVersion:1},actor),'FORBIDDEN');await reject(command('resource_active',{kind,id,expectedVersion:1,active:false},actor),'FORBIDDEN');}
    await reject(command(kind,{...input,id,expectedVersion:1},{...owner,tenantId:'other'}),'NOT_FOUND');
  }
  await reject(command('lesson',lesson(),{...owner,tenantId:'other'}),'NOT_FOUND');
  assert.deepEqual((await service.snapshot({...owner,tenantId:'other'})).rooms,[]);
});

test('并发编辑只能一方更新，数据库故障回滚课包版本和审计',async()=>{
  const edits=await Promise.allSettled(['甲','乙'].map(name=>command('student',{id:'student-1',expectedVersion:1,name})));
  assert.equal(edits.filter(x=>x.status==='fulfilled').length,1);
  const before=(await db.query('SELECT * FROM package_versions ORDER BY package_id,version')).rows;
  await db.exec("CREATE FUNCTION reject_resource_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='package' THEN RAISE EXCEPTION 'injected resource failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_resource_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_resource_audit();");
  await assert.rejects(command('package',{...pack,id:'pack-art',expectedVersion:1}),/injected resource failure/);
  assert.deepEqual((await db.query('SELECT * FROM package_versions ORDER BY package_id,version')).rows,before);
  assert.equal((await snapshot()).packages.find(p=>p.id==='pack-art')!.version,1);
});

test('迁移4从原有房间文本建立机构隔离的资源引用，保留历史账目和未知模板来源',async()=>{
  const old=await PGlite.create();
  try{
    await old.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
    await seedDemo({query:(s,v)=>old.query(s,v),exec:s=>old.exec(s),transaction:fn=>old.transaction(fn),close:()=>old.close()});
    for(const file of ['002-classes-schedules.sql','003-lesson-changes.sql'])await old.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
    await old.query("INSERT INTO classes(tenant_id,id,name,course_id,teacher_id,room,capacity) VALUES('studio-demo','old-class','旧班','course-art','teacher-demo','一号画室',9)");
    const ledger=(await old.query('SELECT * FROM ledger ORDER BY seq')).rows,bookings=(await old.query('SELECT * FROM bookings ORDER BY id')).rows;
    await old.exec(await readFile(new URL('../migrations/004-resources.sql',import.meta.url),'utf8'));
    assert.deepEqual((await old.query('SELECT * FROM ledger ORDER BY seq')).rows,ledger);assert.deepEqual((await old.query('SELECT * FROM bookings ORDER BY id')).rows,bookings);
    const rooms=(await old.query<any>("SELECT * FROM rooms WHERE name='一号画室'")).rows;assert.equal(rooms.length,1);assert.equal(rooms[0].capacity,9);
    assert.equal((await old.query<any>("SELECT room_id FROM classes WHERE id='old-class'")).rows[0].room_id,rooms[0].id);
    assert.equal((await old.query<any>("SELECT room_id FROM lessons WHERE id='lesson-next'")).rows[0].room_id,rooms[0].id);
    assert.ok((await old.query<any>('SELECT template_id FROM grants')).rows.every(g=>g.template_id===null));
    assert.equal((await old.query<any>('SELECT * FROM package_versions')).rows.length,2);
  }finally{await old.close();}
});
