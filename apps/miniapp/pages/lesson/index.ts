import {state,command,stamp,message,stateNames,type StudioState} from '../../utils/api';
type BatchRow=StudioState['bookings'][number]&{selected:boolean;statusIndex:number};
type ChangeView=StudioState['lessonChanges'][number]&{label:string;beforeLabel:string;afterLabel:string};
Page({
  data:{id:'',error:'',busy:false,role:'',leaveCharge:false,lesson:null as StudioState['sessions'][number]|null,label:'',started:false,bookings:[] as (StudioState['bookings'][number]&{label:string;pending:boolean;prepaid:boolean})[],students:[] as StudioState['students'],studentIndex:0,makeupId:'',makeupStudent:'',attendanceId:'',revision:0,statusIndex:0,statuses:['到课 · 扣课','缺席 · 不扣课','撤销点名'],statusValues:['attended','absent','unmarked'],changes:[] as ChangeView[],batchOpen:false,batchRows:[] as BatchRow[],batchCount:0,batchStatuses:['到课 · 扣课','缺席 · 不扣课']},
  onLoad(query:Record<string,string>){this.setData({id:query.id,makeupId:query.makeupId||'',makeupStudent:query.studentId||''});},
  async onShow(){await this.refresh();},
  leaves(e:WechatMiniprogram.TouchEvent){wx.navigateTo({url:'/pages/leaves/index?bookingId='+e.currentTarget.dataset.id});},
  manage(){wx.navigateTo({url:'/pages/manage-lesson/index?id='+this.data.id});},
  async reloadRecords(){if(this.data.busy)return;this.setData({batchOpen:false,attendanceId:''});await this.refresh();},
  async refresh(){try{const s=await state();const l=s.sessions.find(x=>x.id===this.data.id);if(!l)throw new Error('课程不存在或无访问权限');this.setData({error:'',role:s.actor.role,leaveCharge:s.leavePolicy.charge,lesson:l,label:stamp(l.starts_at),started:new Date(l.starts_at).getTime()<=Date.now(),students:s.students.filter(s=>s.active),studentIndex:Math.max(0,s.students.filter(s=>s.active).findIndex(x=>x.id===this.data.makeupStudent)),bookings:s.bookings.filter(b=>b.session_id===l.id).map(b=>({...b,label:stateNames[b.state],pending:s.leaves.some(r=>r.booking_id===b.id&&r.status==='pending'),prepaid:s.makeups.some(m=>m.id===b.makeup_id&&m.billing_mode==='prepaid')})),changes:s.lessonChanges.filter(h=>h.session_id===l.id).map(h=>({...h,label:stamp(h.created_at),beforeLabel:stamp(h.before_state.startsAt)+' · '+h.before_state.teacherName+' · '+h.before_state.room+' · 上限'+h.before_state.capacity+'人',afterLabel:h.action==='cancel'?'课程已取消':stamp(h.after_state.startsAt)+' · '+h.after_state.teacherName+' · '+h.after_state.room+' · 上限'+h.after_state.capacity+'人'}))});}catch(e){this.setData({error:message(e),lesson:null});}},
  pick(e:WechatMiniprogram.PickerChange){this.setData({[e.currentTarget.dataset.key]:Number(e.detail.value)});},
  async save(op:string,input:object){if(this.data.busy)return;this.setData({busy:true,error:''});try{await command(op,input);this.setData({attendanceId:'',batchOpen:false});await this.refresh();wx.showToast({title:'已保存'});}catch(e){this.setData({error:message(e)});}finally{this.setData({busy:false});}},
  book(){const student=this.data.students[this.data.studentIndex];if(!student){this.setData({error:'暂无可预约学员'});return;}return this.save('booking',{sessionId:this.data.id,studentId:student.id,...(this.data.makeupId?{makeupId:this.data.makeupId}:{})});},
  point(e:WechatMiniprogram.TouchEvent){const b=this.data.bookings.find(x=>x.id===e.currentTarget.dataset.id)!;this.setData({attendanceId:b.id,revision:b.revision,statuses:[b.prepaid?'到课 · 原课已扣':'到课 · 扣课','缺席 · 不扣课','撤销点名'],statusIndex:b.attendance_status==='absent'?1:0,batchOpen:false});},
  submitAttendance(e:WechatMiniprogram.FormSubmit){return this.save('attendance',{bookingId:this.data.attendanceId,expectedRevision:this.data.revision,status:this.data.statusValues[this.data.statusIndex],reason:e.detail.value.reason});},
  openBatch(){
    if(this.data.batchOpen){this.setData({batchOpen:false});return;}
    const batchRows=this.data.bookings.filter(b=>b.state==='confirmed').map(b=>({...b,selected:true,statusIndex:0}));
    this.setData({batchRows,batchCount:batchRows.length,batchOpen:true,attendanceId:'',error:''});
  },
  selectBatch(e:WechatMiniprogram.CheckboxGroupChange){const chosen=new Set(e.detail.value);this.setData({batchRows:this.data.batchRows.map(b=>({...b,selected:chosen.has(b.id)})),batchCount:chosen.size});},
  batchStatus(e:WechatMiniprogram.PickerChange){this.setData({batchRows:this.data.batchRows.map(b=>b.id===e.currentTarget.dataset.id?{...b,statusIndex:Number(e.detail.value)}:b)});},
  submitBatch(e:WechatMiniprogram.FormSubmit){
    const items=this.data.batchRows.filter(b=>b.selected).map(b=>({bookingId:b.id,expectedRevision:b.revision,status:b.statusIndex===0?'attended':'absent'}));
    if(!items.length){this.setData({error:'请至少选择一位学员'});return;}
    return this.save('batch_attendance',{sessionId:this.data.id,items,reason:e.detail.value.reason});
  },
  async change(e:WechatMiniprogram.TouchEvent){const id=e.currentTarget.dataset.id,op=e.currentTarget.dataset.op;try{if(op==='reschedule'){wx.navigateTo({url:'/pages/choose/index?bookingId='+id+'&origin='+this.data.id});}else{const result=await wx.showModal({title:op==='leave'?'提交请假申请':'取消预约',content:op==='leave'?(this.data.leaveCharge?'审批通过后原课扣课，补课不重复扣。审批前保留原预约。请填写原因。':'审批通过后原课不扣课，补课到课时扣。审批前保留原预约。请填写原因。'):'取消后会释放名额，补课资格恢复为待安排。',editable:op==='leave',placeholderText:'请假原因'});if(result.confirm)await this.save(op,{bookingId:id,...(op==='leave'?{reason:result.content||'',expectedRevision:this.data.bookings.find(b=>b.id===id)!.revision,expectedLessonVersion:this.data.lesson!.version}:{})});}}catch(e){if(!String((e as {errMsg?:string}).errMsg).includes('cancel'))this.setData({error:message(e)});}},
});
