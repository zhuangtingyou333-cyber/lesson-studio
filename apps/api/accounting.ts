import {syncPayroll} from './payroll.ts';
import {randomUUID} from 'node:crypto';
import type {Actor} from '../../packages/contracts/index.ts';
import type {Sql} from './db.ts';
import {ensure} from './errors.ts';
type Row=Record<string,any>;
export const activeDebits=async(tx:Sql,t:string,bookingId:string)=>(await tx.query<Row>("SELECT e.* FROM ledger e WHERE e.tenant_id=$1 AND e.booking_id=$2 AND e.kind='consume' AND NOT EXISTS(SELECT 1 FROM ledger r WHERE r.tenant_id=e.tenant_id AND r.reversal_of=e.id)",[t,bookingId])).rows;
// Caller owns the tenant lock and transaction. Preserve original allocations when already paid.
export async function settleCharge(tx:Sql,a:Actor,b:Row,charge:boolean,revision:number,reason:string){
 const debits=await activeDebits(tx,a.tenantId,b.id);
 if(charge&&debits.reduce((sum,e)=>sum-e.delta,0)===b.debit)return;
 for(const e of debits)await tx.query("INSERT INTO ledger(tenant_id,id,grant_id,student_id,delta,kind,booking_id,revision,reversal_of,actor_id,reason) VALUES($1,$2,$3,$4,$5,'reversal',$6,$7,$8,$9,$10)",[a.tenantId,randomUUID(),e.grant_id,b.student_id,-e.delta,b.id,revision,e.id,a.userId,reason]);
 if(!charge)return;
 const grants=(await tx.query<Row>('SELECT g.id,g.expires_at,COALESCE(sum(e.delta),0)::int AS balance FROM grants g LEFT JOIN ledger e ON(e.tenant_id=g.tenant_id AND e.grant_id=g.id) WHERE g.tenant_id=$1 AND g.student_id=$2 AND g.course_id=$3 AND g.created_at<=$4 AND g.expires_at>$4 GROUP BY g.id,g.expires_at ORDER BY g.expires_at,g.id',[a.tenantId,b.student_id,b.course_id,b.starts_at])).rows;
 ensure(grants.reduce((sum,g)=>sum+g.balance,0)>=b.debit,'ENTITLEMENT_INSUFFICIENT','上课时有效的课包余额不足，本次操作未保存');
 let remaining=b.debit;
 for(const g of grants){const amount=Math.min(remaining,Math.max(g.balance,0));if(amount){await tx.query("INSERT INTO ledger(tenant_id,id,grant_id,student_id,delta,kind,booking_id,revision,actor_id,reason) VALUES($1,$2,$3,$4,$5,'consume',$6,$7,$8,$9)",[a.tenantId,randomUUID(),g.id,b.student_id,-amount,b.id,revision,a.userId,reason]);remaining-=amount;}if(!remaining)break;}
}
export async function recordAttendance(tx:Sql,a:Actor,id:string,revision:number,status:string,reason:string){
 await tx.query('INSERT INTO attendance VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,booking_id) DO UPDATE SET revision=EXCLUDED.revision,status=EXCLUDED.status',[a.tenantId,id,revision,status]);
 await tx.query('INSERT INTO attendance_history(tenant_id,booking_id,revision,status,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[a.tenantId,id,revision,status,reason,a.userId]);
 await syncPayroll(tx,a,id,revision,reason);
}
export async function prepaidMakeup(tx:Sql,t:string,m:Row,debit:number){
 ensure(m.covered_units===debit,'MAKEUP_UNITS_MISMATCH','补课必须与原课扣减次数一致，请选择其他课次',409);
 if(m.billing_mode!=='prepaid')return false;
 const paid=(await activeDebits(tx,t,m.origin_booking)).reduce((sum,e)=>sum-e.delta,0);
 ensure(paid===m.covered_units,'MAKEUP_ACCOUNTING_CONFLICT','原课扣减记录已变化，请联系管理员核对',409);
 return true;
}
