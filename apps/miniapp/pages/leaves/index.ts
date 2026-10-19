import {state,command,message,stamp,units,type StudioState} from '../../utils/api';
const labels:Record<string,string>={pending:'待审批',approved:'已通过',rejected:'已驳回',withdrawn:'已撤回',superseded:'原课已变化',corrected:'扣课已更正'};
type View=StudioState['leaves'][number]&{label:string;time:string;created:string;rule:string;result:string;expiry:string;canWithdraw:boolean;makeupLabel:string;makeupSession:string;makeupStudent:string;makeupCourse:string;canArrange:boolean;history:{version:number;title:string;detail:string}[]};
Page({
 data:{ready:false,busy:false,error:'',notice:'',role:'',bookingId:'',onlyPending:false,rows:[] as View[],all:[] as View[],pending:0,policy:null as StudioState['leavePolicy']|null,policyOpen:false,chargeIndex:0,charges:['原课不扣，补课到课时扣','原课扣课，补课不重复扣'],review:null as {id:string;version:number;op:string;approve:boolean;charge:boolean;title:string;summary:string}|null},
 onLoad(q:Record<string,string>){this.setData({bookingId:q.bookingId||''});},
 async onShow(){this.setData({ready:false,rows:[],all:[],review:null,policyOpen:false});await this.refresh();},
 async refresh(){
  try{
   const s=await state();
   const all=s.leaves.filter(r=>!this.data.bookingId||r.booking_id===this.data.bookingId).map(r=>{
    const m=s.makeups.find(m=>m.id===r.makeup_id),linked=m?s.bookings.find(b=>b.makeup_id===m.id&&['confirmed','attended','absent'].includes(b.state)):null;
    const expired=!!m&&new Date(m.expires_at).getTime()<=Date.now();
    return {...r,label:labels[r.status],time:stamp(r.basis.startsAt),created:stamp(r.created_at),
     rule:(r.policy.version?'规则第'+r.policy.version+'版':'默认规则')+' · 提前'+r.policy.cutoffMinutes+'分钟截止 · 补课有效'+r.policy.validDays+'天',
     result:(r.status==='approved'?r.charge:r.policy.charge)?'原课扣'+units(r.basis.debit)+'次，补课不重复扣':'原课不扣课，补课到课时扣'+units(r.basis.debit)+'次',
     expiry:r.makeup_expires?stamp(r.makeup_expires):'',canWithdraw:r.status==='pending'&&(s.actor.role==='owner'||r.requester_id===s.actor.userId),
     makeupLabel:m?m.state==='used'?'补课已完成':m.state==='reserved'?'补课已预约':expired?'补课资格已到期':'补课待安排':'',
     makeupSession:linked?.session_id||'',makeupStudent:m?.student_id||'',makeupCourse:m?.course_id||'',canArrange:!!m&&m.state==='available'&&!expired&&s.actor.role!=='teacher',
     history:r.events.map(e=>({version:e.version,title:labels[e.action]+' · '+e.actor_name+' · '+stamp(e.created_at),detail:e.reason+(e.charge===null?'':e.charge?'（原课扣课）':'（原课不扣课）')}))};
   });
   this.setData({ready:true,error:'',role:s.actor.role,all,rows:this.data.onlyPending?all.filter(r=>r.status==='pending'):all,pending:all.filter(r=>r.status==='pending').length,policy:s.leavePolicy,chargeIndex:s.leavePolicy.charge?1:0});
  }catch(e){this.setData({ready:false,error:message(e),rows:[],all:[],review:null,policy:null});}
 },
 async reload(){if(this.data.busy)return;this.setData({review:null,policyOpen:false});await this.refresh();},
 filter(e:WechatMiniprogram.TouchEvent){const onlyPending=e.currentTarget.dataset.pending==='yes';this.setData({onlyPending,review:null,rows:onlyPending?this.data.all.filter(r=>r.status==='pending'):this.data.all});},
 policyToggle(){this.setData({policyOpen:!this.data.policyOpen,review:null});},
 pick(e:WechatMiniprogram.PickerChange){this.setData({chargeIndex:Number(e.detail.value)});},
 async savePolicy(e:WechatMiniprogram.FormSubmit){if(!this.data.policy)return;const v=e.detail.value;await this.save('leave_policy',{expectedVersion:this.data.policy.version,cutoffMinutes:Number(v.cutoff),validDays:Number(v.days),charge:this.data.chargeIndex===1,reason:v.reason});},
 start(e:WechatMiniprogram.TouchEvent){const r=this.data.rows.find(r=>r.id===e.currentTarget.dataset.id);if(!r)return;const op=e.currentTarget.dataset.op,approve=e.currentTarget.dataset.approve==='yes';const charge=!r.charge;
  this.setData({policyOpen:false,review:{id:r.id,version:r.version,op,approve,charge,title:op==='leave_correct'?'更正原课扣课':op==='leave_withdraw'?'撤回申请':approve?'通过请假':'驳回申请',summary:op==='leave_correct'?(charge?'将扣原课课时，后续补课不重复扣。':'将按原扣减课包返还，后续补课到课时扣。')+'须先取消已安排的补课；已完成时还需先更正补课点名。':op==='leave_withdraw'||!approve?'原预约和课时保持当前状态。':r.result+'。释放原名额并生成一次补课资格；有效期从审批和原课时间中较晚者起算。'}});
 },
 cancelReview(){this.setData({review:null});},
 async submit(e:WechatMiniprogram.FormSubmit){const r=this.data.review;if(!r)return;await this.save(r.op,{id:r.id,expectedVersion:r.version,reason:e.detail.value.reason,...(r.op==='leave_review'?{approve:r.approve}:r.op==='leave_correct'?{charge:r.charge}:{})});},
 async save(op:string,input:object){if(this.data.busy)return;this.setData({busy:true,error:'',notice:''});try{await command(op,input);this.setData({review:null,policyOpen:false,notice:'已保存，可在记录中查看结果'});await this.refresh();}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
 makeup(e:WechatMiniprogram.TouchEvent){const r=this.data.rows.find(r=>r.id===e.currentTarget.dataset.id);if(!r)return;if(r.makeupSession)wx.navigateTo({url:'/pages/lesson/index?id='+r.makeupSession});else if(r.canArrange)wx.navigateTo({url:'/pages/choose/index?makeupId='+r.makeup_id+'&studentId='+r.makeupStudent+'&courseId='+r.makeupCourse});},
 lesson(e:WechatMiniprogram.TouchEvent){const r=this.data.rows.find(r=>r.id===e.currentTarget.dataset.id);if(r)wx.navigateTo({url:'/pages/lesson/index?id='+r.basis.sessionId});},
});
