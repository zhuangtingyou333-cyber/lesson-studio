import {payrollMutation,payrollOverview,payrollDetail,payrollReport,payrollLookup,payrollLookupSchema} from './payroll.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Actor, StudioState, Student, Course, Package, Lesson, Booking, Grant, Entry, Makeup, ClassGroup, LessonChange, Room } from '../../packages/contracts/index.ts';
import type { Database, Sql } from './db.ts';
import { ensure, DomainError } from './errors.ts';
import { schemas, scheduleSchema, scheduleChangeSchema, type Command } from './schemas.ts';
import { saveClass, setClassActive, previewSchedule } from './scheduling.ts';
import { previewScheduleChange, commitScheduleChange } from './schedule-changes.ts';

import {saveResource,setResourceActive,activeCourse,resolveRoom,roomCapacity} from './resources.ts';

import {importMutation,importDetail,importList,importReport} from './imports/service.ts';
import {leaveMutation,leavePolicy,visibleLeaves,invalidateLeaves} from './leaves.ts';
import {settleCharge,recordAttendance,prepaidMakeup} from './accounting.ts';
import {IdentityService,identityMutation,membersOverview} from './identity.ts';

const id = () => randomUUID();
const iso = (value:string) => new Date(value).toISOString();
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
type Row = Record<string, any>;
const first = async <T = Row>(tx: Sql, q: string, v: unknown[] = []) => (await tx.query<T>(q, v)).rows[0];
export class StudioService {
  constructor(public db: Database, public identity=new IdentityService(db)) {}
  async membership(tx: Sql, actor: Actor): Promise<Actor> {
    const m = await first(tx, 'SELECT m.role,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active', [actor.tenantId, actor.userId]);
    ensure(m, 'FORBIDDEN', '当前机构访问权限已失效', 403);
    return { ...actor, role: m.role, name: m.name };
  }
  async auth(token: string): Promise<Actor> {
    const a = await first(this.db, 'SELECT a.user_id,a.tenant_id,m.role,u.name FROM auth_sessions a JOIN memberships m ON (m.tenant_id=a.tenant_id AND m.user_id=a.user_id) JOIN users u ON u.id=a.user_id WHERE a.token_hash=$1 AND a.expires_at>now() AND m.active', [digest(token)]);
    ensure(a, 'UNAUTHENTICATED', '请先登录并选择机构', 401);
    return { userId: a.user_id, tenantId: a.tenant_id, role: a.role, name: a.name };
  }
  async login(role: Actor['role']) {
    ensure(this.identity.demoEnabled,'NOT_FOUND','体验登录未启用',404);
    const userId = { owner: 'owner-demo', teacher: 'teacher-demo', guardian: 'guardian-demo' }[role];
    ensure(userId, 'VALIDATION', '请选择有效身份');
    ensure(await first(this.db,'SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active',['studio-demo',userId]),'FORBIDDEN','体验成员已停用',403);
    const token = randomUUID() + randomUUID();
    await this.db.query("INSERT INTO auth_sessions VALUES($1,$2,'studio-demo',now()+interval '12 hours')", [digest(token), userId]);
    return token;
  }
  async command(actorInput: Actor, operation: Command, raw: unknown, key: string): Promise<Row> {
    ensure(key && key.length >= 8 && key.length <= 120, 'IDEMPOTENCY_REQUIRED', '缺少有效操作编号');
    ensure(Object.hasOwn(schemas, operation), 'UNKNOWN_COMMAND', '不支持此操作', 404);
    const schema = schemas[operation];
    ensure(schema, 'UNKNOWN_COMMAND', '不支持此操作', 404);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new DomainError('VALIDATION', parsed.error.issues[0].message, 400, parsed.error.issues);
    const input = parsed.data as Row;
    const hash = digest(JSON.stringify({ operation, input }));
    return this.db.transaction(async tx => {
      // All tenant writes use this same lock. Coarse but correct for the first local release;
      // normal PostgreSQL processes also serialize on this row, not a JS in-memory mutex.
      ensure(await first(tx, 'SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [actorInput.tenantId]), 'FORBIDDEN', '无法访问该机构', 403);
      const actor = await this.membership(tx, actorInput);
      const permissions = actor.role === 'owner' ? Object.keys(schemas) : actor.role === 'teacher' ? ['attendance', 'batch_attendance'] : ['booking', 'cancel', 'reschedule', 'leave', 'leave_withdraw'];
      ensure(permissions.includes(operation), 'FORBIDDEN', '当前身份没有此操作权限', 403);
      const saved = await first(tx, 'SELECT hash,result FROM commands WHERE tenant_id=$1 AND actor_id=$2 AND key=$3', [actor.tenantId, actor.userId, key]);
      if (saved) { ensure(saved.hash === hash, 'IDEMPOTENCY_MISMATCH', '操作编号已被其他内容使用', 409); return saved.result; }
      // Return the same JSON-shaped value on the first response and an idempotent replay.
      const result = JSON.parse(JSON.stringify(await this.execute(tx, actor, operation, input))) as Row;
      const storedResult=operation==='invite_create'?{id:result.id,expiresAt:result.expiresAt,tokenAvailable:false}:result;
      await tx.query('INSERT INTO commands(tenant_id,actor_id,key,hash,result) VALUES($1,$2,$3,$4,$5)', [actor.tenantId, actor.userId, key, hash, JSON.stringify(storedResult)]);
      await tx.query('INSERT INTO audit_events(id,tenant_id,actor_id,action,subject,detail) VALUES($1,$2,$3,$4,$5,$6)', [id(), actor.tenantId, actor.userId, operation, String(result.id ?? ''), JSON.stringify({ command: key, result:storedResult })]);
      return result;
    });
  }
  private async student(tx: Sql, a: Actor, studentId: string, allowArchived=false) {
    const student = await first(tx, 'SELECT * FROM students WHERE tenant_id=$1 AND id=$2 AND (active OR $3)', [a.tenantId, studentId,allowArchived]);
    ensure(student, 'NOT_FOUND', '学员不存在或已归档', 404);
    if (a.role === 'guardian') ensure(await first(tx, 'SELECT 1 FROM guardians WHERE tenant_id=$1 AND student_id=$2 AND user_id=$3', [a.tenantId, studentId, a.userId]), 'FORBIDDEN', '只能操作已关联学员', 403);
    return student;
  }
  private async lesson(tx: Sql, a: Actor, sessionId: string) {
    const lesson = await first(tx, 'SELECT * FROM lessons WHERE tenant_id=$1 AND id=$2', [a.tenantId, sessionId]);
    ensure(lesson, 'NOT_FOUND', '课程不存在', 404); return lesson;
  }
  private async booking(tx: Sql, a: Actor, bookingId: string) {
    const b = await first(tx, 'SELECT b.*,l.teacher_id,l.course_id,l.debit,l.starts_at,l.ends_at FROM bookings b JOIN lessons l ON (l.tenant_id=b.tenant_id AND l.id=b.session_id) WHERE b.tenant_id=$1 AND b.id=$2', [a.tenantId, bookingId]);
    ensure(b, 'NOT_FOUND', '预约不存在', 404);
    await this.student(tx, a, b.student_id,true);
    if (a.role === 'teacher') ensure(b.teacher_id === a.userId, 'FORBIDDEN', '只能点名自己负责的课程', 403);
    return b;
  }
  private async emit(tx: Sql, a: Actor, event: string, payload: Row) {
    await tx.query('INSERT INTO outbox(id,tenant_id,event,payload) VALUES($1,$2,$3,$4)', [id(), a.tenantId, event, JSON.stringify(payload)]);
  }
  private async append(tx: Sql, a: Actor, data: { grantId: string; studentId: string; delta: number; kind: string; reason: string; bookingId?: string; revision?: number; reversalOf?: string }) {
    await tx.query('INSERT INTO ledger(tenant_id,id,grant_id,student_id,delta,kind,booking_id,revision,reversal_of,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [a.tenantId,id(),data.grantId,data.studentId,data.delta,data.kind,data.bookingId ?? null,data.revision ?? null,data.reversalOf ?? null,a.userId,data.reason]);
  }
  private async reserve(tx: Sql, a: Actor, sessionId: string, studentId: string, existingId?: string, makeupId?: string) {
    await this.student(tx, a, studentId);
    const l = await this.lesson(tx, a, sessionId);
    ensure(l.status==='scheduled','LESSON_CANCELLED','课程已取消，不能预约',409);
    await resolveRoom(tx,a.tenantId,{roomId:l.room_id});
    ensure(new Date(l.starts_at).getTime() > Date.now(), 'BOOKING_CLOSED', '课程已开始，不能预约');
    const existing = await first(tx, 'SELECT * FROM bookings WHERE tenant_id=$1 AND session_id=$2 AND student_id=$3', [a.tenantId,sessionId,studentId]);
    ensure(!existing || existing.id === existingId || existing.state === 'cancelled', 'ALREADY_BOOKED', '该学员已有这节课的记录', 409);
    const n = await first(tx, "SELECT count(*)::int AS n FROM bookings WHERE tenant_id=$1 AND session_id=$2 AND state IN ('confirmed','attended','absent') AND id<>$3", [a.tenantId,sessionId,existingId ?? '']);
    ensure(n.n < l.capacity, 'SESSION_FULL', '这节课已满，请选择其他时段', 409);
    const overlap = await first(tx, "SELECT b.id FROM bookings b JOIN lessons l ON (l.tenant_id=b.tenant_id AND l.id=b.session_id) WHERE b.tenant_id=$1 AND b.student_id=$2 AND b.state IN ('confirmed','attended','absent') AND b.id<>$3 AND l.status='scheduled' AND l.starts_at<$4 AND l.ends_at>$5", [a.tenantId,studentId,existingId ?? '',l.ends_at,l.starts_at]);
    ensure(!overlap, 'RESOURCE_CONFLICT', '学员在这个时间已有其他课程', 409);
    let prepaid=false;
    // Ordinary makeup needs an active package; prepaid makeup fulfills the original charge.
    const balance = await first(tx, 'SELECT COALESCE(sum(e.delta),0)::int AS n FROM grants g JOIN ledger e ON (e.tenant_id=g.tenant_id AND e.grant_id=g.id) WHERE g.tenant_id=$1 AND g.student_id=$2 AND g.course_id=$3 AND g.expires_at>$4', [a.tenantId,studentId,l.course_id,l.starts_at]);
    if (makeupId) {
      const m = await first(tx, 'SELECT * FROM makeup_credits WHERE tenant_id=$1 AND id=$2', [a.tenantId,makeupId]);
      ensure(m && m.student_id === studentId && m.course_id === l.course_id, 'INVALID_MAKEUP', '补课资格不匹配');
      const held=existingId?await first(tx,'SELECT makeup_id FROM bookings WHERE tenant_id=$1 AND id=$2',[a.tenantId,existingId]):null;
      ensure(m.state === 'available' || (m.state === 'reserved' && held?.makeup_id===m.id), 'MAKEUP_ALREADY_USED', '补课资格已被占用', 409);
      ensure(new Date(m.expires_at) > new Date(l.starts_at), 'MAKEUP_EXPIRED', '补课资格在上课前已到期');
      prepaid=await prepaidMakeup(tx,a.tenantId,m,l.debit);
    }
    ensure(prepaid||balance.n >= l.debit, 'ENTITLEMENT_INSUFFICIENT', '该课程可用课时不足，或课包在上课前到期');
    return { l, existing };
  }
  private async execute(tx: Sql, a: Actor, op: Command, d: Row): Promise<Row> {
    const t = a.tenantId;
    if(['payroll_rule','payroll_calculate','payroll_freeze'].includes(op))return payrollMutation(tx,a,op,d);
    if(['leave','leave_review','leave_withdraw','leave_policy','leave_correct'].includes(op))return leaveMutation(tx,a,op,d);
    if(['import_create','import_sheet','import_validate','import_commit'].includes(op))return importMutation(tx,a,op,d);
    if(['invite_create','invite_revoke','claim_review','member_active','guardian_unlink'].includes(op))return identityMutation(tx,a,op,d);
    if(['student','course','package','room'].includes(op))return saveResource(tx,a,op as 'student'|'course'|'package'|'room',d);
    if(op==='resource_active')return setResourceActive(tx,a,d);
    if(op==='schedule_change')return commitScheduleChange(tx,a,d.change,d.previewVersion);
    if(op==='class_save')return saveClass(tx,a,d);
    if(op==='class_active')return setClassActive(tx,a,d);
    if(op==='schedule_series'){
      const preview=await previewSchedule(tx,a,d.schedule);
      ensure(preview.previewVersion===d.previewVersion,'PREVIEW_STALE','排课依据已变化，请重新预览；本批全部未保存',409);
      if(!preview.canCommit)throw new DomainError('RESOURCE_CONFLICT','预览中仍有冲突，本批全部未保存',409,preview);
      const c=await first(tx,'SELECT * FROM classes WHERE tenant_id=$1 AND id=$2',[t,d.schedule.classId]);
      const members=(await tx.query<Row>('SELECT student_id FROM class_members WHERE tenant_id=$1 AND class_id=$2 ORDER BY student_id',[t,c.id])).rows;
      const key=id(),sessionIds:string[]=[];
      await tx.query('INSERT INTO schedule_series(tenant_id,id,class_id,rule,created_by) VALUES($1,$2,$3,$4,$5)',[t,key,c.id,JSON.stringify({schedule:preview.input,previewVersion:preview.previewVersion,classVersion:c.version,studentIds:members.map(m=>m.student_id)}),a.userId]);
      for(const row of preview.occurrences){
        const lesson=await this.execute(tx,a,'lesson',{courseId:c.course_id,teacherId:c.teacher_id,roomId:c.room_id,startsAt:row.startsAt,capacity:c.capacity});
        await tx.query('UPDATE lessons SET class_id=$3,series_id=$4 WHERE tenant_id=$1 AND id=$2',[t,lesson.id,c.id,key]);
        for(const m of members)await this.execute(tx,a,'booking',{sessionId:lesson.id,studentId:m.student_id});
        sessionIds.push(lesson.id);
      }
      await this.emit(tx,a,'schedule.created',{seriesId:key,sessionIds});
      return {id:key,sessionIds,count:sessionIds.length,bookingCount:sessionIds.length*members.length};
    }
    if (op === 'enrollment') {
      await this.student(tx,a,d.studentId);
      const p=await first(tx,'SELECT * FROM packages WHERE tenant_id=$1 AND id=$2',[t,d.packageId]); ensure(p,'NOT_FOUND','课包不存在',404);
      ensure(p.active,'PACKAGE_ARCHIVED','课包已归档，不能继续开通',409);await activeCourse(tx,t,p.course_id);
      const key=id();
      await tx.query("INSERT INTO grants(tenant_id,id,student_id,course_id,package_name,purchased,gift,source,expires_at,template_id,template_version,template_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 day',$10,$11,$12)",[t,key,d.studentId,p.course_id,p.name,p.purchased,p.gift,d.source,p.valid_days,p.id,p.version,JSON.stringify(p)]);
      await this.append(tx,a,{grantId:key,studentId:d.studentId,delta:p.purchased,kind:d.source==='opening'?'opening':'purchase',reason:d.source==='opening'?'期初余额迁入':'开通课包'});
      if(p.gift) await this.append(tx,a,{grantId:key,studentId:d.studentId,delta:p.gift,kind:'gift',reason:'赠送课时'});
      if(d.source==='receipt') await tx.query('INSERT INTO receipts(tenant_id,id,grant_id,amount,method) VALUES($1,$2,$3,$4,$5)',[t,id(),key,d.received,d.method]);
      return {id:key,balance:p.purchased+p.gift};
    }
    if(op==='lesson') {
      const c=await activeCourse(tx,t,d.courseId);
      const room=await resolveRoom(tx,t,d);roomCapacity(room,d.capacity);
      ensure(await first(tx,"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role IN ('owner','teacher') AND active",[t,d.teacherId]),'NOT_FOUND','老师不可用',404);
      const start=new Date(d.startsAt),end=new Date(start.getTime()+c.duration*60000);
      ensure(start.getTime()>Date.now()-86400000,'INVALID_TIME','只能安排最近24小时或之后的课程');
      const conflict=await first(tx,"SELECT id FROM lessons WHERE tenant_id=$1 AND status='scheduled' AND (teacher_id=$2 OR room_id=$3) AND starts_at<$4 AND ends_at>$5",[t,d.teacherId,room.id,end.toISOString(),start.toISOString()]);
      ensure(!conflict,'RESOURCE_CONFLICT','老师或教室在该时段已有课程',409);
      const key=id(); await tx.query('INSERT INTO lessons(tenant_id,id,course_id,teacher_id,room,starts_at,ends_at,capacity,debit,room_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[t,key,d.courseId,d.teacherId,room.name,start.toISOString(),end.toISOString(),d.capacity,c.debit,room.id]); return {id:key};
    }
    if(op==='booking') {
      const {existing}=await this.reserve(tx,a,d.sessionId,d.studentId,undefined,d.makeupId);
      const key=existing?.id ?? id();
      if(existing) await tx.query("UPDATE bookings SET state='confirmed',makeup_id=$3 WHERE tenant_id=$1 AND id=$2",[t,key,d.makeupId??null]);
      else await tx.query("INSERT INTO bookings VALUES($1,$2,$3,$4,'confirmed',$5)",[t,key,d.sessionId,d.studentId,d.makeupId??null]);
      if(d.makeupId) await tx.query("UPDATE makeup_credits SET state='reserved' WHERE tenant_id=$1 AND id=$2",[t,d.makeupId]);
      await this.emit(tx,a,'booking.confirmed',{bookingId:key}); return {id:key};
    }
    if(op==='cancel') {
      const b=await this.booking(tx,a,d.bookingId); ensure(b.state==='confirmed','INVALID_STATE','只能取消尚未点名的预约',409);
      if(a.role==='guardian') ensure(new Date(b.starts_at).getTime()>Date.now(),'BOOKING_CLOSED','课程已开始，请联系教务处理');
      await tx.query("UPDATE bookings SET state='cancelled' WHERE tenant_id=$1 AND id=$2",[t,b.id]);
      if(b.makeup_id) await tx.query("UPDATE makeup_credits SET state='available' WHERE tenant_id=$1 AND id=$2",[t,b.makeup_id]);
      await invalidateLeaves(tx,a,[b.id],'原预约已取消，申请失效');
      await this.emit(tx,a,'booking.cancelled',{bookingId:b.id}); return {id:b.id};
    }
    if(op==='reschedule') {
      const b=await this.booking(tx,a,d.bookingId); ensure(b.state==='confirmed','INVALID_STATE','只能改约尚未点名的课程',409);
      if(a.role==='guardian') ensure(new Date(b.starts_at).getTime()>Date.now(),'BOOKING_CLOSED','原课程已开始，请联系教务');
      ensure(!await first(tx,'SELECT 1 FROM attendance WHERE tenant_id=$1 AND booking_id=$2',[t,b.id]),'INVALID_STATE','存在点名历史，请取消后另建预约，保留原课记录',409);
      const {existing}=await this.reserve(tx,a,d.sessionId,b.student_id,b.id,b.makeup_id??undefined);
      ensure(!existing || existing.id===b.id,'ALREADY_BOOKED','目标课程已有历史预约，请取消原预约后重新预约',409);
      await tx.query('UPDATE bookings SET session_id=$3 WHERE tenant_id=$1 AND id=$2',[t,b.id,d.sessionId]);
      await invalidateLeaves(tx,a,[b.id],'原预约已改约，请按新课次重新申请');
      await this.emit(tx,a,'booking.rescheduled',{bookingId:b.id,from:b.session_id,to:d.sessionId}); return {id:b.id};
    }
    if(op==='batch_attendance') {
      const lesson=await this.lesson(tx,a,d.sessionId);
      if(a.role==='teacher')ensure(lesson.teacher_id===a.userId,'FORBIDDEN','只能点名自己负责的课程',403);
      const results:Row[]=[];
      // Reuse the single-record rules within the SAME transaction. Any row failure
      // rolls back earlier attendance, ledger, makeup and outbox writes in this batch.
      for(let i=0;i<d.items.length;i++){
        const item=d.items[i];let studentName='';
        try{
          const booking=await this.booking(tx,a,item.bookingId);
          ensure(booking.session_id===d.sessionId,'INVALID_BATCH','批量点名只能包含同一节课的预约');
          const student=await this.student(tx,a,booking.student_id,true);studentName=student.name;
          ensure(booking.state==='confirmed','INVALID_STATE','记录已经点名、取消或请假，请刷新后核对',409);
          results.push(await this.execute(tx,a,'attendance',{...item,reason:d.reason}));
        }catch(error){
          if(error instanceof DomainError)throw new DomainError(error.code,`第${i+1}位${studentName?'（'+studentName+'）':''}：${error.message}；本批全部未保存`,error.status,{bookingId:item.bookingId,row:i+1,studentName,cause:error.details});
          throw error;
        }
      }
      return {id:d.sessionId,count:results.length,results};
    }
    if(op==='attendance') {
      const b=await this.booking(tx,a,d.bookingId); ensure(['confirmed','attended','absent'].includes(b.state),'INVALID_STATE','已取消或请假的预约不能点名',409);
      ensure(new Date(b.starts_at).getTime()<=Date.now(),'ATTENDANCE_NOT_OPEN','课程开始后才能点名');
      const old=await first(tx,'SELECT * FROM attendance WHERE tenant_id=$1 AND booking_id=$2',[t,b.id]);
      ensure((old?.revision??0)===d.expectedRevision,'VERSION_CONFLICT','记录已更新，请刷新后再操作',409);
      ensure(old?.status!==d.status,'NO_CHANGE','当前已经是这个状态',409);
      ensure(old||d.status!=='unmarked','INVALID_STATE','尚无可撤销的点名记录');
      const revision=(old?.revision??0)+1;
      const makeup=b.makeup_id?await first(tx,'SELECT * FROM makeup_credits WHERE tenant_id=$1 AND id=$2',[t,b.makeup_id]):null;
      const prepaid=makeup?await prepaidMakeup(tx,t,makeup,b.debit):false;
      await settleCharge(tx,a,b,d.status==='attended'&&!prepaid,revision,d.reason);
      await recordAttendance(tx,a,b.id,revision,d.status,d.reason);
      await invalidateLeaves(tx,a,[b.id],'原预约已点名或更正，请重新核对后申请');
      const state=d.status==='unmarked'?'confirmed':d.status;
      await tx.query('UPDATE bookings SET state=$3 WHERE tenant_id=$1 AND id=$2',[t,b.id,state]);
      if(b.makeup_id) await tx.query('UPDATE makeup_credits SET state=$3 WHERE tenant_id=$1 AND id=$2',[t,b.makeup_id,d.status==='attended'?'used':'reserved']);
      await this.emit(tx,a,'attendance.changed',{bookingId:b.id,revision,status:d.status}); return {id:b.id,revision,status:d.status};
    }
    throw new DomainError('UNKNOWN_COMMAND','不支持此操作',404);
  }
  async payrollMonth(actor:Actor,input:unknown){
    const parsed=payrollLookupSchema.safeParse(input);ensure(parsed.success,'VALIDATION','请选择有效的老师和账期');
    return this.db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return payrollLookup(tx,await this.membership(tx,actor),parsed.data);});
  }
  async payroll(actor:Actor,kind:'list'|'detail'|'report',id='',page=1,cursor?:string){
    return this.db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const a=await this.membership(tx,actor);
      if(kind==='list')return payrollOverview(tx,a,cursor);
      if(kind==='report')return payrollReport(tx,a,id);
      return payrollDetail(tx,a,id,page);
    });
  }
  async imports(actor:Actor,kind:'list'|'detail'|'report',id='',page=1,cursor?:string){
    return this.db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const a=await this.membership(tx,actor);
      if(kind==='list')return importList(tx,a,cursor);
      if(kind==='report')return importReport(tx,a,id);
      return importDetail(tx,a,id,page);
    });
  }
  async members(actorInput:Actor){
    return this.db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return membersOverview(tx,await this.membership(tx,actorInput));
    });
  }
  async snapshot(actorInput: Actor): Promise<StudioState> {
    return this.db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const a=await this.membership(tx,actorInput),t=a.tenantId;
      const tenant=await first<{id:string;name:string}>(tx,'SELECT id,name FROM tenants WHERE id=$1',[t]);
      const courses=(await tx.query<Course>('SELECT id,name,duration,debit,color,active,version FROM courses WHERE tenant_id=$1 ORDER BY name',[t])).rows;
      const packages=(await tx.query<Package>('SELECT id,name,course_id,purchased,gift,price,valid_days,active,version FROM packages WHERE tenant_id=$1 ORDER BY name',[t])).rows;
      const rooms=(await tx.query<Room>("SELECT r.id,r.name,r.capacity,r.active,r.version,(SELECT count(*)::int FROM lessons l WHERE l.tenant_id=r.tenant_id AND l.room_id=r.id AND l.status='scheduled' AND l.ends_at>now()) AS upcoming FROM rooms r WHERE r.tenant_id=$1 ORDER BY r.active DESC,r.name,r.id",[t])).rows;
      const teachers=(await tx.query<{id:string;name:string}>("SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=$1 AND m.active AND m.role IN ('owner','teacher') ORDER BY u.name",[t])).rows;
      let classes=(await tx.query<ClassGroup>(`SELECT k.id,k.name,k.course_id,c.name AS course_name,k.teacher_id,u.name AS teacher_name,r.name AS room,k.room_id,k.capacity,k.active,k.version,
        ARRAY(SELECT student_id FROM class_members cm WHERE cm.tenant_id=k.tenant_id AND cm.class_id=k.id ORDER BY student_id) AS member_ids
        FROM classes k JOIN rooms r ON(r.tenant_id=k.tenant_id AND r.id=k.room_id) JOIN courses c ON(c.tenant_id=k.tenant_id AND c.id=k.course_id) JOIN users u ON u.id=k.teacher_id WHERE k.tenant_id=$1 ORDER BY k.active DESC,k.name,k.id`,[t])).rows;
      if(a.role==='teacher')classes=classes.filter(c=>c.teacher_id===a.userId);
      let sessions=(await tx.query<Lesson>("SELECT l.id,l.course_id,c.name AS course_name,l.teacher_id,u.name AS teacher_name,l.room,l.room_id,r.active AS room_active,l.starts_at,l.ends_at,l.capacity,l.debit,l.version,l.status,c.color,l.class_id,k.name AS class_name,l.series_id,(SELECT count(*)::int FROM bookings b WHERE b.tenant_id=l.tenant_id AND b.session_id=l.id AND b.state IN ('confirmed','attended','absent')) AS booked FROM lessons l JOIN rooms r ON(r.tenant_id=l.tenant_id AND r.id=l.room_id) JOIN courses c ON(c.tenant_id=l.tenant_id AND c.id=l.course_id) JOIN users u ON u.id=l.teacher_id LEFT JOIN classes k ON(k.tenant_id=l.tenant_id AND k.id=l.class_id) WHERE l.tenant_id=$1 ORDER BY l.starts_at,l.id",[t])).rows;
      if(a.role==='teacher') sessions=sessions.filter(s=>s.teacher_id===a.userId);
      let bookings=(await tx.query<Booking>('SELECT b.id,b.session_id,b.student_id,s.name AS student_name,b.state,b.makeup_id,COALESCE(a.revision,0) AS revision,a.status AS attendance_status FROM bookings b JOIN students s ON(s.tenant_id=b.tenant_id AND s.id=b.student_id) LEFT JOIN attendance a ON(a.tenant_id=b.tenant_id AND a.booking_id=b.id) WHERE b.tenant_id=$1',[t])).rows;
      const links=(await tx.query<{student_id:string}>('SELECT student_id FROM guardians WHERE tenant_id=$1 AND user_id=$2',[t,a.userId])).rows;
      const visible=a.role==='owner'?null:new Set(a.role==='guardian'?links.map(l=>l.student_id):[...bookings.filter(b=>sessions.some(s=>s.id===b.session_id)).map(b=>b.student_id),...classes.filter(c=>c.active).flatMap(c=>c.member_ids)]);
      if(a.role==='guardian')classes=classes.filter(c=>c.member_ids.some(id=>visible!.has(id))).map(c=>({...c,member_ids:c.member_ids.filter(id=>visible!.has(id))}));
      const teacherPairs=new Set<string>();
      if(a.role==='teacher'){
        for(const b of bookings){const l=sessions.find(l=>l.id===b.session_id);if(l)teacherPairs.add(JSON.stringify([b.student_id,l.course_id]));}
        for(const c of classes.filter(c=>c.active))for(const studentId of c.member_ids)teacherPairs.add(JSON.stringify([studentId,c.course_id]));
      }
      const canSeeCourse=(studentId:string,courseId:string)=>(!visible||visible.has(studentId))&&(a.role!=='teacher'||teacherPairs.has(JSON.stringify([studentId,courseId])));
      let students=(await tx.query<Student>(`SELECT s.id,s.name,s.phone,s.note,s.active,s.version,COALESCE((SELECT sum(e.delta)::int FROM grants g JOIN ledger e ON(e.tenant_id=g.tenant_id AND e.grant_id=g.id) WHERE g.tenant_id=s.tenant_id AND g.student_id=s.id AND g.expires_at>now()),0) AS balance FROM students s WHERE s.tenant_id=$1 ORDER BY s.created_at,s.id`,[t])).rows;
      students=students.filter(s=>!visible||visible.has(s.id)).map(s=>a.role==='teacher'?{...s,phone:'',note:''}:s);
      bookings=bookings.filter(b=>(!visible||visible.has(b.student_id))&&(a.role!=='teacher'||sessions.some(s=>s.id===b.session_id)));
      let grants=(await tx.query<Grant>('SELECT g.id,g.student_id,g.course_id,g.package_name,c.name AS course_name,g.expires_at,g.source,g.purchased,g.gift,g.template_id,g.template_version,COALESCE(sum(e.delta),0)::int AS balance FROM grants g JOIN courses c ON(c.tenant_id=g.tenant_id AND c.id=g.course_id) LEFT JOIN ledger e ON(e.tenant_id=g.tenant_id AND e.grant_id=g.id) WHERE g.tenant_id=$1 GROUP BY g.tenant_id,g.id,c.name ORDER BY g.created_at DESC',[t])).rows;
      grants=grants.filter(g=>canSeeCourse(g.student_id,g.course_id));
      if(a.role==='teacher')students=students.map(s=>({...s,balance:grants.filter(g=>g.student_id===s.id&&new Date(g.expires_at).getTime()>Date.now()).reduce((sum,g)=>sum+g.balance,0)}));
      let ledger=(await tx.query<Entry>(`SELECT e.id,e.student_id,g.course_id,s.name AS student_name,g.package_name,c.name AS course_name,e.delta,e.kind,e.reason,e.created_at,u.name AS actor_name,(SELECT sum(x.delta)::int FROM ledger x WHERE x.tenant_id=e.tenant_id AND x.student_id=e.student_id AND x.seq<=e.seq) AS balance_after,l.room AS session_title FROM ledger e JOIN students s ON(s.tenant_id=e.tenant_id AND s.id=e.student_id) JOIN grants g ON(g.tenant_id=e.tenant_id AND g.id=e.grant_id) JOIN courses c ON(c.tenant_id=g.tenant_id AND c.id=g.course_id) JOIN users u ON u.id=e.actor_id LEFT JOIN bookings b ON(b.tenant_id=e.tenant_id AND b.id=e.booking_id) LEFT JOIN lessons l ON(l.tenant_id=b.tenant_id AND l.id=b.session_id) WHERE e.tenant_id=$1 ORDER BY e.seq DESC`,[t])).rows;
      ledger=ledger.filter(e=>canSeeCourse(e.student_id,e.course_id));
      if(a.role==='teacher'){
        const running=new Map<string,number>();
        for(const entry of [...ledger].reverse()){const n=(running.get(entry.student_id)||0)+entry.delta;entry.balance_after=n;running.set(entry.student_id,n);}
      }
      const makeups=(await tx.query<Makeup>('SELECT m.id,m.student_id,s.name AS student_name,m.course_id,c.name AS course_name,m.state,m.origin_booking,m.expires_at,m.billing_mode,m.covered_units FROM makeup_credits m JOIN students s ON(s.tenant_id=m.tenant_id AND s.id=m.student_id) JOIN courses c ON(c.tenant_id=m.tenant_id AND c.id=m.course_id) WHERE m.tenant_id=$1 ORDER BY m.expires_at',[t])).rows.filter(m=>canSeeCourse(m.student_id,m.course_id));
      const receipt=a.role==='owner'?await first(tx,'SELECT COALESCE(sum(amount),0)::int AS n FROM receipts WHERE tenant_id=$1',[t]):{n:0};
      const historyScope=new Set(a.role==='guardian'?bookings.map(b=>b.session_id):sessions.map(l=>l.id));
      const lessonChanges=(await tx.query<LessonChange>('SELECT h.id,h.session_id,h.version,h.action,h.reason,h.before_state,h.after_state,u.name AS actor_name,h.created_at FROM lesson_changes h JOIN users u ON u.id=h.actor_id WHERE h.tenant_id=$1 ORDER BY h.created_at DESC,h.version DESC,h.id',[t])).rows.filter(h=>historyScope.has(h.session_id));
      return {actor:a,tenant,students,courses,packages,rooms,teachers,classes,bookings,leavePolicy:await leavePolicy(tx,t),leaves:await visibleLeaves(tx,t,bookings.map(b=>b.id)),
        sessions:sessions.map(l=>({...l,starts_at:iso(l.starts_at),ends_at:iso(l.ends_at)})),
        ledger:ledger.map(e=>({...e,created_at:iso(e.created_at)})),grants:grants.map(g=>({...g,expires_at:iso(g.expires_at)})),
        makeups:makeups.map(m=>({...m,expires_at:iso(m.expires_at)})),lessonChanges:lessonChanges.map(h=>({...h,created_at:iso(h.created_at)})),
        metrics:{students:students.length,available:students.reduce((s,x)=>s+x.balance,0),received:receipt.n,consumed:-ledger.filter(e=>['consume','reversal'].includes(e.kind)).reduce((s,e)=>s+e.delta,0)},asOf:new Date().toISOString(),capabilities:{livePayments:false,liveNotifications:false,localAuth:true}};
    });
  }
  async schedulePreview(actorInput:Actor,raw:unknown){
    const parsed=scheduleSchema.safeParse(raw);
    if(!parsed.success)throw new DomainError('VALIDATION',parsed.error.issues[0].message,400,parsed.error.issues);
    return this.db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const actor=await this.membership(tx,actorInput);
      return previewSchedule(tx,actor,parsed.data);
    });
  }
  async scheduleChangePreview(actorInput:Actor,raw:unknown){
    const parsed=scheduleChangeSchema.safeParse(raw);
    if(!parsed.success)throw new DomainError('VALIDATION',parsed.error.issues[0].message,400,parsed.error.issues);
    return this.db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return previewScheduleChange(tx,await this.membership(tx,actorInput),parsed.data);
    });
  }
  async exportLedger(actor: Actor) {
    const s=await this.snapshot(actor);
    const escape=(v:unknown)=>{let str=String(v??'');if(typeof v!=='number' && /^[=+\-@\t\r]/.test(str))str="'"+str;return '"'+str.replaceAll('"','""')+'"';};
    const rows=[['时间','学员','课程','课包','变化(次)','累计账面余额(次)','类型','原因','操作人'],...s.ledger.map(e=>[new Date(e.created_at).toISOString(),e.student_name,e.course_name,e.package_name,e.delta/1000,e.balance_after/1000,e.kind,e.reason,e.actor_name])];
    return '\uFEFF'+rows.map(row=>row.map(escape).join(',')).join('\r\n');
  }
}
