export type Role = 'owner' | 'teacher' | 'guardian';
export interface Actor { userId: string; tenantId: string; role: Role; name: string }
export interface Student { id: string; name: string; phone: string; note: string; balance: number; active: boolean; version:number }
export interface Course { id: string; name: string; duration: number; debit: number; color: string; active:boolean; version:number }
export interface Package { id: string; name: string; course_id: string; purchased: number; gift: number; price: number; valid_days: number; active:boolean; version:number }
export interface Room {id:string;name:string;capacity:number;active:boolean;version:number;upcoming:number}
export interface Lesson { id: string; course_id: string; course_name: string; teacher_id: string; teacher_name: string; room: string; room_id:string; room_active:boolean; starts_at: string; ends_at: string; capacity: number; debit: number; booked: number; version: number; color: string; class_id: string|null; class_name: string|null; series_id: string|null; status:'scheduled'|'cancelled' }
export type ScheduleChangeDraft={sessionId:string;scope:'single'|'future'|'range';fromDate?:string;toDate?:string;reason:string}&({action:'cancel'}|{action:'reschedule';date:string;time:string;teacherId?:string;roomId?:string;room?:string;capacity?:number});
export interface LessonPlan {startsAt:string;endsAt:string;teacherId:string;teacherName:string;room:string;roomId:string;capacity:number;status:'scheduled'|'cancelled';version:number}
export interface ScheduleChangePreview {
  input:ScheduleChangeDraft;previewVersion:string;canCommit:boolean;affectedBookings:number;releasedMakeups:number;
  rows:{id:string;title:string;before:LessonPlan;after:LessonPlan;bookings:{id:string;studentId:string;studentName:string;makeupId:string|null}[];conflicts:string[]}[];
  unchanged:{id:string;startsAt:string;reason:string}[];
}
export interface LessonChange {id:string;session_id:string;version:number;action:'reschedule'|'cancel';reason:string;before_state:LessonPlan;after_state:LessonPlan;actor_name:string;created_at:string}
export interface ClassGroup { id:string; name:string; course_id:string; course_name:string; teacher_id:string; teacher_name:string; room:string; room_id:string; capacity:number; active:boolean; version:number; member_ids:string[] }
export interface ScheduleDraft { classId:string; startDate:string; endDate:string; time:string; weekdays:number[]; excludeDates:string[] }
export interface SchedulePreview {
  input:ScheduleDraft; previewVersion:string; className:string; courseName:string; teacherName:string; room:string;
  studentCount:number; debit:number; canCommit:boolean;
  occurrences:{date:string; startsAt:string; endsAt:string; conflicts:string[]}[];
}
export interface Booking { id: string; session_id: string; student_id: string; student_name: string; state: string; revision: number; attendance_status: string | null; makeup_id: string | null }
export interface Entry { course_id:string; id: string; student_id: string; student_name: string; package_name: string; course_name: string; delta: number; kind: string; reason: string; created_at: string; balance_after: number; actor_name: string; session_title: string | null }
export interface Grant { course_id:string; id: string; student_id: string; package_name: string; course_name: string; balance: number; expires_at: string; source: string; purchased: number; gift: number; template_id:string|null; template_version:number|null }
export interface Makeup { id: string; student_id: string; student_name: string; course_id: string; course_name: string; state: string; origin_booking: string; expires_at: string; billing_mode: 'prepaid'|'on_attendance'; covered_units:number }
export interface StudioState {
  actor: Actor; tenant: { id: string; name: string }; students: Student[]; courses: Course[];
  packages: Package[]; rooms:Room[]; teachers: { id: string; name: string }[]; sessions: Lesson[]; classes: ClassGroup[];
  bookings: Booking[]; ledger: Entry[]; grants: Grant[]; makeups: Makeup[]; lessonChanges:LessonChange[]; leavePolicy:LeavePolicy; leaves:LeaveRequest[];
  metrics: { students: number; available: number; received: number; consumed: number };
  asOf: string; capabilities: { livePayments: false; liveNotifications: false; localAuth: true };
}
export interface ApiErrorBody { code: string; message: string; requestId?: string; details?: unknown }
export const units = (n: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(n / 1000);

export interface Principal {userId:string;name:string;tenantId:string|null}
export interface IdentityOverview {
  user:{id:string;name:string};
  memberships:{tenant_id:string;tenant_name:string;role:Role;active:boolean;version:number}[];
  claims:{id:string;status:'pending'|'approved'|'rejected';display_name:string;relationship:string;decision_reason:string|null;tenant_name:string;role:Role;expires_at:string}[];
  capabilities:{wechatLogin:boolean;demoLogin:boolean};
}
export interface MembersOverview {
  members:{user_id:string;name:string;display_name:string;role:Role;active:boolean;version:number;upcoming:number;students:{id:string;name:string}[]}[];
  invitations:{id:string;role:'teacher'|'guardian';label:string;state:'open'|'claimed'|'revoked';version:number;expires_at:string;expired:boolean;students:{id:string;name:string}[]}[];
  claims:{id:string;invitation_id:string;user_id:string;display_name:string;relationship:string;status:'pending'|'approved'|'rejected';version:number;decision_reason:string|null}[];
}

export type ImportField='studentKey'|'name'|'phone'|'note'|'grantKey'|'course'|'package'|'purchased'|'gift'|'expires'|'unit';
export interface ImportConfig {sheet:string;source:string;kind:'students'|'opening';mapping:Partial<Record<ImportField,number>>;targets:Record<string,string>}
export interface ImportRowPreview {
 line:number;studentKey:string;name:string;phone:string;note:string;grantKey:string;courseId:string;courseName:string;packageName:string;
 purchased:number;gift:number;expiresAt:string;targetId:string|null;studentVersion:number|null;courseVersion:number|null;
 errors:string[];warnings:string[];needsResolution:boolean;candidateNames:string[];
}
export interface ImportSummary {rows:number;errors:number;warnings:number;newStudents:number;existingStudents:number;grants:number;purchased:number;gift:number;available:number;expired:number}
export interface ImportBatch {
 id:string;file_name:string;status:'draft'|'invalid'|'ready'|'completed';version:number;created_at:string;completed_at:string|null;
 sheets:{name:string;headers:string[];rows:number;sample:string[][]}[];config:ImportConfig|null;previewHash:string|null;summary:ImportSummary|null;
 rows:ImportRowPreview[];page:number;totalPages:number;totalRows:number;
}
export interface ImportList {items:{id:string;file_name:string;worksheet:string;status:ImportBatch['status'];version:number;created_at:string;completed_at:string|null}[];nextCursor:string|null}

export interface LeavePolicy {version:number;cutoffMinutes:number;validDays:number;charge:boolean}
export interface LeaveRequest {
 id:string;booking_id:string;requester_id:string;requester_name:string;student_name:string;course_name:string;
 status:'pending'|'approved'|'rejected'|'withdrawn'|'superseded';version:number;reason:string;policy:LeavePolicy;
 basis:{sessionId:string;lessonVersion:number;startsAt:string;endsAt:string;debit:number;state:string;revision:number};
 charge:boolean|null;decision_reason:string|null;created_at:string;makeup_id:string|null;makeup_state:string|null;makeup_expires:string|null;
 events:{version:number;action:string;reason:string;charge:boolean|null;actor_name:string;created_at:string}[];
}

export interface PayrollRule {id:string;teacherId:string;courseId:string;version:number;effectiveFrom:string;mode:'lesson'|'student';rate:number;countAbsent:boolean;countMakeup:boolean;reason:string}
export interface PayrollLine {
 key:string;kind:'lesson'|'adjustment';lessonId:string;courseId:string;courseName:string;startsAt:string;endsAt:string;room:string;lessonStatus:string;
 rule:PayrollRule|null;eligible:number;pending:number;amount:number;note:string;
 students:{id:string;name:string;bookingId:string;revision:number;status:string;makeup:boolean}[];
 sourcePeriodId?:string;sourceMonth?:string;beforeAmount?:number;afterAmount?:number;eligibleMonth?:string;
}
export interface PayrollCalculation {teacherId:string;teacherName:string;month:string;rows:PayrollLine[];baseAmount:number;adjustmentAmount:number;total:number;blockers:string[];fingerprint:string;calculatedAt:string}
export interface PayrollDetail extends PayrollCalculation {id:string;status:'draft'|'frozen';version:number;stale:boolean;frozenAt:string|null;freezeReason:string|null;page:number;totalPages:number;totalRows:number;canFreeze:boolean}
export interface PayrollOverview {
 role:Role;teachers:{id:string;name:string;active:boolean}[];courses:{id:string;name:string}[];rules:PayrollRule[];
 periods:{id:string;teacherId:string;teacherName:string;month:string;status:'draft'|'frozen';version:number;total:number}[];nextCursor:string|null;
 pending:{id:string;teacherId:string;lessonId:string;sourcePeriodId:string;sourceMonth:string;eligibleMonth:string;amount:number;reason:string;courseName:string}[];
}
