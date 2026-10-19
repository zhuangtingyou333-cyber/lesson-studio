import {payrollSchemas} from './payroll.ts';
import { z } from 'zod';
import {importSchemas} from './imports/service.ts';
const id = z.string().min(1).max(100);
const text = z.string().trim().min(1).max(80);
const units = z.number().int().min(1).max(10000000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===s;},'日期无效');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/,'时间格式应为HH:mm');
const edit={id:id.optional(),expectedVersion:z.number().int().min(1).optional()};
const editValid=(v:{id?:string;expectedVersion?:number})=>Boolean(v.id)===Boolean(v.expectedVersion);
const roomChoice={roomId:id.optional(),room:text.optional()};
const roomValid=(v:{roomId?:string;room?:string})=>Boolean(v.roomId)!==Boolean(v.room);
const changeBase={sessionId:id,scope:z.enum(['single','future','range']),fromDate:date.optional(),toDate:date.optional(),reason:z.string().trim().min(1).max(300)};
export const scheduleChangeSchema=z.discriminatedUnion('action',[
  z.object({...changeBase,action:z.literal('cancel')}).strict(),
  z.object({...changeBase,action:z.literal('reschedule'),date,time,teacherId:id.optional(),...roomChoice,capacity:z.number().int().min(1).max(200).optional()}).strict(),
]).refine(v=>v.action==='cancel'||!(v.roomId&&v.room),'请选择教室编号或名称之一').refine(v=>v.scope==='range'?Boolean(v.fromDate&&v.toDate&&v.fromDate<=v.toDate):!v.fromDate&&!v.toDate,'指定范围须提供有效起止日期，其他范围不能携带日期筛选');
export type ScheduleChangeInput=z.infer<typeof scheduleChangeSchema>;
export const scheduleSchema = z.object({
  classId:id, startDate:date, endDate:date, time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/,'时间格式应为HH:mm'),
  weekdays:z.array(z.number().int().min(0).max(6)).min(1,'至少选择一个上课日').max(7).refine(v=>new Set(v).size===v.length,'上课日不能重复'),
  excludeDates:z.array(date).max(366).default([]).refine(v=>new Set(v).size===v.length,'排除日期不能重复'),
}).strict();
export type ScheduleInput = z.infer<typeof scheduleSchema>;
const reason=z.string().trim().min(1).max(300);
const expectedVersion=z.number().int().min(1);
export const schemas = {
  ...importSchemas,
  ...payrollSchemas,
  invite_create:z.object({role:z.enum(['teacher','guardian']),label:text,expiresInHours:z.number().int().min(1).max(168).default(24),studentIds:z.array(id).max(20).default([]).refine(v=>new Set(v).size===v.length,'学员不能重复')}).strict().refine(v=>v.role==='teacher'?v.studentIds.length===0:v.studentIds.length>0,'家长邀请需要关联学员，老师邀请不能关联学员'),
  invite_revoke:z.object({id,expectedVersion,reason}).strict(),
  claim_review:z.object({id,expectedVersion,approve:z.boolean(),reason}).strict(),
  member_active:z.object({userId:id,expectedVersion,active:z.boolean(),reason}).strict(),
  guardian_unlink:z.object({userId:id,studentId:id,expectedVersion,reason}).strict(),
  resource_active:z.object({kind:z.enum(['student','course','package','room']),id,expectedVersion:z.number().int().min(1),active:z.boolean()}).strict(),
  room:z.object({...edit,name:text,capacity:z.number().int().min(1).max(200)}).strict().refine(editValid,'编辑须提供当前版本'),
  schedule_change:z.object({change:scheduleChangeSchema,previewVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  class_save:z.object({id:id.optional(),expectedVersion:z.number().int().min(1).optional(),name:text,courseId:id,teacherId:id,...roomChoice,capacity:z.number().int().min(1).max(200),studentIds:z.array(id).max(200).refine(v=>new Set(v).size===v.length,'学员不能重复')}).strict().refine(editValid,'编辑班级必须提供当前版本').refine(roomValid,'请选择教室'),
  class_active:z.object({classId:id,expectedVersion:z.number().int().min(1),active:z.boolean()}).strict(),
  schedule_series:z.object({schedule:scheduleSchema,previewVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  student: z.object({ ...edit, name: text, phone: z.string().trim().max(24).default(''), note: z.string().trim().max(500).default('') }).strict().refine(editValid,'编辑须提供当前版本'),
  course: z.object({ ...edit, name: text, duration: z.number().int().min(15).max(480), debit: units, color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#49756b') }).strict().refine(editValid,'编辑须提供当前版本'),
  package: z.object({ ...edit, name: text, courseId: id, purchased: units, gift: z.number().int().min(0).max(10000000), price: z.number().int().min(0).max(100000000), validDays: z.number().int().min(1).max(3650) }).strict().refine(editValid,'编辑须提供当前版本'),
  enrollment: z.object({ studentId: id, packageId: id, source: z.enum(['opening','receipt']), received: z.number().int().min(0).max(100000000), method: z.enum(['cash','external']).default('external') }).strict().refine(v => v.source !== 'opening' || v.received === 0, { message: '期初迁入不能记录新增收款', path: ['received'] }),
  lesson: z.object({ courseId: id, teacherId: id, ...roomChoice, startsAt: z.string().datetime({ offset: true }), capacity: z.number().int().min(1).max(200) }).strict().refine(roomValid,'请选择教室'),
  booking: z.object({ sessionId: id, studentId: id, makeupId: id.optional() }).strict(),
  cancel: z.object({ bookingId: id }).strict(),
  reschedule: z.object({ bookingId: id, sessionId: id }).strict(),
  attendance: z.object({ bookingId: id, expectedRevision: z.number().int().min(0), status: z.enum(['attended','absent','unmarked']), reason: z.string().trim().min(1).max(300) }).strict(),
  batch_attendance: z.object({
    sessionId: id,
    items: z.array(z.object({ bookingId: id, expectedRevision: z.number().int().min(0), status: z.enum(['attended','absent']) }).strict()).min(1, '请至少选择一位学员').max(200),
    reason: z.string().trim().min(1).max(300),
  }).strict().refine(v=>new Set(v.items.map(x=>x.bookingId)).size===v.items.length,{message:'同一预约不能重复出现在一批点名中',path:['items']}),
  leave: z.object({bookingId:id,expectedRevision:z.number().int().min(0),expectedLessonVersion:expectedVersion,reason}).strict(),
  leave_review:z.object({id,expectedVersion,approve:z.boolean(),reason}).strict(),
  leave_withdraw:z.object({id,expectedVersion,reason}).strict(),
  leave_correct:z.object({id,expectedVersion,charge:z.boolean(),reason}).strict(),
  leave_policy:z.object({expectedVersion:z.number().int().min(0),cutoffMinutes:z.number().int().min(0).max(10080),validDays:z.number().int().min(1).max(365),charge:z.boolean(),reason}).strict(),
};
export type Command = keyof typeof schemas;
