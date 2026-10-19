import {invalidateLeaves} from './leaves.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Actor, LessonPlan, ScheduleChangePreview } from '../../packages/contracts/index.ts';
import type { Sql } from './db.ts';
import type { ScheduleChangeInput } from './schemas.ts';
import { DomainError, ensure } from './errors.ts';

import {resolveRoom} from './resources.ts';

type Row=Record<string,any>;
const iso=(v:string|Date)=>new Date(v).toISOString();
const localDate=(v:string|Date)=>new Date(new Date(v).getTime()+8*3600000).toISOString().slice(0,10);
const overlap=(a:LessonPlan,b:LessonPlan)=>Date.parse(a.startsAt)<Date.parse(b.endsAt)&&Date.parse(a.endsAt)>Date.parse(b.startsAt);
const plan=(l:Row):LessonPlan=>({startsAt:iso(l.starts_at),endsAt:iso(l.ends_at),teacherId:l.teacher_id,teacherName:l.teacher_name,room:l.room,roomId:l.room_id,capacity:l.capacity,status:l.status,version:l.version});
const samePlan=(a:LessonPlan,b:LessonPlan)=>a.startsAt===b.startsAt&&a.endsAt===b.endsAt&&a.teacherId===b.teacherId&&a.room===b.room&&a.roomId===b.roomId&&a.capacity===b.capacity&&a.status===b.status;

export async function previewScheduleChange(tx:Sql,a:Actor,input:ScheduleChangeInput):Promise<ScheduleChangePreview>{
  ensure(a.role==='owner','FORBIDDEN','只有管理员可以调整课程',403);
  const t=a.tenantId;
  const anchor=(await tx.query<Row>('SELECT * FROM lessons WHERE tenant_id=$1 AND id=$2',[t,input.sessionId])).rows[0];
  ensure(anchor,'NOT_FOUND','课程不存在',404);
  ensure(input.scope==='single'||anchor.series_id,'INVALID_SCOPE','这节课不属于周期系列，只能单节调整');
  const candidates=(await tx.query<Row>(`SELECT l.*,u.name AS teacher_name,COALESCE(k.name,c.name) AS title FROM lessons l
    JOIN users u ON u.id=l.teacher_id JOIN courses c ON(c.tenant_id=l.tenant_id AND c.id=l.course_id)
    LEFT JOIN classes k ON(k.tenant_id=l.tenant_id AND k.id=l.class_id)
    WHERE l.tenant_id=$1 AND ${input.scope==='single'?'l.id=$2':'l.series_id=$2'} ORDER BY l.starts_at,l.id`,[t,input.scope==='single'?anchor.id:anchor.series_id])).rows;
  const selected=candidates.filter(l=>input.scope==='single'||(input.scope==='future'?new Date(l.starts_at)>=new Date(anchor.starts_at):localDate(l.starts_at)>=input.fromDate!&&localDate(l.starts_at)<=input.toDate!));
  ensure(selected.length>0,'EMPTY_SELECTION','该范围没有课次');
  ensure(selected.length<=60,'SCHEDULE_LIMIT','一次最多调整60节，请缩小范围');
  const teachers=(await tx.query<Row>("SELECT u.id,u.name,m.active,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1",[t])).rows;
  const rooms=(await tx.query<Row>('SELECT * FROM rooms WHERE tenant_id=$1 ORDER BY id',[t])).rows;
  const chosenRoom=input.action==='reschedule'&&(input.roomId||input.room)?await resolveRoom(tx,t,input):null;
  const records=(await tx.query<Row>(`SELECT b.*,s.name AS student_name,s.active AS student_active,a.revision,a.status AS attendance_status,m.state AS makeup_state,m.expires_at AS makeup_expires,m.billing_mode,m.covered_units,
    (SELECT COALESCE(-sum(e.delta),0)::int FROM ledger e WHERE e.tenant_id=m.tenant_id AND e.booking_id=m.origin_booking AND e.kind='consume' AND NOT EXISTS(SELECT 1 FROM ledger r WHERE r.tenant_id=e.tenant_id AND r.reversal_of=e.id)) AS makeup_paid
    FROM bookings b JOIN students s ON(s.tenant_id=b.tenant_id AND s.id=b.student_id)
    LEFT JOIN attendance a ON(a.tenant_id=b.tenant_id AND a.booking_id=b.id)
    LEFT JOIN makeup_credits m ON(m.tenant_id=b.tenant_id AND m.id=b.makeup_id)
    WHERE b.tenant_id=$1 AND b.session_id=ANY($2::text[]) ORDER BY b.id`,[t,selected.map(l=>l.id)])).rows;
  const rows:ScheduleChangePreview['rows']=[],unchanged:ScheduleChangePreview['unchanged']=[];
  for(const l of selected){
    const before=plan(l),after={...before,version:before.version+1};
    if(l.status==='cancelled'){unchanged.push({id:l.id,startsAt:before.startsAt,reason:'已经取消，保留原记录'});continue;}
    if(input.action==='cancel')after.status='cancelled';
    else{
      const shift=Date.parse(input.date+'T00:00:00Z')-Date.parse(localDate(anchor.starts_at)+'T00:00:00Z');
      const date=new Date(Date.parse(localDate(l.starts_at)+'T00:00:00Z')+shift).toISOString().slice(0,10);
      ensure(/^\d{4}-\d{2}-\d{2}$/.test(date),'INVALID_TIME','调整后的日期超出支持范围');
      after.startsAt=new Date(date+'T'+input.time+':00+08:00').toISOString();
      after.endsAt=new Date(Date.parse(after.startsAt)+Date.parse(before.endsAt)-Date.parse(before.startsAt)).toISOString();
      after.teacherId=input.teacherId??before.teacherId;
      after.teacherName=teachers.find(u=>u.id===after.teacherId)?.name||'老师不可用';
      after.room=chosenRoom?.name??before.room;after.roomId=chosenRoom?.id??before.roomId;after.capacity=input.capacity??before.capacity;
    }
    if(samePlan(before,after)){unchanged.push({id:l.id,startsAt:before.startsAt,reason:'设置未改变，保留原记录'});continue;}
    const bookings=records.filter(b=>b.session_id===l.id&&['confirmed','attended','absent'].includes(b.state)).map(b=>({id:b.id,studentId:b.student_id,studentName:b.student_name,makeupId:b.makeup_id}));
    rows.push({id:l.id,title:l.title,before,after,bookings,conflicts:[]});
  }
  ensure(rows.length>0,'NO_CHANGE','所选课程均已取消或设置没有变化',409);
  const ids=rows.map(r=>r.id),members=[...new Set(rows.flatMap(r=>r.bookings.map(b=>b.studentId)))];
  const resources=input.action==='cancel'?[]:(await tx.query<Row>(`SELECT l.*,u.name AS teacher_name FROM lessons l JOIN users u ON u.id=l.teacher_id
    WHERE l.tenant_id=$1 AND l.status='scheduled' AND NOT(l.id=ANY($2::text[])) ORDER BY l.id`,[t,ids])).rows;
  const otherBookings=input.action==='cancel'?[]:(await tx.query<Row>(`SELECT b.student_id,l.starts_at,l.ends_at FROM bookings b JOIN lessons l ON(l.tenant_id=b.tenant_id AND l.id=b.session_id)
    WHERE b.tenant_id=$1 AND b.student_id=ANY($2::text[]) AND b.state IN ('confirmed','attended','absent') AND l.status='scheduled' AND NOT(l.id=ANY($3::text[])) ORDER BY b.id`,[t,members,ids])).rows;
  const grants=input.action==='cancel'?[]:(await tx.query<Row>(`SELECT g.id,g.student_id,g.course_id,g.expires_at,COALESCE(sum(e.delta),0)::int AS balance FROM grants g LEFT JOIN ledger e ON(e.tenant_id=g.tenant_id AND e.grant_id=g.id)
    WHERE g.tenant_id=$1 AND g.student_id=ANY($2::text[]) GROUP BY g.tenant_id,g.id ORDER BY g.id`,[t,members])).rows;
  const now=Date.now();
  for(const row of rows){
    const l=selected.find(l=>l.id===row.id)!;
    if(Date.parse(row.before.startsAt)<=now)row.conflicts.push('课程已开始，不能调整或取消');
    if(records.some(b=>b.session_id===row.id&&(b.revision||['attended','absent'].includes(b.state))))row.conflicts.push('存在点名历史，必须保留原课次');
    if(input.action==='cancel')continue;
    if(Date.parse(row.after.startsAt)<=now)row.conflicts.push('新时间必须在未来');
    const teacher=teachers.find(u=>u.id===row.after.teacherId);
    if(!teacher?.active||!['owner','teacher'].includes(teacher.role))row.conflicts.push('所选老师不可用');
    const room=rooms.find(r=>r.id===row.after.roomId);
    if(!room?.active)row.conflicts.push('教室已停用，请选择其他教室');
    if(room&&row.after.capacity>room.capacity)row.conflicts.push('新人数上限超过教室容量');
    if(row.bookings.length>row.after.capacity)row.conflicts.push('新人数上限小于已有预约人数');
    if(resources.some(l=>l.teacher_id===row.after.teacherId&&overlap(plan(l),row.after)))row.conflicts.push('老师在新时段已有课程');
    if(resources.some(l=>l.room_id===row.after.roomId&&overlap(plan(l),row.after)))row.conflicts.push('教室在新时段已有课程');
    for(const b of row.bookings){
      const record=records.find(x=>x.id===b.id)!;
      if(!record.student_active)row.conflicts.push(`${b.studentName}：学员已归档`);
      if(otherBookings.some(x=>x.student_id===b.studentId&&new Date(x.starts_at).getTime()<Date.parse(row.after.endsAt)&&new Date(x.ends_at).getTime()>Date.parse(row.after.startsAt)))row.conflicts.push(`${b.studentName}：新时段已有其他预约`);
      const prepaid=record.billing_mode==='prepaid';
      if(prepaid&&record.makeup_paid!==record.covered_units)row.conflicts.push(`${b.studentName}：原课扣减记录已变化`);
      if(b.makeupId&&record.covered_units!==l.debit)row.conflicts.push(`${b.studentName}：补课与原课次数不一致`);
      if(!prepaid&&grants.filter(g=>g.student_id===b.studentId&&g.course_id===l.course_id&&new Date(g.expires_at).getTime()>Date.parse(row.after.startsAt)).reduce((sum,g)=>sum+g.balance,0)<l.debit)row.conflicts.push(`${b.studentName}：新上课时间的有效课时不足`);
      if(b.makeupId&&(record.makeup_state!=='reserved'||new Date(record.makeup_expires).getTime()<=Date.parse(row.after.startsAt)))row.conflicts.push(`${b.studentName}：补课资格不可用或在新时间已到期`);
    }
  }
  // Ignore all selected old slots, then compare proposed slots against one another.
  // This allows shifting a series into slots that the same atomic change will release.
  if(input.action==='reschedule')for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    const x=rows[i],y=rows[j];if(!overlap(x.after,y.after))continue;
    if(x.after.teacherId===y.after.teacherId||x.after.roomId===y.after.roomId||x.bookings.some(b=>y.bookings.some(c=>c.studentId===b.studentId))){x.conflicts.push('调整后的课次之间存在老师、教室或学员冲突');y.conflicts.push('调整后的课次之间存在老师、教室或学员冲突');}
  }
  const releasedMakeups=input.action==='cancel'?records.filter(b=>ids.includes(b.session_id)&&b.state==='confirmed'&&b.makeup_id&&b.makeup_state==='reserved').length:0;
  const previewVersion=createHash('sha256').update(JSON.stringify({input,selected,records,grants,rooms:rooms.filter(r=>rows.some(l=>l.after.roomId===r.id)),rows,unchanged,releasedMakeups})).digest('hex');
  return {input,previewVersion,canCommit:rows.every(r=>!r.conflicts.length),affectedBookings:rows.reduce((n,r)=>n+r.bookings.length,0),releasedMakeups,rows,unchanged};
}

// Caller holds the tenant write lock and owns the encompassing command transaction.
export async function commitScheduleChange(tx:Sql,a:Actor,input:ScheduleChangeInput,version:string){
  const preview=await previewScheduleChange(tx,a,input);
  ensure(preview.previewVersion===version,'PREVIEW_STALE','课程或预约已变化，请重新预览；本批全部未保存',409);
  if(!preview.canCommit)throw new DomainError('RESOURCE_CONFLICT','仍有冲突，本批全部未保存',409,preview);
  const t=a.tenantId;
  for(const row of preview.rows){
    const after=row.after;
    const updated=await tx.query('UPDATE lessons SET starts_at=$3,ends_at=$4,teacher_id=$5,room=$6,capacity=$7,status=$8,version=$9,room_id=$11 WHERE tenant_id=$1 AND id=$2 AND version=$10 RETURNING id',[t,row.id,after.startsAt,after.endsAt,after.teacherId,after.room,after.capacity,after.status,after.version,row.before.version,after.roomId]);
    ensure(updated.rows.length,'VERSION_CONFLICT','课次已更新，本批全部未保存',409);
    const affected=(await tx.query<Row>('SELECT id FROM bookings WHERE tenant_id=$1 AND session_id=$2',[t,row.id])).rows;
    await invalidateLeaves(tx,a,affected.map(b=>b.id),'课程已调整或取消，请按新课次重新申请');
    if(input.action==='cancel'){
      const changed=(await tx.query<Row>("UPDATE bookings SET state='cancelled' WHERE tenant_id=$1 AND session_id=$2 AND state='confirmed' RETURNING id,makeup_id",[t,row.id])).rows;
      for(const b of changed)if(b.makeup_id)await tx.query("UPDATE makeup_credits SET state='available' WHERE tenant_id=$1 AND id=$2 AND state='reserved'",[t,b.makeup_id]);
    }
    await tx.query('INSERT INTO lesson_changes(tenant_id,id,session_id,version,action,reason,before_state,after_state,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[t,randomUUID(),row.id,after.version,input.action,input.reason,JSON.stringify(row.before),JSON.stringify(after),a.userId]);
    await tx.query('INSERT INTO outbox(id,tenant_id,event,payload) VALUES($1,$2,$3,$4)',[randomUUID(),t,'lesson.'+(input.action==='cancel'?'cancelled':'rescheduled'),JSON.stringify({sessionId:row.id,bookingIds:row.bookings.map(b=>b.id),before:row.before,after,reason:input.reason})]);
  }
  return {id:input.sessionId,action:input.action,count:preview.rows.length,sessionIds:preview.rows.map(r=>r.id),affectedBookings:preview.affectedBookings,releasedMakeups:preview.releasedMakeups};
}
