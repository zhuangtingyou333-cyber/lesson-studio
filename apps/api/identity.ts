import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Actor,IdentityOverview,MembersOverview,Principal} from '../../packages/contracts/index.ts';
import type {Database,Sql} from './db.ts';
import {ensure,DomainError} from './errors.ts';
import type {WechatIdentityProvider} from './wechat-login.ts';
type Row=Record<string,any>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const first=async(tx:Sql,sql:string,args:unknown[])=>(await tx.query<Row>(sql,args)).rows[0];
const iso=(v:string|Date)=>new Date(v).toISOString();
const reason=z.string().trim().min(1).max(300);
const identitySchemas={
  institution_create:z.object({name:z.string().trim().min(1).max(80)}).strict(),
  invite_claim:z.object({token:z.string().trim().regex(/^[a-f0-9]{64}$/),displayName:z.string().trim().min(1).max(80),relationship:reason}).strict(),
};

export class IdentityService {
  constructor(public db:Database,public provider?:WechatIdentityProvider,public demoEnabled=true){}
  async principal(token:string):Promise<Principal>{
    const p=await first(this.db,`SELECT s.user_id,u.name,s.tenant_id FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND (s.tenant_id IS NULL OR EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=s.tenant_id AND m.user_id=s.user_id AND m.active))`,[hash(token)]);
    ensure(p,'UNAUTHENTICATED','登录已失效，请重新登录',401);return {userId:p.user_id,name:p.name,tenantId:p.tenant_id};
  }
  async issue(userId:string,tenantId:string|null,tx:Sql=this.db){
    const token=randomBytes(32).toString('hex');
    await tx.query("INSERT INTO auth_sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",[hash(token),userId,tenantId]);return token;
  }
  async devVisitor(persona:'visitor'|'visitor2'){
    ensure(this.demoEnabled,'NOT_FOUND','接口不可用',404);
    const userId='dev-'+persona,name=persona==='visitor'?'新成员体验甲':'新成员体验乙';
    await this.db.query('INSERT INTO users(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[userId,name]);
    return {identityToken:await this.issue(userId,null),userId,name};
  }
  async wechatLogin(raw:unknown){
    ensure(this.provider,'AUTH_NOT_CONFIGURED','正式微信登录尚未配置',503);
    const body=z.object({code:z.string().min(1).max(512)}).strict().safeParse(raw);
    ensure(body.success,'VALIDATION','需要有效的微信登录凭证');
    const {code}=body.data,provider=this.provider;
    const known=await first(this.db,'SELECT 1 FROM login_codes WHERE app_id=$1 AND code_hash=$2',[provider.appId,hash(code)]);
    ensure(!known,'LOGIN_CODE_USED','登录凭证已使用，请重新登录',409);
    const proof=await provider.exchange(code);
    ensure(typeof proof.openId==='string'&&proof.openId.length>0&&proof.openId.length<=128,'WECHAT_LOGIN_FAILED','微信身份无效',502);
    return this.db.transaction(async tx=>{
      const used=await tx.query('INSERT INTO login_codes(app_id,code_hash) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING code_hash',[provider.appId,hash(code)]);
      ensure(used.rows.length,'LOGIN_CODE_USED','登录凭证已使用，请重新登录',409);
      const userId='wx-'+hash(JSON.stringify([provider.appId,proof.openId]));
      await tx.query("INSERT INTO users(id,name) VALUES($1,'微信用户') ON CONFLICT(id) DO NOTHING",[userId]);
      await tx.query("INSERT INTO external_identities(provider,app_id,subject,user_id) VALUES('wechat',$1,$2,$3) ON CONFLICT DO NOTHING",[provider.appId,proof.openId,userId]);
      return {identityToken:await this.issue(userId,null,tx),userId,name:'微信用户'};
    });
  }
  async overview(p:Principal):Promise<IdentityOverview>{
    const memberships=(await this.db.query<any>('SELECT m.tenant_id,t.name AS tenant_name,m.role,m.active,m.version FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 ORDER BY t.name,t.id',[p.userId])).rows;
    const claims=(await this.db.query<any>(`SELECT c.id,c.status,c.display_name,c.relationship,c.decision_reason,t.name AS tenant_name,i.role,i.expires_at
      FROM membership_claims c JOIN tenants t ON t.id=c.tenant_id JOIN invitations i ON(i.tenant_id=c.tenant_id AND i.id=c.invitation_id) WHERE c.user_id=$1 ORDER BY c.created_at DESC,c.id`,[p.userId])).rows.map(c=>({...c,expires_at:iso(c.expires_at)}));
    return {user:{id:p.userId,name:p.name},memberships,claims,capabilities:{wechatLogin:!!this.provider,demoLogin:this.demoEnabled}};
  }
  async select(p:Principal,tenantId:string){
    return this.db.transaction(async tx=>{
      ensure(await first(tx,'SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenantId]),'FORBIDDEN','无法进入该机构',403);
      const m=await first(tx,'SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active',[tenantId,p.userId]);
      ensure(m,'FORBIDDEN','尚未加入机构或成员资格已停用',403);
      return {token:await this.issue(p.userId,tenantId,tx),context:{userId:p.userId,tenantId},role:m.role};
    });
  }
  async command(p:Principal,op:string,raw:unknown,key:string){
    ensure(key&&key.length>=8&&key.length<=120,'IDEMPOTENCY_REQUIRED','缺少有效操作编号');
    ensure(Object.hasOwn(identitySchemas,op),'UNKNOWN_COMMAND','不支持此操作',404);
    const parsed=identitySchemas[op as keyof typeof identitySchemas].safeParse(raw);
    if(!parsed.success)throw new DomainError('VALIDATION',parsed.error.issues[0].message,400);
    const d=parsed.data as Row,bodyHash=hash(JSON.stringify({op,d}));
    return this.db.transaction(async tx=>{
      await tx.query('INSERT INTO identity_guards(user_id) VALUES($1) ON CONFLICT DO NOTHING',[p.userId]);
      await tx.query('SELECT user_id FROM identity_guards WHERE user_id=$1 FOR UPDATE',[p.userId]);
      const saved=await first(tx,'SELECT hash,result FROM identity_commands WHERE user_id=$1 AND key=$2',[p.userId,key]);
      if(saved){ensure(saved.hash===bodyHash,'IDEMPOTENCY_MISMATCH','操作编号已用于其他内容',409);return saved.result;}
      let result:Row;
      if(op==='institution_create'){
        const id=randomUUID();await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[id,d.name]);
        await tx.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[id,p.userId]);
        await tx.query("INSERT INTO audit_events(id,tenant_id,actor_id,action,subject,detail) VALUES($1,$2,$3,'institution_create',$2,$4)",[randomUUID(),id,p.userId,JSON.stringify({name:d.name})]);
        result={id,tenantId:id,name:d.name};
      }else{
        const invite=await first(tx,'SELECT tenant_id,id FROM invitations WHERE token_hash=$1',[hash(d.token)]);
        ensure(invite,'INVITE_INVALID','邀请无效或已失效',404);
        await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[invite.tenant_id]);
        const current=await first(tx,'SELECT * FROM invitations WHERE tenant_id=$1 AND id=$2',[invite.tenant_id,invite.id]);
        ensure(current.state!=='revoked'&&new Date(current.expires_at).getTime()>Date.now(),'INVITE_INVALID','邀请无效或已失效',409);
        const previous=await first(tx,'SELECT * FROM membership_claims WHERE tenant_id=$1 AND invitation_id=$2',[invite.tenant_id,invite.id]);
        if(previous){ensure(previous.user_id===p.userId,'INVITE_USED','邀请已被使用，请联系管理员',409);result={id:previous.id,status:previous.status};}
        else{
          ensure(current.created_by!==p.userId,'INVITE_SELF','不能申请自己创建的邀请');
          const id=randomUUID();await tx.query('INSERT INTO membership_claims(tenant_id,id,invitation_id,user_id,display_name,relationship) VALUES($1,$2,$3,$4,$5,$6)',[invite.tenant_id,id,invite.id,p.userId,d.displayName,d.relationship]);
          await tx.query("UPDATE invitations SET state='claimed',version=version+1 WHERE tenant_id=$1 AND id=$2",[invite.tenant_id,invite.id]);
          await tx.query("INSERT INTO audit_events(id,tenant_id,actor_id,action,subject,detail) VALUES($1,$2,$3,'invite_claim',$4,$5)",[randomUUID(),invite.tenant_id,p.userId,id,JSON.stringify({invitationId:invite.id,status:'pending'})]);
          result={id,status:'pending'};
        }
      }
      await tx.query('INSERT INTO identity_commands(user_id,key,hash,result) VALUES($1,$2,$3,$4)',[p.userId,key,bodyHash,JSON.stringify(result)]);return result;
    });
  }
}

export async function identityMutation(tx:Sql,a:Actor,op:string,d:Row){
  ensure(a.role==='owner','FORBIDDEN','只有管理员可以管理成员',403);const t=a.tenantId;
  if(op==='invite_create'){
    const students=(await tx.query<Row>('SELECT id FROM students WHERE tenant_id=$1 AND id=ANY($2::text[]) AND active',[t,d.studentIds])).rows;
    ensure(students.length===d.studentIds.length,'NOT_FOUND','指定学员不存在或已归档',404);
    const id=randomUUID(),inviteToken=randomBytes(32).toString('hex');
    const expiresAt=new Date(Date.now()+d.expiresInHours*3600000).toISOString();
    await tx.query('INSERT INTO invitations(tenant_id,id,role,token_hash,label,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[t,id,d.role,hash(inviteToken),d.label,expiresAt,a.userId]);
    for(const studentId of d.studentIds)await tx.query('INSERT INTO invitation_students VALUES($1,$2,$3)',[t,id,studentId]);
    return {id,inviteToken,expiresAt,tokenAvailable:true};
  }
  if(op==='invite_revoke'){
    const invite=await first(tx,'SELECT * FROM invitations WHERE tenant_id=$1 AND id=$2',[t,d.id]);
    ensure(invite,'NOT_FOUND','邀请不存在',404);ensure(invite.version===d.expectedVersion,'VERSION_CONFLICT','邀请状态已变化，请刷新',409);
    ensure(invite.state!=='revoked','NO_CHANGE','邀请已经撤销',409);
    await tx.query("UPDATE invitations SET state='revoked',version=version+1 WHERE tenant_id=$1 AND id=$2",[t,d.id]);
    await tx.query("UPDATE membership_claims SET status='rejected',version=version+1,decided_by=$3,decision_reason=$4 WHERE tenant_id=$1 AND invitation_id=$2 AND status='pending'",[t,d.id,a.userId,d.reason]);
    return {id:d.id,state:'revoked',reason:d.reason};
  }
  if(op==='claim_review'){
    const claim=await first(tx,`SELECT c.*,i.role,i.state AS invite_state,i.expires_at,i.created_by FROM membership_claims c JOIN invitations i ON(i.tenant_id=c.tenant_id AND i.id=c.invitation_id) WHERE c.tenant_id=$1 AND c.id=$2`,[t,d.id]);
    ensure(claim,'NOT_FOUND','申请不存在',404);ensure(claim.version===d.expectedVersion&&claim.status==='pending','VERSION_CONFLICT','申请已处理，请刷新',409);
    if(d.approve){
      ensure(claim.invite_state==='claimed'&&new Date(claim.expires_at).getTime()>Date.now(),'INVITE_INVALID','邀请已失效，请重新邀请',409);
      ensure(await first(tx,"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role='owner' AND active",[t,claim.created_by]),'INVITE_INVALID','邀请发起人已失去管理资格',409);
      const m=await first(tx,'SELECT * FROM memberships WHERE tenant_id=$1 AND user_id=$2',[t,claim.user_id]);
      ensure(!m||m.active,'MEMBER_DISABLED','该成员已停用，请先核对并恢复成员',409);
      ensure(!m||m.role===claim.role,'ROLE_CONFLICT','该账号在本机构已有不同身份，不能用邀请覆盖',409);
      if(!m)await tx.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[t,claim.user_id,claim.role]);
      else await tx.query('UPDATE memberships SET version=version+1 WHERE tenant_id=$1 AND user_id=$2',[t,claim.user_id]);
      const students=(await tx.query<Row>('SELECT s.id,s.active FROM invitation_students i JOIN students s ON(s.tenant_id=i.tenant_id AND s.id=i.student_id) WHERE i.tenant_id=$1 AND i.invitation_id=$2',[t,claim.invitation_id])).rows;
      ensure(students.every(s=>s.active),'STUDENT_ARCHIVED','关联学员已归档，请恢复后重新核对',409);
      for(const student of students)await tx.query('INSERT INTO guardians(tenant_id,student_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[t,student.id,claim.user_id]);
      await tx.query('DELETE FROM auth_sessions WHERE tenant_id=$1 AND user_id=$2',[t,claim.user_id]);
    }
    await tx.query('UPDATE membership_claims SET status=$3,version=version+1,decided_by=$4,decision_reason=$5 WHERE tenant_id=$1 AND id=$2',[t,d.id,d.approve?'approved':'rejected',a.userId,d.reason]);
    return {id:d.id,status:d.approve?'approved':'rejected'};
  }
  const m=await first(tx,'SELECT * FROM memberships WHERE tenant_id=$1 AND user_id=$2',[t,d.userId]);
  ensure(m,'NOT_FOUND','成员不存在',404);ensure(m.version===d.expectedVersion,'VERSION_CONFLICT','成员资料已变化，请刷新',409);
  if(op==='member_active'){
    ensure(m.active!==d.active,'NO_CHANGE','成员已经是此状态',409);
    if(!d.active&&m.role==='owner'){
      const n=await first(tx,"SELECT count(*)::int AS n FROM memberships WHERE tenant_id=$1 AND role='owner' AND active",[t]);
      ensure(n.n>1,'LAST_OWNER','至少保留一名有效管理员',409);
    }
    await tx.query('UPDATE memberships SET active=$3,version=version+1 WHERE tenant_id=$1 AND user_id=$2',[t,d.userId,d.active]);
    if(!d.active){
      const pending=(await tx.query<Row>("UPDATE invitations SET state='revoked',version=version+1 WHERE tenant_id=$1 AND created_by=$2 AND state<>'revoked' RETURNING id",[t,d.userId])).rows;
      await tx.query("UPDATE membership_claims SET status='rejected',version=version+1,decided_by=$3,decision_reason=$4 WHERE tenant_id=$1 AND invitation_id=ANY($2::text[]) AND status='pending'",[t,pending.map(x=>x.id),a.userId,'邀请发起人被停用']);
    }
  }else{
    ensure(op==='guardian_unlink','UNKNOWN_COMMAND','不支持此操作',404);
    ensure(m.role==='guardian','ROLE_CONFLICT','只有家长成员具有学员关联',409);
    const removed=await tx.query('DELETE FROM guardians WHERE tenant_id=$1 AND user_id=$2 AND student_id=$3 RETURNING student_id',[t,d.userId,d.studentId]);
    ensure(removed.rows.length,'NOT_FOUND','关联不存在',404);
    await tx.query('UPDATE memberships SET version=version+1 WHERE tenant_id=$1 AND user_id=$2',[t,d.userId]);
  }
  await tx.query('DELETE FROM auth_sessions WHERE tenant_id=$1 AND user_id=$2',[t,d.userId]);
  return {id:d.userId,version:m.version+1,reason:d.reason,...(op==='guardian_unlink'?{studentId:d.studentId}:{active:d.active})};
}

export async function membersOverview(tx:Sql,a:Actor):Promise<MembersOverview>{
  ensure(a.role==='owner','FORBIDDEN','只有管理员可以查看成员管理',403);const t=a.tenantId;
  const members=(await tx.query<any>(`SELECT m.user_id,u.name,m.role,m.active,m.version,
    COALESCE((SELECT c.display_name FROM membership_claims c WHERE c.tenant_id=m.tenant_id AND c.user_id=m.user_id AND c.status='approved' ORDER BY c.created_at DESC,c.id LIMIT 1),u.name) AS display_name,
    (SELECT count(*)::int FROM lessons l WHERE l.tenant_id=m.tenant_id AND l.teacher_id=m.user_id AND l.status='scheduled' AND l.ends_at>now()) AS upcoming,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) ORDER BY s.id) FROM guardians g JOIN students s ON(s.tenant_id=g.tenant_id AND s.id=g.student_id) WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id),'[]'::jsonb) AS students
    FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.role,u.name,m.user_id`,[t])).rows;
  const invitations=(await tx.query<any>(`SELECT i.id,i.role,i.label,i.state,i.version,i.expires_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) ORDER BY s.id) FROM invitation_students x JOIN students s ON(s.tenant_id=x.tenant_id AND s.id=x.student_id) WHERE x.tenant_id=i.tenant_id AND x.invitation_id=i.id),'[]'::jsonb) AS students
    FROM invitations i WHERE i.tenant_id=$1 ORDER BY i.created_at DESC,i.id`,[t])).rows.map(i=>({...i,expires_at:iso(i.expires_at),expired:new Date(i.expires_at).getTime()<=Date.now()}));
  const claims=(await tx.query<any>('SELECT id,invitation_id,user_id,display_name,relationship,status,version,decision_reason FROM membership_claims WHERE tenant_id=$1 ORDER BY created_at DESC,id',[t])).rows;
  return {members,invitations,claims};
}
