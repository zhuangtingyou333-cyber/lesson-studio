import {randomUUID} from 'node:crypto';
import type {Actor,LeavePolicy,LeaveRequest} from '../../packages/contracts/index.ts';
import type {Sql} from './db.ts';
import {ensure} from './errors.ts';
import {recordAttendance,settleCharge} from './accounting.ts';
type Row=Record<string,any>;
const first=async(tx:Sql,q:string,v:unknown[])=>(await tx.query<Row>(q,v)).rows[0];
const iso=(v:string)=>new Date(v).toISOString();
export async function leavePolicy(tx:Sql,t:string):Promise<LeavePolicy>{
 const p=await first(tx,'SELECT version,cutoff_minutes,valid_days,charge FROM leave_policy_versions WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1',[t]);
 return p?{version:p.version,cutoffMinutes:p.cutoff_minutes,validDays:p.valid_days,charge:p.charge}:{version:0,cutoffMinutes:0,validDays:30,charge:false};
}
async function booking(tx:Sql,a:Actor,id:string){
 const b=await first(tx,`SELECT b.*,l.course_id,l.starts_at,l.ends_at,l.debit,l.version AS lesson_version,l.status AS lesson_status,COALESCE(x.revision,0) AS revision
 FROM bookings b JOIN lessons l ON(l.tenant_id=b.tenant_id AND l.id=b.session_id) LEFT JOIN attendance x ON(x.tenant_id=b.tenant_id AND x.booking_id=b.id) WHERE b.tenant_id=$1 AND b.id=$2`,[a.tenantId,id]);
 ensure(b,'NOT_FOUND','预约不存在',404);
 if(a.role==='guardian')ensure(await first(tx,'SELECT 1 FROM guardians WHERE tenant_id=$1 AND student_id=$2 AND user_id=$3',[a.tenantId,b.student_id,a.userId]),'FORBIDDEN','只能操作已关联学员',403);
 return b;
}
const basis=(b:Row)=>({sessionId:b.session_id,lessonVersion:b.lesson_version,startsAt:iso(b.starts_at),endsAt:iso(b.ends_at),debit:b.debit,state:b.state,revision:b.revision});
async function event(tx:Sql,a:Actor,r:Row,action:string,reason:string,charge:boolean|null=null){
 await tx.query('INSERT INTO leave_events(tenant_id,id,request_id,version,action,reason,charge,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[a.tenantId,randomUUID(),r.id,r.version,action,reason,charge,a.userId]);
 await tx.query('INSERT INTO outbox(id,tenant_id,event,payload) VALUES($1,$2,$3,$4)',[randomUUID(),a.tenantId,'leave.'+action,JSON.stringify({requestId:r.id,bookingId:r.booking_id,version:r.version})]);
}
export async function invalidateLeaves(tx:Sql,a:Actor,bookingIds:string[],reason:string){
 if(!bookingIds.length)return;
 const rows=(await tx.query<Row>("UPDATE leave_requests SET status='superseded',version=version+1,decision_reason=$3,reviewed_by=$4,reviewed_at=now() WHERE tenant_id=$1 AND booking_id=ANY($2::text[]) AND status='pending' RETURNING *",[a.tenantId,bookingIds,reason,a.userId])).rows;
 for(const r of rows)await event(tx,a,r,'superseded',reason);
}
export async function leaveMutation(tx:Sql,a:Actor,op:string,d:Row){
 const t=a.tenantId;
 if(op==='leave_policy'){
  const old=await leavePolicy(tx,t);ensure(old.version===d.expectedVersion,'VERSION_CONFLICT','请假规则已更新，请刷新',409);
  const version=old.version+1;
  await tx.query('INSERT INTO leave_policy_versions(tenant_id,version,cutoff_minutes,valid_days,charge,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[t,version,d.cutoffMinutes,d.validDays,d.charge,d.reason,a.userId]);
  return {id:t,version};
 }
 if(op==='leave'){
  const b=await booking(tx,a,d.bookingId);
  ensure(['confirmed','attended','absent'].includes(b.state)&&!b.makeup_id&&b.lesson_status==='scheduled','INVALID_STATE','此预约不能再申请请假',409);
  ensure(b.revision===d.expectedRevision&&b.lesson_version===d.expectedLessonVersion,'VERSION_CONFLICT','课程或点名记录已变化，请刷新后重新申请',409);
  const p=await leavePolicy(tx,t);
  if(a.role==='guardian')ensure(b.state==='confirmed'&&Date.parse(b.starts_at)-Date.now()>p.cutoffMinutes*60000,'LEAVE_CLOSED','已超过家长请假截止时间，请联系管理员核对');
  ensure(!await first(tx,'SELECT 1 FROM makeup_credits WHERE tenant_id=$1 AND origin_booking=$2',[t,b.id]),'INVALID_STATE','原课已有补课资格，请从请假记录更正',409);
  ensure(!await first(tx,"SELECT 1 FROM leave_requests WHERE tenant_id=$1 AND booking_id=$2 AND status='pending'",[t,b.id]),'LEAVE_PENDING','已有待审批申请，请先处理或撤回',409);
  const r={id:randomUUID(),booking_id:b.id,version:1};
  await tx.query("INSERT INTO leave_requests(tenant_id,id,booking_id,requester_id,reason,status,policy,basis) VALUES($1,$2,$3,$4,$5,'pending',$6,$7)",[t,r.id,b.id,a.userId,d.reason,JSON.stringify(p),JSON.stringify(basis(b))]);
  await event(tx,a,r,'pending',d.reason);return {id:r.id,version:1,status:'pending'};
 }
 const r=await first(tx,'SELECT * FROM leave_requests WHERE tenant_id=$1 AND id=$2',[t,d.id]);ensure(r,'NOT_FOUND','请假申请不存在',404);
 const b=await booking(tx,a,r.booking_id);
 ensure(r.version===d.expectedVersion,'VERSION_CONFLICT','申请已处理，请刷新后核对',409);
 if(op==='leave_correct'){
  ensure(r.status==='approved'&&b.state==='leave','INVALID_STATE','仅能更正已通过的请假',409);
  ensure(r.charge!==d.charge,'NO_CHANGE','当前扣课方式未变化',409);
  const m=await first(tx,'SELECT * FROM makeup_credits WHERE tenant_id=$1 AND origin_booking=$2',[t,b.id]);
  ensure(m&&m.state==='available','LINKED_MAKEUP_LOCKED','补课已预约或完成。请先更正补课点名并取消补课预约，再更正原课，历史会保留',409);
  ensure(!await first(tx,"SELECT 1 FROM bookings WHERE tenant_id=$1 AND makeup_id=$2 AND state IN ('confirmed','attended','absent')",[t,m.id]),'LINKED_MAKEUP_LOCKED','请先处理关联补课预约',409);
  await settleCharge(tx,a,b,d.charge,b.revision+1,d.reason);await recordAttendance(tx,a,b.id,b.revision+1,'leave',d.reason);
  await tx.query('UPDATE makeup_credits SET billing_mode=$3 WHERE tenant_id=$1 AND id=$2',[t,m.id,d.charge?'prepaid':'on_attendance']);
  await tx.query('UPDATE leave_requests SET charge=$3,version=version+1,decision_reason=$4,reviewed_by=$5,reviewed_at=now() WHERE tenant_id=$1 AND id=$2',[t,r.id,d.charge,d.reason,a.userId]);
  await event(tx,a,{...r,version:r.version+1},'corrected',d.reason,d.charge);return {id:r.id,version:r.version+1,status:r.status,makeupId:m.id};
 }
 ensure(r.status==='pending','INVALID_STATE','此申请已处理',409);
 if(op==='leave_withdraw')ensure(a.role==='owner'||r.requester_id===a.userId,'FORBIDDEN','只能撤回自己提交的申请',403);
 let makeupId:string|undefined;
 if(op==='leave_review'&&d.approve){
  const current=basis(b);ensure(b.lesson_status==='scheduled'&&Object.keys(current).every(k=>current[k as keyof typeof current]===r.basis[k]),'LEAVE_STALE','课程或预约已变化，请撤回后重新申请',409);
  const member=await first(tx,'SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active',[t,r.requester_id]);
  ensure(member&&(member.role==='owner'||member.role==='guardian'&&await first(tx,'SELECT 1 FROM guardians WHERE tenant_id=$1 AND user_id=$2 AND student_id=$3',[t,r.requester_id,b.student_id])),'LEAVE_REQUESTER_REVOKED','申请人的关联或权限已失效，请驳回后由管理员重新办理',409);
  await settleCharge(tx,a,b,r.policy.charge,b.revision+1,d.reason);await recordAttendance(tx,a,b.id,b.revision+1,'leave',d.reason);
  await tx.query("UPDATE bookings SET state='leave' WHERE tenant_id=$1 AND id=$2",[t,b.id]);
  makeupId=randomUUID();
  await tx.query("INSERT INTO makeup_credits(tenant_id,id,student_id,course_id,origin_booking,state,expires_at,billing_mode,covered_units) VALUES($1,$2,$3,$4,$5,'available',GREATEST(now(),$6::timestamptz)+$7*interval '1 day',$8,$9)",[t,makeupId,b.student_id,b.course_id,b.id,b.starts_at,r.policy.validDays,r.policy.charge?'prepaid':'on_attendance',b.debit]);
 }
 const status=op==='leave_withdraw'?'withdrawn':d.approve?'approved':'rejected',charge=status==='approved'?r.policy.charge:null;
 await tx.query('UPDATE leave_requests SET status=$3,version=version+1,decision_reason=$4,reviewed_by=$5,reviewed_at=now(),charge=$6 WHERE tenant_id=$1 AND id=$2',[t,r.id,status,d.reason,a.userId,charge]);
 await event(tx,a,{...r,version:r.version+1},status,d.reason,charge);return {id:r.id,version:r.version+1,status,...(makeupId?{makeupId}:{})};
}
export async function visibleLeaves(tx:Sql,t:string,bookingIds:string[]):Promise<LeaveRequest[]>{
 if(!bookingIds.length)return [];
 const rows=(await tx.query<Row>(`SELECT r.*,s.name AS student_name,c.name AS course_name,u.name AS requester_name,m.id AS makeup_id,m.state AS makeup_state,m.expires_at AS makeup_expires
 FROM leave_requests r JOIN bookings b ON(b.tenant_id=r.tenant_id AND b.id=r.booking_id) JOIN students s ON(s.tenant_id=b.tenant_id AND s.id=b.student_id)
 JOIN lessons l ON(l.tenant_id=b.tenant_id AND l.id=b.session_id) JOIN courses c ON(c.tenant_id=l.tenant_id AND c.id=l.course_id) JOIN users u ON(u.id=r.requester_id)
 LEFT JOIN makeup_credits m ON(m.tenant_id=r.tenant_id AND m.origin_booking=r.booking_id)
 WHERE r.tenant_id=$1 AND r.booking_id=ANY($2::text[]) ORDER BY r.created_at DESC,r.id`,[t,bookingIds])).rows;
 const events=(await tx.query<Row>('SELECT e.request_id,e.version,e.action,e.reason,e.charge,u.name AS actor_name,e.created_at FROM leave_events e JOIN users u ON(u.id=e.actor_id) WHERE e.tenant_id=$1 AND e.request_id=ANY($2::text[]) ORDER BY e.version',[t,rows.map(r=>r.id)])).rows;
 return rows.map(r=>({id:r.id,booking_id:r.booking_id,requester_id:r.requester_id,requester_name:r.requester_name,student_name:r.student_name,course_name:r.course_name,reason:r.reason,status:r.status,version:r.version,policy:r.policy,basis:r.basis,charge:r.charge,decision_reason:r.decision_reason,created_at:iso(r.created_at),makeup_id:r.makeup_id,makeup_state:r.makeup_state,makeup_expires:r.makeup_expires?iso(r.makeup_expires):null,events:events.filter(e=>e.request_id===r.id).map(e=>({version:e.version,action:e.action,reason:e.reason,charge:e.charge,actor_name:e.actor_name,created_at:iso(e.created_at)}))}));
}
