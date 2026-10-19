import {randomUUID} from 'node:crypto';
import type {Actor} from '../../packages/contracts/index.ts';
import type {Sql} from './db.ts';
import {ensure} from './errors.ts';
type Row=Record<string,any>;
const first=async(tx:Sql,sql:string,args:unknown[])=>(await tx.query<Row>(sql,args)).rows[0];
const tables={student:'students',course:'courses',package:'packages',room:'rooms'} as const;
export type ResourceKind=keyof typeof tables;

// Legacy name inputs resolve an existing room; they never implicitly create one.
export async function resolveRoom(tx:Sql,t:string,d:{roomId?:string;room?:string}){
  const room=await first(tx,`SELECT * FROM rooms WHERE tenant_id=$1 AND ${d.roomId?'id':'name'}=$2`,[t,d.roomId||d.room]);
  ensure(room,'ROOM_NOT_FOUND','教室不存在，请先在教室管理中创建',404);
  ensure(room.active,'ROOM_DISABLED','教室已停用，请选择其他教室',409);
  return room;
}
export function roomCapacity(room:Row,capacity:number){ensure(capacity<=room.capacity,'ROOM_CAPACITY','人数上限超过教室容量，请调整人数或更换教室',409);}
export async function activeCourse(tx:Sql,t:string,id:string){
  const course=await first(tx,'SELECT * FROM courses WHERE tenant_id=$1 AND id=$2',[t,id]);
  ensure(course,'NOT_FOUND','课程不存在',404);ensure(course.active,'COURSE_ARCHIVED','课程已归档，不能新增排课、班级或开通课包',409);return course;
}
export async function saveResource(tx:Sql,a:Actor,kind:ResourceKind,d:Row){
  const t=a.tenantId,table=tables[kind];
  const old=d.id?await first(tx,`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,[t,d.id]):null;
  if(d.id){ensure(old,'NOT_FOUND','资料不存在',404);ensure(old.version===d.expectedVersion,'VERSION_CONFLICT','资料已更新，请重新加载后编辑',409);ensure(old.active,'RESOURCE_ARCHIVED','请先恢复已归档资料',409);}
  if(kind==='package')await activeCourse(tx,t,d.courseId);
  if(kind==='room'){
    ensure(!await first(tx,'SELECT 1 FROM rooms WHERE tenant_id=$1 AND name=$2 AND id<>$3',[t,d.name,d.id||'']),'DUPLICATE_ROOM','已有同名教室，请编辑原教室或使用不同名称',409);
    if(old&&d.capacity<old.capacity){
      const pending=await first(tx,"SELECT count(*)::int AS n FROM lessons WHERE tenant_id=$1 AND room_id=$2 AND status='scheduled' AND ends_at>now() AND capacity>$3",[t,d.id,d.capacity]);
      ensure(!pending.n,'ROOM_IN_USE',`有${pending.n}节未结束课程的人数上限超过新容量，请先调整课程`,409);
    }
  }
  const fields:Record<ResourceKind,Record<string,unknown>>={
    student:{name:d.name,phone:d.phone,note:d.note},course:{name:d.name,duration:d.duration,debit:d.debit,color:d.color},
    package:{name:d.name,course_id:d.courseId,purchased:d.purchased,gift:d.gift,price:d.price,valid_days:d.validDays},room:{name:d.name,capacity:d.capacity},
  };
  const key=d.id||randomUUID(),version=old?old.version+1:1,entries=Object.entries(fields[kind]);
  if(old)await tx.query(`UPDATE ${table} SET ${entries.map(([k],i)=>k+'=$'+(i+3)).join(',')},version=version+1 WHERE tenant_id=$1 AND id=$2`,[t,key,...entries.map(([,v])=>v)]);
  else await tx.query(`INSERT INTO ${table}(tenant_id,id,${entries.map(([k])=>k).join(',')}) VALUES(${Array.from({length:entries.length+2},(_,i)=>'$'+(i+1)).join(',')})`,[t,key,...entries.map(([,v])=>v)]);
  return {id:key,version,previous:old,current:fields[kind]};
}
export async function setResourceActive(tx:Sql,a:Actor,d:Row){
  const table=tables[d.kind as ResourceKind],t=a.tenantId;
  const old=await first(tx,`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,[t,d.id]);
  ensure(old,'NOT_FOUND','资料不存在',404);ensure(old.version===d.expectedVersion,'VERSION_CONFLICT','资料已更新，请重新加载',409);
  ensure(old.active!==d.active,'NO_CHANGE','资料已经是此状态',409);
  await tx.query(`UPDATE ${table} SET active=$3,version=version+1 WHERE tenant_id=$1 AND id=$2`,[t,d.id,d.active]);
  return {id:d.id,version:old.version+1,active:d.active,previous:old};
}
