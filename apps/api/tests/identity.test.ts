import {beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase,type Database} from '../db.ts';
import {seedDemo} from '../seed.ts';
import {StudioService} from '../service.ts';
import {IdentityService} from '../identity.ts';
import {wechatProvider} from '../wechat-login.ts';
import {createApp} from '../server.ts';
import type {Actor,Principal} from '../../../packages/contracts/index.ts';
import type {Command} from '../schemas.ts';
let db:Database,s:StudioService;
const owner:Actor={tenantId:'studio-demo',userId:'owner-demo',role:'owner',name:'林老师'};
const teacher:Actor={...owner,userId:'teacher-demo',role:'teacher'};
const guardian:Actor={...owner,userId:'guardian-demo',role:'guardian'};
beforeEach(async()=>{db=await openDatabase();await seedDemo(db);s=new StudioService(db);});
afterEach(async()=>{await db.close();});
const reject=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e.code===code);
const cmd=(op:Command,d:unknown,a=owner,key=randomUUID())=>s.command(a,op,d,key);
const invite=(role='guardian',students=['student-1'],key=randomUUID())=>cmd('invite_create',{role,studentIds:students,label:'合成邀请',expiresInHours:24},owner,key);
async function visitor(persona:'visitor'|'visitor2'='visitor'){const r=await s.identity.devVisitor(persona);return s.identity.principal(r.identityToken);}
const claim=(p:Principal,token:string,key=randomUUID())=>s.identity.command(p,'invite_claim',{token,displayName:'合成家长',relationship:'合成身份测试'},key);
const review=(id:string,approve=true)=>cmd('claim_review',{id,expectedVersion:1,approve,reason:'通过测试联系渠道核对（合成）'});
const rows=async(table:string)=>(await db.query<any>('SELECT * FROM '+table)).rows;

test('邀请仅显示一次；命令缓存、审计、列表无原始口令，响应丢失重试不重建',async()=>{
 const key=randomUUID(),i=await invite('guardian',['student-1'],key);assert.match(i.inviteToken,/^[a-f0-9]{64}$/);assert.equal(i.tokenAvailable,true);
 const replay=await invite('guardian',['student-1'],key);assert.equal(replay.id,i.id);assert.equal(replay.inviteToken,undefined);assert.equal(replay.tokenAvailable,false);
 for(const table of ['invitations','commands','audit_events'])assert.ok(!JSON.stringify(await rows(table)).includes(i.inviteToken));
 assert.ok(!JSON.stringify(await s.members(owner)).includes(i.inviteToken));assert.equal((await rows('invitations')).length,1);
 await reject(invite('guardian',['student-2'],key),'IDEMPOTENCY_MISMATCH');
});

test('申请不授予权限；核对后家长只见指定学员；解除立即撤销旧会话',async()=>{
 const p=await visitor(),i=await invite(),c=await claim(p,i.inviteToken);
 await reject(s.identity.select(p,owner.tenantId),'FORBIDDEN');assert.equal((await s.identity.overview(p)).memberships.length,0);
 const overview=JSON.stringify(await s.identity.overview(p));assert.ok(!overview.includes('student-1'));assert.ok(!overview.includes('小禾'));
 await review(c.id);const session=await s.identity.select(p,owner.tenantId),a=await s.auth(session.token),state=await s.snapshot(a);assert.deepEqual(state.students.map(x=>x.id),['student-1']);
 assert.ok(state.ledger.every(x=>x.student_id==='student-1'));await reject(cmd('student',{name:'不能建档'},a),'FORBIDDEN');await reject(s.members(a),'FORBIDDEN');
 await cmd('guardian_unlink',{userId:p.userId,studentId:'student-1',expectedVersion:1,reason:'核对解除'});await reject(s.auth(session.token),'UNAUTHENTICATED');
 assert.equal((await rows('audit_events')).find(e=>e.action==='guardian_unlink').detail.result.studentId,'student-1');
 const next=await s.identity.select(p,owner.tenantId);assert.equal((await s.snapshot(await s.auth(next.token))).students.length,0);
});

test('同一口令并发申请仅一个人成功，重复提交返回原申请且不覆盖姓名',async()=>{
 const a=await visitor(),b=await visitor('visitor2'),i=await invite();
 const r=await Promise.allSettled([claim(a,i.inviteToken),claim(b,i.inviteToken)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await rows('membership_claims')).length,1);
 const saved=(await rows('membership_claims'))[0],winner=saved.user_id===a.userId?a:b;
 assert.equal((await claim(winner,i.inviteToken)).id,saved.id);assert.equal((await rows('audit_events')).filter(e=>e.action==='invite_claim').length,1);
});

test('机构创建幂等、切换不信任前端角色，其他机构学生不可用于邀请',async()=>{
 const p=await visitor(),key=randomUUID(),r=await s.identity.command(p,'institution_create',{name:'独立机构'},key);
 assert.deepEqual(await s.identity.command(p,'institution_create',{name:'独立机构'},key),r);
 const a=await s.auth((await s.identity.select(p,r.tenantId)).token);assert.equal(a.role,'owner');assert.equal((await s.snapshot(a)).students.length,0);
 await reject(invite('guardian',['不存在']),'NOT_FOUND');await reject(cmd('invite_create',{role:'guardian',studentIds:['student-1'],label:'跨机构',expiresInHours:24},a),'NOT_FOUND');
 await reject(s.identity.select(p,owner.tenantId),'FORBIDDEN');await reject(s.identity.command(p,'institution_create',{name:'伪装',role:'owner'},randomUUID()),'VALIDATION');
});

test('到期、撤销、已拒绝与本人邀请均不能扩权；撤销待审申请会拒绝',async()=>{
 const p=await visitor();let i=await invite();await db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1",[i.id]);await reject(claim(p,i.inviteToken),'INVITE_INVALID');
 i=await invite();const c=await claim(p,i.inviteToken);await cmd('invite_revoke',{id:i.id,expectedVersion:2,reason:'撤销合成邀请'});assert.equal((await rows('membership_claims')).find(x=>x.id===c.id).status,'rejected');await reject(review(c.id),'VERSION_CONFLICT');
 i=await invite();const c2=await claim(p,i.inviteToken);await review(c2.id,false);await reject(review(c2.id),'VERSION_CONFLICT');await reject(s.identity.select(p,owner.tenantId),'FORBIDDEN');
 i=await invite();await reject(claim({userId:owner.userId,name:owner.name,tenantId:null},i.inviteToken),'INVITE_SELF');
});

test('老师邀请和家长邀请字段严格隔离，非管理员无法创建，外机构成员不可维护',async()=>{
 await reject(invite('teacher',['student-1']),'VALIDATION');await reject(invite('guardian',[]),'VALIDATION');await reject(invite('guardian',['student-1','student-1']),'VALIDATION');
 await reject(cmd('invite_create',{role:'teacher',studentIds:[],label:'越权'},teacher),'FORBIDDEN');await reject(s.members(guardian),'FORBIDDEN');
 const p=await visitor(),i=await invite('teacher',[]),c=await claim(p,i.inviteToken);await review(c.id);const a=await s.auth((await s.identity.select(p,owner.tenantId)).token);assert.equal(a.role,'teacher');assert.equal((await s.snapshot(a)).students.length,0);
 await reject(cmd('member_active',{userId:p.userId,expectedVersion:1,active:false,reason:'伪装管理'}, {...teacher,role:'owner'}),'FORBIDDEN');
});

test('成员停用后会话失效，恢复不复活旧会话；最后管理员不能停用',async()=>{
 const token=await s.login('teacher');await cmd('member_active',{userId:'teacher-demo',expectedVersion:1,active:false,reason:'停用'});
 await reject(s.auth(token),'UNAUTHENTICATED');await reject(s.login('teacher'),'FORBIDDEN');await reject(s.snapshot(teacher),'FORBIDDEN');
 await cmd('member_active',{userId:'teacher-demo',expectedVersion:2,active:true,reason:'恢复'});await reject(s.auth(token),'UNAUTHENTICATED');assert.equal((await s.auth(await s.login('teacher'))).role,'teacher');
 await reject(cmd('member_active',{userId:'owner-demo',expectedVersion:1,active:false,reason:'不能停最后一人'}),'LAST_OWNER');
});

test('审批重查角色、成员状态、学员归档和有效期；失败不增加关联',async()=>{
 const p:Principal={userId:'teacher-demo',name:'老师',tenantId:null},i=await invite(),c=await claim(p,i.inviteToken);await reject(review(c.id),'ROLE_CONFLICT');
 const v=await visitor(),i2=await invite(),c2=await claim(v,i2.inviteToken);await cmd('resource_active',{kind:'student',id:'student-1',expectedVersion:1,active:false});await reject(review(c2.id),'STUDENT_ARCHIVED');assert.ok(!(await rows('memberships')).some(m=>m.user_id===v.userId));
 await cmd('resource_active',{kind:'student',id:'student-1',expectedVersion:2,active:true});await db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1",[i2.id]);await reject(review(c2.id),'INVITE_INVALID');
 const i3=await invite('teacher',[]),c3=await claim(p,i3.inviteToken);await cmd('member_active',{userId:'teacher-demo',expectedVersion:1,active:false,reason:'停用'});await reject(review(c3.id),'MEMBER_DISABLED');
});

test('停用邀请发起人会撤销其待审邀请，审批和关联的故障整笔回滚',async()=>{
 await db.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES('studio-demo','guardian-demo','owner') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='owner'");
 const p=await visitor(),i=await invite(),c=await claim(p,i.inviteToken);
 await cmd('member_active',{userId:'owner-demo',expectedVersion:1,active:false,reason:'交接后停用'},{...guardian,role:'owner'});
 assert.equal((await rows('membership_claims')).find(x=>x.id===c.id).status,'rejected');assert.equal((await rows('invitations')).find(x=>x.id===i.id).state,'revoked');
 await cmd('member_active',{userId:'owner-demo',expectedVersion:2,active:true,reason:'恢复'},{...guardian,role:'owner'});
 const i2=await invite(),c2=await claim(p,i2.inviteToken);
 await db.exec("CREATE FUNCTION fail_identity_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='claim_review' THEN RAISE EXCEPTION 'simulated audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_identity_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_identity_audit();");
 await assert.rejects(review(c2.id));assert.ok(!(await rows('memberships')).some(m=>m.user_id===p.userId));assert.ok(!(await rows('guardians')).some(m=>m.user_id===p.userId));assert.equal((await rows('membership_claims')).find(x=>x.id===c2.id).status,'pending');
});

test('老师可见学员的其他课程课包和流水不泄露，累计余额只计算可见课程',async()=>{
 await cmd('enrollment',{studentId:'student-1',packageId:'pack-water',source:'opening',received:0});
 const full=await s.snapshot(owner),narrow=await s.snapshot(teacher);assert.equal(full.students.find(x=>x.id==='student-1')!.balance,20000);assert.equal(narrow.students.find(x=>x.id==='student-1')!.balance,12000);
 assert.ok(narrow.grants.every(g=>g.course_id==='course-art'));assert.ok(narrow.ledger.every(e=>e.course_id==='course-art'));assert.equal(narrow.ledger.filter(e=>e.student_id==='student-1')[0].balance_after,12000);
 assert.ok(narrow.students.every(x=>x.phone===''&&x.note===''));assert.ok(!(await s.exportLedger(teacher)).includes('水彩'));assert.equal(narrow.metrics.received,0);
});

test('微信提供方只用后端固定地址，丢弃密钥和供应方错误细节',async()=>{
 let called:URL|undefined;
 const provider=wechatProvider('wx1234567890abcdef','secret-not-for-client',async(url,options)=>{called=new URL(String(url));assert.equal(options?.redirect,'error');return Response.json({openid:'opaque-openid',session_key:'secret-session'});});
 assert.deepEqual(await provider.exchange('short-lived-code'),{openId:'opaque-openid'});assert.equal(called!.origin,'https://api.weixin.qq.com');assert.equal(called!.searchParams.get('js_code'),'short-lived-code');
 const broken=wechatProvider('wx1234567890abcdef','secret-not-for-client',async()=>{throw new Error('secret-not-for-client');});await assert.rejects(broken.exchange('code'),(e:any)=>e.code==='WECHAT_LOGIN_FAILED'&&!e.message.includes('secret'));
});

test('微信身份映射稳定、登录码不可复用、默认无权限，演示关闭后不能选角色登录',async()=>{
 const identity=new IdentityService(db,{appId:'wx1234567890abcdef',exchange:async()=>({openId:'opaque-openid'})},false),service=new StudioService(db,identity);
 const a=await identity.wechatLogin({code:'once'}),b=await identity.wechatLogin({code:'twice'});assert.equal(a.userId,b.userId);assert.notEqual(a.identityToken,b.identityToken);assert.ok(!JSON.stringify(a).includes('opaque-openid'));
 await reject(identity.wechatLogin({code:'once'}),'LOGIN_CODE_USED');await reject(identity.wechatLogin({code:'other',role:'owner'}),'VALIDATION');
 const p=await identity.principal(a.identityToken);assert.equal(p.tenantId,null);assert.equal((await identity.overview(p)).memberships.length,0);await reject(service.auth(a.identityToken),'UNAUTHENTICATED');
 await reject(service.login('owner'),'NOT_FOUND');await reject(identity.devVisitor('visitor'),'NOT_FOUND');await reject(s.identity.wechatLogin({code:'code'}),'AUTH_NOT_CONFIGURED');
 const app=await createApp(service);await app.listen(0,'127.0.0.1');try{const base=await app.getUrl(),r=await fetch(base+'/api/dev-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'owner'})});assert.equal(r.status,404);assert.equal((await (await fetch(base+'/api/auth/options')).json()).demoLogin,false);}finally{await app.close();}
});

test('迁移5保留已有登录和课时数据，并允许无机构的身份会话',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const {readFile}=await import('node:fs/promises');const old=await PGlite.create();
 try{
  for(const file of ['schema.sql','migrations/002-classes-schedules.sql','migrations/003-lesson-changes.sql','migrations/004-resources.sql'])await old.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
  const adapter:Database={query:(sql,v)=>old.query(sql,v),exec:sql=>old.exec(sql),transaction:fn=>old.transaction(fn),close:()=>old.close()};await seedDemo(adapter);
  const service=new StudioService(adapter),token=await service.login('owner'),before=(await old.query('SELECT id,delta FROM ledger ORDER BY id')).rows;
  await old.exec(await readFile(new URL('../migrations/005-identity.sql',import.meta.url),'utf8'));
  assert.equal((await service.auth(token)).role,'owner');assert.deepEqual((await old.query('SELECT id,delta FROM ledger ORDER BY id')).rows,before);
  const global=await service.identity.issue('owner-demo',null);assert.equal((await service.identity.principal(global)).tenantId,null);assert.equal((await service.members(owner)).members.length,3);
 }finally{await old.close();}
});
