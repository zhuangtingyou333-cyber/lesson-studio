import { createHash, randomUUID } from 'node:crypto';
import type { Actor, SchedulePreview } from '../../packages/contracts/index.ts';
import type { Sql } from './db.ts';
import { ensure } from './errors.ts';
import type { ScheduleInput } from './schemas.ts';

import {activeCourse,resolveRoom,roomCapacity} from './resources.ts';

type Row = Record<string, any>;
const first = async (tx:Sql,q:string,v:unknown[]) => (await tx.query<Row>(q,v)).rows[0];

// All calendar input is a date/time in Asia/Shanghai, independent of server TZ.
export function occurrences(input:ScheduleInput,duration:number) {
  const from=Date.parse(input.startDate+'T00:00:00Z'),to=Date.parse(input.endDate+'T00:00:00Z');
  ensure(to>=from&&to-from<=365*86400000,'INVALID_RANGE','结束日期须不早于开始日期，范围最多366天');
  const days=new Set(input.weekdays),exclusions=new Set(input.excludeDates),possible=new Set<string>();
  const result:{date:string;startsAt:string;endsAt:string;conflicts:string[]}[]=[];
  for(let cursor=from;cursor<=to;cursor+=86400000){
    const d=new Date(cursor),date=d.toISOString().slice(0,10);
    if(!days.has(d.getUTCDay()))continue;
    possible.add(date);
    if(exclusions.has(date))continue;
    const start=Date.parse(date+'T'+input.time+':00+08:00');
    result.push({date,startsAt:new Date(start).toISOString(),endsAt:new Date(start+duration*60000).toISOString(),conflicts:[]});
  }
  ensure(input.excludeDates.every(d=>possible.has(d)),'INVALID_EXCLUSION','排除日期必须位于本次范围且为选中的上课日');
  ensure(result.length>0,'EMPTY_SCHEDULE','没有可生成的课次，请检查日期、每周上课日和排除日期');
  ensure(result.length<=60,'SCHEDULE_LIMIT','一次最多60节课，请缩小日期范围；本次没有截断或保存');
  return result;
}

export async function saveClass(tx:Sql,a:Actor,d:Row) {
  const t=a.tenantId;
  const old=d.id?await first(tx,'SELECT * FROM classes WHERE tenant_id=$1 AND id=$2',[t,d.id]):null;
  if(d.id){ensure(old,'NOT_FOUND','班级不存在',404);ensure(old.version===d.expectedVersion,'VERSION_CONFLICT','班级已更新，请重新加载后编辑',409);ensure(old.active,'INVALID_STATE','请先恢复已归档班级');}
  await activeCourse(tx,t,d.courseId);
  ensure(await first(tx,"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active AND role IN ('owner','teacher')",[t,d.teacherId]),'NOT_FOUND','老师不可用',404);
  ensure(d.studentIds.length<=d.capacity,'CLASS_FULL','所选学员超过班级人数上限');
  const members=(await tx.query<Row>('SELECT id FROM students WHERE tenant_id=$1 AND id=ANY($2::text[]) AND active',[t,d.studentIds])).rows;
  ensure(members.length===d.studentIds.length,'NOT_FOUND','所选学员不存在或已归档',404);
  if(old&&old.course_id!==d.courseId)ensure(!await first(tx,'SELECT 1 FROM lessons WHERE tenant_id=$1 AND class_id=$2 LIMIT 1',[t,d.id]),'CLASS_HAS_LESSONS','已有课次的班级不能换课程，请新建班级以保留记录');
  const room=await resolveRoom(tx,t,d);roomCapacity(room,d.capacity);
  const key=d.id??randomUUID(),version=old?old.version+1:1;
  if(old)await tx.query('UPDATE classes SET name=$3,course_id=$4,teacher_id=$5,room=$6,capacity=$7,version=$8,room_id=$9 WHERE tenant_id=$1 AND id=$2',[t,key,d.name,d.courseId,d.teacherId,room.name,d.capacity,version,room.id]);
  else await tx.query('INSERT INTO classes(tenant_id,id,name,course_id,teacher_id,room,capacity,room_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[t,key,d.name,d.courseId,d.teacherId,room.name,d.capacity,room.id]);
  const previousMembers=(await tx.query<Row>('SELECT student_id FROM class_members WHERE tenant_id=$1 AND class_id=$2 ORDER BY student_id',[t,key])).rows.map(s=>s.student_id);
  await tx.query('DELETE FROM class_members WHERE tenant_id=$1 AND class_id=$2',[t,key]);
  for(const sid of d.studentIds)await tx.query('INSERT INTO class_members VALUES($1,$2,$3)',[t,key,sid]);
  // Only the roster template changes. Existing lesson bookings and attendance stay intact.
  return {id:key,version,studentIds:d.studentIds,previousMembers,previous:old,configuration:{name:d.name,courseId:d.courseId,teacherId:d.teacherId,room:room.name,roomId:room.id,capacity:d.capacity}};
}

export async function setClassActive(tx:Sql,a:Actor,d:Row){
  const c=await first(tx,'SELECT * FROM classes WHERE tenant_id=$1 AND id=$2',[a.tenantId,d.classId]);
  ensure(c,'NOT_FOUND','班级不存在',404);
  ensure(c.version===d.expectedVersion,'VERSION_CONFLICT','班级已更新，请重新加载',409);
  ensure(c.active!==d.active,'NO_CHANGE','班级已经是此状态',409);
  await tx.query('UPDATE classes SET active=$3,version=version+1 WHERE tenant_id=$1 AND id=$2',[a.tenantId,d.classId,d.active]);
  return {id:d.classId,version:c.version+1,active:d.active};
}

export async function previewSchedule(tx:Sql,a:Actor,raw:ScheduleInput):Promise<SchedulePreview>{
  ensure(a.role==='owner','FORBIDDEN','只有管理员可以排课',403);
  const t=a.tenantId,input={...raw,weekdays:[...raw.weekdays].sort(),excludeDates:[...raw.excludeDates].sort()};
  const c=await first(tx,`SELECT k.*,c.duration,c.debit,c.name AS course_name,u.name AS teacher_name,m.active AS teacher_active,m.role AS teacher_role
    FROM classes k JOIN courses c ON (c.tenant_id=k.tenant_id AND c.id=k.course_id)
    JOIN memberships m ON(m.tenant_id=k.tenant_id AND m.user_id=k.teacher_id) JOIN users u ON u.id=k.teacher_id
    WHERE k.tenant_id=$1 AND k.id=$2`,[t,input.classId]);
  ensure(c,'NOT_FOUND','班级不存在',404);ensure(c.active,'INVALID_STATE','已归档班级不能排课');
  ensure(c.teacher_active&&['teacher','owner'].includes(c.teacher_role),'NOT_FOUND','班级老师已不可用，请修改班级配置',404);
  const course=await activeCourse(tx,t,c.course_id),room=await resolveRoom(tx,t,{roomId:c.room_id});roomCapacity(room,c.capacity);
  const roster=(await tx.query<Row>('SELECT s.id,s.name,s.active FROM class_members cm JOIN students s ON(s.tenant_id=cm.tenant_id AND s.id=cm.student_id) WHERE cm.tenant_id=$1 AND cm.class_id=$2 ORDER BY s.id',[t,c.id])).rows;
  ensure(roster.length>0,'EMPTY_CLASS','请先给班级添加学员');
  ensure(roster.every(s=>s.active),'INVALID_STATE','班级中有已归档学员，请更新名单');
  ensure(roster.length<=c.capacity,'CLASS_FULL','班级人数超过上限，请更新班级配置');
  const rows=occurrences(input,c.duration),members=roster.map(s=>s.id),start=rows[0].startsAt,end=rows.at(-1)!.endsAt;
  const resources=(await tx.query<Row>("SELECT id,teacher_id,room_id,starts_at,ends_at FROM lessons WHERE tenant_id=$1 AND status='scheduled' AND (teacher_id=$2 OR room_id=$3) AND starts_at<$4 AND ends_at>$5 ORDER BY starts_at,id",[t,c.teacher_id,c.room_id,end,start])).rows;
  const booked=(await tx.query<Row>(`SELECT b.student_id,l.starts_at,l.ends_at FROM bookings b JOIN lessons l ON(l.tenant_id=b.tenant_id AND l.id=b.session_id)
    WHERE b.tenant_id=$1 AND b.student_id=ANY($2::text[]) AND b.state IN ('confirmed','attended','absent') AND l.status='scheduled' AND l.starts_at<$3 AND l.ends_at>$4 ORDER BY b.student_id,l.starts_at,b.id`,[t,members,end,start])).rows;
  const grants=(await tx.query<Row>(`SELECT g.id,g.student_id,g.expires_at,COALESCE(sum(e.delta),0)::int AS balance FROM grants g LEFT JOIN ledger e ON(e.tenant_id=g.tenant_id AND e.grant_id=g.id)
    WHERE g.tenant_id=$1 AND g.student_id=ANY($2::text[]) AND g.course_id=$3 GROUP BY g.tenant_id,g.id ORDER BY g.id`,[t,members,c.course_id])).rows;
  const now=Date.now();
  for(const row of rows){
    const from=Date.parse(row.startsAt),to=Date.parse(row.endsAt);
    if(from<=now)row.conflicts.push('该课次已开始，请选择未来时间');
    const overlaps=resources.filter(r=>new Date(r.starts_at).getTime()<to&&new Date(r.ends_at).getTime()>from);
    if(overlaps.some(r=>r.teacher_id===c.teacher_id))row.conflicts.push('老师在该时段已有课程');
    if(overlaps.some(r=>r.room_id===c.room_id))row.conflicts.push('教室在该时段已有课程');
    for(const student of roster){
      if(booked.some(b=>b.student_id===student.id&&new Date(b.starts_at).getTime()<to&&new Date(b.ends_at).getTime()>from))row.conflicts.push(`${student.name}：该时段已有课程`);
      const balance=grants.filter(g=>g.student_id===student.id&&new Date(g.expires_at).getTime()>from).reduce((n,g)=>n+g.balance,0);
      if(balance<c.debit)row.conflicts.push(`${student.name}：上课时有效的课时不足`);
    }
  }
  // Bind the reviewed draft to the class/roster/entitlements and proposed results.
  // Recomputed inside the same tenant write lock at commit, never trust client canCommit.
  const previewVersion=createHash('sha256').update(JSON.stringify({input,version:c.version,course:course.version,room,duration:c.duration,debit:c.debit,roster,grants,rows})).digest('hex');
  return {input,previewVersion,className:c.name,courseName:c.course_name,teacherName:c.teacher_name,room:room.name,studentCount:roster.length,debit:c.debit,canCommit:rows.every(r=>r.conflicts.length===0),occurrences:rows};
}
