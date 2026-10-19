import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ExcelJS from 'exceljs';
import { transformSync } from 'esbuild';
import { openDatabase } from '../db.ts';
import { seedDemo } from '../seed.ts';
import { StudioService } from '../service.ts';
import { createApp } from '../server.ts';

test('原生页面处理器连接真实HTTP API：建档、课包、排课、点名、资料维护/归档/恢复、邀请核对、机构切换与家长隔离',async()=>{
  const db=await openDatabase();await seedDemo(db);await db.query("INSERT INTO rooms(tenant_id,id,name,capacity) VALUES('studio-demo','ui-room','原生验收画室',10),('studio-demo','ui-series-room','页面周期画室',10)");const service=new StudioService(db);
  const app=await createApp(service);await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const storage=new Map<string,unknown>(),modules=new Map<string,any>();let definition:any;
  let navigated='';
  let pickedFile:{name:string;base64:string}|null=null,downloaded='';
  let dropResponse=false;const requestKeys:string[]=[];
  const wx={
    getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:unknown)=>storage.set(k,structuredClone(v)),removeStorageSync:(k:string)=>storage.delete(k),
    request:(o:any)=>{if(o.header['Idempotency-Key'])requestKeys.push(o.header['Idempotency-Key']);void fetch(o.url.replace('http://127.0.0.1:4310',base),{method:o.method,headers:o.header,body:o.data?JSON.stringify(o.data):undefined}).then(async r=>{const data=await r.json();if(dropResponse&&o.url.endsWith('/commands')){dropResponse=false;o.fail({errMsg:'模拟提交成功但响应丢失'});}else o.success({statusCode:r.status,data});}).catch(o.fail);},
    chooseMessageFile:(o:any)=>o.success({tempFiles:[{name:pickedFile!.name,path:'synthetic-file',size:Buffer.from(pickedFile!.base64,'base64').length}]}),
    getFileSystemManager:()=>({readFile:(o:any)=>o.success({data:pickedFile!.base64})}),
    downloadFile:(o:any)=>{void fetch(o.url.replace('http://127.0.0.1:4310',base),{headers:o.header}).then(async r=>{downloaded=await r.text();o.success({statusCode:r.status,tempFilePath:'synthetic-download'});}).catch(o.fail);},
    shareFileMessage:async()=>{},
    showToast:()=>{},redirectTo:()=>{},switchTab:()=>{},navigateTo:(o:any)=>{navigated=o.url;},pageScrollTo:()=>{},showModal:async()=>({confirm:true}),showActionSheet:async()=>({tapIndex:0}),
  };
  function load(file:string):any{
    file=path.resolve(file);if(modules.has(file))return modules.get(file);
    const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'es2017'}).code;
    const module={exports:{}};const context={module,exports:module.exports,wx,Page:(p:any)=>{definition=p;},App:()=>{},require:(p:string)=>load(path.resolve(path.dirname(file),p+'.ts')),console};
    vm.runInNewContext(code,context,{filename:file});modules.set(file,module.exports);return module.exports;
  }
  function page(name:string){definition=undefined;load(`apps/miniapp/pages/${name}/index.ts`);const instance=definition;instance.data=structuredClone(instance.data);instance.setData=(values:object)=>Object.assign(instance.data,values);return instance;}
  const touch=(data:object)=>({currentTarget:{dataset:data}}),form=(value:object)=>({detail:{value}});
  try{
    const home=page('home');await home.enter(touch({role:'owner'}));assert.equal(home.data.ready,true);
    const students=page('students');await students.onShow();
    await students.add(form({name:'原生页面验收学员',phone:'',note:'合成数据'}));assert.equal(students.data.error,'');
    students.data.studentIndex=students.data.students.findIndex((s:any)=>s.name==='原生页面验收学员');
    const studentId=students.data.students[students.data.studentIndex].id;
    students.data.packageIndex=students.data.packages.findIndex((p:any)=>p.id==='pack-art');
    await students.enroll(form({received:'0'}));assert.equal(students.data.error,'');
    assert.equal(students.data.students.find((s:any)=>s.id===studentId).balance,12000);
    const schedule=page('schedule');await schedule.onShow();
    schedule.data.courseIndex=schedule.data.courses.findIndex((x:any)=>x.id==='course-art');
    schedule.data.teacherIndex=schedule.data.teachers.findIndex((x:any)=>x.id==='owner-demo');
    schedule.data.roomIndex=schedule.data.rooms.findIndex((r:any)=>r.id==='ui-room');
    schedule.data.date=new Date(Date.now()+5*86400000).toISOString().slice(0,10);schedule.data.time='10:00';
    await schedule.save(form({room:'原生验收画室',capacity:'3'}));assert.equal(schedule.data.error,'');
    const created=schedule.data.sessions.find((x:any)=>x.room==='原生验收画室');assert.ok(created);
    const detail=page('lesson');detail.onLoad({id:created.id});await detail.onShow();
    detail.data.studentIndex=detail.data.students.findIndex((s:any)=>s.id===studentId);await detail.book();assert.equal(detail.data.error,'');
    assert.ok(detail.data.bookings.some((b:any)=>b.student_id===studentId));
    detail.onLoad({id:'lesson-current'});await detail.onShow();detail.point(touch({id:'booking-1'}));
    await detail.submitAttendance(form({reason:'小程序处理器验收到课'}));assert.equal(detail.data.error,'');
    let snapshot=await service.snapshot(await service.auth(storage.get('studio-token') as string));
    assert.equal(snapshot.students.find(s=>s.id==='student-1')!.balance,11000);
    detail.point(touch({id:'booking-1'}));detail.data.statusIndex=2;
    await detail.submitAttendance(form({reason:'小程序处理器验收撤销'}));assert.equal(detail.data.error,'');
    snapshot=await service.snapshot(await service.auth(storage.get('studio-token') as string));assert.equal(snapshot.students.find(s=>s.id==='student-1')!.balance,12000);
    detail.openBatch();assert.equal(detail.data.batchCount,3);
    detail.batchStatus({currentTarget:{dataset:{id:'booking-2'}},detail:{value:'1'}});
    await detail.submitBatch(form({reason:'小程序批量点名验收'}));assert.equal(detail.data.error,'');assert.equal(detail.data.batchOpen,false);
    snapshot=await service.snapshot(await service.auth(storage.get('studio-token') as string));
    assert.equal(snapshot.students.find(s=>s.id==='student-1')!.balance,11000);
    assert.equal(snapshot.students.find(s=>s.id==='student-2')!.balance,12000);
    assert.equal(snapshot.students.find(s=>s.id==='student-3')!.balance,11000);
    const api=load('apps/miniapp/utils/api.ts');
    dropResponse=true;await assert.rejects(api.command('student',{name:'响应丢失验收'}));
    await api.command('student',{name:'响应丢失验收'});
    assert.equal(requestKeys.at(-1),requestKeys.at(-2));
    assert.equal((await service.snapshot(await service.auth(storage.get('studio-token') as string))).students.filter(s=>s.name==='响应丢失验收').length,1);
    const classes=page('classes');await classes.onShow();assert.equal(classes.data.owner,true);
    classes.edit(touch({}));classes.members({detail:{value:['student-1','student-2']}});
    classes.data.courseIndex=classes.data.courses.findIndex((c:any)=>c.id==='course-art');
    classes.data.roomIndex=classes.data.rooms.findIndex((r:any)=>r.id==='ui-series-room');
    await classes.save(form({name:'页面周期班',room:'页面周期画室',capacity:'4'}));assert.equal(classes.data.error,'');
    const classId=classes.data.classes.find((c:any)=>c.name==='页面周期班').id;
    const series=page('series');series.onLoad({classId});await series.onShow();
    series.data.startDate=new Date(Date.now()+10*86400000).toISOString().slice(0,10);series.data.endDate=series.data.startDate;
    series.daysChanged({detail:{value:[String(new Date(series.data.startDate+'T00:00:00Z').getUTCDay())]}});
    await series.onShow();assert.equal(series.data.days.filter((d:any)=>d.selected).length,1,'重新展示后星期勾选与草稿保持一致');
    await series.previewSchedule(form({excludeDates:''}));assert.equal(series.data.error,'');assert.equal(series.data.preview.canCommit,true);
    series.invalidate();assert.equal(series.data.preview,null,'改草稿必须移除旧预览');
    await series.previewSchedule(form({excludeDates:''}));await series.commit();assert.equal(series.data.error,'');assert.match(series.data.result,/已安排1节课/);
    snapshot=await service.snapshot(await service.auth(storage.get('studio-token') as string));
    const recurring=snapshot.sessions.find(s=>s.class_id===classId)!;assert.ok(recurring.series_id);assert.equal(recurring.booked,2);
    const manage=page('manage-lesson');manage.onLoad({id:recurring.id});await manage.onShow();manage.data.time='11:00';
    await manage.previewChange(form({reason:'页面改期验收',room:'',capacity:''}));assert.equal(manage.data.error,'');assert.equal(manage.data.preview.canCommit,true);
    await manage.commit();assert.equal(manage.data.error,'');assert.match(manage.data.result,/已调整1节课/);
    await manage.onShow();manage.data.actionIndex=1;
    await manage.previewChange(form({reason:'页面取消验收'}));assert.equal(manage.data.preview.affectedBookings,2);
    await manage.commit();assert.equal(manage.data.error,'');assert.match(manage.data.result,/已取消1节课/);
    detail.onLoad({id:recurring.id});await detail.onShow();assert.equal(detail.data.lesson.status,'cancelled');assert.equal(detail.data.changes.length,2);assert.ok(detail.data.bookings.every((b:any)=>b.state==='cancelled'));
    const choose=page('choose');choose.onLoad({studentId:'student-1',courseId:'course-art'});await choose.onShow();assert.ok(!choose.data.sessions.some((l:any)=>l.id===recurring.id),'已取消课次不能出现在补课选择列表');
    const resource=page('resource');resource.onLoad({kind:'room'});await resource.onShow();
    await resource.save(form({name:'HTTP资源教室',capacity:'4'}));assert.equal(resource.data.error,'');assert.match(resource.data.result,/教室已保存/);
    const roomId=resource.data.id;await resource.onShow();assert.equal(resource.data.version,1);
    await resource.save(form({name:'HTTP更名教室',capacity:'5'}));assert.equal(resource.data.error,'');await resource.onShow();
    await resource.setActive();assert.equal(resource.data.active,false);assert.equal(resource.data.version,3);
    await resource.setActive();assert.equal(resource.data.active,true);
    snapshot=await service.snapshot(await service.auth(storage.get('studio-token') as string));assert.equal(snapshot.rooms.find(r=>r.id===roomId)?.capacity,5);
    resource.onLoad({kind:'student',id:studentId});await resource.onShow();
    await resource.save(form({name:'档案已更新',phone:'13800000000',note:'合成编辑验收'}));assert.equal(resource.data.error,'');await resource.onShow();
    await resource.setActive();await students.onShow();assert.ok(!students.data.enrollable.some((s:any)=>s.id===studentId));assert.ok(students.data.students.some((s:any)=>s.id===studentId&&!s.active));
    await resource.setActive();await students.onShow();assert.ok(students.data.enrollable.some((s:any)=>s.id===studentId));
    resource.onLoad({kind:'course',id:'course-art'});await resource.onShow();
    await resource.save(form({name:'页面新版素描',duration:'75',debit:'1.25'}));assert.equal(resource.data.error,'');await resource.onShow();assert.equal(resource.data.draft.debit,'1.25');
    snapshot=await service.snapshot(await service.auth(storage.get('studio-token') as string));assert.equal(snapshot.sessions.find(l=>l.id===created.id)?.debit,1000);
    const originalGrant=snapshot.grants.find(g=>g.student_id===studentId)!;
    resource.onLoad({kind:'package',id:'pack-art'});await resource.onShow();
    await resource.save(form({name:'页面新版课包',purchased:'2.5',gift:'1',price:'99.5',validDays:'30'}));assert.equal(resource.data.error,'');await resource.onShow();assert.equal(resource.data.version,2);
    snapshot=await service.snapshot(await service.auth(storage.get('studio-token') as string));assert.deepEqual(snapshot.grants.find(g=>g.id===originalGrant.id),originalGrant);
    assert.equal(snapshot.packages.find(p=>p.id==='pack-art')?.price,9950);
    await resource.setActive();await students.onShow();assert.ok(!students.data.packages.some((p:any)=>p.id==='pack-art'));
    await resource.setActive();
    await home.signOut();await home.enter(touch({role:'guardian'}));await students.onShow();
    await classes.onShow();assert.equal(classes.data.owner,false);assert.ok(classes.data.classes.every((c:any)=>c.member_ids.every((id:string)=>['student-1','student-2'].includes(id))));
    assert.equal(students.data.owner,false);assert.equal(students.data.students.length,2);
    assert.ok(!students.data.students.some((s:any)=>s.id===studentId));
    const ledger=page('ledger');await ledger.onShow();assert.ok(ledger.data.entries.every((e:any)=>['student-1','student-2'].includes(e.student_id)));
    await home.signOut();await home.enter(touch({role:'owner'}));
    const members=page('members');await members.onShow();assert.equal(members.data.ready,true);
    members.pick({detail:{value:'1'}});members.studentsChanged({detail:{value:['student-1']}});
    await members.create(form({label:'HTTP页面家长邀请'}));assert.equal(members.data.error,'');
    const inviteToken=members.data.created.inviteToken;assert.match(inviteToken,/^[a-f0-9]{64}$/);
    const account=page('account');await account.onShow();assert.equal(account.data.ready,true);
    await account.signIn(touch({persona:'visitor'}));assert.equal(account.data.memberships.length,0);
    await account.claim(form({token:inviteToken,displayName:'小禾合成家长',relationship:'母亲（合成）'}));assert.equal(account.data.error,'');assert.equal(account.data.claims[0].status,'pending');assert.equal(storage.has('studio-token'),false);
    await home.enter(touch({role:'owner'}));await members.refresh();
    const claimId=members.data.claims[0].id;members.startReview(touch({id:claimId,approve:'yes'}));
    await members.reviewClaim(form({reason:'合成联系人核对测试'}));assert.equal(members.data.error,'');assert.equal(members.data.claims.length,0);
    await account.signIn(touch({persona:'visitor'}));assert.equal(account.data.claims[0].status,'approved');
    await account.select(touch({id:'studio-demo'}));await students.onShow();assert.deepEqual(Array.from(students.data.students,(s:any)=>s.id),['student-1']);
    const oldScoped=storage.get('studio-token') as string;
    await home.enter(touch({role:'owner'}));await members.refresh();
    await members.unlink(touch({id:'dev-visitor',student:'student-1'}));assert.equal(members.data.error,'');await assert.rejects(service.auth(oldScoped));
    dropResponse=true;await members.create(form({label:'响应丢失邀请'}));assert.ok(members.data.error);
    await members.create(form({label:'响应丢失邀请'}));assert.equal(members.data.error,'');assert.equal(members.data.created.tokenAvailable,false);assert.equal(members.data.created.inviteToken,undefined);
    const ownerContext=JSON.stringify(storage.get('studio-context'));
    dropResponse=true;await assert.rejects(api.command('student',{name:'机构幂等范围'}));const lostKey=requestKeys.at(-1);
    await account.onShow();await account.create(form({name:'原生机构切换验收'}));assert.equal(account.data.error,'');assert.notEqual(JSON.stringify(storage.get('studio-context')),ownerContext);
    await api.command('student',{name:'机构幂等范围'});assert.notEqual(requestKeys.at(-1),lostKey);
    await account.select(touch({id:'studio-demo'}));await api.command('student',{name:'机构幂等范围'});assert.equal(requestKeys.at(-1),lostKey);
    assert.equal((await service.snapshot(await service.auth(storage.get('studio-token') as string))).students.filter(s=>s.name==='机构幂等范围').length,1);
    const imports=page('imports');await imports.onShow();assert.equal(imports.data.owner,true);
    imports.sample();await imports.paste();assert.equal(imports.data.error,'');assert.equal(imports.data.mappingFields.filter((f:any)=>f.index>0).length,11);
    await imports.validate();assert.equal(imports.data.error,'');assert.equal(imports.data.batch.status,'ready');assert.equal(imports.data.batch.summary.available,9750);
    dropResponse=true;await imports.commit();assert.ok(imports.data.error);await imports.commit();assert.equal(imports.data.error,'');assert.equal(imports.data.batch.status,'completed');assert.equal(requestKeys.at(-1),requestKeys.at(-2));
    await imports.report();assert.equal(imports.data.error,'');assert.ok(downloaded.includes('已导入'));assert.ok(downloaded.includes('DEMO-GRANT-0927'));assert.ok(downloaded.includes('迁入时剩余付费次数'));assert.match(imports.data.summaryText,/迁入时可用/);
    await imports.back();const workbook=new ExcelJS.Workbook();workbook.addWorksheet('第一张').addRows([['原学员编号','姓名'],['FILE-1','文件选择合成学员']]);workbook.addWorksheet('第二张').addRows([['原学员编号','姓名'],['FILE-2','第二张合成学员']]);
    pickedFile={name:'原生文件选择.xlsx',base64:Buffer.from(await workbook.xlsx.writeBuffer() as any).toString('base64')};await imports.choose();assert.equal(imports.data.error,'');assert.equal(imports.data.batch.sheets.length,2);
    await imports.pick({currentTarget:{dataset:{key:'sheetIndex'}},detail:{value:'1'}});assert.equal(imports.data.config.sheet,'第二张');await imports.pick({currentTarget:{dataset:{key:'kindIndex'}},detail:{value:'0'}});
    await imports.validate();assert.equal(imports.data.error,'');assert.equal(imports.data.batch.status,'ready');await imports.commit();assert.equal(imports.data.batch.status,'completed');
    snapshot=await service.snapshot(await service.auth(storage.get('studio-token') as string));assert.ok(snapshot.students.some(s=>s.name==='第二张合成学员'));assert.ok(!snapshot.students.some(s=>s.name==='文件选择合成学员'));
    await imports.back();imports.data.fileText='原学员编号,姓名\nRESOLVE-1,小禾';await imports.paste();await imports.pick({currentTarget:{dataset:{key:'kindIndex'}},detail:{value:'0'}});await imports.validate();assert.equal(imports.data.batch.status,'invalid');
    imports.resolve(touch({key:'RESOLVE-1',name:'小禾'}));imports.saveTarget();assert.match(imports.data.error,/请先选择/);
    imports.target({detail:{value:String(imports.data.students.findIndex((s:any)=>s.id==='student-1')+2)}});imports.saveTarget();assert.equal(imports.data.dirty,true);await imports.validate();assert.equal(imports.data.batch.status,'ready');assert.equal(imports.data.batch.summary.newStudents,0);await imports.commit();assert.equal(imports.data.batch.status,'completed');
    await home.enter(touch({role:'guardian'}));detail.onLoad({id:'lesson-next'});await detail.onShow();
    await detail.save('leave',{bookingId:'booking-next',expectedRevision:0,expectedLessonVersion:1,reason:'原生家长请假'});assert.equal(detail.data.error,'');assert.equal(detail.data.bookings.find((b:any)=>b.id==='booking-next').pending,true);
    const leaves=page('leaves');leaves.onLoad({});await leaves.onShow();assert.equal(leaves.data.pending,1);const request=leaves.data.rows[0];
    leaves.start(touch({id:request.id,op:'leave_withdraw'}));await leaves.submit(form({reason:'先撤回重新安排'}));assert.equal(leaves.data.error,'');assert.equal(leaves.data.rows[0].status,'withdrawn');
    await detail.save('leave',{bookingId:'booking-next',expectedRevision:0,expectedLessonVersion:1,reason:'重新确认请假'});
    await home.enter(touch({role:'owner'}));await leaves.onShow();assert.equal(leaves.data.role,'owner');leaves.filter(touch({pending:'yes'}));assert.equal(leaves.data.rows.length,1);
    leaves.start(touch({id:leaves.data.rows[0].id,op:'leave_review',approve:'yes'}));dropResponse=true;await leaves.submit(form({reason:'管理员核对通过'}));assert.ok(leaves.data.error);await leaves.submit(form({reason:'管理员核对通过'}));assert.equal(leaves.data.error,'');assert.equal(leaves.data.pending,0);assert.equal(requestKeys.at(-1),requestKeys.at(-2));
    leaves.filter(touch({pending:'no'}));const approved=leaves.data.rows.find((r:any)=>r.status==='approved');assert.ok(approved.makeup_id);assert.match(approved.result,/原课不扣课/);assert.equal(approved.makeupLabel,'补课待安排');leaves.makeup(touch({id:approved.id}));assert.ok(navigated.includes('/pages/choose/index?makeupId='+approved.makeup_id));
    leaves.start(touch({id:approved.id,op:'leave_correct'}));await leaves.submit(form({reason:'核对为原课扣课'}));assert.equal(leaves.data.error,'');assert.equal(leaves.data.rows.find((r:any)=>r.id===approved.id).charge,true);
    leaves.policyToggle();leaves.pick({detail:{value:'1'}});await leaves.savePolicy(form({cutoff:'60',days:'15',reason:'新的机构规则'}));assert.equal(leaves.data.error,'');assert.equal(leaves.data.policy.version,1);
    await home.enter(touch({role:'guardian'}));await leaves.onShow();assert.equal(leaves.data.review,null);assert.equal(leaves.data.policyOpen,false);assert.ok(leaves.data.rows.every((r:any)=>r.student_name==='小禾'));
    await home.enter(touch({role:'teacher'}));await imports.onShow();assert.equal(imports.data.owner,false);assert.equal(imports.data.batch,null);assert.equal(imports.data.rows.length,0);



  }finally{await app.close();await db.close();}
});
