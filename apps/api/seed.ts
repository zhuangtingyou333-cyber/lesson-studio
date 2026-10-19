import type { Database } from './db.ts';
export async function seedDemo(db: Database) {
  await db.transaction(async tx=>{
    if((await tx.query("SELECT 1 FROM tenants WHERE id='studio-demo'")).rows.length)return;
    await tx.query("INSERT INTO tenants VALUES('studio-demo','青禾艺术工作室 · 体验空间')");
    await tx.query("INSERT INTO users VALUES('owner-demo','林老师'),('teacher-demo','陈老师'),('guardian-demo','体验家长')");
    await tx.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES('studio-demo','owner-demo','owner'),('studio-demo','teacher-demo','teacher'),('studio-demo','guardian-demo','guardian')");
    const students=[['student-1','小禾','正在学习基础素描'],['student-2','小予','周末班'],['student-3','小满','喜欢水彩'],['student-4','小棠','新学员']];
    for(const [sid,name,note] of students)await tx.query("INSERT INTO students(tenant_id,id,name,note) VALUES('studio-demo',$1,$2,$3)",[sid,name,note]);
    await tx.query("INSERT INTO guardians VALUES('studio-demo','student-1','guardian-demo'),('studio-demo','student-2','guardian-demo')");
    await tx.query("INSERT INTO courses(tenant_id,id,name,duration,debit,color) VALUES('studio-demo','course-art','创意素描',90,1000,'#487969'),('studio-demo','course-water','水彩小课堂',60,1000,'#bb894c')");
    await tx.query("INSERT INTO packages(tenant_id,id,course_id,name,purchased,gift,price,valid_days) VALUES('studio-demo','pack-art','course-art','素描 · 10次赠2次',10000,2000,120000,365),('studio-demo','pack-water','course-water','水彩 · 8次课',8000,0,96000,180)");
    for(let i=1;i<=4;i++){
      await tx.query("INSERT INTO grants(tenant_id,id,student_id,course_id,package_name,purchased,gift,source,expires_at,created_at) VALUES('studio-demo',$1,$2,'course-art','素描 · 10次赠2次',10000,2000,'opening',now()+interval '180 days',now()-interval '7 days')",['grant-'+i,'student-'+i]);
      for(const [delta,kind] of [[10000,'opening'],[2000,'gift']])await tx.query("INSERT INTO ledger(tenant_id,id,grant_id,student_id,delta,kind,actor_id,reason,created_at) VALUES('studio-demo',$1,$2,$3,$4,$5,'owner-demo','体验数据 · 期初余额',now()-interval '7 days')",['entry-'+i+'-'+kind,'grant-'+i,'student-'+i,delta,kind]);
    }
    const now=Date.now();
    const slots=[{id:'lesson-current',start:now-90*60000,room:'一号画室',teacher:'teacher-demo'}, {id:'lesson-next',start:now+86400000,room:'一号画室',teacher:'teacher-demo'}, {id:'lesson-weekend',start:now+2*86400000,room:'二号画室',teacher:'owner-demo'}];
    const hasRooms=!!(await tx.query<{r:string|null}>("SELECT to_regclass('rooms') AS r")).rows[0].r;
    if(hasRooms)await tx.query("INSERT INTO rooms(tenant_id,id,name,capacity) VALUES('studio-demo','room-1','一号画室',12),('studio-demo','room-2','二号画室',12)");
    for(const slot of slots)await tx.query(`INSERT INTO lessons(tenant_id,id,course_id,teacher_id,room,starts_at,ends_at,capacity,debit${hasRooms?',room_id':''}) VALUES('studio-demo',$1,'course-art',$2,$3,$4,$5,6,1000${hasRooms?',$6':''})`,[slot.id,slot.teacher,slot.room,new Date(slot.start).toISOString(),new Date(slot.start+90*60000).toISOString(),...(hasRooms?[slot.room==='一号画室'?'room-1':'room-2']:[])]);
    for(let i=1;i<=3;i++)await tx.query("INSERT INTO bookings VALUES('studio-demo',$1,'lesson-current',$2,'confirmed',NULL)",['booking-'+i,'student-'+i]);
    await tx.query("INSERT INTO bookings VALUES('studio-demo','booking-next','lesson-next','student-1','confirmed',NULL)");
  });
}
